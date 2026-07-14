package scripts

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"

	applicationoperations "github.com/lyming99/autoplan/backend/internal/application/operations"
	domainautomation "github.com/lyming99/autoplan/backend/internal/domain/automation"
	domainoperation "github.com/lyming99/autoplan/backend/internal/domain/operation"
	"github.com/lyming99/autoplan/backend/internal/repository"
	"github.com/lyming99/autoplan/backend/internal/runtime/process"
	"github.com/lyming99/autoplan/backend/internal/runtime/scheduler"
)

type runRequest struct {
	service *Service
	command RunCommand
	trigger Trigger
	stage   string
	digest  string
	key     string
	reply   chan runReply

	operation  domainoperation.Operation
	script     domainautomation.Script
	submission *scheduler.Submission
	active     bool
	result     process.Result
}

type runReply struct {
	result Result
	err    error
}

func (service *Service) submit(ctx context.Context, command RunCommand, trigger Trigger, stage string) (Result, error) {
	if err := service.ready(ctx); err != nil {
		return Result{}, err
	}
	if !validCaller(command.Caller, command.ProjectID) || command.ScriptID <= 0 || !validIdentity(command.RequestID, 64) || !validIdentity(command.IdempotencyKey, 128) ||
		!trigger.valid() || (trigger == TriggerHook && !validHookStage(stage)) || (trigger != TriggerHook && stage != "") || !command.Context.Valid() {
		return Result{}, ErrInvalidCommand
	}
	key := scriptKey{projectID: command.ProjectID, scriptID: command.ScriptID}
	operationKey := operationKey(command.ScriptID, command.IdempotencyKey)
	digest := scriptDigest(command.ProjectID, command.ScriptID, trigger, stage, command.IdempotencyKey)
	if existing, found := service.activeByIdentity(key, operationKey, digest); found {
		return Result{Operation: existing, Changed: false}, nil
	}
	request := &runRequest{
		service: service, command: command, trigger: trigger, stage: stage, key: operationKey, digest: digest,
		reply: make(chan runReply, 1),
	}
	submission, err := service.scheduler.Submit(context.Background(), command.ProjectID, scheduler.Command{
		Name: OperationType, Start: request.start, Work: request.work, Cancel: request.cancel, Complete: request.complete,
	})
	if err != nil {
		return Result{}, schedulerError(err)
	}
	request.submission = submission
	select {
	case reply := <-request.reply:
		return reply.result, reply.err
	case <-ctx.Done():
		submission.Cancel()
		return Result{}, ctx.Err()
	}
}

func (request *runRequest) start(ctx context.Context) error {
	if request == nil || request.service == nil {
		return ErrUnavailable
	}
	if request.service.hasActive(request.command.ProjectID, request.command.ScriptID) {
		request.respond(Result{}, ErrBusy)
		return ErrBusy
	}
	project, script, err := request.loadAuthorized(ctx)
	if err != nil {
		request.respond(Result{}, err)
		return err
	}
	if err := request.authorizeSource(ctx, project, script); err != nil {
		request.respond(Result{}, err)
		return err
	}
	if request.trigger == TriggerManual {
		request.stage = "manual"
		if script.HookStage != nil && *script.HookStage != "" {
			request.stage = *script.HookStage
		}
	} else if request.trigger == TriggerSchedule {
		request.stage = "schedule"
	}
	created, err := request.service.operations.CreateOrReuse(ctx, applicationoperations.CreateCommand{
		Caller: operationCaller(request.command), ProjectID: request.command.ProjectID, Type: OperationType,
		IdempotencyKey: request.key, RequestDigest: request.digest, RequestID: request.command.RequestID,
	})
	if err != nil {
		err = operationError(err)
		request.respond(Result{}, err)
		return err
	}
	request.operation = created.Operation
	if !created.Changed {
		request.respond(Result{Operation: created.Operation, Changed: false}, nil)
		return nil
	}
	claimed, err := request.service.operations.Claim(ctx, applicationoperations.ClaimCommand{
		Caller: operationCaller(request.command), ProjectID: request.command.ProjectID, OperationID: created.Operation.OperationID,
		ExpectedVersion: created.Operation.Version, RequestDigest: request.digest, RequestID: request.command.RequestID,
	})
	if err != nil {
		request.cancelCreated(ctx, created.Operation)
		err = operationError(err)
		request.respond(Result{}, err)
		return err
	}
	request.operation, request.script, request.active = claimed.Operation, script, true
	request.service.setActive(request)
	request.service.setRuntimeRunning(request.command.ProjectID, request.command.ScriptID)
	request.respond(Result{Operation: request.operation, Changed: true}, nil)
	return nil
}

