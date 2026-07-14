package bootstrap

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	applicationloop "github.com/lyming99/autoplan/backend/internal/application/loop"
	domainintake "github.com/lyming99/autoplan/backend/internal/domain/intake"
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
	spec   processruntime.Spec
	prompt string
	result processruntime.Result
	err    error
}

type loopLogFixture struct{ events []logging.Event }

func (fixture *loopLogFixture) Log(event logging.Event) error {
	fixture.events = append(fixture.events, event)
	return nil
}

func (fixture *loopInputRunnerFixture) RunWithInput(_ context.Context, spec processruntime.Spec, input []byte) (processruntime.Result, error) {
	fixture.spec, fixture.prompt = spec, string(input)
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
	process := &loopInputRunnerFixture{result: processruntime.Result{ExitCode: 0}}
	output, err := (sidecarLoopRunner{store: store, runner: process}).RunOnce(
		context.Background(), applicationloop.RunInput{ProjectID: 7, OperationID: "loop-operation-1"})
	if err != nil || output.ProcessedPlans != 1 || store.finished == nil || !store.finished.Succeeded {
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
