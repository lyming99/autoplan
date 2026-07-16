package bootstrap

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	applicationloop "github.com/lyming99/autoplan/backend/internal/application/loop"
	domainintake "github.com/lyming99/autoplan/backend/internal/domain/intake"
	domainmodelusage "github.com/lyming99/autoplan/backend/internal/domain/modelusage"
	domainplan "github.com/lyming99/autoplan/backend/internal/domain/plan"
	"github.com/lyming99/autoplan/backend/internal/platform/logging"
	"github.com/lyming99/autoplan/backend/internal/repository"
	processruntime "github.com/lyming99/autoplan/backend/internal/runtime/process"
)

type loopCycleStoreFixture struct {
	project  repository.Project
	pending  []domainintake.Intake
	saved    bool
	failed   bool
	plan     repository.GeneratedPlanInput
	claim    repository.LoopPlanTaskClaim
	claimed  bool
	finished *repository.LoopPlanTaskCompletion
}

func (fixture *loopCycleStoreFixture) Project(context.Context, int64) (repository.Project, bool, error) {
	return fixture.project, true, nil
}
func (fixture *loopCycleStoreFixture) Pending(context.Context, int64) ([]domainintake.Intake, error) {
	return fixture.pending, nil
}
func (fixture *loopCycleStoreFixture) SavePlan(_ context.Context, _ domainintake.Intake, plan repository.GeneratedPlanInput) (int64, error) {
	fixture.saved, fixture.plan = true, plan
	return 11, nil
}
func (fixture *loopCycleStoreFixture) Fail(context.Context, domainintake.Intake) error {
	fixture.failed = true
	return nil
}
func (fixture *loopCycleStoreFixture) ClaimTask(context.Context, int64, string, string) (repository.LoopPlanTaskClaim, bool, error) {
	return fixture.claim, fixture.claimed, nil
}
func (fixture *loopCycleStoreFixture) FinishTask(_ context.Context, input repository.LoopPlanTaskCompletion) error {
	copy := input
	fixture.finished = &copy
	return nil
}

type loopInputRunnerFixture struct {
	spec    processruntime.Spec
	specs   []processruntime.Spec
	prompt  string
	prompts []string
	result  processruntime.Result
	results []processruntime.Result
	err     error
	errs    []error
	calls   int
}

type loopLogFixture struct{ events []logging.Event }

type usageRecorderFixture struct{ records []domainmodelusage.Record }

func (fixture *usageRecorderFixture) Record(_ context.Context, value domainmodelusage.Record) error {
	fixture.records = append(fixture.records, value)
	return nil
}

type cancellationAwareLoopRunner struct {
	started chan struct{}
}

func (runner *cancellationAwareLoopRunner) RunWithInput(ctx context.Context, _ processruntime.Spec, _ []byte) (processruntime.Result, error) {
	close(runner.started)
	<-ctx.Done()
	return processruntime.Result{ExitCode: -1, Cancelled: true}, processruntime.ErrCancelled
}

func (fixture *loopLogFixture) Log(event logging.Event) error {
	fixture.events = append(fixture.events, event)
	return nil
}

func (fixture *loopInputRunnerFixture) RunWithInput(_ context.Context, spec processruntime.Spec, input []byte) (processruntime.Result, error) {
	fixture.spec, fixture.prompt = spec, string(input)
	fixture.specs = append(fixture.specs, spec)
	fixture.prompts = append(fixture.prompts, string(input))
	index := fixture.calls
	fixture.calls++
	if index < len(fixture.results) {
		var err error
		if index < len(fixture.errs) {
			err = fixture.errs[index]
		}
		return fixture.results[index], err
	}
	return fixture.result, fixture.err
}

