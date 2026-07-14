package sqlite

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"
	"time"

	applicationruntime "github.com/lyming99/autoplan/backend/internal/application/runtime"
	domainevents "github.com/lyming99/autoplan/backend/internal/domain/events"
	domainoperation "github.com/lyming99/autoplan/backend/internal/domain/operation"
	"github.com/lyming99/autoplan/backend/internal/repository"
)

var (
	ErrIdempotencyConflict = errors.New("operation idempotency conflict")
	ErrOperationState      = errors.New("operation state is invalid")
)

const operationColumns = `operation_id, project_id, type, status, request_id, idempotency_scope,
	 idempotency_key, request_hash, cancel_requested_at, created_at, updated_at, started_at,
	 finished_at, result_json, error_json, output_json, version`

// OperationTransaction is the P10-only bounded write surface. It is a thin
// facade over one serializable Writer transaction, so a state write, project
// revision advance, and outbox append cannot commit independently.
type OperationTransaction struct{ transaction *writeTransaction }

type CreateOperation struct {
	Operation        domainoperation.Operation
	IdempotencyScope string
	Payload          json.RawMessage
}

type TransitionOperation struct {
	ProjectID       int64
	OperationID     string
	ExpectedVersion int64
	Target          domainoperation.Status
	RequestID       string
	UpdatedAt       string
	Result          *json.RawMessage
	Error           *domainoperation.ErrorSummary
	Output          *domainoperation.OutputMetadata
	Payload         json.RawMessage
}

type CancelOperation struct {
	ProjectID       int64
	OperationID     string
	ExpectedVersion int64
	RequestID       string
	RequestedAt     string
}

type OperationMutation struct {
	Operation domainoperation.Operation
	Event     *domainevents.Envelope
	Changed   bool
}

type OperationListQuery struct {
	ProjectID  int64
	Type       string
	Status     domainoperation.Status
	Limit      int
	Descending bool
}

type storedOperation struct {
	Operation        domainoperation.Operation
	IdempotencyScope string
}

// TransactOperations exposes no raw SQL and cannot nest a transaction. A
// caller receives the P10 facade only after the Writer has passed all owner,
// schema, readiness, and context checks.
func (writer *Writer) TransactOperations(ctx context.Context, operation func(*OperationTransaction) error) error {
	if operation == nil {
		return repository.ErrTransaction
	}
	return writer.Transact(ctx, func(transaction repository.WriteTransaction) error {
		concrete, ok := transaction.(*writeTransaction)
		if !ok {
			return repository.ErrTransaction
		}
		return operation(&OperationTransaction{transaction: concrete})
	})
}

func (transaction *OperationTransaction) Create(ctx context.Context, input CreateOperation) (OperationMutation, error) {
	if transaction == nil || transaction.transaction == nil || input.Operation.Status != domainoperation.StatusQueued ||
		input.Operation.Version != 1 || input.Operation.IdempotencyKey == nil || !validOpaque(input.IdempotencyScope, 512) ||
		input.Operation.Validate() != nil {
		return OperationMutation{}, repository.ErrTransaction
	}
	if input.IdempotencyScope != operationScope(input.Operation.ProjectID, input.Operation.Type) {
		return OperationMutation{}, repository.ErrTransaction
	}
	if input.Operation.Result != nil || input.Operation.Error != nil || input.Operation.Output != nil {
		return OperationMutation{}, repository.ErrTransaction
	}
	if !validOperationPayload(input.Payload) {
		return OperationMutation{}, repository.ErrTransaction
	}
	found, err := transaction.transaction.projectExists(ctx, input.Operation.ProjectID)
	if err != nil {
		return OperationMutation{}, err
	}
	if !found {
		return OperationMutation{}, repository.ErrNotFound
	}
	existing, exists, err := transaction.transaction.operationByScope(ctx, input.IdempotencyScope, *input.Operation.IdempotencyKey)
	if err != nil {
		return OperationMutation{}, err
	}
	if exists {
		if sameOperationCreate(existing, input) {
			return OperationMutation{Operation: existing.Operation}, nil
		}
		return OperationMutation{}, ErrIdempotencyConflict
	}
	if err := transaction.transaction.insertOperation(ctx, input.Operation, input.IdempotencyScope); err != nil {
		if !errors.Is(err, repository.ErrDuplicate) {
			return OperationMutation{}, err
		}
		existing, exists, lookupErr := transaction.transaction.operationByScope(ctx, input.IdempotencyScope, *input.Operation.IdempotencyKey)
		if lookupErr != nil {
			return OperationMutation{}, lookupErr
		}
		if exists && sameOperationCreate(existing, input) {
			return OperationMutation{Operation: existing.Operation}, nil
		}
		return OperationMutation{}, ErrIdempotencyConflict
	}
	event, err := transaction.transaction.appendOperationEvent(ctx, input.Operation, domainoperation.StatusQueued, input.Operation.RequestID, input.Payload)
	if err != nil {
		return OperationMutation{}, err
	}
	return OperationMutation{Operation: input.Operation, Event: &event, Changed: true}, nil
}

