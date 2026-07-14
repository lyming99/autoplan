package intake

import (
	"context"
	"fmt"

	applicationidempotency "github.com/lyming99/autoplan/backend/internal/application/idempotency"
	domainintake "github.com/lyming99/autoplan/backend/internal/domain/intake"
	domainproject "github.com/lyming99/autoplan/backend/internal/domain/project"
	"github.com/lyming99/autoplan/backend/internal/repository"
)

const RouteRetryPlanGeneration = "intake:retry-plan-generation"

type RetryPlanGenerationCommand struct {
	ProjectID int64
	Type      domainintake.Type
	ID        int64
	Metadata  MutationMetadata
}

// RetryPlanGeneration clears only the bounded generation-failure state. The
// intake content and provider configuration remain unchanged, so the next
// loop cycle retries the same user request instead of creating a duplicate.
func (service *Service) RetryPlanGeneration(
	ctx context.Context,
	command RetryPlanGenerationCommand,
	visibility domainproject.Visibility,
) (MutationResult, error) {
	if err := service.ready(ctx); err != nil {
		return MutationResult{}, err
	}
	if command.ProjectID <= 0 || command.ID <= 0 || !command.Type.Valid() {
		return MutationResult{}, ErrInvalidCommand
	}
	now := service.now()
	projectID := command.ProjectID
	prepared, err := service.idempotency.Prepare(applicationidempotency.Request{
		Scope: command.Metadata.CallerScope, Key: command.Metadata.IdempotencyKey,
		RequestID: command.Metadata.RequestID, Route: RouteRetryPlanGeneration, ProjectID: &projectID,
		Payload: struct {
			ProjectID int64
			Type      domainintake.Type
			ID        int64
		}{command.ProjectID, command.Type, command.ID},
		OccurredAt: formatTimestamp(now),
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
		current, found, getErr := transaction.GetIntake(ctx, projectID, command.Type, command.ID)
		if getErr != nil {
			return getErr
		}
		if !found {
			return repository.ErrNotFound
		}
		mutationAt := nextTimestamp(now, current.UpdatedAt)
		updated, updateErr := transaction.UpdateIntake(ctx, projectID, command.Type, command.ID, domainintake.Update{
			RequirementID: current.RequirementID, Title: current.Title, Body: current.Body, Status: current.Status,
			AgentCLI: current.AgentCLI, PlanGeneration: current.PlanGeneration, Failure: domainintake.GenerationFailure{},
			AcceptedAt: current.AcceptedAt, SessionID: current.SessionID, UpdatedAt: mutationAt,
		})
		if updateErr != nil {
			return updateErr
		}
		if eventErr := appendEvent(ctx, transaction, prepared, RouteRetryPlanGeneration,
			"plan.generate.retry.requested", projectID, updated.ID, updated.Type,
			fmt.Sprintf("%s #%d plan generation retry requested", updated.Type, updated.ID),
			map[string]any{"intake_type": updated.Type, "intake_id": updated.ID}, mutationAt); eventErr != nil {
			return eventErr
		}
		return service.idempotency.Complete(ctx, transaction, prepared, reference, mutationAt)
	})
	if err != nil {
		return MutationResult{}, err
	}
	return service.snapshotResult(ctx, reference, visibility, nil)
}
