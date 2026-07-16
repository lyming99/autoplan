package bootstrap

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"sync"

	"github.com/lyming99/autoplan/backend/internal/application/capabilities"
	applicationloop "github.com/lyming99/autoplan/backend/internal/application/loop"
	applicationoperations "github.com/lyming99/autoplan/backend/internal/application/operations"
	domainoperation "github.com/lyming99/autoplan/backend/internal/domain/operation"
	"github.com/lyming99/autoplan/backend/internal/repository"
)

// manualRuntimeDispatcher owns explicit task run and stop actions. Autonomous
// loop cycles never receive either activation or task-stop authority.
type manualRuntimeDispatcher struct {
	activator repository.DraftPlanTaskActivator
	stopper   repository.PlanTaskStopper

	mu         sync.RWMutex
	operations *applicationoperations.Service
	loop       *applicationloop.Service
}

func newManualRuntimeDispatcher(activator repository.DraftPlanTaskActivator) *manualRuntimeDispatcher {
	if activator == nil {
		return nil
	}
	stopper, _ := activator.(repository.PlanTaskStopper)
	return &manualRuntimeDispatcher{activator: activator, stopper: stopper}
}

func (dispatcher *manualRuntimeDispatcher) Bind(operations *applicationoperations.Service, loop *applicationloop.Service) {
	if dispatcher == nil {
		return
	}
	dispatcher.mu.Lock()
	dispatcher.operations, dispatcher.loop = operations, loop
	dispatcher.mu.Unlock()
}

func (dispatcher *manualRuntimeDispatcher) dependencies() (*applicationoperations.Service, *applicationloop.Service, error) {
	if dispatcher == nil || dispatcher.activator == nil {
		return nil, nil, applicationloop.ErrUnavailable
	}
	dispatcher.mu.RLock()
	operations, loop := dispatcher.operations, dispatcher.loop
	dispatcher.mu.RUnlock()
	if operations == nil || !operations.Configured() || loop == nil {
		return nil, nil, applicationloop.ErrUnavailable
	}
	return operations, loop, nil
}