func (request *runRequest) loadAuthorized(ctx context.Context) (repository.Project, domainautomation.Script, error) {
	if request == nil || request.service == nil {
		return repository.Project{}, domainautomation.Script{}, ErrUnavailable
	}
	project, found, err := request.service.store.GetProject(ctx, request.command.ProjectID)
	if err != nil {
		return repository.Project{}, domainautomation.Script{}, err
	}
	if !found || project.ID != request.command.ProjectID || strings.TrimSpace(project.WorkspacePath) == "" {
		return repository.Project{}, domainautomation.Script{}, ErrNotFound
	}
	script, found, err := request.service.store.GetScript(ctx, request.command.ProjectID, request.command.ScriptID)
	if err != nil {
		return repository.Project{}, domainautomation.Script{}, err
	}
	if !found || script.ProjectID == nil || *script.ProjectID != request.command.ProjectID || domainautomation.ValidateScriptRecord(script) != nil {
		return repository.Project{}, domainautomation.Script{}, ErrNotFound
	}
	if !script.Enabled {
		return repository.Project{}, domainautomation.Script{}, ErrDisabled
	}
	if err := matchesTrigger(script, request.trigger, request.stage); err != nil {
		return repository.Project{}, domainautomation.Script{}, err
	}
	return project, script, nil
}

func (request *runRequest) authorizeSource(ctx context.Context, project repository.Project, script domainautomation.Script) error {
	workingDirectory, err := resolveWorkingDirectory(script.WorkDir, project.WorkspacePath)
	if err != nil {
		return ErrInvalidCommand
	}
	workingDecision, err := request.service.files.AuthorizeWorkingDirectory(ctx, project.WorkspacePath, workingDirectory)
	if err != nil || !workingDecision.Allowed || strings.TrimSpace(workingDecision.ResolvedTarget) == "" {
		return ErrInvalidCommand
	}
	if script.SourceType != "file" {
		return nil
	}
	source, err := resolveScriptPath(script.Path, project.WorkspacePath)
	if err != nil {
		return ErrInvalidCommand
	}
	decision, err := request.service.files.AuthorizeScriptSource(ctx, project.WorkspacePath, source)
	if err != nil || !decision.Allowed || strings.TrimSpace(decision.ResolvedTarget) == "" {
		return ErrInvalidCommand
	}
	return nil
}

func (request *runRequest) work(ctx context.Context) error {
	if request == nil || !request.active {
		return nil
	}
	project, found, err := request.service.store.GetProject(ctx, request.command.ProjectID)
	if err != nil || !found || project.ID != request.command.ProjectID {
		if err != nil {
			return err
		}
		return ErrNotFound
	}
	spec, err := request.processSpec(ctx, project, request.script)
	if err != nil {
		return err
	}
	result, runErr := request.service.runner.Run(ctx, spec)
	request.result = result
	if runErr != nil {
		return runErr
	}
	if result.ExitCode != 0 {
		return errNonZeroExit
	}
	return nil
}

