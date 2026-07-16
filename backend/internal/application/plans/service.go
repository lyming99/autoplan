package plans

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/lyming99/autoplan/backend/internal/domain/contracts"
	domainevent "github.com/lyming99/autoplan/backend/internal/domain/event"
	domainintake "github.com/lyming99/autoplan/backend/internal/domain/intake"
	domainplan "github.com/lyming99/autoplan/backend/internal/domain/plan"
	domainproject "github.com/lyming99/autoplan/backend/internal/domain/project"
	"github.com/lyming99/autoplan/backend/internal/repository"
)

var (
	ErrUnavailable    = errors.New("plan application service unavailable")
	ErrInvalidCommand = errors.New("plan command is invalid")
	ErrStateConflict  = errors.New("plan state conflicts")
	ErrProtected      = errors.New("plan deletion is protected")
)

type Clock interface{ Now() time.Time }

type systemClock struct{}

func (systemClock) Now() time.Time { return time.Now().UTC() }

// SnapshotAssembler is intentionally narrow: plans do not depend on the
// snapshot implementation, only on the post-commit projection it provides.
type SnapshotAssembler interface {
	Assemble(context.Context, *int64, domainproject.Visibility) (contracts.AppSnapshot, error)
}

type Dependencies struct {
	Assembler SnapshotAssembler
	Writer    repository.PlanTransactional
	Clock     Clock
}

type Service struct {
	assembler SnapshotAssembler
	writer    repository.PlanTransactional
	clock     Clock
}

func NewService(dependencies Dependencies) *Service {
	clock := dependencies.Clock
	if clock == nil {
		clock = systemClock{}
	}
	return &Service{assembler: dependencies.Assembler, writer: dependencies.Writer, clock: clock}
}

func (service *Service) ready(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if service == nil || service.assembler == nil || service.writer == nil || service.clock == nil {
		return ErrUnavailable
	}
	return service.writer.Check(ctx)
}

func (service *Service) snapshot(ctx context.Context, projectID int64, visibility domainproject.Visibility) (contracts.AppSnapshot, error) {
	if projectID <= 0 {
		return contracts.AppSnapshot{}, ErrInvalidCommand
	}
	return service.assembler.Assemble(ctx, &projectID, visibility)
}

const (
	RouteAccept   = "plans:accept"
	RouteUnaccept = "plans:unaccept"
	RouteRedo     = "plans:redo"
)

type AcceptanceCommand struct {
	ProjectID int64
	Target    AcceptanceTarget
	Accept    bool
	RequestID string
}

type BatchAcceptanceCommand struct {
	ProjectID int64
	Targets   []AcceptanceTarget
	Accept    bool
	RequestID string
}

type RedoCommand struct {
	ProjectID             int64
	Target                AcceptanceTarget
	ExpectedTaskUpdatedAt map[int64]string
	Supplement            string
	RequestID             string
}

func (service *Service) SetAcceptance(
	ctx context.Context,
	command AcceptanceCommand,
	visibility domainproject.Visibility,
) (MutationResult, error) {
	return service.SetAcceptances(ctx, BatchAcceptanceCommand{
		ProjectID: command.ProjectID, Targets: []AcceptanceTarget{command.Target},
		Accept: command.Accept, RequestID: command.RequestID,
	}, visibility)
}

// SetAcceptances preloads and validates every target before issuing the first
// write. All target updates and their audit events are then committed or
// rolled back by one Plan transaction.
func (service *Service) SetAcceptances(
	ctx context.Context,
	command BatchAcceptanceCommand,
	visibility domainproject.Visibility,
) (MutationResult, error) {
	return service.setAcceptances(ctx, command, visibility, true)
}

// SetRuntimeAcceptances resolves target versions inside the same transaction
// that performs the writes. Runtime callers intentionally provide resource
// identifiers only, while the persistence API above retains its explicit
// optimistic-concurrency contract.
func (service *Service) SetRuntimeAcceptances(
	ctx context.Context,
	command BatchAcceptanceCommand,
	visibility domainproject.Visibility,
) (MutationResult, error) {
	return service.setAcceptances(ctx, command, visibility, false)
}

