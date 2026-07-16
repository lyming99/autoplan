package plans

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"

	"github.com/lyming99/autoplan/backend/internal/application/capabilities"
	applicationloop "github.com/lyming99/autoplan/backend/internal/application/loop"
	applicationoperations "github.com/lyming99/autoplan/backend/internal/application/operations"
	domainoperation "github.com/lyming99/autoplan/backend/internal/domain/operation"
	domainplan "github.com/lyming99/autoplan/backend/internal/domain/plan"
	"github.com/lyming99/autoplan/backend/internal/repository"
)

type planStopCanceller interface {
	CancelPlanExecution(context.Context, int64, int64) (bool, error)
}

type RuntimeDependencies struct {
	Plans      *Service
	Operations *applicationoperations.Service
	Loop       planStopCanceller
}

// RuntimeHandler leaves the remaining plan actions on the shared dispatcher,
// but owns plan.stop natively with the Plan, Operation, and Loop services.
type RuntimeHandler struct {
	dispatcher applicationloop.Dispatcher
	plans      *Service
	operations *applicationoperations.Service
	loop       planStopCanceller
}

// Optional typed dependencies keep existing dispatcher-only construction
// compatible while bootstrap supplies the native plan.stop runtime.
func NewRuntimeHandler(dispatcher applicationloop.Dispatcher, dependencies ...RuntimeDependencies) *RuntimeHandler {
	handler := &RuntimeHandler{dispatcher: dispatcher}
	if len(dependencies) > 0 {
		handler.plans = dependencies[0].Plans
		handler.operations = dependencies[0].Operations
		handler.loop = dependencies[0].Loop
	}
	return handler
}

func (handler *RuntimeHandler) Commands() []applicationloop.CommandKind {
	return []applicationloop.CommandKind{
		applicationloop.CommandPlanGenerate, applicationloop.CommandPlanParse,
		applicationloop.CommandPlanRun, applicationloop.CommandPlanStop,
		applicationloop.CommandPlanResume, applicationloop.CommandPlanReexecute,
		applicationloop.CommandPlanRecreate, applicationloop.CommandPlanValidate,
	}
}

func (handler *RuntimeHandler) Execute(ctx context.Context, command applicationloop.Command) (applicationloop.Result, error) {
	switch command.Kind {
	case applicationloop.CommandPlanGenerate:
		if command.IntakeID <= 0 {
			return applicationloop.Result{}, applicationloop.ErrInvalidCommand
		}
	case applicationloop.CommandPlanStop:
		if err := validatePlanStopCommand(command); err != nil {
			return applicationloop.Result{}, err
		}
		return handler.stop(ctx, command)
	case applicationloop.CommandPlanParse, applicationloop.CommandPlanRun,
		applicationloop.CommandPlanResume, applicationloop.CommandPlanReexecute,
		applicationloop.CommandPlanRecreate, applicationloop.CommandPlanValidate:
		if err := applicationloop.RequirePlan(command); err != nil {
			return applicationloop.Result{}, err
		}
	default:
		return applicationloop.Result{}, applicationloop.ErrUnsupportedCommand
	}
	return applicationloop.Dispatch(ctx, handler.dispatcher, command)
}