func TestSidecarLoopRunnerGeneratesConcretePlanForDraftRequirement(t *testing.T) {
	workspace := t.TempDir()
	provider := "codex"
	store := &loopCycleStoreFixture{
		project: repository.Project{ID: 7, Name: "fixture", WorkspacePath: workspace},
		pending: []domainintake.Intake{{ID: 3, ProjectID: 7, Type: domainintake.Requirement,
			Title: "Implement feature", Body: "Change the code and test it", Status: domainintake.StatusDraft,
			AgentCLI: domainintake.AgentCLIConfig{Provider: &provider}}},
	}
	process := &loopInputRunnerFixture{result: processruntime.Result{ExitCode: 0, Stdout: processruntime.Output{Tail: `{
		"title":"Implement feature plan","summary":"Change the relevant service safely","tasks":[
		{"title":"Update service","scope":"backend/service.go","acceptance":"Service behavior is implemented"},
		{"title":"Add tests","scope":"backend/service_test.go","acceptance":"Regression tests pass"}],
		"finalValidation":"Run go test ./..."}`}}}
	output, err := (sidecarLoopRunner{store: store, runner: process}).RunOnce(context.Background(), applicationloop.RunInput{ProjectID: 7})
	if err != nil || output.PendingIntakes != 1 || output.GeneratedPlans != 1 || !store.saved || store.failed || len(store.plan.Tasks) != 3 {
		t.Fatalf("output=%#v saved=%v failed=%v plan=%#v err=%v", output, store.saved, store.failed, store.plan, err)
	}
	if store.plan.Status != domainplan.StatusDraft || output.ProcessedPlans != 0 || store.finished != nil {
		t.Fatalf("draft plan executed unexpectedly: status=%q output=%#v finished=%#v", store.plan.Status, output, store.finished)
	}
	if process.spec.Executable != "codex" || process.spec.WorkingDirectory != workspace ||
		!strings.Contains(process.prompt, "Implement feature") || !strings.Contains(process.prompt, "do not modify any files") {
		t.Fatalf("spec=%#v prompt=%q", process.spec, process.prompt)
	}
}

func TestSidecarLoopRunnerRecordsStructuredPlanGenerationUsage(t *testing.T) {
	workspace := t.TempDir()
	provider := "codex"
	store := &loopCycleStoreFixture{
		project: repository.Project{ID: 7, Name: "fixture", WorkspacePath: workspace},
		pending: []domainintake.Intake{{ID: 3, ProjectID: 7, Type: domainintake.Requirement,
			Title: "Usage", Body: "Record usage", Status: domainintake.StatusDraft,
			AgentCLI:       domainintake.AgentCLIConfig{Provider: &provider},
			PlanGeneration: domainintake.PlanGenerationConfig{Model: "gpt-fixture"}}},
	}
	plan := `{"title":"Usage plan","summary":"Record accounting","tasks":[{"title":"Record usage","scope":"backend","acceptance":"Usage is durable"}],"finalValidation":"Run tests"}`
	process := &loopInputRunnerFixture{result: processruntime.Result{ExitCode: 0, Stdout: processruntime.Output{Tail: `{"type":"item.completed","item":{"type":"agent_message","text":` + strconv.Quote(plan) + `}}` + "\n" +
		`{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":4,"cached_input_tokens":2,"reasoning_output_tokens":1}}`}}}
	usage := &usageRecorderFixture{}
	output, err := (sidecarLoopRunner{store: store, runner: process, usage: usage}).RunOnce(
		context.Background(), applicationloop.RunInput{ProjectID: 7, OperationID: "loop-operation-usage"})
	if err != nil || output.GeneratedPlans != 1 || len(usage.records) != 1 {
		t.Fatalf("output=%#v records=%#v err=%v", output, usage.records, err)
	}
	record := usage.records[0]
	if record.Source != domainmodelusage.SourcePlanGeneration || record.ProjectID != 7 || record.Provider != "codex" ||
		record.Model != "gpt-fixture" || record.OperationID == nil || *record.OperationID != "loop-operation-usage" ||
		record.Tokens.Input == nil || *record.Tokens.Input != 10 || !strings.Contains(record.InvocationKey, "requirement:3") ||
		!slices.Contains(process.spec.Args, "--json") {
		t.Fatalf("record=%#v spec=%#v", record, process.spec)
	}
}