func (transaction *OperationTransaction) Get(ctx context.Context, projectID int64, operationID string) (domainoperation.Operation, bool, error) {
	if transaction == nil || transaction.transaction == nil || projectID <= 0 || !validOpaque(operationID, 128) {
		return domainoperation.Operation{}, false, repository.ErrTransaction
	}
	stored, found, err := transaction.transaction.operationByID(ctx, projectID, operationID)
	if err != nil || !found {
		return domainoperation.Operation{}, found, err
	}
	return stored.Operation, true, nil
}

func (transaction *OperationTransaction) List(ctx context.Context, query OperationListQuery) ([]domainoperation.Operation, error) {
	if transaction == nil || transaction.transaction == nil || query.ProjectID <= 0 ||
		(query.Type != "" && !validOpaque(query.Type, 128)) || (query.Status != "" && !query.Status.Valid()) {
		return nil, repository.ErrTransaction
	}
	if query.Limit <= 0 {
		query.Limit = 80
	}
	if query.Limit > 200 {
		query.Limit = 200
	}
	arguments := []any{query.ProjectID}
	where := "project_id = ?"
	if query.Type != "" {
		where += " AND type = ?"
		arguments = append(arguments, query.Type)
	}
	if query.Status != "" {
		where += " AND status = ?"
		arguments = append(arguments, string(query.Status))
	}
	arguments = append(arguments, query.Limit)
	direction := "ASC"
	if query.Descending {
		direction = "DESC"
	}
	rows, err := transaction.transaction.tx.QueryContext(ctx,
		"SELECT "+operationColumns+" FROM operations WHERE "+where+" ORDER BY created_at "+direction+", operation_id "+direction+" LIMIT ?", arguments...)
	if err != nil {
		return nil, safeSQLError(ctx, err)
	}
	defer rows.Close()
	result := make([]domainoperation.Operation, 0)
	for rows.Next() {
		stored, scanErr := scanOperation(rows)
		if scanErr != nil {
			return nil, scanErr
		}
		result = append(result, stored.Operation)
	}
	if err := rows.Err(); err != nil {
		return nil, safeSQLError(ctx, err)
	}
	return result, nil
}

func (transaction *OperationTransaction) Transition(ctx context.Context, input TransitionOperation) (OperationMutation, error) {
	if transaction == nil || transaction.transaction == nil || input.ProjectID <= 0 || !validOpaque(input.OperationID, 128) ||
		input.ExpectedVersion <= 0 || !input.Target.Valid() || !validOpaque(input.RequestID, 64) || !validUTCTimestamp(input.UpdatedAt) {
		return OperationMutation{}, repository.ErrTransaction
	}
	current, found, err := transaction.transaction.operationByID(ctx, input.ProjectID, input.OperationID)
	if err != nil {
		return OperationMutation{}, err
	}
	if !found {
		return OperationMutation{}, repository.ErrNotFound
	}
	disposition := domainoperation.ResolveTransition(current.Operation.Status, input.Target)
	if disposition == domainoperation.TransitionNoop {
		return OperationMutation{Operation: current.Operation}, nil
	}
	if disposition != domainoperation.TransitionApply {
		return OperationMutation{}, ErrOperationState
	}
	if current.Operation.Version != input.ExpectedVersion {
		return OperationMutation{}, repository.ErrVersionConflict
	}
	payload := input.Payload
	if len(payload) == 0 {
		payload = json.RawMessage(`{"status":"` + string(input.Target) + `"}`)
	}
	if !validOperationPayload(payload) {
		return OperationMutation{}, repository.ErrTransaction
	}
	next := current.Operation
	next.Status = input.Target
	next.UpdatedAt = input.UpdatedAt
	next.Version++
	switch input.Target {
	case domainoperation.StatusRunning:
		next.StartedAt = stringPointer(input.UpdatedAt)
		next.FinishedAt = nil
		next.Result = nil
		next.Error = nil
	case domainoperation.StatusSucceeded:
		next.FinishedAt = stringPointer(input.UpdatedAt)
		next.Result = cloneRaw(input.Result)
		next.Error = nil
	case domainoperation.StatusFailed, domainoperation.StatusInterrupted:
		next.FinishedAt = stringPointer(input.UpdatedAt)
		next.Result = nil
		next.Error = cloneError(input.Error)
	case domainoperation.StatusCancelled:
		next.FinishedAt = stringPointer(input.UpdatedAt)
		next.Result = nil
		next.Error = nil
	}
	if input.Output != nil {
		output := *input.Output
		next.Output = &output
	}
	if next.Validate() != nil {
		return OperationMutation{}, repository.ErrTransaction
	}
	if err := transaction.transaction.updateOperation(ctx, current.Operation, next); err != nil {
		return OperationMutation{}, err
	}
	event, err := transaction.transaction.appendOperationEvent(ctx, next, input.Target, input.RequestID, payload)
	if err != nil {
		return OperationMutation{}, err
	}
	return OperationMutation{Operation: next, Event: &event, Changed: true}, nil
}

