package plans

import (
	"context"
	"encoding/json"
	"errors"
	"sort"
	"testing"
	"time"

	"github.com/lyming99/autoplan/backend/internal/domain/contracts"
	domainevent "github.com/lyming99/autoplan/backend/internal/domain/event"
	domainintake "github.com/lyming99/autoplan/backend/internal/domain/intake"
	domainplan "github.com/lyming99/autoplan/backend/internal/domain/plan"
	domainproject "github.com/lyming99/autoplan/backend/internal/domain/project"
	"github.com/lyming99/autoplan/backend/internal/repository"
)

const regressionTime = "2026-07-15T01:00:00.000Z"

type regressionClock struct{}

func (regressionClock) Now() time.Time {
	value, _ := time.Parse(time.RFC3339Nano, "2026-07-15T02:00:00.000Z")
	return value
}

type regressionState struct {
	plans      map[int64]domainplan.Plan
	tasks      map[int64]domainplan.Task
	intakes    map[string]domainintake.Intake
	links      map[string][]domainintake.PlanLink
	refs       map[int64][]domainintake.IntakeRef
	events     []domainevent.PendingEvent
	failIntake bool
}

func (state *regressionState) clone() *regressionState {
	copyState := &regressionState{
		plans: make(map[int64]domainplan.Plan, len(state.plans)), tasks: make(map[int64]domainplan.Task, len(state.tasks)),
		intakes: make(map[string]domainintake.Intake, len(state.intakes)), links: make(map[string][]domainintake.PlanLink, len(state.links)),
		refs: make(map[int64][]domainintake.IntakeRef, len(state.refs)), events: append([]domainevent.PendingEvent(nil), state.events...),
		failIntake: state.failIntake,
	}
	for key, value := range state.plans {
		copyState.plans[key] = value
	}
	for key, value := range state.tasks {
		copyState.tasks[key] = value
	}
	for key, value := range state.intakes {
		copyState.intakes[key] = value
	}
	for key, value := range state.links {
		copyState.links[key] = append([]domainintake.PlanLink(nil), value...)
	}
	for key, value := range state.refs {
		copyState.refs[key] = append([]domainintake.IntakeRef(nil), value...)
	}
	return copyState
}

type regressionWriter struct {
	repository.PlanTransactional
	state *regressionState
}

func (writer *regressionWriter) Check(context.Context) error { return nil }
func (writer *regressionWriter) Close() error                { return nil }
func (writer *regressionWriter) TransactPlans(ctx context.Context, apply func(repository.PlanWriteTransaction) error) error {
	working := writer.state.clone()
	if err := apply(&regressionTransaction{state: working}); err != nil {
		return err
	}
	writer.state = working
	return nil
}

type regressionTransaction struct {
	repository.PlanWriteTransaction
	state *regressionState
}

func (transaction *regressionTransaction) ListPlans(_ context.Context, options domainplan.ListOptions) ([]domainplan.Plan, error) {
	values := make([]domainplan.Plan, 0)
	for _, value := range transaction.state.plans {
		if value.ProjectID == options.ProjectID {
			values = append(values, value)
		}
	}
	sort.Slice(values, func(i, j int) bool { return values[i].ID < values[j].ID })
	start := options.Offset
	if start >= len(values) {
		return nil, nil
	}
	end := start + options.Limit
	if end > len(values) {
		end = len(values)
	}
	return values[start:end], nil
}

func (transaction *regressionTransaction) GetPlan(_ context.Context, projectID, planID int64) (domainplan.Plan, bool, error) {
	value, found := transaction.state.plans[planID]
	return value, found && value.ProjectID == projectID, nil
}

func (transaction *regressionTransaction) ListPlanTasks(_ context.Context, projectID, planID int64) ([]domainplan.Task, error) {
	values := make([]domainplan.Task, 0)
	for _, value := range transaction.state.tasks {
		if value.ProjectID == projectID && value.PlanID == planID {
			values = append(values, value)
		}
	}
	sort.Slice(values, func(i, j int) bool { return values[i].ID < values[j].ID })
	return values, nil
}

func (transaction *regressionTransaction) GetPlanTask(_ context.Context, projectID, planID, taskID int64) (domainplan.Task, bool, error) {
	value, found := transaction.state.tasks[taskID]
	return value, found && value.ProjectID == projectID && value.PlanID == planID, nil
}

func (transaction *regressionTransaction) SetPlanAcceptance(_ context.Context, update domainplan.AcceptanceUpdate) (domainplan.Plan, error) {
	value := transaction.state.plans[update.ID]
	value.AcceptedAt, value.UpdatedAt = copyString(update.AcceptedAt), update.UpdatedAt
	transaction.state.plans[value.ID] = value
	return value, nil
}