func TestSidecarLoopRunnerPersistsMeasuredGenerationDuration(t *testing.T) {
	workspace := t.TempDir()
	startedAt := time.Date(2026, time.July, 15, 8, 30, 0, 125_000_000, time.UTC)
	endedAt := startedAt.Add(2750 * time.Millisecond)
	store := &loopCycleStoreFixture{
		project: repository.Project{ID: 7, Name: "fixture", WorkspacePath: workspace},
		pending: []domainintake.Intake{{ID: 3, ProjectID: 7, Type: domainintake.Requirement,
			Title: "Measure generation", Body: "Persist the elapsed time", Status: domainintake.StatusDraft}},
	}
	process := &loopInputRunnerFixture{result: processruntime.Result{
		ExitCode: 0, StartedAt: startedAt, EndedAt: endedAt,
		Stdout: processruntime.Output{Tail: `{
			"title":"Measured plan","summary":"Persist timing","tasks":[
			{"title":"Add timing test","scope":"backend","acceptance":"Duration is persisted"}],
			"finalValidation":"Run go test ./..."}`},
	}}
	logs := &loopLogFixture{}

	output, err := (sidecarLoopRunner{store: store, runner: process, logger: logs}).RunOnce(
		context.Background(), applicationloop.RunInput{ProjectID: 7})
	if err != nil || output.GeneratedPlans != 1 || !store.saved {
		t.Fatalf("output=%#v saved=%v err=%v", output, store.saved, err)
	}
	if store.plan.GenerationDurationMS != 2750 {
		t.Fatalf("generation duration=%d, want 2750", store.plan.GenerationDurationMS)
	}
	var generated logging.Event
	for _, event := range logs.events {
		if event.Code == "plan_generated" {
			generated = event
		}
	}
	if generated.DurationMS != store.plan.GenerationDurationMS {
		t.Fatalf("logged duration=%d saved duration=%d", generated.DurationMS, store.plan.GenerationDurationMS)
	}
}

func TestSidecarLoopRunnerRecordsAgentFailure(t *testing.T) {
	store := &loopCycleStoreFixture{
		project: repository.Project{ID: 7, WorkspacePath: t.TempDir()},
		pending: []domainintake.Intake{{ID: 3, ProjectID: 7, Type: domainintake.Requirement, Title: "x", Status: domainintake.StatusOpen}},
	}
	process := &loopInputRunnerFixture{err: errors.New("fixture failure")}
	_, err := (sidecarLoopRunner{store: store, runner: process}).RunOnce(context.Background(), applicationloop.RunInput{ProjectID: 7})
	if !errors.Is(err, errLoopAgentExecution) || !store.failed || store.saved {
		t.Fatalf("saved=%v failed=%v err=%v", store.saved, store.failed, err)
	}
}

func TestSidecarLoopRunnerUsesSafeStdoutWhenOnlyStderrRedactionFails(t *testing.T) {
	workspace := t.TempDir()
	store := &loopCycleStoreFixture{
		project: repository.Project{ID: 7, WorkspacePath: workspace},
		pending: []domainintake.Intake{{ID: 4, ProjectID: 7, Type: domainintake.Requirement,
			Title: "Constrained icon", Body: "Center the fixed-size icon", Status: domainintake.StatusDraft}},
	}
	process := &loopInputRunnerFixture{
		err: processruntime.ErrOutputRedaction,
		result: processruntime.Result{ExitCode: 0,
			Stdout: processruntime.Output{Tail: `{"title":"Icon plan","summary":"Center the glyph","tasks":[{"title":"Update icon","scope":"ui/icon.dart","acceptance":"The glyph stays centered"}],"finalValidation":"Run widget tests"}`},
			Stderr: processruntime.Output{Truncated: true, RedactionFailed: true}},
	}
	output, err := (sidecarLoopRunner{store: store, runner: process}).RunOnce(context.Background(), applicationloop.RunInput{ProjectID: 7})
	if err != nil || output.GeneratedPlans != 1 || !store.saved || store.failed {
		t.Fatalf("output=%#v saved=%v failed=%v err=%v", output, store.saved, store.failed, err)
	}
}

