// Package scripts owns the project-scoped Script runtime boundary.  It turns
// persisted Script definitions into the closed process.Spec accepted by the
// shared runner; transports never provide commands, paths, environments or
// process identifiers to this package.
package scripts

import (
	"context"
	"errors"
	"sync"
	"time"

	filesapp "github.com/lyming99/autoplan/backend/internal/application/files"
	applicationoperations "github.com/lyming99/autoplan/backend/internal/application/operations"
	domainautomation "github.com/lyming99/autoplan/backend/internal/domain/automation"
	domainfiles "github.com/lyming99/autoplan/backend/internal/domain/files"
	domainoperation "github.com/lyming99/autoplan/backend/internal/domain/operation"
	"github.com/lyming99/autoplan/backend/internal/repository"
	"github.com/lyming99/autoplan/backend/internal/runtime/process"
	"github.com/lyming99/autoplan/backend/internal/runtime/scheduler"
)

const OperationType = "script.run"

var (
	ErrUnavailable     = errors.New("script application service unavailable")
	ErrInvalidCommand  = errors.New("script command is invalid")
	ErrUnauthorized    = errors.New("script caller is not authorized")
	ErrNotFound        = errors.New("script was not found")
	ErrDisabled        = errors.New("script is disabled")
	ErrTriggerMismatch = errors.New("script trigger does not match")
	ErrBusy            = errors.New("script is already running")
	ErrQueueFull       = errors.New("script runtime queue is full")
	ErrNotRunning      = errors.New("script is not running")
	ErrStateConflict   = errors.New("script runtime state conflicts")
)

// Store deliberately permits only project-scoped reads. It has no raw SQL or
// runtime-state mutation path; P005 supplies the atomic durable run archive.
type Store interface {
	Check(context.Context) error
	GetProject(context.Context, int64) (repository.Project, bool, error)
	GetScript(context.Context, int64, int64) (domainautomation.Script, bool, error)
	ListScripts(context.Context, domainautomation.ListOptions) ([]domainautomation.Script, error)
	ListProjects(context.Context) ([]repository.Project, error)
}

// Runner is intentionally the narrow P11 runner facade. Implementations may
// only receive an already-authorized, persisted Script-derived process spec.
type Runner interface {
	Run(context.Context, process.Spec) (process.Result, error)
}

// FilePolicy checks the persisted file-backed source before an Operation is
// created. The runner independently re-checks the working directory at spawn.
type FilePolicy interface {
	AuthorizeScriptSource(context.Context, string, string) (domainfiles.Decision, error)
	AuthorizeWorkingDirectory(context.Context, string, string) (domainfiles.Decision, error)
}

// Finalizer commits the terminal Operation, Script last_* state, bounded log
// archive and business event in one repository transaction.
type Finalizer interface {
	FinalizeScriptRun(context.Context, RunFinalization) (domainoperation.Operation, error)
}

type RunFinalization struct {
	ProjectID, ScriptID          int64
	OperationID, RequestID       string
	ExpectedVersion              int64
	Target                       domainoperation.Status
	Status, FailureCode, Summary string
	ExitCode, DurationMS         int64
	StdoutTail, StderrTail       string
	Output                       domainoperation.OutputMetadata
	OccurredAt                   string
}

var _ FilePolicy = (*filesapp.Service)(nil)

type Clock interface{ Now() time.Time }

type systemClock struct{}

func (systemClock) Now() time.Time { return time.Now().UTC() }

type Dependencies struct {
	Store      Store
	Operations *applicationoperations.Service
	Scheduler  *scheduler.Manager
	Runner     Runner
	Files      FilePolicy
	Finalizer  Finalizer
	Clock      Clock
}

// Caller is the authenticated, transport-owned proof used to create a
// project Operation. Trigger, stage and manual intent are never authorization
// proofs and are selected by the service entry point instead.
type Caller struct {
	ID        string
	ProjectID int64
}

type Trigger string

const (
	TriggerManual   Trigger = "manual"
	TriggerHook     Trigger = "hook"
	TriggerSchedule Trigger = "schedule"
)

type RunCommand struct {
	Caller         Caller
	ProjectID      int64
	ScriptID       int64
	RequestID      string
	IdempotencyKey string
	Context        Context
}

type StopCommand struct {
	Caller    Caller
	ProjectID int64
	ScriptID  int64
	RequestID string
}

