package plans

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/lyming99/autoplan/backend/internal/domain/contracts"
	domainevent "github.com/lyming99/autoplan/backend/internal/domain/event"
	domainplan "github.com/lyming99/autoplan/backend/internal/domain/plan"
	domainproject "github.com/lyming99/autoplan/backend/internal/domain/project"
	"github.com/lyming99/autoplan/backend/internal/repository"
)

const stopServiceTime = "2026-07-15T03:00:00.000Z"

type stopServiceClock struct{}

func (stopServiceClock) Now() time.Time {
	value, _ := time.Parse(time.RFC3339Nano, stopServiceTime)
	return value
}

type stopServiceState struct {
	plan      domainplan.Plan
	tasks     []domainplan.Task
	events    []domainevent.PendingEvent
	failEvent bool
}

func (state stopServiceState) clone() stopServiceState {
	state.tasks = append([]domainplan.Task(nil), state.tasks...)
	state.events = append([]domainevent.PendingEvent(nil), state.events...)
	return state
}

type stopServiceWriter struct {
	repository.PlanTransactional
	state stopServiceState
}

func (writer *stopServiceWriter) Check(context.Context) error { return nil }
func (writer *stopServiceWriter) Close() error                { return nil }
func (writer *stopServiceWriter) TransactPlans(ctx context.Context, apply func(repository.PlanWriteTransaction) error) error {
	working := writer.state.clone()
	transaction := &stopServiceTransaction{state: &working}
	if err := apply(transaction); err != nil {
		return err
	}
	writer.state = working
	return nil
}

type stopServiceTransaction struct {
	repository.PlanWriteTransaction
	state *stopServiceState
}

func (transaction *stopServiceTransaction) GetPlan(_ context.Context, projectID, planID int64) (domainplan.Plan, bool, error) {
	plan := transaction.state.plan
	return plan, plan.ProjectID == projectID && plan.ID == planID, nil
}

func (transaction *stopServiceTransaction) ListPlanTasks(_ context.Context, projectID, planID int64) ([]domainplan.Task, error) {
	if transaction.state.plan.ProjectID != projectID || transaction.state.plan.ID != planID {
		return []domainplan.Task{}, nil
	}
	return append([]domainplan.Task(nil), transaction.state.tasks...), nil
}

func (transaction *stopServiceTransaction) StopPlan(_ context.Context, input domainplan.PlanStop) (domainplan.PlanStopResult, error) {
	plan := transaction.state.plan
	if plan.ProjectID != input.ProjectID || plan.ID != input.PlanID {
		return domainplan.PlanStopResult{}, repository.ErrNotFound
	}
	stoppable := plan.Status == domainplan.StatusRunning
	for _, task := range transaction.state.tasks {
		stoppable = stoppable || task.Status == domainplan.TaskRunning
	}
	if !stoppable {
		return domainplan.PlanStopResult{}, repository.ErrInvalidPlan
	}
	plan.Status, plan.UpdatedAt = domainplan.StatusInterrupted, input.UpdatedAt
	transaction.state.plan = plan
	affected := make([]domainplan.Task, 0)
	for index, task := range transaction.state.tasks {
		if domainplan.IsAcceptableTask(task.Status) || task.Status == domainplan.TaskBlocked {
			continue
		}
		task.Status, task.UpdatedAt = domainplan.TaskBlocked, input.UpdatedAt
		transaction.state.tasks[index] = task
		affected = append(affected, task)
	}
	return domainplan.PlanStopResult{Plan: plan, AffectedTasks: affected}, nil
}

func (transaction *stopServiceTransaction) AppendEvent(_ context.Context, event domainevent.PendingEvent) error {
	if transaction.state.failEvent {
		return errors.New("synthetic event failure")
	}
	if domainevent.ValidatePending(event) != nil {
		return repository.ErrInvalidEvent
	}
	transaction.state.events = append(transaction.state.events, event)
	return nil
}

type stopServiceAssembler struct{}

func (stopServiceAssembler) Assemble(context.Context, *int64, domainproject.Visibility) (contracts.AppSnapshot, error) {
	return contracts.AppSnapshot{}, nil
}

func TestStopCommitsAggregateAndPlanStoppedEventTogether(t *testing.T) {
	writer := newStopServiceWriter(domainplan.StatusRunning, domainplan.TaskRunning, domainplan.TaskCompleted)
	service := NewService(Dependencies{Assembler: stopServiceAssembler{}, Writer: writer, Clock: stopServiceClock{}})

	result, err := service.Stop(context.Background(), StopCommand{ProjectID: 7, PlanID: 11, RequestID: "req-stop"})
	if err != nil {
		t.Fatal(err)
	}
	if result.Plan.Status != domainplan.StatusInterrupted || result.Plan.UpdatedAt != stopServiceTime ||
		len(result.AffectedTasks) != 1 || result.AffectedTasks[0].Status != domainplan.TaskBlocked {
		t.Fatalf("result=%#v", result)
	}
	if len(writer.state.events) != 1 || writer.state.events[0].Type != "plan.stopped" ||
		writer.state.events[0].OccurredAt != stopServiceTime {
		t.Fatalf("events=%#v", writer.state.events)
	}
	var metadata struct {
		PlanID          int64   `json:"plan_id"`
		PreviousStatus  string  `json:"previous_status"`
		Status          string  `json:"status"`
		AffectedTasks   int     `json:"affected_tasks"`
		AffectedTaskIDs []int64 `json:"affected_task_ids"`
	}
	if err := json.Unmarshal([]byte(*writer.state.events[0].MetaJSON), &metadata); err != nil ||
		metadata.PlanID != 11 || metadata.PreviousStatus != "running" || metadata.Status != "interrupted" ||
		metadata.AffectedTasks != 1 || len(metadata.AffectedTaskIDs) != 1 || metadata.AffectedTaskIDs[0] != 12 {
		t.Fatalf("metadata=%#v error=%v", metadata, err)
	}
}

