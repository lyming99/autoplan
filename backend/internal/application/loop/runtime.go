// Package loop owns the versioned runtime-command boundary shared by REST,
// MCP, background workers, and the future Node compatibility client.
package loop

import (
	"context"
	"errors"
	"strings"
	"unicode/utf8"

	"github.com/lyming99/autoplan/backend/internal/application/capabilities"
	applicationoperations "github.com/lyming99/autoplan/backend/internal/application/operations"
	"github.com/lyming99/autoplan/backend/internal/domain/contracts"
	"github.com/lyming99/autoplan/backend/internal/runtime/scheduler"
)

const ContractVersion = "v1"

var (
	ErrUnavailable        = errors.New("runtime command service unavailable")
	ErrInvalidCommand     = errors.New("runtime command is invalid")
	ErrUnsupportedCommand = errors.New("runtime command is unsupported")
	ErrStateConflict      = errors.New("runtime command state conflicts")
	ErrCancelled          = errors.New("runtime command was cancelled")
	ErrRegistry           = errors.New("runtime command registry is invalid")
)

type CommandKind string

const (
	CommandLoopStart   CommandKind = "loop.start"
	CommandLoopStop    CommandKind = "loop.stop"
	CommandLoopRunOnce CommandKind = "loop.run_once"

	CommandPlanGenerate  CommandKind = "plan.generate"
	CommandPlanParse     CommandKind = "plan.parse"
	CommandPlanRun       CommandKind = "plan.run"
	CommandPlanStop      CommandKind = "plan.stop"
	CommandPlanResume    CommandKind = "plan.resume"
	CommandPlanReexecute CommandKind = "plan.reexecute"
	CommandPlanRecreate  CommandKind = "plan.recreate"
	CommandPlanValidate  CommandKind = "plan.validate"

	CommandTaskRun        CommandKind = "task.run"
	CommandTaskRunBatches CommandKind = "task.run_batches"
	CommandTaskStop       CommandKind = "task.stop"

	CommandAcceptanceAccept        CommandKind = "acceptance.accept"
	CommandAcceptanceUnaccept      CommandKind = "acceptance.unaccept"
	CommandAcceptanceRedo          CommandKind = "acceptance.redo"
	CommandAcceptanceAcceptBatch   CommandKind = "acceptance.accept_batch"
	CommandAcceptanceUnacceptBatch CommandKind = "acceptance.unaccept_batch"

	CommandChatSend          CommandKind = "chat.send"
	CommandChatStop          CommandKind = "chat.stop"
	CommandChatPump          CommandKind = "chat.pump"
	CommandChatGenerateTitle CommandKind = "chat.generate_title"
	CommandChatClear         CommandKind = "chat.clear"

	CommandScriptRun  CommandKind = "script.run"
	CommandScriptStop CommandKind = "script.stop"

	CommandExecutorRun    CommandKind = "executor.run"
	CommandExecutorStop   CommandKind = "executor.stop"
	CommandExecutorAction CommandKind = "executor.action"

	CommandMCPStart          CommandKind = "mcp.start"
	CommandMCPStop           CommandKind = "mcp.stop"
	CommandTerminalConfigure CommandKind = "terminal.configure"
	CommandUpdateConfigure   CommandKind = "update.configure"
)

// Command is deliberately closed: it carries resource identifiers and typed
// runtime intent, never SQL, a table name, process arguments, or an
// environment map. A typed terminal setting is write-only intent and must be
// authorized by the runtime owner. Request and idempotency identity is
// transport metadata and cannot be supplied in a JSON body.
type Command struct {
	Version           string           `json:"version"`
	Kind              CommandKind      `json:"command"`
	ProjectID         int64            `json:"project_id"`
	PlanID            int64            `json:"plan_id,omitempty"`
	TaskID            int64            `json:"task_id,omitempty"`
	IntakeID          int64            `json:"intake_id,omitempty"`
	ConversationID    int64            `json:"conversation_id,omitempty"`
	ScriptID          int64            `json:"script_id,omitempty"`
	ExecutorID        int64            `json:"executor_id,omitempty"`
	ExpectedVersion   int64            `json:"expected_version,omitempty"`
	ExpectedUpdatedAt string           `json:"expected_updated_at,omitempty"`
	Action            string           `json:"action,omitempty"`
	Chat              *ChatInput       `json:"chat,omitempty"`
	Batches           []TaskBatch      `json:"batches,omitempty"`
	Acceptance        *AcceptanceInput `json:"acceptance,omitempty"`
	Terminal          *Terminal        `json:"terminal,omitempty"`
	Updates           *Updates         `json:"updates,omitempty"`
	CallerScope       string           `json:"-"`
	RequestID         string           `json:"-"`
	IdempotencyKey    string           `json:"-"`
}

