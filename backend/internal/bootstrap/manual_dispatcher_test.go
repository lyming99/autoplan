package bootstrap

import (
	"context"
	"errors"
	"testing"

	applicationloop "github.com/lyming99/autoplan/backend/internal/application/loop"
	"github.com/lyming99/autoplan/backend/internal/repository"
)

type manualDispatcherRepositoryStub struct{}

func (manualDispatcherRepositoryStub) ActivateDraftPlanTask(context.Context, repository.DraftPlanTaskActivation) (bool, error) {
	return false, nil
}

func (manualDispatcherRepositoryStub) RequestPlanTaskStop(context.Context, repository.PlanTaskStopInput) (repository.PlanTaskStopResult, error) {
	return repository.PlanTaskStopResult{}, nil
}

func TestManualRuntimeDispatcherRecognizesTaskStop(t *testing.T) {
	repositoryStub := manualDispatcherRepositoryStub{}
	dispatcher := newManualRuntimeDispatcher(repositoryStub)
	_, err := dispatcher.Dispatch(context.Background(), applicationloop.Command{
		Version: applicationloop.ContractVersion, Kind: applicationloop.CommandTaskStop,
		ProjectID: 7, PlanID: 11, TaskID: 12, CallerScope: "test",
		RequestID: "request-stop", IdempotencyKey: "intent-stop",
	})
	if !errors.Is(err, applicationloop.ErrUnavailable) || errors.Is(err, applicationloop.ErrUnsupportedCommand) {
		t.Fatalf("task.stop dispatch error = %v", err)
	}
}
