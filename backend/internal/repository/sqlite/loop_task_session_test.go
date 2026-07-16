package sqlite

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"testing"

	"github.com/lyming99/autoplan/backend/internal/repository"
)

func TestLoopTaskSessionPersistsBetweenClaimsForSamePlan(t *testing.T) {
	migrationDirectory := filepath.Join("..", "..", "..", "migrations")
	database, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "loop-session.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	database.SetMaxOpenConns(1)
	for _, name := range []string{"0001_schema_v1.sql", "0002_operations_outbox_v2.sql", "0003_operation_start_times_v3.sql"} {
		schema, readErr := os.ReadFile(filepath.Join(migrationDirectory, name))
		if readErr != nil {
			t.Fatal(readErr)
		}
		if _, err = database.Exec(string(schema)); err != nil {
			t.Fatal(err)
		}
	}

	const projectID int64 = 7
	const planID int64 = 11
	const firstTaskID int64 = 12
	const secondTaskID int64 = 13
	const sessionID = "00000000-aaaa-bbbb-cccc-000000000001"
	const createdAt = "2026-07-15T00:00:00.000Z"
	if _, err = database.Exec(`INSERT INTO projects (id, name, workspace_path, created_at, updated_at)
		VALUES (?, 'fixture', ?, ?, ?)`, projectID, t.TempDir(), createdAt, createdAt); err != nil {
		t.Fatal(err)
	}
	if _, err = database.Exec(`INSERT INTO plans (
		id, project_id, issue_hash, file_path, hash, status, sort_order, total_tasks,
		agent_cli_provider, plan_execution_provider, created_at, updated_at
	) VALUES (?, ?, 'issue-digest', 'docs/plan/fixture.md', 'plan-digest', 'pending', 1, 2,
		'codex', 'codex', ?, ?)`, planID, projectID, createdAt, createdAt); err != nil {
		t.Fatal(err)
	}
	if _, err = database.Exec(`INSERT INTO plan_tasks
		(id, plan_id, task_key, title, raw_line, scope, status, sort_order, updated_at)
		VALUES
		(?, ?, 'P001', 'Implement service', '- [ ] P001: Implement service', 'backend', 'pending', 1, ?),
		(?, ?, 'P002', 'Add tests', '- [ ] P002: Add tests', 'backend', 'pending', 2, ?)`,
		firstTaskID, planID, createdAt, secondTaskID, planID, createdAt); err != nil {
		t.Fatal(err)
	}

	writer, err := newWriter(sqlBeginner{database}, writeTestGate{}, writeTestOwner{"loop-session"}, true, SchemaVersion)
	if err != nil {
		t.Fatal(err)
	}
	defer writer.Close()
	ctx := context.Background()
	first, found, err := writer.ClaimNextPlanTask(ctx, projectID, "loop-operation-1", "2026-07-15T00:00:01.000Z")
	if err != nil || !found || first.Task.ID != firstTaskID || first.SessionID != "" {
		t.Fatalf("first claim=%#v found=%v err=%v", first, found, err)
	}
	if err = writer.FinishPlanTask(ctx, repository.LoopPlanTaskCompletion{
		ProjectID: projectID, PlanID: planID, TaskID: firstTaskID, OperationID: "loop-operation-1",
		Succeeded: true, Digest: "digest-after-p001", SessionID: sessionID,
		FinishedAt: "2026-07-15T00:00:02.000Z", DurationMS: 1000,
	}); err != nil {
		t.Fatal(err)
	}
	second, found, err := writer.ClaimNextPlanTask(ctx, projectID, "loop-operation-2", "2026-07-15T00:00:03.000Z")
	if err != nil || !found || second.Task.ID != secondTaskID || second.SessionID != sessionID {
		t.Fatalf("second claim=%#v found=%v err=%v", second, found, err)
	}
}