func (service *Service) setAcceptances(
	ctx context.Context,
	command BatchAcceptanceCommand,
	visibility domainproject.Visibility,
	requireExpectedVersion bool,
) (MutationResult, error) {
	if err := service.ready(ctx); err != nil {
		return MutationResult{}, err
	}
	targets, err := normalizeAcceptanceTargetsForMutation(command.Targets, requireExpectedVersion)
	if err != nil || command.ProjectID <= 0 {
		return MutationResult{}, ErrInvalidCommand
	}
	route := RouteUnaccept
	if command.Accept {
		route = RouteAccept
	}
	items := make([]AcceptanceResult, 0, len(targets))
	err = service.writer.TransactPlans(ctx, func(transaction repository.PlanWriteTransaction) error {
		graph, graphErr := loadPlanGraph(ctx, transaction, command.ProjectID)
		if graphErr != nil {
			return graphErr
		}
		resolved := make([]resolvedTarget, 0, len(targets))
		clockInputs := make([]string, 0, len(targets))
		for _, target := range targets {
			if !requireExpectedVersion {
				target, graphErr = graph.withCurrentVersion(target)
				if graphErr != nil {
					return graphErr
				}
			}
			item, resolveErr := graph.resolve(target)
			if resolveErr != nil {
				return resolveErr
			}
			resolved = append(resolved, item)
			clockInputs = append(clockInputs, item.updatedAt())
		}
		mutationAt := nextMutationTimestamp(service.clock.Now(), clockInputs)
		for _, item := range resolved {
			var acceptedAt *string
			if command.Accept {
				value := mutationAt
				acceptedAt = &value
			}
			var result AcceptanceResult
			if item.target.TargetType == TargetPlan {
				updated, updateErr := transaction.SetPlanAcceptance(ctx, domainplan.AcceptanceUpdate{
					ProjectID: command.ProjectID, ID: item.plan.ID, AcceptedAt: acceptedAt,
					ExpectedUpdatedAt: item.plan.UpdatedAt, UpdatedAt: mutationAt,
				})
				if updateErr != nil {
					return updateErr
				}
				result = AcceptanceResult{TargetType: TargetPlan, ID: updated.ID, PlanID: updated.ID,
					AcceptedAt: copyString(updated.AcceptedAt), Status: string(updated.Status)}
			} else {
				updated, updateErr := transaction.SetPlanTaskAcceptance(ctx, domainplan.AcceptanceUpdate{
					ProjectID: command.ProjectID, ID: item.task.ID, AcceptedAt: acceptedAt,
					ExpectedUpdatedAt: item.task.UpdatedAt, UpdatedAt: mutationAt,
				})
				if updateErr != nil {
					return updateErr
				}
				result = AcceptanceResult{TargetType: TargetTask, ID: updated.ID, PlanID: updated.PlanID,
					AcceptedAt: copyString(updated.AcceptedAt), Status: string(updated.Status)}
			}
			eventType := string(result.TargetType) + ".unaccepted"
			if command.Accept {
				eventType = string(result.TargetType) + ".accepted"
			}
			if eventErr := appendPlanEvent(ctx, transaction, route, command.RequestID, command.ProjectID,
				result.TargetType, result.ID, eventType,
				fmt.Sprintf("%s #%d acceptance updated", result.TargetType, result.ID),
				map[string]any{
					"target_type": result.TargetType, "id": result.ID, "plan_id": result.PlanID,
					"accepted_at": result.AcceptedAt, "previous_accepted_at": item.acceptedAt(),
				}, mutationAt); eventErr != nil {
				return eventErr
			}
			items = append(items, result)
		}
		planIDs := make([]int64, 0, len(resolved))
		for _, item := range resolved {
			if item.target.TargetType == TargetPlan {
				planIDs = append(planIDs, item.plan.ID)
			}
		}
		return syncLinkedIntakeAcceptance(ctx, transaction, command.ProjectID, planIDs,
			mutationAt, route, command.RequestID)
	})
	if err != nil {
		return MutationResult{}, mapMutationError(err)
	}
	snapshot, err := service.snapshot(ctx, command.ProjectID, visibility)
	if err != nil {
		return MutationResult{}, err
	}
	return MutationResult{Snapshot: snapshot, Items: items}, nil
}

