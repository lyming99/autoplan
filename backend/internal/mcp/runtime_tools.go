package mcp

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strconv"
	"strings"

	applicationloop "github.com/lyming99/autoplan/backend/internal/application/loop"
)

// RuntimeApplication is the same closed command service used by REST. MCP
// receives neither a repository nor a process/runtime implementation.
type RuntimeApplication interface {
	Execute(context.Context, applicationloop.Command) (applicationloop.Result, error)
}

var _ RuntimeApplication = (*applicationloop.Bridge)(nil)

type RuntimeDependencies struct {
	Bridge RuntimeApplication
}

type RuntimeTools struct {
	bridge RuntimeApplication
}

func NewRuntimeTools(dependencies RuntimeDependencies) *RuntimeTools {
	return &RuntimeTools{bridge: dependencies.Bridge}
}

func (tools *RuntimeTools) Names() []string {
	return []string{
		"runtime.execute",
		"runtime.loop.start", "runtime.loop.stop", "runtime.loop.run_once",
		"runtime.plan.stop", "runtime.plan.resume", "runtime.plan.reexecute", "runtime.plan.recreate",
		"runtime.task.run", "runtime.task.run_batches", "runtime.task.stop",
		"runtime.acceptance.accept", "runtime.acceptance.unaccept", "runtime.acceptance.redo",
		"runtime.acceptance.accept_batch", "runtime.acceptance.unaccept_batch",
		"runtime.intake.retry_plan_generation",
	}
}

// Execute dispatches a typed application command with host-authenticated MCP
// identity. The command result is safe metadata; Chat content and process
// details never appear in the result or ToolError.
func (tools *RuntimeTools) Execute(ctx context.Context, command applicationloop.Command, request ToolContext) (applicationloop.Result, error) {
	if tools == nil || tools.bridge == nil {
		return applicationloop.Result{}, ToolError{Code: "service_unavailable"}
	}
	command.CallerScope = strings.TrimSpace(request.CallerScope)
	if command.CallerScope == "" {
		command.CallerScope = "mcp-local"
	}
	command.RequestID = strings.TrimSpace(request.RequestID)
	if command.RequestID == "" {
		command.RequestID = "mcp-request"
	}
	command.IdempotencyKey = strings.TrimSpace(request.IdempotencyKey)
	if command.IdempotencyKey == "" {
		command.IdempotencyKey = runtimeIdempotencyKey(command)
	}
	result, err := tools.bridge.Execute(ctx, command)
	if err != nil {
		return applicationloop.Result{}, mapRuntimeToolError(err)
	}
	return result, nil
}

// The named helpers give MCP a stable, typed vocabulary while preserving the
// one shared application bridge. They contain no repository/process logic.
func (tools *RuntimeTools) LoopStart(ctx context.Context, request ToolContext, projectID int64) (applicationloop.Result, error) {
	return tools.action(ctx, request, applicationloop.Command{Version: applicationloop.ContractVersion, Kind: applicationloop.CommandLoopStart, ProjectID: projectID})
}

func (tools *RuntimeTools) LoopStop(ctx context.Context, request ToolContext, projectID int64) (applicationloop.Result, error) {
	return tools.action(ctx, request, applicationloop.Command{Version: applicationloop.ContractVersion, Kind: applicationloop.CommandLoopStop, ProjectID: projectID})
}

func (tools *RuntimeTools) LoopRunOnce(ctx context.Context, request ToolContext, projectID int64) (applicationloop.Result, error) {
	return tools.action(ctx, request, applicationloop.Command{Version: applicationloop.ContractVersion, Kind: applicationloop.CommandLoopRunOnce, ProjectID: projectID})
}

func (tools *RuntimeTools) PlanAction(ctx context.Context, request ToolContext, kind applicationloop.CommandKind, projectID, planID int64) (applicationloop.Result, error) {
	switch kind {
	case applicationloop.CommandPlanStop, applicationloop.CommandPlanResume, applicationloop.CommandPlanReexecute, applicationloop.CommandPlanRecreate:
	default:
		return applicationloop.Result{}, ToolError{Code: "invalid_request"}
	}
	return tools.action(ctx, request, applicationloop.Command{Version: applicationloop.ContractVersion, Kind: kind, ProjectID: projectID, PlanID: planID})
}

