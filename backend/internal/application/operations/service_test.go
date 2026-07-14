package operations

import (
	"context"
	"encoding/json"
	"errors"
	"sort"
	"testing"
	"time"

	domainoperation "github.com/lyming99/autoplan/backend/internal/domain/operation"
	"github.com/lyming99/autoplan/backend/internal/repository"
)

type operationTestClock struct{ now time.Time }

func (clock operationTestClock) Now() time.Time { return clock.now }

type operationTestProjects []repository.Project

func (projects operationTestProjects) ListProjects(context.Context) ([]repository.Project, error) {
	return append([]repository.Project(nil), projects...), nil
}

type operationTestHandler struct{ operationType string }

func (handler operationTestHandler) Type() string { return handler.operationType }

func (operationTestHandler) CanRecover(context.Context, domainoperation.Operation) (bool, error) {
	return true, nil
}

type operationNonRecoveringHandler struct{ operationType string }

func (handler operationNonRecoveringHandler) Type() string { return handler.operationType }
func (operationNonRecoveringHandler) CanRecover(context.Context, domainoperation.Operation) (bool, error) {
	return false, nil
}

type operationMemoryStore struct {
	operations map[string]domainoperation.Operation
	keys       map[string]string
}

func newOperationMemoryStore(values ...domainoperation.Operation) *operationMemoryStore {
	store := &operationMemoryStore{operations: make(map[string]domainoperation.Operation), keys: make(map[string]string)}
	for _, value := range values {
		store.operations[value.OperationID] = value
		if value.IdempotencyKey != nil {
			store.keys[operationScope(value.ProjectID, value.Type)+"\x00"+*value.IdempotencyKey] = value.OperationID
		}
	}
	return store
}

func (store *operationMemoryStore) Check(context.Context) error { return nil }

func (store *operationMemoryStore) ListProjects(context.Context) ([]repository.Project, error) {
	seen := make(map[int64]struct{})
	projects := make([]repository.Project, 0)
	for _, operation := range store.operations {
		if _, exists := seen[operation.ProjectID]; exists {
			continue
		}
		seen[operation.ProjectID] = struct{}{}
		projects = append(projects, repository.Project{ID: operation.ProjectID})
	}
	return projects, nil
}

func (store *operationMemoryStore) Transact(_ context.Context, operation func(Transaction) error) error {
	if operation == nil {
		return errors.New("nil transaction")
	}
	return operation(operationMemoryTransaction{store: store})
}

type operationMemoryTransaction struct{ store *operationMemoryStore }

func (transaction operationMemoryTransaction) Create(_ context.Context, value domainoperation.Operation, scope string, _ json.RawMessage) (domainoperation.Operation, bool, error) {
	key := scope + "\x00" + *value.IdempotencyKey
	if existingID, exists := transaction.store.keys[key]; exists {
		existing := transaction.store.operations[existingID]
		if existing.RequestDigest != value.RequestDigest || existing.ProjectID != value.ProjectID || existing.Type != value.Type {
			return domainoperation.Operation{}, false, ErrIdempotencyConflict
		}
		return existing, false, nil
	}
	transaction.store.operations[value.OperationID] = value
	transaction.store.keys[key] = value.OperationID
	return value, true, nil
}

func (transaction operationMemoryTransaction) Get(_ context.Context, projectID int64, operationID string) (domainoperation.Operation, bool, error) {
	value, exists := transaction.store.operations[operationID]
	return value, exists && value.ProjectID == projectID, nil
}

func (transaction operationMemoryTransaction) List(_ context.Context, query ListQuery) ([]domainoperation.Operation, error) {
	result := make([]domainoperation.Operation, 0)
	for _, value := range transaction.store.operations {
		if value.ProjectID == query.ProjectID && (query.Type == "" || value.Type == query.Type) && (query.Status == "" || value.Status == query.Status) {
			result = append(result, value)
		}
	}
	sort.Slice(result, func(left, right int) bool { return result[left].OperationID < result[right].OperationID })
	if query.Limit > 0 && len(result) > query.Limit {
		result = result[:query.Limit]
	}
	return result, nil
}

