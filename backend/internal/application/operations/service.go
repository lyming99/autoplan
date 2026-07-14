package operations

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"sort"
	"strconv"
	"time"

	domainoperation "github.com/lyming99/autoplan/backend/internal/domain/operation"
	"github.com/lyming99/autoplan/backend/internal/repository"
	"github.com/lyming99/autoplan/backend/internal/repository/sqlite"
)

type ProjectSource interface {
	ListProjects(context.Context) ([]repository.Project, error)
}

// ChatProviderOperationType is claimed only by the P13 Chat application
// service after its durable turn claim. It deliberately has no generic
// recovery handler: a daemon restart must interrupt it rather than replay a
// provider side effect whose request may already have reached the provider.
const ChatProviderOperationType = "chat.provider"

// RecoveryHandler may only prove whether it can safely claim a queued record.
// It must not start a process or perform the operation's side effect; a caller
// invokes the regular runner after Claim has committed the running state.
type RecoveryHandler interface {
	Type() string
	CanRecover(context.Context, domainoperation.Operation) (bool, error)
}

type Dependencies struct {
	Store                Store
	Projects             ProjectSource
	Clock                Clock
	NewID                func() string
	QueuedRecoveryMaxAge time.Duration
	RecoveryHandlers     []RecoveryHandler
}

type Service struct {
	store                Store
	projects             ProjectSource
	clock                Clock
	newID                func() string
	queuedRecoveryMaxAge time.Duration
	handlers             map[string]RecoveryHandler
	invalidHandlers      bool
}

type CreateCommand struct {
	Caller         Caller
	ProjectID      int64
	Type           string
	IdempotencyKey string
	RequestDigest  string
	RequestID      string
}

type Query struct {
	Caller      Caller
	ProjectID   int64
	OperationID string
}

type ClaimCommand struct {
	Caller          Caller
	ProjectID       int64
	OperationID     string
	ExpectedVersion int64
	RequestDigest   string
	RequestID       string
}

type CompleteCommand struct {
	Caller          Caller
	ProjectID       int64
	OperationID     string
	ExpectedVersion int64
	RequestID       string
	Result          *json.RawMessage
	Output          *OutputCapture
}

type FailCommand struct {
	Caller          Caller
	ProjectID       int64
	OperationID     string
	ExpectedVersion int64
	RequestID       string
	Code            string
	Summary         string
	Output          *OutputCapture
}

type CancelCommand struct {
	Caller          Caller
	ProjectID       int64
	OperationID     string
	ExpectedVersion int64
	RequestID       string
	Output          *OutputCapture
}

type Result struct {
	Operation domainoperation.Operation `json:"operation"`
	Changed   bool                      `json:"changed"`
}

func NewService(dependencies Dependencies) *Service {
	clock := dependencies.Clock
	if clock == nil {
		clock = systemClock{}
	}
	newID := dependencies.NewID
	if newID == nil {
		newID = newOperationID
	}
	handlers := make(map[string]RecoveryHandler, len(dependencies.RecoveryHandlers))
	invalidHandlers := false
	for _, handler := range dependencies.RecoveryHandlers {
		if handler == nil || !validCommandID(handler.Type()) {
			invalidHandlers = true
			continue
		}
		if _, exists := handlers[handler.Type()]; exists {
			invalidHandlers = true
			continue
		}
		handlers[handler.Type()] = handler
	}
	return &Service{
		store: dependencies.Store, projects: dependencies.Projects, clock: clock, newID: newID,
		queuedRecoveryMaxAge: dependencies.QueuedRecoveryMaxAge, handlers: handlers, invalidHandlers: invalidHandlers,
	}
}

func NewSQLiteStore(writer *sqlite.Writer) Store {
	if writer == nil {
		return nil
	}
	return sqliteStore{writer: writer}
}

func (service *Service) Configured() bool {
	return service != nil && service.store != nil && service.clock != nil && service.newID != nil && !service.invalidHandlers
}

func (service *Service) ready(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if !service.Configured() {
		return ErrUnavailable
	}
	return service.store.Check(ctx)
}