func (service *Service) Redo(
	ctx context.Context,
	command RedoCommand,
	visibility domainproject.Visibility,
) (MutationResult, error) {
	return service.redo(ctx, command, visibility, true)
}

// RedoRuntime is the identifier-only runtime variant of Redo. All current
// plan/task versions are captured inside the write transaction before the
// state transition, so it cannot apply a partially stale target graph.
func (service *Service) RedoRuntime(
	ctx context.Context,
	command RedoCommand,
	visibility domainproject.Visibility,
) (MutationResult, error) {
	return service.redo(ctx, command, visibility, false)
}

func (service *Service) redo(
	ctx context.Context,
	command RedoCommand,
	visibility domainproject.Visibility,
	requireExpectedVersion bool,
) (MutationResult, error) {
	if err := service.ready(ctx); err != nil {
		return MutationResult{}, err
	}
	if command.ProjectID <= 0 || (requireExpectedVersion && !validTarget(command.Target)) ||
		(!requireExpectedVersion && !validTargetSelector(command.Target)) {
		return MutationResult{}, ErrInvalidCommand
	}
	command.Supplement = domainplan.NormalizeSupplement(command.Supplement)
	items := make([]AcceptanceResult, 0, 1)
	err := service.writer.TransactPlans(ctx, func(transaction repository.PlanWriteTransaction) error {
		graph, graphErr := loadPlanGraph(ctx, transaction, command.ProjectID)
		if graphErr != nil {
			return graphErr
		}
		target := command.Target
		if !requireExpectedVersion {
			target, graphErr = graph.withCurrentVersion(target)
			if graphErr != nil {
				return graphErr
			}
		}
		resolved, resolveErr := graph.resolve(target)
		if resolveErr != nil {
			return resolveErr
		}
		if resolved.target.TargetType == TargetPlan {
			expectedTaskUpdatedAt := command.ExpectedTaskUpdatedAt
			if requireExpectedVersion {
				if len(expectedTaskUpdatedAt) != len(graph.tasksByPlan[resolved.plan.ID]) {
					return ErrStateConflict
				}
				for _, task := range graph.tasksByPlan[resolved.plan.ID] {
					if expectedTaskUpdatedAt[task.ID] != task.UpdatedAt {
						return ErrStateConflict
					}
				}
			} else {
				expectedTaskUpdatedAt = make(map[int64]string, len(graph.tasksByPlan[resolved.plan.ID]))
				for _, task := range graph.tasksByPlan[resolved.plan.ID] {
					expectedTaskUpdatedAt[task.ID] = task.UpdatedAt
				}
			}
			mutationAt := nextMutationTimestamp(service.clock.Now(), append([]string{resolved.plan.UpdatedAt}, graph.taskTimes(resolved.plan.ID)...))
			updated, updateErr := transaction.RedoPlan(ctx, domainplan.PlanRedo{
				ProjectID: command.ProjectID, PlanID: resolved.plan.ID,
				ExpectedPlanUpdatedAt: resolved.plan.UpdatedAt,
				ExpectedTaskUpdatedAt: copyUpdatedAt(expectedTaskUpdatedAt),
				UpdatedAt:             mutationAt, Supplement: command.Supplement,
			})
			if updateErr != nil {
				return updateErr
			}
			result := AcceptanceResult{TargetType: TargetPlan, ID: updated.ID, PlanID: updated.ID,
				AcceptedAt: copyString(updated.AcceptedAt), Status: string(updated.Status)}
			if eventErr := appendPlanEvent(ctx, transaction, RouteRedo, command.RequestID, command.ProjectID,
				TargetPlan, updated.ID, "plan.redo", fmt.Sprintf("plan #%d returned for redo", updated.ID),
				map[string]any{
					"target_type": TargetPlan, "id": updated.ID, "plan_id": updated.ID,
					"previous_status": resolved.plan.Status, "previous_accepted_at": resolved.plan.AcceptedAt,
					"has_supplement": command.Supplement != "",
				}, mutationAt); eventErr != nil {
				return eventErr
			}
			items = append(items, result)
			return syncLinkedIntakeAcceptance(ctx, transaction, command.ProjectID, []int64{updated.ID},
				mutationAt, RouteRedo, command.RequestID)
		}
		if requireExpectedVersion && (!domainplan.ValidUTCTimestamp(command.Target.ExpectedPlanUpdatedAt) ||
			command.Target.ExpectedPlanUpdatedAt != resolved.plan.UpdatedAt) {
			return ErrStateConflict
		}
		mutationAt := nextMutationTimestamp(service.clock.Now(), []string{resolved.plan.UpdatedAt, resolved.task.UpdatedAt})
		updated, updateErr := transaction.RedoPlanTask(ctx, domainplan.TaskRedo{
			ProjectID: command.ProjectID, PlanID: resolved.plan.ID, TaskID: resolved.task.ID,
			ExpectedPlanUpdatedAt: resolved.plan.UpdatedAt, ExpectedTaskUpdatedAt: resolved.task.UpdatedAt,
			UpdatedAt: mutationAt, Supplement: command.Supplement,
		})
		if updateErr != nil {
			return updateErr
		}
		result := AcceptanceResult{TargetType: TargetTask, ID: updated.ID, PlanID: updated.PlanID,
			AcceptedAt: copyString(updated.AcceptedAt), Status: string(updated.Status)}
		if eventErr := appendPlanEvent(ctx, transaction, RouteRedo, command.RequestID, command.ProjectID,
			TargetTask, updated.ID, "task.redo", fmt.Sprintf("task #%d returned for redo", updated.ID),
			map[string]any{
				"target_type": TargetTask, "id": updated.ID, "task_id": updated.ID, "plan_id": updated.PlanID,
				"previous_status": resolved.task.Status, "previous_accepted_at": resolved.task.AcceptedAt,
				"has_supplement": command.Supplement != "",
			}, mutationAt); eventErr != nil {
			return eventErr
		}
		items = append(items, result)
		return syncLinkedIntakeAcceptance(ctx, transaction, command.ProjectID, []int64{updated.PlanID},
			mutationAt, RouteRedo, command.RequestID)
	})
	if err != nil {
		return MutationResult{}, mapMutationError(err)
	}
	snapshot, err := service.snapshot(ctx, command.ProjectID, visibility)
	if err != nil {
		return MutationResult{}, err
	}
	return MutationResult{Snapshot: snapshot, Items: items}, nil
}