func (transaction operationMemoryTransaction) Transition(_ context.Context, input Transition) (domainoperation.Operation, bool, error) {
	current, found := transaction.store.operations[input.OperationID]
	if !found || current.ProjectID != input.ProjectID {
		return domainoperation.Operation{}, false, repository.ErrNotFound
	}
	disposition := domainoperation.ResolveTransition(current.Status, input.Target)
	if disposition == domainoperation.TransitionNoop {
		return current, false, nil
	}
	if disposition != domainoperation.TransitionApply {
		return domainoperation.Operation{}, false, ErrStateConflict
	}
	if current.Version != input.ExpectedVersion {
		return domainoperation.Operation{}, false, repository.ErrVersionConflict
	}
	next := current
	next.Status = input.Target
	next.UpdatedAt = input.UpdatedAt
	next.Version++
	switch input.Target {
	case domainoperation.StatusRunning:
		next.StartedAt = stringPtr(input.UpdatedAt)
		next.FinishedAt, next.Result, next.Error = nil, nil, nil
	case domainoperation.StatusSucceeded:
		next.FinishedAt, next.Result, next.Error = stringPtr(input.UpdatedAt), cloneJSON(input.Result), nil
	case domainoperation.StatusFailed, domainoperation.StatusInterrupted:
		next.FinishedAt, next.Result, next.Error = stringPtr(input.UpdatedAt), nil, input.Error
	case domainoperation.StatusCancelled:
		next.FinishedAt, next.Result, next.Error = stringPtr(input.UpdatedAt), nil, nil
	}
	next.Output = input.Output
	if next.Validate() != nil {
		return domainoperation.Operation{}, false, ErrInvalidCommand
	}
	transaction.store.operations[next.OperationID] = next
	return next, true, nil
}

func (transaction operationMemoryTransaction) RequestCancellation(_ context.Context, input CancelRequest) (domainoperation.Operation, bool, error) {
	current, found := transaction.store.operations[input.OperationID]
	if !found || current.ProjectID != input.ProjectID {
		return domainoperation.Operation{}, false, repository.ErrNotFound
	}
	if current.Status.Terminal() || current.CancelRequestedAt != nil {
		return current, false, nil
	}
	if current.Version != input.ExpectedVersion {
		return domainoperation.Operation{}, false, repository.ErrVersionConflict
	}
	if current.Status == domainoperation.StatusQueued {
		return transaction.Transition(context.Background(), Transition{
			ProjectID: input.ProjectID, OperationID: input.OperationID, ExpectedVersion: input.ExpectedVersion,
			Target: domainoperation.StatusCancelled, RequestID: input.RequestID, UpdatedAt: input.RequestedAt,
		})
	}
	next := current
	next.CancelRequestedAt = stringPtr(input.RequestedAt)
	next.UpdatedAt = input.RequestedAt
	next.Version++
	transaction.store.operations[next.OperationID] = next
	return next, true, nil
}

func TestCreateOrReuseAndCancellationUseOneServiceBoundary(t *testing.T) {
	clock := operationTestClock{now: time.Date(2026, 7, 12, 0, 0, 1, 0, time.UTC)}
	store := newOperationMemoryStore()
	service := NewService(Dependencies{
		Store: store, Clock: clock, NewID: func() string { return "op-service-1" },
		RecoveryHandlers: []RecoveryHandler{operationTestHandler{operationType: "task.run"}},
	})
	caller := Caller{ID: "runner-1", ProjectID: 1}
	command := CreateCommand{
		Caller: caller, ProjectID: 1, Type: "task.run", IdempotencyKey: "task-key", RequestID: "request-1",
		RequestDigest: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
	}
	created, err := service.CreateOrReuse(context.Background(), command)
	if err != nil || !created.Changed || created.Operation.Status != domainoperation.StatusQueued {
		t.Fatalf("create = %#v, %v", created, err)
	}
	reused, err := service.CreateOrReuse(context.Background(), command)
	if err != nil || reused.Changed || reused.Operation.OperationID != created.Operation.OperationID {
		t.Fatalf("reuse = %#v, %v", reused, err)
	}
	cancelled, err := service.RequestCancel(context.Background(), CancelCommand{
		Caller: caller, ProjectID: 1, OperationID: created.Operation.OperationID, ExpectedVersion: 1, RequestID: "cancel-1",
	})
	if err != nil || !cancelled.Changed || cancelled.Operation.Status != domainoperation.StatusCancelled {
		t.Fatalf("cancel = %#v, %v", cancelled, err)
	}
	replayed, err := service.RequestCancel(context.Background(), CancelCommand{
		Caller: caller, ProjectID: 1, OperationID: created.Operation.OperationID, ExpectedVersion: 1, RequestID: "cancel-1",
	})
	if err != nil || replayed.Changed || replayed.Operation.Status != domainoperation.StatusCancelled {
		t.Fatalf("cancel replay = %#v, %v", replayed, err)
	}
}

