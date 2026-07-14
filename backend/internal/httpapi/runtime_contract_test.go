package httpapi

import (
	"errors"
	"testing"

	applicationloop "github.com/lyming99/autoplan/backend/internal/application/loop"
)

func TestP11RuntimeRoutesRemainProjectScopedAcrossTransportAdapters(t *testing.T) {
	for _, route := range []string{
		LoopStartActionPath,
		LoopStopActionPath,
		LoopRunOnceActionPath,
		ProjectPlanStopActionPath,
		ProjectPlanResumeActionPath,
		ProjectPlanReexecuteActionPath,
		ProjectPlanRecreateActionPath,
		ProjectTaskRunActionPath,
		ProjectTaskStopActionPath,
		ProjectTaskRunBatchesActionPath,
		AcceptanceAcceptActionPath,
		AcceptanceUnacceptActionPath,
		AcceptanceRedoActionPath,
		AcceptanceAcceptBatchActionPath,
		AcceptanceUnacceptBatchActionPath,
		IntakeRetryPlanGenerationActionPath,
		IntakeInterruptActionPath,
		IntakeResumeActionPath,
		IntakeAppendTaskActionPath,
	} {
		if !validResourceRoutePattern(route) {
			t.Fatalf("runtime resource route is not bounded: %s", route)
		}
	}
	if validResourceRoutePattern("/api/v1/projects/{project_id}/plans/{plan_id}/tasks/{task_id}/actions/run") {
		t.Fatal("three-resource runtime route bypasses bounded adapter contract")
	}
}

func TestP11RuntimeBridgeUsesSameClosedCommandValidationForNodeAndREST(t *testing.T) {
	command := applicationloop.Command{
		Version: applicationloop.ContractVersion, Kind: applicationloop.CommandLoopRunOnce, ProjectID: 7,
		CallerScope: "http-fixture", RequestID: "request-fixture", IdempotencyKey: "intent-fixture",
	}
	if err := applicationloop.ValidateCommand(command); err != nil {
		t.Fatalf("valid command rejected: %v", err)
	}
	command.Kind = applicationloop.CommandTaskRunBatches
	command.Batches = []applicationloop.TaskBatch{{TaskIDs: []int64{11, 11}}}
	if err := applicationloop.ValidateCommand(command); !errors.Is(err, applicationloop.ErrInvalidCommand) {
		t.Fatalf("duplicate batch command error=%v", err)
	}
	command = applicationloop.Command{
		Version: applicationloop.ContractVersion, Kind: applicationloop.CommandLoopStart, ProjectID: 7,
		CallerScope: "http\nfixture", RequestID: "request-fixture", IdempotencyKey: "intent-fixture",
	}
	if err := applicationloop.ValidateCommand(command); !errors.Is(err, applicationloop.ErrInvalidCommand) {
		t.Fatalf("unsafe caller scope error=%v", err)
	}
}
