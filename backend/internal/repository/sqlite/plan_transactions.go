package sqlite

import (
	"context"
	"sort"

	domainplan "github.com/lyming99/autoplan/backend/internal/domain/plan"
	"github.com/lyming99/autoplan/backend/internal/repository"
)

// TransactPlans keeps plan/task mutations and their queued audit events in a
// single top-level serializable transaction. It has no nested transaction or
// arbitrary SQL escape hatch.
func (writer *Writer) TransactPlans(
	ctx context.Context,
	operation func(repository.PlanWriteTransaction) error,
) error {
	if operation == nil {
		return repository.ErrTransaction
	}
	return writer.Transact(ctx, func(transaction repository.WriteTransaction) error {
		planTransaction, ok := transaction.(repository.PlanWriteTransaction)
		if !ok {
			return repository.ErrTransaction
		}
		return operation(planTransaction)
	})
}

func (transaction *writeTransaction) RedoPlan(
	ctx context.Context,
	input domainplan.PlanRedo,
) (domainplan.Plan, error) {
	if domainplan.ValidatePlanRedo(input) != nil {
		return domainplan.Plan{}, repository.ErrInvalidPlan
	}
	current, found, err := transaction.GetPlan(ctx, input.ProjectID, input.PlanID)
	if err != nil {
		return domainplan.Plan{}, err
	}
	if !found {
		return domainplan.Plan{}, repository.ErrNotFound
	}
	if current.UpdatedAt != input.ExpectedPlanUpdatedAt {
		return domainplan.Plan{}, repository.ErrVersionConflict
	}
	if current.Status == domainplan.StatusRunning || current.Status != domainplan.StatusCompleted {
		return domainplan.Plan{}, repository.ErrInvalidPlan
	}
	tasks, err := transaction.ListPlanTasks(ctx, input.ProjectID, input.PlanID)
	if err != nil {
		return domainplan.Plan{}, err
	}
	if len(tasks) != len(input.ExpectedTaskUpdatedAt) {
		return domainplan.Plan{}, repository.ErrVersionConflict
	}
	for _, task := range tasks {
		expected, exists := input.ExpectedTaskUpdatedAt[task.ID]
		if !exists || expected != task.UpdatedAt {
			return domainplan.Plan{}, repository.ErrVersionConflict
		}
	}
	for _, task := range tasks {
		if task.Status != domainplan.TaskCompleted {
			continue
		}
		result, updateErr := transaction.tx.ExecContext(ctx,
			`UPDATE plan_tasks SET status = ?, updated_at = ?
			  WHERE id = ? AND plan_id = ? AND updated_at = ?
			    AND EXISTS (SELECT 1 FROM plans WHERE id = plan_tasks.plan_id AND project_id = ?)`,
			string(domainplan.TaskPending), input.UpdatedAt, task.ID, input.PlanID, task.UpdatedAt, input.ProjectID)
		if updateErr != nil {
			return domainplan.Plan{}, safeSQLError(ctx, updateErr)
		}
		if err := requireOneRow(result); err != nil {
			if err == repository.ErrNotFound {
				return domainplan.Plan{}, repository.ErrVersionConflict
			}
			return domainplan.Plan{}, err
		}
		if err := transaction.wrote("plan-tasks:redo-plan"); err != nil {
			return domainplan.Plan{}, err
		}
	}
	result, err := transaction.tx.ExecContext(ctx,
		`UPDATE plans SET status = ?, validation_passed = 0, accepted_at = NULL, updated_at = ?
		  WHERE id = ? AND project_id = ? AND updated_at = ?`,
		string(domainplan.StatusPending), input.UpdatedAt, input.PlanID, input.ProjectID, input.ExpectedPlanUpdatedAt)
	if err != nil {
		return domainplan.Plan{}, safeSQLError(ctx, err)
	}
	if err := requireOneRow(result); err != nil {
		if err == repository.ErrNotFound {
			return domainplan.Plan{}, repository.ErrVersionConflict
		}
		return domainplan.Plan{}, err
	}
	if err := transaction.wrote("plans:redo"); err != nil {
		return domainplan.Plan{}, err
	}
	updated, found, err := transaction.GetPlan(ctx, input.ProjectID, input.PlanID)
	if err != nil {
		return domainplan.Plan{}, err
	}
	if !found {
		return domainplan.Plan{}, repository.ErrTransaction
	}
	return updated, nil
}