func (transaction *OperationTransaction) RequestCancellation(ctx context.Context, input CancelOperation) (OperationMutation, error) {
	if transaction == nil || transaction.transaction == nil || input.ProjectID <= 0 || !validOpaque(input.OperationID, 128) ||
		input.ExpectedVersion <= 0 || !validOpaque(input.RequestID, 64) || !validUTCTimestamp(input.RequestedAt) {
		return OperationMutation{}, repository.ErrTransaction
	}
	current, found, err := transaction.transaction.operationByID(ctx, input.ProjectID, input.OperationID)
	if err != nil {
		return OperationMutation{}, err
	}
	if !found {
		return OperationMutation{}, repository.ErrNotFound
	}
	if current.Operation.Status.Terminal() || (current.Operation.Status == domainoperation.StatusRunning && current.Operation.CancelRequestedAt != nil) {
		return OperationMutation{Operation: current.Operation}, nil
	}
	if current.Operation.Version != input.ExpectedVersion {
		return OperationMutation{}, repository.ErrVersionConflict
	}
	if current.Operation.Status == domainoperation.StatusQueued {
		return transaction.Transition(ctx, TransitionOperation{
			ProjectID: input.ProjectID, OperationID: input.OperationID, ExpectedVersion: input.ExpectedVersion,
			Target: domainoperation.StatusCancelled, RequestID: input.RequestID, UpdatedAt: input.RequestedAt,
			Payload: json.RawMessage(`{"status":"cancelled"}`),
		})
	}
	if current.Operation.Status != domainoperation.StatusRunning {
		return OperationMutation{}, ErrOperationState
	}
	next := current.Operation
	next.CancelRequestedAt = stringPointer(input.RequestedAt)
	next.UpdatedAt = input.RequestedAt
	next.Version++
	if next.Validate() != nil {
		return OperationMutation{}, repository.ErrTransaction
	}
	if err := transaction.transaction.updateOperation(ctx, current.Operation, next); err != nil {
		return OperationMutation{}, err
	}
	event, err := transaction.transaction.appendOperationEvent(ctx, next, domainoperation.StatusRunning, input.RequestID,
		json.RawMessage(`{"cancel_requested":true}`))
	if err != nil {
		return OperationMutation{}, err
	}
	return OperationMutation{Operation: next, Event: &event, Changed: true}, nil
}