// syncLinkedIntakeAcceptance derives intake acceptance exclusively from all
// linked plans. It runs after every plan mutation in the batch, while still
// inside the plan transaction, so multi-phase intake state is never computed
// from an intermediate batch state. Task acceptance is intentionally absent;
// only redo of a task participates because it also invalidates its parent plan.
func syncLinkedIntakeAcceptance(
	ctx context.Context,
	transaction repository.PlanWriteTransaction,
	projectID int64,
	planIDs []int64,
	mutationAt, route, requestID string,
) error {
	uniquePlans := make(map[int64]struct{}, len(planIDs))
	references := make(map[string]domainintake.IntakeRef)
	for _, planID := range planIDs {
		if planID <= 0 {
			continue
		}
		if _, duplicate := uniquePlans[planID]; duplicate {
			continue
		}
		uniquePlans[planID] = struct{}{}
		linked, err := transaction.ListIntakesForPlan(ctx, projectID, planID)
		if err != nil {
			return err
		}
		for _, reference := range linked {
			if reference.ProjectID != projectID || !reference.IntakeType.Valid() || reference.IntakeID <= 0 {
				return repository.ErrInvalidStore
			}
			key := string(reference.IntakeType) + ":" + decimal(reference.IntakeID)
			references[key] = reference
		}
	}
	keys := make([]string, 0, len(references))
	for key := range references {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		reference := references[key]
		current, found, err := transaction.GetIntake(ctx, projectID, reference.IntakeType, reference.IntakeID)
		if err != nil {
			return err
		}
		if !found {
			return repository.ErrInvalidStore
		}
		links, err := transaction.ListPlanLinksForIntake(ctx, projectID, reference.IntakeType, reference.IntakeID)
		if err != nil {
			return err
		}
		if len(links) == 0 {
			continue
		}
		allAccepted := true
		for _, link := range links {
			plan, exists, getErr := transaction.GetPlan(ctx, projectID, link.PlanID)
			if getErr != nil {
				return getErr
			}
			if !exists {
				return repository.ErrInvalidStore
			}
			if plan.AcceptedAt == nil {
				allAccepted = false
			}
		}
		if allAccepted == (current.AcceptedAt != nil) {
			continue
		}
		var acceptedAt *string
		if allAccepted {
			value := mutationAt
			acceptedAt = &value
		}
		updated, err := transaction.SetIntakeAcceptance(ctx, projectID, reference.IntakeType,
			reference.IntakeID, acceptedAt, mutationAt)
		if err != nil {
			return err
		}
		if err := appendLinkedIntakeEvent(ctx, transaction, route, requestID, updated,
			current.AcceptedAt, mutationAt); err != nil {
			return err
		}
	}
	return nil
}

