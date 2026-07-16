package contracts

import (
	"bytes"
	"encoding/json"
	"io"
	"regexp"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

var (
	requestIDPattern   = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$`)
	identifierPattern  = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)
	idempotencyPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)
	errorCodePattern   = regexp.MustCompile(`^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$`)
	messageTypePattern = regexp.MustCompile(`^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+)*$`)
)

func decodeObject(data []byte, destination any, required ...string) error {
	if destination == nil || !validJSONStructure(data) || requireKeys(data, required...) != nil {
		return ErrInvalidContract
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return ErrInvalidContract
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		return ErrInvalidContract
	}
	return nil
}

func rejectNullKeys(data []byte, names ...string) error {
	var object map[string]json.RawMessage
	if err := json.Unmarshal(data, &object); err != nil || object == nil {
		return ErrInvalidContract
	}
	for _, name := range names {
		if raw, exists := object[name]; exists && bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
			return ErrInvalidContract
		}
	}
	return nil
}

func (project *Project) UnmarshalJSON(data []byte) error {
	type wire Project
	var value wire
	optional := []string{
		"workspace_path", "running", "phase", "interval_seconds", "validation_command", "project_prompt",
		"agent_cli_provider", "agent_cli_command",
	}
	if project == nil || rejectNullKeys(data, optional...) != nil ||
		decodeObject(data, &value, "id", "name", "description", "created_at", "updated_at") != nil {
		return ErrInvalidContract
	}
	candidate := Project(value)
	if err := candidate.Validate(); err != nil {
		return err
	}
	*project = candidate
	return nil
}

func (project Project) Validate() error {
	if project.ID <= 0 || strings.TrimSpace(project.Name) == "" || len(project.Name) > 200 ||
		len(project.WorkspacePath) > 4096 || strings.ContainsRune(project.WorkspacePath, 0) ||
		len(project.Description) > 10000 || !validUTCTimestamp(project.CreatedAt) ||
		!validUTCTimestamp(project.UpdatedAt) || later(project.CreatedAt, project.UpdatedAt) {
		return ErrInvalidContract
	}
	if project.Running != nil && *project.Running != 0 && *project.Running != 1 {
		return ErrInvalidContract
	}
	if project.IntervalSeconds != nil && *project.IntervalSeconds <= 0 {
		return ErrInvalidContract
	}
	if project.PlanGenerationStrategy != nil && *project.PlanGenerationStrategy != "external-cli-markdown" &&
		*project.PlanGenerationStrategy != "external-cli-structured" &&
		*project.PlanGenerationStrategy != "builtin-llm-structured" {
		return ErrInvalidContract
	}
	if project.PlanExecutionStrategy != nil && *project.PlanExecutionStrategy != "external-cli" &&
		*project.PlanExecutionStrategy != "builtin-llm" {
		return ErrInvalidContract
	}
	if negativeOptionalID(project.PlanGenerationClaudeConfigID) || negativeOptionalID(project.PlanExecutionClaudeConfigID) {
		return ErrInvalidContract
	}
	return nil
}

func (snapshot *AppSnapshot) UnmarshalJSON(data []byte) error {
	type wire AppSnapshot
	var value wire
	required := []string{
		"activeProjectId", "activeProject", "projects", "mcp", "state", "requirements",
		"feedback", "attachments", "plans", "tasks", "events", "scans", "scanSummary",
		"scripts", "executors", "terminals", "activeOperation", "activeOperations", "lastOperation", "modelUsage",
	}
	if snapshot == nil || decodeObject(data, &value, required...) != nil {
		return ErrInvalidContract
	}
	candidate := AppSnapshot(value)
	if err := candidate.Validate(); err != nil {
		return err
	}
	*snapshot = candidate
	return nil
}

func (snapshot AppSnapshot) Validate() error {
	if snapshot.Projects == nil || snapshot.MCP == nil || snapshot.Requirements == nil ||
		snapshot.Feedback == nil || snapshot.Attachments == nil || snapshot.Plans == nil ||
		snapshot.Tasks == nil || snapshot.Events == nil || snapshot.Scans == nil ||
		snapshot.ScanSummary == nil || snapshot.Scripts == nil || snapshot.Executors == nil ||
		snapshot.Terminals == nil || snapshot.ActiveOperations == nil {
		return ErrInvalidContract
	}
	if snapshot.ModelUsage.Validate() != nil {
		return ErrInvalidContract
	}
	if (snapshot.ActiveProjectID == nil) != (snapshot.ActiveProject == nil) {
		return ErrInvalidContract
	}
	activeFound := snapshot.ActiveProjectID == nil
	projectIDs := make(map[int64]struct{}, len(snapshot.Projects))
	for index := range snapshot.Projects {
		if err := snapshot.Projects[index].Validate(); err != nil {
			return err
		}
		if _, duplicate := projectIDs[snapshot.Projects[index].ID]; duplicate {
			return ErrInvalidContract
		}
		projectIDs[snapshot.Projects[index].ID] = struct{}{}
		if snapshot.ActiveProjectID != nil && snapshot.Projects[index].ID == *snapshot.ActiveProjectID {
			activeFound = true
		}
	}
	if !activeFound {
		return ErrInvalidContract
	}
	if snapshot.ActiveProject != nil {
		if snapshot.ActiveProject.ID != *snapshot.ActiveProjectID || snapshot.ActiveProject.Validate() != nil {
			return ErrInvalidContract
		}
	}
	if snapshot.MCP.Validate() != nil || snapshot.ScanSummary.Validate() != nil ||
		validateOptionalObject(snapshot.State) != nil || validateOptionalObject(snapshot.ActiveOperation) != nil ||
		validateOptionalObject(snapshot.LastOperation) != nil {
		return ErrInvalidContract
	}
	groups := [][]SanitizedObject{
		snapshot.Requirements, snapshot.Feedback, snapshot.Attachments, snapshot.Plans,
		snapshot.Tasks, snapshot.Events, snapshot.Scans, snapshot.Scripts,
		snapshot.Executors, snapshot.Terminals, snapshot.ActiveOperations,
	}
	for _, group := range groups {
		for _, object := range group {
			if object.Validate() != nil {
				return ErrInvalidContract
			}
		}
	}
	return nil
}

func (summary *ModelUsageSummary) UnmarshalJSON(data []byte) error {
	type wire ModelUsageSummary
	var value wire
	if summary == nil || rejectNullKeys(data, "cumulative", "today", "byProvider") != nil ||
		decodeObject(data, &value, "cumulative", "today", "byProvider") != nil {
		return ErrInvalidContract
	}
	candidate := ModelUsageSummary(value)
	if candidate.Validate() != nil {
		return ErrInvalidContract
	}
	*summary = candidate
	return nil
}

func (summary ModelUsageSummary) Validate() error {
	if summary.Cumulative.Validate() != nil || summary.Today.Validate() != nil {
		return ErrInvalidContract
	}
	seen := make(map[string]struct{}, len(summary.ByProvider))
	for _, provider := range summary.ByProvider {
		if strings.TrimSpace(provider.Provider) == "" || len(provider.Provider) > 64 ||
			provider.Provider != strings.TrimSpace(provider.Provider) ||
			!utf8.ValidString(provider.Provider) || strings.ContainsFunc(provider.Provider, unicode.IsControl) ||
			provider.Cumulative.Validate() != nil || provider.Today.Validate() != nil {
			return ErrInvalidContract
		}
		if _, duplicate := seen[provider.Provider]; duplicate {
			return ErrInvalidContract
		}
		seen[provider.Provider] = struct{}{}
	}
	return nil
}

func (summary ModelUsageSummary) MarshalJSON() ([]byte, error) {
	type wire ModelUsageSummary
	value := wire(summary)
	if value.ByProvider == nil {
		value.ByProvider = make([]ModelUsageProvider, 0)
	}
	return json.Marshal(value)
}

func (totals *ModelUsageTotals) UnmarshalJSON(data []byte) error {
	type wire ModelUsageTotals
	var value wire
	if totals == nil || decodeObject(data, &value,
		"inputTokens", "outputTokens", "cachedTokens", "reasoningTokens", "totalTokens") != nil {
		return ErrInvalidContract
	}
	candidate := ModelUsageTotals(value)
	if candidate.Validate() != nil {
		return ErrInvalidContract
	}
	*totals = candidate
	return nil
}

func (totals ModelUsageTotals) Validate() error {
	if totals.InputTokens < 0 || totals.OutputTokens < 0 || totals.CachedTokens < 0 ||
		totals.ReasoningTokens < 0 || totals.TotalTokens < 0 {
		return ErrInvalidContract
	}
	return nil
}

func (failure *Error) UnmarshalJSON(data []byte) error {
	type wire Error
	var value wire
	if failure == nil || rejectNullKeys(data, "details") != nil ||
		decodeObject(data, &value, "code", "message", "request_id", "retryable") != nil {
		return ErrInvalidContract
	}
	candidate := Error(value)
	if err := candidate.Validate(); err != nil {
		return err
	}
	*failure = candidate
	return nil
}

func (failure Error) Validate() error {
	if !errorCodePattern.MatchString(failure.Code) || strings.TrimSpace(failure.Message) == "" ||
		len(failure.Message) > 1000 || !requestIDPattern.MatchString(failure.RequestID) ||
		validateOptionalObject(failure.Details) != nil {
		return ErrInvalidContract
	}
	return nil
}

func (accepted *OperationAccepted) UnmarshalJSON(data []byte) error {
	type wire OperationAccepted
	var value wire
	if accepted == nil || decodeObject(data, &value, "operation_id", "status", "request_id", "accepted_at") != nil {
		return ErrInvalidContract
	}
	candidate := OperationAccepted(value)
	if err := candidate.Validate(); err != nil {
		return err
	}
	*accepted = candidate
	return nil
}

func (accepted OperationAccepted) Validate() error {
	if !identifierPattern.MatchString(accepted.OperationID) || accepted.Status != OperationQueued ||
		!requestIDPattern.MatchString(accepted.RequestID) || !validUTCTimestamp(accepted.AcceptedAt) {
		return ErrInvalidContract
	}
	return nil
}

func (operation *Operation) UnmarshalJSON(data []byte) error {
	type wire Operation
	var value wire
	required := []string{
		"operation_id", "type", "status", "request_id", "idempotency_key", "created_at",
		"updated_at", "started_at", "finished_at", "result", "error",
	}
	if operation == nil || decodeObject(data, &value, required...) != nil {
		return ErrInvalidContract
	}
	candidate := Operation(value)
	if err := candidate.Validate(); err != nil {
		return err
	}
	*operation = candidate
	return nil
}

func (operation Operation) Validate() error {
	if !identifierPattern.MatchString(operation.OperationID) || !messageTypePattern.MatchString(operation.Type) ||
		!validStatus(operation.Status) || !requestIDPattern.MatchString(operation.RequestID) ||
		(operation.IdempotencyKey != nil && !idempotencyPattern.MatchString(*operation.IdempotencyKey)) ||
		!validUTCTimestamp(operation.CreatedAt) || !validUTCTimestamp(operation.UpdatedAt) ||
		later(operation.CreatedAt, operation.UpdatedAt) || !validOptionalTimestamp(operation.StartedAt) ||
		!validOptionalTimestamp(operation.FinishedAt) || validateOptionalObject(operation.Result) != nil {
		return ErrInvalidContract
	}
	if operation.StartedAt != nil && (later(operation.CreatedAt, *operation.StartedAt) || later(*operation.StartedAt, operation.UpdatedAt)) {
		return ErrInvalidContract
	}
	if operation.FinishedAt != nil && (later(operation.CreatedAt, *operation.FinishedAt) || later(*operation.FinishedAt, operation.UpdatedAt)) {
		return ErrInvalidContract
	}
	if operation.StartedAt != nil && operation.FinishedAt != nil && later(*operation.StartedAt, *operation.FinishedAt) {
		return ErrInvalidContract
	}
	if operation.Error != nil && (operation.Error.Validate() != nil || operation.Error.RequestID != operation.RequestID) {
		return ErrInvalidContract
	}
	switch operation.Status {
	case OperationQueued:
		if operation.StartedAt != nil || operation.FinishedAt != nil || operation.Error != nil {
			return ErrInvalidContract
		}
	case OperationRunning:
		if operation.StartedAt == nil || operation.FinishedAt != nil || operation.Error != nil {
			return ErrInvalidContract
		}
	case OperationSucceeded:
		if operation.StartedAt == nil || operation.FinishedAt == nil || operation.Error != nil {
			return ErrInvalidContract
		}
	case OperationFailed:
		if operation.StartedAt == nil || operation.FinishedAt == nil || operation.Error == nil {
			return ErrInvalidContract
		}
	case OperationCancelled, OperationInterrupted:
		if operation.FinishedAt == nil {
			return ErrInvalidContract
		}
	}
	return nil
}

func (envelope *SSEEnvelopeV1) UnmarshalJSON(data []byte) error {
	type wire SSEEnvelopeV1
	var value wire
	required := []string{"schema_version", "event_id", "type", "request_id", "operation_id", "occurred_at", "data"}
	if envelope == nil || rejectNullKeys(data, "project_id", "sequence") != nil ||
		decodeObject(data, &value, required...) != nil {
		return ErrInvalidContract
	}
	candidate := SSEEnvelopeV1(value)
	if err := candidate.Validate(); err != nil {
		return err
	}
	*envelope = candidate
	return nil
}

func (envelope SSEEnvelopeV1) Validate() error {
	if envelope.SchemaVersion != SchemaVersionV1 || !identifierPattern.MatchString(envelope.EventID) ||
		!messageTypePattern.MatchString(envelope.Type) || !requestIDPattern.MatchString(envelope.RequestID) ||
		!validOptionalIdentifier(envelope.OperationID) || (envelope.ProjectID != nil && *envelope.ProjectID <= 0) ||
		!validUTCTimestamp(envelope.OccurredAt) || (envelope.Sequence != nil && *envelope.Sequence < 0) ||
		envelope.Data.Validate() != nil {
		return ErrInvalidContract
	}
	return nil
}

func (envelope *WSEnvelopeV1) UnmarshalJSON(data []byte) error {
	type wire WSEnvelopeV1
	var value wire
	required := []string{"schema_version", "event_id", "type", "request_id", "operation_id", "direction", "occurred_at", "data"}
	if envelope == nil || rejectNullKeys(data, "terminal_session_id") != nil ||
		decodeObject(data, &value, required...) != nil {
		return ErrInvalidContract
	}
	candidate := WSEnvelopeV1(value)
	if err := candidate.Validate(); err != nil {
		return err
	}
	*envelope = candidate
	return nil
}

func (envelope WSEnvelopeV1) Validate() error {
	if envelope.SchemaVersion != SchemaVersionV1 || !identifierPattern.MatchString(envelope.EventID) ||
		!messageTypePattern.MatchString(envelope.Type) || !requestIDPattern.MatchString(envelope.RequestID) ||
		!validOptionalIdentifier(envelope.OperationID) || !validOptionalIdentifier(envelope.TerminalSessionID) ||
		(envelope.Direction != WSClientToServer && envelope.Direction != WSServerToClient) ||
		!validUTCTimestamp(envelope.OccurredAt) || envelope.Data.Validate() != nil {
		return ErrInvalidContract
	}
	return nil
}

func validStatus(status OperationStatus) bool {
	switch status {
	case OperationQueued, OperationRunning, OperationSucceeded, OperationFailed, OperationCancelled, OperationInterrupted:
		return true
	default:
		return false
	}
}

func validUTCTimestamp(value string) bool {
	if !strings.HasSuffix(value, "Z") {
		return false
	}
	parsed, err := time.Parse(time.RFC3339Nano, value)
	return err == nil && parsed.Location() == time.UTC
}

func validOptionalTimestamp(value *string) bool {
	return value == nil || validUTCTimestamp(*value)
}

func later(left, right string) bool {
	leftTime, leftError := time.Parse(time.RFC3339Nano, left)
	rightTime, rightError := time.Parse(time.RFC3339Nano, right)
	return leftError != nil || rightError != nil || leftTime.After(rightTime)
}

func negativeOptionalID(value *int64) bool {
	return value != nil && *value < 0
}

func validOptionalIdentifier(value *string) bool {
	return value == nil || identifierPattern.MatchString(*value)
}

func validateOptionalObject(value *SanitizedObject) error {
	if value == nil {
		return nil
	}
	return value.Validate()
}
