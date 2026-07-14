package bootstrap

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/lyming99/autoplan/backend/internal/config"
	domainfiles "github.com/lyming99/autoplan/backend/internal/domain/files"
	domainintake "github.com/lyming99/autoplan/backend/internal/domain/intake"
	"github.com/lyming99/autoplan/backend/internal/repository"
	processruntime "github.com/lyming99/autoplan/backend/internal/runtime/process"
)

type realCodexWorkspacePolicy struct{ workspace string }

func (policy realCodexWorkspacePolicy) AuthorizeWorkingDirectory(_ context.Context, workspace, workingDirectory string) (domainfiles.Decision, error) {
	if workspace != policy.workspace || workingDirectory != policy.workspace {
		return domainfiles.Decision{}, nil
	}
	return domainfiles.Decision{Allowed: true, ResolvedTarget: policy.workspace}, nil
}

// This test is opt-in because it invokes the locally authenticated Codex CLI.
// It exercises the same bounded process runner and prompt parser used by the
// packaged sidecar, rather than a fake executable that only prints fixture JSON.
func TestRealCodexPlanGeneration(t *testing.T) {
	workspace := os.Getenv("AUTOPLAN_REAL_CODEX_WORKSPACE")
	if workspace == "" {
		t.Skip("set AUTOPLAN_REAL_CODEX_WORKSPACE to run the real Codex integration")
	}
	provider := "codex"
	project := repository.Project{ID: 1, WorkspacePath: workspace}
	intake := domainintake.Intake{
		ID: 1, ProjectID: 1, Type: domainintake.Requirement,
		Title:    "Center fixed-size SVG icons inside OutlineInputBorder icon slots",
		Body:     "Use a Center widget around each specifically sized SVG icon so input border constraints do not stretch the glyph.",
		AgentCLI: domainintake.AgentCLIConfig{Provider: &provider},
	}
	spec, prompt := loopAgentRequest(project, intake)
	spec.Timeout = 5 * time.Minute
	runtimeConfig := config.DefaultProcessRuntime()
	runner, err := processruntime.NewRunner(processruntime.Dependencies{
		Config: runtimeConfig, Policy: realCodexWorkspacePolicy{workspace: workspace},
		BaseEnvironment: loopProcessEnvironment(runtimeConfig.AllowedEnvironment),
	})
	if err != nil {
		t.Fatal(err)
	}
	defer runner.Shutdown()

	result, runErr := runner.RunWithInput(context.Background(), spec, []byte(prompt))
	t.Logf("run_err=%v exit=%d timeout=%v cancelled=%v stdout_bytes=%d stdout_lines=%d stdout_truncated=%v stderr_bytes=%d stderr_lines=%d stderr_truncated=%v",
		runErr, result.ExitCode, result.TimedOut, result.Cancelled,
		result.Stdout.Bytes, result.Stdout.Lines, result.Stdout.Truncated,
		result.Stderr.Bytes, result.Stderr.Lines, result.Stderr.Truncated)
	usableRedactedOutput := errors.Is(runErr, processruntime.ErrOutputRedaction) &&
		!result.Stdout.RedactionFailed && strings.TrimSpace(result.Stdout.Tail) != ""
	if runErr != nil && !usableRedactedOutput {
		t.Fatalf("real Codex runner failed: %v; stderr tail: %s", runErr, result.Stderr.Tail)
	}
	if result.ExitCode != 0 {
		t.Fatalf("real Codex exited %d; stderr tail: %s", result.ExitCode, result.Stderr.Tail)
	}
	if _, err := parseGeneratedPlan(result.Stdout.Tail); err != nil {
		t.Fatalf("real Codex output was not parseable: %v; stdout tail: %s; stderr tail: %s", err, result.Stdout.Tail, result.Stderr.Tail)
	}
}