func appendLinkedIntakeEvent(
	ctx context.Context,
	transaction repository.PlanWriteTransaction,
	route, requestID string,
	updated domainintake.Intake,
	previousAcceptedAt *string,
	occurredAt string,
) error {
	requestID = strings.TrimSpace(requestID)
	if requestID == "" {
		requestID = "local-plan-mutation"
	}
	data, err := json.Marshal(map[string]any{
		"intake_type": updated.Type, "intake_id": updated.ID,
		"accepted_at": updated.AcceptedAt, "previous_accepted_at": previousAcceptedAt,
	})
	if err != nil {
		return ErrInvalidCommand
	}
	eventType := string(updated.Type) + ".unaccepted"
	if updated.AcceptedAt != nil {
		eventType = string(updated.Type) + ".accepted"
	}
	eventID, sequence := planEventIdentity(route, requestID, updated.ProjectID,
		string(updated.Type), updated.ID, occurredAt)
	metadata := string(data)
	return transaction.AppendEvent(ctx, domainevent.PendingEvent{
		EventID: eventID, StreamKey: fmt.Sprintf("project:%d:intake:%s:%d", updated.ProjectID, updated.Type, updated.ID),
		Sequence: sequence, Type: eventType, RequestID: requestID, ProjectID: updated.ProjectID,
		Message: fmt.Sprintf("%s #%d acceptance updated", updated.Type, updated.ID), MetaJSON: &metadata,
		OccurredAt: occurredAt, CreatedAt: occurredAt,
	})
}

type planGraph struct {
	plans       []domainplan.Plan
	planByID    map[int64]domainplan.Plan
	tasksByPlan map[int64][]domainplan.Task
	taskByID    map[int64]domainplan.Task
}

func loadPlanGraph(ctx context.Context, transaction repository.PlanWriteTransaction, projectID int64) (planGraph, error) {
	graph := planGraph{
		plans: make([]domainplan.Plan, 0), planByID: make(map[int64]domainplan.Plan),
		tasksByPlan: make(map[int64][]domainplan.Task), taskByID: make(map[int64]domainplan.Task),
	}
	const pageSize = 200
	for offset := 0; ; offset += pageSize {
		page, err := transaction.ListPlans(ctx, domainplan.ListOptions{ProjectID: projectID, Limit: pageSize, Offset: offset})
		if err != nil {
			return planGraph{}, err
		}
		for _, plan := range page {
			if _, duplicate := graph.planByID[plan.ID]; duplicate {
				return planGraph{}, repository.ErrInvalidStore
			}
			graph.plans = append(graph.plans, plan)
			graph.planByID[plan.ID] = plan
		}
		if len(page) < pageSize {
			break
		}
	}
	for _, plan := range graph.plans {
		tasks, err := transaction.ListPlanTasks(ctx, projectID, plan.ID)
		if err != nil {
			return planGraph{}, err
		}
		graph.tasksByPlan[plan.ID] = append([]domainplan.Task(nil), tasks...)
		for _, task := range tasks {
			if task.PlanID != plan.ID {
				return planGraph{}, repository.ErrInvalidStore
			}
			if _, duplicate := graph.taskByID[task.ID]; duplicate {
				return planGraph{}, repository.ErrInvalidStore
			}
			graph.taskByID[task.ID] = task
		}
	}
	return graph, nil
}