func (handler *RuntimeHandler) stop(ctx context.Context, command applicationloop.Command) (applicationloop.Result, error) {
	if handler == nil || handler.plans == nil || handler.operations == nil ||
		!handler.operations.Configured() || handler.loop == nil {
		return applicationloop.Result{}, applicationloop.ErrUnavailable
	}
	digest := planStopDigest(command)
	caller := applicationoperations.Caller{ID: command.CallerScope, ProjectID: command.ProjectID}
	created, err := handler.operations.CreateOrReuse(ctx, applicationoperations.CreateCommand{
		Caller: caller, ProjectID: command.ProjectID, Type: string(command.Kind),
		IdempotencyKey: command.IdempotencyKey, RequestDigest: digest, RequestID: command.RequestID,
	})
	if err != nil {
		return applicationloop.Result{}, mapPlanStopOperationError(err)
	}
	if !created.Changed {
		return planStopOperationResult(created.Operation)
	}
	claimed, err := handler.operations.Claim(ctx, applicationoperations.ClaimCommand{
		Caller: caller, ProjectID: command.ProjectID, OperationID: created.Operation.OperationID,
		ExpectedVersion: created.Operation.Version, RequestDigest: digest, RequestID: command.RequestID,
	})
	if err != nil {
		handler.failStop(ctx, caller, created.Operation, command.RequestID)
		return applicationloop.Result{}, mapPlanStopOperationError(err)
	}
	if err = handler.plans.CheckStoppable(ctx, command.ProjectID, command.PlanID); err != nil {
		handler.failStop(ctx, caller, claimed.Operation, command.RequestID)
		return applicationloop.Result{}, mapPlanStopServiceError(err)
	}
	if _, err = handler.loop.CancelPlanExecution(ctx, command.ProjectID, command.PlanID); err != nil {
		handler.failStop(ctx, caller, claimed.Operation, command.RequestID)
		return applicationloop.Result{}, mapPlanStopCancelError(err)
	}
	stopped, err := handler.plans.Stop(ctx, StopCommand{
		ProjectID: command.ProjectID, PlanID: command.PlanID, RequestID: command.RequestID,
	})
	if err != nil {
		handler.failStop(ctx, caller, claimed.Operation, command.RequestID)
		return applicationloop.Result{}, mapPlanStopServiceError(err)
	}
	payload, err := json.Marshal(planStopOperationPayload(stopped))
	if err != nil {
		handler.failStop(ctx, caller, claimed.Operation, command.RequestID)
		return applicationloop.Result{}, applicationloop.ErrStateConflict
	}
	raw := json.RawMessage(payload)
	completed, err := handler.operations.Succeed(ctx, applicationoperations.CompleteCommand{
		Caller: caller, ProjectID: command.ProjectID, OperationID: claimed.Operation.OperationID,
		ExpectedVersion: claimed.Operation.Version, RequestID: command.RequestID, Result: &raw,
	})
	if err != nil {
		handler.failStop(ctx, caller, claimed.Operation, command.RequestID)
		return applicationloop.Result{}, mapPlanStopOperationError(err)
	}
	return planStopOperationResult(completed.Operation)
}

// Operation results cross a persistence and renderer boundary, so they carry
// only the committed state needed to correlate the later snapshot refresh.
// In particular, Plan.FilePath and task source text must never enter the
// Operation safe-JSON envelope.
func planStopOperationPayload(stopped StopResult) any {
	type stoppedTask struct {
		ID        int64                 `json:"id"`
		PlanID    int64                 `json:"plan_id"`
		ProjectID int64                 `json:"project_id"`
		Status    domainplan.TaskStatus `json:"status"`
		UpdatedAt string                `json:"updated_at"`
	}
	type stoppedPlan struct {
		ID        int64             `json:"id"`
		ProjectID int64             `json:"project_id"`
		Status    domainplan.Status `json:"status"`
		UpdatedAt string            `json:"updated_at"`
	}
	tasks := make([]stoppedTask, 0, len(stopped.AffectedTasks))
	for _, task := range stopped.AffectedTasks {
		tasks = append(tasks, stoppedTask{
			ID: task.ID, PlanID: task.PlanID, ProjectID: task.ProjectID,
			Status: task.Status, UpdatedAt: task.UpdatedAt,
		})
	}
	return struct {
		Plan          stoppedPlan   `json:"plan"`
		AffectedTasks []stoppedTask `json:"affected_tasks"`
	}{
		Plan: stoppedPlan{
			ID: stopped.Plan.ID, ProjectID: stopped.Plan.ProjectID,
			Status: stopped.Plan.Status, UpdatedAt: stopped.Plan.UpdatedAt,
		},
		AffectedTasks: tasks,
	}
}

func validatePlanStopCommand(command applicationloop.Command) error {
	if err := applicationloop.RequirePlan(command); err != nil {
		return err
	}
	if command.TaskID != 0 || command.IntakeID != 0 || command.ConversationID != 0 || command.ScriptID != 0 ||
		command.ExecutorID != 0 || command.ExpectedVersion != 0 || command.ExpectedUpdatedAt != "" || command.Action != "" ||
		command.Chat != nil || len(command.Batches) != 0 || command.Acceptance != nil || command.Terminal != nil || command.Updates != nil {
		return applicationloop.ErrInvalidCommand
	}
	return nil
}