func (transaction *regressionTransaction) SetPlanTaskAcceptance(_ context.Context, update domainplan.AcceptanceUpdate) (domainplan.Task, error) {
	value := transaction.state.tasks[update.ID]
	value.AcceptedAt, value.UpdatedAt = copyString(update.AcceptedAt), update.UpdatedAt
	transaction.state.tasks[value.ID] = value
	return value, nil
}

func (transaction *regressionTransaction) RedoPlanTask(_ context.Context, redo domainplan.TaskRedo) (domainplan.Task, error) {
	task := transaction.state.tasks[redo.TaskID]
	task.Status, task.AcceptedAt, task.UpdatedAt = domainplan.TaskPending, nil, redo.UpdatedAt
	transaction.state.tasks[task.ID] = task
	plan := transaction.state.plans[redo.PlanID]
	plan.Status, plan.AcceptedAt, plan.ValidationPassed, plan.UpdatedAt = domainplan.StatusPending, nil, false, redo.UpdatedAt
	transaction.state.plans[plan.ID] = plan
	return task, nil
}

func (transaction *regressionTransaction) RedoPlan(_ context.Context, redo domainplan.PlanRedo) (domainplan.Plan, error) {
	plan := transaction.state.plans[redo.PlanID]
	plan.Status, plan.AcceptedAt, plan.ValidationPassed, plan.UpdatedAt = domainplan.StatusPending, nil, false, redo.UpdatedAt
	transaction.state.plans[plan.ID] = plan
	for id, task := range transaction.state.tasks {
		if task.ProjectID == redo.ProjectID && task.PlanID == redo.PlanID {
			task.Status, task.AcceptedAt, task.UpdatedAt = domainplan.TaskPending, nil, redo.UpdatedAt
			transaction.state.tasks[id] = task
		}
	}
	return plan, nil
}

func (transaction *regressionTransaction) AppendEvent(_ context.Context, event domainevent.PendingEvent) error {
	transaction.state.events = append(transaction.state.events, event)
	return nil
}

func (transaction *regressionTransaction) GetIntake(_ context.Context, projectID int64, intakeType domainintake.Type, intakeID int64) (domainintake.Intake, bool, error) {
	value, found := transaction.state.intakes[intakeKey(intakeType, intakeID)]
	return value, found && value.ProjectID == projectID, nil
}

func (transaction *regressionTransaction) ListPlanLinksForIntake(_ context.Context, projectID int64, intakeType domainintake.Type, intakeID int64) ([]domainintake.PlanLink, error) {
	values := transaction.state.links[intakeKey(intakeType, intakeID)]
	result := make([]domainintake.PlanLink, 0, len(values))
	for _, value := range values {
		if value.ProjectID == projectID {
			result = append(result, value)
		}
	}
	return result, nil
}

func (transaction *regressionTransaction) ListIntakesForPlan(_ context.Context, projectID, planID int64) ([]domainintake.IntakeRef, error) {
	result := make([]domainintake.IntakeRef, 0)
	for _, value := range transaction.state.refs[planID] {
		if value.ProjectID == projectID {
			result = append(result, value)
		}
	}
	return result, nil
}

func (transaction *regressionTransaction) SetIntakeAcceptance(_ context.Context, projectID int64, intakeType domainintake.Type, intakeID int64, acceptedAt *string, updatedAt string) (domainintake.Intake, error) {
	if transaction.state.failIntake {
		return domainintake.Intake{}, errors.New("synthetic intake write failure")
	}
	key := intakeKey(intakeType, intakeID)
	value := transaction.state.intakes[key]
	if value.ProjectID != projectID {
		return domainintake.Intake{}, repository.ErrNotFound
	}
	value.AcceptedAt, value.UpdatedAt = copyString(acceptedAt), updatedAt
	transaction.state.intakes[key] = value
	return value, nil
}

type regressionAssembler struct{ writer *regressionWriter }

func (assembler regressionAssembler) Assemble(_ context.Context, projectID *int64, _ domainproject.Visibility) (contracts.AppSnapshot, error) {
	snapshot := contracts.AppSnapshot{Requirements: []contracts.SanitizedObject{}, Feedback: []contracts.SanitizedObject{}}
	for _, intake := range assembler.writer.state.intakes {
		if projectID == nil || intake.ProjectID != *projectID {
			continue
		}
		accepted, _ := json.Marshal(intake.AcceptedAt)
		object := contracts.SanitizedObject{"accepted_at": accepted}
		if intake.Type == domainintake.Requirement {
			snapshot.Requirements = append(snapshot.Requirements, object)
		} else {
			snapshot.Feedback = append(snapshot.Feedback, object)
		}
	}
	return snapshot, nil
}