func (transaction *writeTransaction) DeletePlanAggregate(
	ctx context.Context,
	input domainplan.Delete,
) (domainplan.DeleteResult, error) {
	if domainplan.ValidateDelete(input) != nil {
		return domainplan.DeleteResult{}, repository.ErrInvalidPlan
	}
	current, found, err := transaction.GetPlan(ctx, input.ProjectID, input.PlanID)
	if err != nil {
		return domainplan.DeleteResult{}, err
	}
	if !found {
		return domainplan.DeleteResult{}, repository.ErrNotFound
	}
	if current.UpdatedAt != input.ExpectedUpdatedAt {
		return domainplan.DeleteResult{}, repository.ErrVersionConflict
	}
	if current.Status == domainplan.StatusRunning {
		return domainplan.DeleteResult{}, repository.ErrRelationConflict
	}
	var runningTasks int64
	if err := transaction.tx.QueryRowContext(ctx,
		"SELECT COUNT(*) FROM plan_tasks WHERE plan_id = ? AND status = ?", input.PlanID, string(domainplan.TaskRunning)).Scan(&runningTasks); err != nil {
		return domainplan.DeleteResult{}, safeSQLError(ctx, err)
	}
	if runningTasks != 0 {
		return domainplan.DeleteResult{}, repository.ErrRelationConflict
	}

	result := domainplan.DeleteResult{PlanID: input.PlanID, LinkedIntakes: []domainplan.LinkedIntake{}}
	references, err := transaction.listPlanLinkedIntakes(ctx, input.ProjectID, input.PlanID)
	if err != nil {
		return domainplan.DeleteResult{}, err
	}
	result.LinkedIntakes = references
	if _, err := transaction.tx.ExecContext(ctx,
		"DELETE FROM intake_plan_links WHERE project_id = ? AND plan_id = ?", input.ProjectID, input.PlanID); err != nil {
		return domainplan.DeleteResult{}, safeSQLError(ctx, err)
	}
	if err := transaction.wrote("plan-links:delete-plan"); err != nil {
		return domainplan.DeleteResult{}, err
	}
	for _, reference := range references {
		if reference.IntakeType != "requirement" && reference.IntakeType != "feedback" {
			return domainplan.DeleteResult{}, repository.ErrInvalidStore
		}
		table := "requirements"
		if reference.IntakeType == "feedback" {
			table = "feedback"
		}
		updateResult, updateErr := transaction.tx.ExecContext(ctx,
			"UPDATE "+table+` SET linked_plan_id = (
			  SELECT plan_id FROM intake_plan_links
			   WHERE project_id = ? AND intake_type = ? AND intake_id = ?
			   ORDER BY phase_index ASC, plan_id ASC LIMIT 1
			), updated_at = ?
			 WHERE project_id = ? AND id = ? AND linked_plan_id = ?`,
			input.ProjectID, reference.IntakeType, reference.IntakeID, input.UpdatedAt,
			input.ProjectID, reference.IntakeID, input.PlanID)
		if updateErr != nil {
			return domainplan.DeleteResult{}, safeSQLError(ctx, updateErr)
		}
		if _, affectedErr := rowsAffected(updateResult); affectedErr != nil {
			return domainplan.DeleteResult{}, affectedErr
		}
		if err := transaction.wrote("plan-links:sync-legacy-after-plan-delete"); err != nil {
			return domainplan.DeleteResult{}, err
		}
	}
	taskResult, err := transaction.tx.ExecContext(ctx,
		"DELETE FROM plan_tasks WHERE plan_id IN (SELECT id FROM plans WHERE id = ? AND project_id = ?)", input.PlanID, input.ProjectID)
	if err != nil {
		return domainplan.DeleteResult{}, safeSQLError(ctx, err)
	}
	result.DeletedTaskCount, err = rowsAffected(taskResult)
	if err != nil {
		return domainplan.DeleteResult{}, err
	}
	if err := transaction.wrote("plan-tasks:delete-plan"); err != nil {
		return domainplan.DeleteResult{}, err
	}
	planResult, err := transaction.tx.ExecContext(ctx,
		"DELETE FROM plans WHERE id = ? AND project_id = ? AND updated_at = ?", input.PlanID, input.ProjectID, input.ExpectedUpdatedAt)
	if err != nil {
		return domainplan.DeleteResult{}, safeSQLError(ctx, err)
	}
	if err := requireOneRow(planResult); err != nil {
		if err == repository.ErrNotFound {
			return domainplan.DeleteResult{}, repository.ErrVersionConflict
		}
		return domainplan.DeleteResult{}, err
	}
	if err := transaction.wrote("plans:delete"); err != nil {
		return domainplan.DeleteResult{}, err
	}
	scanResult, err := transaction.tx.ExecContext(ctx,
		"DELETE FROM scan_files WHERE project_id = ? AND scan_type = 'plan' AND file_path = ?", input.ProjectID, current.SourceRef)
	if err != nil {
		return domainplan.DeleteResult{}, safeSQLError(ctx, err)
	}
	result.DeletedScanCount, err = rowsAffected(scanResult)
	if err != nil {
		return domainplan.DeleteResult{}, err
	}
	if err := transaction.wrote("scan-files:delete-plan"); err != nil {
		return domainplan.DeleteResult{}, err
	}
	return result, nil
}

