// Package plans provides the shared, pure-persistence Plan and PlanTask use
// cases. It deliberately has no runtime, filesystem, or process dependency.
package plans

import (
	"encoding/json"
	"strings"

	"github.com/lyming99/autoplan/backend/internal/domain/contracts"
	domainplan "github.com/lyming99/autoplan/backend/internal/domain/plan"
)

type TargetType string

const (
	TargetPlan TargetType = "plan"
	TargetTask TargetType = "task"
)

func (value TargetType) Valid() bool { return value == TargetPlan || value == TargetTask }

type PlanDTO struct {
	ID                                 int64             `json:"id"`
	ProjectID                          int64             `json:"project_id"`
	IssueHash                          string            `json:"issue_hash"`
	FilePath                           string            `json:"file_path"`
	Hash                               string            `json:"hash"`
	Status                             domainplan.Status `json:"status"`
	SortOrder                          int64             `json:"sort_order"`
	TotalTasks                         int64             `json:"total_tasks"`
	CompletedTasks                     int64             `json:"completed_tasks"`
	ValidationPassed                   int               `json:"validation_passed"`
	AgentCLIProvider                   *string           `json:"agent_cli_provider"`
	AgentCLICommand                    string            `json:"agent_cli_command"`
	CodexReasoningEffort               *string           `json:"codex_reasoning_effort"`
	PlanGenerationStrategy             string            `json:"plan_generation_strategy"`
	PlanGenerationProvider             *string           `json:"plan_generation_provider"`
	PlanGenerationCommand              string            `json:"plan_generation_command"`
	PlanGenerationModel                string            `json:"plan_generation_model"`
	PlanGenerationCodexReasoningEffort *string           `json:"plan_generation_codex_reasoning_effort"`
	PlanGenerationClaudeConfigID       int64             `json:"plan_generation_claude_config_id"`
	PlanExecutionStrategy              string            `json:"plan_execution_strategy"`
	PlanExecutionProvider              *string           `json:"plan_execution_provider"`
	PlanExecutionCommand               string            `json:"plan_execution_command"`
	PlanExecutionModel                 string            `json:"plan_execution_model"`
	PlanExecutionCodexReasoningEffort  *string           `json:"plan_execution_codex_reasoning_effort"`
	PlanExecutionClaudeConfigID        int64             `json:"plan_execution_claude_config_id"`
	PlanGenerationDurationMS           int64             `json:"plan_generation_duration_ms"`
	CreatedAt                          string            `json:"created_at"`
	UpdatedAt                          string            `json:"updated_at"`
	AcceptedAt                         *string           `json:"accepted_at"`
	Title                              string            `json:"title"`
}

type TaskDTO struct {
	ID         int64                 `json:"id"`
	ProjectID  int64                 `json:"project_id"`
	PlanID     int64                 `json:"plan_id"`
	TaskKey    string                `json:"task_key"`
	Title      string                `json:"title"`
	RawLine    string                `json:"raw_line"`
	Scope      string                `json:"scope"`
	Status     domainplan.TaskStatus `json:"status"`
	SortOrder  int64                 `json:"sort_order"`
	StartedAt  *string               `json:"started_at"`
	FinishedAt *string               `json:"finished_at"`
	DurationMS int64                 `json:"duration_ms"`
	UpdatedAt  string                `json:"updated_at"`
	AcceptedAt *string               `json:"accepted_at"`
	FilePath   string                `json:"file_path"`
	PlanTitle  string                `json:"plan_title"`
}

type AcceptanceTarget struct {
	TargetType            TargetType `json:"target_type"`
	ID                    int64      `json:"id"`
	ExpectedUpdatedAt     string     `json:"expected_updated_at"`
	ExpectedPlanUpdatedAt string     `json:"expected_plan_updated_at,omitempty"`
}

type AcceptanceResult struct {
	TargetType TargetType `json:"target_type"`
	ID         int64      `json:"id"`
	PlanID     int64      `json:"plan_id"`
	AcceptedAt *string    `json:"accepted_at"`
	Status     string     `json:"status"`
}

type MutationResult struct {
	Snapshot contracts.AppSnapshot `json:"snapshot"`
	Items    []AcceptanceResult    `json:"items,omitempty"`
}

