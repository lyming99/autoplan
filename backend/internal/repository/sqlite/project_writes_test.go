package sqlite

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"io"
	"strings"
	"sync"
	"testing"

	domainconfig "github.com/lyming99/autoplan/backend/internal/domain/config"
	domainproject "github.com/lyming99/autoplan/backend/internal/domain/project"
	"github.com/lyming99/autoplan/backend/internal/repository"
)

type writeTestGate struct{ err error }

func (gate writeTestGate) Check(context.Context) error { return gate.err }

type writeTestOwner struct{ id string }

func (owner writeTestOwner) DatabaseID() string { return owner.id }

func TestWriterRequiresLiveOwnerReadinessSchemaAndExplicitCopy(t *testing.T) {
	connection, cleanup := newScriptConnection(t, nil)
	defer cleanup()
	valid := []any{connection, writeTestGate{}, writeTestOwner{"fixture-id"}, true, SchemaVersion}
	tests := []struct {
		name string
		args []any
	}{
		{"connection", []any{nil, valid[1], valid[2], valid[3], valid[4]}},
		{"readiness", []any{valid[0], nil, valid[2], valid[3], valid[4]}},
		{"owner", []any{valid[0], valid[1], nil, valid[3], valid[4]}},
		{"owner id", []any{valid[0], valid[1], writeTestOwner{}, valid[3], valid[4]}},
		{"copy authorization", []any{valid[0], valid[1], valid[2], false, valid[4]}},
		{"schema", []any{valid[0], valid[1], valid[2], valid[3], 0}},
	}
	for _, item := range tests {
		t.Run(item.name, func(t *testing.T) {
			var connectionArg transactionConnection
			if item.args[0] != nil {
				connectionArg = item.args[0].(transactionConnection)
			}
			var gate repository.Readiness
			if item.args[1] != nil {
				gate = item.args[1].(repository.Readiness)
			}
			var owner repository.DatabaseOwnerProof
			if item.args[2] != nil {
				owner = item.args[2].(repository.DatabaseOwnerProof)
			}
			_, err := newWriter(connectionArg, gate, owner, item.args[3].(bool), item.args[4].(int))
			if !errors.Is(err, repository.ErrWriterUnauthorized) {
				t.Fatalf("authorization error = %v", err)
			}
		})
	}
}

func TestCreateProjectAndDefaultStateCommitAtomically(t *testing.T) {
	backend := &scriptBackend{steps: []scriptStep{
		execStep("INSERT INTO projects", 1, 7),
		execStep("INSERT INTO project_states", 1, 0),
	}}
	writer, cleanup := newTestWriter(t, backend)
	defer cleanup()
	var project repository.Project
	var state repository.ProjectState
	err := writer.Transact(context.Background(), func(transaction repository.WriteTransaction) error {
		var err error
		project, state, err = transaction.CreateProject(context.Background(), domainproject.Create{
			Name: "  Synthetic  ", WorkspacePath: "fixture/workspace", Description: "",
		}, "2026-07-11T00:00:00.000Z")
		return err
	})
	if err != nil || project.ID != 7 || project.Name != "Synthetic" || state.ProjectID != 7 ||
		state.Phase != "idle" || state.IntervalSeconds != 5 || state.Version != 1 || state.CodexReasoningEffort != nil {
		t.Fatalf("atomic create = %#v %#v %v", project, state, err)
	}
	backend.assertFinished(t, 1, 0)
}

func TestCanceledAndClosedWriterFailBeforeBeginningTransaction(t *testing.T) {
	backend := &scriptBackend{}
	writer, cleanup := newTestWriter(t, backend)
	defer cleanup()
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	if err := writer.Transact(cancelled, func(repository.WriteTransaction) error {
		return errors.New("must not run")
	}); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled error = %v", err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	if err := writer.Transact(context.Background(), func(repository.WriteTransaction) error { return nil }); !errors.Is(err, repository.ErrClosed) {
		t.Fatalf("closed error = %v", err)
	}
	backend.assertFinished(t, 0, 0)
}

