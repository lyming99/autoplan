package httpapi

import (
	"context"
	"errors"
	"net/http"
	"sort"

	applicationexecutors "github.com/lyming99/autoplan/backend/internal/application/executors"
	applicationscripts "github.com/lyming99/autoplan/backend/internal/application/scripts"
	"github.com/lyming99/autoplan/backend/internal/repository"
)

type ErrorCode string

const (
	CodeNotFound                ErrorCode = "not_found"
	CodeMethodNotAllowed        ErrorCode = "method_not_allowed"
	CodeInvalidJSON             ErrorCode = "invalid_json"
	CodeBodyTooLarge            ErrorCode = "body_too_large"
	CodeUnsupportedMediaType    ErrorCode = "unsupported_media_type"
	CodeInvalidIdempotencyKey   ErrorCode = "invalid_idempotency_key"
	CodeUnauthorized            ErrorCode = "unauthorized"
	CodeOriginForbidden         ErrorCode = "origin_forbidden"
	CodeInvalidPagination       ErrorCode = "invalid_pagination"
	CodeInvalidProjectID        ErrorCode = "invalid_project_id"
	CodeInvalidProject          ErrorCode = "invalid_project"
	CodeInvalidPlan             ErrorCode = "invalid_plan"
	CodeInvalidConfig           ErrorCode = "invalid_config"
	CodeInvalidIntake           ErrorCode = "invalid_intake"
	CodeInvalidAttachment       ErrorCode = "invalid_attachment"
	CodeInvalidAutomation       ErrorCode = "invalid_automation"
	CodeInvalidConversation     ErrorCode = "invalid_conversation"
	CodeInvalidCursor           ErrorCode = "invalid_cursor"
	CodeChatRuntimeUnavailable  ErrorCode = "chat_runtime_unavailable"
	CodeChatQueueItemNotFound   ErrorCode = "chat_queue_item_not_found"
	CodeChatTurnNotFound        ErrorCode = "chat_turn_not_found"
	CodeChatTurnStateConflict   ErrorCode = "chat_turn_state_conflict"
	CodeChatIdempotencyConflict ErrorCode = "chat_idempotency_conflict"
	CodeTerminalFeatureDisabled ErrorCode = "terminal_feature_disabled"
	CodeTerminalPlatformBlocked ErrorCode = "terminal_platform_blocked"
	CodeTerminalPTYUnavailable  ErrorCode = "terminal_pty_unavailable"
	CodeTerminalInvalidPayload  ErrorCode = "terminal_invalid_payload"
	CodeTerminalInvalidSession  ErrorCode = "terminal_invalid_session"
	CodeTerminalSessionNotFound ErrorCode = "terminal_session_not_found"
	CodeTerminalProjectNotFound ErrorCode = "terminal_project_not_found"
	CodeTerminalForbidden       ErrorCode = "terminal_forbidden"
	CodeTerminalCWDOutside      ErrorCode = "terminal_cwd_outside_workspace"
	CodeTerminalWriteFailed     ErrorCode = "terminal_write_failed"
	CodeTerminalResizeFailed    ErrorCode = "terminal_resize_failed"
	CodeTerminalKillFailed      ErrorCode = "terminal_kill_failed"
	CodeTerminalReplayGap       ErrorCode = "terminal_replay_gap"
	CodeTerminalCursorTooOld    ErrorCode = "terminal_cursor_too_old"
	CodeTerminalSessionLimit    ErrorCode = "terminal_session_limit"
	CodeTerminalConnectionLimit ErrorCode = "terminal_connection_limit"
	CodeTerminalRateLimited     ErrorCode = "terminal_rate_limited"
	CodeTerminalSlowConsumer    ErrorCode = "terminal_slow_consumer"
	CodeTerminalProtocolError   ErrorCode = "terminal_protocol_error"
	CodeProjectNotFound         ErrorCode = "project_not_found"
	CodeIntakeNotFound          ErrorCode = "intake_not_found"
	CodeAttachmentNotFound      ErrorCode = "attachment_not_found"
	CodeAutomationNotFound      ErrorCode = "automation_not_found"
	CodeConversationNotFound    ErrorCode = "conversation_not_found"
	CodeConfigNotFound          ErrorCode = "config_not_found"
	CodeVersionRequired         ErrorCode = "version_required"
	CodeVersionConflict         ErrorCode = "version_conflict"
	CodePreconditionFailed      ErrorCode = "precondition_failed"
	CodeProjectRunning          ErrorCode = "project_running"
	CodeRelationConflict        ErrorCode = "relation_conflict"
	CodeIdempotencyKeyReused    ErrorCode = "idempotency_key_reused"
	CodeRequestInProgress       ErrorCode = "request_in_progress"
	CodeDuplicateIntake         ErrorCode = "duplicate_intake"
	CodeAttachmentRecovery      ErrorCode = "attachment_recovery_required"
	CodeRangeNotSatisfiable     ErrorCode = "range_not_satisfiable"
	CodeInsufficientStorage     ErrorCode = "insufficient_storage"
	CodeRepositoryBusy          ErrorCode = "repository_busy"
	CodeRepositorySchemaDrift   ErrorCode = "repository_schema_drift"
	CodeRepositoryUnavailable   ErrorCode = "repository_unavailable"
	CodeRequestTimeout          ErrorCode = "request_timeout"
	CodeRuntimeCommand          ErrorCode = "invalid_runtime_command"
	CodeOperationCancelled      ErrorCode = "operation_cancelled"
	CodeInvalidOperation        ErrorCode = "invalid_operation"
	CodeOperationNotFound       ErrorCode = "operation_not_found"
	CodeOperationVersion        ErrorCode = "operation_version_conflict"
	CodeOperationState          ErrorCode = "operation_state_conflict"
	CodeNotImplemented          ErrorCode = "not_implemented"
	CodeServiceUnavailable      ErrorCode = "service_unavailable"
	CodeShuttingDown            ErrorCode = "shutting_down"
	CodeInternal                ErrorCode = "internal_error"
)