func (transaction *writeTransaction) listPlanLinkedIntakes(
	ctx context.Context,
	projectID, planID int64,
) ([]domainplan.LinkedIntake, error) {
	rows, err := transaction.tx.QueryContext(ctx,
		`SELECT links.project_id, links.intake_type, links.intake_id
		   FROM intake_plan_links AS links
		  WHERE links.project_id = ? AND links.plan_id = ?
		    AND ((links.intake_type = 'requirement' AND EXISTS (
		      SELECT 1 FROM requirements WHERE id = links.intake_id AND project_id = links.project_id))
		      OR (links.intake_type = 'feedback' AND EXISTS (
		      SELECT 1 FROM feedback WHERE id = links.intake_id AND project_id = links.project_id)))
		  ORDER BY CASE links.intake_type WHEN 'requirement' THEN 0 ELSE 1 END ASC,
		           links.phase_index ASC, links.intake_id ASC`, projectID, planID)
	if err != nil {
		return nil, safeSQLError(ctx, err)
	}
	result := make([]domainplan.LinkedIntake, 0)
	for rows.Next() {
		var reference domainplan.LinkedIntake
		if err := rows.Scan(&reference.ProjectID, &reference.IntakeType, &reference.IntakeID); err != nil {
			_ = rows.Close()
			return nil, safeSQLError(ctx, err)
		}
		if reference.ProjectID != projectID || reference.IntakeID <= 0 ||
			(reference.IntakeType != "requirement" && reference.IntakeType != "feedback") {
			_ = rows.Close()
			return nil, repository.ErrInvalidStore
		}
		result = append(result, reference)
	}
	if closeErr := rows.Close(); closeErr != nil || rows.Err() != nil {
		return nil, repository.ErrTransaction
	}
	if len(result) != 0 {
		return result, nil
	}
	for _, intakeType := range []string{"requirement", "feedback"} {
		table := "requirements"
		if intakeType == "feedback" {
			table = "feedback"
		}
		legacyRows, queryErr := transaction.tx.QueryContext(ctx,
			"SELECT project_id, id FROM "+table+" WHERE project_id = ? AND linked_plan_id = ? ORDER BY id ASC", projectID, planID)
		if queryErr != nil {
			return nil, safeSQLError(ctx, queryErr)
		}
		for legacyRows.Next() {
			var reference domainplan.LinkedIntake
			reference.IntakeType = intakeType
			if err := legacyRows.Scan(&reference.ProjectID, &reference.IntakeID); err != nil {
				_ = legacyRows.Close()
				return nil, safeSQLError(ctx, err)
			}
			result = append(result, reference)
		}
		if closeErr := legacyRows.Close(); closeErr != nil || legacyRows.Err() != nil {
			return nil, repository.ErrTransaction
		}
	}
	sort.SliceStable(result, func(left, right int) bool {
		if result[left].IntakeType == result[right].IntakeType {
			return result[left].IntakeID < result[right].IntakeID
		}
		return result[left].IntakeType < result[right].IntakeType
	})
	return result, nil
}

var _ repository.PlanTransactional = (*Writer)(nil)
var _ repository.PlanWriteTransaction = (*writeTransaction)(nil)