type Result struct {
	Operation domainoperation.Operation
	Changed   bool
}

type StopResult struct {
	Operation domainoperation.Operation
	Changed   bool
	Stopped   bool
}

// RuntimeSnapshot is a bounded, redacted in-memory overlay for snapshot
// assembly. It does not claim ownership of Operations restored from another
// runtime or of legacy Node processes.
type RuntimeSnapshot struct {
	Running         bool
	OperationID     string
	OperationStatus string
	LastStatus      *string
	LastExitCode    *int64
	LastDurationMS  *int64
	LastRunAt       *string
}

type Service struct {
	store      Store
	operations *applicationoperations.Service
	scheduler  *scheduler.Manager
	runner     Runner
	files      FilePolicy
	finalizer  Finalizer
	clock      Clock

	mu        sync.Mutex
	active    map[scriptKey]*activeRun
	last      map[scriptKey]runtimeLast
	scheduled map[scriptKey]string
	closed    bool
}

type scriptKey struct {
	projectID int64
	scriptID  int64
}

type activeRun struct {
	operation      domainoperation.Operation
	script         domainautomation.Script
	request        *runRequest
	submission     *scheduler.Submission
	cancelled      bool
	idempotencyKey string
	digest         string
}

type runtimeLast struct {
	status     string
	exitCode   int64
	durationMS int64
	ranAt      string
	hasMetrics bool
}

func NewService(dependencies Dependencies) *Service {
	clock := dependencies.Clock
	if clock == nil {
		clock = systemClock{}
	}
	return &Service{
		store: dependencies.Store, operations: dependencies.Operations, scheduler: dependencies.Scheduler,
		runner: dependencies.Runner, files: dependencies.Files, finalizer: dependencies.Finalizer, clock: clock,
		active: make(map[scriptKey]*activeRun), last: make(map[scriptKey]runtimeLast), scheduled: make(map[scriptKey]string),
	}
}

func (service *Service) Configured() bool {
	if service == nil {
		return false
	}
	service.mu.Lock()
	defer service.mu.Unlock()
	return !service.closed && service.store != nil && service.operations != nil && service.operations.Configured() &&
		service.scheduler != nil && service.runner != nil && service.files != nil && service.finalizer != nil && service.clock != nil
}

// BindOperations completes bootstrap's cycle: the Script executor must be
// registered before Operations freezes recovery handlers, while the concrete
// Operation service itself is built from that frozen registry afterwards.
func (service *Service) BindOperations(operations *applicationoperations.Service) {
	if service == nil {
		return
	}
	service.mu.Lock()
	service.operations = operations
	service.mu.Unlock()
}