func planDTO(value domainplan.Plan, titleOverride ...string) PlanDTO {
	validationPassed := 0
	if value.ValidationPassed {
		validationPassed = 1
	}
	filePath := safeRelativeReference(value.SourceRef)
	title := "Plan #" + decimal(value.ID)
	if len(titleOverride) > 0 {
		if override := cleanPlanTitle(titleOverride[0]); override != "" {
			title = override
		}
	}
	return PlanDTO{
		ID: value.ID, ProjectID: value.ProjectID, IssueHash: value.IssueHash, FilePath: filePath, Hash: value.Digest,
		Status: value.Status, SortOrder: value.SortOrder, TotalTasks: value.TotalTasks,
		CompletedTasks: value.CompletedTasks, ValidationPassed: validationPassed,
		AgentCLIProvider: copyString(value.AgentCLI.Provider), AgentCLICommand: value.AgentCLI.Command,
		CodexReasoningEffort:   copyString(value.AgentCLI.CodexReasoningEffort),
		PlanGenerationStrategy: value.PlanGeneration.Strategy,
		PlanGenerationProvider: copyString(value.PlanGeneration.Provider),
		PlanGenerationCommand:  value.PlanGeneration.Command, PlanGenerationModel: value.PlanGeneration.Model,
		PlanGenerationCodexReasoningEffort: copyString(value.PlanGeneration.CodexReasoningEffort),
		PlanGenerationClaudeConfigID:       value.PlanGeneration.ClaudeConfigID,
		PlanExecutionStrategy:              value.PlanExecution.Strategy,
		PlanExecutionProvider:              copyString(value.PlanExecution.Provider),
		PlanExecutionCommand:               value.PlanExecution.Command, PlanExecutionModel: value.PlanExecution.Model,
		PlanExecutionCodexReasoningEffort: copyString(value.PlanExecution.CodexReasoningEffort),
		PlanExecutionClaudeConfigID:       value.PlanExecution.ClaudeConfigID,
		PlanGenerationDurationMS:          value.GenerationMillis, CreatedAt: value.CreatedAt, UpdatedAt: value.UpdatedAt,
		AcceptedAt: copyString(value.AcceptedAt), Title: title,
	}
}

// PlanDTOFromDomain is used by sibling application projections that need the
// same redacted source-reference and title semantics as Plan queries.
func PlanDTOFromDomain(value domainplan.Plan, titleOverride ...string) PlanDTO {
	return planDTO(value, titleOverride...)
}

func taskDTO(value domainplan.Task, plan PlanDTO) TaskDTO {
	return TaskDTO{
		ID: value.ID, ProjectID: value.ProjectID, PlanID: value.PlanID, TaskKey: value.Key,
		Title: value.Title, RawLine: value.RawLine, Scope: value.Scope, Status: value.Status,
		SortOrder: value.SortOrder, StartedAt: copyString(value.StartedAt), FinishedAt: copyString(value.FinishedAt),
		DurationMS: value.DurationMS, UpdatedAt: value.UpdatedAt, AcceptedAt: copyString(value.AcceptedAt),
		FilePath: plan.FilePath, PlanTitle: plan.Title,
	}
}