func intakeKey(intakeType domainintake.Type, intakeID int64) string {
	return string(intakeType) + ":" + decimal(intakeID)
}

func newRegressionService() (*Service, *regressionWriter) {
	state := &regressionState{
		plans: map[int64]domainplan.Plan{}, tasks: map[int64]domainplan.Task{}, intakes: map[string]domainintake.Intake{},
		links: map[string][]domainintake.PlanLink{}, refs: map[int64][]domainintake.IntakeRef{},
	}
	writer := &regressionWriter{state: state}
	return NewService(Dependencies{Writer: writer, Assembler: regressionAssembler{writer}, Clock: regressionClock{}}), writer
}

func addRegressionPlan(writer *regressionWriter, id, projectID int64) {
	writer.state.plans[id] = domainplan.Plan{ID: id, ProjectID: projectID, Status: domainplan.StatusCompleted, UpdatedAt: regressionTime}
}

func addRegressionIntake(writer *regressionWriter, intakeType domainintake.Type, id, projectID int64, planIDs ...int64) {
	key := intakeKey(intakeType, id)
	writer.state.intakes[key] = domainintake.Intake{ID: id, ProjectID: projectID, Type: intakeType, UpdatedAt: regressionTime}
	for index, planID := range planIDs {
		writer.state.links[key] = append(writer.state.links[key], domainintake.PlanLink{ProjectID: projectID, IntakeType: intakeType, IntakeID: id, PlanID: planID, PhaseIndex: int64(index + 1)})
		writer.state.refs[planID] = append(writer.state.refs[planID], domainintake.IntakeRef{ProjectID: projectID, IntakeType: intakeType, IntakeID: id})
	}
}

func runtimeTarget(targetType TargetType, id int64) AcceptanceTarget {
	return AcceptanceTarget{TargetType: targetType, ID: id}
}