func TestLiveClaimDoesNotUseStartupRecoveryAdmission(t *testing.T) {
	clock := operationTestClock{now: time.Date(2026, 7, 12, 0, 0, 1, 0, time.UTC)}
	store := newOperationMemoryStore()
	service := NewService(Dependencies{
		Store: store, Clock: clock, NewID: func() string { return "op-live-claim" },
		RecoveryHandlers: []RecoveryHandler{operationNonRecoveringHandler{operationType: "script.run"}},
	})
	caller := Caller{ID: "renderer", ProjectID: 1}
	digest := "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	created, err := service.CreateOrReuse(context.Background(), CreateCommand{
		Caller: caller, ProjectID: 1, Type: "script.run", IdempotencyKey: "script-live", RequestID: "request-live", RequestDigest: digest,
	})
	if err != nil {
		t.Fatal(err)
	}
	claimed, err := service.Claim(context.Background(), ClaimCommand{
		Caller: caller, ProjectID: 1, OperationID: created.Operation.OperationID,
		ExpectedVersion: created.Operation.Version, RequestDigest: digest, RequestID: "request-live",
	})
	if err != nil || claimed.Operation.Status != domainoperation.StatusRunning {
		t.Fatalf("live claim = %#v, %v", claimed, err)
	}
}

func TestRecoverInterruptsRunningAndUnclaimedQueuedWithoutExecuting(t *testing.T) {
	base := "2026-07-11T00:00:00Z"
	started := base
	keyOne, keyTwo := "running-key", "queued-key"
	store := newOperationMemoryStore(
		domainoperation.Operation{OperationID: "op-running", ProjectID: 1, Type: "task.run", Status: domainoperation.StatusRunning, RequestID: "request-running", IdempotencyKey: &keyOne, RequestDigest: "1111111111111111111111111111111111111111111111111111111111111111", Version: 2, CreatedAt: base, UpdatedAt: base, StartedAt: &started},
		domainoperation.Operation{OperationID: "op-queued", ProjectID: 1, Type: "task.run", Status: domainoperation.StatusQueued, RequestID: "request-queued", IdempotencyKey: &keyTwo, RequestDigest: "2222222222222222222222222222222222222222222222222222222222222222", Version: 1, CreatedAt: base, UpdatedAt: base},
	)
	service := NewService(Dependencies{
		Store: store, Projects: operationTestProjects{{ID: 1}},
		Clock:                operationTestClock{now: time.Date(2026, 7, 12, 0, 0, 0, 0, time.UTC)},
		QueuedRecoveryMaxAge: 0,
	})
	result, err := service.Recover(context.Background())
	if err != nil || len(result) != 2 {
		t.Fatalf("recover = %#v, %v", result, err)
	}
	for _, operationID := range []string{"op-running", "op-queued"} {
		value := store.operations[operationID]
		if value.Status != domainoperation.StatusInterrupted || value.Error == nil {
			t.Fatalf("recovered %s = %#v", operationID, value)
		}
	}
}

func TestAssessOutputDropsSensitiveChunksAndBoundsRetainedMetadata(t *testing.T) {
	assessment := AssessOutput(&OutputCapture{
		Stdout: []byte("normal line\nTOKEN=<redacted>\n"),
		Stderr: []byte("C:\\private\\trace\n"),
	})
	if assessment.Metadata == nil || !assessment.Metadata.RedactionFailed || assessment.Diagnostic == nil ||
		assessment.Diagnostic.Code != "OUTPUT_REDACTION_FAILED" || assessment.Metadata.StdoutBytes >= int64(len("normal line\nTOKEN=<redacted>\n")) {
		t.Fatalf("output assessment = %#v", assessment)
	}
}

func stringPtr(value string) *string { return &value }

func cloneJSON(value *json.RawMessage) *json.RawMessage {
	if value == nil {
		return nil
	}
	copyValue := json.RawMessage(append([]byte(nil), (*value)...))
	return &copyValue
}
