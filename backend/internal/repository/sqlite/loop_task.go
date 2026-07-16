package sqlite

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"
	"unicode/utf8"

	domainplan "github.com/lyming99/autoplan/backend/internal/domain/plan"
	"github.com/lyming99/autoplan/backend/internal/repository"
)

func (writer *Writer) ClaimNextPlanTask(
	ctx context.Context,
	projectID int64,
	operationID string,
	startedAt string,
) (repository.LoopPlanTaskClaim, bool, error) {
	if projectID <= 0 || strings.TrimSpace(operationID) == "" || !domainplan.ValidUTCTimestamp(startedAt) {
		return repository.LoopPlanTaskClaim{}, false, repository.ErrInvalidTask
	}
	var claim repository.LoopPlanTaskClaim
	claimed := false
	err := writer.Transact(ctx, func(transaction repository.WriteTransaction) error {
		tx, ok := transaction.(*writeTransaction)
		if !ok {
			return repository.ErrTransaction
		}
		if _, found, err := tx.GetProject(ctx, projectID); err != nil || !found {
			if err != nil {
				return err
			}
			return repository.ErrNotFound
		}
		// A persisted running task has no live process after daemon recovery.
		// Returning it to pending here is safe because the per-project actor
		// admits only one active Loop command at a time.
		if _, err := tx.tx.ExecContext(ctx, `UPDATE plan_tasks
			SET status = 'pending', started_at = NULL, finished_at = NULL, duration_ms = 0, updated_at = ?
			WHERE status IN ('running', 'stopping') AND plan_id IN
			  (SELECT id FROM plans WHERE project_id = ?)`, startedAt, projectID); err != nil {
			return safeSQLError(ctx, err)
		}
		plans, err := tx.ListPlans(ctx, domainplan.ListOptions{ProjectID: projectID, Limit: 200})
		if err != nil {
			return err
		}
		for _, plan := range plans {
			if plan.Status != domainplan.StatusPending && plan.Status != domainplan.StatusRunning {
				continue
			}
			tasks, listErr := tx.ListPlanTasks(ctx, projectID, plan.ID)
			if listErr != nil {
				return listErr
			}
			for _, task := range tasks {
				if task.Status != domainplan.TaskPending {
					continue
				}
				result, updateErr := tx.tx.ExecContext(ctx, `UPDATE plan_tasks
					SET status = ?, started_at = ?, finished_at = NULL, duration_ms = 0, updated_at = ?
					WHERE id = ? AND plan_id = ? AND status = ?`,
					string(domainplan.TaskRunning), startedAt, startedAt, task.ID, plan.ID, string(domainplan.TaskPending))
				if updateErr != nil {
					return safeSQLError(ctx, updateErr)
				}
				if updateErr = requireOneRow(result); updateErr != nil {
					return updateErr
				}
				if _, updateErr = tx.tx.ExecContext(ctx, `UPDATE plans SET status = ?, updated_at = ?
					WHERE id = ? AND project_id = ?`, string(domainplan.StatusRunning), startedAt, plan.ID, projectID); updateErr != nil {
					return safeSQLError(ctx, updateErr)
				}
				updatedPlan, found, loadErr := tx.GetPlan(ctx, projectID, plan.ID)
				if loadErr != nil || !found {
					if loadErr != nil {
						return loadErr
					}
					return repository.ErrTransaction
				}
				updatedTask, found, loadErr := tx.GetPlanTask(ctx, projectID, plan.ID, task.ID)
				if loadErr != nil || !found {
					if loadErr != nil {
						return loadErr
					}
					return repository.ErrTransaction
				}
				var storedSession sql.NullString
				if loadErr = tx.tx.QueryRowContext(ctx, `SELECT agent_cli_session_id FROM plans
					WHERE id = ? AND project_id = ?`, plan.ID, projectID).Scan(&storedSession); loadErr != nil {
					return safeSQLError(ctx, loadErr)
				}
				if eventErr := appendLoopTaskEvent(ctx, tx, operationID, updatedPlan, updatedTask,
					"task.started", "Plan task execution started", "running", startedAt); eventErr != nil {
					return eventErr
				}
				claim, claimed = repository.LoopPlanTaskClaim{
					Plan: updatedPlan, Task: updatedTask, SessionID: normalizeLoopSessionID(storedSession.String),
				}, true
				return tx.wrote("loop-task:claim")
			}
		}
		return nil
	})
	return claim, claimed, err
}