func TestCreateMidpointAndCommitFailuresRollback(t *testing.T) {
	t.Run("midpoint", func(t *testing.T) {
		backend := &scriptBackend{steps: []scriptStep{execStep("INSERT INTO projects", 1, 9)}}
		writer, cleanup := newTestWriter(t, backend)
		defer cleanup()
		writer.faults.afterWrite = func(label string) error {
			if label == "projects:create" {
				return errors.New("synthetic")
			}
			return nil
		}
		err := writer.Transact(context.Background(), func(transaction repository.WriteTransaction) error {
			_, _, err := transaction.CreateProject(context.Background(), domainproject.Create{Name: "Synthetic"}, "2026-07-11T00:00:00.000Z")
			return err
		})
		if !errors.Is(err, repository.ErrTransaction) {
			t.Fatalf("midpoint error = %v", err)
		}
		backend.assertFinished(t, 0, 1)
	})
	t.Run("commit", func(t *testing.T) {
		backend := &scriptBackend{commitErr: errors.New("synthetic commit")}
		writer, cleanup := newTestWriter(t, backend)
		defer cleanup()
		err := writer.Transact(context.Background(), func(repository.WriteTransaction) error { return nil })
		if !errors.Is(err, repository.ErrCommit) {
			t.Fatalf("commit error = %v", err)
		}
	})
}

func TestLoopConfigCASNoopConflictAndSingleIncrement(t *testing.T) {
	base := defaultStateValues(11, 1)
	t.Run("change", func(t *testing.T) {
		backend := &scriptBackend{steps: []scriptStep{
			queryStep("FROM project_states WHERE project_id", projectStateTestColumns(), base),
			execStep("UPDATE project_states SET", 1, 0),
			execStep("UPDATE projects SET updated_at", 1, 0),
		}}
		writer, cleanup := newTestWriter(t, backend)
		defer cleanup()
		var next repository.ProjectState
		err := writer.Transact(context.Background(), func(transaction repository.WriteTransaction) error {
			config := domainconfig.DefaultLoopConfig()
			config.IntervalSeconds = 9
			var changed bool
			var err error
			next, changed, err = transaction.PutLoopConfig(context.Background(), 11, 1, config, "2026-07-11T00:00:01.000Z")
			if err == nil && !changed {
				return errors.New("expected change")
			}
			return err
		})
		if err != nil || next.Version != 2 || next.IntervalSeconds != 9 {
			t.Fatalf("CAS change = %#v %v", next, err)
		}
		backend.assertFinished(t, 1, 0)
	})
	t.Run("stale", func(t *testing.T) {
		backend := &scriptBackend{steps: []scriptStep{
			queryStep("FROM project_states WHERE project_id", projectStateTestColumns(), defaultStateValues(11, 2)),
		}}
		writer, cleanup := newTestWriter(t, backend)
		defer cleanup()
		err := writer.Transact(context.Background(), func(transaction repository.WriteTransaction) error {
			_, _, err := transaction.PutLoopConfig(context.Background(), 11, 1, domainconfig.DefaultLoopConfig(), "2026-07-11T00:00:01.000Z")
			return err
		})
		if !errors.Is(err, repository.ErrVersionConflict) {
			t.Fatalf("stale error = %v", err)
		}
		backend.assertFinished(t, 0, 1)
	})
	t.Run("same target", func(t *testing.T) {
		backend := &scriptBackend{steps: []scriptStep{
			queryStep("FROM project_states WHERE project_id", projectStateTestColumns(), base),
		}}
		writer, cleanup := newTestWriter(t, backend)
		defer cleanup()
		var changed bool
		err := writer.Transact(context.Background(), func(transaction repository.WriteTransaction) error {
			var err error
			_, changed, err = transaction.PutLoopConfig(context.Background(), 11, 1, domainconfig.DefaultLoopConfig(), "2026-07-11T00:00:01.000Z")
			return err
		})
		if err != nil || changed {
			t.Fatalf("no-op changed=%v error=%v", changed, err)
		}
		backend.assertFinished(t, 1, 0)
	})
}