func (dispatcher *manualRuntimeDispatcher) Dispatch(ctx context.Context, command applicationloop.Command) (applicationloop.Result, error) {
	if command.Kind != applicationloop.CommandTaskRun && command.Kind != applicationloop.CommandTaskRunBatches && command.Kind != applicationloop.CommandTaskStop {
		return applicationloop.Result{}, applicationloop.ErrUnsupportedCommand
	}
	operations, loopService, err := dispatcher.dependencies()
	if err != nil {
		return applicationloop.Result{}, err
	}
	taskIDs := manualTaskIDs(command)
	if command.PlanID <= 0 || len(taskIDs) == 0 {
		return applicationloop.Result{}, applicationloop.ErrInvalidCommand
	}
	digest := manualCommandDigest(command, taskIDs)
	caller := applicationoperations.Caller{ID: command.CallerScope, ProjectID: command.ProjectID}
	created, err := operations.CreateOrReuse(ctx, applicationoperations.CreateCommand{
		Caller: caller, ProjectID: command.ProjectID, Type: string(command.Kind),
		IdempotencyKey: command.IdempotencyKey, RequestDigest: digest, RequestID: command.RequestID,
	})
	if err != nil {
		return applicationloop.Result{}, manualOperationError(err)
	}
	if !created.Changed {
		return manualOperationResult(created.Operation)
	}
	claimed, err := operations.Claim(ctx, applicationoperations.ClaimCommand{
		Caller: caller, ProjectID: command.ProjectID, OperationID: created.Operation.OperationID,
		ExpectedVersion: created.Operation.Version, RequestDigest: digest, RequestID: command.RequestID,
	})
	if err != nil {
		return applicationloop.Result{}, manualOperationError(err)
	}
	if command.Kind == applicationloop.CommandTaskStop {
		return dispatcher.stop(ctx, operations, loopService, command, caller, claimed.Operation)
	}
	activationAt := claimed.Operation.UpdatedAt
	activated, err := dispatcher.activator.ActivateDraftPlanTask(ctx, repository.DraftPlanTaskActivation{
		ProjectID: command.ProjectID, PlanID: command.PlanID, TaskID: taskIDs[0],
		OperationID: claimed.Operation.OperationID, ActivatedAt: activationAt,
	})
	if err != nil {
		dispatcher.fail(ctx, operations, caller, claimed.Operation, command.RequestID)
		return applicationloop.Result{}, manualRepositoryError(err)
	}
	if activated && len(taskIDs) > 1 {
		requestID, key := nestedLoopIdentity(claimed.Operation.OperationID, "start")
		if _, err = loopService.Start(ctx, applicationloop.Command{
			ProjectID: command.ProjectID, CallerScope: "task-runtime", RequestID: requestID, IdempotencyKey: key,
		}); err != nil {
			dispatcher.fail(ctx, operations, caller, claimed.Operation, command.RequestID)
			return applicationloop.Result{}, err
		}
	}
	requestID, key := nestedLoopIdentity(claimed.Operation.OperationID, "run")
	if _, err = loopService.RunOnce(ctx, applicationloop.Command{
		ProjectID: command.ProjectID, CallerScope: "task-runtime", RequestID: requestID, IdempotencyKey: key,
	}); err != nil {
		dispatcher.fail(ctx, operations, caller, claimed.Operation, command.RequestID)
		return applicationloop.Result{}, err
	}
	completed, err := operations.Succeed(ctx, applicationoperations.CompleteCommand{
		Caller: caller, ProjectID: command.ProjectID, OperationID: claimed.Operation.OperationID,
		ExpectedVersion: claimed.Operation.Version, RequestID: command.RequestID,
	})
	if err != nil {
		return applicationloop.Result{}, manualOperationError(err)
	}
	return manualOperationResult(completed.Operation)
}

func (dispatcher *manualRuntimeDispatcher) fail(ctx context.Context, operations *applicationoperations.Service, caller applicationoperations.Caller, operation domainoperation.Operation, requestID string) {
	_, _ = operations.Fail(ctx, applicationoperations.FailCommand{
		Caller: caller, ProjectID: operation.ProjectID, OperationID: operation.OperationID,
		ExpectedVersion: operation.Version, RequestID: requestID,
		Code: "TASK_DISPATCH_FAILED", Summary: "Task execution could not be dispatched.",
	})
}

func manualTaskIDs(command applicationloop.Command) []int64 {
	if command.Kind == applicationloop.CommandTaskRun || command.Kind == applicationloop.CommandTaskStop {
		if command.TaskID <= 0 {
			return nil
		}
		return []int64{command.TaskID}
	}
	result := make([]int64, 0)
	for _, batch := range command.Batches {
		result = append(result, batch.TaskIDs...)
	}
	return result
}

