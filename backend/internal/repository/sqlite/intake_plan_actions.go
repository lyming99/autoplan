package sqlite

import (
	"context"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	domainintake "github.com/lyming99/autoplan/backend/internal/domain/intake"
	domainplan "github.com/lyming99/autoplan/backend/internal/domain/plan"
	"github.com/lyming99/autoplan/backend/internal/repository"
)

var intakeTaskKeyPattern = regexp.MustCompile(`(?i)^P0*(\d+)$`)

// ApplyIntakePlanAction owns the complete linked-plan database transition.
// The caller runs it inside TransactIntake together with idempotency and the
// outbox event, so no renderer-visible partial state can be committed.
func (transaction *writeTransaction) ApplyIntakePlanAction(
	ctx context.Context,
	input repository.IntakePlanActionInput,
) (repository.IntakePlanActionResult, error) {
	if input.ProjectID <= 0 || input.IntakeID <= 0 || !input.Type.Valid() ||
		!domainintake.ValidUTCTimestamp(input.UpdatedAt) {
		return repository.IntakePlanActionResult{}, repository.ErrInvalidIntake
	}
	if input.Action != repository.IntakePlanInterrupt && input.Action != repository.IntakePlanResume &&
		input.Action != repository.IntakePlanAppend {
		return repository.IntakePlanActionResult{}, repository.ErrInvalidIntake
	}
	title := strings.Join(strings.Fields(input.Title), " ")
	if input.Action == repository.IntakePlanAppend &&
		(title == "" || utf8.RuneCountInString(title) > 500 || strings.ContainsRune(title, 0)) {
		return repository.IntakePlanActionResult{}, repository.ErrInvalidTask
	}
	if _, found, err := transaction.GetIntake(ctx, input.ProjectID, input.Type, input.IntakeID); err != nil {
		return repository.IntakePlanActionResult{}, err
	} else if !found {
		return repository.IntakePlanActionResult{}, repository.ErrNotFound
	}
	links, err := transaction.ListPlanLinksForIntake(ctx, input.ProjectID, input.Type, input.IntakeID)
	if err != nil {
		return repository.IntakePlanActionResult{}, err
	}
	result := repository.IntakePlanActionResult{PlanIDs: make([]int64, 0, len(links)), UpdatedAt: input.UpdatedAt}
	for _, link := range links {
		result.PlanIDs = append(result.PlanIDs, link.PlanID)
	}
	if input.Action == repository.IntakePlanAppend {
		return transaction.appendIntakePlanTask(ctx, input, title, links, result)
	}
	for _, link := range links {
		plan, found, loadErr := transaction.GetPlan(ctx, input.ProjectID, link.PlanID)
		if loadErr != nil {
			return repository.IntakePlanActionResult{}, loadErr
		}
		if !found {
			return repository.IntakePlanActionResult{}, repository.ErrPlanMissing
		}
		if plan.Status == domainplan.StatusCompleted {
			continue
		}
		updatedAt, timestampErr := intakeActionTimestamp(result.UpdatedAt, plan.UpdatedAt)
		if timestampErr != nil {
			return repository.IntakePlanActionResult{}, timestampErr
		}
		result.UpdatedAt = updatedAt
		var changed bool
		var affected int64
		if input.Action == repository.IntakePlanInterrupt {
			affected, changed, err = transaction.interruptLinkedPlan(ctx, input.ProjectID, plan, updatedAt)
		} else {
			affected, changed, err = transaction.resumeLinkedPlan(ctx, input.ProjectID, plan, updatedAt)
		}
		if err != nil {
			return repository.IntakePlanActionResult{}, err
		}
		if changed {
			result.AffectedPlanIDs = append(result.AffectedPlanIDs, plan.ID)
			result.AffectedTasks += affected
		}
	}
	return result, nil
}

