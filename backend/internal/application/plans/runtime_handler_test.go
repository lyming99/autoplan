package plans

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/lyming99/autoplan/backend/internal/application/capabilities"
	applicationloop "github.com/lyming99/autoplan/backend/internal/application/loop"
	applicationoperations "github.com/lyming99/autoplan/backend/internal/application/operations"
	domainoperation "github.com/lyming99/autoplan/backend/internal/domain/operation"
	domainplan "github.com/lyming99/autoplan/backend/internal/domain/plan"
	"github.com/lyming99/autoplan/backend/internal/repository"
)

type planRuntimeDispatcherSpy struct{ calls int }

func (spy *planRuntimeDispatcherSpy) Dispatch(_ context.Context, command applicationloop.Command) (applicationloop.Result, error) {
	spy.calls++
	return applicationloop.Result{Operation: capabilities.OperationReference{
		OperationID: "legacy-operation", Type: string(command.Kind), Status: "accepted",
		RequestID: command.RequestID, AcceptedAt: "2026-07-15T00:00:00Z",
	}}, nil
}

func TestPlanStopNeverFallsThroughToLegacyDispatcher(t *testing.T) {
	dispatcher := &planRuntimeDispatcherSpy{}
	handler := NewRuntimeHandler(dispatcher)
	_, err := handler.Execute(context.Background(), applicationloop.Command{
		Version: applicationloop.ContractVersion, Kind: applicationloop.CommandPlanStop,
		ProjectID: 7, PlanID: 11, CallerScope: "fixture",
		RequestID: "request-stop", IdempotencyKey: "intent-stop",
	})
	if !errors.Is(err, applicationloop.ErrUnavailable) {
		t.Fatalf("error=%v", err)
	}
	if dispatcher.calls != 0 {
		t.Fatalf("plan.stop reached legacy dispatcher %d times", dispatcher.calls)
	}
}

type planStopCancellerSpy struct {
	calls             int
	projectID, planID int64
}

func (spy *planStopCancellerSpy) CancelPlanExecution(_ context.Context, projectID, planID int64) (bool, error) {
	spy.calls++
	spy.projectID, spy.planID = projectID, planID
	return true, nil
}

type planStopOperationStore struct{ operation domainoperation.Operation }

func (store *planStopOperationStore) Check(context.Context) error { return nil }
func (store *planStopOperationStore) ListProjects(context.Context) ([]repository.Project, error) {
	return []repository.Project{{ID: 7}}, nil
}
func (store *planStopOperationStore) Transact(ctx context.Context, apply func(applicationoperations.Transaction) error) error {
	return apply(planStopOperationTransaction{store})
}

type planStopOperationTransaction struct{ store *planStopOperationStore }

func (transaction planStopOperationTransaction) Create(_ context.Context, value domainoperation.Operation, _ string, _ json.RawMessage) (domainoperation.Operation, bool, error) {
	if transaction.store.operation.OperationID != "" {
		if transaction.store.operation.RequestDigest != value.RequestDigest {
			return domainoperation.Operation{}, false, applicationoperations.ErrIdempotencyConflict
		}
		return transaction.store.operation, false, nil
	}
	transaction.store.operation = value
	return value, true, nil
}
func (transaction planStopOperationTransaction) Get(_ context.Context, projectID int64, operationID string) (domainoperation.Operation, bool, error) {
	value := transaction.store.operation
	return value, value.ProjectID == projectID && value.OperationID == operationID, nil
}
func (transaction planStopOperationTransaction) List(context.Context, applicationoperations.ListQuery) ([]domainoperation.Operation, error) {
	if transaction.store.operation.OperationID == "" {
		return []domainoperation.Operation{}, nil
	}
	return []domainoperation.Operation{transaction.store.operation}, nil
}
func (transaction planStopOperationTransaction) Transition(_ context.Context, input applicationoperations.Transition) (domainoperation.Operation, bool, error) {
	value := transaction.store.operation
	if value.ProjectID != input.ProjectID || value.OperationID != input.OperationID {
		return domainoperation.Operation{}, false, repository.ErrNotFound
	}
	if value.Version != input.ExpectedVersion {
		return domainoperation.Operation{}, false, repository.ErrVersionConflict
	}
	value.Status, value.UpdatedAt, value.Version = input.Target, input.UpdatedAt, value.Version+1
	value.Result = input.Result
	if input.Target == domainoperation.StatusRunning {
		started := input.UpdatedAt
		value.StartedAt = &started
	}
	if input.Target.Terminal() {
		completed := input.UpdatedAt
		value.FinishedAt = &completed
	}
	transaction.store.operation = value
	return value, true, nil
}
func (transaction planStopOperationTransaction) RequestCancellation(context.Context, applicationoperations.CancelRequest) (domainoperation.Operation, bool, error) {
	return transaction.store.operation, false, nil
}