func (request *runRequest) processSpec(ctx context.Context, project repository.Project, script domainautomation.Script) (process.Spec, error) {
	workDir, err := resolveWorkingDirectory(script.WorkDir, project.WorkspacePath)
	if err != nil {
		return process.Spec{}, ErrInvalidCommand
	}
	executable, args, suffix, err := interpreter(script.Runtime)
	if err != nil {
		return process.Spec{}, ErrInvalidCommand
	}
	spec := process.Spec{
		ProjectID: request.command.ProjectID, Resource: process.ResourceRef{Kind: process.ResourceScript, ID: script.ID},
		Workspace: project.WorkspacePath, WorkingDirectory: workDir, Executable: executable, Args: args,
		Timeout: time.Duration(script.TimeoutSeconds) * time.Second,
	}
	if script.SourceType == "file" {
		source, resolveErr := resolveScriptPath(script.Path, project.WorkspacePath)
		if resolveErr != nil {
			return process.Spec{}, ErrInvalidCommand
		}
		decision, authorizeErr := request.service.files.AuthorizeScriptSource(ctx, project.WorkspacePath, source)
		if authorizeErr != nil || !decision.Allowed || decision.ResolvedTarget == "" {
			return process.Spec{}, ErrInvalidCommand
		}
		spec.Args = append(spec.Args, decision.ResolvedTarget)
	} else {
		spec.InlineScript = &process.InlineScript{Body: []byte(script.Body), Suffix: suffix}
	}
	contextValue, err := request.command.Context.withRuntime(request.stage, request.trigger, project.WorkspacePath)
	if err != nil {
		return process.Spec{}, ErrInvalidCommand
	}
	if script.ContextInject == "stdin" {
		encoded, encodeErr := json.Marshal(contextValue)
		if encodeErr != nil {
			return process.Spec{}, ErrInvalidCommand
		}
		spec.Input = encoded
	} else if script.ContextInject == "env" {
		encoded, encodeErr := json.Marshal(contextValue)
		if encodeErr != nil {
			return process.Spec{}, ErrInvalidCommand
		}
		spec.Environment = map[string]string{
			"AUTOPLAN_STAGE": request.stage, "AUTOPLAN_WORKSPACE": project.WorkspacePath, "AUTOPLAN_CONTEXT": string(encoded),
		}
		if contextValue.PlanID != nil {
			spec.Environment["AUTOPLAN_PLAN_ID"] = strconv.FormatInt(*contextValue.PlanID, 10)
		}
		if contextValue.TaskKey != nil {
			spec.Environment["AUTOPLAN_TASK_KEY"] = *contextValue.TaskKey
		}
		if len(contextValue.ScopeFiles) != 0 {
			spec.Environment["AUTOPLAN_SCOPE_FILES"] = strings.Join(contextValue.ScopeFiles, ",")
		}
	}
	return spec, nil
}

func (request *runRequest) cancel(context.Context) {
	// Stop first writes the Operation cancellation request and then asks the
	// scheduler to cancel this work. The cancellation-aware P11 runner reaps
	// exactly the process tree created by this request.
}

func (request *runRequest) complete(ctx context.Context, work scheduler.WorkResult) error {
	if request == nil || request.service == nil || !request.active {
		return nil
	}
	active, found := request.service.activeFor(request.command.ProjectID, request.command.ScriptID, request.operation.OperationID)
	if !found {
		return nil
	}
	defer request.service.clearActive(request.command.ProjectID, request.command.ScriptID, request.operation.OperationID)
	duration := durationMilliseconds(request.result, work)
	target := domainoperation.StatusSucceeded
	status := "ok"
	failureLabel, summary := "", ""
	if active.cancelled || work.Cancelled || errors.Is(work.Err, context.Canceled) || errors.Is(work.Err, process.ErrCancelled) {
		target, status = domainoperation.StatusCancelled, "cancelled"
	} else if work.Err != nil {
		target, status = domainoperation.StatusFailed, "bad"
		failureLabel, summary = failureCode(work.Err), "Script execution failed."
	}
	archive := applicationoperations.ArchiveOutput(&applicationoperations.OutputCapture{
		Stdout: []byte(request.result.Stdout.Tail), Stderr: []byte(request.result.Stderr.Tail),
	}, 8<<10, 256)
	output := domainoperation.OutputMetadata{}
	if archive.Metadata != nil {
		output = *archive.Metadata
	}
	completed, err := request.service.finalizer.FinalizeScriptRun(ctx, RunFinalization{
		ProjectID: request.command.ProjectID, ScriptID: request.command.ScriptID,
		OperationID: active.operation.OperationID, RequestID: request.command.RequestID,
		ExpectedVersion: active.operation.Version, Target: target, Status: status,
		FailureCode: failureLabel, Summary: summary, ExitCode: int64(request.result.ExitCode), DurationMS: duration,
		StdoutTail: archive.StdoutTail, StderrTail: archive.StderrTail, Output: output,
		OccurredAt: terminalTimestamp(request.service.clock.Now(), active.operation.UpdatedAt),
	})
	if err != nil {
		return err
	}
	request.service.setRuntimeTerminal(request.command.ProjectID, request.command.ScriptID, status, int64(request.result.ExitCode), duration)
	request.operation = completed
	return work.Err
}

func terminalTimestamp(now time.Time, previous string) string {
	value := now.UTC()
	if parsed, err := time.Parse(time.RFC3339Nano, previous); err == nil && !value.After(parsed) {
		value = parsed.Add(time.Millisecond)
	}
	return value.Format(time.RFC3339Nano)
}