func planStopDigest(command applicationloop.Command) string {
	payload, _ := json.Marshal(struct {
		Kind      applicationloop.CommandKind `json:"kind"`
		ProjectID int64                       `json:"project_id"`
		PlanID    int64                       `json:"plan_id"`
	}{command.Kind, command.ProjectID, command.PlanID})
	digest := sha256.Sum256(payload)
	return hex.EncodeToString(digest[:])
}

func (handler *RuntimeHandler) failStop(ctx context.Context, caller applicationoperations.Caller, operation domainoperation.Operation, requestID string) {
	_, _ = handler.operations.Fail(ctx, applicationoperations.FailCommand{
		Caller: caller, ProjectID: operation.ProjectID, OperationID: operation.OperationID,
		ExpectedVersion: operation.Version, RequestID: requestID,
		Code: "PLAN_STOP_FAILED", Summary: "Plan could not be stopped.",
	})
}

func planStopOperationResult(operation domainoperation.Operation) (applicationloop.Result, error) {
	status := string(operation.Status)
	switch operation.Status {
	case domainoperation.StatusSucceeded:
		status = "completed"
	case domainoperation.StatusCancelled:
		status = "cancelled"
	case domainoperation.StatusQueued, domainoperation.StatusRunning:
	default:
		return applicationloop.Result{}, applicationloop.ErrStateConflict
	}
	return applicationloop.Result{Operation: capabilities.OperationReference{
		OperationID: operation.OperationID, Type: operation.Type, Status: status,
		RequestID: operation.RequestID, AcceptedAt: operation.CreatedAt,
	}}, nil
}

func mapPlanStopOperationError(err error) error {
	switch {
	case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded):
		return err
	case errors.Is(err, applicationoperations.ErrUnavailable), errors.Is(err, repository.ErrNotConfigured),
		errors.Is(err, repository.ErrUnsafePath), errors.Is(err, repository.ErrInvalidStore),
		errors.Is(err, repository.ErrSourceChanged), errors.Is(err, repository.ErrClosed),
		errors.Is(err, repository.ErrWriterUnauthorized):
		return applicationloop.ErrRepositoryUnavailable
	case errors.Is(err, applicationoperations.ErrHandlerUnavailable):
		return applicationloop.ErrUnavailable
	case errors.Is(err, applicationoperations.ErrInvalidCommand), errors.Is(err, applicationoperations.ErrUnauthorized),
		errors.Is(err, applicationoperations.ErrIdempotencyConflict):
		return applicationloop.ErrInvalidCommand
	default:
		return applicationloop.ErrStateConflict
	}
}

func mapPlanStopServiceError(err error) error {
	switch {
	case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded):
		return err
	case errors.Is(err, repository.ErrNotFound):
		return applicationloop.ErrNotFound
	case errors.Is(err, ErrUnavailable), errors.Is(err, repository.ErrNotConfigured),
		errors.Is(err, repository.ErrUnsafePath), errors.Is(err, repository.ErrInvalidStore),
		errors.Is(err, repository.ErrSourceChanged), errors.Is(err, repository.ErrClosed),
		errors.Is(err, repository.ErrWriterUnauthorized):
		return applicationloop.ErrRepositoryUnavailable
	case errors.Is(err, ErrStateConflict), errors.Is(err, repository.ErrInvalidPlan),
		errors.Is(err, repository.ErrVersionConflict):
		return applicationloop.ErrStateConflict
	case errors.Is(err, ErrInvalidCommand):
		return applicationloop.ErrInvalidCommand
	default:
		return applicationloop.ErrStateConflict
	}
}

func mapPlanStopCancelError(err error) error {
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return err
	}
	return applicationloop.ErrCancellationFailed
}

type stopRecoveryHandler struct{}

func (stopRecoveryHandler) Type() string { return string(applicationloop.CommandPlanStop) }
func (stopRecoveryHandler) CanRecover(context.Context, domainoperation.Operation) (bool, error) {
	return false, nil
}

func RecoveryHandlers() []applicationoperations.RecoveryHandler {
	return []applicationoperations.RecoveryHandler{stopRecoveryHandler{}}
}

var _ applicationloop.Handler = (*RuntimeHandler)(nil)
var _ applicationoperations.RecoveryHandler = stopRecoveryHandler{}
