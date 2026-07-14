package bootstrap

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/lyming99/autoplan/backend/internal/repository"
	storesqlite "github.com/lyming99/autoplan/backend/internal/repository/sqlite"
	"github.com/lyming99/autoplan/backend/migrations"
)

func TestStartDatabaseMigratesEmptyTemporaryDatabase(t *testing.T) {
	readiness, err := NewDatabaseReadiness()
	if err != nil {
		t.Fatal(err)
	}
	root := canonicalTemporaryDirectory(t)
	for range 2 {
		runtime, err := StartDatabase(context.Background(), DatabaseStartupOptions{
			Target: filepath.Join(root, "autoplan.sqlite"), DriverName: "sqlite", AllowCreate: true,
			LockTimeout: time.Second, AuthorizedRoots: []string{root}, Readiness: readiness,
		})
		if err != nil {
			t.Fatal(err)
		}
		if err := runtime.Close(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
}

func TestStartDatabaseRepairsV2OperationsAndRestartsWithStoredWorkspace(t *testing.T) {
	ctx := context.Background()
	root := canonicalTemporaryDirectory(t)
	workspace := canonicalTemporaryDirectory(t)
	target := filepath.Join(root, "autoplan.sqlite")
	seedVersionTwoRestartFixture(t, target, workspace)

	readiness, err := NewDatabaseReadiness()
	if err != nil {
		t.Fatal(err)
	}
	runtime, err := StartDatabase(ctx, DatabaseStartupOptions{
		Target: target, DriverName: "sqlite", AllowCreate: true, LockTimeout: time.Second,
		AuthorizedRoots: []string{root}, AuthorizeStoredProjectWorkspaces: true, Readiness: readiness,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer runtime.Close(ctx)
	connection, ok := runtime.Connection().(*storesqlite.Connection)
	if !ok {
		t.Fatal("startup connection type drifted")
	}
	gate, err := readiness.Gate("configuration", "prerequisites", "application", "listener")
	if err != nil {
		t.Fatal(err)
	}
	writer, err := storesqlite.NewWriter(storesqlite.WriterOptions{
		Connection: connection, Readiness: gate, Owner: runtime,
		AuthorizedCopy: true, SchemaVersion: storesqlite.SchemaVersion,
	})
	if err != nil {
		t.Fatal(err)
	}
	resultJSON := `{"kind":"active-project","project_id":1}`
	err = writer.Transact(ctx, func(transaction repository.WriteTransaction) error {
		projectID := int64(1)
		if reserveErr := transaction.ReserveIdempotency(ctx, repository.IdempotencyRecord{
			OperationID: "current-operation", ProjectID: &projectID, Route: "projects:update",
			Status: "running", RequestID: "current-request", Scope: "current-scope", Key: "current-key",
			RequestHash: strings.Repeat("b", 64), CreatedAt: "2026-07-13T00:00:01.000Z",
			UpdatedAt: "2026-07-13T00:00:01.000Z",
		}); reserveErr != nil {
			return reserveErr
		}
		return transaction.CompleteIdempotency(
			ctx, "current-scope", "current-key", "succeeded", &resultJSON, nil,
			"2026-07-13T00:00:02.000Z",
		)
	})
	if err != nil {
		t.Fatal(err)
	}
	for operation, expected := range map[string]string{
		"legacy-operation":  "2026-07-13T00:00:00.000Z",
		"current-operation": "2026-07-13T00:00:01.000Z",
	} {
		var startedAt string
		if err := connection.QueryRowContext(ctx,
			"SELECT started_at FROM operations WHERE operation_id = ?", operation,
		).Scan(&startedAt); err != nil || startedAt != expected {
			t.Fatalf("%s started_at = %q, %v", operation, startedAt, err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	if err := runtime.Close(ctx); err != nil {
		t.Fatal(err)
	}

	secondReadiness, err := NewDatabaseReadiness()
	if err != nil {
		t.Fatal(err)
	}
	second, err := StartDatabase(ctx, DatabaseStartupOptions{
		Target: target, DriverName: "sqlite", AllowCreate: true, LockTimeout: time.Second,
		AuthorizedRoots: []string{root}, AuthorizeStoredProjectWorkspaces: true, Readiness: secondReadiness,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer second.Close(ctx)
	if err := second.Close(ctx); err != nil {
		t.Fatal(err)
	}
}

func TestLoopTaskLifecyclePersistsAtomicallyInSQLite(t *testing.T) {
	ctx := context.Background()
	root := canonicalTemporaryDirectory(t)
	readiness, err := NewDatabaseReadiness()
	if err != nil {
		t.Fatal(err)
	}
	runtime, err := StartDatabase(ctx, DatabaseStartupOptions{
		Target: filepath.Join(root, "autoplan.sqlite"), DriverName: "sqlite", AllowCreate: true,
		LockTimeout: time.Second, AuthorizedRoots: []string{root}, Readiness: readiness,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer runtime.Close(ctx)
	connection, ok := runtime.Connection().(*storesqlite.Connection)
	if !ok {
		t.Fatal("startup connection type drifted")
	}
	gate, err := readiness.Gate("configuration", "prerequisites", "application", "listener")
	if err != nil {
		t.Fatal(err)
	}
	writer, err := storesqlite.NewWriter(storesqlite.WriterOptions{
		Connection: connection, Readiness: gate, Owner: runtime,
		AuthorizedCopy: true, SchemaVersion: storesqlite.SchemaVersion,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer writer.Close()

	createdAt := "2026-07-14T01:02:03.000Z"
	startedAt := "2026-07-14T01:02:04.000Z"
	finishedAt := "2026-07-14T01:02:05.000Z"
	statements := []struct {
		query string
		args  []any
	}{
		{`INSERT INTO projects (id, name, workspace_path, description, created_at, updated_at)
		  VALUES (1, 'loop fixture', ?, '', ?, ?)`, []any{root, createdAt, createdAt}},
		{`INSERT INTO project_states (project_id, updated_at) VALUES (1, ?)`, []any{createdAt}},
		{`INSERT INTO plans (
			id, project_id, issue_hash, file_path, hash, status, sort_order, total_tasks,
			completed_tasks, validation_passed, agent_cli_provider, agent_cli_command,
			plan_generation_strategy, plan_execution_strategy, plan_execution_provider,
			plan_execution_command, created_at, updated_at
		  ) VALUES (1, 1, 'issue-digest', '.autoplan/plans/fixture.md', 'before-digest',
			'pending', 1, 1, 0, 0, 'codex', 'codex', 'external-cli-structured',
			'external-cli', 'codex', 'codex', ?, ?)`, []any{createdAt, createdAt}},
		{`INSERT INTO plan_tasks (
			id, plan_id, task_key, title, raw_line, scope, status, sort_order, updated_at
		  ) VALUES (1, 1, 'TASK-001', 'Implement fixture', '- [ ] TASK-001 Implement fixture',
			'backend/**', 'pending', 1, ?)`, []any{createdAt}},
		{`INSERT INTO operations (
			operation_id, project_id, type, status, request_id, idempotency_scope,
			request_hash, created_at, updated_at, started_at
		  ) VALUES ('loop-operation', 1, 'loop.run_once', 'running', 'loop-request',
			'loop:project:1', ?, ?, ?, ?)`, []any{strings.Repeat("a", 64), createdAt, createdAt, createdAt}},
	}
	for _, statement := range statements {
		if _, err := connection.ExecContext(ctx, statement.query, statement.args...); err != nil {
			t.Fatal(err)
		}
	}

	claim, claimed, err := writer.ClaimNextPlanTask(ctx, 1, "loop-operation", startedAt)
	if err != nil || !claimed {
		t.Fatalf("claim = %#v, claimed=%t, err=%v", claim, claimed, err)
	}
	if claim.Plan.Status != "running" || claim.Task.Status != "running" || claim.Task.Key != "TASK-001" {
		t.Fatalf("unexpected claimed lifecycle: plan=%#v task=%#v", claim.Plan, claim.Task)
	}
	if err := writer.FinishPlanTask(ctx, repository.LoopPlanTaskCompletion{
		ProjectID: 1, PlanID: claim.Plan.ID, TaskID: claim.Task.ID, OperationID: "loop-operation",
		Succeeded: true, Digest: "after-digest", FinishedAt: finishedAt, DurationMS: 1000,
	}); err != nil {
		t.Fatal(err)
	}

	var taskStatus, planStatus, digest, succeededMeta string
	var completedTasks, validationPassed, durableEvents int64
	if err := connection.QueryRowContext(ctx, `SELECT task.status, plan.status, plan.hash,
		plan.completed_tasks, plan.validation_passed
		FROM plan_tasks AS task JOIN plans AS plan ON plan.id = task.plan_id
		WHERE task.id = 1`).Scan(&taskStatus, &planStatus, &digest, &completedTasks, &validationPassed); err != nil {
		t.Fatal(err)
	}
	if err := connection.QueryRowContext(ctx, `SELECT COUNT(*) FROM event_outbox
		WHERE operation_id = 'loop-operation' AND type IN ('business.task_started', 'business.task_succeeded')
		AND project_revision IS NOT NULL`).Scan(&durableEvents); err != nil {
		t.Fatal(err)
	}
	if err := connection.QueryRowContext(ctx, `SELECT data_json FROM event_outbox
		WHERE operation_id = 'loop-operation' AND type = 'business.task_succeeded'`).Scan(&succeededMeta); err != nil {
		t.Fatal(err)
	}
	var eventMeta map[string]any
	if err := json.Unmarshal([]byte(succeededMeta), &eventMeta); err != nil {
		t.Fatal(err)
	}
	if eventMeta["task_title"] != "Implement fixture" {
		t.Fatalf("task event title = %#v, want %q", eventMeta["task_title"], "Implement fixture")
	}
	if taskStatus != "completed" || planStatus != "completed" || digest != "after-digest" ||
		completedTasks != 1 || validationPassed != 1 || durableEvents != 2 {
		t.Fatalf("persisted lifecycle task=%q plan=%q digest=%q completed=%d validation=%d events=%d",
			taskStatus, planStatus, digest, completedTasks, validationPassed, durableEvents)
	}
}

func canonicalTemporaryDirectory(t *testing.T) string {
	t.Helper()
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return filepath.Clean(root)
}

func seedVersionTwoRestartFixture(t *testing.T, target, workspace string) {
	t.Helper()
	ctx := context.Background()
	connection, err := storesqlite.OpenConnection(ctx, storesqlite.ConnectionOptions{
		DriverName: "sqlite", DataSourceName: target,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	entries := migrations.NewRegistry(migrations.NewCatalog()).Migrations()
	if len(entries) < migrations.SchemaV2Version {
		t.Fatal("v2 migration history missing")
	}
	for _, entry := range entries[:migrations.SchemaV2Version] {
		if _, err := connection.ExecContext(ctx, entry.SQL); err != nil {
			t.Fatal(err)
		}
		if _, err := connection.ExecContext(ctx,
			"INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
			entry.Version, entry.Name, entry.Checksum, "2026-07-13T00:00:00Z",
		); err != nil {
			t.Fatal(err)
		}
		if _, err := connection.ExecContext(ctx, fmt.Sprintf("PRAGMA user_version = %d", entry.TargetUserVersion)); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := connection.ExecContext(ctx,
		`INSERT INTO projects (id, name, workspace_path, description, created_at, updated_at)
		 VALUES (1, 'restart fixture', ?, '', '2026-07-13T00:00:00.000Z', '2026-07-13T00:00:00.000Z')`,
		workspace,
	); err != nil {
		t.Fatal(err)
	}
	if _, err := connection.ExecContext(ctx,
		`INSERT INTO project_states (project_id, updated_at) VALUES (1, '2026-07-13T00:00:00.000Z')`,
	); err != nil {
		t.Fatal(err)
	}
	if _, err := connection.ExecContext(ctx,
		`INSERT INTO operations (
		 operation_id, project_id, type, status, request_id, idempotency_scope, idempotency_key,
		 request_hash, created_at, updated_at, finished_at, result_json, version
		) VALUES (?, 1, ?, 'succeeded', ?, ?, ?, ?, ?, ?, ?, ?, 2)`,
		"legacy-operation", "projects:create", "legacy-request", "legacy-scope", "legacy-key",
		strings.Repeat("a", 64), "2026-07-13T00:00:00.000Z", "2026-07-13T00:00:00.000Z",
		"2026-07-13T00:00:00.000Z", `{"kind":"active-project","project_id":1}`,
	); err != nil {
		t.Fatal(err)
	}
}

func TestDaemonAllowedOriginsAddsOnlyLoopbackDevelopmentRenderer(t *testing.T) {
	t.Setenv("AUTOPLAN_SIDECAR_RENDERER_ORIGIN", "http://127.0.0.1:5173")
	origins := daemonAllowedOrigins()
	if len(origins) != 2 || origins[0] != daemonOrigin || origins[1] != "http://127.0.0.1:5173" {
		t.Fatalf("allowed origins = %#v", origins)
	}
	t.Setenv("AUTOPLAN_SIDECAR_RENDERER_ORIGIN", "https://example.test")
	origins = daemonAllowedOrigins()
	if len(origins) != 1 || origins[0] != daemonOrigin {
		t.Fatalf("non-loopback renderer origin was accepted: %#v", origins)
	}
}
