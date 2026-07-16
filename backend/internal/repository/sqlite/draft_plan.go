package sqlite

import (
	"context"
	"encoding/json"
	"strings"

	domainplan "github.com/lyming99/autoplan/backend/internal/domain/plan"
	"github.com/lyming99/autoplan/backend/internal/repository"
)

// ActivateDraftPlanTask is the explicit user-intent transition that makes a
// generated draft (or a failed task after an interrupted plan) eligible for
// the Go loop. Automatic cycles never call it.
func (writer *Writer) ActivateDraftPlanTask(ctx context.Context, input repository.DraftPlanTaskActivation) (bool, error) {
	if input.ProjectID <= 0 || input.PlanID <= 0 || input.TaskID <= 0 || strings.TrimSpace(input.OperationID) == "" ||
		!domainplan.ValidUTCTimestamp(input.ActivatedAt) {
		return false, repository.ErrInvalidTask
	}
	changed := false
	err := writer.Transact(ctx, func(transaction repository.WriteTransaction) error {
		tx, ok := transaction.(*writeTransaction)
		if !ok {
			return repository.ErrTransaction
		}
		plan, found, err := tx.GetPlan(ctx, input.ProjectID, input.PlanID)
		if err != nil || !found {
			if err != nil {
				return err
			}
			return repository.ErrNotFound
		}
		task, found, err := tx.GetPlanTask(ctx, input.ProjectID, input.PlanID, input.TaskID)
		if err != nil || !found {
			if err != nil {
				return err
			}
			return repository.ErrNotFound
		}
		taskWasFailed := task.Status == domainplan.TaskFailed
		if task.Status != domainplan.TaskPending && !taskWasFailed {
			return repository.ErrVersionConflict
		}

		// Reset a failed task to pending so explicit user re-execution can claim it.
		if taskWasFailed {
			result, err := tx.tx.ExecContext(ctx, `UPDATE plan_tasks
				SET status = ?, accepted_at = NULL, started_at = NULL, finished_at = NULL, duration_ms = 0, updated_at = ?
				WHERE id = ? AND plan_id = ? AND status = ?
				  AND EXISTS (SELECT 1 FROM plans WHERE id = plan_tasks.plan_id AND project_id = ?)`,
				string(domainplan.TaskPending), input.ActivatedAt,
				input.TaskID, input.PlanID, string(domainplan.TaskFailed), input.ProjectID)
			if err != nil {
				return safeSQLError(ctx, err)
			}
			if err = requireOneRow(result); err != nil {
				return err
			}
			changed = true
		}

		if plan.Status == domainplan.StatusPending || plan.Status == domainplan.StatusRunning {
			return nil
		}
		if plan.Status != domainplan.StatusDraft && plan.Status != domainplan.StatusInterrupted {
			return repository.ErrVersionConflict
		}
		result, err := tx.tx.ExecContext(ctx, `UPDATE plans
			SET status = ?, validation_passed = 0, accepted_at = NULL, updated_at = ?
			WHERE id = ? AND project_id = ? AND status = ?`, string(domainplan.StatusPending), input.ActivatedAt,
			input.PlanID, input.ProjectID, string(plan.Status))
		if err != nil {
			return safeSQLError(ctx, err)
		}
		if err = requireOneRow(result); err != nil {
			return err
		}
		changed = true
		payload, _ := json.Marshal(map[string]any{
			"plan_id": input.PlanID, "task_id": input.TaskID, "task_key": task.Key,
			"task_title": loopTaskEventTitle(task), "status": "pending",
		})
		if err = tx.appendRuntimeAudit(ctx, input.ProjectID, "plan.activated", "Draft plan activated by user", input.ActivatedAt, payload); err != nil {
			return err
		}
		if _, err = tx.appendBusinessEvent(ctx, BusinessEvent{
			ProjectID: input.ProjectID, Type: "business.plan_activated", OperationID: &input.OperationID,
			RequestID: input.OperationID, OccurredAt: input.ActivatedAt, Payload: payload,
		}); err != nil {
			return err
		}
		return tx.wrote("draft-plan:activate")
	})
	return changed, err
}

var _ repository.DraftPlanTaskActivator = (*Writer)(nil)
