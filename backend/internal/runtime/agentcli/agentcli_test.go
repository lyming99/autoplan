package agentcli

import (
	"context"
	"errors"
	"testing"

	filesapp "github.com/lyming99/autoplan/backend/internal/application/files"
	"github.com/lyming99/autoplan/backend/internal/runtime/process"
)

type fakeRunner struct {
	result process.Result
	err    error
	calls  int
}

func (runner *fakeRunner) Run(context.Context, process.Spec) (process.Result, error) {
	runner.calls++
	return runner.result, runner.err
}

type fakeInputRunner struct{ fakeRunner }

func (runner *fakeInputRunner) RunWithInput(context.Context, process.Spec, []byte) (process.Result, error) {
	runner.calls++
	return runner.result, runner.err
}

type fakeArtifacts struct {
	agentCalls     int
	promptCalls    int
	removed        int
	authorizedLogs int
}

func (artifacts *fakeArtifacts) EnsureOpenCodePlanAgent(context.Context, string) (string, error) {
	artifacts.agentCalls++
	return filesapp.OpenCodePlanAgentName, nil
}

func (artifacts *fakeArtifacts) AuthorizeAgentOutput(context.Context, string, string) error {
	artifacts.authorizedLogs++
	return nil
}

func (artifacts *fakeArtifacts) WriteOpenCodePrompt(context.Context, string, string) (filesapp.PromptAttachment, error) {
	artifacts.promptCalls++
	return filesapp.PromptAttachment{Workspace: "/workspace", Path: "/workspace/.autoplan-agentcli/prompts/prompt-fixture.md"}, nil
}

func (artifacts *fakeArtifacts) RemoveOpenCodePrompt(context.Context, filesapp.PromptAttachment) error {
	artifacts.removed++
	return nil
}

func TestCodexArgumentsRetainFrozenReasoningAndStdinContract(t *testing.T) {
	prepared, err := (codexAdapter{}).Prepare(context.Background(), Request{
		Provider: ProviderCodex, Prompt: "synthetic prompt", Workspace: "/workspace", WorkingDirectory: "/workspace",
		LastOutputFile: "/workspace/docs/progress/logs/20260712-010101_agent.log", ReasoningEffort: "high",
	}, nil)
	if err != nil || prepared.PromptMode != PromptStdin || prepared.Arguments[0] != "exec" {
		t.Fatalf("prepared=%#v err=%v", prepared, err)
	}
	if prepared.Arguments[1] != "-c" || prepared.Arguments[2] != `model_reasoning_effort="high"` || prepared.Arguments[len(prepared.Arguments)-1] != "-" {
		t.Fatalf("arguments=%#v", prepared.Arguments)
	}
}

func TestClaudeSessionArgumentsUseStreamJSON(t *testing.T) {
	prepared, err := (claudeAdapter{}).Prepare(context.Background(), Request{
		Provider: ProviderClaude, Prompt: "synthetic prompt", Workspace: "/workspace", WorkingDirectory: "/workspace",
		Session: Session{ID: "session-01", Mode: SessionResume},
	}, nil)
	if err != nil || prepared.PromptMode != PromptStdin {
		t.Fatalf("prepared=%#v err=%v", prepared, err)
	}
	if len(prepared.Arguments) < 7 || prepared.Arguments[1] != "--output-format" || prepared.Arguments[2] != "stream-json" || prepared.Arguments[len(prepared.Arguments)-2] != "--resume" {
		t.Fatalf("arguments=%#v", prepared.Arguments)
	}
}

func TestOpenCodeLongPromptUsesControlledAttachment(t *testing.T) {
	artifacts := &fakeArtifacts{}
	prepared, err := (openCodeAdapter{}).Prepare(context.Background(), Request{
		Provider: ProviderOpenCode, Prompt: "line one\nline two", Workspace: "/workspace", WorkingDirectory: "/workspace", PlanGeneration: true,
	}, artifacts)
	if err != nil || artifacts.agentCalls != 1 || artifacts.promptCalls != 1 || prepared.Cleanup == nil {
		t.Fatalf("prepared=%#v artifacts=%#v err=%v", prepared, artifacts, err)
	}
	if prepared.PromptMode != PromptArgument || prepared.Arguments[len(prepared.Arguments)-2] != "-f" {
		t.Fatalf("arguments=%#v", prepared.Arguments)
	}
}

func TestCodexParserCapturesOnlyValidSessionMetadata(t *testing.T) {
	parsed := ParseSessionMetadata(ProviderCodex, process.Result{
		Stdout: process.Output{Tail: `session id: 00000000-aaaa-bbbb-cccc-000000000001`},
	})
	if parsed.ID != "00000000-aaaa-bbbb-cccc-000000000001" || parsed.Missing {
		t.Fatalf("parsed=%#v", parsed)
	}
	missing := ParseSessionMetadata(ProviderCodex, process.Result{Stderr: process.Output{Tail: "session not found"}})
	if missing.ID != "" || !missing.Missing {
		t.Fatalf("missing=%#v", missing)
	}
}

func TestOpenCodeSessionListReturnsOnlyExactPlanTitle(t *testing.T) {
	result := process.Result{ExitCode: 0, Stdout: process.Output{Tail: `[
		{"id":"session-other","title":"AutoPlan project 7 plan 10","directory":"/private/other"},
		{"id":"session-plan-11","title":"AutoPlan project 7 plan 11","directory":"/private/workspace"}
	]`}}
	sessionID, found := ParseOpenCodeSessionList(result, "AutoPlan project 7 plan 11")
	if !found || sessionID != "session-plan-11" {
		t.Fatalf("session=%q found=%v", sessionID, found)
	}
}

func TestServiceFailsClosedWhenStdinRunnerIsMissing(t *testing.T) {
	service, err := NewService(Dependencies{Runner: &fakeRunner{}, Artifacts: &fakeArtifacts{}})
	if err != nil {
		t.Fatal(err)
	}
	_, err = service.Run(context.Background(), Request{
		ProjectID: 1, Provider: ProviderCodex, Workspace: "/workspace", WorkingDirectory: "/workspace",
		Prompt: "synthetic prompt", LastOutputFile: "/workspace/docs/progress/logs/20260712-010101_agent.log",
	})
	if !errors.Is(err, ErrPromptTransport) {
		t.Fatalf("err=%v", err)
	}
}

var _ ProcessExecutor = (*fakeRunner)(nil)
var _ InputProcessExecutor = (*fakeInputRunner)(nil)
var _ ArtifactWriter = (*fakeArtifacts)(nil)