func (service *Service) CreateOrReuse(ctx context.Context, command CreateCommand) (Result, error) {
	if err := service.ready(ctx); err != nil {
		return Result{}, err
	}
	if !command.Caller.authorizes(command.ProjectID) || !validOperationType(command.Type) || !validCommandID(command.IdempotencyKey) ||
		!validRequestID(command.RequestID) || !validDigest(command.RequestDigest) {
		return Result{}, ErrInvalidCommand
	}
	if service.handlers[command.Type] == nil && !directRuntimeOperation(command.Type) {
		return Result{}, ErrHandlerUnavailable
	}
	operationID := service.newID()
	if !validCommandID(operationID) {
		return Result{}, ErrUnavailable
	}
	now := nextTimestamp(service.clock, "")
	key := command.IdempotencyKey
	operation := domainoperation.Operation{
		OperationID: operationID, ProjectID: command.ProjectID, Type: command.Type, Status: domainoperation.StatusQueued,
		RequestID: command.RequestID, IdempotencyKey: &key, RequestDigest: command.RequestDigest,
		Version: 1, CreatedAt: now, UpdatedAt: now,
	}
	var result Result
	err := service.store.Transact(ctx, func(transaction Transaction) error {
		stored, changed, createErr := transaction.Create(ctx, operation, operationScope(command.ProjectID, command.Type), statusPayload(domainoperation.StatusQueued))
		result = Result{Operation: stored, Changed: changed}
		return createErr
	})
	if err != nil {
		return Result{}, mapStoreError(err)
	}
	return result, nil
}

func (service *Service) Get(ctx context.Context, query Query) (domainoperation.Operation, error) {
	if err := service.ready(ctx); err != nil {
		return domainoperation.Operation{}, err
	}
	if !query.Caller.authorizes(query.ProjectID) || !validCommandID(query.OperationID) {
		return domainoperation.Operation{}, ErrUnauthorized
	}
	var result domainoperation.Operation
	err := service.store.Transact(ctx, func(transaction Transaction) error {
		value, found, getErr := transaction.Get(ctx, query.ProjectID, query.OperationID)
		if getErr != nil {
			return getErr
		}
		if !found {
			return ErrNotFound
		}
		result = value
		return nil
	})
	if err != nil {
		return domainoperation.Operation{}, mapStoreError(err)
	}
	return result, nil
}

// ListForSnapshot returns a bounded, newest-first project projection for the
// trusted snapshot assembler. Authorization has already been established by
// the project-scoped snapshot lookup; this method still accepts no global or
// cross-project query shape.
func (service *Service) ListForSnapshot(ctx context.Context, projectID int64, limit int) ([]domainoperation.Operation, error) {
	if err := service.ready(ctx); err != nil {
		return nil, err
	}
	if projectID <= 0 {
		return nil, ErrInvalidCommand
	}
	if limit <= 0 {
		limit = 20
	}
	if limit > 100 {
		limit = 100
	}
	result := make([]domainoperation.Operation, 0)
	err := service.store.Transact(ctx, func(transaction Transaction) error {
		items, listErr := transaction.List(ctx, ListQuery{
			ProjectID: projectID, Limit: limit, Descending: true,
		})
		if listErr != nil {
			return listErr
		}
		result = append(result, items...)
		return nil
	})
	if err != nil {
		return nil, mapStoreError(err)
	}
	sort.SliceStable(result, func(left, right int) bool {
		if result[left].UpdatedAt == result[right].UpdatedAt {
			return result[left].OperationID > result[right].OperationID
		}
		return result[left].UpdatedAt > result[right].UpdatedAt
	})
	return result, nil
}

func (service *Service) Claim(ctx context.Context, command ClaimCommand) (Result, error) {
	if err := service.ready(ctx); err != nil {
		return Result{}, err
	}
	if !command.Caller.authorizes(command.ProjectID) || !validCommandID(command.OperationID) || !validRequestID(command.RequestID) ||
		command.ExpectedVersion <= 0 || !validDigest(command.RequestDigest) {
		return Result{}, ErrInvalidCommand
	}
	var result Result
	err := service.store.Transact(ctx, func(transaction Transaction) error {
		current, found, getErr := transaction.Get(ctx, command.ProjectID, command.OperationID)
		if getErr != nil {
			return getErr
		}
		if !found {
			return ErrNotFound
		}
		if current.RequestDigest != command.RequestDigest {
			return ErrRecoveryNotClaimable
		}
		if current.Status == domainoperation.StatusRunning {
			result = Result{Operation: current}
			return nil
		}
		if current.Status != domainoperation.StatusQueued {
			return ErrStateConflict
		}
		handler := service.handlers[current.Type]
		if handler == nil {
			if !directRuntimeOperation(current.Type) {
				return ErrHandlerUnavailable
			}
		}
		updatedAt := nextTimestamp(service.clock, current.UpdatedAt)
		updated, changed, transitionErr := transaction.Transition(ctx, Transition{
			ProjectID: command.ProjectID, OperationID: command.OperationID, ExpectedVersion: command.ExpectedVersion,
			Target: domainoperation.StatusRunning, RequestID: command.RequestID, UpdatedAt: updatedAt,
			Payload: statusPayload(domainoperation.StatusRunning),
		})
		result = Result{Operation: updated, Changed: changed}
		return transitionErr
	})
	if err != nil {
		return Result{}, mapStoreError(err)
	}
	return result, nil
}