// ChatInput is write-only intent. A response contains an operation and an
// optional committed snapshot; it never reflects this content.
type ChatInput struct {
	Content string `json:"content"`
}

type TaskBatch struct {
	TaskIDs []int64 `json:"task_ids"`
}

// AcceptanceInput is the bounded write-only intent shared by REST, MCP and
// the Node compatibility client. It contains identifiers only; optimistic
// database versions are resolved and checked inside the Plan transaction.
type AcceptanceInput struct {
	Targets    []AcceptanceTarget `json:"targets"`
	Supplement string             `json:"supplement,omitempty"`
}

type AcceptanceTarget struct {
	TargetType string `json:"target_type"`
	ID         int64  `json:"id"`
}

type Terminal struct {
	DefaultProfile    *string `json:"default_profile,omitempty"`
	InitialCWD        *string `json:"initial_cwd,omitempty"`
	FontSize          *int64  `json:"font_size,omitempty"`
	ScrollbackLimit   *int64  `json:"scrollback_limit,omitempty"`
	RetainOnExit      *bool   `json:"retain_on_exit,omitempty"`
	ConfirmBeforeKill *bool   `json:"confirm_before_kill,omitempty"`
}

type Updates struct {
	AutoCheck       *bool  `json:"auto_check,omitempty"`
	IntervalMinutes *int64 `json:"interval_minutes,omitempty"`
}

// Result is the only successful runtime response. A dispatcher must create a
// real operation reference and may attach a committed Node-compatible
// snapshot. Empty successes are rejected by Bridge.
type Result struct {
	Operation capabilities.OperationReference `json:"operation"`
	Snapshot  *contracts.AppSnapshot          `json:"snapshot,omitempty"`
}

// Dispatcher is implemented by the runtime owner. It must commit the command
// transaction and event before starting a side effect, then attach only a
// committed snapshot. The implementation is intentionally outside this
// package so application commands cannot discover a database, spawn a
// process, or fall back to Node/sql.js.
type Dispatcher interface {
	Dispatch(context.Context, Command) (Result, error)
}

// Handler owns validation for a bounded command family. REST, MCP, UI and the
// Node bridge all invoke the same registered handler through Bridge.
type Handler interface {
	Commands() []CommandKind
	Execute(context.Context, Command) (Result, error)
}

type Dependencies struct {
	// Dispatcher remains the compatibility path for command families that are
	// migrated later. Loop commands use the concrete P005 runtime whenever all
	// of its bounded dependencies are supplied.
	Dispatcher Dispatcher
	Operations *applicationoperations.Service
	Scheduler  *scheduler.Manager
	State      StateStore
	Runner     Runner
}

type Service struct {
	dispatcher Dispatcher
	runtime    *runtimeService
}

func NewService(dependencies Dependencies) *Service {
	return &Service{dispatcher: dependencies.Dispatcher, runtime: newRuntimeService(dependencies)}
}

func (service *Service) Commands() []CommandKind {
	return []CommandKind{CommandLoopStart, CommandLoopStop, CommandLoopRunOnce}
}

func (service *Service) Execute(ctx context.Context, command Command) (Result, error) {
	if err := ValidateCommand(command); err != nil {
		return Result{}, err
	}
	if service == nil {
		return Result{}, ErrUnavailable
	}
	switch command.Kind {
	case CommandLoopStart, CommandLoopStop, CommandLoopRunOnce:
		if service.runtime != nil && service.runtime.Requested() {
			if !service.runtime.Configured() {
				return Result{}, ErrUnavailable
			}
			return service.runtime.Execute(ctx, command)
		}
		return Dispatch(ctx, service.dispatcher, command)
	default:
		return Result{}, ErrUnsupportedCommand
	}
}