func (writer *Writer) FinishPlanTask(ctx context.Context, input repository.LoopPlanTaskCompletion) error {
	if input.ProjectID <= 0 || input.PlanID <= 0 || input.TaskID <= 0 || strings.TrimSpace(input.OperationID) == "" ||
		!domainplan.ValidUTCTimestamp(input.FinishedAt) || input.DurationMS < 0 ||
		input.SessionID != normalizeLoopSessionID(input.SessionID) ||
		(input.Succeeded && input.Cancelled) ||
		(!input.Succeeded && !input.Cancelled && (input.FailureCode == "" || len(input.FailureCode) > 64)) ||
		len(input.FailureCode) > 64 {
		return repository.ErrInvalidTask
	}
	return writer.Transact(ctx, func(transaction repository.WriteTransaction) error {
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
		if task.Status != domainplan.TaskRunning && task.Status != domainplan.TaskStopping {
			if task.Status == domainplan.TaskCompleted || task.Status == domainplan.TaskBlocked ||
				task.Status == domainplan.TaskFailed || task.Status == domainplan.TaskStopped ||
				task.Status == domainplan.TaskInterrupted || task.Status == domainplan.TaskDone ||
				task.Status == domainplan.TaskPassed {
				// Process completion can arrive after a stop/completion race has
				// already committed the terminal state. It must not rewrite it.
				return nil
			}
			return repository.ErrVersionConflict
		}
		cancelled := input.Cancelled || task.Status == domainplan.TaskStopping
		taskStatus := domainplan.TaskFailed
		planStatus := domainplan.StatusInterrupted
		validationPassed := 0
		if cancelled {
			taskStatus = domainplan.TaskStopped
			planStatus = domainplan.StatusStopped
		} else if input.Succeeded {
			taskStatus = domainplan.TaskCompleted
			planStatus = domainplan.StatusRunning
		}
		result, err := tx.tx.ExecContext(ctx, `UPDATE plan_tasks
			SET status = ?, finished_at = ?, duration_ms = ?, agent_cli_session_id = ?, updated_at = ?
			WHERE id = ? AND plan_id = ? AND status = ?`,
			string(taskStatus), input.FinishedAt, input.DurationMS, nullableLoopSessionID(input.SessionID), input.FinishedAt,
			input.TaskID, input.PlanID, string(task.Status))
		if err != nil {
			return safeSQLError(ctx, err)
		}
		if err = requireOneRow(result); err != nil {
			return err
		}
		var total, completed int64
		if err = tx.tx.QueryRowContext(ctx, `SELECT COUNT(*),
			COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0)
			FROM plan_tasks WHERE plan_id = ?`, input.PlanID).Scan(&total, &completed); err != nil {
			return safeSQLError(ctx, err)
		}
		if input.Succeeded && total > 0 && completed == total {
			planStatus = domainplan.StatusCompleted
			validationPassed = 1
		}
		digest := plan.Digest
		if input.Digest != "" {
			digest = input.Digest
		}
		if _, err = tx.tx.ExecContext(ctx, `UPDATE plans
			SET hash = ?, status = ?, total_tasks = ?, completed_tasks = ?, validation_passed = ?,
				agent_cli_session_id = ?, updated_at = ?
			WHERE id = ? AND project_id = ?`, digest, string(planStatus), total, completed,
			validationPassed, nullableLoopSessionID(input.SessionID), input.FinishedAt, input.PlanID, input.ProjectID); err != nil {
			return safeSQLError(ctx, err)
		}
		updatedPlan, found, err := tx.GetPlan(ctx, input.ProjectID, input.PlanID)
		if err != nil || !found {
			if err != nil {
				return err
			}
			return repository.ErrTransaction
		}
		updatedTask, found, err := tx.GetPlanTask(ctx, input.ProjectID, input.PlanID, input.TaskID)
		if err != nil || !found {
			if err != nil {
				return err
			}
			return repository.ErrTransaction
		}
		eventType, message, status := "task.failed", "Plan task execution failed", "failed"
		if cancelled {
			eventType, message, status = "task.stopped", "Plan task execution stopped", "stopped"
		} else if input.Succeeded {
			eventType, message, status = "task.succeeded", "Plan task execution completed", "completed"
		}
		if err = appendLoopTaskEvent(ctx, tx, input.OperationID, updatedPlan, updatedTask,
			eventType, message, status, input.FinishedAt); err != nil {
			return err
		}
		if updatedPlan.Status == domainplan.StatusCompleted {
			for _, intakeTable := range []string{"requirements", "feedback"} {
				if _, err = tx.tx.ExecContext(ctx, `UPDATE `+intakeTable+` SET status = 'completed', updated_at = ?
					WHERE project_id = ? AND id IN (SELECT intake_id FROM intake_plan_links
					WHERE project_id = ? AND plan_id = ? AND intake_type = ?)`, input.FinishedAt,
					input.ProjectID, input.ProjectID, input.PlanID, strings.TrimSuffix(intakeTable, "s")); err != nil {
					return safeSQLError(ctx, err)
				}
			}
		}
		return tx.wrote("loop-task:finish")
	})
}

