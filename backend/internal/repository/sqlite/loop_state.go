package sqlite

import (
	"context"
	"database/sql"
	"time"

	domainloop "github.com/lyming99/autoplan/backend/internal/domain/loop"
	"github.com/lyming99/autoplan/backend/internal/repository"
)

// LoopStateStore is the bounded live-SQL adapter for the Loop state machine.
// It shares Writer ownership and never opens a second database connection.
type LoopStateStore struct{ writer *Writer }

func NewLoopStateStore(writer *Writer) *LoopStateStore { return &LoopStateStore{writer: writer} }

func (store *LoopStateStore) Check(ctx context.Context) error {
	if store == nil || store.writer == nil {
		return repository.ErrNotConfigured
	}
	return store.writer.Check(ctx)
}

func (store *LoopStateStore) Get(ctx context.Context, projectID int64) (domainloop.State, bool, error) {
	var state domainloop.State
	var found bool
	err := store.writer.Transact(ctx, func(transaction repository.WriteTransaction) error {
		concrete, ok := transaction.(*writeTransaction)
		if !ok {
			return repository.ErrTransaction
		}
		var workspace string
		var running int64
		var lastError sql.NullString
		err := concrete.tx.QueryRowContext(ctx, `SELECT states.project_id, projects.workspace_path,
			states.interval_seconds, states.running, states.phase, states.last_error, states.version
			FROM project_states AS states JOIN projects ON projects.id = states.project_id
			WHERE states.project_id = ?`, projectID).Scan(
			&state.ProjectID, &workspace, &state.IntervalSeconds, &running, &state.Phase, &lastError, &state.Version,
		)
		if err == sql.ErrNoRows {
			return nil
		}
		if err != nil {
			return safeSQLError(ctx, err)
		}
		state.WorkspaceConfigured = workspace != ""
		state.Running = running != 0
		if lastError.Valid && lastError.String != "" {
			value := lastError.String
			state.LastError = &value
		}
		found = true
		return state.Validate()
	})
	return state, found, err
}

func (store *LoopStateStore) ListRunning(ctx context.Context) ([]domainloop.State, error) {
	states := make([]domainloop.State, 0)
	err := store.writer.Transact(ctx, func(transaction repository.WriteTransaction) error {
		concrete, ok := transaction.(*writeTransaction)
		if !ok {
			return repository.ErrTransaction
		}
		rows, err := concrete.tx.QueryContext(ctx, `SELECT states.project_id, projects.workspace_path,
			states.interval_seconds, states.running, states.phase, states.last_error, states.version
			FROM project_states AS states JOIN projects ON projects.id = states.project_id
			WHERE states.running = 1 ORDER BY states.project_id`)
		if err != nil {
			return safeSQLError(ctx, err)
		}
		defer rows.Close()
		for rows.Next() {
			var state domainloop.State
			var workspace string
			var running int64
			var lastError sql.NullString
			if err := rows.Scan(&state.ProjectID, &workspace, &state.IntervalSeconds, &running, &state.Phase, &lastError, &state.Version); err != nil {
				return safeSQLError(ctx, err)
			}
			state.WorkspaceConfigured, state.Running = workspace != "", running != 0
			if lastError.Valid && lastError.String != "" {
				value := lastError.String
				state.LastError = &value
			}
			if err := state.Validate(); err != nil {
				return repository.ErrSchemaDrift
			}
			states = append(states, state)
		}
		return rows.Err()
	})
	return states, err
}

func (store *LoopStateStore) Save(ctx context.Context, state domainloop.State, expectedVersion int64) (domainloop.State, bool, error) {
	if err := state.Validate(); err != nil || expectedVersion <= 0 || state.Version != expectedVersion {
		return domainloop.State{}, false, repository.ErrVersionConflict
	}
	changed := false
	err := store.writer.Transact(ctx, func(transaction repository.WriteTransaction) error {
		concrete, ok := transaction.(*writeTransaction)
		if !ok {
			return repository.ErrTransaction
		}
		result, err := concrete.tx.ExecContext(ctx, `UPDATE project_states
			SET running = ?, phase = ?, last_error = ?, updated_at = ?, version = version + 1
			WHERE project_id = ? AND version = ?`, boolInteger(state.Running), state.Phase, state.LastError,
			time.Now().UTC().Format("2006-01-02T15:04:05.000Z"), state.ProjectID, expectedVersion)
		if err != nil {
			return safeSQLError(ctx, err)
		}
		count, err := result.RowsAffected()
		if err != nil {
			return repository.ErrTransaction
		}
		if count != 1 {
			return repository.ErrVersionConflict
		}
		changed = true
		state.Version++
		return concrete.wrote("project_states:loop-runtime")
	})
	return state, changed, err
}

func boolInteger(value bool) int64 {
	if value {
		return 1
	}
	return 0
}