type resolvedTarget struct {
	target AcceptanceTarget
	plan   domainplan.Plan
	task   domainplan.Task
}

func (graph planGraph) withCurrentVersion(target AcceptanceTarget) (AcceptanceTarget, error) {
	if !validTargetSelector(target) {
		return AcceptanceTarget{}, ErrInvalidCommand
	}
	if target.TargetType == TargetPlan {
		plan, exists := graph.planByID[target.ID]
		if !exists {
			return AcceptanceTarget{}, repository.ErrNotFound
		}
		target.ExpectedUpdatedAt = plan.UpdatedAt
		return target, nil
	}
	task, exists := graph.taskByID[target.ID]
	if !exists {
		return AcceptanceTarget{}, repository.ErrNotFound
	}
	plan, exists := graph.planByID[task.PlanID]
	if !exists {
		return AcceptanceTarget{}, repository.ErrInvalidStore
	}
	target.ExpectedUpdatedAt = task.UpdatedAt
	target.ExpectedPlanUpdatedAt = plan.UpdatedAt
	return target, nil
}

func (graph planGraph) resolve(target AcceptanceTarget) (resolvedTarget, error) {
	if !validTarget(target) {
		return resolvedTarget{}, ErrInvalidCommand
	}
	if target.TargetType == TargetPlan {
		plan, exists := graph.planByID[target.ID]
		if !exists {
			return resolvedTarget{}, repository.ErrNotFound
		}
		if plan.UpdatedAt != target.ExpectedUpdatedAt {
			return resolvedTarget{}, repository.ErrVersionConflict
		}
		return resolvedTarget{target: target, plan: plan}, nil
	}
	task, exists := graph.taskByID[target.ID]
	if !exists {
		return resolvedTarget{}, repository.ErrNotFound
	}
	if task.UpdatedAt != target.ExpectedUpdatedAt {
		return resolvedTarget{}, repository.ErrVersionConflict
	}
	plan, exists := graph.planByID[task.PlanID]
	if !exists {
		return resolvedTarget{}, repository.ErrInvalidStore
	}
	return resolvedTarget{target: target, plan: plan, task: task}, nil
}

func (target resolvedTarget) updatedAt() string {
	if target.target.TargetType == TargetPlan {
		return target.plan.UpdatedAt
	}
	return target.task.UpdatedAt
}

func (target resolvedTarget) acceptedAt() *string {
	if target.target.TargetType == TargetPlan {
		return copyString(target.plan.AcceptedAt)
	}
	return copyString(target.task.AcceptedAt)
}

func (graph planGraph) planTimes() []string {
	result := make([]string, 0, len(graph.plans))
	for _, plan := range graph.plans {
		result = append(result, plan.UpdatedAt)
	}
	return result
}

func (graph planGraph) taskTimes(planID int64) []string {
	tasks := graph.tasksByPlan[planID]
	result := make([]string, 0, len(tasks))
	for _, task := range tasks {
		result = append(result, task.UpdatedAt)
	}
	return result
}

func normalizeAcceptanceTargets(values []AcceptanceTarget) ([]AcceptanceTarget, error) {
	return normalizeAcceptanceTargetsForMutation(values, true)
}

