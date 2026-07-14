package sqlite

import (
	"context"
	"database/sql/driver"
	"testing"

	domainloop "github.com/lyming99/autoplan/backend/internal/domain/loop"
	"github.com/lyming99/autoplan/backend/internal/repository"
)

func TestLoopStateStoreReadsAndCASUpdatesRuntimeState(t *testing.T) {
	backend := &scriptBackend{steps: []scriptStep{
		queryStep("FROM project_states AS states", []string{
			"project_id", "workspace_path", "interval_seconds", "running", "phase", "last_error", "version",
		}, []driver.Value{int64(7), `D:\fixture`, int64(5), int64(0), "idle", nil, int64(3)}),
		execStep("UPDATE project_states", 1, 0),
	}}
	writer, cleanup := newTestWriter(t, backend)
	defer cleanup()
	store := NewLoopStateStore(writer)
	state, found, err := store.Get(context.Background(), 7)
	if err != nil || !found || state.ProjectID != 7 || !state.WorkspaceConfigured || state.Running || state.Version != 3 {
		t.Fatalf("state=%#v found=%t err=%v", state, found, err)
	}
	state.Running, state.Phase = true, domainloop.PhaseRunning
	saved, changed, err := store.Save(context.Background(), state, 3)
	if err != nil || !changed || !saved.Running || saved.Version != 4 {
		t.Fatalf("saved=%#v changed=%t err=%v", saved, changed, err)
	}
	backend.assertFinished(t, 2, 0)
}

func TestLoopStateStoreRejectsStaleCAS(t *testing.T) {
	backend := &scriptBackend{steps: []scriptStep{execStep("UPDATE project_states", 0, 0)}}
	writer, cleanup := newTestWriter(t, backend)
	defer cleanup()
	state := domainloop.State{
		ProjectID: 7, WorkspaceConfigured: true, IntervalSeconds: 5,
		Running: true, Phase: domainloop.PhaseRunning, Version: 2,
	}
	_, _, err := NewLoopStateStore(writer).Save(context.Background(), state, 2)
	if err == nil || err != repository.ErrVersionConflict {
		t.Fatalf("stale error=%v", err)
	}
}
