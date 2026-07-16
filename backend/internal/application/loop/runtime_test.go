package loop

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/lyming99/autoplan/backend/internal/application/capabilities"
	domainoperation "github.com/lyming99/autoplan/backend/internal/domain/operation"
)

type dispatcherSpy struct {
	command Command
	err     error
}

func TestTaskCancellationDoesNotTargetAnotherActiveLoopOperation(t *testing.T) {
	service := &Service{runtime: &runtimeService{active: map[int64]*activeRun{
		7: {operation: domainoperation.Operation{OperationID: "loop-operation-active"}},
	}}}
	cancelled, err := service.CancelTaskExecution(context.Background(), 7, "loop-operation-stale")
	if err != nil || cancelled {
		t.Fatalf("mismatched task cancellation = %t, %v", cancelled, err)
	}
}

func TestPlanCancellationRequiresExactClaimedPlanAssociation(t *testing.T) {
	runtime := &runtimeService{active: map[int64]*activeRun{
		7: {operation: domainoperation.Operation{OperationID: "loop-operation-active"}},
	}}
	service := &Service{runtime: runtime}
	if !runtime.associatePlan(7, "loop-operation-active", 11) {
		t.Fatal("active operation did not accept its claimed plan association")
	}
	if runtime.associatePlan(7, "loop-operation-stale", 12) || runtime.active[7].planID != 11 {
		t.Fatal("stale operation replaced the active plan association")
	}
	for _, target := range [][2]int64{{7, 12}, {8, 11}} {
		cancelled, err := service.CancelPlanExecution(context.Background(), target[0], target[1])
		if err != nil || cancelled {
			t.Fatalf("unrelated plan cancellation %v = %t, %v", target, cancelled, err)
		}
	}
}

func TestPlanCancellationIntentClosesClaimAssociationRace(t *testing.T) {
	runtime := &runtimeService{active: map[int64]*activeRun{
		7: {operation: domainoperation.Operation{OperationID: "loop-operation-active"}},
	}}
	service := &Service{runtime: runtime}
	cancelled, err := service.CancelPlanExecution(context.Background(), 7, 11)
	if err != nil || cancelled {
		t.Fatalf("pre-association cancellation = %t, %v", cancelled, err)
	}
	if runtime.associatePlan(7, "loop-operation-active", 11) {
		t.Fatal("runner was allowed to start work after plan stop intent")
	}
	if runtime.active[7].planID != 11 {
		t.Fatal("claimed plan association was not retained for cancellation")
	}
}

func (spy *dispatcherSpy) Dispatch(_ context.Context, command Command) (Result, error) {
	spy.command = command
	if spy.err != nil {
		return Result{}, spy.err
	}
	return Result{Operation: capabilities.OperationReference{
		OperationID: "operation-fixture", Type: string(command.Kind), Status: "accepted",
		RequestID: command.RequestID, AcceptedAt: "2026-07-12T00:00:00.000Z",
	}}, nil
}

func TestBridgeDispatchesClosedLoopCommand(t *testing.T) {
	spy := &dispatcherSpy{}
	bridge, err := NewBridge(NewService(Dependencies{Dispatcher: spy}))
	if err != nil {
		t.Fatal(err)
	}
	command := Command{
		Version: ContractVersion, Kind: CommandLoopStart, ProjectID: 7,
		CallerScope: "fixture", RequestID: "request-fixture", IdempotencyKey: "intent-fixture",
	}
	result, err := bridge.Execute(context.Background(), command)
	if err != nil {
		t.Fatal(err)
	}
	if result.Operation.OperationID == "" || spy.command.Kind != CommandLoopStart || spy.command.ProjectID != 7 {
		t.Fatalf("result=%#v command=%#v", result, spy.command)
	}
}

func TestBridgeFailsClosedWithoutDispatcherOrForUnownedCommand(t *testing.T) {
	bridge, err := NewBridge(NewService(Dependencies{Dispatcher: UnavailableDispatcher{}}))
	if err != nil {
		t.Fatal(err)
	}
	command := Command{Version: ContractVersion, Kind: CommandLoopStop, ProjectID: 7, CallerScope: "fixture", RequestID: "request-fixture", IdempotencyKey: "intent-fixture"}
	if _, err := bridge.Execute(context.Background(), command); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("unavailable error=%v", err)
	}
	command.Kind = CommandPlanRun
	command.PlanID = 3
	if _, err := bridge.Execute(context.Background(), command); !errors.Is(err, ErrUnsupportedCommand) {
		t.Fatalf("unsupported error=%v", err)
	}
}

func TestCommandValidationRejectsUnboundedRuntimeInputs(t *testing.T) {
	command := Command{Version: ContractVersion, Kind: CommandChatSend, ProjectID: 7, ConversationID: 2, CallerScope: "fixture", RequestID: "request-fixture", Chat: &ChatInput{Content: ""}}
	if err := ValidateCommand(command); !errors.Is(err, ErrInvalidCommand) {
		t.Fatalf("empty content error=%v", err)
	}
	command.Chat.Content = "message"
	command.Batches = []TaskBatch{{TaskIDs: []int64{1, 1}}}
	if err := ValidateCommand(command); !errors.Is(err, ErrInvalidCommand) {
		t.Fatalf("duplicate batch task error=%v", err)
	}
}

func TestCommandValidationBoundsAcceptanceIntent(t *testing.T) {
	command := Command{
		Version: ContractVersion, Kind: CommandAcceptanceAcceptBatch, ProjectID: 7,
		CallerScope: "fixture", RequestID: "request-fixture", IdempotencyKey: "intent-fixture",
		Acceptance: &AcceptanceInput{Targets: []AcceptanceTarget{{TargetType: "plan", ID: 3}, {TargetType: "task", ID: 8}}},
	}
	if err := ValidateCommand(command); err != nil {
		t.Fatalf("valid acceptance input error=%v", err)
	}
	command.Acceptance.Targets = append(command.Acceptance.Targets, AcceptanceTarget{TargetType: "plan", ID: 3})
	if err := ValidateCommand(command); !errors.Is(err, ErrInvalidCommand) {
		t.Fatalf("duplicate acceptance target error=%v", err)
	}
	command.Acceptance.Targets = []AcceptanceTarget{{TargetType: "plan", ID: 3}}
	command.Acceptance.Supplement = strings.Repeat("补", 2001)
	if err := ValidateCommand(command); !errors.Is(err, ErrInvalidCommand) {
		t.Fatalf("oversized acceptance supplement error=%v", err)
	}
}
