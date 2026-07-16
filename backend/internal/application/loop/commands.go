package loop

import (
	"context"
	"errors"

	applicationoperations "github.com/lyming99/autoplan/backend/internal/application/operations"
	domainloop "github.com/lyming99/autoplan/backend/internal/domain/loop"
	domainoperation "github.com/lyming99/autoplan/backend/internal/domain/operation"
	"github.com/lyming99/autoplan/backend/internal/runtime/scheduler"
)

// Start, Stop and RunOnce are the typed application entry points used by the
// future REST and MCP adapters. They all converge on Execute so transport
// metadata and idempotency are validated exactly once.
func (service *Service) Start(ctx context.Context, command Command) (Result, error) {
	command.Version, command.Kind = ContractVersion, CommandLoopStart
	return service.Execute(ctx, command)
}

func (service *Service) Stop(ctx context.Context, command Command) (Result, error) {
	command.Version, command.Kind = ContractVersion, CommandLoopStop
	return service.Execute(ctx, command)
}

func (service *Service) RunOnce(ctx context.Context, command Command) (Result, error) {
	command.Version, command.Kind = ContractVersion, CommandLoopRunOnce
	return service.Execute(ctx, command)
}

func (service *runtimeService) Execute(ctx context.Context, command Command) (Result, error) {
	if err := ValidateCommand(command); err != nil {
		return Result{}, err
	}
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return Result{}, err
	}
	_, manager, stateStore, _, err := service.dependencies()
	if err != nil {
		return Result{}, err
	}
	if err := stateStore.Check(ctx); err != nil {
		return Result{}, ErrRuntimeUnavailable
	}
	request := &commandRequest{service: service, command: command, digest: requestDigest(string(command.Kind), command.ProjectID, command.IdempotencyKey), reply: make(chan commandReply, 1)}
	// The caller context guards admission and the synchronous acceptance wait,
	// but it must not own a long-running Operation after 202 has been returned.
	// Explicit stop, deadline-aware runners, and scheduler shutdown remain the
	// cancellation authorities for accepted work.
	submission, err := manager.Submit(context.Background(), command.ProjectID, request.schedulerCommand())
	if err != nil {
		return Result{}, operationError(err)
	}
	request.submission = submission
	select {
	case reply := <-request.reply:
		if reply.err != nil {
			return Result{}, reply.err
		}
		return operationResult(reply.operation), nil
	case <-ctx.Done():
		submission.Cancel()
		return Result{}, ctx.Err()
	}
}

type commandReply struct {
	operation domainoperation.Operation
	err       error
}

type commandRequest struct {
	service    *runtimeService
	command    Command
	digest     string
	reply      chan commandReply
	submission *scheduler.Submission

	operation domainoperation.Operation
	created   bool
	claimed   bool
	noop      bool
	recovered bool
	output    RunOutput
}

func (request *commandRequest) schedulerCommand() scheduler.Command {
	value := scheduler.Command{Name: string(request.command.Kind), Start: request.start}
	if request.command.Kind == CommandLoopRunOnce {
		value.Work = request.run
		value.Cancel = request.cancel
		value.Complete = request.complete
	}
	return value
}

func (request *commandRequest) start(ctx context.Context) error {
	operations, _, stateStore, _, err := request.service.dependencies()
	if err != nil {
		request.respond(commandReply{err: err})
		return err
	}
	if request.recovered {
		switch request.command.Kind {
		case CommandLoopStart:
			err = request.startLoop(ctx, stateStore)
		case CommandLoopStop:
			err = request.stopLoop(ctx, stateStore)
		case CommandLoopRunOnce:
			err = request.beginRun(ctx, stateStore)
		default:
			err = ErrUnsupportedCommand
		}
		if err != nil {
			request.failClaimed(ctx, err)
		}
		request.respond(commandReply{operation: request.operation, err: err})
		return err
	}
	created, err := operations.CreateOrReuse(ctx, applicationoperations.CreateCommand{
		Caller: operationCaller(request.command), ProjectID: request.command.ProjectID, Type: string(request.command.Kind),
		IdempotencyKey: request.command.IdempotencyKey, RequestDigest: request.digest, RequestID: request.command.RequestID,
	})
	if err != nil {
		err = operationError(err)
		request.respond(commandReply{err: err})
		return err
	}
	request.operation, request.created = created.Operation, created.Changed
	if !request.created {
		request.noop = true
		request.respond(commandReply{operation: request.operation})
		return nil
	}
	claimed, err := operations.Claim(ctx, applicationoperations.ClaimCommand{
		Caller: operationCaller(request.command), ProjectID: request.command.ProjectID, OperationID: created.Operation.OperationID,
		ExpectedVersion: created.Operation.Version, RequestDigest: request.digest, RequestID: request.command.RequestID,
	})
	if err != nil {
		request.cancelCreated(ctx, created.Operation)
		err = operationError(err)
		request.respond(commandReply{err: err})
		return err
	}
	request.operation, request.claimed = claimed.Operation, true

	switch request.command.Kind {
	case CommandLoopStart:
		err = request.startLoop(ctx, stateStore)
	case CommandLoopStop:
		err = request.stopLoop(ctx, stateStore)
	case CommandLoopRunOnce:
		err = request.beginRun(ctx, stateStore)
	default:
		err = ErrUnsupportedCommand
	}
	if err != nil {
		request.failClaimed(ctx, err)
		request.respond(commandReply{err: err})
		return err
	}
	request.respond(commandReply{operation: request.operation})
	return nil
}

