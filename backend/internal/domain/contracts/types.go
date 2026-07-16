// Package contracts contains the transport-neutral, versioned public DTOs.
package contracts

import "encoding/json"

const SchemaVersionV1 = 1

type Project struct {
	ID            int64  `json:"id"`
	Name          string `json:"name"`
	WorkspacePath string `json:"workspace_path"`
	Description   string `json:"description"`
	CreatedAt     string `json:"created_at"`
	UpdatedAt     string `json:"updated_at"`

	Running              *int    `json:"running,omitempty"`
	Phase                *string `json:"phase,omitempty"`
	IntervalSeconds      *int    `json:"interval_seconds,omitempty"`
	ValidationCommand    *string `json:"validation_command,omitempty"`
	ProjectPrompt        *string `json:"project_prompt,omitempty"`
	AgentCLIProvider     *string `json:"agent_cli_provider,omitempty"`
	AgentCLICommand      *string `json:"agent_cli_command,omitempty"`
	CodexReasoningEffort *string `json:"codex_reasoning_effort,omitempty"`

	PlanGenerationStrategy             *string `json:"plan_generation_strategy,omitempty"`
	PlanGenerationProvider             *string `json:"plan_generation_provider,omitempty"`
	PlanGenerationCommand              *string `json:"plan_generation_command,omitempty"`
	PlanGenerationModel                *string `json:"plan_generation_model,omitempty"`
	PlanGenerationCodexReasoningEffort *string `json:"plan_generation_codex_reasoning_effort,omitempty"`
	PlanGenerationClaudeBaseURL        *string `json:"plan_generation_claude_base_url,omitempty"`
	PlanGenerationClaudeModel          *string `json:"plan_generation_claude_model,omitempty"`
	PlanGenerationHasClaudeAuthToken   *bool   `json:"plan_generation_has_claude_auth_token,omitempty"`
	PlanGenerationClaudeConfigID       *int64  `json:"plan_generation_claude_config_id,omitempty"`

	PlanExecutionStrategy             *string `json:"plan_execution_strategy,omitempty"`
	PlanExecutionProvider             *string `json:"plan_execution_provider,omitempty"`
	PlanExecutionCommand              *string `json:"plan_execution_command,omitempty"`
	PlanExecutionModel                *string `json:"plan_execution_model,omitempty"`
	PlanExecutionCodexReasoningEffort *string `json:"plan_execution_codex_reasoning_effort,omitempty"`
	PlanExecutionClaudeBaseURL        *string `json:"plan_execution_claude_base_url,omitempty"`
	PlanExecutionClaudeModel          *string `json:"plan_execution_claude_model,omitempty"`
	PlanExecutionHasClaudeAuthToken   *bool   `json:"plan_execution_has_claude_auth_token,omitempty"`
	PlanExecutionClaudeConfigID       *int64  `json:"plan_execution_claude_config_id,omitempty"`
}

// SanitizedObject preserves not-yet-migrated compatible DTO fields while its
// decoder permits only explicit workspace capability fields and irreversible
// credential/environment markers; all other sensitive keys remain rejected.
type SanitizedObject map[string]json.RawMessage

// ModelUsageTotals is deliberately outside SanitizedObject: token counters are
// public accounting data, while SanitizedObject continues to reject fields
// containing "token" as potential credentials.
type ModelUsageTotals struct {
	InputTokens     int64 `json:"inputTokens"`
	OutputTokens    int64 `json:"outputTokens"`
	CachedTokens    int64 `json:"cachedTokens"`
	ReasoningTokens int64 `json:"reasoningTokens"`
	TotalTokens     int64 `json:"totalTokens"`
}

type ModelUsageProvider struct {
	Provider   string           `json:"provider"`
	Cumulative ModelUsageTotals `json:"cumulative"`
	Today      ModelUsageTotals `json:"today"`
}