func (service *Service) Succeed(ctx context.Context, command CompleteCommand) (Result, error) {
	if err := service.ready(ctx); err != nil {
		return Result{}, err
	}
	if !command.Caller.authorizes(command.ProjectID) || !validCommandID(command.OperationID) || !validRequestID(command.RequestID) || command.ExpectedVersion <= 0 {
		return Result{}, ErrInvalidCommand
	}
	assessment := AssessOutput(command.Output)
	return service.transition(ctx, command.Caller, command.ProjectID, command.OperationID, command.ExpectedVersion,
		command.RequestID, domainoperation.StatusSucceeded, command.Result, assessment.Metadata, nil)
}

func (service *Service) Fail(ctx context.Context, command FailCommand) (Result, error) {
	if err := service.ready(ctx); err != nil {
		return Result{}, err
	}
	if !command.Caller.authorizes(command.ProjectID) || !validCommandID(command.OperationID) || !validRequestID(command.RequestID) || command.ExpectedVersion <= 0 {
		return Result{}, ErrInvalidCommand
	}
	assessment := AssessOutput(command.Output)
	failure := &domainoperation.ErrorSummary{Code: command.Code, Summary: command.Summary}
	if assessment.Diagnostic != nil {
		failure = assessment.Diagnostic
	}
	if failure.Validate() != nil {
		return Result{}, ErrInvalidCommand
	}
	return service.transition(ctx, command.Caller, command.ProjectID, command.OperationID, command.ExpectedVersion,
		command.RequestID, domainoperation.StatusFailed, nil, assessment.Metadata, failure)
}

func (service *Service) RequestCancel(ctx context.Context, command CancelCommand) (Result, error) {
	if err := service.ready(ctx); err != nil {
		return Result{}, err
	}
	if !command.Caller.authorizes(command.ProjectID) || !validCommandID(command.OperationID) || !validRequestID(command.RequestID) || command.ExpectedVersion <= 0 {
		return Result{}, ErrInvalidCommand
	}
	var result Result
	err := service.store.Transact(ctx, func(transaction Transaction) error {
		current, found, getErr := transaction.Get(ctx, command.ProjectID, command.OperationID)
		if getErr != nil {
			return getErr
		}
		if !found {
			return ErrNotFound
		}
		requestedAt := nextTimestamp(service.clock, current.UpdatedAt)
		updated, changed, cancelErr := transaction.RequestCancellation(ctx, CancelRequest{
			ProjectID: command.ProjectID, OperationID: command.OperationID, ExpectedVersion: command.ExpectedVersion,
			RequestID: command.RequestID, RequestedAt: requestedAt,
		})
		result = Result{Operation: updated, Changed: changed}
		return cancelErr
	})
	if err != nil {
		return Result{}, mapStoreError(err)
	}
	return result, nil
}

func (service *Service) ConfirmCancel(ctx context.Context, command CancelCommand) (Result, error) {
	if err := service.ready(ctx); err != nil {
		return Result{}, err
	}
	if !command.Caller.authorizes(command.ProjectID) || !validCommandID(command.OperationID) || !validRequestID(command.RequestID) || command.ExpectedVersion <= 0 {
		return Result{}, ErrInvalidCommand
	}
	assessment := AssessOutput(command.Output)
	return service.transition(ctx, command.Caller, command.ProjectID, command.OperationID, command.ExpectedVersion,
		command.RequestID, domainoperation.StatusCancelled, nil, assessment.Metadata, nil)
}

func (service *Service) transition(
	ctx context.Context,
	caller Caller,
	projectID int64,
	operationID string,
	expectedVersion int64,
	requestID string,
	target domainoperation.Status,
	resultJSON *json.RawMessage,
	output *domainoperation.OutputMetadata,
	failure *domainoperation.ErrorSummary,
) (Result, error) {
	var result Result
	err := service.store.Transact(ctx, func(transaction Transaction) error {
		current, found, getErr := transaction.Get(ctx, projectID, operationID)
		if getErr != nil {
			return getErr
		}
		if !found {
			return ErrNotFound
		}
		if !caller.authorizes(current.ProjectID) {
			return ErrUnauthorized
		}
		updatedAt := nextTimestamp(service.clock, current.UpdatedAt)
		updated, changed, transitionErr := transaction.Transition(ctx, Transition{
			ProjectID: projectID, OperationID: operationID, ExpectedVersion: expectedVersion, Target: target,
			RequestID: requestID, UpdatedAt: updatedAt, Result: resultJSON, Error: failure, Output: output,
			Payload: statusPayload(target),
		})
		result = Result{Operation: updated, Changed: changed}
		return transitionErr
	})
	if err != nil {
		return Result{}, mapStoreError(err)
	}
	return result, nil
}