func (dispatcher *manualRuntimeDispatcher) stop(
	ctx context.Context,
	operations *applicationoperations.Service,
	loopService *applicationloop.Service,
	command applicationloop.Command,
	caller applicationoperations.Caller,
	operation domainoperation.Operation,
) (applicationloop.Result, error) {
	if dispatcher.stopper == nil {
		dispatcher.fail(ctx, operations, caller, operation, command.RequestID)
		return applicationloop.Result{}, applicationloop.ErrUnavailable
	}
	stopped, err := dispatcher.stopper.RequestPlanTaskStop(ctx, repository.PlanTaskStopInput{
		ProjectID: command.ProjectID, PlanID: command.PlanID, TaskID: command.TaskID, UpdatedAt: operation.UpdatedAt,
	})
	if err != nil {
		dispatcher.fail(ctx, operations, caller, operation, command.RequestID)
		return applicationloop.Result{}, manualRepositoryError(err)
	}
	switch stopped.Outcome {
	case repository.PlanTaskStopRequested, repository.PlanTaskStopAlreadyRequested:
		if stopped.OperationID != "" {
			if _, err = loopService.CancelTaskExecution(ctx, command.ProjectID, stopped.OperationID); err != nil {
				dispatcher.fail(ctx, operations, caller, operation, command.RequestID)
				return applicationloop.Result{}, err
			}
		}
	case repository.PlanTaskStopTerminal:
		// Repeated stop after terminal convergence is an idempotent no-op.
	case repository.PlanTaskStopNotFound, repository.PlanTaskStopOwnershipMismatch:
		dispatcher.fail(ctx, operations, caller, operation, command.RequestID)
		return applicationloop.Result{}, applicationloop.ErrInvalidCommand
	case repository.PlanTaskStopNotRunning:
		dispatcher.fail(ctx, operations, caller, operation, command.RequestID)
		return applicationloop.Result{}, applicationloop.ErrStateConflict
	default:
		dispatcher.fail(ctx, operations, caller, operation, command.RequestID)
		return applicationloop.Result{}, applicationloop.ErrStateConflict
	}
	completed, err := operations.Succeed(ctx, applicationoperations.CompleteCommand{
		Caller: caller, ProjectID: command.ProjectID, OperationID: operation.OperationID,
		ExpectedVersion: operation.Version, RequestID: command.RequestID,
	})
	if err != nil {
		return applicationloop.Result{}, manualOperationError(err)
	}
	return manualOperationResult(completed.Operation)
}

func manualCommandDigest(command applicationloop.Command, taskIDs []int64) string {
	encoded, _ := json.Marshal(struct {
		Kind      applicationloop.CommandKind `json:"kind"`
		ProjectID int64                       `json:"project_id"`
		PlanID    int64                       `json:"plan_id"`
		TaskIDs   []int64                     `json:"task_ids"`
	}{command.Kind, command.ProjectID, command.PlanID, taskIDs})
	digest := sha256.Sum256(encoded)
	return hex.EncodeToString(digest[:])
}

func nestedLoopIdentity(operationID, action string) (string, string) {
	digest := sha256.Sum256([]byte(operationID + ":" + action))
	value := hex.EncodeToString(digest[:20])
	return "task-loop-" + value, "task-loop-" + value
}

func manualOperationResult(operation domainoperation.Operation) (applicationloop.Result, error) {
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
	return applicationloop.Result{Operation: capabilities.OperationReference{
		OperationID: operation.OperationID, Type: operation.Type, Status: status,
		RequestID: operation.RequestID, AcceptedAt: operation.CreatedAt,
	}}, nil
}

func manualOperationError(err error) error {
	switch {
	case errors.Is(err, applicationoperations.ErrUnavailable), errors.Is(err, applicationoperations.ErrHandlerUnavailable):
		return applicationloop.ErrUnavailable
	case errors.Is(err, applicationoperations.ErrInvalidCommand), errors.Is(err, applicationoperations.ErrUnauthorized), errors.Is(err, applicationoperations.ErrIdempotencyConflict):
		return applicationloop.ErrInvalidCommand
	default:
		return applicationloop.ErrStateConflict
	}
}

func manualRepositoryError(err error) error {
	switch {
	case errors.Is(err, repository.ErrNotConfigured):
		return applicationloop.ErrUnavailable
	case errors.Is(err, repository.ErrNotFound), errors.Is(err, repository.ErrInvalidTask):
		return applicationloop.ErrInvalidCommand
	default:
		return applicationloop.ErrStateConflict
	}
}

type manualRecoveryHandler struct{ operationType string }

func (handler manualRecoveryHandler) Type() string { return handler.operationType }
func (manualRecoveryHandler) CanRecover(context.Context, domainoperation.Operation) (bool, error) {
	return false, nil
}

var _ applicationloop.Dispatcher = (*manualRuntimeDispatcher)(nil)
var _ applicationoperations.RecoveryHandler = manualRecoveryHandler{}