func TestProjectAndConfigUpdateRollbackTogether(t *testing.T) {
	backend := &scriptBackend{steps: []scriptStep{
		queryStep("FROM projects WHERE id", []string{"id", "name", "workspace_path", "description", "created_at", "updated_at"}, []driver.Value{
			int64(3), "Before", "fixture/old", "description", "2026-07-11T00:00:00.000Z", "2026-07-11T00:00:00.000Z",
		}),
		execStep("UPDATE projects SET", 1, 0),
	}}
	writer, cleanup := newTestWriter(t, backend)
	defer cleanup()
	writer.faults.afterWrite = func(label string) error {
		if label == "projects:update" {
			return errors.New("synthetic midpoint")
		}
		return nil
	}
	name := "After"
	err := writer.Transact(context.Background(), func(transaction repository.WriteTransaction) error {
		if _, err := transaction.UpdateProject(context.Background(), 3, domainproject.Update{Name: &name}, "2026-07-11T00:00:01.000Z"); err != nil {
			return err
		}
		_, _, err := transaction.PutLoopConfig(context.Background(), 3, 1, domainconfig.DefaultLoopConfig(), "2026-07-11T00:00:01.000Z")
		return err
	})
	if !errors.Is(err, repository.ErrTransaction) {
		t.Fatalf("midpoint error = %v", err)
	}
	backend.assertFinished(t, 0, 1)
}

func TestResetLoopConfigUsesCASAndPreservesRuntimeFields(t *testing.T) {
	stateValues := defaultStateValues(12, 4)
	stateValues[1] = int64(0)
	stateValues[2] = "stopped"
	stateValues[3] = int64(12)
	stateValues[28] = "historical error"
	backend := &scriptBackend{steps: []scriptStep{
		queryStep("FROM project_states WHERE project_id", projectStateTestColumns(), stateValues),
		execStep("UPDATE project_states SET", 1, 0),
		execStep("UPDATE projects SET updated_at", 1, 0),
	}}
	writer, cleanup := newTestWriter(t, backend)
	defer cleanup()
	var reset repository.ProjectState
	err := writer.Transact(context.Background(), func(transaction repository.WriteTransaction) error {
		var changed bool
		var err error
		reset, changed, err = transaction.ResetLoopConfig(context.Background(), 12, 4, "2026-07-11T00:00:02.000Z")
		if err == nil && !changed {
			return errors.New("reset did not change")
		}
		return err
	})
	if err != nil || reset.Version != 5 || reset.IntervalSeconds != 5 || reset.Phase != "stopped" ||
		reset.LastError == nil || *reset.LastError != "historical error" {
		t.Fatalf("reset state = %#v %v", reset, err)
	}
	backend.assertFinished(t, 1, 0)
}

func TestSettingsCASAndIdempotencyStayInsideTransaction(t *testing.T) {
	backend := &scriptBackend{steps: []scriptStep{
		queryStep("FROM settings WHERE key", []string{"key", "value", "version"}, []driver.Value{"mcp.enabled", "true", int64(1)}),
		execStep("UPDATE settings SET value", 1, 0),
		queryStep("FROM operations WHERE idempotency_scope", idempotencyTestColumns()),
		execStep("INSERT INTO operations", 1, 0),
		execStep("UPDATE operations", 1, 0),
	}}
	writer, cleanup := newTestWriter(t, backend)
	defer cleanup()
	resultJSON := `{"activeProjectId":null}`
	err := writer.Transact(context.Background(), func(transaction repository.WriteTransaction) error {
		setting, changed, err := transaction.PutSetting(context.Background(), repository.SettingMutation{
			Key: "mcp.enabled", Value: "false", ExpectedVersion: 1,
		})
		if err != nil || !changed || setting.Version != 2 {
			return errors.New("setting CAS failed")
		}
		if err := transaction.ReserveIdempotency(context.Background(), repository.IdempotencyRecord{
			OperationID: "operation-1", Route: "projects:create", RequestID: "request-1",
			Scope: "session-1:projects:create", Key: "key-1", RequestHash: strings.Repeat("a", 64),
			CreatedAt: "2026-07-11T00:00:00.000Z", UpdatedAt: "2026-07-11T00:00:00.000Z",
		}); err != nil {
			return err
		}
		return transaction.CompleteIdempotency(context.Background(), "session-1:projects:create", "key-1",
			"succeeded", &resultJSON, nil, "2026-07-11T00:00:01.000Z")
	})
	if err != nil {
		t.Fatal(err)
	}
	backend.assertFinished(t, 1, 0)
}

