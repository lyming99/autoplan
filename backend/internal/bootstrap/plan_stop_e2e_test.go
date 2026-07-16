package bootstrap

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	applicationplans "github.com/lyming99/autoplan/backend/internal/application/plans"
	"github.com/lyming99/autoplan/backend/internal/config"
	"github.com/lyming99/autoplan/backend/internal/httpapi"
	"github.com/lyming99/autoplan/backend/internal/platform/logging"
	"github.com/lyming99/autoplan/backend/internal/platform/session"
	storesqlite "github.com/lyming99/autoplan/backend/internal/repository/sqlite"
)

type planStopE2EClock struct{}

func (planStopE2EClock) Now() time.Time {
	return time.Date(2026, time.July, 15, 9, 30, 0, 0, time.UTC)
}

type planStopE2EFixture struct {
	t          *testing.T
	server     *httptest.Server
	credential string
	connection *storesqlite.Connection
	plans      *applicationplans.Service
}

func TestPlanStopEndToEndThroughHTTPRuntimeAndSQLite(t *testing.T) {
	fixture := newPlanStopE2EFixture(t)
	if err := fixture.plans.CheckStoppable(context.Background(), 1, 11); err != nil {
		t.Fatalf("seeded running plan is not stoppable: %v", err)
	}

	first := fixture.stop(1, 11, "stop-running-plan")
	if first.status != http.StatusAccepted || first.code == "invalid_runtime_command" ||
		first.operationID == "" || first.operationStatus != "completed" {
		t.Fatalf("running plan stop response=%#v operations=%s", first, fixture.operationSummary())
	}
	fixture.assertPlanAndTasks(11, "interrupted", map[int64]string{111: "blocked", 112: "blocked", 113: "completed"})
	fixture.assertCount("SELECT COUNT(*) FROM events WHERE project_id = 1 AND type = 'plan.stopped'", 1)
	fixture.assertCount("SELECT COUNT(*) FROM operations WHERE project_id = 1 AND type = 'plan.stop' AND status = 'succeeded'", 1)
	fixture.assertCount("SELECT COUNT(*) FROM operations WHERE operation_id = '"+first.operationID+"' AND result_json NOT LIKE '%file_path%'", 1)

	replay := fixture.stop(1, 11, "stop-running-plan")
	if replay.status != http.StatusAccepted || replay.operationID != first.operationID || replay.operationStatus != "completed" {
		t.Fatalf("idempotent replay=%#v first=%#v operations=%s", replay, first, fixture.operationSummary())
	}
	fixture.assertCount("SELECT COUNT(*) FROM events WHERE project_id = 1 AND type = 'plan.stopped'", 1)
	fixture.assertCount("SELECT COUNT(*) FROM operations WHERE project_id = 1 AND type = 'plan.stop'", 1)

	withoutActiveProcess := fixture.stop(1, 12, "stop-running-task")
	if withoutActiveProcess.status != http.StatusAccepted || withoutActiveProcess.operationStatus != "completed" {
		t.Fatalf("running-task-only stop=%#v", withoutActiveProcess)
	}
	fixture.assertPlanAndTasks(12, "interrupted", map[int64]string{121: "blocked"})

	inactive := fixture.stop(1, 13, "stop-inactive-plan")
	if inactive.status != http.StatusPreconditionFailed || inactive.code != "precondition_failed" {
		t.Fatalf("inactive plan response=%#v", inactive)
	}
	crossProject := fixture.stop(1, 21, "stop-cross-project-plan")
	if crossProject.status != http.StatusNotFound || crossProject.code != "not_found" {
		t.Fatalf("cross-project response=%#v", crossProject)
	}
	fixture.assertPlanAndTasks(21, "running", map[int64]string{211: "running"})

	snapshot := fixture.get("/api/v1/projects/1/snapshot")
	if snapshot.status != http.StatusOK || !strings.Contains(snapshot.body, `"status":"interrupted"`) ||
		!strings.Contains(snapshot.body, `"status":"blocked"`) {
		t.Fatalf("post-stop snapshot status=%d body=%s", snapshot.status, snapshot.body)
	}
}

func TestPlanStopEndToEndRollsBackSQLiteTransaction(t *testing.T) {
	fixture := newPlanStopE2EFixture(t)
	if _, err := fixture.connection.ExecContext(context.Background(), `
		CREATE TRIGGER reject_plan_14_stop BEFORE UPDATE OF status ON plans
		WHEN OLD.id = 14 AND NEW.status = 'interrupted'
		BEGIN SELECT RAISE(ABORT, 'injected plan stop failure'); END`); err != nil {
		t.Fatal(err)
	}

	response := fixture.stop(1, 14, "stop-rollback-plan")
	if response.status < 400 || response.code == "" || response.code == "invalid_runtime_command" {
		t.Fatalf("rollback response=%#v", response)
	}
	fixture.assertPlanAndTasks(14, "running", map[int64]string{141: "running", 142: "pending"})
	fixture.assertCount("SELECT COUNT(*) FROM events WHERE project_id = 1 AND type = 'plan.stopped' AND json_extract(meta, '$.plan_id') = 14", 0)
	fixture.assertCount("SELECT COUNT(*) FROM operations WHERE project_id = 1 AND type = 'plan.stop' AND status = 'failed'", 1)
}