type errorSpec struct {
	status    int
	message   string
	retryable bool
}

var errorCatalog = map[ErrorCode]errorSpec{
	CodeNotFound:                {http.StatusNotFound, "resource not found", false},
	CodeMethodNotAllowed:        {http.StatusMethodNotAllowed, "method not allowed", false},
	CodeInvalidJSON:             {http.StatusBadRequest, "request body must be valid JSON", false},
	CodeBodyTooLarge:            {http.StatusRequestEntityTooLarge, "request body exceeds the configured limit", false},
	CodeUnsupportedMediaType:    {http.StatusUnsupportedMediaType, "content type is not supported", false},
	CodeInvalidIdempotencyKey:   {http.StatusBadRequest, "idempotency key is invalid", false},
	CodeUnauthorized:            {http.StatusUnauthorized, "authentication required", false},
	CodeOriginForbidden:         {http.StatusForbidden, "origin is not allowed", false},
	CodeInvalidPagination:       {http.StatusBadRequest, "pagination parameters are invalid", false},
	CodeInvalidProjectID:        {http.StatusBadRequest, "project id is invalid", false},
	CodeInvalidProject:          {http.StatusBadRequest, "project input is invalid", false},
	CodeInvalidPlan:             {http.StatusUnprocessableEntity, "plan input is invalid", false},
	CodeInvalidConfig:           {http.StatusBadRequest, "configuration input is invalid", false},
	CodeInvalidIntake:           {http.StatusUnprocessableEntity, "intake input is invalid", false},
	CodeInvalidAttachment:       {http.StatusUnprocessableEntity, "attachment input is invalid", false},
	CodeInvalidAutomation:       {http.StatusUnprocessableEntity, "automation input is invalid", false},
	CodeInvalidConversation:     {http.StatusUnprocessableEntity, "conversation input is invalid", false},
	CodeInvalidCursor:           {http.StatusBadRequest, "pagination cursor is invalid", false},
	CodeChatRuntimeUnavailable:  {http.StatusServiceUnavailable, "chat runtime is unavailable", true},
	CodeChatQueueItemNotFound:   {http.StatusNotFound, "chat queue item was not found", false},
	CodeChatTurnNotFound:        {http.StatusNotFound, "chat turn was not found", false},
	CodeChatTurnStateConflict:   {http.StatusConflict, "chat turn state conflicts", false},
	CodeChatIdempotencyConflict: {http.StatusConflict, "chat idempotency key conflicts", false},
	CodeTerminalFeatureDisabled: {http.StatusServiceUnavailable, "terminal feature is disabled", false},
	CodeTerminalPlatformBlocked: {http.StatusServiceUnavailable, "terminal platform is blocked", false},
	CodeTerminalPTYUnavailable:  {http.StatusServiceUnavailable, "terminal capability is unavailable", true},
	CodeTerminalInvalidPayload:  {http.StatusBadRequest, "terminal request is invalid", false},
	CodeTerminalInvalidSession:  {http.StatusBadRequest, "terminal session identifier is invalid", false},
	CodeTerminalSessionNotFound: {http.StatusNotFound, "terminal session was not found", false},
	CodeTerminalProjectNotFound: {http.StatusNotFound, "terminal project was not found", false},
	CodeTerminalForbidden:       {http.StatusForbidden, "terminal access is forbidden", false},
	CodeTerminalCWDOutside:      {http.StatusForbidden, "terminal working directory is not allowed", false},
	CodeTerminalWriteFailed:     {http.StatusConflict, "terminal write failed", false},
	CodeTerminalResizeFailed:    {http.StatusConflict, "terminal resize failed", false},
	CodeTerminalKillFailed:      {http.StatusConflict, "terminal kill failed", false},
	CodeTerminalReplayGap:       {http.StatusConflict, "terminal replay is unavailable", false},
	CodeTerminalCursorTooOld:    {http.StatusConflict, "terminal replay cursor is invalid", false},
	CodeTerminalSessionLimit:    {http.StatusTooManyRequests, "terminal session limit reached", false},
	CodeTerminalConnectionLimit: {http.StatusTooManyRequests, "terminal connection limit reached", false},
	CodeTerminalRateLimited:     {http.StatusTooManyRequests, "terminal rate limit reached", false},
	CodeTerminalSlowConsumer:    {http.StatusTooManyRequests, "terminal consumer is too slow", false},
	CodeTerminalProtocolError:   {http.StatusBadRequest, "terminal protocol is invalid", false},
	CodeProjectNotFound:         {http.StatusNotFound, "project not found", false},
	CodeIntakeNotFound:          {http.StatusNotFound, "intake not found", false},
	CodeAttachmentNotFound:      {http.StatusNotFound, "attachment not found", false},
	CodeAutomationNotFound:      {http.StatusNotFound, "automation resource not found", false},
	CodeConversationNotFound:    {http.StatusNotFound, "conversation not found", false},
	CodeConfigNotFound:          {http.StatusNotFound, "configuration not found", false},
	CodeVersionRequired:         {http.StatusPreconditionRequired, "configuration version is required", false},
	CodeVersionConflict:         {http.StatusConflict, "configuration version is stale", false},
	CodePreconditionFailed:      {http.StatusPreconditionFailed, "resource state is stale", false},
	CodeProjectRunning:          {http.StatusLocked, "project must be stopped before this operation", false},
	CodeRelationConflict:        {http.StatusConflict, "project has protected related resources", false},
	CodeIdempotencyKeyReused:    {http.StatusConflict, "idempotency key was reused with a different request", false},
	CodeRequestInProgress:       {http.StatusConflict, "an equivalent request is already in progress", true},
	CodeDuplicateIntake:         {http.StatusConflict, "an equivalent intake already exists", false},
	CodeAttachmentRecovery:      {http.StatusLocked, "attachment recovery is required", true},
	CodeRangeNotSatisfiable:     {http.StatusRequestedRangeNotSatisfiable, "requested range is not satisfiable", false},
	CodeInsufficientStorage:     {http.StatusInsufficientStorage, "attachment storage is unavailable", true},
	CodeRepositoryBusy:          {http.StatusLocked, "repository is busy", true},
	CodeRepositorySchemaDrift:   {http.StatusInternalServerError, "repository schema is incompatible", false},
	CodeRepositoryUnavailable:   {http.StatusServiceUnavailable, "project repository is unavailable", true},
	CodeRequestTimeout:          {http.StatusGatewayTimeout, "request timed out", true},
	CodeRuntimeCommand:          {http.StatusUnprocessableEntity, "runtime command is invalid", false},
	CodeOperationCancelled:      {http.StatusConflict, "operation was cancelled", false},
	CodeInvalidOperation:        {http.StatusBadRequest, "operation request is invalid", false},
	CodeOperationNotFound:       {http.StatusNotFound, "operation was not found", false},
	CodeOperationVersion:        {http.StatusConflict, "operation version conflicts", false},
	CodeOperationState:          {http.StatusConflict, "operation state conflicts", false},
	CodeNotImplemented:          {http.StatusNotImplemented, "operation is not implemented", false},
	CodeServiceUnavailable:      {http.StatusServiceUnavailable, "service is unavailable", true},
	CodeShuttingDown:            {http.StatusServiceUnavailable, "service is shutting down", true},
	CodeInternal:                {http.StatusInternalServerError, "internal server error", false},
}