// RecoverProcessOwnership applies the fail-closed restart policy for Script
// and Executor process work. There is no PID lookup or relaunch path: only
// records known to be running are transitioned to interrupted, and plugin
// live state is reset. Every Operation/resource/outbox mutation is performed
// through one OperationTransaction, so a crash leaves either the old state or
// the complete recovered state.
func (writer *Writer) RecoverProcessOwnership(
	ctx context.Context,
	input applicationruntime.ProcessRecoveryInput,
) (applicationruntime.ProcessRecoveryResult, error) {
	if writer == nil || !input.Valid() {
		return applicationruntime.ProcessRecoveryResult{}, repository.ErrTransaction
	}
	result := applicationruntime.ProcessRecoveryResult{}
	err := writer.TransactOperations(ctx, func(transaction *OperationTransaction) error {
		operations, err := transaction.transaction.listRunningProcessOperations(ctx, input.MaximumRecords)
		if err != nil {
			return err
		}
		if len(operations) > input.MaximumRecords {
			return repository.ErrTransaction
		}
		for _, current := range operations {
			updatedAt, timestampErr := recoveryTimestamp(current.Operation.UpdatedAt, input.OccurredAt)
			if timestampErr != nil {
				return repository.ErrTransaction
			}
			mutation, transitionErr := transaction.Transition(ctx, TransitionOperation{
				ProjectID: current.Operation.ProjectID, OperationID: current.Operation.OperationID,
				ExpectedVersion: current.Operation.Version, Target: domainoperation.StatusInterrupted,
				RequestID: input.RequestID, UpdatedAt: updatedAt,
				Error:   &domainoperation.ErrorSummary{Code: "RECOVERY_INTERRUPTED", Summary: "Process ownership was interrupted during startup recovery."},
				Payload: json.RawMessage(`{"status":"interrupted","failure_code":"RECOVERY_INTERRUPTED"}`),
			})
			if transitionErr != nil {
				return transitionErr
			}
			if mutation.Changed {
				result.InterruptedOperations++
				payload, payloadErr := runtimeRecoveryOperationPayload(mutation.Operation.OperationID)
				if payloadErr != nil {
					return payloadErr
				}
				if auditErr := transaction.transaction.appendRuntimeAudit(ctx, mutation.Operation.ProjectID,
					"runtime.process.operation_interrupted", "Process operation was interrupted during startup recovery.", updatedAt, payload); auditErr != nil {
					return auditErr
				}
			}
		}

		remaining := input.MaximumRecords - result.InterruptedOperations
		scripts, scriptErr := transaction.transaction.listRunningScriptResources(ctx, remaining)
		if scriptErr != nil {
			return scriptErr
		}
		if len(scripts) > remaining {
			return repository.ErrTransaction
		}
		remaining -= len(scripts)
		executors, executorErr := transaction.transaction.listRunningExecutorResources(ctx, remaining)
		if executorErr != nil {
			return executorErr
		}
		if len(executors) > remaining {
			return repository.ErrTransaction
		}
		for _, script := range scripts {
			if !archiveAfter(input.OccurredAt, script.createdAt) {
				return repository.ErrTransaction
			}
			if err := transaction.transaction.interruptScriptResource(ctx, script, input); err != nil {
				return err
			}
			result.InterruptedScripts++
		}
		for _, executor := range executors {
			if !archiveAfter(input.OccurredAt, executor.createdAt) {
				return repository.ErrTransaction
			}
			if err := transaction.transaction.interruptExecutorResource(ctx, executor, input); err != nil {
				return err
			}
			result.InterruptedExecutors++
		}
		return nil
	})
	if err != nil {
		return applicationruntime.ProcessRecoveryResult{}, err
	}
	return result, nil
}

type runningRuntimeResource struct {
	projectID int64
	id        int64
	createdAt string
}

func (transaction *writeTransaction) listRunningProcessOperations(ctx context.Context, maximum int) ([]storedOperation, error) {
	if maximum <= 0 {
		return nil, repository.ErrTransaction
	}
	rows, err := transaction.tx.QueryContext(ctx,
		`SELECT `+operationColumns+` FROM operations
		  WHERE status = ? AND (type = 'script.run' OR type = 'executor.run' OR type = 'executor.action')
		  ORDER BY project_id ASC, created_at ASC, operation_id ASC LIMIT ?`, string(domainoperation.StatusRunning), maximum+1)
	if err != nil {
		return nil, safeSQLError(ctx, err)
	}
	defer rows.Close()
	result := make([]storedOperation, 0)
	for rows.Next() {
		item, scanErr := scanOperation(rows)
		if scanErr != nil {
			return nil, safeOperationError(ctx, scanErr)
		}
		result = append(result, item)
	}
	if err := rows.Err(); err != nil {
		return nil, safeSQLError(ctx, err)
	}
	return result, nil
}

func (transaction *writeTransaction) listRunningScriptResources(ctx context.Context, maximum int) ([]runningRuntimeResource, error) {
	return transaction.listRunningRuntimeResources(ctx, "scripts", maximum)
}

func (transaction *writeTransaction) listRunningExecutorResources(ctx context.Context, maximum int) ([]runningRuntimeResource, error) {
	return transaction.listRunningRuntimeResources(ctx, "executors", maximum)
}