func (transaction *writeTransaction) interruptLinkedPlan(
	ctx context.Context,
	projectID int64,
	plan domainplan.Plan,
	updatedAt string,
) (int64, bool, error) {
	tasks, err := transaction.tx.ExecContext(ctx, `UPDATE plan_tasks
		SET status = ?, updated_at = ?
		WHERE plan_id = ? AND status IN (?, ?, ?)`,
		string(domainplan.TaskBlocked), updatedAt, plan.ID,
		string(domainplan.TaskPending), string(domainplan.TaskRunning), string(domainplan.TaskStopping))
	if err != nil {
		return 0, false, safeSQLError(ctx, err)
	}
	affected, err := rowsAffected(tasks)
	if err != nil {
		return 0, false, err
	}
	planResult, err := transaction.tx.ExecContext(ctx, `UPDATE plans SET status = ?, updated_at = ?
		WHERE id = ? AND project_id = ? AND status <> ?`,
		string(domainplan.StatusInterrupted), updatedAt, plan.ID, projectID, string(domainplan.StatusInterrupted))
	if err != nil {
		return 0, false, safeSQLError(ctx, err)
	}
	planChanges, err := rowsAffected(planResult)
	if err != nil {
		return 0, false, err
	}
	if affected > 0 || planChanges > 0 {
		if err := transaction.wrote("intake-plan:interrupt"); err != nil {
			return 0, false, err
		}
		return affected, true, nil
	}
	return 0, false, nil
}

func (transaction *writeTransaction) resumeLinkedPlan(
	ctx context.Context,
	projectID int64,
	plan domainplan.Plan,
	updatedAt string,
) (int64, bool, error) {
	var blocked int64
	if err := transaction.tx.QueryRowContext(ctx,
		"SELECT COUNT(*) FROM plan_tasks WHERE plan_id = ? AND status = ?",
		plan.ID, string(domainplan.TaskBlocked)).Scan(&blocked); err != nil {
		return 0, false, safeSQLError(ctx, err)
	}
	if plan.Status != domainplan.StatusInterrupted && plan.Status != domainplan.StatusValidationFailed && blocked == 0 {
		return 0, false, nil
	}
	query := `UPDATE plan_tasks SET status = ?, updated_at = ? WHERE plan_id = ? AND status = ?`
	arguments := []any{string(domainplan.TaskPending), updatedAt, plan.ID, string(domainplan.TaskBlocked)}
	if plan.Status == domainplan.StatusValidationFailed {
		query = `UPDATE plan_tasks SET status = ?, updated_at = ? WHERE plan_id = ? AND status IN (?, ?)`
		arguments = append(arguments, string(domainplan.TaskFailed))
	}
	tasks, err := transaction.tx.ExecContext(ctx, query, arguments...)
	if err != nil {
		return 0, false, safeSQLError(ctx, err)
	}
	affected, err := rowsAffected(tasks)
	if err != nil {
		return 0, false, err
	}
	planResult, err := transaction.tx.ExecContext(ctx, `UPDATE plans
		SET status = ?, validation_passed = 0, updated_at = ? WHERE id = ? AND project_id = ?`,
		string(domainplan.StatusPending), updatedAt, plan.ID, projectID)
	if err != nil {
		return 0, false, safeSQLError(ctx, err)
	}
	if err := requireOneRow(planResult); err != nil {
		return 0, false, err
	}
	if err := transaction.wrote("intake-plan:resume"); err != nil {
		return 0, false, err
	}
	return affected, true, nil
}