func (request *runRequest) cancelCreated(ctx context.Context, operation domainoperation.Operation) {
	_, _ = request.service.operations.ConfirmCancel(ctx, applicationoperations.CancelCommand{
		Caller: operationCaller(request.command), ProjectID: request.command.ProjectID, OperationID: operation.OperationID,
		ExpectedVersion: operation.Version, RequestID: request.command.RequestID,
	})
}

func (request *runRequest) respond(result Result, err error) {
	select {
	case request.reply <- runReply{result: result, err: err}:
	default:
	}
}

func matchesTrigger(script domainautomation.Script, trigger Trigger, stage string) error {
	switch trigger {
	case TriggerManual:
		if script.TriggerMode != string(TriggerManual) {
			return ErrTriggerMismatch
		}
	case TriggerHook:
		if script.TriggerMode != string(TriggerHook) || script.HookStage == nil || *script.HookStage != stage {
			return ErrTriggerMismatch
		}
	case TriggerSchedule:
		if script.TriggerMode != string(TriggerSchedule) || script.ScheduleCron == nil {
			return ErrTriggerMismatch
		}
	default:
		return ErrInvalidCommand
	}
	return nil
}

func interpreter(value string) (string, []string, string, error) {
	switch value {
	case "node":
		return "node", nil, ".cjs", nil
	case "bash":
		return "bash", nil, ".sh", nil
	case "ps":
		if runtime.GOOS == "windows" {
			return "powershell", []string{"-NoProfile", "-ExecutionPolicy", "Bypass", "-File"}, ".ps1", nil
		}
		return "pwsh", []string{"-NoProfile", "-File"}, ".ps1", nil
	case "cmd":
		return "cmd", []string{"/c"}, ".cmd", nil
	default:
		return "", nil, "", ErrInvalidCommand
	}
}

func resolveWorkingDirectory(value, workspace string) (string, error) {
	if strings.TrimSpace(workspace) == "" {
		return "", ErrInvalidCommand
	}
	if strings.TrimSpace(value) == "" {
		return filepath.Clean(workspace), nil
	}
	return resolveScriptPath(value, workspace)
}

func resolveScriptPath(value, workspace string) (string, error) {
	raw := strings.TrimSpace(value)
	if raw == "" || strings.TrimSpace(workspace) == "" || strings.ContainsRune(raw, 0) {
		return "", ErrInvalidCommand
	}
	planDir := filepath.Join(workspace, "docs", "plan")
	resolved := strings.ReplaceAll(strings.ReplaceAll(raw, "${workspace}", workspace), "${planDir}", planDir)
	if strings.TrimSpace(resolved) == "" {
		return "", ErrInvalidCommand
	}
	if !filepath.IsAbs(resolved) {
		resolved = filepath.Join(workspace, resolved)
	}
	return filepath.Clean(resolved), nil
}

func operationCaller(command RunCommand) applicationoperations.Caller {
	return applicationoperations.Caller{ID: command.Caller.ID, ProjectID: command.ProjectID}
}

func validCaller(caller Caller, projectID int64) bool {
	return projectID > 0 && caller.ProjectID == projectID && validIdentity(caller.ID, 128)
}

func validIdentity(value string, maximum int) bool {
	if value == "" || len(value) > maximum || strings.ContainsAny(value, "\r\n\x00") {
		return false
	}
	for index, character := range value {
		if !(character >= 'A' && character <= 'Z' || character >= 'a' && character <= 'z' || character >= '0' && character <= '9' ||
			(index > 0 && (character == '.' || character == '_' || character == ':' || character == '-'))) {
			return false
		}
	}
	return true
}

func (trigger Trigger) valid() bool {
	return trigger == TriggerManual || trigger == TriggerHook || trigger == TriggerSchedule
}

func operationKey(scriptID int64, idempotencyKey string) string {
	sum := sha256.Sum256([]byte(strconv.FormatInt(scriptID, 10) + "\x00" + idempotencyKey))
	return "script-" + strconv.FormatInt(scriptID, 10) + "-" + hex.EncodeToString(sum[:16])
}

func scriptDigest(projectID, scriptID int64, trigger Trigger, stage, idempotencyKey string) string {
	sum := sha256.Sum256([]byte(OperationType + "\x00" + strconv.FormatInt(projectID, 10) + "\x00" + strconv.FormatInt(scriptID, 10) + "\x00" + string(trigger) + "\x00" + stage + "\x00" + idempotencyKey))
	return hex.EncodeToString(sum[:])
}