func (writer *Writer) RequestPlanTaskStop(
	ctx context.Context,
	input repository.PlanTaskStopInput,
) (repository.PlanTaskStopResult, error) {
	if input.ProjectID <= 0 || input.PlanID <= 0 || input.TaskID <= 0 ||
		!domainplan.ValidUTCTimestamp(input.UpdatedAt) {
		return repository.PlanTaskStopResult{}, repository.ErrInvalidTask
	}

	var stop repository.PlanTaskStopResult
	err := writer.Transact(ctx, func(transaction repository.WriteTransaction) error {
		tx, ok := transaction.(*writeTransaction)
		if !ok {
			return repository.ErrTransaction
		}

		var actualProjectID, actualPlanID int64
		var storedStatus string
		err := tx.tx.QueryRowContext(ctx, `SELECT plans.project_id, plan_tasks.plan_id, plan_tasks.status
			FROM plan_tasks JOIN plans ON plans.id = plan_tasks.plan_id
			WHERE plan_tasks.id = ?`, input.TaskID).Scan(&actualProjectID, &actualPlanID, &storedStatus)
		if errors.Is(err, sql.ErrNoRows) {
			stop.Outcome = repository.PlanTaskStopNotFound
			return nil
		}
		if err != nil {
			return safeSQLError(ctx, err)
		}

		if actualProjectID != input.ProjectID || actualPlanID != input.PlanID {
			stop.Outcome = repository.PlanTaskStopOwnershipMismatch
			return nil
		}
		status := domainplan.TaskStatus(storedStatus)
		stop.PreviousStatus, stop.Status = status, status
		// The task.started business event is committed by the same transaction
		// that claims the task. Its Operation identifies the only Loop run that
		// may be cancelled for this target; an absent event deliberately means
		// there is no runtime execution to take over.
		var operationID sql.NullString
		if err = tx.tx.QueryRowContext(ctx, `SELECT operation_id FROM event_outbox
			WHERE project_id = ? AND type = 'business.task_started'
			  AND json_extract(data_json, '$.task_id') = ?
			ORDER BY sequence DESC LIMIT 1`, input.ProjectID, input.TaskID).Scan(&operationID); err != nil && !errors.Is(err, sql.ErrNoRows) {
			return safeSQLError(ctx, err)
		}
		stop.OperationID = strings.TrimSpace(operationID.String)
		switch status {
		case domainplan.TaskStopping:
			stop.Outcome = repository.PlanTaskStopAlreadyRequested
			return nil
		case domainplan.TaskCompleted, domainplan.TaskBlocked, domainplan.TaskFailed,
			domainplan.TaskStopped, domainplan.TaskInterrupted, domainplan.TaskDone, domainplan.TaskPassed:
			stop.Outcome = repository.PlanTaskStopTerminal
			return nil
		case domainplan.TaskRunning:
			// Continue below.
		default:
			stop.Outcome = repository.PlanTaskStopNotRunning
			return nil
		}

		result, err := tx.tx.ExecContext(ctx, `UPDATE plan_tasks
			SET status = ?, updated_at = ?
			WHERE id = ? AND plan_id = ? AND status = ?
			  AND EXISTS (SELECT 1 FROM plans WHERE id = ? AND project_id = ?)`,
			string(domainplan.TaskStopping), input.UpdatedAt, input.TaskID, input.PlanID,
			string(domainplan.TaskRunning), input.PlanID, input.ProjectID)
		if err != nil {
			return safeSQLError(ctx, err)
		}
		if err = requireOneRow(result); err != nil {
			return err
		}
		stop.Outcome = repository.PlanTaskStopRequested
		stop.Status = domainplan.TaskStopping
		stop.Changed = true
		return tx.wrote("loop-task:request-stop")
	})
	return stop, err
}