// ErrorDetails contains only bounded, non-sensitive transport metadata.
type ErrorDetails struct {
	Field          string   `json:"field,omitempty"`
	LimitBytes     int64    `json:"limit_bytes,omitempty"`
	AllowedMethods []string `json:"allowed_methods,omitempty"`
	Capability     string   `json:"capability,omitempty"`
}

// APIError is constructed from the closed catalog above; arbitrary messages
// and wrapped errors cannot cross the HTTP boundary.
type APIError struct {
	code    ErrorCode
	status  int
	message string
	retry   bool
	details *ErrorDetails
}

func NewAPIError(code ErrorCode, details *ErrorDetails) APIError {
	spec, exists := errorCatalog[code]
	if !exists {
		code = CodeInternal
		spec = errorCatalog[code]
		details = nil
	}
	return APIError{
		code: code, status: spec.status, message: spec.message,
		retry: spec.retryable, details: sanitizeDetails(details),
	}
}

func (failure APIError) Code() ErrorCode { return failure.code }

func (failure APIError) Status() int { return failure.status }

func (failure APIError) Retryable() bool { return failure.retry }

func sanitizeDetails(details *ErrorDetails) *ErrorDetails {
	if details == nil {
		return nil
	}
	result := &ErrorDetails{}
	if validField(details.Field) {
		result.Field = details.Field
	}
	if details.LimitBytes > 0 {
		result.LimitBytes = details.LimitBytes
	}
	if len(details.AllowedMethods) > 0 && len(details.AllowedMethods) <= 16 {
		result.AllowedMethods = make([]string, 0, len(details.AllowedMethods))
		for _, method := range details.AllowedMethods {
			if !validMethod(method) {
				result.AllowedMethods = nil
				break
			}
			result.AllowedMethods = append(result.AllowedMethods, method)
		}
		sort.Strings(result.AllowedMethods)
	}
	if validCapability(details.Capability) {
		result.Capability = details.Capability
	}
	if result.Field == "" && result.LimitBytes == 0 && len(result.AllowedMethods) == 0 && result.Capability == "" {
		return nil
	}
	return result
}