func schedulerError(err error) error {
	switch {
	case errors.Is(err, scheduler.ErrActorQueueFull), errors.Is(err, scheduler.ErrWorkerQueueFull):
		return ErrQueueFull
	case errors.Is(err, scheduler.ErrManagerClosed), errors.Is(err, scheduler.ErrActorClosed), errors.Is(err, scheduler.ErrWorkerPoolClosed):
		return ErrUnavailable
	default:
		return ErrStateConflict
	}
}

func operationError(err error) error {
	switch {
	case errors.Is(err, applicationoperations.ErrUnavailable), errors.Is(err, applicationoperations.ErrHandlerUnavailable):
		return ErrUnavailable
	case errors.Is(err, applicationoperations.ErrUnauthorized):
		return ErrUnauthorized
	case errors.Is(err, applicationoperations.ErrNotFound):
		return ErrNotFound
	case errors.Is(err, applicationoperations.ErrIdempotencyConflict), errors.Is(err, applicationoperations.ErrStateConflict), errors.Is(err, applicationoperations.ErrVersionConflict):
		return ErrStateConflict
	default:
		return ErrInvalidCommand
	}
}

var errNonZeroExit = errors.New("script process exited non-zero")

func failureCode(err error) string {
	if errors.Is(err, errNonZeroExit) {
		return "SCRIPT_EXIT_NONZERO"
	}
	return string(process.ErrorCode(err))
}

func durationMilliseconds(result process.Result, work scheduler.WorkResult) int64 {
	start, end := result.StartedAt, result.EndedAt
	if start.IsZero() {
		start = work.StartedAt
	}
	if end.IsZero() {
		end = work.EndedAt
	}
	if start.IsZero() || end.IsZero() || end.Before(start) {
		return 0
	}
	return end.Sub(start).Milliseconds()
}

func (service *Service) activeByIdentity(key scriptKey, idempotencyKey, digest string) (domainoperation.Operation, bool) {
	service.mu.Lock()
	defer service.mu.Unlock()
	active := service.active[key]
	if active == nil || active.idempotencyKey != idempotencyKey || active.digest != digest {
		return domainoperation.Operation{}, false
	}
	return active.operation, true
}

func (service *Service) hasActive(projectID, scriptID int64) bool {
	service.mu.Lock()
	defer service.mu.Unlock()
	return service.active[scriptKey{projectID: projectID, scriptID: scriptID}] != nil
}

func (service *Service) setActive(request *runRequest) {
	key := scriptKey{projectID: request.command.ProjectID, scriptID: request.command.ScriptID}
	service.mu.Lock()
	service.active[key] = &activeRun{operation: request.operation, script: request.script, request: request, submission: request.submission, idempotencyKey: request.key, digest: request.digest}
	service.mu.Unlock()
}

func (service *Service) activeFor(projectID, scriptID int64, operationID string) (*activeRun, bool) {
	service.mu.Lock()
	defer service.mu.Unlock()
	active := service.active[scriptKey{projectID: projectID, scriptID: scriptID}]
	if active == nil || (operationID != "" && active.operation.OperationID != operationID) {
		return nil, false
	}
	copy := *active
	return &copy, true
}

func (service *Service) clearActive(projectID, scriptID int64, operationID string) {
	service.mu.Lock()
	key := scriptKey{projectID: projectID, scriptID: scriptID}
	if active := service.active[key]; active != nil && active.operation.OperationID == operationID {
		delete(service.active, key)
	}
	service.mu.Unlock()
}

func (service *Service) setRuntimeRunning(projectID, scriptID int64) {
	service.mu.Lock()
	service.last[scriptKey{projectID: projectID, scriptID: scriptID}] = runtimeLast{
		status: "running", ranAt: service.clock.Now().UTC().Format(time.RFC3339Nano),
	}
	service.mu.Unlock()
}

func (service *Service) setRuntimeTerminal(projectID, scriptID int64, status string, exitCode, duration int64) {
	service.mu.Lock()
	service.last[scriptKey{projectID: projectID, scriptID: scriptID}] = runtimeLast{
		status: status, exitCode: exitCode, durationMS: duration,
		ranAt: service.clock.Now().UTC().Format(time.RFC3339Nano), hasMetrics: true,
	}
	service.mu.Unlock()
}
