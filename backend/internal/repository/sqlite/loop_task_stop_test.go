package sqlite

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"testing"

	domainplan "github.com/lyming99/autoplan/backend/internal/domain/plan"
	"github.com/lyming99/autoplan/backend/internal/repository"
)

const (
	stopTestCreatedAt = "2026-07-15T00:00:00.000Z"
	stopTestUpdatedAt = "2026-07-15T00:00:05.000Z"
)

func TestRequestPlanTaskStopValidatesTargetAndIsIdempotent(t *testing.T) {
	database, writer := newLoopTaskStopFixture(t)
	ctx := context.Background()
	insertStopTaskStartedEvent(t, database, "loop-operation-12", 12)

	result, err := writer.RequestPlanTaskStop(ctx, repository.PlanTaskStopInput{
		ProjectID: 7, PlanID: 11, TaskID: 12, UpdatedAt: stopTestUpdatedAt,
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Outcome != repository.PlanTaskStopRequested || !result.Changed ||
		result.PreviousStatus != domainplan.TaskRunning || result.Status != domainplan.TaskStopping ||
		result.OperationID != "loop-operation-12" {
		t.Fatalf("first stop result=%#v", result)
	}
	assertStopTaskRow(t, database, 12, "stopping", stopTestUpdatedAt)

	repeated, err := writer.RequestPlanTaskStop(ctx, repository.PlanTaskStopInput{
		ProjectID: 7, PlanID: 11, TaskID: 12, UpdatedAt: "2026-07-15T00:00:06.000Z",
	})
	if err != nil {
		t.Fatal(err)
	}
	if repeated.Outcome != repository.PlanTaskStopAlreadyRequested || repeated.Changed ||
		repeated.Status != domainplan.TaskStopping || repeated.OperationID != "loop-operation-12" {
		t.Fatalf("repeated stop result=%#v", repeated)
	}
	assertStopTaskRow(t, database, 12, "stopping", stopTestUpdatedAt)
}

func TestFinishPlanTaskConvergesStoppingTaskAndIgnoresLateCompletion(t *testing.T) {
	database, writer := newLoopTaskStopFixture(t)
	ctx := context.Background()
	insertStopTaskStartedEvent(t, database, "loop-operation-12", 12)

	if _, err := writer.RequestPlanTaskStop(ctx, repository.PlanTaskStopInput{
		ProjectID: 7, PlanID: 11, TaskID: 12, UpdatedAt: stopTestUpdatedAt,
	}); err != nil {
		t.Fatal(err)
	}
	completion := repository.LoopPlanTaskCompletion{
		ProjectID: 7, PlanID: 11, TaskID: 12, OperationID: "loop-operation-12",
		Cancelled: true, FinishedAt: "2026-07-15T00:00:07.000Z", DurationMS: 7000,
	}
	if err := writer.FinishPlanTask(ctx, completion); err != nil {
		t.Fatal(err)
	}

	var taskStatus, planStatus, finishedAt string
	var durationMS, totalTasks, completedTasks, validationPassed int64
	if err := database.QueryRow(`SELECT plan_tasks.status, plan_tasks.finished_at, plan_tasks.duration_ms,
		plans.status, plans.total_tasks, plans.completed_tasks, plans.validation_passed
		FROM plan_tasks JOIN plans ON plans.id = plan_tasks.plan_id WHERE plan_tasks.id = 12`).Scan(
		&taskStatus, &finishedAt, &durationMS, &planStatus, &totalTasks, &completedTasks, &validationPassed); err != nil {
		t.Fatal(err)
	}
	if taskStatus != "stopped" || planStatus != "stopped" || finishedAt != completion.FinishedAt ||
		durationMS != 7000 || totalTasks != 3 || completedTasks != 1 || validationPassed != 0 {
		t.Fatalf("terminal state task=%q plan=%q finished=%q duration=%d counts=%d/%d validation=%d",
			taskStatus, planStatus, finishedAt, durationMS, completedTasks, totalTasks, validationPassed)
	}

	// A duplicate worker callback and a late successful process exit are both
	// no-ops once the cancellation terminal has committed.
	if err := writer.FinishPlanTask(ctx, completion); err != nil {
		t.Fatalf("duplicate finish error=%v", err)
	}
	late := completion
	late.Cancelled, late.Succeeded, late.FinishedAt, late.DurationMS = false, true, "2026-07-15T00:00:09.000Z", 9000
	if err := writer.FinishPlanTask(ctx, late); err != nil {
		t.Fatalf("late successful finish error=%v", err)
	}
	var stoppedEvents int
	var eventStatus string
	if err := database.QueryRow(`SELECT COUNT(*), COALESCE(MAX(json_extract(data_json, '$.status')), '')
		FROM event_outbox WHERE project_id = 7 AND type = 'business.task_stopped' AND operation_id = 'loop-operation-12'`).Scan(
		&stoppedEvents, &eventStatus); err != nil {
		t.Fatal(err)
	}
	if stoppedEvents != 1 || eventStatus != "stopped" {
		t.Fatalf("stopped events=%d status=%q", stoppedEvents, eventStatus)
	}
	assertStopTaskRow(t, database, 12, "stopped", completion.FinishedAt)
}

func insertStopTaskStartedEvent(t *testing.T, database *sql.DB, operationID string, taskID int64) {
	t.Helper()
	if _, err := database.Exec(`INSERT INTO operations
		(operation_id, project_id, type, status, request_id, idempotency_scope, request_hash, created_at, updated_at, version)
		VALUES (?, 7, 'loop.run_once', 'running', ?, 'project:7:loop.run_once', 'digest', ?, ?, 2)`,
		operationID, operationID, stopTestCreatedAt, stopTestCreatedAt); err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec(`INSERT INTO event_outbox
		(event_id, schema_version, stream_key, sequence, type, request_id, operation_id, project_id,
		 occurred_at, data_json, attempts, created_at)
		VALUES (?, 1, 'project:7', 1, 'business.task_started', ?, ?, 7, ?, ?, 0, ?)`,
		"event-"+operationID, operationID, operationID, stopTestCreatedAt,
		`{"plan_id":11,"task_id":`+fmt.Sprint(taskID)+`}`, stopTestCreatedAt); err != nil {
		t.Fatal(err)
	}
}

func TestRequestPlanTaskStopRejectsTargetsWithoutWrites(t *testing.T) {
	tests := []struct {
		name      string
		input     repository.PlanTaskStopInput
		outcome   repository.PlanTaskStopOutcome
		taskID    int64
		status    string
		updatedAt string
	}{
		{"missing", repository.PlanTaskStopInput{ProjectID: 7, PlanID: 11, TaskID: 999}, repository.PlanTaskStopNotFound, 12, "running", stopTestCreatedAt},
		{"wrong project", repository.PlanTaskStopInput{ProjectID: 8, PlanID: 11, TaskID: 12}, repository.PlanTaskStopOwnershipMismatch, 12, "running", stopTestCreatedAt},
		{"wrong plan", repository.PlanTaskStopInput{ProjectID: 7, PlanID: 21, TaskID: 12}, repository.PlanTaskStopOwnershipMismatch, 12, "running", stopTestCreatedAt},
		{"pending", repository.PlanTaskStopInput{ProjectID: 7, PlanID: 11, TaskID: 13}, repository.PlanTaskStopNotRunning, 13, "pending", stopTestCreatedAt},
		{"terminal", repository.PlanTaskStopInput{ProjectID: 7, PlanID: 11, TaskID: 14}, repository.PlanTaskStopTerminal, 14, "completed", stopTestCreatedAt},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			database, writer := newLoopTaskStopFixture(t)
			test.input.UpdatedAt = stopTestUpdatedAt
			result, err := writer.RequestPlanTaskStop(context.Background(), test.input)
			if err != nil {
				t.Fatal(err)
			}
			if result.Outcome != test.outcome || result.Changed {
				t.Fatalf("stop result=%#v", result)
			}
			assertStopTaskRow(t, database, test.taskID, test.status, test.updatedAt)
		})
	}
}

