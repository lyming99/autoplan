package bootstrap

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/lyming99/autoplan/backend/internal/platform/instance"
	"github.com/lyming99/autoplan/backend/internal/runtime/lifecycle"
)

func TestDatabaseStartupGatesReadinessAndClosesConnectionBeforeOwner(t *testing.T) {
	readiness, err := NewReadiness(ReadinessDatabaseOwner, ReadinessMigrations, ReadinessDatabase)
	if err != nil {
		t.Fatal(err)
	}
	events := make([]string, 0, 8)
	owner := &fakeDatabaseOwner{id: "database-id", events: &events}
	connection := &fakeStartupConnection{events: &events}
	runtime, err := StartDatabase(context.Background(), DatabaseStartupOptions{
		Target: filepath.Join(t.TempDir(), "database.sqlite.copy"), DriverName: "fixture-driver",
		Readiness: readiness,
		Dependencies: DatabaseStartupDependencies{
			Acquire: func(context.Context, instance.DatabaseLockOptions) (DatabaseOwner, error) {
				events = append(events, "owner_acquired")
				return owner, nil
			},
			Open: func(context.Context, string, string) (StartupConnection, error) {
				if readiness.Snapshot().Dependencies[0].State != DependencyReady || readiness.Ready() {
					t.Fatal("connection opened before owner-only readiness state")
				}
				events = append(events, "connection_opened")
				return connection, nil
			},
			Migrate: func(context.Context, StartupConnection) error {
				events = append(events, "migrated")
				return nil
			},
			Validate: func(context.Context, StartupConnection) error {
				if readiness.Ready() {
					t.Fatal("readiness opened before schema validation")
				}
				events = append(events, "schema_validated")
				return nil
			},
			Audit: func(context.Context, StartupConnection) error {
				if readiness.Ready() {
					t.Fatal("readiness opened before audit")
				}
				events = append(events, "audited")
				return nil
			},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !readiness.Ready() || runtime.DatabaseID() != "database-id" {
		t.Fatalf("database runtime not ready: %#v", readiness.Snapshot())
	}
	if err := runtime.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	want := "owner_acquired,connection_opened,migrated,schema_validated,audited,connection_closed,owner_released"
	if strings.Join(events, ",") != want {
		t.Fatalf("database lifecycle order = %v", events)
	}
}

func TestDatabaseStartupFailureIsClosedAndNeverReady(t *testing.T) {
	readiness, err := NewReadiness(ReadinessDatabaseOwner, ReadinessMigrations, ReadinessDatabase)
	if err != nil {
		t.Fatal(err)
	}
	events := make([]string, 0, 5)
	_, err = StartDatabase(context.Background(), DatabaseStartupOptions{
		Target: filepath.Join(t.TempDir(), "database.sqlite.copy"), DriverName: "fixture-driver",
		Readiness: readiness,
		Dependencies: DatabaseStartupDependencies{
			Acquire: func(context.Context, instance.DatabaseLockOptions) (DatabaseOwner, error) {
				events = append(events, "owner_acquired")
				return &fakeDatabaseOwner{id: "database-id", events: &events}, nil
			},
			Open: func(context.Context, string, string) (StartupConnection, error) {
				events = append(events, "connection_opened")
				return &fakeStartupConnection{events: &events}, nil
			},
			Migrate: func(context.Context, StartupConnection) error {
				events = append(events, "migration_failed")
				return errors.New("synthetic")
			},
			Validate: func(context.Context, StartupConnection) error { return nil },
			Audit:    func(context.Context, StartupConnection) error { return nil },
		},
	})
	if !errors.Is(err, ErrDatabaseMigration) || readiness.Ready() {
		t.Fatalf("failed startup = %v, %#v", err, readiness.Snapshot())
	}
	want := "owner_acquired,connection_opened,migration_failed,connection_closed,owner_released"
	if strings.Join(events, ",") != want {
		t.Fatalf("failure cleanup order = %v", events)
	}
	snapshot := readiness.Snapshot()
	if snapshot.Dependencies[0].State != DependencyReady ||
		snapshot.Dependencies[1].State != DependencyFailed ||
		snapshot.Dependencies[2].State != DependencyPending {
		t.Fatalf("failure readiness drifted: %#v", snapshot)
	}
}

func TestDatabaseOwnerConflictDoesNotOpenConnection(t *testing.T) {
	readiness, err := NewReadiness(ReadinessDatabaseOwner, ReadinessMigrations, ReadinessDatabase)
	if err != nil {
		t.Fatal(err)
	}
	_, err = StartDatabase(context.Background(), DatabaseStartupOptions{
		Target: filepath.Join(t.TempDir(), "database.sqlite.copy"), DriverName: "fixture-driver",
		Readiness: readiness,
		Dependencies: DatabaseStartupDependencies{
			Acquire: func(context.Context, instance.DatabaseLockOptions) (DatabaseOwner, error) {
				return nil, instance.ErrDatabaseOwnerLocked
			},
			Open: func(context.Context, string, string) (StartupConnection, error) {
				t.Fatal("connection opened after owner conflict")
				return nil, nil
			},
			Migrate:  func(context.Context, StartupConnection) error { return nil },
			Validate: func(context.Context, StartupConnection) error { return nil },
			Audit:    func(context.Context, StartupConnection) error { return nil },
		},
	})
	if !errors.Is(err, instance.ErrDatabaseOwnerLocked) || readiness.Ready() {
		t.Fatalf("owner conflict = %v, %#v", err, readiness.Snapshot())
	}
	status := readiness.Snapshot().Dependencies[0]
	if status.State != DependencyFailed || status.Reason != "owner_locked" {
		t.Fatalf("owner conflict readiness = %#v", status)
	}
}

func TestDatabaseReadinessGateCannotBypassDatabaseStages(t *testing.T) {
	readiness, err := NewDatabaseReadiness()
	if err != nil {
		t.Fatal(err)
	}
	gate, err := readiness.Gate("application", "listener")
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"configuration", "prerequisites"} {
		if err := readiness.MarkReady(name); err != nil {
			t.Fatal(err)
		}
	}
	if !errors.Is(gate.Check(context.Background()), ErrNotReady) {
		t.Fatal("database gate opened before owner lock")
	}
	for _, name := range []string{ReadinessDatabaseOwner, ReadinessMigrations} {
		if err := readiness.MarkReady(name); err != nil {
			t.Fatal(err)
		}
	}
	if !errors.Is(gate.Check(context.Background()), ErrNotReady) {
		t.Fatal("database gate opened before schema/audit")
	}
	if err := readiness.MarkReady(ReadinessDatabase); err != nil {
		t.Fatal(err)
	}
	if err := gate.Check(context.Background()); err != nil {
		t.Fatalf("database gate remained closed: %v", err)
	}
	readiness.BeginShutdown()
	if !errors.Is(gate.Check(context.Background()), ErrReadinessShutting) {
		t.Fatal("database gate remained ready during shutdown")
	}
}

type fakeDatabaseOwner struct {
	id     string
	events *[]string
}

func (owner *fakeDatabaseOwner) DatabaseID() string { return owner.id }

func (owner *fakeDatabaseOwner) Close(context.Context) error {
	*owner.events = append(*owner.events, "owner_released")
	return nil
}

type fakeStartupConnection struct{ events *[]string }

func (connection *fakeStartupConnection) Close() error {
	*connection.events = append(*connection.events, "connection_closed")
	return nil
}

func TestLifecycleShutdownIsTerminalReverseOrderedAndIdempotent(t *testing.T) {
	readiness, err := NewReadiness("configuration", "application", "listener")
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"configuration", "application", "listener"} {
		if err := readiness.MarkReady(name); err != nil {
			t.Fatal(err)
		}
	}
	if !readiness.Ready() {
		t.Fatal("readiness did not become ready")
	}
	manager, err := lifecycle.New(readiness, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	closed := make([]string, 0, 3)
	for _, name := range []string{"first", "second", "third"} {
		name := name
		if err := manager.Add(lifecycle.CloserFunc(func(context.Context) error {
			mu.Lock()
			closed = append(closed, name)
			mu.Unlock()
			return nil
		})); err != nil {
			t.Fatal(err)
		}
	}
	if err := manager.Shutdown(); err != nil {
		t.Fatal(err)
	}
	if err := manager.Shutdown(); err != nil {
		t.Fatal(err)
	}
	if strings.Join(closed, ",") != "third,second,first" {
		t.Fatalf("shutdown order drifted: %v", closed)
	}
	if readiness.Ready() || !readiness.ShuttingDown() || readiness.Snapshot().State != "shutting_down" {
		t.Fatal("shutdown did not make readiness terminal")
	}
	if err := manager.Add(lifecycle.CloserFunc(func(context.Context) error { return nil })); !errors.Is(err, lifecycle.ErrShutdownStarted) {
		t.Fatalf("late resource registration error=%v", err)
	}
}

func TestRunServerLifecycle(t *testing.T) {
	temporaryRoot := t.TempDir()
	runtimeDirectory := filepath.Join(temporaryRoot, "runtime")
	stdout := newReadinessWriter()
	var stderr bytes.Buffer
	ctx, cancel := context.WithCancel(context.Background())
	result := make(chan int, 1)
	go func() {
		result <- RunServerCommand(ctx, nil, []string{
			"AUTOPLAN_SIDECAR_LISTEN_HOST=127.0.0.1",
			"AUTOPLAN_SIDECAR_LISTEN_PORT=0",
			"AUTOPLAN_SIDECAR_ALLOWED_ORIGINS=http://127.0.0.1:43124",
			"AUTOPLAN_SIDECAR_RUNTIME_DIR=" + runtimeDirectory,
			"AUTOPLAN_SIDECAR_RUNTIME_TARGET_KIND=temporary",
			"AUTOPLAN_SIDECAR_SHUTDOWN_TIMEOUT=2s",
		}, stdout, &stderr)
	}()

	line := waitReadinessLine(t, stdout.lines, 10*time.Second)
	var message readinessMessage
	if err := json.Unmarshal([]byte(line), &message); err != nil {
		cancel()
		t.Fatalf("readiness output is not JSON: %v", err)
	}
	if message.Version != 1 || message.Type != "autoplan_server_ready" || !message.Ready ||
		message.Host != "127.0.0.1" || message.Port <= 0 || message.PID != os.Getpid() {
		cancel()
		t.Fatalf("readiness message drifted: %#v raw=%s stderr=%s", message, line, stderr.String())
	}

	client := &http.Client{Timeout: 2 * time.Second}
	assertLiveProbe(t, client, message.Port, "/healthz", "ok")
	assertLiveProbe(t, client, message.Port, "/readyz", "ready")
	cancel()
	select {
	case code := <-result:
		if code != exitOK {
			t.Fatalf("server exit=%d stderr=%s", code, stderr.String())
		}
	case <-time.After(10 * time.Second):
		t.Fatal("server did not complete graceful shutdown")
	}

	if lines := strings.Split(strings.TrimSpace(stdout.String()), "\n"); len(lines) != 1 || lines[0] != line {
		t.Fatalf("server emitted more than one readiness line: %q", stdout.String())
	}
	if _, err := os.Stat(runtimeDirectory); !os.IsNotExist(err) {
		t.Fatalf("temporary runtime lock directory was not cleaned: %v", err)
	}
	for _, logLine := range strings.Split(strings.TrimSpace(stderr.String()), "\n") {
		if logLine == "" {
			continue
		}
		var event map[string]any
		if err := json.Unmarshal([]byte(logLine), &event); err != nil {
			t.Fatalf("server log is not JSON: %v", err)
		}
		if strings.Contains(logLine, runtimeDirectory) || strings.Contains(logLine, temporaryRoot) {
			t.Fatal("server log contains a temporary absolute path")
		}
	}
}

type readinessWriter struct {
	mu      sync.Mutex
	buffer  bytes.Buffer
	lines   chan string
	pending string
}

func newReadinessWriter() *readinessWriter {
	return &readinessWriter{lines: make(chan string, 2)}
}

func (writer *readinessWriter) Write(content []byte) (int, error) {
	writer.mu.Lock()
	defer writer.mu.Unlock()
	_, _ = writer.buffer.Write(content)
	writer.pending += string(content)
	for {
		index := strings.IndexByte(writer.pending, '\n')
		if index < 0 {
			break
		}
		line := strings.TrimSuffix(writer.pending[:index], "\r")
		writer.pending = writer.pending[index+1:]
		writer.lines <- line
	}
	return len(content), nil
}

func (writer *readinessWriter) String() string {
	writer.mu.Lock()
	defer writer.mu.Unlock()
	return writer.buffer.String()
}

func waitReadinessLine(t *testing.T, lines <-chan string, timeout time.Duration) string {
	t.Helper()
	select {
	case line := <-lines:
		return line
	case <-time.After(timeout):
		t.Fatal("timed out waiting for readiness output")
		return ""
	}
}

func assertLiveProbe(t *testing.T, client *http.Client, port int, path, expected string) {
	t.Helper()
	response, err := client.Get("http://127.0.0.1:" + integerString(port) + path)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	content, err := io.ReadAll(io.LimitReader(response.Body, 4096))
	if err != nil {
		t.Fatal(err)
	}
	var body map[string]any
	if err := json.Unmarshal(content, &body); err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusOK || body["status"] != expected || body["request_id"] == "" {
		t.Fatalf("probe %s drifted: status=%d body=%s", path, response.StatusCode, content)
	}
}

func integerString(value int) string {
	const digits = "0123456789"
	if value == 0 {
		return "0"
	}
	result := make([]byte, 0, 5)
	for value > 0 {
		result = append(result, digits[value%10])
		value /= 10
	}
	for left, right := 0, len(result)-1; left < right; left, right = left+1, right-1 {
		result[left], result[right] = result[right], result[left]
	}
	return string(result)
}
