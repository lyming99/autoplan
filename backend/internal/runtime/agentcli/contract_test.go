package agentcli

import (
	"context"
	"reflect"
	"testing"

	filesapp "github.com/lyming99/autoplan/backend/internal/application/files"
)

type p11ArtifactWriter struct{}

func (p11ArtifactWriter) EnsureOpenCodePlanAgent(context.Context, string) (string, error) {
	return filesapp.OpenCodePlanAgentName, nil
}

func (p11ArtifactWriter) AuthorizeAgentOutput(context.Context, string, string) error { return nil }

func (p11ArtifactWriter) WriteOpenCodePrompt(context.Context, string, string) (filesapp.PromptAttachment, error) {
	return filesapp.PromptAttachment{}, nil
}

func (p11ArtifactWriter) RemoveOpenCodePrompt(context.Context, filesapp.PromptAttachment) error {
	return nil
}

func TestP11ProviderCommandAndPromptContractsUseArgumentArrays(t *testing.T) {
	ctx := context.Background()
	codex, err := (codexAdapter{}).Prepare(ctx, Request{
		Provider: ProviderCodex, Workspace: "<fixture-workspace>", WorkingDirectory: "<fixture-workspace>", Prompt: "fixture prompt",
		LastOutputFile: "<last-file>", ReasoningEffort: "high",
	}, nil)
	if err != nil || codex.Executable != "codex" || codex.PromptMode != PromptStdin || !reflect.DeepEqual(codex.Arguments,
		[]string{"exec", "-c", `model_reasoning_effort="high"`, "--json", "--color", "never", "-o", "<last-file>", "--sandbox", "danger-full-access", "--skip-git-repo-check", "-"}) {
		t.Fatalf("codex=%#v err=%v", codex, err)
	}
	claude, err := (claudeAdapter{}).Prepare(ctx, Request{
		Provider: ProviderClaude, Workspace: "<fixture-workspace>", WorkingDirectory: "<fixture-workspace>", Prompt: "fixture prompt",
		ClaudeBaseURL: "https://fixture.invalid", ClaudeModel: "fixture-model", Session: Session{Mode: SessionContinue},
	}, nil)
	if err != nil || claude.Executable != "claude" || claude.PromptMode != PromptStdin ||
		!reflect.DeepEqual(claude.Arguments, []string{"--print", "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions", "--continue"}) ||
		claude.Environment["ANTHROPIC_BASE_URL"] != "https://fixture.invalid" || claude.Environment["ANTHROPIC_MODEL"] != "fixture-model" {
		t.Fatalf("claude=%#v err=%v", claude, err)
	}
	openCode, err := (openCodeAdapter{}).Prepare(ctx, Request{
		Provider: ProviderOpenCode, ProjectID: 7, PlanID: 11, Workspace: "<fixture-workspace>", WorkingDirectory: "<fixture-workspace>", Prompt: "fixture prompt",
	}, nil)
	if err != nil || openCode.Executable != "opencode" || openCode.PromptMode != PromptArgument ||
		!reflect.DeepEqual(openCode.Arguments, []string{"run", "--format", "default", "--auto", "--title", "AutoPlan project 7 plan 11", "fixture prompt"}) {
		t.Fatalf("opencode=%#v err=%v", openCode, err)
	}
	ohmypi, err := (ohMyPiAdapter{}).Prepare(ctx, Request{
		Provider: ProviderOhMyPi, Workspace: "<fixture-workspace>", WorkingDirectory: "<fixture-workspace>", Prompt: "fixture prompt",
	}, nil)
	if err != nil || ohmypi.Executable != "omp" || ohmypi.PromptMode != PromptStdin || !reflect.DeepEqual(ohmypi.Arguments, []string{"--mode", "json"}) {
		t.Fatalf("oh-my-pi=%#v err=%v", ohmypi, err)
	}
}

func TestP11ProviderResumeAndPlanAgentContractsStayFake(t *testing.T) {
	ctx := context.Background()
	codex, err := (codexAdapter{}).Prepare(ctx, Request{
		Provider: ProviderCodex, Workspace: "<fixture-workspace>", WorkingDirectory: "<fixture-workspace>", Prompt: "fixture prompt",
		LastOutputFile: "<last-file>", ReasoningEffort: "high", Session: Session{Mode: SessionResume, ID: "00000000-aaaa-bbbb-cccc-000000000001"},
	}, nil)
	if err != nil || !reflect.DeepEqual(codex.Arguments,
		[]string{"exec", "resume", "-c", `model_reasoning_effort="high"`, "--json", "-o", "<last-file>", "--skip-git-repo-check", "00000000-aaaa-bbbb-cccc-000000000001", "-"}) {
		t.Fatalf("codex resume=%#v err=%v", codex, err)
	}
	claude, err := (claudeAdapter{}).Prepare(ctx, Request{
		Provider: ProviderClaude, Workspace: "<fixture-workspace>", WorkingDirectory: "<fixture-workspace>", Prompt: "fixture prompt",
		Command: "fixture-claude", Session: Session{Mode: SessionResume, ID: "fixture-session"},
	}, nil)
	if err != nil || claude.Executable != "fixture-claude" || !reflect.DeepEqual(claude.Arguments,
		[]string{"--print", "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions", "--resume", "fixture-session"}) {
		t.Fatalf("claude resume=%#v err=%v", claude, err)
	}
	openCode, err := (openCodeAdapter{}).Prepare(ctx, Request{
		Provider: ProviderOpenCode, ProjectID: 7, PlanID: 11, Workspace: "<fixture-workspace>", WorkingDirectory: "<fixture-workspace>",
		Prompt: "fixture prompt", PlanGeneration: true,
	}, p11ArtifactWriter{})
	if err != nil || openCode.PromptMode != PromptArgument || !reflect.DeepEqual(openCode.Arguments,
		[]string{"run", "--format", "default", "--auto", "--title", "AutoPlan project 7 plan 11", "--agent", filesapp.OpenCodePlanAgentName, "fixture prompt"}) {
		t.Fatalf("opencode plan agent=%#v err=%v", openCode, err)
	}
}

func TestP11SessionFallbackAndSensitiveInputValidationStayClosed(t *testing.T) {
	resumed, err := normalizeSession(ProviderCodex, Session{Mode: SessionResume, ID: "00000000-aaaa-bbbb-cccc-000000000001"})
	if err != nil || resumed.Mode != SessionResume || resumed.ID == "" {
		t.Fatalf("resume=%#v err=%v", resumed, err)
	}
	fallback := fallbackSession(resumed)
	if !fallback.Fallback || fallback.Mode != SessionNew || fallback.State != "fallback-new" || fallback.RequestedID != resumed.ID {
		t.Fatalf("fallback=%#v", fallback)
	}
	if _, err := normalizeSession(ProviderClaude, Session{Mode: SessionSpecified}); err == nil {
		t.Fatal("Claude specified session without id was accepted")
	}
	if validCommand("tool --unsafe") || validCommand("tool\n--unsafe") || validEnvironmentOverlay("secret\nvalue") {
		t.Fatal("command or environment overlay accepted a re-parsed/sensitive shape")
	}
}