func TestRequestPlanTaskStopRollsBackFailedTransaction(t *testing.T) {
	database, writer := newLoopTaskStopFixture(t)
	writer.faults.afterWrite = func(label string) error {
		if label == "loop-task:request-stop" {
			return errors.New("injected failure")
		}
		return nil
	}
	_, err := writer.RequestPlanTaskStop(context.Background(), repository.PlanTaskStopInput{
		ProjectID: 7, PlanID: 11, TaskID: 12, UpdatedAt: stopTestUpdatedAt,
	})
	if !errors.Is(err, repository.ErrTransaction) {
		t.Fatalf("stop error=%v", err)
	}
	assertStopTaskRow(t, database, 12, "running", stopTestCreatedAt)
}

func TestRequestPlanTaskStopRejectsInvalidInputBeforeTransaction(t *testing.T) {
	_, writer := newLoopTaskStopFixture(t)
	for _, input := range []repository.PlanTaskStopInput{
		{ProjectID: 0, PlanID: 11, TaskID: 12, UpdatedAt: stopTestUpdatedAt},
		{ProjectID: 7, PlanID: 0, TaskID: 12, UpdatedAt: stopTestUpdatedAt},
		{ProjectID: 7, PlanID: 11, TaskID: 0, UpdatedAt: stopTestUpdatedAt},
		{ProjectID: 7, PlanID: 11, TaskID: 12, UpdatedAt: "not-a-timestamp"},
	} {
		if _, err := writer.RequestPlanTaskStop(context.Background(), input); !errors.Is(err, repository.ErrInvalidTask) {
			t.Fatalf("input=%#v error=%v", input, err)
		}
	}
}

