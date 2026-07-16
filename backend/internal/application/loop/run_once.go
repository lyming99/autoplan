package loop

import (
	"context"
	"encoding/json"

	applicationoperations "github.com/lyming99/autoplan/backend/internal/application/operations"
	domainloop "github.com/lyming99/autoplan/backend/internal/domain/loop"
	"github.com/lyming99/autoplan/backend/internal/runtime/scheduler"
)

func (request *commandRequest) run(ctx context.Context) error {
	if request.noop {
		return nil
	}
	_, _, _, runner, err := request.service.dependencies()
	if err != nil {
		return err
	}
	output, err := runner.RunOnce(ctx, RunInput{
		ProjectID: request.command.ProjectID, OperationID: request.operation.OperationID,
		AssociatePlan: func(planID int64) bool {
			return request.service.associatePlan(request.command.ProjectID, request.operation.OperationID, planID)
		},
	})
	if err == nil && !output.Valid() {
		return ErrStateConflict
	}
	request.output = output
	return err
}

func (request *commandRequest) cancel(context.Context) {
	// The stop command persists the cancellation request before posting this
	// actor callback. Work receives its context cancellation from scheduler.
}

func (request *commandRequest) complete(ctx context.Context, work scheduler.WorkResult) error {
	if request.noop {
		return nil
	}
	active, found := request.service.activeFor(request.command.ProjectID, request.operation.OperationID)
	if !found {
		return nil
	}
	defer request.service.clearActive(request.command.ProjectID, request.operation.OperationID)
	operations, _, stateStore, _, err := request.service.dependencies()
	if err != nil {
		return err
	}
	if active.cancelled || work.Cancelled || isCancellation(work.Err) {
		_, err = operations.ConfirmCancel(ctx, applicationoperations.CancelCommand{
			Caller: operationCaller(request.command), ProjectID: request.command.ProjectID, OperationID: active.operation.OperationID,
			ExpectedVersion: active.operation.Version, RequestID: request.command.RequestID,
		})
		return operationError(err)
	}

	state, exists, stateErr := stateStore.Get(ctx, request.command.ProjectID)
	if stateErr != nil || !exists {
		request.failOperation(ctx, operations, active, "LOOP_STATE_UNAVAILABLE")
		if stateErr != nil {
			return stateErr
		}
		return ErrProjectNotFound
	}
	next, stateErr := domainloop.FinishRun(state, work.EndedAt, work.Err)
	if stateErr != nil {
		request.failOperation(ctx, operations, active, "LOOP_STATE_UNAVAILABLE")
		return stateErr
	}
	if _, _, stateErr = stateStore.Save(ctx, next, state.Version); stateErr != nil {
		request.failOperation(ctx, operations, active, "LOOP_STATE_CONFLICT")
		return stateErr
	}
	if work.Err != nil {
		request.failOperation(ctx, operations, active, "LOOP_RUN_FAILED")
		return work.Err
	}
	payload, _ := json.Marshal(map[string]int{
		"pending_intakes": request.output.PendingIntakes,
		"generated_plans": request.output.GeneratedPlans,
		"processed_plans": request.output.ProcessedPlans,
	})
	raw := json.RawMessage(payload)
	_, err = operations.Succeed(ctx, applicationoperations.CompleteCommand{
		Caller: operationCaller(request.command), ProjectID: request.command.ProjectID, OperationID: active.operation.OperationID,
		ExpectedVersion: active.operation.Version, RequestID: request.command.RequestID, Result: &raw,
	})
	return operationError(err)
}

func (request *commandRequest) failOperation(ctx context.Context, operations *applicationoperations.Service, active *activeRun, code string) {
	if operations == nil || active == nil {
		return
	}
	_, _ = operations.Fail(ctx, applicationoperations.FailCommand{
		Caller: operationCaller(request.command), ProjectID: request.command.ProjectID, OperationID: active.operation.OperationID,
		ExpectedVersion: active.operation.Version, RequestID: request.command.RequestID,
		Code: code, Summary: "Loop run could not be completed.",
	})
}

func (service *runtimeService) activeFor(projectID int64, operationID string) (*activeRun, bool) {
	service.mu.Lock()
	defer service.mu.Unlock()
	active := service.active[projectID]
	if active == nil || active.operation.OperationID != operationID {
		return nil, false
	}
	copy := *active
	return &copy, true
}

func (service *runtimeService) associatePlan(projectID int64, operationID string, planID int64) bool {
	if planID <= 0 {
		return false
	}
	service.mu.Lock()
	active := service.active[projectID]
	if active == nil || active.operation.OperationID != operationID || active.cancelled {
		service.mu.Unlock()
		return false
	}
	active.planID = planID
	_, stopPending := service.planStops[projectID][planID]
	service.mu.Unlock()
	if stopPending {
		_, _ = service.cancelActiveOperation(context.Background(), projectID, operationID)
		return false
	}
	return true
}