func TestMissingResourcesVersionAndIdempotencyConflictsAreStable(t *testing.T) {
	t.Run("missing project", func(t *testing.T) {
		backend := &scriptBackend{steps: []scriptStep{
			queryStep("FROM projects WHERE id", []string{"id", "name", "workspace_path", "description", "created_at", "updated_at"}),
		}}
		writer, cleanup := newTestWriter(t, backend)
		defer cleanup()
		err := writer.Transact(context.Background(), func(transaction repository.WriteTransaction) error {
			_, err := transaction.UpdateProject(context.Background(), 404, domainproject.Update{}, "2026-07-11T00:00:01.000Z")
			return err
		})
		if !errors.Is(err, repository.ErrNotFound) {
			t.Fatalf("missing error = %v", err)
		}
		backend.assertFinished(t, 0, 1)
	})
	t.Run("version required", func(t *testing.T) {
		backend := &scriptBackend{}
		writer, cleanup := newTestWriter(t, backend)
		defer cleanup()
		err := writer.Transact(context.Background(), func(transaction repository.WriteTransaction) error {
			_, _, err := transaction.PutSetting(context.Background(), repository.SettingMutation{Key: "mcp.enabled", Value: "false"})
			return err
		})
		if !errors.Is(err, repository.ErrVersionRequired) {
			t.Fatalf("version error = %v", err)
		}
		backend.assertFinished(t, 0, 1)
	})
	t.Run("idempotency key reused", func(t *testing.T) {
		projectID := int64(8)
		backend := &scriptBackend{steps: []scriptStep{
			queryStep("FROM operations WHERE idempotency_scope", idempotencyTestColumns(), []driver.Value{
				"operation-existing", projectID, "projects:update", "request-existing", "session:projects", "same-key",
				strings.Repeat("b", 64), "succeeded", `{}`, nil, int64(2),
				"2026-07-11T00:00:00.000Z", "2026-07-11T00:00:01.000Z",
			}),
		}}
		writer, cleanup := newTestWriter(t, backend)
		defer cleanup()
		err := writer.Transact(context.Background(), func(transaction repository.WriteTransaction) error {
			return transaction.ReserveIdempotency(context.Background(), repository.IdempotencyRecord{
				OperationID: "operation-new", ProjectID: &projectID, Route: "projects:update", RequestID: "request-new",
				Scope: "session:projects", Key: "same-key", RequestHash: strings.Repeat("a", 64),
				CreatedAt: "2026-07-11T00:00:02.000Z", UpdatedAt: "2026-07-11T00:00:02.000Z",
			})
		})
		if !errors.Is(err, repository.ErrIdempotencyKeyReuse) {
			t.Fatalf("idempotency error = %v", err)
		}
		backend.assertFinished(t, 0, 1)
	})
}