func newLoopTaskStopFixture(t *testing.T) (*sql.DB, *Writer) {
	t.Helper()
	database, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "loop-task-stop.db"))
	if err != nil {
		t.Fatal(err)
	}
	database.SetMaxOpenConns(1)
	for _, name := range []string{"0001_schema_v1.sql", "0002_operations_outbox_v2.sql", "0003_operation_start_times_v3.sql"} {
		schema, readErr := os.ReadFile(filepath.Join("..", "..", "..", "migrations", name))
		if readErr != nil {
			t.Fatal(readErr)
		}
		if _, err = database.Exec(string(schema)); err != nil {
			t.Fatal(err)
		}
	}
	t.Cleanup(func() { _ = database.Close() })
	if _, err = database.Exec(`INSERT INTO projects (id, name, workspace_path, created_at, updated_at)
		VALUES (7, 'owner', '', ?, ?), (8, 'other', '', ?, ?)`,
		stopTestCreatedAt, stopTestCreatedAt, stopTestCreatedAt, stopTestCreatedAt); err != nil {
		t.Fatal(err)
	}
	if _, err = database.Exec(`INSERT INTO plans
		(id, project_id, issue_hash, file_path, hash, status, sort_order, total_tasks, created_at, updated_at)
		VALUES (11, 7, 'issue', 'plan', 'digest', 'running', 1, 3, ?, ?),
		       (21, 7, 'other-issue', 'other-plan', 'other-digest', 'running', 2, 0, ?, ?)`,
		stopTestCreatedAt, stopTestCreatedAt, stopTestCreatedAt, stopTestCreatedAt); err != nil {
		t.Fatal(err)
	}
	if _, err = database.Exec(`INSERT INTO plan_tasks
		(id, plan_id, task_key, title, raw_line, status, sort_order, started_at, finished_at, duration_ms, updated_at)
		VALUES (12, 11, 'P001', 'running', '- [ ] P001', 'running', 1, ?, NULL, 0, ?),
		       (13, 11, 'P002', 'pending', '- [ ] P002', 'pending', 2, NULL, NULL, 0, ?),
		       (14, 11, 'P003', 'completed', '- [x] P003', 'completed', 3, ?, ?, 1000, ?)`,
		stopTestCreatedAt, stopTestCreatedAt, stopTestCreatedAt,
		stopTestCreatedAt, stopTestCreatedAt, stopTestCreatedAt); err != nil {
		t.Fatal(err)
	}
	writer, err := newWriter(sqlBeginner{database}, writeTestGate{}, writeTestOwner{"loop-task-stop"}, true, SchemaVersion)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = writer.Close() })
	return database, writer
}

func assertStopTaskRow(t *testing.T, database *sql.DB, taskID int64, status, updatedAt string) {
	t.Helper()
	var actualStatus, actualUpdatedAt string
	if err := database.QueryRow(`SELECT status, updated_at FROM plan_tasks WHERE id = ?`, taskID).
		Scan(&actualStatus, &actualUpdatedAt); err != nil {
		t.Fatal(err)
	}
	if actualStatus != status || actualUpdatedAt != updatedAt {
		t.Fatalf("task %d state=(%q,%q), want=(%q,%q)", taskID, actualStatus, actualUpdatedAt, status, updatedAt)
	}
}