func TestCheckStoppableUsesProjectScopedPlanOrRunningTask(t *testing.T) {
	for _, test := range []struct {
		name       string
		projectID  int64
		planStatus domainplan.Status
		taskStatus domainplan.TaskStatus
		want       error
	}{
		{name: "running plan", projectID: 7, planStatus: domainplan.StatusRunning, taskStatus: domainplan.TaskPending},
		{name: "running task", projectID: 7, planStatus: domainplan.StatusPending, taskStatus: domainplan.TaskRunning},
		{name: "inactive", projectID: 7, planStatus: domainplan.StatusPending, taskStatus: domainplan.TaskPending, want: ErrStateConflict},
		{name: "cross project", projectID: 8, planStatus: domainplan.StatusRunning, taskStatus: domainplan.TaskRunning, want: repository.ErrNotFound},
	} {
		t.Run(test.name, func(t *testing.T) {
			writer := newStopServiceWriter(test.planStatus, test.taskStatus)
			service := NewService(Dependencies{Assembler: stopServiceAssembler{}, Writer: writer, Clock: stopServiceClock{}})
			err := service.CheckStoppable(context.Background(), test.projectID, 11)
			if !errors.Is(err, test.want) {
				t.Fatalf("error=%v want=%v", err, test.want)
			}
			if writer.state.plan.Status != test.planStatus || writer.state.tasks[0].Status != test.taskStatus {
				t.Fatalf("read-only check mutated state: %#v", writer.state)
			}
		})
	}
}

func TestStopReturnsStableNotFoundAndConflictErrorsWithoutWrites(t *testing.T) {
	tests := []struct {
		name      string
		projectID int64
		status    domainplan.Status
		want      error
	}{
		{name: "cross project is hidden", projectID: 8, status: domainplan.StatusRunning, want: repository.ErrNotFound},
		{name: "inactive plan conflicts", projectID: 7, status: domainplan.StatusPending, want: ErrStateConflict},
		{name: "repeated stop conflicts", projectID: 7, status: domainplan.StatusInterrupted, want: ErrStateConflict},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			writer := newStopServiceWriter(test.status, domainplan.TaskPending)
			service := NewService(Dependencies{Assembler: stopServiceAssembler{}, Writer: writer, Clock: stopServiceClock{}})
			_, err := service.Stop(context.Background(), StopCommand{ProjectID: test.projectID, PlanID: 11, RequestID: "req-stop"})
			if !errors.Is(err, test.want) {
				t.Fatalf("error=%v want=%v", err, test.want)
			}
			if writer.state.plan.Status != test.status || writer.state.tasks[0].Status != domainplan.TaskPending || len(writer.state.events) != 0 {
				t.Fatalf("partial write: %#v", writer.state)
			}
		})
	}
}

func TestStopRollsBackAggregateWhenAuditAppendFails(t *testing.T) {
	writer := newStopServiceWriter(domainplan.StatusRunning, domainplan.TaskRunning)
	writer.state.failEvent = true
	service := NewService(Dependencies{Assembler: stopServiceAssembler{}, Writer: writer, Clock: stopServiceClock{}})

	if _, err := service.Stop(context.Background(), StopCommand{ProjectID: 7, PlanID: 11, RequestID: "req-stop"}); err == nil {
		t.Fatal("expected event failure")
	}
	if writer.state.plan.Status != domainplan.StatusRunning || writer.state.tasks[0].Status != domainplan.TaskRunning || len(writer.state.events) != 0 {
		t.Fatalf("transaction did not roll back: %#v", writer.state)
	}
}

func newStopServiceWriter(planStatus domainplan.Status, taskStatuses ...domainplan.TaskStatus) *stopServiceWriter {
	plan := domainplan.Plan{ID: 11, ProjectID: 7, Status: planStatus, UpdatedAt: "2026-07-15T02:00:00.000Z"}
	tasks := make([]domainplan.Task, len(taskStatuses))
	for index, status := range taskStatuses {
		tasks[index] = domainplan.Task{ID: int64(12 + index), ProjectID: 7, PlanID: 11, Status: status,
			UpdatedAt: "2026-07-15T02:00:00.000Z"}
	}
	return &stopServiceWriter{state: stopServiceState{plan: plan, tasks: tasks}}
}

var _ repository.PlanTransactional = (*stopServiceWriter)(nil)
var _ repository.PlanWriteTransaction = (*stopServiceTransaction)(nil)