func TestSidecarLoopRunnerLogsAgentLifecycleWithoutPromptOrOutput(t *testing.T) {
	provider := "codex"
	store := &loopCycleStoreFixture{
		project: repository.Project{ID: 7, WorkspacePath: t.TempDir()},
		pending: []domainintake.Intake{{ID: 5, ProjectID: 7, Type: domainintake.Requirement,
			Title: "secret requirement", Body: "secret body", Status: domainintake.StatusDraft,
			AgentCLI: domainintake.AgentCLIConfig{Provider: &provider}}},
	}
	process := &loopInputRunnerFixture{result: processruntime.Result{ExitCode: 9,
		Stdout: processruntime.Output{Tail: "secret stdout", Bytes: 13, Lines: 1},
		Stderr: processruntime.Output{Tail: "secret stderr", Bytes: 13, Lines: 1, Truncated: true}}}
	logs := &loopLogFixture{}
	_, err := (sidecarLoopRunner{store: store, runner: process, logger: logs}).RunOnce(context.Background(), applicationloop.RunInput{ProjectID: 7})
	if !errors.Is(err, errLoopAgentExecution) || len(logs.events) != 3 {
		t.Fatalf("events=%#v err=%v", logs.events, err)
	}
	finished := logs.events[2]
	if finished.Code != "agent_cli_finished" || finished.ErrorCode != "agent_exit_nonzero" ||
		finished.ProjectID != 7 || finished.IntakeID != 5 || finished.ExitCode != 9 ||
		finished.StdoutBytes != 13 || !finished.OutputTruncated {
		t.Fatalf("event=%#v", finished)
	}
}

