package plans

import (
	"context"
	"errors"
	"fmt"

	domainplan "github.com/lyming99/autoplan/backend/internal/domain/plan"
	"github.com/lyming99/autoplan/backend/internal/repository"
)

const RouteStop = "plans:stop"

// StopCommand identifies the plan aggregate to stop. RequestID is used only
// to correlate the audit event; runtime cancellation and operation ownership
// remain outside this pure-persistence application service.
type StopCommand struct {
	ProjectID int64
	PlanID    int64
	RequestID string
}

// StopResult returns the committed aggregate values needed by runtime callers
// and transports without requiring a second, potentially stale read.
type StopResult struct {
	Plan          domainplan.Plan   `json:"plan"`
	AffectedTasks []domainplan.Task `json:"affected_tasks"`
}

// CheckStoppable verifies the project-scoped target immediately before a
// runtime cancellation. Stop repeats the check in its write transaction.
func (service *Service) CheckStoppable(ctx context.Context, projectID, planID int64) error {
	if err := service.ready(ctx); err != nil {
		return err
	}
	if projectID <= 0 || planID <= 0 {
		return ErrInvalidCommand
	}
	return service.writer.TransactPlans(ctx, func(transaction repository.PlanWriteTransaction) error {
		current, found, err := transaction.GetPlan(ctx, projectID, planID)
		if err != nil {
			return err
		}
		if !found {
			return repository.ErrNotFound
		}
		if current.Status == domainplan.StatusRunning {
			return nil
		}
		tasks, err := transaction.ListPlanTasks(ctx, projectID, planID)
		if err != nil {
			return err
		}
		for _, task := range tasks {
			if task.Status == domainplan.TaskRunning {
				return nil
			}
		}
		return ErrStateConflict
	})
}

// Stop interrupts one active plan and blocks its unfinished tasks. The state
// transition and plan.stopped audit event share one TransactPlans transaction.
func (service *Service) Stop(ctx context.Context, command StopCommand) (StopResult, error) {
	if err := service.ready(ctx); err != nil {
		return StopResult{}, err
	}
	if command.ProjectID <= 0 || command.PlanID <= 0 {
		return StopResult{}, ErrInvalidCommand
	}

	var result domainplan.PlanStopResult
	err := service.writer.TransactPlans(ctx, func(transaction repository.PlanWriteTransaction) error {
		current, found, err := transaction.GetPlan(ctx, command.ProjectID, command.PlanID)
		if err != nil {
			return err
		}
		if !found {
			return repository.ErrNotFound
		}
		updatedAt := nextMutationTimestamp(service.clock.Now(), []string{current.UpdatedAt})
		result, err = transaction.StopPlan(ctx, domainplan.PlanStop{
			ProjectID: command.ProjectID, PlanID: command.PlanID, UpdatedAt: updatedAt,
		})
		if err != nil {
			return err
		}
		taskIDs := make([]int64, len(result.AffectedTasks))
		for index, task := range result.AffectedTasks {
			taskIDs[index] = task.ID
		}
		return appendPlanEvent(ctx, transaction, RouteStop, command.RequestID, command.ProjectID,
			TargetPlan, command.PlanID, "plan.stopped", fmt.Sprintf("plan #%d stopped", command.PlanID),
			map[string]any{
				"plan_id": command.PlanID, "previous_status": current.Status, "status": result.Plan.Status,
				"affected_tasks": len(result.AffectedTasks), "affected_task_ids": taskIDs,
			}, updatedAt)
	})
	if err != nil {
		return StopResult{}, mapStopError(err)
	}
	return StopResult{Plan: result.Plan, AffectedTasks: result.AffectedTasks}, nil
}

func mapStopError(err error) error {
	switch {
	case err == nil:
		return nil
	case errors.Is(err, repository.ErrInvalidPlan), errors.Is(err, repository.ErrVersionConflict):
		return fmt.Errorf("%w: %w", ErrStateConflict, err)
	default:
		return mapMutationError(err)
	}
}
