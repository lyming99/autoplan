// Package acceptance owns the runtime admission path for plan and task
// acceptance mutations. Persistence remains delegated to the Plan service;
// this package adds durable Operation lifecycle and the shared command shape.
package acceptance

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"

	"github.com/lyming99/autoplan/backend/internal/application/capabilities"
	applicationloop "github.com/lyming99/autoplan/backend/internal/application/loop"
	applicationoperations "github.com/lyming99/autoplan/backend/internal/application/operations"
	applicationplans "github.com/lyming99/autoplan/backend/internal/application/plans"
	"github.com/lyming99/autoplan/backend/internal/domain/contracts"
	domainoperation "github.com/lyming99/autoplan/backend/internal/domain/operation"
	domainproject "github.com/lyming99/autoplan/backend/internal/domain/project"
	"github.com/lyming99/autoplan/backend/internal/repository"
)

var commandKinds = []applicationloop.CommandKind{
	applicationloop.CommandAcceptanceAccept,
	applicationloop.CommandAcceptanceUnaccept,
	applicationloop.CommandAcceptanceRedo,
	applicationloop.CommandAcceptanceAcceptBatch,
	applicationloop.CommandAcceptanceUnacceptBatch,
}

type RuntimeHandler struct {
	plans      *applicationplans.Service
	operations *applicationoperations.Service
}

func NewRuntimeHandler(plans *applicationplans.Service, operations *applicationoperations.Service) *RuntimeHandler {
	return &RuntimeHandler{plans: plans, operations: operations}
}

func (handler *RuntimeHandler) Commands() []applicationloop.CommandKind {
	return append([]applicationloop.CommandKind(nil), commandKinds...)
}

func (handler *RuntimeHandler) Execute(ctx context.Context, command applicationloop.Command) (applicationloop.Result, error) {
	if handler == nil || handler.plans == nil || handler.operations == nil || !handler.operations.Configured() {
		return applicationloop.Result{}, applicationloop.ErrUnavailable
	}
	intent, err := acceptanceIntent(command)
	if err != nil {
		return applicationloop.Result{}, err
	}
	digest := acceptanceDigest(command, intent)
	caller := applicationoperations.Caller{ID: command.CallerScope, ProjectID: command.ProjectID}
	created, err := handler.operations.CreateOrReuse(ctx, applicationoperations.CreateCommand{
		Caller: caller, ProjectID: command.ProjectID, Type: string(command.Kind),
		IdempotencyKey: command.IdempotencyKey, RequestDigest: digest, RequestID: command.RequestID,
	})
	if err != nil {
		return applicationloop.Result{}, mapOperationError(err)
	}
	if !created.Changed {
		return operationResult(created.Operation, nil)
	}
	claimed, err := handler.operations.Claim(ctx, applicationoperations.ClaimCommand{
		Caller: caller, ProjectID: command.ProjectID, OperationID: created.Operation.OperationID,
		ExpectedVersion: created.Operation.Version, RequestDigest: digest, RequestID: command.RequestID,
	})
	if err != nil {
		return applicationloop.Result{}, mapOperationError(err)
	}

	mutation, err := handler.mutate(ctx, command, intent)
	if err != nil {
		handler.fail(ctx, caller, claimed.Operation, command.RequestID)
		return applicationloop.Result{}, mapPlanError(err)
	}
	encoded, err := json.Marshal(struct {
		Items []applicationplans.AcceptanceResult `json:"items"`
	}{Items: mutation.Items})
	if err != nil {
		handler.fail(ctx, caller, claimed.Operation, command.RequestID)
		return applicationloop.Result{}, applicationloop.ErrStateConflict
	}
	result := json.RawMessage(encoded)
	completed, err := handler.operations.Succeed(ctx, applicationoperations.CompleteCommand{
		Caller: caller, ProjectID: command.ProjectID, OperationID: claimed.Operation.OperationID,
		ExpectedVersion: claimed.Operation.Version, RequestID: command.RequestID, Result: &result,
	})
	if err != nil {
		handler.fail(ctx, caller, claimed.Operation, command.RequestID)
		return applicationloop.Result{}, mapOperationError(err)
	}
	return operationResult(completed.Operation, &mutation.Snapshot)
}

type intent struct {
	targets    []applicationplans.AcceptanceTarget
	supplement string
}

func acceptanceIntent(command applicationloop.Command) (intent, error) {
	if command.Acceptance == nil || command.PlanID != 0 || command.TaskID != 0 || command.Action != "" ||
		command.ExpectedUpdatedAt != "" || command.ExpectedVersion != 0 {
		return intent{}, applicationloop.ErrInvalidCommand
	}
	targets := command.Acceptance.Targets
	single := command.Kind == applicationloop.CommandAcceptanceAccept ||
		command.Kind == applicationloop.CommandAcceptanceUnaccept || command.Kind == applicationloop.CommandAcceptanceRedo
	batch := command.Kind == applicationloop.CommandAcceptanceAcceptBatch ||
		command.Kind == applicationloop.CommandAcceptanceUnacceptBatch
	if (!single && !batch) || (single && len(targets) != 1) || (batch && len(targets) == 0) ||
		(command.Kind != applicationloop.CommandAcceptanceRedo && command.Acceptance.Supplement != "") {
		return intent{}, applicationloop.ErrInvalidCommand
	}
	result := intent{targets: make([]applicationplans.AcceptanceTarget, 0, len(targets)), supplement: command.Acceptance.Supplement}
	for _, target := range targets {
		kind := applicationplans.TargetType(target.TargetType)
		if !kind.Valid() || target.ID <= 0 {
			return intent{}, applicationloop.ErrInvalidCommand
		}
		result.targets = append(result.targets, applicationplans.AcceptanceTarget{TargetType: kind, ID: target.ID})
	}
	return result, nil
}

