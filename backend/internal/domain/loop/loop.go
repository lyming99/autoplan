// Package loop defines the persistence-neutral state machine for one
// project's Loop runtime. It intentionally knows neither a database nor a
// scheduler: those concerns live at the application boundary.
package loop

import (
	"errors"
	"strings"
	"time"
)

var ErrInvalid = errors.New("loop state is invalid")

type Phase string

const (
	PhaseIdle         Phase = "idle"
	PhaseStopped      Phase = "stopped"
	PhaseRunning      Phase = "running"
	PhaseScan         Phase = "scan"
	PhaseGeneratePlan Phase = "generate-plan"
	PhaseExecuteTask  Phase = "execute-task"
	PhaseValidate     Phase = "validate"
	PhaseWaiting      Phase = "waiting"
	PhaseError        Phase = "error"
)

// State is the non-secret portion of a project's persisted Loop state. A
// store derives WorkspaceConfigured from project configuration; it never
// copies a workspace path into Operation results or events.
type State struct {
	ProjectID           int64
	WorkspaceConfigured bool
	IntervalSeconds     int64
	Running             bool
	Phase               Phase
	LastRunAt           *string
	LastError           *string
	Version             int64
}

func (state State) Validate() error {
	if state.ProjectID <= 0 || state.IntervalSeconds <= 0 || state.Version <= 0 || !state.Phase.Valid() ||
		!validTimestamp(state.LastRunAt) || !validSafeText(state.LastError, 1024) {
		return ErrInvalid
	}
	if state.Running && (state.Phase == PhaseIdle || state.Phase == PhaseStopped) {
		return ErrInvalid
	}
	return nil
}

func (phase Phase) Valid() bool {
	switch phase {
	case PhaseIdle, PhaseStopped, PhaseRunning, PhaseScan, PhaseGeneratePlan, PhaseExecuteTask, PhaseValidate, PhaseWaiting, PhaseError:
		return true
	default:
		return false
	}
}

func Start(state State) (State, bool, error) {
	if err := state.Validate(); err != nil || !state.WorkspaceConfigured {
		return State{}, false, ErrInvalid
	}
	if state.Running {
		return state, false, nil
	}
	state.Running = true
	state.Phase = PhaseRunning
	state.LastError = nil
	return state, true, nil
}

func Stop(state State) (State, bool, error) {
	if err := state.Validate(); err != nil {
		return State{}, false, err
	}
	if !state.Running && state.Phase == PhaseStopped {
		return state, false, nil
	}
	state.Running = false
	state.Phase = PhaseStopped
	return state, true, nil
}

func BeginRun(state State) (State, error) {
	if err := state.Validate(); err != nil || !state.WorkspaceConfigured {
		return State{}, ErrInvalid
	}
	state.Phase = PhaseScan
	state.LastError = nil
	return state, nil
}

func FinishRun(state State, now time.Time, runErr error) (State, error) {
	if err := state.Validate(); err != nil || now.IsZero() {
		return State{}, ErrInvalid
	}
	if !state.Running && state.Phase == PhaseStopped {
		return state, nil
	}
	if runErr != nil {
		state.Phase = PhaseError
		summary := "Loop run failed."
		state.LastError = &summary
		return state, nil
	}
	stamp := now.UTC().Format(time.RFC3339Nano)
	state.LastRunAt = &stamp
	state.LastError = nil
	if state.Running {
		state.Phase = PhaseWaiting
	} else if state.Phase != PhaseStopped {
		state.Phase = PhaseIdle
	}
	return state, nil
}

func validTimestamp(value *string) bool {
	if value == nil || !strings.HasSuffix(*value, "Z") {
		return value == nil
	}
	_, err := time.Parse(time.RFC3339Nano, *value)
	return err == nil
}

func validSafeText(value *string, limit int) bool {
	if value == nil {
		return true
	}
	return strings.TrimSpace(*value) != "" && len(*value) <= limit && !strings.ContainsRune(*value, 0)
}