func TestDomainNormalizationPreservesFrozenDefaultsAndNullability(t *testing.T) {
	created := domainproject.NormalizeCreate(domainproject.Create{Name: "  "})
	if created.Name != domainproject.DefaultName {
		t.Fatalf("default project name = %q", created.Name)
	}
	environment := domainconfig.NormalizeEnvVars([]domainconfig.EnvVar{
		{Name: " A ", Value: "one"}, {Name: "A", Value: "two"}, {Name: " ", Value: "discarded"},
	})
	if environment != `[{"name":"A","value":"one"}]` {
		t.Fatal("environment normalization drifted")
	}
	provider := "OPENAI"
	config, err := domainconfig.NormalizeLoopConfig(domainconfig.LoopConfig{
		PlanGenerationStrategy: "BUILTIN-LLM-STRUCTURED", PlanGenerationProvider: &provider,
		PlanExecutionStrategy: "invalid", EnvVars: environment,
	})
	if err != nil || config.PlanGenerationProvider == nil || *config.PlanGenerationProvider != "openai" ||
		config.PlanExecutionStrategy != domainconfig.DefaultPlanExecutionStrategy || config.IntervalSeconds != 5 {
		t.Fatalf("config normalization = %#v %v", config, err)
	}
	state, err := domainconfig.DefaultProjectState(1, "2026-07-11T00:00:00.000Z")
	if err != nil || state.CodexReasoningEffort != nil || state.Version != 1 {
		t.Fatalf("default state = %#v %v", state, err)
	}
}

func TestDeleteRelationPolicyRejectsBeforeMutationAndDeletesManagedTree(t *testing.T) {
	t.Run("blocked", func(t *testing.T) {
		backend := &scriptBackend{steps: []scriptStep{
			queryStep("SELECT project_states.running", []string{"running"}, []driver.Value{int64(0)}),
			queryStep("FROM operations", []string{"count"}, []driver.Value{int64(1)}),
		}}
		writer, cleanup := newTestWriter(t, backend)
		defer cleanup()
		err := writer.Transact(context.Background(), func(transaction repository.WriteTransaction) error {
			return transaction.DeleteProject(context.Background(), 4)
		})
		if !errors.Is(err, repository.ErrRelationConflict) {
			t.Fatalf("relation error = %v", err)
		}
		backend.assertFinished(t, 0, 1)
	})
	t.Run("managed tree", func(t *testing.T) {
		steps := []scriptStep{queryStep("SELECT project_states.running", []string{"running"}, []driver.Value{int64(0)})}
		steps = append(steps, queryStep("FROM operations", []string{"count"}, []driver.Value{int64(0)}))
		for _, marker := range []string{
			"DELETE FROM event_outbox", "DELETE FROM operations", "DELETE FROM event_retention_watermarks", "DELETE FROM project_revisions",
			"DELETE FROM attachments", "DELETE FROM intake_plan_links",
			"DELETE FROM feedback", "DELETE FROM requirements", "DELETE FROM plans", "DELETE FROM scripts", "DELETE FROM executors",
			"DELETE FROM ai_configs", "DELETE FROM claude_cli_configs", "DELETE FROM secret_refs", "DELETE FROM projects",
		} {
			steps = append(steps, execStep(marker, 1, 0))
		}
		backend := &scriptBackend{steps: steps}
		writer, cleanup := newTestWriter(t, backend)
		defer cleanup()
		if err := writer.Transact(context.Background(), func(transaction repository.WriteTransaction) error {
			return transaction.DeleteProject(context.Background(), 4)
		}); err != nil {
			t.Fatal(err)
		}
		backend.assertFinished(t, 1, 0)
	})
}