func (transaction *writeTransaction) listRunningRuntimeResources(ctx context.Context, table string, maximum int) ([]runningRuntimeResource, error) {
	if maximum < 0 || (table != "scripts" && table != "executors") {
		return nil, repository.ErrTransaction
	}
	limit := maximum + 1
	rows, err := transaction.tx.QueryContext(ctx,
		"SELECT project_id, id, created_at FROM "+table+" WHERE last_status = 'running' ORDER BY project_id ASC, id ASC LIMIT ?", limit)
	if err != nil {
		return nil, safeSQLError(ctx, err)
	}
	defer rows.Close()
	result := make([]runningRuntimeResource, 0)
	for rows.Next() {
		var item runningRuntimeResource
		if err := rows.Scan(&item.projectID, &item.id, &item.createdAt); err != nil {
			return nil, safeSQLError(ctx, err)
		}
		if item.projectID <= 0 || item.id <= 0 || !validUTCTimestamp(item.createdAt) {
			return nil, repository.ErrInvalidStore
		}
		result = append(result, item)
	}
	if err := rows.Err(); err != nil {
		return nil, safeSQLError(ctx, err)
	}
	return result, nil
}

func (transaction *writeTransaction) interruptScriptResource(
	ctx context.Context,
	resource runningRuntimeResource,
	input applicationruntime.ProcessRecoveryInput,
) error {
	result, err := transaction.tx.ExecContext(ctx,
		`UPDATE scripts
		    SET last_status = 'interrupted', last_exit_code = NULL, last_duration_ms = NULL,
		        last_log = ?, last_run_at = ?, updated_at = ?
		  WHERE id = ? AND project_id = ? AND last_status = 'running'`,
		"Process ownership was interrupted during startup recovery.", input.OccurredAt, input.OccurredAt,
		resource.id, resource.projectID)
	if err != nil {
		return safeSQLError(ctx, err)
	}
	if err := requireOneRow(result); err != nil {
		return err
	}
	if err := transaction.wrote("scripts:recover-interrupted"); err != nil {
		return err
	}
	payload, err := runtimeRecoveryPayload(resource.id)
	if err != nil {
		return err
	}
	_, err = transaction.appendBusinessEvent(ctx, BusinessEvent{
		ProjectID: resource.projectID, Type: "business.script.runtime_interrupted", RequestID: input.RequestID,
		OccurredAt: input.OccurredAt, Payload: payload,
	})
	if err != nil {
		return err
	}
	return transaction.appendRuntimeAudit(ctx, resource.projectID, "runtime.script.interrupted",
		"Script process ownership was interrupted during startup recovery.", input.OccurredAt, payload)
}

func (transaction *writeTransaction) interruptExecutorResource(
	ctx context.Context,
	resource runningRuntimeResource,
	input applicationruntime.ProcessRecoveryInput,
) error {
	pluginState := json.RawMessage(`{"running":false,"state":"stopped","reason":"recovery_interrupted"}`)
	result, err := transaction.tx.ExecContext(ctx,
		`UPDATE executors
		    SET last_status = 'interrupted', last_exit_code = NULL, last_duration_ms = NULL,
		        last_log = ?, last_run_at = ?,
		        plugin_state_json = CASE WHEN type = 'plugin' THEN ? ELSE NULL END,
		        updated_at = ?
		  WHERE id = ? AND project_id = ? AND last_status = 'running'`,
		"Process ownership was interrupted during startup recovery.", input.OccurredAt, string(pluginState), input.OccurredAt,
		resource.id, resource.projectID)
	if err != nil {
		return safeSQLError(ctx, err)
	}
	if err := requireOneRow(result); err != nil {
		return err
	}
	if err := transaction.wrote("executors:recover-interrupted"); err != nil {
		return err
	}
	payload, err := runtimeRecoveryPayload(resource.id)
	if err != nil {
		return err
	}
	_, err = transaction.appendBusinessEvent(ctx, BusinessEvent{
		ProjectID: resource.projectID, Type: "business.executor.runtime_interrupted", RequestID: input.RequestID,
		OccurredAt: input.OccurredAt, Payload: payload,
	})
	if err != nil {
		return err
	}
	return transaction.appendRuntimeAudit(ctx, resource.projectID, "runtime.executor.interrupted",
		"Executor process ownership was interrupted during startup recovery.", input.OccurredAt, payload)
}