func TestPlanStopCompletesOperationAndReplaysIdempotently(t *testing.T) {
	writer := newStopServiceWriter(domainplan.StatusRunning, domainplan.TaskRunning, domainplan.TaskCompleted)
	planService := NewService(Dependencies{Assembler: stopServiceAssembler{}, Writer: writer, Clock: stopServiceClock{}})
	operationStore := &planStopOperationStore{}
	operationService := applicationoperations.NewService(applicationoperations.Dependencies{
		Store: operationStore, Clock: stopServiceClock{}, NewID: func() string { return "op-plan-stop" },
		RecoveryHandlers: RecoveryHandlers(),
	})
	canceller := &planStopCancellerSpy{}
	dispatcher := &planRuntimeDispatcherSpy{}
	handler := NewRuntimeHandler(dispatcher, RuntimeDependencies{
		Plans: planService, Operations: operationService, Loop: canceller,
	})
	command := applicationloop.Command{
		Version: applicationloop.ContractVersion, Kind: applicationloop.CommandPlanStop,
		ProjectID: 7, PlanID: 11, CallerScope: "fixture",
		RequestID: "request-stop", IdempotencyKey: "intent-stop",
	}
	first, err := handler.Execute(context.Background(), command)
	if err != nil {
		t.Fatal(err)
	}
	second, err := handler.Execute(context.Background(), command)
	if err != nil {
		t.Fatal(err)
	}
	if first.Operation.OperationID != "op-plan-stop" || first.Operation.Status != "completed" || second.Operation != first.Operation {
		t.Fatalf("operation replay drifted: first=%#v second=%#v", first.Operation, second.Operation)
	}
	if canceller.calls != 1 || canceller.projectID != 7 || canceller.planID != 11 {
		t.Fatalf("cancellation=%#v", canceller)
	}
	if dispatcher.calls != 0 || writer.state.plan.Status != domainplan.StatusInterrupted ||
		writer.state.tasks[0].Status != domainplan.TaskBlocked || writer.state.tasks[1].Status != domainplan.TaskCompleted {
		t.Fatalf("runtime stop state dispatcher=%d state=%#v", dispatcher.calls, writer.state)
	}
}

func TestPlanStopErrorsRemainDistinctAtRuntimeBoundary(t *testing.T) {
	for _, item := range []struct {
		name string
		got  error
		want error
	}{
		{"missing plan", mapPlanStopServiceError(repository.ErrNotFound), applicationloop.ErrNotFound},
		{"state conflict", mapPlanStopServiceError(ErrStateConflict), applicationloop.ErrStateConflict},
		{"repository unavailable", mapPlanStopServiceError(repository.ErrClosed), applicationloop.ErrRepositoryUnavailable},
		{"operation repository unavailable", mapPlanStopOperationError(repository.ErrInvalidStore), applicationloop.ErrRepositoryUnavailable},
		{"cancellation failed", mapPlanStopCancelError(errors.New("cancel failed")), applicationloop.ErrCancellationFailed},
	} {
		t.Run(item.name, func(t *testing.T) {
			if !errors.Is(item.got, item.want) {
				t.Fatalf("error=%v want=%v", item.got, item.want)
			}
		})
	}
}