func normalizeLoopSessionID(value string) string {
	text := strings.TrimSpace(value)
	if text == "" || len(text) > 256 {
		return ""
	}
	for _, character := range text {
		if character >= 'a' && character <= 'z' || character >= 'A' && character <= 'Z' ||
			character >= '0' && character <= '9' || character == '.' || character == '_' || character == ':' || character == '-' {
			continue
		}
		return ""
	}
	return text
}

func nullableLoopSessionID(value string) any {
	if value == "" {
		return nil
	}
	return value
}

func appendLoopTaskEvent(
	ctx context.Context,
	tx *writeTransaction,
	operationID string,
	plan domainplan.Plan,
	task domainplan.Task,
	eventType, message, status, occurredAt string,
) error {
	metadataBytes, _ := json.Marshal(map[string]any{
		"plan_id": plan.ID, "task_id": task.ID, "task_key": task.Key, "task_title": loopTaskEventTitle(task), "status": status,
		"completed_tasks": plan.CompletedTasks, "total_tasks": plan.TotalTasks,
	})
	if err := tx.appendRuntimeAudit(ctx, plan.ProjectID, eventType, message, occurredAt, metadataBytes); err != nil {
		return err
	}
	_, err := tx.appendBusinessEvent(ctx, BusinessEvent{
		ProjectID: plan.ProjectID, Type: "business." + strings.ReplaceAll(eventType, ".", "_"),
		OperationID: &operationID, RequestID: operationID, OccurredAt: occurredAt, Payload: metadataBytes,
	})
	return err
}

// loopTaskEventTitle keeps the renderer-facing identity in the durable event.
// Event metadata deliberately cannot contain absolute/path-like strings, so a
// path-shaped task title is labelled before it crosses that boundary.
func loopTaskEventTitle(task domainplan.Task) string {
	title := strings.Join(strings.Fields(task.Title), " ")
	if title == "" {
		title = strings.TrimSpace(task.Key)
	}
	if title == "" {
		title = "Task"
	}
	if utf8.RuneCountInString(title) > 512 {
		title = string([]rune(title)[:512])
	}
	lower := strings.ToLower(title)
	if strings.HasPrefix(lower, "file:") || strings.HasPrefix(title, "/") ||
		(len(title) >= 3 && title[1] == ':' && (title[2] == '\\' || title[2] == '/')) {
		title = "Task " + title
	}
	return title
}

var _ repository.LoopPlanTaskWriter = (*Writer)(nil)
var _ repository.PlanTaskStopper = (*Writer)(nil)
