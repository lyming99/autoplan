package sqlite

import (
	"context"

	domainplan "github.com/lyming99/autoplan/backend/internal/domain/plan"
	"github.com/lyming99/autoplan/backend/internal/repository"
)

// StopPlan applies the complete plan-stop transition inside the caller's
// TransactPlans transaction. All eligibility checks happen before the first
// write, and any later error rolls the plan and task updates back together.
func (transaction *writeTransaction) StopPlan(
	ctx context.Context,
	input domainplan.PlanStop,
) (domainplan.PlanStopResult, error) {
	if domainplan.ValidatePlanStop(input) != nil {
		return domainplan.PlanStopResult{}, repository.ErrInvalidPlan
	}

	plan, found, err := transaction.GetPlan(ctx, input.ProjectID, input.PlanID)
	if err != nil {
		return domainplan.PlanStopResult{}, err
	}
	if !found {
		// Project ownership mismatches are intentionally indistinguishable from
		// missing plans at this project-scoped boundary.
		return domainplan.PlanStopResult{}, repository.ErrNotFound
	}
	tasks, err := transaction.ListPlanTasks(ctx, input.ProjectID, input.PlanID)
	if err != nil {
		return domainplan.PlanStopResult{}, err
	}

	stoppable := plan.Status == domainplan.StatusRunning
	for _, task := range tasks {
		if task.Status == domainplan.TaskRunning {
			stoppable = true
			break
		}
	}
	if !stoppable {
		return domainplan.PlanStopResult{}, repository.ErrInvalidPlan
	}

	affectedIDs := make(map[int64]struct{}, len(tasks))
	for _, task := range tasks {
		if domainplan.IsAcceptableTask(task.Status) || task.Status == domainplan.TaskBlocked {
			continue
		}
		affectedIDs[task.ID] = struct{}{}
	}
	if len(affectedIDs) > 0 {
		result, updateErr := transaction.tx.ExecContext(ctx, `UPDATE plan_tasks
			SET status = ?, updated_at = ?
			WHERE plan_id = ? AND status NOT IN (?, ?, ?, ?)
			  AND EXISTS (SELECT 1 FROM plans WHERE id = plan_tasks.plan_id AND project_id = ?)`,
			string(domainplan.TaskBlocked), input.UpdatedAt, input.PlanID,
			string(domainplan.TaskCompleted), string(domainplan.TaskDone), string(domainplan.TaskPassed),
			string(domainplan.TaskBlocked), input.ProjectID)
		if updateErr != nil {
			return domainplan.PlanStopResult{}, safeSQLError(ctx, updateErr)
		}
		affected, affectedErr := rowsAffected(result)
		if affectedErr != nil {
			return domainplan.PlanStopResult{}, affectedErr
		}
		if affected != int64(len(affectedIDs)) {
			return domainplan.PlanStopResult{}, repository.ErrTransaction
		}
		if err := transaction.wrote("plan-stop:tasks"); err != nil {
			return domainplan.PlanStopResult{}, err
		}
	}

	planResult, err := transaction.tx.ExecContext(ctx, `UPDATE plans
		SET status = ?, updated_at = ?
		WHERE id = ? AND project_id = ? AND status = ?`,
		string(domainplan.StatusInterrupted), input.UpdatedAt, input.PlanID, input.ProjectID, string(plan.Status))
	if err != nil {
		return domainplan.PlanStopResult{}, safeSQLError(ctx, err)
	}
	if err := requireOneRow(planResult); err != nil {
		if err == repository.ErrNotFound {
			return domainplan.PlanStopResult{}, repository.ErrVersionConflict
		}
		return domainplan.PlanStopResult{}, err
	}
	if err := transaction.wrote("plan-stop:plan"); err != nil {
		return domainplan.PlanStopResult{}, err
	}

	stopped, found, err := transaction.GetPlan(ctx, input.ProjectID, input.PlanID)
	if err != nil {
		return domainplan.PlanStopResult{}, err
	}
	if !found {
		return domainplan.PlanStopResult{}, repository.ErrTransaction
	}
	updatedTasks, err := transaction.ListPlanTasks(ctx, input.ProjectID, input.PlanID)
	if err != nil {
		return domainplan.PlanStopResult{}, err
	}
	result := domainplan.PlanStopResult{Plan: stopped, AffectedTasks: make([]domainplan.Task, 0, len(affectedIDs))}
	for _, task := range updatedTasks {
		if _, affected := affectedIDs[task.ID]; affected {
			result.AffectedTasks = append(result.AffectedTasks, task)
		}
	}
	if len(result.AffectedTasks) != len(affectedIDs) {
		return domainplan.PlanStopResult{}, repository.ErrTransaction
	}
	return result, nil
}
