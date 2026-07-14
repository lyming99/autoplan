package intake

import (
	"context"
	"fmt"
	"strings"
	"unicode/utf8"

	applicationidempotency "github.com/lyming99/autoplan/backend/internal/application/idempotency"
	domainintake "github.com/lyming99/autoplan/backend/internal/domain/intake"
	domainproject "github.com/lyming99/autoplan/backend/internal/domain/project"
	"github.com/lyming99/autoplan/backend/internal/repository"
)

const (
	RouteInterruptPlans = "intake:interrupt-plans"
	RouteResumePlans    = "intake:resume-plans"
	RouteAppendTask     = "intake:append-task"
)

type PlanActionCommand struct {
	ProjectID int64
	Type      domainintake.Type
	ID        int64
	Title     string
	Metadata  MutationMetadata
}

func (service *Service) InterruptPlans(
	ctx context.Context,
	command PlanActionCommand,
	visibility domainproject.Visibility,
) (MutationResult, error) {
	return service.applyPlanAction(ctx, command, visibility, repository.IntakePlanInterrupt)
}

func (service *Service) ResumePlans(
	ctx context.Context,
	command PlanActionCommand,
	visibility domainproject.Visibility,
) (MutationResult, error) {
	return service.applyPlanAction(ctx, command, visibility, repository.IntakePlanResume)
}

func (service *Service) AppendTask(
	ctx context.Context,
	command PlanActionCommand,
	visibility domainproject.Visibility,
) (MutationResult, error) {
	return service.applyPlanAction(ctx, command, visibility, repository.IntakePlanAppend)
}

func (service *Service) applyPlanAction(
	ctx context.Context,
	command PlanActionCommand,
	visibility domainproject.Visibility,
	action repository.IntakePlanAction,
) (MutationResult, error) {
	if err := service.ready(ctx); err != nil {
		return MutationResult{}, err
	}
	command.Title = strings.Join(strings.Fields(command.Title), " ")
	if command.ProjectID <= 0 || command.ID <= 0 || !command.Type.Valid() ||
		(action == repository.IntakePlanAppend &&
			(command.Title == "" || utf8.RuneCountInString(command.Title) > 500 || strings.ContainsRune(command.Title, 0))) {
		return MutationResult{}, ErrInvalidCommand
	}
	route := intakePlanActionRoute(action)
	if route == "" {
		return MutationResult{}, ErrInvalidCommand
	}
	projectID := command.ProjectID
	occurredAt := formatTimestamp(service.now())
	prepared, err := service.idempotency.Prepare(applicationidempotency.Request{
		Scope: command.Metadata.CallerScope, Key: command.Metadata.IdempotencyKey,
		RequestID: command.Metadata.RequestID, Route: route, ProjectID: &projectID,
		Payload: struct {
			ProjectID int64
			Type      domainintake.Type
			ID        int64
			Action    repository.IntakePlanAction
			Title     string
		}{command.ProjectID, command.Type, command.ID, action, command.Title},
		OccurredAt: occurredAt,
	})
	if err != nil {
		return MutationResult{}, err
	}
	prepared = mutationPrepared(prepared, command.Metadata)
	reference := activeProjectReference(projectID)
	err = service.writer.TransactIntake(ctx, func(transaction repository.IntakeWriteTransaction) error {
		decision, beginErr := service.idempotency.Begin(ctx, transaction, prepared)
		if beginErr != nil {
			return beginErr
		}
		if decision.Replay {
			reference = decision.Reference
			return nil
		}
		actions, ok := transaction.(repository.IntakePlanActions)
		if !ok {
			return ErrUnavailable
		}
		result, actionErr := actions.ApplyIntakePlanAction(ctx, repository.IntakePlanActionInput{
			ProjectID: projectID, Type: command.Type, IntakeID: command.ID,
			Action: action, Title: command.Title, UpdatedAt: occurredAt,
		})
		if actionErr != nil {
			return actionErr
		}
		mutationAt := result.UpdatedAt
		if mutationAt == "" {
			mutationAt = occurredAt
		}
		eventType, message := intakePlanActionEvent(action, command, result)
		data := map[string]any{
			"action": action, "intake_type": command.Type, "intake_id": command.ID,
			"plan_ids": result.PlanIDs, "affected_plan_ids": result.AffectedPlanIDs,
			"affected_plans": len(result.AffectedPlanIDs), "affected_tasks": result.AffectedTasks,
		}
		if result.PlanID > 0 {
			data["plan_id"], data["task_id"], data["task_key"] = result.PlanID, result.TaskID, result.TaskKey
			data["reactivated"] = result.Reactivated
			data["title"] = command.Title
		}
		if eventErr := appendEvent(ctx, transaction, prepared, route, eventType,
			projectID, command.ID, command.Type, message, data, mutationAt); eventErr != nil {
			return eventErr
		}
		return service.idempotency.Complete(ctx, transaction, prepared, reference, mutationAt)
	})
	if err != nil {
		return MutationResult{}, err
	}
	return service.snapshotResult(ctx, reference, visibility, nil)
}

func intakePlanActionRoute(action repository.IntakePlanAction) string {
	switch action {
	case repository.IntakePlanInterrupt:
		return RouteInterruptPlans
	case repository.IntakePlanResume:
		return RouteResumePlans
	case repository.IntakePlanAppend:
		return RouteAppendTask
	default:
		return ""
	}
}

func intakePlanActionEvent(
	action repository.IntakePlanAction,
	command PlanActionCommand,
	result repository.IntakePlanActionResult,
) (string, string) {
	switch action {
	case repository.IntakePlanInterrupt:
		return "intake.plans.interrupted", fmt.Sprintf("%s #%d linked plans interrupted: %d/%d",
			command.Type, command.ID, len(result.AffectedPlanIDs), len(result.PlanIDs))
	case repository.IntakePlanResume:
		return "intake.plans.resumed", fmt.Sprintf("%s #%d linked plans resumed: %d/%d",
			command.Type, command.ID, len(result.AffectedPlanIDs), len(result.PlanIDs))
	default:
		return "intake.task.appended", fmt.Sprintf("%s #%d appended task %s to plan #%d",
			command.Type, command.ID, result.TaskKey, result.PlanID)
	}
}
