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

// manualRuntimeDispatcher owns the explicit task action path. It transitions
// draft or interrupted plans back to pending so the loop can claim the selected
// task; autonomous loop cycles never receive this capability.
type manualRuntimeDispatcher struct {
	activator repository.DraftPlanTaskActivator

	mu         sync.RWMutex
	operations *applicationoperations.Service
	loop       *applicationloop.Service
}

func newManualRuntimeDispatcher(activator repository.DraftPlanTaskActivator) *manualRuntimeDispatcher {
	if activator == nil {
		return nil
	}
	return &manualRuntimeDispatcher{activator: activator}
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
	if command.Kind == applicationloop.CommandTaskStop {
		return dispatcher.stop(ctx, command)
	}
	if command.Kind != applicationloop.CommandTaskRun && command.Kind != applicationloop.CommandTaskRunBatches {
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

func (dispatcher *manualRuntimeDispatcher) stop(ctx context.Context, command applicationloop.Command) (applicationloop.Result, error) {
	if command.PlanID <= 0 || command.TaskID <= 0 {
		return applicationloop.Result{}, applicationloop.ErrInvalidCommand
	}
	operations, loopService, err := dispatcher.dependencies()
	if err != nil {
		return applicationloop.Result{}, err
	}
	digest := manualCommandDigest(command, []int64{command.TaskID})
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
	if err := loopService.CancelActive(ctx, command.ProjectID); err != nil {
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
	if command.Kind == applicationloop.CommandTaskRun {
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