func normalizeAcceptanceTargetsForMutation(values []AcceptanceTarget, requireExpectedVersion bool) ([]AcceptanceTarget, error) {
	if len(values) == 0 {
		return nil, ErrInvalidCommand
	}
	result := make([]AcceptanceTarget, 0, len(values))
	seen := make(map[string]struct{}, len(values))
	for _, value := range values {
		if (!requireExpectedVersion && !validTargetSelector(value)) || (requireExpectedVersion && !validTarget(value)) {
			return nil, ErrInvalidCommand
		}
		key := string(value.TargetType) + ":" + decimal(value.ID)
		if _, duplicate := seen[key]; duplicate {
			continue
		}
		seen[key] = struct{}{}
		result = append(result, value)
	}
	if len(result) == 0 {
		return nil, ErrInvalidCommand
	}
	return result, nil
}

func validTarget(value AcceptanceTarget) bool {
	return value.TargetType.Valid() && value.ID > 0 && domainplan.ValidUTCTimestamp(value.ExpectedUpdatedAt)
}

func validTargetSelector(value AcceptanceTarget) bool {
	return value.TargetType.Valid() && value.ID > 0 && value.ExpectedUpdatedAt == "" && value.ExpectedPlanUpdatedAt == ""
}

func nextMutationTimestamp(now time.Time, current []string) string {
	next := now.UTC().Truncate(time.Millisecond)
	for _, value := range current {
		parsed, err := time.Parse(time.RFC3339Nano, value)
		if err == nil && !next.After(parsed) {
			next = parsed.UTC().Truncate(time.Millisecond).Add(time.Millisecond)
		}
	}
	return next.Format("2006-01-02T15:04:05.000Z")
}

func appendPlanEvent(
	ctx context.Context,
	transaction repository.PlanWriteTransaction,
	route, requestID string,
	projectID int64,
	targetType TargetType,
	targetID int64,
	eventType, message string,
	data map[string]any,
	occurredAt string,
) error {
	requestID = strings.TrimSpace(requestID)
	if requestID == "" {
		requestID = "local-plan-mutation"
	}
	if len(requestID) > 256 || strings.ContainsAny(requestID, "\r\n\x00") {
		return ErrInvalidCommand
	}
	encoded, err := json.Marshal(data)
	if err != nil {
		return ErrInvalidCommand
	}
	metadata := string(encoded)
	eventID, sequence := planEventIdentity(route, requestID, projectID, string(targetType), targetID, occurredAt)
	return transaction.AppendEvent(ctx, domainevent.PendingEvent{
		EventID: eventID, StreamKey: fmt.Sprintf("project:%d:plan:%s:%d", projectID, targetType, targetID),
		Sequence: sequence, Type: eventType, RequestID: requestID, ProjectID: projectID,
		Message: message, MetaJSON: &metadata, OccurredAt: occurredAt, CreatedAt: occurredAt,
	})
}

func planEventIdentity(route, requestID string, projectID int64, targetType string, targetID int64, occurredAt string) (string, int64) {
	digest := sha256.Sum256([]byte(fmt.Sprintf("p07\x00%s\x00%s\x00%d\x00%s\x00%d\x00%s", route, requestID, projectID, targetType, targetID, occurredAt)))
	sequence := int64(0)
	for index := 0; index < 7; index++ {
		sequence = (sequence << 8) | int64(digest[index])
	}
	return "evt-" + hex.EncodeToString(digest[:16]), sequence
}

func copyUpdatedAt(source map[int64]string) map[int64]string {
	result := make(map[int64]string, len(source))
	for id, updatedAt := range source {
		result[id] = updatedAt
	}
	return result
}

func mapMutationError(err error) error {
	switch {
	case err == nil:
		return nil
	case errors.Is(err, ErrStateConflict), errors.Is(err, repository.ErrVersionConflict):
		return fmt.Errorf("%w: %w", ErrStateConflict, err)
	case errors.Is(err, repository.ErrRelationConflict):
		return fmt.Errorf("%w: %w", ErrProtected, err)
	case errors.Is(err, repository.ErrInvalidPlan), errors.Is(err, repository.ErrInvalidTask),
		errors.Is(err, repository.ErrInvalidEvent), errors.Is(err, repository.ErrPlanOrderConflict):
		return fmt.Errorf("%w: %w", ErrInvalidCommand, err)
	default:
		return err
	}
}
