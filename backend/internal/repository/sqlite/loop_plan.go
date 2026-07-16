package sqlite

import (
	"context"
	"strings"

	domainintake "github.com/lyming99/autoplan/backend/internal/domain/intake"
	domainplan "github.com/lyming99/autoplan/backend/internal/domain/plan"
	"github.com/lyming99/autoplan/backend/internal/repository"
)

func (writer *Writer) CreateGeneratedPlan(ctx context.Context, input repository.GeneratedPlanInput) (int64, error) {
	status := input.Status
	if status == "" {
		status = domainplan.StatusPending
	}
	if input.ProjectID <= 0 || input.IntakeID <= 0 || !input.IntakeType.Valid() ||
		strings.TrimSpace(input.IssueHash) == "" || strings.TrimSpace(input.FilePath) == "" ||
		strings.TrimSpace(input.Digest) == "" || input.GenerationDurationMS < 0 ||
		!domainintake.ValidUTCTimestamp(input.CreatedAt) || len(input.Tasks) == 0 ||
		(status != domainplan.StatusDraft && status != domainplan.StatusPending) {
		return 0, repository.ErrInvalidPlan
	}
	var planID int64
	err := writer.Transact(ctx, func(transaction repository.WriteTransaction) error {
		tx, ok := transaction.(*writeTransaction)
		if !ok {
			return repository.ErrTransaction
		}
		if _, found, err := tx.GetIntake(ctx, input.ProjectID, input.IntakeType, input.IntakeID); err != nil || !found {
			if err != nil {
				return err
			}
			return repository.ErrNotFound
		}
		var sortOrder int64
		if err := tx.tx.QueryRowContext(ctx, "SELECT COALESCE(MAX(sort_order), 0) + 1 FROM plans WHERE project_id = ?", input.ProjectID).Scan(&sortOrder); err != nil {
			return safeSQLError(ctx, err)
		}
		provider := optionalString(input.AgentCLI.Provider)
		generationProvider := optionalString(input.PlanGeneration.Provider)
		if generationProvider == nil {
			generationProvider = provider
		}
		strategy := "external-cli-structured"
		if input.PlanGeneration.Strategy != nil && strings.TrimSpace(*input.PlanGeneration.Strategy) != "" {
			strategy = strings.TrimSpace(*input.PlanGeneration.Strategy)
		}
		result, err := tx.tx.ExecContext(ctx, `INSERT INTO plans (
			project_id, issue_hash, file_path, hash, status, sort_order, total_tasks, completed_tasks, validation_passed,
			agent_cli_provider, agent_cli_command, codex_reasoning_effort,
			plan_generation_strategy, plan_generation_provider, plan_generation_command, plan_generation_model,
			plan_generation_codex_reasoning_effort, plan_generation_claude_config_id,
			plan_execution_strategy, plan_execution_provider, plan_execution_command, plan_execution_codex_reasoning_effort,
			plan_generation_duration_ms, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'external-cli', ?, ?, ?, ?, ?, ?)`,
			input.ProjectID, input.IssueHash, input.FilePath, input.Digest, string(status), sortOrder, len(input.Tasks),
			provider, input.AgentCLI.Command, optionalString(input.AgentCLI.CodexReasoningEffort),
			strategy, generationProvider, input.PlanGeneration.Command, input.PlanGeneration.Model,
			optionalString(input.PlanGeneration.CodexReasoningEffort), input.PlanGeneration.ClaudeConfigID,
			provider, input.AgentCLI.Command, optionalString(input.AgentCLI.CodexReasoningEffort),
			input.GenerationDurationMS, input.CreatedAt, input.CreatedAt)
		if err != nil {
			return safeSQLError(ctx, err)
		}
		planID, err = result.LastInsertId()
		if err != nil || planID <= 0 {
			return repository.ErrTransaction
		}
		for _, task := range input.Tasks {
			if task.SortOrder <= 0 || strings.TrimSpace(task.Key) == "" || strings.TrimSpace(task.Title) == "" || strings.TrimSpace(task.RawLine) == "" {
				return repository.ErrInvalidTask
			}
			if _, err = tx.tx.ExecContext(ctx, `INSERT INTO plan_tasks
				(plan_id, task_key, title, raw_line, scope, status, sort_order, updated_at)
				VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`, planID, task.Key, task.Title, task.RawLine, task.Scope, task.SortOrder, input.CreatedAt); err != nil {
				return safeSQLError(ctx, err)
			}
		}
		if _, err = tx.tx.ExecContext(ctx, `INSERT INTO intake_plan_links
			(project_id, intake_type, intake_id, plan_id, phase_index, phase_title, created_at, updated_at)
			VALUES (?, ?, ?, ?, 1, ?, ?, ?)`, input.ProjectID, string(input.IntakeType), input.IntakeID, planID, input.FilePath, input.CreatedAt, input.CreatedAt); err != nil {
			return safeSQLError(ctx, err)
		}
		if _, err = tx.tx.ExecContext(ctx, "UPDATE "+input.IntakeType.Table()+" SET linked_plan_id = ?, updated_at = ? WHERE project_id = ? AND id = ?",
			planID, input.CreatedAt, input.ProjectID, input.IntakeID); err != nil {
			return safeSQLError(ctx, err)
		}
		return tx.wrote("loop:generated-plan")
	})
	return planID, err
}

var _ repository.GeneratedPlanWriter = (*Writer)(nil)