func TestLinkedIntakeAcceptanceCoversPhasesBatchLegacyRedoAndSnapshot(t *testing.T) {
	ctx := context.Background()
	service, writer := newRegressionService()
	addRegressionPlan(writer, 1, 7)
	addRegressionPlan(writer, 2, 7)
	writer.state.tasks[11] = domainplan.Task{ID: 11, ProjectID: 7, PlanID: 1, Status: domainplan.TaskCompleted, UpdatedAt: regressionTime}
	addRegressionIntake(writer, domainintake.Requirement, 21, 7, 1, 2) // normalized multi-phase link
	addRegressionIntake(writer, domainintake.Feedback, 22, 7, 1)       // legacy link has the same repository contract
	addRegressionIntake(writer, domainintake.Requirement, 23, 8, 1)    // malformed cross-project reference must remain isolated

	_, err := service.SetRuntimeAcceptances(ctx, BatchAcceptanceCommand{ProjectID: 7, Accept: true, Targets: []AcceptanceTarget{runtimeTarget(TargetTask, 11)}}, domainproject.Visibility{})
	if err != nil || writer.state.intakes[intakeKey(domainintake.Requirement, 21)].AcceptedAt != nil {
		t.Fatalf("ordinary task acceptance changed intake: err=%v intake=%#v", err, writer.state.intakes[intakeKey(domainintake.Requirement, 21)])
	}
	if _, err = service.SetAcceptance(ctx, AcceptanceCommand{ProjectID: 7, Accept: true, Target: AcceptanceTarget{TargetType: TargetPlan, ID: 1, ExpectedUpdatedAt: regressionTime}}, domainproject.Visibility{}); err != nil {
		t.Fatal(err)
	}
	if writer.state.intakes[intakeKey(domainintake.Requirement, 21)].AcceptedAt != nil || writer.state.intakes[intakeKey(domainintake.Feedback, 22)].AcceptedAt == nil {
		t.Fatal("single phase accepted a multi-phase intake or legacy single-plan intake was not accepted")
	}
	result, err := service.SetRuntimeAcceptances(ctx, BatchAcceptanceCommand{ProjectID: 7, Accept: true, Targets: []AcceptanceTarget{runtimeTarget(TargetPlan, 2), runtimeTarget(TargetPlan, 2)}}, domainproject.Visibility{})
	if err != nil {
		t.Fatal(err)
	}
	if writer.state.intakes[intakeKey(domainintake.Requirement, 21)].AcceptedAt == nil {
		t.Fatal("all phases did not accept requirement")
	}
	if writer.state.intakes[intakeKey(domainintake.Requirement, 23)].AcceptedAt != nil {
		t.Fatal("cross-project intake changed")
	}
	if len(result.Snapshot.Requirements) == 0 || string(result.Snapshot.Requirements[0]["accepted_at"]) == "null" {
		t.Fatal("returned snapshot did not contain current intake acceptance")
	}

	acceptedEvents := 0
	for _, event := range writer.state.events {
		if event.Type == "requirement.accepted" {
			acceptedEvents++
		}
	}
	if _, err = service.SetRuntimeAcceptances(ctx, BatchAcceptanceCommand{ProjectID: 7, Accept: true, Targets: []AcceptanceTarget{runtimeTarget(TargetPlan, 2)}}, domainproject.Visibility{}); err != nil {
		t.Fatal(err)
	}
	for _, event := range writer.state.events {
		if event.Type == "requirement.accepted" {
			acceptedEvents--
		}
	}
	if acceptedEvents != 0 {
		t.Fatal("repeated acceptance emitted another derived event")
	}

	if _, err = service.SetRuntimeAcceptances(ctx, BatchAcceptanceCommand{ProjectID: 7, Accept: false, Targets: []AcceptanceTarget{runtimeTarget(TargetPlan, 1)}}, domainproject.Visibility{}); err != nil {
		t.Fatal(err)
	}
	if writer.state.intakes[intakeKey(domainintake.Requirement, 21)].AcceptedAt != nil || writer.state.intakes[intakeKey(domainintake.Feedback, 22)].AcceptedAt != nil {
		t.Fatal("plan unaccept did not clear linked intakes")
	}
	if _, err = service.SetRuntimeAcceptances(ctx, BatchAcceptanceCommand{ProjectID: 7, Accept: true, Targets: []AcceptanceTarget{runtimeTarget(TargetPlan, 1)}}, domainproject.Visibility{}); err != nil {
		t.Fatal(err)
	}
	if _, err = service.RedoRuntime(ctx, RedoCommand{ProjectID: 7, Target: runtimeTarget(TargetPlan, 1), Supplement: "plan regression"}, domainproject.Visibility{}); err != nil {
		t.Fatal(err)
	}
	if writer.state.intakes[intakeKey(domainintake.Requirement, 21)].AcceptedAt != nil || writer.state.intakes[intakeKey(domainintake.Feedback, 22)].AcceptedAt != nil {
		t.Fatal("plan redo did not clear linked intakes")
	}
	// Restore the plan/task to a completed state to exercise the task-redo path independently.
	plan := writer.state.plans[1]
	plan.Status = domainplan.StatusCompleted
	writer.state.plans[1] = plan
	task := writer.state.tasks[11]
	task.Status = domainplan.TaskCompleted
	writer.state.tasks[11] = task
	if _, err = service.SetRuntimeAcceptances(ctx, BatchAcceptanceCommand{ProjectID: 7, Accept: true, Targets: []AcceptanceTarget{runtimeTarget(TargetPlan, 1)}}, domainproject.Visibility{}); err != nil {
		t.Fatal(err)
	}

	if _, err = service.RedoRuntime(ctx, RedoCommand{ProjectID: 7, Target: runtimeTarget(TargetTask, 11), Supplement: "regression"}, domainproject.Visibility{}); err != nil {
		t.Fatal(err)
	}
	if writer.state.intakes[intakeKey(domainintake.Requirement, 21)].AcceptedAt != nil || writer.state.intakes[intakeKey(domainintake.Feedback, 22)].AcceptedAt != nil {
		t.Fatal("task redo did not clear linked intake acceptance")
	}
}

func TestLinkedIntakeAcceptanceTransactionFailureRollsEverythingBack(t *testing.T) {
	service, writer := newRegressionService()
	addRegressionPlan(writer, 1, 7)
	addRegressionIntake(writer, domainintake.Requirement, 21, 7, 1)
	writer.state.failIntake = true

	_, err := service.SetRuntimeAcceptances(context.Background(), BatchAcceptanceCommand{
		ProjectID: 7, Accept: true, Targets: []AcceptanceTarget{runtimeTarget(TargetPlan, 1)},
	}, domainproject.Visibility{})
	if err == nil {
		t.Fatal("synthetic transaction failure was accepted")
	}
	if writer.state.plans[1].AcceptedAt != nil || writer.state.intakes[intakeKey(domainintake.Requirement, 21)].AcceptedAt != nil || len(writer.state.events) != 0 {
		t.Fatalf("transaction partially committed: plan=%#v intake=%#v events=%d", writer.state.plans[1], writer.state.intakes[intakeKey(domainintake.Requirement, 21)], len(writer.state.events))
	}
}