type planStopHTTPResponse struct {
	status          int
	code            string
	operationID     string
	operationStatus string
	body            string
}

func newPlanStopE2EFixture(t *testing.T) *planStopE2EFixture {
	t.Helper()
	ctx := context.Background()
	root := canonicalTemporaryDirectory(t)
	readiness, err := NewDatabaseReadiness()
	if err != nil {
		t.Fatal(err)
	}
	database, err := StartDatabase(ctx, DatabaseStartupOptions{
		Target: filepath.Join(root, "autoplan.sqlite"), DriverName: "sqlite", AllowCreate: true,
		LockTimeout: time.Second, AuthorizedRoots: []string{root}, Readiness: readiness,
	})
	if err != nil {
		t.Fatal(err)
	}
	connection, ok := database.Connection().(*storesqlite.Connection)
	if !ok {
		t.Fatal("startup connection type drifted")
	}
	gate, err := readiness.Gate("configuration", "prerequisites", "application", "listener")
	if err != nil {
		t.Fatal(err)
	}
	writer, err := storesqlite.NewWriter(storesqlite.WriterOptions{
		Connection: connection, Readiness: gate, Owner: database,
		AuthorizedCopy: true, SchemaVersion: storesqlite.SchemaVersion,
	})
	if err != nil {
		t.Fatal(err)
	}
	seedPlanStopE2EDatabase(t, connection, root)

	configuration := config.Defaults()
	configuration.HTTP.AllowedOrigins = []string{"http://127.0.0.1:5173"}
	clock := planStopE2EClock{}
	dependencies, err := AssembleDependencies(configuration, DependencyOverrides{
		Clock: clock, Readiness: gate, Repository: writer,
	})
	if err != nil {
		t.Fatal(err)
	}
	router, err := httpapi.NewRouter(httpapi.RouterOptions{
		Application: dependencies.Application, Logger: logging.Nop{}, Clock: clock,
		BodyLimitBytes: config.DefaultBodyLimit,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := dependencies.RegisterRuntimeRoutes(router, logging.Nop{}, clock); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(router)
	fixture := &planStopE2EFixture{t: t, server: server, credential: string(dependencies.SessionCopy()), connection: connection, plans: dependencies.Plans}
	t.Cleanup(func() {
		server.Close()
		_ = dependencies.Close(ctx)
		_ = database.Close(ctx)
	})
	return fixture
}

func seedPlanStopE2EDatabase(t *testing.T, connection *storesqlite.Connection, workspace string) {
	t.Helper()
	ctx := context.Background()
	createdAt := "2026-07-15T09:00:00.000Z"
	for _, statement := range []struct {
		query string
		args  []any
	}{
		{`INSERT INTO projects (id, name, workspace_path, description, created_at, updated_at) VALUES (1, 'one', ?, '', ?, ?)`, []any{workspace, createdAt, createdAt}},
		{`INSERT INTO projects (id, name, workspace_path, description, created_at, updated_at) VALUES (2, 'two', ?, '', ?, ?)`, []any{workspace, createdAt, createdAt}},
		{`INSERT INTO project_states (project_id, updated_at) VALUES (1, ?), (2, ?)`, []any{createdAt, createdAt}},
	} {
		if _, err := connection.ExecContext(ctx, statement.query, statement.args...); err != nil {
			t.Fatal(err)
		}
	}
	for _, plan := range []struct {
		id, project int64
		status      string
	}{{11, 1, "running"}, {12, 1, "pending"}, {13, 1, "pending"}, {14, 1, "running"}, {21, 2, "running"}} {
		_, err := connection.ExecContext(ctx, `INSERT INTO plans (
			id, project_id, issue_hash, file_path, hash, status, sort_order, total_tasks,
			completed_tasks, validation_passed, agent_cli_provider, agent_cli_command,
			plan_generation_strategy, plan_execution_strategy, plan_execution_provider,
			plan_execution_command, created_at, updated_at
		) VALUES (?, ?, ?, ?, 'digest', ?, ?, 1, 0, 0, 'codex', 'codex',
			'external-cli-structured', 'external-cli', 'codex', 'codex', ?, ?)`,
			plan.id, plan.project, fmt.Sprintf("issue-%d", plan.id), fmt.Sprintf("docs/plan/%d.md", plan.id),
			plan.status, plan.id, createdAt, createdAt)
		if err != nil {
			t.Fatal(err)
		}
	}
	for _, task := range []struct {
		id, plan int64
		status   string
	}{{111, 11, "running"}, {112, 11, "pending"}, {113, 11, "completed"}, {121, 12, "running"},
		{131, 13, "pending"}, {141, 14, "running"}, {142, 14, "pending"}, {211, 21, "running"}} {
		_, err := connection.ExecContext(ctx, `INSERT INTO plan_tasks
			(id, plan_id, task_key, title, raw_line, scope, status, sort_order, updated_at)
			VALUES (?, ?, ?, 'fixture task', '- [ ] fixture task', 'backend', ?, ?, ?)`,
			task.id, task.plan, fmt.Sprintf("P%d", task.id), task.status, task.id, createdAt)
		if err != nil {
			t.Fatal(err)
		}
	}
}

func (fixture *planStopE2EFixture) stop(projectID, planID int64, key string) planStopHTTPResponse {
	fixture.t.Helper()
	path := fmt.Sprintf("/api/v1/projects/%d/plans/%d/actions/stop", projectID, planID)
	return fixture.request(http.MethodPost, path, key, []byte("{}"))
}

func (fixture *planStopE2EFixture) get(path string) planStopHTTPResponse {
	fixture.t.Helper()
	return fixture.request(http.MethodGet, path, "", nil)
}

func (fixture *planStopE2EFixture) request(method, path, key string, body []byte) planStopHTTPResponse {
	fixture.t.Helper()
	request, err := http.NewRequest(method, fixture.server.URL+path, bytes.NewReader(body))
	if err != nil {
		fixture.t.Fatal(err)
	}
	request.Header.Set("Origin", "http://127.0.0.1:5173")
	request.Header.Set(session.HeaderName, fixture.credential)
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	if key != "" {
		request.Header.Set(httpapi.IdempotencyKeyHeader, key)
		request.Header.Set(httpapi.RequestIDHeader, "request-"+key)
	}
	response, err := fixture.server.Client().Do(request)
	if err != nil {
		fixture.t.Fatal(err)
	}
	defer response.Body.Close()
	payload, err := io.ReadAll(response.Body)
	if err != nil {
		fixture.t.Fatal(err)
	}
	result := planStopHTTPResponse{status: response.StatusCode, body: string(payload)}
	var envelope struct {
		Code string `json:"code"`
		Data struct {
			OperationID string `json:"operation_id"`
			Status      string `json:"status"`
		} `json:"data"`
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal(payload, &envelope); err == nil {
		result.operationID, result.operationStatus, result.code = envelope.Data.OperationID, envelope.Data.Status, envelope.Code
		if result.code == "" {
			result.code = envelope.Error.Code
		}
	}
	return result
}

func (fixture *planStopE2EFixture) assertPlanAndTasks(planID int64, planStatus string, tasks map[int64]string) {
	fixture.t.Helper()
	var actualPlan string
	if err := fixture.connection.QueryRowContext(context.Background(), "SELECT status FROM plans WHERE id = ?", planID).Scan(&actualPlan); err != nil {
		fixture.t.Fatal(err)
	}
	if actualPlan != planStatus {
		fixture.t.Fatalf("plan %d status=%q want=%q", planID, actualPlan, planStatus)
	}
	for taskID, expected := range tasks {
		var actual string
		if err := fixture.connection.QueryRowContext(context.Background(), "SELECT status FROM plan_tasks WHERE id = ?", taskID).Scan(&actual); err != nil {
			fixture.t.Fatal(err)
		}
		if actual != expected {
			fixture.t.Fatalf("task %d status=%q want=%q", taskID, actual, expected)
		}
	}
}

func (fixture *planStopE2EFixture) assertCount(query string, expected int64) {
	fixture.t.Helper()
	var actual int64
	if err := fixture.connection.QueryRowContext(context.Background(), query).Scan(&actual); err != nil {
		fixture.t.Fatal(err)
	}
	if actual != expected {
		fixture.t.Fatalf("count=%d want=%d query=%s", actual, expected, query)
	}
}

func (fixture *planStopE2EFixture) operationSummary() string {
	fixture.t.Helper()
	rows, err := fixture.connection.QueryContext(context.Background(), "SELECT type, status, version, COALESCE(error_json, '') FROM operations ORDER BY created_at")
	if err != nil {
		return err.Error()
	}
	defer rows.Close()
	var values []string
	for rows.Next() {
		var kind, status, failure string
		var version int64
		if err := rows.Scan(&kind, &status, &version, &failure); err != nil {
			return err.Error()
		}
		values = append(values, fmt.Sprintf("%s/%s/v%d/%s", kind, status, version, failure))
	}
	return strings.Join(values, ",")
}