func (handler *RuntimeHandler) mutate(ctx context.Context, command applicationloop.Command, value intent) (applicationplans.MutationResult, error) {
	if command.Kind == applicationloop.CommandAcceptanceRedo {
		return handler.plans.RedoRuntime(ctx, applicationplans.RedoCommand{
			ProjectID: command.ProjectID, Target: value.targets[0], Supplement: value.supplement, RequestID: command.RequestID,
		}, domainproject.Visibility{})
	}
	accept := command.Kind == applicationloop.CommandAcceptanceAccept || command.Kind == applicationloop.CommandAcceptanceAcceptBatch
	return handler.plans.SetRuntimeAcceptances(ctx, applicationplans.BatchAcceptanceCommand{
		ProjectID: command.ProjectID, Targets: value.targets, Accept: accept, RequestID: command.RequestID,
	}, domainproject.Visibility{})
}

func acceptanceDigest(command applicationloop.Command, value intent) string {
	encoded, _ := json.Marshal(struct {
		Kind       applicationloop.CommandKind         `json:"kind"`
		ProjectID  int64                               `json:"project_id"`
		Targets    []applicationplans.AcceptanceTarget `json:"targets"`
		Supplement string                              `json:"supplement,omitempty"`
	}{command.Kind, command.ProjectID, value.targets, value.supplement})
	digest := sha256.Sum256(encoded)
	return hex.EncodeToString(digest[:])
}

func (handler *RuntimeHandler) fail(ctx context.Context, caller applicationoperations.Caller, operation domainoperation.Operation, requestID string) {
	_, _ = handler.operations.Fail(ctx, applicationoperations.FailCommand{
		Caller: caller, ProjectID: operation.ProjectID, OperationID: operation.OperationID,
		ExpectedVersion: operation.Version, RequestID: requestID,
		Code: "ACCEPTANCE_MUTATION_FAILED", Summary: "Acceptance state could not be updated.",
	})
}

func operationResult(operation domainoperation.Operation, snapshot *contracts.AppSnapshot) (applicationloop.Result, error) {
	status := string(operation.Status)
	switch operation.Status {
	case domainoperation.StatusSucceeded:
		status = "completed"
	case domainoperation.StatusCancelled:
		status = "cancelled"
	case domainoperation.StatusQueued:
		status = "queued"
	case domainoperation.StatusRunning:
		status = "running"
	default:
		return applicationloop.Result{}, applicationloop.ErrStateConflict
	}
	result := applicationloop.Result{Operation: capabilities.OperationReference{
		OperationID: operation.OperationID, Type: operation.Type, Status: status,
		RequestID: operation.RequestID, AcceptedAt: operation.CreatedAt,
	}, Snapshot: snapshot}
	return result, nil
}

func mapOperationError(err error) error {
	switch {
	case errors.Is(err, applicationoperations.ErrUnavailable), errors.Is(err, applicationoperations.ErrHandlerUnavailable):
		return applicationloop.ErrUnavailable
	case errors.Is(err, applicationoperations.ErrInvalidCommand), errors.Is(err, applicationoperations.ErrUnauthorized),
		errors.Is(err, applicationoperations.ErrIdempotencyConflict):
		return applicationloop.ErrInvalidCommand
	default:
		return applicationloop.ErrStateConflict
	}
}

func mapPlanError(err error) error {
	switch {
	case errors.Is(err, applicationplans.ErrUnavailable), errors.Is(err, repository.ErrNotConfigured), errors.Is(err, repository.ErrClosed):
		return applicationloop.ErrUnavailable
	case errors.Is(err, applicationplans.ErrInvalidCommand), errors.Is(err, repository.ErrNotFound):
		return applicationloop.ErrInvalidCommand
	default:
		return applicationloop.ErrStateConflict
	}
}

type recoveryHandler struct{ operationType string }

func (handler recoveryHandler) Type() string { return handler.operationType }
func (recoveryHandler) CanRecover(context.Context, domainoperation.Operation) (bool, error) {
	return false, nil
}

func RecoveryHandlers() []applicationoperations.RecoveryHandler {
	result := make([]applicationoperations.RecoveryHandler, 0, len(commandKinds))
	for _, kind := range commandKinds {
		result = append(result, recoveryHandler{operationType: string(kind)})
	}
	return result
}

var _ applicationloop.Handler = (*RuntimeHandler)(nil)
var _ applicationoperations.RecoveryHandler = recoveryHandler{}
