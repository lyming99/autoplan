package loop

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"sync"
	"time"

	"github.com/lyming99/autoplan/backend/internal/application/capabilities"
	applicationoperations "github.com/lyming99/autoplan/backend/internal/application/operations"
	domainloop "github.com/lyming99/autoplan/backend/internal/domain/loop"
	domainoperation "github.com/lyming99/autoplan/backend/internal/domain/operation"
	"github.com/lyming99/autoplan/backend/internal/runtime/scheduler"
)

var (
	ErrRuntimeUnavailable = errors.New("loop runtime is unavailable")
	ErrRuntimeBusy        = errors.New("loop runtime is already running")
	ErrProjectNotFound    = errors.New("loop project was not found")
)

// StateStore is deliberately narrower than the repository writer. Its
// implementation is responsible for committing Loop state, project revision,
// and the compatible snapshot/outbox atomically. The Loop service therefore
// has no SQL escape hatch and cannot accidentally persist a partial snapshot.
type StateStore interface {
	Check(context.Context) error
	Get(context.Context, int64) (domainloop.State, bool, error)
	ListRunning(context.Context) ([]domainloop.State, error)
	Save(context.Context, domainloop.State, int64) (domainloop.State, bool, error)
}

// Runner performs one bounded Loop cycle after the actor has claimed its
// Operation. It owns scan/generation/plan-processing composition but returns
// only safe counts; raw paths, prompts, CLI output and process details remain
// outside the Operation and event contracts.
type Runner interface {
	RunOnce(context.Context, RunInput) (RunOutput, error)
}

type RunInput struct {
	ProjectID   int64
	OperationID string
	// AssociatePlan records the plan actually claimed by the runner. Runtime
	// cancellation uses this association so plan.stop cannot cancel unrelated
	// work in the same project.
	AssociatePlan func(int64) bool
}

type RunOutput struct {
	PendingIntakes int
	GeneratedPlans int
	ProcessedPlans int
}

func (output RunOutput) Valid() bool {
	return output.PendingIntakes >= 0 && output.GeneratedPlans >= 0 && output.ProcessedPlans >= 0
}

type runtimeService struct {
	mu         sync.Mutex
	operations *applicationoperations.Service
	scheduler  *scheduler.Manager
	state      StateStore
	runner     Runner
	requested  bool

	schedules map[int64]*schedule
	active    map[int64]*activeRun
	planStops map[int64]map[int64]struct{}
	instance  string
	sequence  uint64
	closed    bool
}

type schedule struct {
	cancel chan struct{}
	done   chan struct{}
}

type activeRun struct {
	operation     domainoperation.Operation
	requestDigest string
	request       *commandRequest
	planID        int64
	cancelled     bool
}

func newRuntimeService(dependencies Dependencies) *runtimeService {
	return &runtimeService{
		operations: dependencies.Operations, scheduler: dependencies.Scheduler,
		state: dependencies.State, runner: dependencies.Runner,
		requested: dependencies.Operations != nil || dependencies.Scheduler != nil || dependencies.State != nil || dependencies.Runner != nil,
		schedules: make(map[int64]*schedule), active: make(map[int64]*activeRun), planStops: make(map[int64]map[int64]struct{}),
		instance: automaticInstanceID(),
	}
}

func automaticInstanceID() string {
	value := make([]byte, 12)
	if _, err := rand.Read(value); err == nil {
		return hex.EncodeToString(value)
	}
	// rand.Read should only fail when the operating system random source is
	// unavailable. Process identity plus wall time still avoids reverting to a
	// plain sequence, whose persisted idempotency keys collide on restart.
	fallback := fmt.Sprintf("%d:%d", os.Getpid(), time.Now().UnixNano())
	sum := sha256.Sum256([]byte(fallback))
	return hex.EncodeToString(sum[:12])
}

func (service *runtimeService) Requested() bool {
	if service == nil {
		return false
	}
	service.mu.Lock()
	defer service.mu.Unlock()
	return service.requested
}

func (service *runtimeService) BindOperations(operations *applicationoperations.Service) {
	if service == nil {
		return
	}
	service.mu.Lock()
	service.operations = operations
	service.mu.Unlock()
}

func (service *runtimeService) Configured() bool {
	if service == nil {
		return false
	}
	service.mu.Lock()
	defer service.mu.Unlock()
	return !service.closed && service.operations != nil && service.operations.Configured() && service.scheduler != nil && service.state != nil && service.runner != nil
}

func (service *runtimeService) dependencies() (*applicationoperations.Service, *scheduler.Manager, StateStore, Runner, error) {
	if service == nil {
		return nil, nil, nil, nil, ErrRuntimeUnavailable
	}
	service.mu.Lock()
	defer service.mu.Unlock()
	if service.closed || service.operations == nil || !service.operations.Configured() || service.scheduler == nil || service.state == nil || service.runner == nil {
		return nil, nil, nil, nil, ErrRuntimeUnavailable
	}
	return service.operations, service.scheduler, service.state, service.runner, nil
}

func (service *runtimeService) nextAutomaticIdentity(operationType string, projectID int64) (string, string) {
	service.mu.Lock()
	service.sequence++
	sequence := service.sequence
	instance := service.instance
	service.mu.Unlock()
	requestID := fmt.Sprintf("loop-auto-%s-%d", instance, sequence)
	key := fmt.Sprintf("loop-%d-%s-%d", projectID, instance, sequence)
	return requestID, key
}

func requestDigest(operationType string, projectID int64, key string) string {
	sum := sha256.Sum256([]byte(operationType + "\x00" + fmt.Sprintf("%d", projectID) + "\x00" + key))
	return hex.EncodeToString(sum[:])
}

func operationResult(operation domainoperation.Operation) Result {
	return Result{Operation: capabilities.OperationReference{
		OperationID: operation.OperationID, Type: operation.Type, Status: "accepted",
		RequestID: operation.RequestID, AcceptedAt: operation.CreatedAt,
	}}
}

func operationCaller(command Command) applicationoperations.Caller {
	return applicationoperations.Caller{ID: command.CallerScope, ProjectID: command.ProjectID}
}

func operationError(err error) error {
	switch {
	case errors.Is(err, applicationoperations.ErrUnavailable), errors.Is(err, applicationoperations.ErrHandlerUnavailable):
		return ErrRuntimeUnavailable
	case errors.Is(err, applicationoperations.ErrStateConflict), errors.Is(err, applicationoperations.ErrVersionConflict):
		return ErrStateConflict
	case errors.Is(err, applicationoperations.ErrNotFound):
		return ErrProjectNotFound
	case errors.Is(err, applicationoperations.ErrInvalidCommand), errors.Is(err, applicationoperations.ErrUnauthorized), errors.Is(err, applicationoperations.ErrIdempotencyConflict):
		return ErrInvalidCommand
	default:
		return err
	}
}