type ModelUsageSummary struct {
	Cumulative ModelUsageTotals     `json:"cumulative"`
	Today      ModelUsageTotals     `json:"today"`
	ByProvider []ModelUsageProvider `json:"byProvider"`
}

type AppSnapshot struct {
	ActiveProjectID  *int64            `json:"activeProjectId"`
	ActiveProject    *Project          `json:"activeProject"`
	Projects         []Project         `json:"projects"`
	MCP              SanitizedObject   `json:"mcp"`
	State            *SanitizedObject  `json:"state"`
	Requirements     []SanitizedObject `json:"requirements"`
	Feedback         []SanitizedObject `json:"feedback"`
	Attachments      []SanitizedObject `json:"attachments"`
	Plans            []SanitizedObject `json:"plans"`
	Tasks            []SanitizedObject `json:"tasks"`
	Events           []SanitizedObject `json:"events"`
	Scans            []SanitizedObject `json:"scans"`
	ScanSummary      SanitizedObject   `json:"scanSummary"`
	Scripts          []SanitizedObject `json:"scripts"`
	Executors        []SanitizedObject `json:"executors"`
	Terminals        []SanitizedObject `json:"terminals"`
	ActiveOperation  *SanitizedObject  `json:"activeOperation"`
	ActiveOperations []SanitizedObject `json:"activeOperations"`
	LastOperation    *SanitizedObject  `json:"lastOperation"`
	ModelUsage       ModelUsageSummary `json:"modelUsage"`
}

type Error struct {
	Code      string           `json:"code"`
	Message   string           `json:"message"`
	RequestID string           `json:"request_id"`
	Retryable bool             `json:"retryable"`
	Details   *SanitizedObject `json:"details,omitempty"`
}

type OperationStatus string

const (
	OperationQueued      OperationStatus = "queued"
	OperationRunning     OperationStatus = "running"
	OperationSucceeded   OperationStatus = "succeeded"
	OperationFailed      OperationStatus = "failed"
	OperationCancelled   OperationStatus = "cancelled"
	OperationInterrupted OperationStatus = "interrupted"
)

type OperationAccepted struct {
	OperationID string          `json:"operation_id"`
	Status      OperationStatus `json:"status"`
	RequestID   string          `json:"request_id"`
	AcceptedAt  string          `json:"accepted_at"`
}

type Operation struct {
	OperationID    string           `json:"operation_id"`
	Type           string           `json:"type"`
	Status         OperationStatus  `json:"status"`
	RequestID      string           `json:"request_id"`
	IdempotencyKey *string          `json:"idempotency_key"`
	CreatedAt      string           `json:"created_at"`
	UpdatedAt      string           `json:"updated_at"`
	StartedAt      *string          `json:"started_at"`
	FinishedAt     *string          `json:"finished_at"`
	Result         *SanitizedObject `json:"result"`
	Error          *Error           `json:"error"`
}

type SSEEnvelopeV1 struct {
	SchemaVersion int             `json:"schema_version"`
	EventID       string          `json:"event_id"`
	Type          string          `json:"type"`
	RequestID     string          `json:"request_id"`
	OperationID   *string         `json:"operation_id"`
	ProjectID     *int64          `json:"project_id,omitempty"`
	OccurredAt    string          `json:"occurred_at"`
	Sequence      *int64          `json:"sequence,omitempty"`
	Data          SanitizedObject `json:"data"`
}

type WSDirection string

const (
	WSClientToServer WSDirection = "client_to_server"
	WSServerToClient WSDirection = "server_to_client"
)

type WSEnvelopeV1 struct {
	SchemaVersion     int             `json:"schema_version"`
	EventID           string          `json:"event_id"`
	Type              string          `json:"type"`
	RequestID         string          `json:"request_id"`
	OperationID       *string         `json:"operation_id"`
	TerminalSessionID *string         `json:"terminal_session_id,omitempty"`
	Direction         WSDirection     `json:"direction"`
	OccurredAt        string          `json:"occurred_at"`
	Data              SanitizedObject `json:"data"`
}