func TestConcurrentCASAllowsOnlyOneCommit(t *testing.T) {
	backends := []*scriptBackend{
		{steps: []scriptStep{
			queryStep("FROM project_states WHERE project_id", projectStateTestColumns(), defaultStateValues(5, 1)),
			execStep("UPDATE project_states SET", 1, 0),
			execStep("UPDATE projects SET updated_at", 1, 0),
		}},
		{steps: []scriptStep{
			queryStep("FROM project_states WHERE project_id", projectStateTestColumns(), defaultStateValues(5, 2)),
		}},
	}
	errorsSeen := make(chan error, 2)
	var group sync.WaitGroup
	for index, backend := range backends {
		writer, cleanup := newTestWriter(t, backend)
		defer cleanup()
		group.Add(1)
		go func(index int, writer *Writer) {
			defer group.Done()
			errorsSeen <- writer.Transact(context.Background(), func(transaction repository.WriteTransaction) error {
				config := domainconfig.DefaultLoopConfig()
				config.IntervalSeconds = 10
				_, _, err := transaction.PutLoopConfig(context.Background(), 5, 1, config, "2026-07-11T00:00:01.000Z")
				return err
			})
		}(index, writer)
	}
	group.Wait()
	close(errorsSeen)
	var successes, conflicts int
	for err := range errorsSeen {
		if err == nil {
			successes++
		} else if errors.Is(err, repository.ErrVersionConflict) {
			conflicts++
		} else {
			t.Fatalf("unexpected concurrent error: %v", err)
		}
	}
	if successes != 1 || conflicts != 1 {
		t.Fatalf("successes=%d conflicts=%d", successes, conflicts)
	}
}

func newTestWriter(t *testing.T, backend *scriptBackend) (*Writer, func()) {
	t.Helper()
	connection, cleanup := newScriptConnection(t, backend)
	writer, err := newWriter(connection, writeTestGate{}, writeTestOwner{"fixture-id"}, true, SchemaVersion)
	if err != nil {
		cleanup()
		t.Fatal(err)
	}
	return writer, func() { _ = writer.Close(); cleanup() }
}

type sqlBeginner struct{ database *sql.DB }

func (connection sqlBeginner) BeginTx(ctx context.Context, options *sql.TxOptions) (*sql.Tx, error) {
	return connection.database.BeginTx(ctx, options)
}

func newScriptConnection(t *testing.T, backend *scriptBackend) (transactionConnection, func()) {
	t.Helper()
	if backend == nil {
		backend = &scriptBackend{}
	}
	database := sql.OpenDB(scriptConnector{backend: backend})
	database.SetMaxOpenConns(1)
	return sqlBeginner{database}, func() { _ = database.Close() }
}

type scriptStep struct {
	kind     string
	contains string
	columns  []string
	rows     [][]driver.Value
	affected int64
	insertID int64
	err      error
}

func execStep(contains string, affected, insertID int64) scriptStep {
	return scriptStep{kind: "exec", contains: contains, affected: affected, insertID: insertID}
}

func queryStep(contains string, columns []string, rows ...[]driver.Value) scriptStep {
	return scriptStep{kind: "query", contains: contains, columns: columns, rows: rows}
}

type scriptBackend struct {
	mu        sync.Mutex
	steps     []scriptStep
	execArgs  [][]driver.NamedValue
	commits   int
	rollbacks int
	commitErr error
}

func (backend *scriptBackend) next(kind, query string) (scriptStep, error) {
	backend.mu.Lock()
	defer backend.mu.Unlock()
	if len(backend.steps) == 0 {
		return scriptStep{}, errors.New("unexpected SQL")
	}
	step := backend.steps[0]
	backend.steps = backend.steps[1:]
	if step.kind != kind || !strings.Contains(query, step.contains) {
		return scriptStep{}, errors.New("SQL order mismatch")
	}
	return step, step.err
}

func (backend *scriptBackend) assertFinished(t *testing.T, commits, rollbacks int) {
	t.Helper()
	backend.mu.Lock()
	defer backend.mu.Unlock()
	if len(backend.steps) != 0 || backend.commits != commits || backend.rollbacks != rollbacks {
		t.Fatalf("steps=%d commits=%d rollbacks=%d", len(backend.steps), backend.commits, backend.rollbacks)
	}
}