func runtimeRecoveryPayload(resourceID int64) (json.RawMessage, error) {
	encoded, err := json.Marshal(map[string]any{
		"resource_id":  resourceID,
		"status":       "interrupted",
		"failure_code": "RECOVERY_INTERRUPTED",
	})
	if err != nil {
		return nil, repository.ErrTransaction
	}
	return json.RawMessage(encoded), nil
}

func runtimeRecoveryOperationPayload(operationID string) (json.RawMessage, error) {
	encoded, err := json.Marshal(map[string]any{
		"operation_id": operationID,
		"status":       "interrupted",
		"failure_code": "RECOVERY_INTERRUPTED",
	})
	if err != nil {
		return nil, repository.ErrTransaction
	}
	return json.RawMessage(encoded), nil
}

func recoveryTimestamp(previous, candidate string) (string, error) {
	previousAt, previousErr := time.Parse(time.RFC3339Nano, previous)
	candidateAt, candidateErr := time.Parse(time.RFC3339Nano, candidate)
	if previousErr != nil || candidateErr != nil || previousAt.Location() != time.UTC || candidateAt.Location() != time.UTC {
		return "", repository.ErrTransaction
	}
	if !candidateAt.After(previousAt) {
		candidateAt = previousAt.Add(time.Millisecond)
	}
	return candidateAt.UTC().Format(time.RFC3339Nano), nil
}

func (transaction *writeTransaction) operationByScope(ctx context.Context, scope, key string) (storedOperation, bool, error) {
	stored, err := scanOperation(transaction.tx.QueryRowContext(ctx,
		"SELECT "+operationColumns+" FROM operations WHERE idempotency_scope = ? AND idempotency_key = ?", scope, key))
	if err == sql.ErrNoRows {
		return storedOperation{}, false, nil
	}
	if err != nil {
		return storedOperation{}, false, safeOperationError(ctx, err)
	}
	return stored, true, nil
}

func (transaction *writeTransaction) operationByID(ctx context.Context, projectID int64, operationID string) (storedOperation, bool, error) {
	stored, err := scanOperation(transaction.tx.QueryRowContext(ctx,
		"SELECT "+operationColumns+" FROM operations WHERE project_id = ? AND operation_id = ?", projectID, operationID))
	if err == sql.ErrNoRows {
		return storedOperation{}, false, nil
	}
	if err != nil {
		return storedOperation{}, false, safeOperationError(ctx, err)
	}
	return stored, true, nil
}