// PlanSnapshot and TaskSnapshot are used by the committed AppSnapshot
// assembler. They retain Node-compatible snake_case fields while excluding
// session IDs, credential values, and absolute filesystem capabilities.
func PlanSnapshot(value domainplan.Plan, titleOverride ...string) (contracts.SanitizedObject, error) {
	dto := planDTO(value, titleOverride...)
	return sanitized(map[string]any{
		"id": dto.ID, "project_id": dto.ProjectID, "issue_hash": dto.IssueHash,
		"file_path": dto.FilePath, "hash": dto.Hash, "status": dto.Status,
		"sort_order": dto.SortOrder, "total_tasks": dto.TotalTasks,
		"completed_tasks": dto.CompletedTasks, "validation_passed": dto.ValidationPassed,
		"agent_cli_provider": dto.AgentCLIProvider, "agent_cli_command": dto.AgentCLICommand,
		"codex_reasoning_effort": dto.CodexReasoningEffort, "agent_cli_session_id": nil,
		"plan_generation_strategy":               dto.PlanGenerationStrategy,
		"plan_generation_provider":               dto.PlanGenerationProvider,
		"plan_generation_command":                dto.PlanGenerationCommand,
		"plan_generation_model":                  dto.PlanGenerationModel,
		"plan_generation_codex_reasoning_effort": dto.PlanGenerationCodexReasoningEffort,
		"plan_generation_claude_base_url":        "", "plan_generation_claude_auth_token": "",
		"plan_generation_claude_model": "", "plan_generation_claude_config_id": dto.PlanGenerationClaudeConfigID,
		"plan_generation_has_claude_auth_token": false,
		"plan_execution_strategy":               dto.PlanExecutionStrategy,
		"plan_execution_provider":               dto.PlanExecutionProvider,
		"plan_execution_command":                dto.PlanExecutionCommand,
		"plan_execution_model":                  dto.PlanExecutionModel,
		"plan_execution_codex_reasoning_effort": dto.PlanExecutionCodexReasoningEffort,
		"plan_execution_claude_base_url":        "", "plan_execution_claude_auth_token": "",
		"plan_execution_claude_model": "", "plan_execution_claude_config_id": dto.PlanExecutionClaudeConfigID,
		"plan_execution_has_claude_auth_token": false,
		"plan_generation_duration_ms":          dto.PlanGenerationDurationMS,
		"created_at":                           dto.CreatedAt, "updated_at": dto.UpdatedAt, "accepted_at": dto.AcceptedAt,
		"is_draft": dto.Status == domainplan.StatusDraft, "title": dto.Title,
		"concurrency_suggestion": map[string]any{
			"hasSafeParallelBatches": false, "parallelTaskCount": 0, "batchCount": 0,
			"serialTaskCount": 0, "maxParallelTasks": 1, "batches": []any{}, "serialTasks": []any{},
		},
	})
}

func TaskSnapshot(value domainplan.Task, parent domainplan.Plan, planTitleOverride ...string) (contracts.SanitizedObject, error) {
	dto := taskDTO(value, planDTO(parent, planTitleOverride...))
	return sanitized(map[string]any{
		"id": dto.ID, "project_id": dto.ProjectID, "plan_id": dto.PlanID,
		"task_key": dto.TaskKey, "title": dto.Title, "raw_line": dto.RawLine,
		"scope": dto.Scope, "scope_files": []any{}, "status": dto.Status, "sort_order": dto.SortOrder,
		"started_at": dto.StartedAt, "finished_at": dto.FinishedAt, "duration_ms": dto.DurationMS,
		"updated_at": dto.UpdatedAt, "accepted_at": dto.AcceptedAt,
		"file_path": dto.FilePath, "plan_title": dto.PlanTitle,
	})
}

func sanitized(fields map[string]any) (contracts.SanitizedObject, error) {
	result := make(contracts.SanitizedObject, len(fields))
	for name, value := range fields {
		encoded, err := json.Marshal(value)
		if err != nil {
			return nil, ErrInvalidCommand
		}
		result[name] = encoded
	}
	if result.Validate() != nil {
		return nil, ErrInvalidCommand
	}
	return result, nil
}

func safeRelativeReference(value string) string {
	trimmed := strings.TrimSpace(value)
	segments := strings.Split(strings.ReplaceAll(trimmed, "\\", "/"), "/")
	for _, segment := range segments {
		if segment == ".." {
			return ""
		}
	}
	if trimmed == "" || strings.HasPrefix(strings.ToLower(trimmed), "file:") ||
		strings.HasPrefix(trimmed, "/") || strings.HasPrefix(trimmed, `\\`) ||
		(len(trimmed) >= 3 && trimmed[1] == ':' && (trimmed[2] == '\\' || trimmed[2] == '/')) {
		return ""
	}
	return trimmed
}

func copyString(value *string) *string {
	if value == nil {
		return nil
	}
	copy := *value
	return &copy
}

func decimal(value int64) string {
	if value == 0 {
		return "0"
	}
	buffer := [20]byte{}
	position := len(buffer)
	for value > 0 {
		position--
		buffer[position] = byte('0' + value%10)
		value /= 10
	}
	return string(buffer[position:])
}