// BindOperations completes the bootstrap cycle between the operation service
// and the Loop executor registry. It is intentionally explicit: a nil or
// partially assembled runtime remains unavailable instead of silently using
// the legacy dispatcher.
func (service *Service) BindOperations(operations *applicationoperations.Service) {
	if service == nil || service.runtime == nil {
		return
	}
	service.runtime.BindOperations(operations)
}

// Close stops timer ownership before the scheduler is shut down. It is safe
// during partial assembly and does not manufacture cancellation operations.
func (service *Service) Close(ctx context.Context) error {
	if service == nil || service.runtime == nil {
		return nil
	}
	return service.runtime.Close(ctx)
}

// Recover reconstructs timers and resumes only operations explicitly claimed
// by the executor registry after P10 recovery has committed their running
// state. Unknown work is never relaunched.
func (service *Service) Recover(ctx context.Context) error {
	if service == nil || service.runtime == nil || !service.runtime.Configured() {
		return nil
	}
	return service.runtime.Recover(ctx)
}

// RemoveProject is the deletion hook for the project application service. It
// removes timer ownership before the scheduler tears down the actor, so a
// late tick cannot create a replacement actor for a deleted project.
func (service *Service) RemoveProject(ctx context.Context, projectID int64) error {
	if service == nil || service.runtime == nil {
		return nil
	}
	return service.runtime.RemoveProject(ctx, projectID)
}

// CancelActive requests cancellation of the currently running loop cycle for
// projectID without changing the loop's scheduled state. It is a no-op when
// no cycle is active, so callers must still create and complete an operation.
func (service *Service) CancelActive(ctx context.Context, projectID int64) error {
	if service == nil || service.runtime == nil {
		return ErrUnavailable
	}
	if projectID <= 0 {
		return ErrInvalidCommand
	}
	service.runtime.cancelActive(ctx, projectID)
	return nil
}

// Bridge is a closed dispatcher registry. Registration happens once during
// bootstrap; there is no runtime feature flag or dynamic handler lookup.
type Bridge struct {
	handlers map[CommandKind]Handler
}

func NewBridge(handlers ...Handler) (*Bridge, error) {
	bridge := &Bridge{handlers: make(map[CommandKind]Handler)}
	for _, handler := range handlers {
		if handler == nil {
			return nil, ErrRegistry
		}
		for _, kind := range handler.Commands() {
			if kind == "" {
				return nil, ErrRegistry
			}
			if _, exists := bridge.handlers[kind]; exists {
				return nil, ErrRegistry
			}
			bridge.handlers[kind] = handler
		}
	}
	if len(bridge.handlers) == 0 {
		return nil, ErrRegistry
	}
	return bridge, nil
}

func (bridge *Bridge) Execute(ctx context.Context, command Command) (Result, error) {
	if err := ValidateCommand(command); err != nil {
		return Result{}, err
	}
	if bridge == nil {
		return Result{}, ErrUnavailable
	}
	handler, exists := bridge.handlers[command.Kind]
	if !exists {
		return Result{}, ErrUnsupportedCommand
	}
	result, err := handler.Execute(ctx, command)
	if err != nil {
		return Result{}, err
	}
	if err := validateResult(command, result); err != nil {
		return Result{}, err
	}
	return result, nil
}

func Dispatch(ctx context.Context, dispatcher Dispatcher, command Command) (Result, error) {
	if err := ctx.Err(); err != nil {
		return Result{}, err
	}
	if dispatcher == nil {
		return Result{}, ErrUnavailable
	}
	return dispatcher.Dispatch(ctx, command)
}

// UnavailableDispatcher is deliberately non-operational. It is the bootstrap
// default until a supervised Go runtime owner is supplied by a later phase.
type UnavailableDispatcher struct{}

func (UnavailableDispatcher) Dispatch(context.Context, Command) (Result, error) {
	return Result{}, ErrUnavailable
}

