package loop

import (
	"context"
	"time"

	applicationoperations "github.com/lyming99/autoplan/backend/internal/application/operations"
)

// arm owns at most one timer goroutine per project. Every tick re-enters the
// same RunOnce command boundary; the timer never calls a runner directly.
func (service *runtimeService) arm(projectID int64, intervalSeconds int64) {
	if intervalSeconds <= 0 {
		return
	}
	entry := &schedule{cancel: make(chan struct{}), done: make(chan struct{})}
	service.mu.Lock()
	if service.closed {
		service.mu.Unlock()
		close(entry.cancel)
		close(entry.done)
		return
	}
	previous := service.schedules[projectID]
	service.schedules[projectID] = entry
	service.mu.Unlock()
	if previous != nil {
		close(previous.cancel)
	}
	go service.schedule(projectID, intervalSeconds, entry)
}

func (service *runtimeService) schedule(projectID int64, intervalSeconds int64, entry *schedule) {
	defer close(entry.done)
	wait := time.Duration(0)
	for {
		_, manager, _, _, err := service.dependencies()
		if err != nil {
			return
		}
		timer, err := manager.NewTimer(wait)
		if err != nil {
			return
		}
		select {
		case <-entry.cancel:
			timer.Stop()
			return
		case <-timer.C():
			if !service.ownsSchedule(projectID, entry) {
				return
			}
			service.submitAutomaticRun(projectID)
			wait = time.Duration(intervalSeconds) * time.Second
		}
	}
}

func (service *runtimeService) ownsSchedule(projectID int64, entry *schedule) bool {
	service.mu.Lock()
	defer service.mu.Unlock()
	return !service.closed && service.schedules[projectID] == entry
}

func (service *runtimeService) submitAutomaticRun(projectID int64) {
	requestID, key := service.nextAutomaticIdentity(string(CommandLoopRunOnce), projectID)
	_, _ = service.Execute(context.Background(), Command{
		Version: ContractVersion, Kind: CommandLoopRunOnce, ProjectID: projectID,
		CallerScope: "loop-scheduler", RequestID: requestID, IdempotencyKey: key,
	})
}

func (service *runtimeService) disarm(projectID int64) {
	service.mu.Lock()
	entry := service.schedules[projectID]
	delete(service.schedules, projectID)
	service.mu.Unlock()
	if entry != nil {
		close(entry.cancel)
	}
}

func (service *runtimeService) cancelActive(ctx context.Context, projectID int64) {
	service.mu.Lock()
	active := service.active[projectID]
	service.mu.Unlock()
	if active == nil {
		return
	}
	_, _ = service.cancelActiveOperation(ctx, projectID, active.operation.OperationID)
}

func (service *runtimeService) cancelActiveOperation(ctx context.Context, projectID int64, operationID string) (bool, error) {
	service.mu.Lock()
	active := service.active[projectID]
	service.mu.Unlock()
	if active == nil || active.operation.OperationID != operationID {
		return false, nil
	}
	operations, _, _, _, err := service.dependencies()
	if err != nil {
		return false, err
	}
	cancelled, cancelErr := operations.RequestCancel(ctx, applicationoperations.CancelCommand{
		Caller: applicationoperations.Caller{ID: "loop-system", ProjectID: projectID}, ProjectID: projectID,
		OperationID: active.operation.OperationID, ExpectedVersion: active.operation.Version, RequestID: "loop-stop",
	})
	if cancelErr != nil {
		return false, operationError(cancelErr)
	}
	requested := false
	service.mu.Lock()
	if current := service.active[projectID]; current != nil && current.operation.OperationID == active.operation.OperationID {
		current.cancelled = true
		current.operation = cancelled.Operation
		requested = true
		if current.request != nil && current.request.submission != nil {
			current.request.submission.Cancel()
		}
	}
	service.mu.Unlock()
	return requested, nil
}

func (service *runtimeService) RemoveProject(ctx context.Context, projectID int64) error {
	if projectID <= 0 {
		return ErrInvalidCommand
	}
	_, manager, _, _, err := service.dependencies()
	if err != nil {
		return err
	}
	service.disarm(projectID)
	service.cancelActive(ctx, projectID)
	if err := manager.RemoveProject(ctx, projectID); err != nil {
		return operationError(err)
	}
	return nil
}

func (service *runtimeService) Close(ctx context.Context) error {
	if service == nil {
		return nil
	}
	if ctx == nil {
		ctx = context.Background()
	}
	service.mu.Lock()
	if service.closed {
		service.mu.Unlock()
		return nil
	}
	service.closed = true
	schedules := make([]*schedule, 0, len(service.schedules))
	for _, entry := range service.schedules {
		schedules = append(schedules, entry)
	}
	service.schedules = make(map[int64]*schedule)
	service.mu.Unlock()
	for _, entry := range schedules {
		close(entry.cancel)
	}
	for _, entry := range schedules {
		select {
		case <-entry.done:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	return nil
}