func (tools *RuntimeTools) TaskAction(ctx context.Context, request ToolContext, kind applicationloop.CommandKind, projectID, planID, taskID int64, batches []applicationloop.TaskBatch) (applicationloop.Result, error) {
	switch kind {
	case applicationloop.CommandTaskRun, applicationloop.CommandTaskStop:
		return tools.action(ctx, request, applicationloop.Command{Version: applicationloop.ContractVersion, Kind: kind, ProjectID: projectID, PlanID: planID, TaskID: taskID})
	case applicationloop.CommandTaskRunBatches:
		return tools.action(ctx, request, applicationloop.Command{Version: applicationloop.ContractVersion, Kind: kind, ProjectID: projectID, PlanID: planID, Batches: append([]applicationloop.TaskBatch(nil), batches...)})
	default:
		return applicationloop.Result{}, ToolError{Code: "invalid_request"}
	}
}

func (tools *RuntimeTools) AcceptanceAction(ctx context.Context, request ToolContext, action, targetType string, projectID, targetID int64) (applicationloop.Result, error) {
	if targetID <= 0 || (targetType != "plan" && targetType != "task") {
		return applicationloop.Result{}, ToolError{Code: "invalid_request"}
	}
	kind := applicationloop.CommandKind("acceptance." + action)
	if action != "accept" && action != "unaccept" && action != "redo" {
		return applicationloop.Result{}, ToolError{Code: "invalid_request"}
	}
	command := applicationloop.Command{Version: applicationloop.ContractVersion, Kind: kind, ProjectID: projectID,
		Acceptance: &applicationloop.AcceptanceInput{Targets: []applicationloop.AcceptanceTarget{{TargetType: targetType, ID: targetID}}}}
	return tools.action(ctx, request, command)
}

func (tools *RuntimeTools) RetryIntakePlanGeneration(ctx context.Context, request ToolContext, projectID, intakeID int64, intakeType string) (applicationloop.Result, error) {
	if intakeType != "requirement" && intakeType != "feedback" {
		return applicationloop.Result{}, ToolError{Code: "invalid_request"}
	}
	return tools.action(ctx, request, applicationloop.Command{
		Version: applicationloop.ContractVersion, Kind: applicationloop.CommandKind("intake.retry_plan_generation"),
		ProjectID: projectID, IntakeID: intakeID, Action: intakeType,
	})
}

func (tools *RuntimeTools) action(ctx context.Context, request ToolContext, command applicationloop.Command) (applicationloop.Result, error) {
	return tools.Execute(ctx, command, request)
}

func runtimeIdempotencyKey(command applicationloop.Command) string {
	// No body/prompt or path is included: this fallback is only for the closed
	// resource identifiers carried by Command and is stable for MCP retries
	// using the same request_id.
	acceptance, _ := json.Marshal(command.Acceptance)
	material := strings.Join([]string{
		"autoplan-mcp-runtime-v1", command.CallerScope, command.RequestID,
		string(command.Kind), strconv.FormatInt(command.ProjectID, 10), strconv.FormatInt(command.PlanID, 10),
		strconv.FormatInt(command.TaskID, 10), strconv.FormatInt(command.IntakeID, 10), command.Action, string(acceptance),
	}, "\x00")
	sum := sha256.Sum256([]byte(material))
	return "mcp-" + hex.EncodeToString(sum[:20])
}

func mapRuntimeToolError(err error) error {
	switch {
	case err == nil:
		return nil
	case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded):
		return ToolError{Code: "request_timeout"}
	case errors.Is(err, applicationloop.ErrInvalidCommand), errors.Is(err, applicationloop.ErrUnsupportedCommand):
		return ToolError{Code: "invalid_request"}
	case errors.Is(err, applicationloop.ErrStateConflict):
		return ToolError{Code: "precondition_failed"}
	case errors.Is(err, applicationloop.ErrRuntimeBusy):
		return ToolError{Code: "precondition_failed"}
	case errors.Is(err, applicationloop.ErrCancelled):
		return ToolError{Code: "operation_cancelled"}
	case errors.Is(err, applicationloop.ErrUnavailable), errors.Is(err, applicationloop.ErrRuntimeUnavailable):
		return ToolError{Code: "service_unavailable"}
	case errors.Is(err, applicationloop.ErrProjectNotFound):
		return ToolError{Code: "not_found"}
	default:
		return ToolError{Code: "internal_error"}
	}
}