func (service *Service) ready(ctx context.Context) error {
	if ctx == nil {
		return ErrInvalidCommand
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if !service.Configured() {
		return ErrUnavailable
	}
	if err := service.store.Check(ctx); err != nil {
		return err
	}
	return nil
}

// RunManual is the only entry point used for a user-initiated Script run.
// The persisted trigger_mode must still be manual; a request field cannot
// turn a hook/scheduled definition into an executable manual Script.
func (service *Service) RunManual(ctx context.Context, command RunCommand) (Result, error) {
	return service.submit(ctx, command, TriggerManual, "")
}

// RunHook runs one already-selected hook definition. Hook batch ordering and
// fail_aborts semantics live in RunHooks below.
func (service *Service) RunHook(ctx context.Context, command RunCommand, stage string) (Result, error) {
	return service.submit(ctx, command, TriggerHook, stage)
}

// RunScheduled runs one already-selected schedule definition. Cron admission
// and same-minute de-duplication live in RunDue.
func (service *Service) RunScheduled(ctx context.Context, command RunCommand) (Result, error) {
	return service.submit(ctx, command, TriggerSchedule, "")
}

// Close only forgets local admission state. The shared scheduler/runner own
// cancellation and process reaping; bootstrap closes them after this service.
func (service *Service) Close() {
	if service == nil {
		return
	}
	service.mu.Lock()
	service.closed = true
	service.mu.Unlock()
}

// ScriptRuntime implements the snapshot overlay source. A returned value is
// always scoped to one (project, script) pair and has no paths, output or PID.
func (service *Service) ScriptRuntime(projectID, scriptID int64) (RuntimeSnapshot, bool) {
	if service == nil || projectID <= 0 || scriptID <= 0 {
		return RuntimeSnapshot{}, false
	}
	key := scriptKey{projectID: projectID, scriptID: scriptID}
	service.mu.Lock()
	defer service.mu.Unlock()
	active := service.active[key]
	last, hasLast := service.last[key]
	if active == nil && !hasLast {
		return RuntimeSnapshot{}, false
	}
	result := RuntimeSnapshot{}
	if active != nil {
		result.Running, result.OperationID, result.OperationStatus = true, active.operation.OperationID, string(active.operation.Status)
	}
	if hasLast {
		status, ranAt := last.status, last.ranAt
		result.LastStatus, result.LastRunAt = &status, &ranAt
		if last.hasMetrics {
			exitCode, duration := last.exitCode, last.durationMS
			result.LastExitCode, result.LastDurationMS = &exitCode, &duration
		}
	}
	return result, true
}

// OperationExecutor registers Script ownership with the generic Operation
// service. P003 deliberately never recovers a queued Script by launching it
// after restart: without a live Go-owned runner registration it is safer for
// generic recovery to mark the record interrupted.
type OperationExecutor struct{ service *Service }

func NewOperationExecutor(service *Service) *OperationExecutor {
	return &OperationExecutor{service: service}
}

func (executor *OperationExecutor) Type() string { return OperationType }

func (executor *OperationExecutor) CanRecover(ctx context.Context, operation domainoperation.Operation) (bool, error) {
	if executor == nil || executor.service == nil || operation.Type != OperationType {
		return false, nil
	}
	if err := ctx.Err(); err != nil {
		return false, err
	}
	return false, nil
}

func (executor *OperationExecutor) ExecuteRecovered(context.Context, domainoperation.Operation) error {
	return ErrUnavailable
}

var _ applicationoperations.Executor = (*OperationExecutor)(nil)

// repositoryStore is the sole repository adapter. It begins a bounded
// automation transaction for each query and never exposes that transaction to
// an HTTP/MCP/UI caller.
type repositoryStore struct {
	writer repository.AutomationTransactional
}

func NewRepositoryStore(writer repository.AutomationTransactional) Store {
	if writer == nil {
		return nil
	}
	return repositoryStore{writer: writer}
}

func (store repositoryStore) Check(ctx context.Context) error { return store.writer.Check(ctx) }

func (store repositoryStore) GetProject(ctx context.Context, projectID int64) (repository.Project, bool, error) {
	var value repository.Project
	var found bool
	err := store.writer.TransactAutomation(ctx, func(transaction repository.AutomationWriteTransaction) error {
		var err error
		value, found, err = transaction.GetProject(ctx, projectID)
		return err
	})
	return value, found, err
}

func (store repositoryStore) GetScript(ctx context.Context, projectID, scriptID int64) (domainautomation.Script, bool, error) {
	var value domainautomation.Script
	var found bool
	err := store.writer.TransactAutomation(ctx, func(transaction repository.AutomationWriteTransaction) error {
		var err error
		value, found, err = transaction.GetScript(ctx, projectID, scriptID)
		return err
	})
	return value, found, err
}

func (store repositoryStore) ListScripts(ctx context.Context, options domainautomation.ListOptions) ([]domainautomation.Script, error) {
	var values []domainautomation.Script
	err := store.writer.TransactAutomation(ctx, func(transaction repository.AutomationWriteTransaction) error {
		var err error
		values, err = transaction.ListScripts(ctx, options)
		return err
	})
	return values, err
}

func (store repositoryStore) ListProjects(ctx context.Context) ([]repository.Project, error) {
	var values []repository.Project
	err := store.writer.TransactAutomation(ctx, func(transaction repository.AutomationWriteTransaction) error {
		var err error
		values, err = transaction.ListProjects(ctx)
		return err
	})
	return values, err
}

func (service *Service) listAllScripts(ctx context.Context, projectID int64) ([]domainautomation.Script, error) {
	const pageSize = 200
	result := make([]domainautomation.Script, 0)
	for offset := 0; ; offset += pageSize {
		page, err := service.store.ListScripts(ctx, domainautomation.ListOptions{ProjectID: projectID, Limit: pageSize, Offset: offset})
		if err != nil {
			return nil, err
		}
		result = append(result, page...)
		if len(page) < pageSize {
			return result, nil
		}
	}
}
