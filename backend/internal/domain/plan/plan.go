// Package plan owns the persistence-neutral Plan and PlanTask invariants.
//
// File locations, CLI sessions, credentials, and SQL rows deliberately do
// not cross this boundary. SourceRef is an opaque compatibility reference;
// callers must not interpret it as an operating-system path.
package plan

import (
	"errors"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

var (
	ErrInvalid       = errors.New("plan is invalid")
	ErrInvalidStatus = errors.New("plan status is invalid")
	ErrInvalidTask   = errors.New("plan task is invalid")
	ErrInvalidOrder  = errors.New("plan order is invalid")
	ErrInvalidRedo   = errors.New("plan redo is invalid")
	ErrInvalidStop   = errors.New("plan stop is invalid")
)

// Status is intentionally open when reading historical data. Mutations only
// introduce values from KnownStatus, but an old persisted status remains
// observable rather than being silently rewritten as a success state.
type Status string

const (
	StatusDraft              Status = "draft"
	StatusPending            Status = "pending"
	StatusRunning            Status = "running"
	StatusReadyForValidation Status = "ready_for_validation"
	StatusCompleted          Status = "completed"
	StatusInterrupted        Status = "interrupted"
	StatusStopped            Status = "stopped"
	StatusValidationFailed   Status = "validation_failed"
)

func (value Status) Known() bool {
	switch value {
	case StatusDraft, StatusPending, StatusRunning, StatusReadyForValidation,
		StatusCompleted, StatusInterrupted, StatusStopped, StatusValidationFailed:
		return true
	default:
		return false
	}
}

type TaskStatus string

const (
	TaskPending     TaskStatus = "pending"
	TaskRunning     TaskStatus = "running"
	TaskCompleted   TaskStatus = "completed"
	TaskBlocked     TaskStatus = "blocked"
	TaskFailed      TaskStatus = "failed"
	TaskStopping    TaskStatus = "stopping"
	TaskStopped     TaskStatus = "stopped"
	TaskInterrupted TaskStatus = "interrupted"
	TaskDone        TaskStatus = "done"
	TaskPassed      TaskStatus = "passed"
)

func (value TaskStatus) Known() bool {
	switch value {
	case TaskPending, TaskRunning, TaskCompleted, TaskBlocked, TaskFailed,
		TaskStopping, TaskStopped, TaskInterrupted, TaskDone, TaskPassed:
		return true
	default:
		return false
	}
}

// AgentCLIConfig and BackendConfig retain only compatibility fields that are
// safe for the domain. Credential-bearing Claude columns and session IDs are
// intentionally not represented here.
type AgentCLIConfig struct {
	Provider             *string
	Command              string
	CodexReasoningEffort *string
}

type BackendConfig struct {
	Strategy             string
	Provider             *string
	Command              string
	Model                string
	CodexReasoningEffort *string
	ClaudeConfigID       int64
}

type Plan struct {
	ID               int64
	ProjectID        int64
	IssueHash        string
	SourceRef        string
	Digest           string
	Status           Status
	SortOrder        int64
	TotalTasks       int64
	CompletedTasks   int64
	ValidationPassed bool
	AgentCLI         AgentCLIConfig
	PlanGeneration   BackendConfig
	PlanExecution    BackendConfig
	GenerationMillis int64
	CreatedAt        string
	UpdatedAt        string
	AcceptedAt       *string
}

type Task struct {
	ID         int64
	ProjectID  int64
	PlanID     int64
	Key        string
	Title      string
	RawLine    string
	Scope      string
	Status     TaskStatus
	SortOrder  int64
	StartedAt  *string
	FinishedAt *string
	DurationMS int64
	UpdatedAt  string
	AcceptedAt *string
}

type ListOptions struct {
	ProjectID int64
	Limit     int
	Offset    int
}

type EventListOptions struct {
	ProjectID int64
	Limit     int
	Offset    int
}

// Reorder is an all-or-nothing replacement of a project's ordered plan set.
// ExpectedUpdatedAt is a compare-and-swap snapshot for every plan in IDs.
type Reorder struct {
	ProjectID         int64
	IDs               []int64
	ExpectedUpdatedAt map[int64]string
	UpdatedAt         string
}

type AcceptanceUpdate struct {
	ProjectID         int64
	ID                int64
	AcceptedAt        *string
	ExpectedUpdatedAt string
	UpdatedAt         string
}

type PlanRedo struct {
	ProjectID             int64
	PlanID                int64
	ExpectedPlanUpdatedAt string
	ExpectedTaskUpdatedAt map[int64]string
	UpdatedAt             string
	Supplement            string
}

type TaskRedo struct {
	ProjectID             int64
	PlanID                int64
	TaskID                int64
	ExpectedPlanUpdatedAt string
	ExpectedTaskUpdatedAt string
	UpdatedAt             string
	Supplement            string
}

// PlanStop identifies a plan through both its project and aggregate IDs. The
// project ID is part of the command so persistence adapters never resolve or
// mutate a plan through a globally-scoped ID.
type PlanStop struct {
	ProjectID int64
	PlanID    int64
	UpdatedAt string
}

// PlanStopResult is the committed aggregate state. AffectedTasks contains
// only unfinished tasks whose status changed to blocked.
type PlanStopResult struct {
	Plan          Plan
	AffectedTasks []Task
}

type Delete struct {
	ProjectID         int64
	PlanID            int64
	ExpectedUpdatedAt string
	UpdatedAt         string
}

type LinkedIntake struct {
	ProjectID  int64
	IntakeType string
	IntakeID   int64
}

type DeleteResult struct {
	PlanID           int64
	LinkedIntakes    []LinkedIntake
	DeletedTaskCount int64
	DeletedScanCount int64
}

func ValidateRecord(value Plan) error {
	if value.ID <= 0 || value.ProjectID <= 0 || !validOpaque(value.IssueHash, 512) ||
		!validOpaque(value.SourceRef, 4096) || !validOpaque(value.Digest, 512) ||
		!validStoredStatus(string(value.Status)) || value.SortOrder <= 0 || value.TotalTasks < 0 ||
		value.CompletedTasks < 0 || value.CompletedTasks > value.TotalTasks || value.GenerationMillis < 0 ||
		!validTimestamp(value.CreatedAt) || !validTimestamp(value.UpdatedAt) ||
		!validOptionalTimestamp(value.AcceptedAt) || !validAgentCLI(value.AgentCLI) ||
		!validBackend(value.PlanGeneration) || !validBackend(value.PlanExecution) {
		return ErrInvalid
	}
	created, _ := time.Parse(time.RFC3339Nano, value.CreatedAt)
	updated, _ := time.Parse(time.RFC3339Nano, value.UpdatedAt)
	if created.After(updated) {
		return ErrInvalid
	}
	return nil
}

func ValidateTaskRecord(value Task) error {
	if value.ID <= 0 || value.ProjectID <= 0 || value.PlanID <= 0 || !validOpaque(value.Key, 256) ||
		!validText(value.Title, 10000, false) || !validText(value.RawLine, 20000, false) ||
		!validText(value.Scope, 20000, true) || !validStoredStatus(string(value.Status)) || value.SortOrder <= 0 ||
		value.DurationMS < 0 || !validOptionalTimestamp(value.StartedAt) || !validOptionalTimestamp(value.FinishedAt) ||
		!validOptionalTimestamp(value.AcceptedAt) || !validTimestamp(value.UpdatedAt) {
		return ErrInvalidTask
	}
	if value.StartedAt != nil && value.FinishedAt != nil {
		started, _ := time.Parse(time.RFC3339Nano, *value.StartedAt)
		finished, _ := time.Parse(time.RFC3339Nano, *value.FinishedAt)
		if finished.Before(started) {
			return ErrInvalidTask
		}
	}
	return nil
}

func ValidateReorder(value Reorder) error {
	if value.ProjectID <= 0 || !validTimestamp(value.UpdatedAt) || len(value.IDs) == 0 ||
		len(value.ExpectedUpdatedAt) != len(value.IDs) {
		return ErrInvalidOrder
	}
	seen := make(map[int64]struct{}, len(value.IDs))
	for _, id := range value.IDs {
		if id <= 0 || !validTimestamp(value.ExpectedUpdatedAt[id]) ||
			!timestampAfter(value.UpdatedAt, value.ExpectedUpdatedAt[id]) {
			return ErrInvalidOrder
		}
		if _, exists := seen[id]; exists {
			return ErrInvalidOrder
		}
		seen[id] = struct{}{}
	}
	return nil
}

func ValidateAcceptanceUpdate(value AcceptanceUpdate) error {
	if value.ProjectID <= 0 || value.ID <= 0 || !validTimestamp(value.ExpectedUpdatedAt) ||
		!validTimestamp(value.UpdatedAt) || !timestampAfter(value.UpdatedAt, value.ExpectedUpdatedAt) ||
		!validOptionalTimestamp(value.AcceptedAt) {
		return ErrInvalid
	}
	return nil
}

func ValidatePlanRedo(value PlanRedo) error {
	if value.ProjectID <= 0 || value.PlanID <= 0 || !validTimestamp(value.ExpectedPlanUpdatedAt) ||
		!validTimestamp(value.UpdatedAt) || !timestampAfter(value.UpdatedAt, value.ExpectedPlanUpdatedAt) ||
		!validSupplement(value.Supplement) {
		return ErrInvalidRedo
	}
	for taskID, updatedAt := range value.ExpectedTaskUpdatedAt {
		if taskID <= 0 || !validTimestamp(updatedAt) || !timestampAfter(value.UpdatedAt, updatedAt) {
			return ErrInvalidRedo
		}
	}
	return nil
}

func ValidateTaskRedo(value TaskRedo) error {
	if value.ProjectID <= 0 || value.PlanID <= 0 || value.TaskID <= 0 ||
		!validTimestamp(value.ExpectedPlanUpdatedAt) || !validTimestamp(value.ExpectedTaskUpdatedAt) ||
		!validTimestamp(value.UpdatedAt) || !timestampAfter(value.UpdatedAt, value.ExpectedPlanUpdatedAt) ||
		!timestampAfter(value.UpdatedAt, value.ExpectedTaskUpdatedAt) || !validSupplement(value.Supplement) {
		return ErrInvalidRedo
	}
	return nil
}

func ValidatePlanStop(value PlanStop) error {
	if value.ProjectID <= 0 || value.PlanID <= 0 || !validTimestamp(value.UpdatedAt) {
		return ErrInvalidStop
	}
	return nil
}

func ValidateDelete(value Delete) error {
	if value.ProjectID <= 0 || value.PlanID <= 0 || !validTimestamp(value.ExpectedUpdatedAt) ||
		!validTimestamp(value.UpdatedAt) || !timestampAfter(value.UpdatedAt, value.ExpectedUpdatedAt) {
		return ErrInvalid
	}
	return nil
}

func IsAcceptablePlan(value Status) bool { return value == StatusCompleted }

func IsAcceptableTask(value TaskStatus) bool {
	return value == TaskCompleted || value == TaskDone || value == TaskPassed
}

func NormalizeSupplement(value string) string {
	value = strings.ReplaceAll(strings.ReplaceAll(value, "\r\n", "\n"), "\r", "\n")
	value = strings.TrimSpace(value)
	if utf8.RuneCountInString(value) > 2000 {
		value = string([]rune(value)[:2000])
	}
	return value
}

func validBackend(value BackendConfig) bool {
	return value.ClaudeConfigID >= 0 && validText(value.Strategy, 64, false) && len(value.Command) <= 1000 &&
		validText(value.Model, 200, true) && validOptionalText(value.Provider, 64) &&
		validOptionalText(value.CodexReasoningEffort, 32)
}

func validAgentCLI(value AgentCLIConfig) bool {
	return len(value.Command) <= 1000 && validOptionalText(value.Provider, 64) &&
		validOptionalText(value.CodexReasoningEffort, 32)
}

func validSupplement(value string) bool {
	return utf8.ValidString(value) && !strings.ContainsRune(value, 0) && utf8.RuneCountInString(value) <= 2000
}

func validStoredStatus(value string) bool {
	return validOpaque(value, 64)
}

func validTimestamp(value string) bool {
	if !strings.HasSuffix(value, "Z") {
		return false
	}
	parsed, err := time.Parse(time.RFC3339Nano, value)
	return err == nil && parsed.Location() == time.UTC
}

func timestampAfter(next, previous string) bool {
	parsedNext, nextErr := time.Parse(time.RFC3339Nano, next)
	parsedPrevious, previousErr := time.Parse(time.RFC3339Nano, previous)
	return nextErr == nil && previousErr == nil && parsedNext.After(parsedPrevious)
}

// ValidUTCTimestamp is shared by adjacent domain packages so audit records
// use the same RFC3339Nano-with-Z convention as plan mutations.
func ValidUTCTimestamp(value string) bool { return validTimestamp(value) }

func validOptionalTimestamp(value *string) bool { return value == nil || validTimestamp(*value) }

func validOpaque(value string, maximum int) bool {
	return value != "" && len(value) <= maximum && strings.TrimSpace(value) == value &&
		!strings.ContainsFunc(value, unicode.IsControl)
}

func validText(value string, maximum int, emptyAllowed bool) bool {
	return utf8.ValidString(value) && !strings.ContainsRune(value, 0) && utf8.RuneCountInString(value) <= maximum &&
		(emptyAllowed || strings.TrimSpace(value) != "")
}

func validOptionalText(value *string, maximum int) bool {
	return value == nil || validText(*value, maximum, true)
}