func ValidateCommand(command Command) error {
	if command.Version != ContractVersion || command.Kind == "" || command.ProjectID < 0 ||
		(command.ProjectID == 0 && commandRequiresProject(command.Kind)) ||
		command.PlanID < 0 || command.TaskID < 0 || command.IntakeID < 0 || command.ConversationID < 0 ||
		command.ScriptID < 0 || command.ExecutorID < 0 || command.ExpectedVersion < 0 ||
		len(command.ExpectedUpdatedAt) > 64 || len(command.CallerScope) == 0 || len(command.CallerScope) > 128 ||
		len(command.RequestID) == 0 || len(command.RequestID) > 64 || len(command.IdempotencyKey) == 0 || len(command.IdempotencyKey) > 128 ||
		strings.ContainsAny(command.CallerScope, "\r\n\x00") || strings.ContainsAny(command.RequestID, "\r\n\x00") || strings.ContainsAny(command.IdempotencyKey, "\r\n\x00") ||
		len(command.Action) > 64 || strings.ContainsAny(command.Action, "\r\n\x00") {
		return ErrInvalidCommand
	}
	if command.Chat != nil && (len(command.Chat.Content) == 0 || len(command.Chat.Content) > 131072) {
		return ErrInvalidCommand
	}
	if len(command.Batches) > 64 {
		return ErrInvalidCommand
	}
	seenTasks := make(map[int64]struct{})
	for _, batch := range command.Batches {
		if len(batch.TaskIDs) == 0 || len(batch.TaskIDs) > 100 {
			return ErrInvalidCommand
		}
		for _, id := range batch.TaskIDs {
			if id <= 0 {
				return ErrInvalidCommand
			}
			if _, duplicate := seenTasks[id]; duplicate {
				return ErrInvalidCommand
			}
			seenTasks[id] = struct{}{}
		}
	}
	if command.Acceptance != nil {
		if len(command.Acceptance.Targets) == 0 || len(command.Acceptance.Targets) > 100 ||
			utf8.RuneCountInString(command.Acceptance.Supplement) > 2000 ||
			strings.ContainsAny(command.Acceptance.Supplement, "\r\x00") {
			return ErrInvalidCommand
		}
		seenTargets := make(map[AcceptanceTarget]struct{}, len(command.Acceptance.Targets))
		for _, target := range command.Acceptance.Targets {
			if target.ID <= 0 || (target.TargetType != "plan" && target.TargetType != "task") {
				return ErrInvalidCommand
			}
			if _, duplicate := seenTargets[target]; duplicate {
				return ErrInvalidCommand
			}
			seenTargets[target] = struct{}{}
		}
	}
	return nil
}

func commandRequiresProject(kind CommandKind) bool {
	switch kind {
	case CommandMCPStart, CommandMCPStop, CommandTerminalConfigure, CommandUpdateConfigure:
		return false
	default:
		return true
	}
}

func RequirePlan(command Command) error {
	if command.PlanID <= 0 {
		return ErrInvalidCommand
	}
	return nil
}

func RequireTask(command Command) error {
	if command.PlanID <= 0 || command.TaskID <= 0 {
		return ErrInvalidCommand
	}
	return nil
}

func RequireConversation(command Command) error {
	if command.ConversationID <= 0 {
		return ErrInvalidCommand
	}
	return nil
}

func RequireScript(command Command) error {
	if command.ScriptID <= 0 {
		return ErrInvalidCommand
	}
	return nil
}

func RequireExecutor(command Command) error {
	if command.ExecutorID <= 0 {
		return ErrInvalidCommand
	}
	return nil
}

func validateResult(command Command, result Result) error {
	operation := result.Operation
	if strings.TrimSpace(operation.OperationID) == "" || len(operation.OperationID) > 128 ||
		operation.Type != string(command.Kind) || !validOperationStatus(operation.Status) ||
		operation.RequestID != command.RequestID || strings.TrimSpace(operation.AcceptedAt) == "" {
		return ErrStateConflict
	}
	return nil
}

func validOperationStatus(status string) bool {
	switch status {
	case "accepted", "queued", "running", "completed", "cancelled":
		return true
	default:
		return false
	}
}