func validCapability(value string) bool {
	if len(value) < 3 || len(value) > 64 {
		return false
	}
	segmentStart := true
	hasSeparator := false
	for _, character := range value {
		if character >= 'a' && character <= 'z' {
			segmentStart = false
			continue
		}
		if !segmentStart && ((character >= '0' && character <= '9') || character == '_') {
			continue
		}
		if character == '.' && !segmentStart {
			segmentStart = true
			hasSeparator = true
			continue
		}
		return false
	}
	return hasSeparator && !segmentStart
}

// writeProcessActionServiceError intentionally collapses disabled, absent and
// cross-project Script/Executor resources into the same public not-found
// result. The caller never receives a command, path, plugin state, runner or
// queue detail that could be used to enumerate project automation.
func writeProcessActionServiceError(writer http.ResponseWriter, request *http.Request, err error) {
	code := CodeInternal
	switch {
	case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded):
		code = CodeRequestTimeout
	case errors.Is(err, applicationscripts.ErrUnauthorized), errors.Is(err, applicationexecutors.ErrUnauthorized):
		code = CodeUnauthorized
	case errors.Is(err, applicationscripts.ErrNotFound), errors.Is(err, applicationscripts.ErrDisabled),
		errors.Is(err, applicationscripts.ErrTriggerMismatch), errors.Is(err, applicationexecutors.ErrNotFound),
		errors.Is(err, applicationexecutors.ErrDisabled), errors.Is(err, applicationexecutors.ErrActionInvalid),
		errors.Is(err, repository.ErrNotFound), errors.Is(err, repository.ErrProjectMismatch):
		code = CodeAutomationNotFound
	case errors.Is(err, applicationscripts.ErrInvalidCommand), errors.Is(err, applicationexecutors.ErrInvalidCommand),
		errors.Is(err, applicationexecutors.ErrActionUnsupported):
		code = CodeRuntimeCommand
	case errors.Is(err, applicationscripts.ErrBusy), errors.Is(err, applicationscripts.ErrStateConflict),
		errors.Is(err, applicationscripts.ErrNotRunning), errors.Is(err, applicationexecutors.ErrBusy),
		errors.Is(err, applicationexecutors.ErrStateConflict), errors.Is(err, applicationexecutors.ErrDependencyMissing),
		errors.Is(err, applicationexecutors.ErrDependencyCycle), errors.Is(err, applicationexecutors.ErrDependencyFailed):
		code = CodeOperationState
	case errors.Is(err, applicationscripts.ErrQueueFull), errors.Is(err, applicationexecutors.ErrQueueFull),
		errors.Is(err, applicationscripts.ErrUnavailable), errors.Is(err, applicationexecutors.ErrUnavailable),
		errors.Is(err, repository.ErrNotConfigured), errors.Is(err, repository.ErrClosed),
		errors.Is(err, repository.ErrWriterUnauthorized), errors.Is(err, repository.ErrUnsafePath),
		errors.Is(err, repository.ErrInvalidStore), errors.Is(err, repository.ErrSourceChanged):
		code = CodeServiceUnavailable
	case errors.Is(err, repository.ErrTransaction), errors.Is(err, repository.ErrCommit), errors.Is(err, repository.ErrRollback):
		code = CodeRepositoryBusy
	case errors.Is(err, repository.ErrSchemaDrift):
		code = CodeRepositorySchemaDrift
	}
	WriteError(writer, request, NewAPIError(code, nil))
}