func (transaction *writeTransaction) insertOperation(ctx context.Context, value domainoperation.Operation, scope string) error {
	resultJSON, err := encodeResult(value.Result)
	if err != nil {
		return err
	}
	errorJSON, err := encodeErrorSummary(value.Error)
	if err != nil {
		return err
	}
	outputJSON, err := encodeOutput(value.Output)
	if err != nil {
		return err
	}
	_, err = transaction.tx.ExecContext(ctx,
		`INSERT INTO operations (
		 operation_id, project_id, type, status, request_id, idempotency_scope, idempotency_key,
		 request_hash, cancel_requested_at, created_at, updated_at, started_at, finished_at,
		 result_json, error_json, output_json, version
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		value.OperationID, value.ProjectID, value.Type, string(value.Status), value.RequestID, scope, value.IdempotencyKey,
		value.RequestDigest, optionalString(value.CancelRequestedAt), value.CreatedAt, value.UpdatedAt,
		optionalString(value.StartedAt), optionalString(value.FinishedAt), resultJSON, errorJSON, outputJSON, value.Version)
	if err != nil {
		return safeSQLError(ctx, err)
	}
	return transaction.wrote("operations:create")
}

func (transaction *writeTransaction) updateOperation(ctx context.Context, previous, next domainoperation.Operation) error {
	resultJSON, err := encodeResult(next.Result)
	if err != nil {
		return err
	}
	errorJSON, err := encodeErrorSummary(next.Error)
	if err != nil {
		return err
	}
	outputJSON, err := encodeOutput(next.Output)
	if err != nil {
		return err
	}
	result, err := transaction.tx.ExecContext(ctx,
		`UPDATE operations
		    SET status = ?, cancel_requested_at = ?, updated_at = ?, started_at = ?, finished_at = ?,
		        result_json = ?, error_json = ?, output_json = ?, version = ?
		  WHERE operation_id = ? AND project_id = ? AND version = ? AND status = ?`,
		string(next.Status), optionalString(next.CancelRequestedAt), next.UpdatedAt, optionalString(next.StartedAt),
		optionalString(next.FinishedAt), resultJSON, errorJSON, outputJSON, next.Version,
		previous.OperationID, previous.ProjectID, previous.Version, string(previous.Status))
	if err != nil {
		return safeSQLError(ctx, err)
	}
	if err := requireOneRow(result); err != nil {
		if errors.Is(err, repository.ErrNotFound) {
			return repository.ErrVersionConflict
		}
		return err
	}
	return transaction.wrote("operations:update")
}

func (transaction *writeTransaction) appendOperationEvent(
	ctx context.Context,
	operation domainoperation.Operation,
	status domainoperation.Status,
	requestID string,
	payload json.RawMessage,
) (domainevents.Envelope, error) {
	revision, err := transaction.allocateProjectRevision(ctx, operation.ProjectID)
	if err != nil {
		return domainevents.Envelope{}, err
	}
	eventID, err := transaction.allocateEventID(ctx)
	if err != nil {
		return domainevents.Envelope{}, err
	}
	operationID := operation.OperationID
	revisionValue := revision
	requestIDValue := requestID
	envelope := domainevents.Envelope{
		SchemaVersion: domainevents.SchemaVersion, Class: domainevents.ClassOperation,
		EventID: &eventID, ProjectID: operation.ProjectID, ProjectRevision: &revisionValue,
		Type: "operation." + string(status), OperationID: &operationID, RequestID: &requestIDValue,
		OccurredAt: operation.UpdatedAt, Payload: cloneRawValue(payload),
	}
	if envelope.Validate() != nil {
		return domainevents.Envelope{}, repository.ErrTransaction
	}
	_, err = transaction.tx.ExecContext(ctx,
		`INSERT INTO event_outbox (
		 event_id, schema_version, event_class, stream_key, sequence, type, request_id, operation_id,
		 project_id, project_revision, occurred_at, data_json, created_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		eventID, envelope.SchemaVersion, string(envelope.Class), "p10:project:"+strconv.FormatInt(operation.ProjectID, 10), revision,
		envelope.Type, requestID, operationID, operation.ProjectID, revision, operation.UpdatedAt, string(payload), operation.UpdatedAt)
	if err != nil {
		return domainevents.Envelope{}, safeSQLError(ctx, err)
	}
	if err := transaction.wrote("event-outbox:append-operation"); err != nil {
		return domainevents.Envelope{}, err
	}
	return envelope, nil
}

func scanOperation(row rowScanner) (storedOperation, error) {
	var result storedOperation
	var status string
	var projectID sql.NullInt64
	var key, cancelRequestedAt, startedAt, finishedAt, resultJSON, errorJSON, outputJSON sql.NullString
	if err := row.Scan(
		&result.Operation.OperationID, &projectID, &result.Operation.Type, &status, &result.Operation.RequestID,
		&result.IdempotencyScope, &key, &result.Operation.RequestDigest, &cancelRequestedAt, &result.Operation.CreatedAt,
		&result.Operation.UpdatedAt, &startedAt, &finishedAt, &resultJSON, &errorJSON, &outputJSON, &result.Operation.Version,
	); err != nil {
		return storedOperation{}, err
	}
	if !projectID.Valid {
		return storedOperation{}, repository.ErrInvalidStore
	}
	result.Operation.ProjectID = projectID.Int64
	result.Operation.Status = domainoperation.Status(status)
	result.Operation.IdempotencyKey = nullStringPointer(key)
	result.Operation.CancelRequestedAt = nullStringPointer(cancelRequestedAt)
	result.Operation.StartedAt = nullStringPointer(startedAt)
	result.Operation.FinishedAt = nullStringPointer(finishedAt)
	decodedResult, err := decodeResult(resultJSON)
	if err != nil {
		return storedOperation{}, err
	}
	decodedError, err := decodeErrorSummary(errorJSON)
	if err != nil {
		return storedOperation{}, err
	}
	decodedOutput, err := decodeOutput(outputJSON)
	if err != nil {
		return storedOperation{}, err
	}
	result.Operation.Result = decodedResult
	result.Operation.Error = decodedError
	result.Operation.Output = decodedOutput
	if !validOpaque(result.IdempotencyScope, 512) || result.Operation.Validate() != nil {
		return storedOperation{}, repository.ErrInvalidStore
	}
	return result, nil
}

func sameOperationCreate(existing storedOperation, input CreateOperation) bool {
	return existing.IdempotencyScope == input.IdempotencyScope && existing.Operation.ProjectID == input.Operation.ProjectID &&
		existing.Operation.Type == input.Operation.Type && existing.Operation.RequestDigest == input.Operation.RequestDigest &&
		existing.Operation.IdempotencyKey != nil && input.Operation.IdempotencyKey != nil &&
		*existing.Operation.IdempotencyKey == *input.Operation.IdempotencyKey
}

func operationScope(projectID int64, operationType string) string {
	return fmt.Sprintf("project:%d:%s", projectID, operationType)
}

func validOperationPayload(payload json.RawMessage) bool {
	probeID, requestID, operationID := "1", "payload-check", "operation-check"
	revision := int64(1)
	return (domainevents.Envelope{
		SchemaVersion: domainevents.SchemaVersion, Class: domainevents.ClassOperation,
		EventID: &probeID, ProjectID: 1, ProjectRevision: &revision, Type: domainevents.TypeOperationQueued,
		OperationID: &operationID, RequestID: &requestID, OccurredAt: "2026-01-01T00:00:00Z", Payload: payload,
	}).Validate() == nil
}

func encodeResult(value *json.RawMessage) (any, error) {
	if value == nil {
		return nil, nil
	}
	if len(*value) == 0 || len(*value) > 8192 || !json.Valid(*value) {
		return nil, repository.ErrTransaction
	}
	return string(*value), nil
}

func decodeResult(value sql.NullString) (*json.RawMessage, error) {
	if !value.Valid {
		return nil, nil
	}
	if len(value.String) == 0 || len(value.String) > 8192 || !json.Valid([]byte(value.String)) {
		return nil, repository.ErrInvalidStore
	}
	raw := json.RawMessage([]byte(value.String))
	return &raw, nil
}

func encodeErrorSummary(value *domainoperation.ErrorSummary) (any, error) {
	if value == nil {
		return nil, nil
	}
	if value.Validate() != nil {
		return nil, repository.ErrTransaction
	}
	encoded, err := json.Marshal(value)
	if err != nil || len(encoded) == 0 || len(encoded) > 2048 {
		return nil, repository.ErrTransaction
	}
	return string(encoded), nil
}

func decodeErrorSummary(value sql.NullString) (*domainoperation.ErrorSummary, error) {
	if !value.Valid {
		return nil, nil
	}
	var result domainoperation.ErrorSummary
	if !decodeStrictJSON(value.String, &result) || result.Validate() != nil {
		return nil, repository.ErrInvalidStore
	}
	return &result, nil
}

func encodeOutput(value *domainoperation.OutputMetadata) (any, error) {
	if value == nil {
		return nil, nil
	}
	if value.Validate() != nil {
		return nil, repository.ErrTransaction
	}
	encoded, err := json.Marshal(value)
	if err != nil || len(encoded) == 0 || len(encoded) > 1024 {
		return nil, repository.ErrTransaction
	}
	return string(encoded), nil
}

func decodeOutput(value sql.NullString) (*domainoperation.OutputMetadata, error) {
	if !value.Valid {
		return nil, nil
	}
	var result domainoperation.OutputMetadata
	if !decodeStrictJSON(value.String, &result) || result.Validate() != nil {
		return nil, repository.ErrInvalidStore
	}
	return &result, nil
}

func decodeStrictJSON(value string, target any) bool {
	decoder := json.NewDecoder(strings.NewReader(value))
	decoder.DisallowUnknownFields()
	if decoder.Decode(target) != nil {
		return false
	}
	var trailing any
	return decoder.Decode(&trailing) == io.EOF
}

func cloneRaw(value *json.RawMessage) *json.RawMessage {
	if value == nil {
		return nil
	}
	copyValue := json.RawMessage(append([]byte(nil), (*value)...))
	return &copyValue
}

func cloneRawValue(value json.RawMessage) json.RawMessage {
	return append(json.RawMessage(nil), value...)
}

func cloneError(value *domainoperation.ErrorSummary) *domainoperation.ErrorSummary {
	if value == nil {
		return nil
	}
	copyValue := *value
	return &copyValue
}

func stringPointer(value string) *string { return &value }

func validUTCTimestamp(value string) bool {
	if !strings.HasSuffix(value, "Z") {
		return false
	}
	parsed, err := time.Parse(time.RFC3339Nano, value)
	return err == nil && parsed.Location() == time.UTC
}

func safeOperationError(ctx context.Context, err error) error {
	if errors.Is(err, repository.ErrInvalidStore) {
		return err
	}
	return safeSQLError(ctx, err)
}