func operationScope(projectID int64, operationType string) string {
	return "project:" + strconv.FormatInt(projectID, 10) + ":" + operationType
}

func directRuntimeOperation(operationType string) bool {
	return operationType == ChatProviderOperationType
}

func newOperationID() string {
	buffer := make([]byte, 16)
	if _, err := rand.Read(buffer); err != nil {
		return ""
	}
	return "op-" + hex.EncodeToString(buffer)
}

func mapStoreError(err error) error {
	switch {
	case err == nil:
		return nil
	case errors.Is(err, sqlite.ErrIdempotencyConflict):
		return ErrIdempotencyConflict
	case errors.Is(err, sqlite.ErrOperationState):
		return ErrStateConflict
	case errors.Is(err, repository.ErrNotFound):
		return ErrNotFound
	case errors.Is(err, repository.ErrVersionConflict):
		return ErrVersionConflict
	default:
		return err
	}
}

func sortProjectIDs(projects []repository.Project) []int64 {
	seen := make(map[int64]struct{}, len(projects))
	result := make([]int64, 0, len(projects))
	for _, project := range projects {
		if project.ID <= 0 {
			continue
		}
		if _, exists := seen[project.ID]; exists {
			continue
		}
		seen[project.ID] = struct{}{}
		result = append(result, project.ID)
	}
	sort.Slice(result, func(left, right int) bool { return result[left] < result[right] })
	return result
}

type sqliteStore struct{ writer *sqlite.Writer }

func (store sqliteStore) Check(ctx context.Context) error { return store.writer.Check(ctx) }

func (store sqliteStore) ListProjects(ctx context.Context) ([]repository.Project, error) {
	var result []repository.Project
	err := store.writer.Transact(ctx, func(transaction repository.WriteTransaction) error {
		projects, err := transaction.ListProjects(ctx)
		if err != nil {
			return err
		}
		result = append([]repository.Project(nil), projects...)
		return nil
	})
	return result, err
}

func (store sqliteStore) Transact(ctx context.Context, operation func(Transaction) error) error {
	if operation == nil {
		return ErrInvalidCommand
	}
	return store.writer.TransactOperations(ctx, func(transaction *sqlite.OperationTransaction) error {
		return operation(sqliteTransaction{transaction: transaction})
	})
}

type sqliteTransaction struct{ transaction *sqlite.OperationTransaction }

func (transaction sqliteTransaction) Create(
	ctx context.Context,
	operation domainoperation.Operation,
	scope string,
	payload json.RawMessage,
) (domainoperation.Operation, bool, error) {
	result, err := transaction.transaction.Create(ctx, sqlite.CreateOperation{
		Operation: operation, IdempotencyScope: scope, Payload: payload,
	})
	return result.Operation, result.Changed, err
}

func (transaction sqliteTransaction) Get(ctx context.Context, projectID int64, operationID string) (domainoperation.Operation, bool, error) {
	return transaction.transaction.Get(ctx, projectID, operationID)
}

func (transaction sqliteTransaction) List(ctx context.Context, query ListQuery) ([]domainoperation.Operation, error) {
	return transaction.transaction.List(ctx, sqlite.OperationListQuery{
		ProjectID: query.ProjectID, Type: query.Type, Status: query.Status, Limit: query.Limit,
		Descending: query.Descending,
	})
}

func (transaction sqliteTransaction) Transition(ctx context.Context, input Transition) (domainoperation.Operation, bool, error) {
	result, err := transaction.transaction.Transition(ctx, sqlite.TransitionOperation{
		ProjectID: input.ProjectID, OperationID: input.OperationID, ExpectedVersion: input.ExpectedVersion,
		Target: input.Target, RequestID: input.RequestID, UpdatedAt: input.UpdatedAt,
		Result: input.Result, Error: input.Error, Output: input.Output, Payload: input.Payload,
	})
	return result.Operation, result.Changed, err
}

func (transaction sqliteTransaction) RequestCancellation(ctx context.Context, input CancelRequest) (domainoperation.Operation, bool, error) {
	result, err := transaction.transaction.RequestCancellation(ctx, sqlite.CancelOperation{
		ProjectID: input.ProjectID, OperationID: input.OperationID, ExpectedVersion: input.ExpectedVersion,
		RequestID: input.RequestID, RequestedAt: input.RequestedAt,
	})
	return result.Operation, result.Changed, err
}