func (backend *scriptBackend) recordedExecArgs() [][]driver.NamedValue {
	backend.mu.Lock()
	defer backend.mu.Unlock()
	result := make([][]driver.NamedValue, len(backend.execArgs))
	for index := range backend.execArgs {
		result[index] = append([]driver.NamedValue(nil), backend.execArgs[index]...)
	}
	return result
}

type scriptConnector struct{ backend *scriptBackend }

func (connector scriptConnector) Connect(context.Context) (driver.Conn, error) {
	return &scriptConnection{backend: connector.backend}, nil
}
func (connector scriptConnector) Driver() driver.Driver { return scriptDriver{} }

type scriptDriver struct{}

func (scriptDriver) Open(string) (driver.Conn, error) { return nil, errors.New("connector required") }

type scriptConnection struct{ backend *scriptBackend }

func (connection *scriptConnection) Prepare(string) (driver.Stmt, error) { return nil, driver.ErrSkip }
func (connection *scriptConnection) Close() error                        { return nil }
func (connection *scriptConnection) Begin() (driver.Tx, error) {
	return connection.BeginTx(context.Background(), driver.TxOptions{})
}
func (connection *scriptConnection) BeginTx(context.Context, driver.TxOptions) (driver.Tx, error) {
	return &scriptTransaction{backend: connection.backend}, nil
}
func (connection *scriptConnection) ExecContext(_ context.Context, query string, arguments []driver.NamedValue) (driver.Result, error) {
	connection.backend.mu.Lock()
	connection.backend.execArgs = append(connection.backend.execArgs, append([]driver.NamedValue(nil), arguments...))
	connection.backend.mu.Unlock()
	step, err := connection.backend.next("exec", query)
	if err != nil {
		return nil, err
	}
	return scriptResult{affected: step.affected, insertID: step.insertID}, nil
}
func (connection *scriptConnection) QueryContext(_ context.Context, query string, _ []driver.NamedValue) (driver.Rows, error) {
	step, err := connection.backend.next("query", query)
	if err != nil {
		return nil, err
	}
	return &scriptRows{columns: step.columns, rows: step.rows}, nil
}

type scriptTransaction struct{ backend *scriptBackend }

func (transaction *scriptTransaction) Commit() error {
	transaction.backend.mu.Lock()
	defer transaction.backend.mu.Unlock()
	transaction.backend.commits++
	return transaction.backend.commitErr
}
func (transaction *scriptTransaction) Rollback() error {
	transaction.backend.mu.Lock()
	defer transaction.backend.mu.Unlock()
	transaction.backend.rollbacks++
	return nil
}

type scriptResult struct{ affected, insertID int64 }

func (result scriptResult) LastInsertId() (int64, error) { return result.insertID, nil }
func (result scriptResult) RowsAffected() (int64, error) { return result.affected, nil }

type scriptRows struct {
	columns []string
	rows    [][]driver.Value
	index   int
}

func (rows *scriptRows) Columns() []string { return rows.columns }
func (rows *scriptRows) Close() error      { return nil }
func (rows *scriptRows) Next(destination []driver.Value) error {
	if rows.index >= len(rows.rows) {
		return io.EOF
	}
	copy(destination, rows.rows[rows.index])
	rows.index++
	return nil
}

func projectStateTestColumns() []string {
	return strings.Split(strings.ReplaceAll(projectStateSelectColumns, "\n", ""), ",")
}

func defaultStateValues(projectID, version int64) []driver.Value {
	return []driver.Value{
		projectID, int64(0), "idle", int64(5), "", "", "codex", "", "medium",
		"external-cli-markdown", nil, "", "", nil, "", "", "", int64(0),
		"external-cli", nil, "", "", nil, "", "", "", int64(0),
		nil, nil, "", "2026-07-11T00:00:00.000Z", version,
	}
}

func idempotencyTestColumns() []string {
	return []string{"operation_id", "project_id", "type", "request_id", "idempotency_scope", "idempotency_key",
		"request_hash", "status", "result_json", "error_json", "version", "created_at", "updated_at"}
}