func (transaction *writeTransaction) appendIntakePlanTask(
	ctx context.Context,
	input repository.IntakePlanActionInput,
	title string,
	links []domainintake.PlanLink,
	result repository.IntakePlanActionResult,
) (repository.IntakePlanActionResult, error) {
	if len(links) == 0 {
		return repository.IntakePlanActionResult{}, repository.ErrPlanMissing
	}
	selected := links[len(links)-1]
	var selectedPlan domainplan.Plan
	for _, link := range links {
		plan, found, err := transaction.GetPlan(ctx, input.ProjectID, link.PlanID)
		if err != nil {
			return repository.IntakePlanActionResult{}, err
		}
		if !found {
			return repository.IntakePlanActionResult{}, repository.ErrPlanMissing
		}
		selected, selectedPlan = link, plan
		if plan.Status != domainplan.StatusCompleted {
			break
		}
	}
	if selectedPlan.ID == 0 {
		var found bool
		var err error
		selectedPlan, found, err = transaction.GetPlan(ctx, input.ProjectID, selected.PlanID)
		if err != nil {
			return repository.IntakePlanActionResult{}, err
		}
		if !found {
			return repository.IntakePlanActionResult{}, repository.ErrPlanMissing
		}
	}
	tasks, err := transaction.ListPlanTasks(ctx, input.ProjectID, selected.PlanID)
	if err != nil {
		return repository.IntakePlanActionResult{}, err
	}
	previousTimes := make([]string, 0, len(tasks)+1)
	previousTimes = append(previousTimes, selectedPlan.UpdatedAt)
	for _, task := range tasks {
		previousTimes = append(previousTimes, task.UpdatedAt)
	}
	updatedAt, err := intakeActionTimestamp(result.UpdatedAt, previousTimes...)
	if err != nil {
		return repository.IntakePlanActionResult{}, err
	}
	result.UpdatedAt = updatedAt
	maxNumber := int64(0)
	maxOrder := int64(0)
	insertOrder := int64(0)
	for _, task := range tasks {
		if task.SortOrder > maxOrder {
			maxOrder = task.SortOrder
		}
		match := intakeTaskKeyPattern.FindStringSubmatch(strings.TrimSpace(task.Key))
		if len(match) == 2 {
			if value, parseErr := strconv.ParseInt(match[1], 10, 64); parseErr == nil && value > maxNumber {
				maxNumber = value
			}
		}
	}
	insertOrder = maxOrder + 1
	if len(tasks) != 0 {
		last := tasks[len(tasks)-1]
		if strings.EqualFold(strings.TrimSpace(last.Scope), "validation") ||
			strings.Contains(strings.ToLower(last.Title), "final validation") {
			insertOrder = last.SortOrder
			if _, err := transaction.tx.ExecContext(ctx,
				"UPDATE plan_tasks SET sort_order = sort_order + 1, updated_at = ? WHERE plan_id = ? AND sort_order >= ?",
				updatedAt, selected.PlanID, insertOrder); err != nil {
				return repository.IntakePlanActionResult{}, safeSQLError(ctx, err)
			}
		}
	}
	taskKey := fmt.Sprintf("P%03d", maxNumber+1)
	rawLine := fmt.Sprintf("- [ ] %s: %s", taskKey, title)
	inserted, err := transaction.tx.ExecContext(ctx, `INSERT INTO plan_tasks
		(plan_id, task_key, title, raw_line, scope, status, sort_order, updated_at)
		VALUES (?, ?, ?, ?, '', ?, ?, ?)`, selected.PlanID, taskKey, title, rawLine,
		string(domainplan.TaskPending), insertOrder, updatedAt)
	if err != nil {
		return repository.IntakePlanActionResult{}, safeSQLError(ctx, err)
	}
	taskID, err := inserted.LastInsertId()
	if err != nil || taskID <= 0 {
		return repository.IntakePlanActionResult{}, repository.ErrTransaction
	}
	status := selectedPlan.Status
	if status == domainplan.StatusCompleted || status == domainplan.StatusInterrupted {
		status = domainplan.StatusPending
		result.Reactivated = true
	}
	planResult, err := transaction.tx.ExecContext(ctx, `UPDATE plans
		SET status = ?, total_tasks = total_tasks + 1, validation_passed = 0, updated_at = ?
		WHERE id = ? AND project_id = ?`, string(status), updatedAt, selected.PlanID, input.ProjectID)
	if err != nil {
		return repository.IntakePlanActionResult{}, safeSQLError(ctx, err)
	}
	if err := requireOneRow(planResult); err != nil {
		return repository.IntakePlanActionResult{}, err
	}
	if err := transaction.wrote("intake-plan:append-task"); err != nil {
		return repository.IntakePlanActionResult{}, err
	}
	result.AffectedPlanIDs = []int64{selected.PlanID}
	result.AffectedTasks = 1
	result.PlanID, result.TaskID, result.TaskKey = selected.PlanID, taskID, taskKey
	return result, nil
}

func intakeActionTimestamp(candidate string, previous ...string) (string, error) {
	next, err := time.Parse(time.RFC3339Nano, candidate)
	if err != nil || next.Location() != time.UTC {
		return "", repository.ErrInvalidIntake
	}
	for _, value := range previous {
		parsed, parseErr := time.Parse(time.RFC3339Nano, value)
		if parseErr != nil || parsed.Location() != time.UTC {
			return "", repository.ErrInvalidStore
		}
		if !next.After(parsed) {
			next = parsed.Add(time.Millisecond)
		}
	}
	return next.UTC().Format("2006-01-02T15:04:05.000Z"), nil
}

var _ repository.IntakePlanActions = (*writeTransaction)(nil)