func (request *commandRequest) startLoop(ctx context.Context, stateStore StateStore) error {
	state, exists, err := stateStore.Get(ctx, request.command.ProjectID)
	if err != nil {
		return err
	}
	if !exists {
		return ErrProjectNotFound
	}
	next, changed, err := domainloop.Start(state)
	if err != nil {
		return ErrStateConflict
	}
	if changed {
		if _, _, err = stateStore.Save(ctx, next, state.Version); err != nil {
			return err
		}
	}
	if err := request.succeed(ctx, nil); err != nil {
		return err
	}
	if changed || (request.recovered && next.Running) {
		request.service.arm(request.command.ProjectID, next.IntervalSeconds)
	}
	return nil
}

func (request *commandRequest) stopLoop(ctx context.Context, stateStore StateStore) error {
	state, exists, err := stateStore.Get(ctx, request.command.ProjectID)
	if err != nil {
		return err
	}
	if !exists {
		return ErrProjectNotFound
	}
	next, _, err := domainloop.Stop(state)
	if err != nil {
		return ErrStateConflict
	}
	if _, _, err = stateStore.Save(ctx, next, state.Version); err != nil {
		return err
	}
	request.service.disarm(request.command.ProjectID)
	request.service.cancelActive(ctx, request.command.ProjectID)
	return request.succeed(ctx, nil)
}

func (request *commandRequest) beginRun(ctx context.Context, stateStore StateStore) error {
	if request.service.hasActive(request.command.ProjectID) {
		request.noop = true
		return request.succeed(ctx, nil)
	}
	state, exists, err := stateStore.Get(ctx, request.command.ProjectID)
	if err != nil {
		return err
	}
	if !exists {
		return ErrProjectNotFound
	}
	next, err := domainloop.BeginRun(state)
	if err != nil {
		return ErrStateConflict
	}
	if _, _, err = stateStore.Save(ctx, next, state.Version); err != nil {
		return err
	}
	request.service.setActive(request.command.ProjectID, &activeRun{operation: request.operation, requestDigest: request.digest, request: request})
	return nil
}

func (request *commandRequest) succeed(ctx context.Context, _ *domainoperation.Operation) error {
	operations, _, _, _, err := request.service.dependencies()
	if err != nil {
		return err
	}
	completed, err := operations.Succeed(ctx, applicationoperations.CompleteCommand{
		Caller: operationCaller(request.command), ProjectID: request.command.ProjectID, OperationID: request.operation.OperationID,
		ExpectedVersion: request.operation.Version, RequestID: request.command.RequestID,
	})
	if err != nil {
		return operationError(err)
	}
	request.operation = completed.Operation
	return nil
}

func (request *commandRequest) failClaimed(ctx context.Context, failure error) {
	operations, _, _, _, err := request.service.dependencies()
	if err != nil || !request.claimed {
		return
	}
	_, _ = operations.Fail(ctx, applicationoperations.FailCommand{
		Caller: operationCaller(request.command), ProjectID: request.command.ProjectID, OperationID: request.operation.OperationID,
		ExpectedVersion: request.operation.Version, RequestID: request.command.RequestID,
		Code: "LOOP_COMMAND_FAILED", Summary: "Loop command could not be completed.",
	})
}

func (request *commandRequest) cancelCreated(ctx context.Context, operation domainoperation.Operation) {
	operations, _, _, _, err := request.service.dependencies()
	if err != nil {
		return
	}
	_, _ = operations.ConfirmCancel(ctx, applicationoperations.CancelCommand{
		Caller: operationCaller(request.command), ProjectID: request.command.ProjectID, OperationID: operation.OperationID,
		ExpectedVersion: operation.Version, RequestID: request.command.RequestID,
	})
}

func (request *commandRequest) respond(reply commandReply) {
	select {
	case request.reply <- reply:
	default:
	}
}

func (service *runtimeService) hasActive(projectID int64) bool {
	service.mu.Lock()
	defer service.mu.Unlock()
	return service.active[projectID] != nil
}

func (service *runtimeService) setActive(projectID int64, active *activeRun) {
	service.mu.Lock()
	service.active[projectID] = active
	service.mu.Unlock()
}

func (service *runtimeService) clearActive(projectID int64, operationID string) {
	service.mu.Lock()
	if active := service.active[projectID]; active != nil && active.operation.OperationID == operationID {
		delete(service.active, projectID)
		delete(service.planStops, projectID)
	}
	service.mu.Unlock()
}

func isCancellation(err error) bool {
	return errors.Is(err, context.Canceled)
}