func TestSidecarLoopRunnerExecutesClaimedPlanTaskAndPersistsCompletion(t *testing.T) {
	workspace := t.TempDir()
	planPath := filepath.Join(workspace, "docs", "plan", "fixture.md")
	if err := os.MkdirAll(filepath.Dir(planPath), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(planPath, []byte("# Fixture\n\n- [ ] P001: Implement service <!-- scope: backend -->\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	provider := "codex"
	store := &loopCycleStoreFixture{
		project: repository.Project{ID: 7, WorkspacePath: workspace}, claimed: true,
		claim: repository.LoopPlanTaskClaim{
			Plan: repository.Plan{ID: 11, ProjectID: 7, SourceRef: "docs/plan/fixture.md",
				AgentCLI:      domainplan.AgentCLIConfig{Provider: &provider},
				PlanExecution: domainplan.BackendConfig{Strategy: "external-cli", Provider: &provider}},
			Task: repository.PlanTask{ID: 12, ProjectID: 7, PlanID: 11, Key: "P001", Title: "Implement service",
				RawLine: "- [ ] P001: Implement service", Scope: "backend", Status: domainplan.TaskRunning},
		},
	}
	sessionID := "00000000-aaaa-bbbb-cccc-000000000001"
	process := &loopInputRunnerFixture{result: processruntime.Result{
		ExitCode: 0, Stderr: processruntime.Output{Tail: "session id: " + sessionID},
	}}
	output, err := (sidecarLoopRunner{store: store, runner: process}).RunOnce(
		context.Background(), applicationloop.RunInput{ProjectID: 7, OperationID: "loop-operation-1"})
	if err != nil || output.ProcessedPlans != 1 || store.finished == nil || !store.finished.Succeeded || store.finished.SessionID != sessionID {
		t.Fatalf("output=%#v finished=%#v err=%v", output, store.finished, err)
	}
	content, readErr := os.ReadFile(planPath)
	if readErr != nil || !strings.Contains(string(content), "- [x] P001") {
		t.Fatalf("plan=%q readErr=%v", content, readErr)
	}
	if !strings.Contains(process.prompt, "Implement only this task") || !strings.Contains(process.prompt, "P001") {
		t.Fatalf("task prompt=%q", process.prompt)
	}
}

func TestSidecarLoopRunnerPropagatesCancellationAndPersistsCancelledCompletion(t *testing.T) {
	provider := "codex"
	store := &loopCycleStoreFixture{}
	process := &cancellationAwareLoopRunner{started: make(chan struct{})}
	runner := sidecarLoopRunner{store: store, runner: process}
	claim := repository.LoopPlanTaskClaim{
		Plan: repository.Plan{ID: 11, ProjectID: 7, SourceRef: "docs/plan/fixture.md",
			PlanExecution: domainplan.BackendConfig{Strategy: "external-cli", Provider: &provider}},
		Task: repository.PlanTask{ID: 12, ProjectID: 7, PlanID: 11, Key: "P001", Title: "Stop me",
			RawLine: "- [ ] P001: Stop me", Status: domainplan.TaskStopping},
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	workspace := t.TempDir()
	go func() {
		done <- runner.executeTask(ctx, repository.Project{ID: 7, WorkspacePath: workspace}, "loop-operation-1", claim)
	}()
	<-process.started
	cancel()
	if err := <-done; !errors.Is(err, errLoopAgentExecution) {
		t.Fatalf("cancelled execution error=%v", err)
	}
	if store.finished == nil || !store.finished.Cancelled || store.finished.Succeeded ||
		store.finished.FailureCode != "agent_cancelled" {
		t.Fatalf("cancelled completion=%#v", store.finished)
	}
}

func TestSidecarLoopRunnerLogsSameSessionFingerprintAcrossPlanTasks(t *testing.T) {
	workspace := t.TempDir()
	planPath := filepath.Join(workspace, "docs", "plan", "fixture.md")
	if err := os.MkdirAll(filepath.Dir(planPath), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(planPath, []byte("# Fixture\n\n- [ ] P001: Implement service\n- [ ] P002: Add tests\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	provider := "codex"
	sessionID := "00000000-aaaa-bbbb-cccc-000000000001"
	project := repository.Project{ID: 7, WorkspacePath: workspace}
	plan := repository.Plan{ID: 11, ProjectID: 7, SourceRef: "docs/plan/fixture.md",
		AgentCLI:      domainplan.AgentCLIConfig{Provider: &provider},
		PlanExecution: domainplan.BackendConfig{Strategy: "external-cli", Provider: &provider}}
	tasks := []repository.PlanTask{
		{ID: 12, ProjectID: 7, PlanID: 11, Key: "P001", Title: "Implement service", RawLine: "- [ ] P001: Implement service", Scope: "backend", Status: domainplan.TaskRunning},
		{ID: 13, ProjectID: 7, PlanID: 11, Key: "P002", Title: "Add tests", RawLine: "- [ ] P002: Add tests", Scope: "backend", Status: domainplan.TaskRunning},
	}
	store := &loopCycleStoreFixture{}
	process := &loopInputRunnerFixture{results: []processruntime.Result{
		{ExitCode: 0, Stderr: processruntime.Output{Tail: "session id: " + sessionID}},
		{ExitCode: 0, Stderr: processruntime.Output{Tail: "session id: " + sessionID}},
	}}
	logs := &loopLogFixture{}
	runner := sidecarLoopRunner{store: store, runner: process, logger: logs}
	if err := runner.executeTask(context.Background(), project, "operation-1", repository.LoopPlanTaskClaim{Plan: plan, Task: tasks[0]}); err != nil {
		t.Fatal(err)
	}
	if err := runner.executeTask(context.Background(), project, "operation-2", repository.LoopPlanTaskClaim{Plan: plan, Task: tasks[1], SessionID: sessionID}); err != nil {
		t.Fatal(err)
	}

	continuity := make([]logging.Event, 0, 2)
	for _, event := range logs.events {
		if event.Code == "plan_context_continuity" {
			continuity = append(continuity, event)
		}
	}
	if len(continuity) != 2 {
		t.Fatalf("continuity events=%#v", continuity)
	}
	if continuity[0].SessionMode != "new" || continuity[0].ContextState != "established" ||
		continuity[1].SessionMode != "resume" || continuity[1].ContextState != "reused" ||
		continuity[0].SessionFingerprint == "" || continuity[0].SessionFingerprint != continuity[1].SessionFingerprint {
		t.Fatalf("continuity events=%#v", continuity)
	}
	encoded, err := json.Marshal(logs.events)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), sessionID) {
		t.Fatalf("raw session id leaked in logs: %s", encoded)
	}
}

func TestSidecarLoopRunnerFallsBackWhenPersistedCodexSessionIsMissing(t *testing.T) {
	workspace := t.TempDir()
	planPath := filepath.Join(workspace, "docs", "plan", "fixture.md")
	if err := os.MkdirAll(filepath.Dir(planPath), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(planPath, []byte("# Fixture\n\n- [ ] P001: Implement service\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	provider := "codex"
	oldSessionID := "00000000-aaaa-bbbb-cccc-000000000001"
	newSessionID := "00000000-aaaa-bbbb-cccc-000000000002"
	store := &loopCycleStoreFixture{
		project: repository.Project{ID: 7, WorkspacePath: workspace}, claimed: true,
		claim: repository.LoopPlanTaskClaim{
			Plan: repository.Plan{ID: 11, ProjectID: 7, SourceRef: "docs/plan/fixture.md",
				AgentCLI:      domainplan.AgentCLIConfig{Provider: &provider},
				PlanExecution: domainplan.BackendConfig{Strategy: "external-cli", Provider: &provider}},
			Task: repository.PlanTask{ID: 12, ProjectID: 7, PlanID: 11, Key: "P001", Title: "Implement service",
				RawLine: "- [ ] P001: Implement service", Scope: "backend", Status: domainplan.TaskRunning},
			SessionID: oldSessionID,
		},
	}
	process := &loopInputRunnerFixture{results: []processruntime.Result{
		{ExitCode: 1, Stdout: processruntime.Output{Tail: `{"type":"turn.completed","usage":{"input_tokens":8,"output_tokens":1}}`}, Stderr: processruntime.Output{Tail: "session not found"}},
		{ExitCode: 0, Stdout: processruntime.Output{Tail: `{"type":"turn.completed","usage":{"input_tokens":9,"output_tokens":2}}`}, Stderr: processruntime.Output{Tail: "session id: " + newSessionID}},
	}}
	logs := &loopLogFixture{}
	usage := &usageRecorderFixture{}
	output, err := (sidecarLoopRunner{store: store, runner: process, usage: usage, logger: logs}).RunOnce(
		context.Background(), applicationloop.RunInput{ProjectID: 7, OperationID: "loop-operation-1"})
	if err != nil || output.ProcessedPlans != 1 || store.finished == nil || store.finished.SessionID != newSessionID {
		t.Fatalf("output=%#v finished=%#v err=%v", output, store.finished, err)
	}
	if process.calls != 2 || len(process.specs) != 2 || process.specs[0].Args[1] != "resume" || process.specs[1].Args[1] == "resume" {
		t.Fatalf("fallback specs=%#v", process.specs)
	}
	if len(usage.records) != 2 || !strings.HasSuffix(usage.records[0].InvocationKey, "attempt:1") ||
		!strings.HasSuffix(usage.records[1].InvocationKey, "attempt:2") || usage.records[0].Source != domainmodelusage.SourceTaskExecution {
		t.Fatalf("fallback usage=%#v", usage.records)
	}
	var fallback, continuity logging.Event
	for _, event := range logs.events {
		switch event.Code {
		case "task_cli_session_fallback":
			fallback = event
		case "plan_context_continuity":
			continuity = event
		}
	}
	if fallback.ContextState != "resume-missing" || fallback.SessionFingerprint != loopSessionFingerprint(provider, oldSessionID) ||
		continuity.ContextState != "replaced" || continuity.SessionFingerprint != loopSessionFingerprint(provider, newSessionID) ||
		fallback.SessionFingerprint == continuity.SessionFingerprint {
		t.Fatalf("fallback=%#v continuity=%#v", fallback, continuity)
	}
}

func TestLoopTaskAgentRequestResumesCodexSessionAcrossTasksInSamePlan(t *testing.T) {
	provider := "codex"
	sessionID := "00000000-aaaa-bbbb-cccc-000000000001"
	plan := repository.Plan{
		ID: 11, ProjectID: 7, SourceRef: "docs/plan/fixture.md",
		AgentCLI:      domainplan.AgentCLIConfig{Provider: &provider},
		PlanExecution: domainplan.BackendConfig{Strategy: "external-cli", Provider: &provider},
	}
	project := repository.Project{ID: 7, WorkspacePath: t.TempDir()}
	tasks := []repository.PlanTask{
		{ID: 12, ProjectID: 7, PlanID: 11, Key: "P001", Title: "Implement service", RawLine: "- [ ] P001: Implement service", Scope: "backend", Status: domainplan.TaskRunning},
		{ID: 13, ProjectID: 7, PlanID: 11, Key: "P002", Title: "Add tests", RawLine: "- [ ] P002: Add tests", Scope: "backend", Status: domainplan.TaskRunning},
	}

	_, first, firstPrompt := loopTaskAgentRequest(project, plan, tasks[0], "")
	_, second, secondPrompt := loopTaskAgentRequest(project, plan, tasks[1], sessionID)
	if len(first.Args) < 2 || first.Args[0] != "exec" || first.Args[1] == "resume" {
		t.Fatalf("first task did not start a fresh Codex session: args=%q", first.Args)
	}
	if len(second.Args) < 3 || second.Args[0] != "exec" || second.Args[1] != "resume" || !containsString(second.Args, sessionID) {
		t.Fatalf("second task did not resume the plan session: args=%q", second.Args)
	}
	if !strings.Contains(firstPrompt, "P001") || !strings.Contains(secondPrompt, "P002") {
		t.Fatalf("prompts=%q", []string{firstPrompt, secondPrompt})
	}
}

func TestLoopTaskAgentRequestUsesProviderSpecificResumeArguments(t *testing.T) {
	project := repository.Project{ID: 7, WorkspacePath: t.TempDir()}
	task := repository.PlanTask{ID: 12, ProjectID: 7, PlanID: 11, Key: "P001", Title: "Implement service",
		RawLine: "- [ ] P001: Implement service", Scope: "backend", Status: domainplan.TaskRunning}
	for _, fixture := range []struct {
		provider  string
		sessionID string
		flag      string
	}{
		{provider: "claude", sessionID: "claude-session-1", flag: "--resume"},
		{provider: "opencode", sessionID: "opencode-session-1", flag: "--session"},
	} {
		provider := fixture.provider
		plan := repository.Plan{ID: 11, ProjectID: 7, SourceRef: "docs/plan/fixture.md",
			PlanExecution: domainplan.BackendConfig{Strategy: "external-cli", Provider: &provider}}
		_, spec, _ := loopTaskAgentRequest(project, plan, task, fixture.sessionID)
		if !containsString(spec.Args, fixture.flag) || !containsString(spec.Args, fixture.sessionID) {
			t.Fatalf("provider=%s args=%q", fixture.provider, spec.Args)
		}
	}
}

func containsString(values []string, expected string) bool {
	for _, value := range values {
		if value == expected {
			return true
		}
	}
	return false
}
