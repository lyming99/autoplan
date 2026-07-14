package bootstrap

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	applicationloop "github.com/lyming99/autoplan/backend/internal/application/loop"
	domainintake "github.com/lyming99/autoplan/backend/internal/domain/intake"
	domainloop "github.com/lyming99/autoplan/backend/internal/domain/loop"
	domainplan "github.com/lyming99/autoplan/backend/internal/domain/plan"
	"github.com/lyming99/autoplan/backend/internal/platform/logging"
	"github.com/lyming99/autoplan/backend/internal/repository"
	processruntime "github.com/lyming99/autoplan/backend/internal/runtime/process"
)

var errLoopAgentExecution = errors.New("loop agent execution failed")

type loopInputRunner interface {
	RunWithInput(context.Context, processruntime.Spec, []byte) (processruntime.Result, error)
}

type loopCycleStore interface {
	Project(context.Context, int64) (repository.Project, bool, error)
	Pending(context.Context, int64) ([]domainintake.Intake, error)
	SavePlan(context.Context, domainintake.Intake, repository.GeneratedPlanInput) (int64, error)
	Fail(context.Context, domainintake.Intake) error
	ClaimTask(context.Context, int64, string, string) (repository.LoopPlanTaskClaim, bool, error)
	FinishTask(context.Context, repository.LoopPlanTaskCompletion) error
}

// sidecarLoopRunner consumes one intake per bounded cycle. The selected Agent
// CLI works directly in the server-authorized project workspace; raw prompts
// and process output never enter operation results or transport responses.
type sidecarLoopRunner struct {
	store      loopCycleStore
	runner     loopInputRunner
	stateStore applicationloop.StateStore
	logger     logging.Logger
}

type repositoryLoopCycleStore struct {
	writer interface {
		repository.IntakeTransactional
		repository.GeneratedPlanWriter
		repository.LoopPlanTaskWriter
	}
	projects repository.Transactional
}

func (runner sidecarLoopRunner) RunOnce(ctx context.Context, input applicationloop.RunInput) (applicationloop.RunOutput, error) {
	runner.log(logging.Event{Level: "info", Code: "loop_cycle_started", Stage: "plan_generation", ProjectID: input.ProjectID})
	if err := ctx.Err(); err != nil {
		runner.log(logging.Event{Level: "warn", Code: "loop_cycle_cancelled", ErrorCode: "context_cancelled", Stage: "plan_generation", ProjectID: input.ProjectID})
		return applicationloop.RunOutput{}, err
	}
	if runner.store == nil || runner.runner == nil {
		runner.log(logging.Event{Level: "error", Code: "loop_runtime_unavailable", ErrorCode: "dependency_unavailable", Stage: "plan_generation", ProjectID: input.ProjectID})
		return applicationloop.RunOutput{}, repository.ErrNotConfigured
	}
	project, found, err := runner.store.Project(ctx, input.ProjectID)
	if err != nil || !found || strings.TrimSpace(project.WorkspacePath) == "" {
		errorCode := "project_not_found"
		if err != nil {
			errorCode = "project_load_failed"
		}
		runner.log(logging.Event{Level: "error", Code: "loop_project_unavailable", ErrorCode: errorCode, Stage: "plan_generation", ProjectID: input.ProjectID})
		if err != nil {
			return applicationloop.RunOutput{}, err
		}
		return applicationloop.RunOutput{}, applicationloop.ErrProjectNotFound
	}
	pending, err := runner.store.Pending(ctx, input.ProjectID)
	if err != nil {
		runner.log(logging.Event{Level: "error", Code: "loop_pending_load_failed", ErrorCode: "repository_read_failed", Stage: "plan_generation", ProjectID: input.ProjectID})
		return applicationloop.RunOutput{}, err
	}
	output := applicationloop.RunOutput{PendingIntakes: len(pending)}
	if len(pending) > 0 {
		runner.setPhase(ctx, input.ProjectID, domainloop.PhaseGeneratePlan)
		intake := pending[0]
		spec, prompt := loopAgentRequest(project, intake)
		provider := loopProvider(intake)
		runner.log(logging.Event{Level: "info", Code: "agent_cli_started", Stage: "plan_generation", Provider: provider,
			ProjectID: input.ProjectID, IntakeID: intake.ID, PendingIntakes: len(pending)})
		startedAt := time.Now()
		result, runErr := runner.runner.RunWithInput(ctx, spec, []byte(prompt))
		// Codex writes repository inspection progress to stderr. A clean exit
		// with safe stdout is usable even when that diagnostic stream could not
		// be retained after redaction.
		usableRedactedOutput := errors.Is(runErr, processruntime.ErrOutputRedaction) &&
			!result.Stdout.RedactionFailed && strings.TrimSpace(result.Stdout.Tail) != ""
		if (runErr != nil && !usableRedactedOutput) || result.ExitCode != 0 || result.TimedOut || result.Cancelled {
			runner.log(agentFinishedEvent(input.ProjectID, intake.ID, provider, len(pending), result, startedAt, "error", agentFailureCode(runErr, result)))
			_ = runner.store.Fail(ctx, intake)
			return output, errLoopAgentExecution
		}
		runner.log(agentFinishedEvent(input.ProjectID, intake.ID, provider, len(pending), result, startedAt, "info", ""))
		generated, parseErr := parseGeneratedPlan(result.Stdout.Tail)
		if parseErr != nil {
			runner.log(logging.Event{Level: "error", Code: "plan_parse_failed", ErrorCode: "invalid_agent_output", Stage: "plan_generation",
				Provider: provider, ProjectID: input.ProjectID, IntakeID: intake.ID})
			_ = runner.store.Fail(ctx, intake)
			return output, errLoopAgentExecution
		}
		planInput, filePath, buildErr := buildGeneratedPlan(project, intake, generated)
		if buildErr != nil {
			runner.log(logging.Event{Level: "error", Code: "plan_build_failed", ErrorCode: "plan_file_write_failed", Stage: "plan_generation",
				Provider: provider, ProjectID: input.ProjectID, IntakeID: intake.ID})
			_ = runner.store.Fail(ctx, intake)
			return output, errLoopAgentExecution
		}
		planID, saveErr := runner.store.SavePlan(ctx, intake, planInput)
		if saveErr != nil {
			runner.log(logging.Event{Level: "error", Code: "plan_persist_failed", ErrorCode: "repository_write_failed", Stage: "plan_generation",
				Provider: provider, ProjectID: input.ProjectID, IntakeID: intake.ID})
			_ = os.Remove(filePath)
			return output, saveErr
		}
		output.GeneratedPlans = 1
		runner.log(logging.Event{Level: "info", Code: "plan_generated", Stage: "plan_generation", Provider: provider,
			ProjectID: input.ProjectID, IntakeID: intake.ID, PlanID: planID, PendingIntakes: len(pending), GeneratedPlans: 1})
	}

	claimAt := time.Now().UTC().Format(time.RFC3339Nano)
	claim, found, claimErr := runner.store.ClaimTask(ctx, input.ProjectID, input.OperationID, claimAt)
	if claimErr != nil {
		runner.log(logging.Event{Level: "error", Code: "plan_task_claim_failed", ErrorCode: "repository_write_failed", Stage: "task_execution", ProjectID: input.ProjectID})
		return output, claimErr
	}
	if !found {
		runner.log(logging.Event{Level: "info", Code: "loop_cycle_idle", Stage: "waiting", ProjectID: input.ProjectID,
			PendingIntakes: output.PendingIntakes, GeneratedPlans: output.GeneratedPlans})
		return output, nil
	}
	runner.setPhase(ctx, input.ProjectID, domainloop.PhaseExecuteTask)
	if executeErr := runner.executeTask(ctx, project, input.OperationID, claim); executeErr != nil {
		return output, executeErr
	}
	output.ProcessedPlans = 1
	runner.log(logging.Event{Level: "info", Code: "loop_cycle_completed", Stage: "waiting", ProjectID: input.ProjectID,
		PlanID: claim.Plan.ID, TaskID: claim.Task.ID, PendingIntakes: output.PendingIntakes,
		GeneratedPlans: output.GeneratedPlans, ProcessedPlans: output.ProcessedPlans})
	return output, nil
}

func (runner sidecarLoopRunner) setPhase(ctx context.Context, projectID int64, phase domainloop.Phase) {
	if runner.stateStore == nil {
		return
	}
	state, found, err := runner.stateStore.Get(ctx, projectID)
	if err != nil || !found || state.Phase == phase {
		return
	}
	state.Phase = phase
	if _, _, err = runner.stateStore.Save(ctx, state, state.Version); err != nil {
		runner.log(logging.Event{Level: "warn", Code: "loop_phase_update_failed", ErrorCode: "state_conflict",
			Stage: string(phase), ProjectID: projectID})
	}
}

func (runner sidecarLoopRunner) log(event logging.Event) {
	if runner.logger == nil {
		return
	}
	defer func() { _ = recover() }()
	_ = runner.logger.Log(event)
}

func agentFinishedEvent(projectID, intakeID int64, provider string, pending int, result processruntime.Result, startedAt time.Time, level, errorCode string) logging.Event {
	return logging.Event{
		Level: level, Code: "agent_cli_finished", ErrorCode: errorCode, Stage: "plan_generation", Provider: provider,
		ProjectID: projectID, IntakeID: intakeID, PendingIntakes: pending, ExitCode: result.ExitCode,
		DurationMS: processDurationMS(result, startedAt), StdoutBytes: result.Stdout.Bytes, StderrBytes: result.Stderr.Bytes,
		StdoutLines: result.Stdout.Lines, StderrLines: result.Stderr.Lines, TimedOut: result.TimedOut, Cancelled: result.Cancelled,
		OutputTruncated: result.Stdout.Truncated || result.Stderr.Truncated,
		RedactionFailed: result.Stdout.RedactionFailed || result.Stderr.RedactionFailed,
	}
}

func processDurationMS(result processruntime.Result, fallback time.Time) int64 {
	if !result.StartedAt.IsZero() && !result.EndedAt.IsZero() && !result.EndedAt.Before(result.StartedAt) {
		return result.EndedAt.Sub(result.StartedAt).Milliseconds()
	}
	return time.Since(fallback).Milliseconds()
}

func agentFailureCode(runErr error, result processruntime.Result) string {
	if result.TimedOut {
		return "agent_timeout"
	}
	if result.Cancelled {
		return "agent_cancelled"
	}
	if result.ExitCode != 0 {
		return "agent_exit_nonzero"
	}
	if errors.Is(runErr, processruntime.ErrOutputRedaction) {
		return "output_redaction_failed"
	}
	return "agent_runtime_failed"
}

func loopProvider(intake domainintake.Intake) string {
	if intake.AgentCLI.Provider == nil {
		return "codex"
	}
	provider := strings.ToLower(strings.TrimSpace(*intake.AgentCLI.Provider))
	if provider == "omp" {
		return "oh-my-pi"
	}
	if provider == "claude" || provider == "opencode" || provider == "oh-my-pi" {
		return provider
	}
	return "codex"
}

func (store repositoryLoopCycleStore) Project(ctx context.Context, projectID int64) (project repository.Project, found bool, err error) {
	if store.projects == nil {
		return project, false, repository.ErrNotConfigured
	}
	err = store.projects.Transact(ctx, func(tx repository.WriteTransaction) error {
		project, found, err = tx.GetProject(ctx, projectID)
		return err
	})
	return project, found, err
}

func (store repositoryLoopCycleStore) Pending(ctx context.Context, projectID int64) ([]domainintake.Intake, error) {
	if store.writer == nil {
		return nil, repository.ErrNotConfigured
	}
	items := make([]domainintake.Intake, 0)
	err := store.writer.TransactIntake(ctx, func(tx repository.IntakeWriteTransaction) error {
		state, stateFound, stateErr := tx.GetProjectState(ctx, projectID)
		if stateErr != nil {
			return stateErr
		}
		for _, intakeType := range []domainintake.Type{domainintake.Requirement, domainintake.Feedback} {
			for _, status := range []domainintake.Status{domainintake.StatusDraft, domainintake.StatusOpen} {
				page, err := tx.ListIntakes(ctx, domainintake.ListOptions{ProjectID: projectID, Type: intakeType, Status: &status, Limit: 200})
				if err != nil {
					return err
				}
				for _, item := range page {
					if stateFound && item.AgentCLI.Provider == nil {
						provider := state.AgentCLIProvider
						item.AgentCLI.Provider = &provider
						item.AgentCLI.Command = state.AgentCLICommand
						if state.CodexReasoningEffort != nil {
							effort := *state.CodexReasoningEffort
							item.AgentCLI.CodexReasoningEffort = &effort
						}
					}
					links, err := tx.ListPlanLinksForIntake(ctx, projectID, intakeType, item.ID)
					if err != nil {
						return err
					}
					if len(links) == 0 && item.Failure.Count < 3 {
						items = append(items, item)
					}
				}
			}
		}
		return nil
	})
	sort.SliceStable(items, func(i, j int) bool {
		if items[i].CreatedAt == items[j].CreatedAt {
			return items[i].ID < items[j].ID
		}
		return items[i].CreatedAt < items[j].CreatedAt
	})
	return items, err
}

func (store repositoryLoopCycleStore) SavePlan(ctx context.Context, intake domainintake.Intake, input repository.GeneratedPlanInput) (int64, error) {
	return store.writer.CreateGeneratedPlan(ctx, input)
}

func (store repositoryLoopCycleStore) Fail(ctx context.Context, intake domainintake.Intake) error {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	return store.writer.TransactIntake(ctx, func(tx repository.IntakeWriteTransaction) error {
		failure := intake.Failure
		failure.Count++
		failure.LastFailedAt = &now
		message := "plan_generation_failed"
		failure.LastError = &message
		_, err := tx.UpdateIntake(ctx, intake.ProjectID, intake.Type, intake.ID, domainintake.Update{
			RequirementID: intake.RequirementID, Title: intake.Title, Body: intake.Body, Status: intake.Status,
			AgentCLI: intake.AgentCLI, PlanGeneration: intake.PlanGeneration, Failure: failure,
			AcceptedAt: intake.AcceptedAt, SessionID: intake.SessionID, UpdatedAt: now,
		})
		return err
	})
}

func (store repositoryLoopCycleStore) ClaimTask(
	ctx context.Context,
	projectID int64,
	operationID string,
	startedAt string,
) (repository.LoopPlanTaskClaim, bool, error) {
	if store.writer == nil {
		return repository.LoopPlanTaskClaim{}, false, repository.ErrNotConfigured
	}
	return store.writer.ClaimNextPlanTask(ctx, projectID, operationID, startedAt)
}

func (store repositoryLoopCycleStore) FinishTask(ctx context.Context, input repository.LoopPlanTaskCompletion) error {
	if store.writer == nil {
		return repository.ErrNotConfigured
	}
	return store.writer.FinishPlanTask(ctx, input)
}

func (runner sidecarLoopRunner) executeTask(
	ctx context.Context,
	project repository.Project,
	operationID string,
	claim repository.LoopPlanTaskClaim,
) error {
	provider, spec, prompt := loopTaskAgentRequest(project, claim.Plan, claim.Task)
	runner.log(logging.Event{Level: "info", Code: "task_cli_started", Stage: "task_execution", Provider: provider,
		ProjectID: project.ID, PlanID: claim.Plan.ID, TaskID: claim.Task.ID})
	startedAt := time.Now()
	result, runErr := runner.runner.RunWithInput(ctx, spec, []byte(prompt))
	failureCode := agentFailureCode(runErr, result)
	succeeded := result.ExitCode == 0 && !result.TimedOut && !result.Cancelled &&
		(runErr == nil || errors.Is(runErr, processruntime.ErrOutputRedaction))
	if succeeded {
		failureCode = ""
	}
	level := "info"
	if !succeeded {
		level = "error"
	}
	runner.log(logging.Event{
		Level: level, Code: "task_cli_finished", ErrorCode: failureCode, Stage: "task_execution", Provider: provider,
		ProjectID: project.ID, PlanID: claim.Plan.ID, TaskID: claim.Task.ID, ExitCode: result.ExitCode,
		DurationMS: processDurationMS(result, startedAt), StdoutBytes: result.Stdout.Bytes, StderrBytes: result.Stderr.Bytes,
		StdoutLines: result.Stdout.Lines, StderrLines: result.Stderr.Lines, TimedOut: result.TimedOut, Cancelled: result.Cancelled,
		OutputTruncated: result.Stdout.Truncated || result.Stderr.Truncated,
		RedactionFailed: result.Stdout.RedactionFailed || result.Stderr.RedactionFailed,
	})
	digest := ""
	if succeeded {
		var markErr error
		digest, markErr = markPlanTaskCompleted(project.WorkspacePath, claim.Plan.SourceRef, claim.Task.Key)
		if markErr != nil {
			succeeded, failureCode = false, "plan_progress_write_failed"
			runner.log(logging.Event{Level: "error", Code: "plan_progress_write_failed", ErrorCode: failureCode,
				Stage: "task_execution", ProjectID: project.ID, PlanID: claim.Plan.ID, TaskID: claim.Task.ID})
		}
	}
	finishedAt := time.Now().UTC().Format(time.RFC3339Nano)
	persistContext, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
	defer cancel()
	if err := runner.store.FinishTask(persistContext, repository.LoopPlanTaskCompletion{
		ProjectID: project.ID, PlanID: claim.Plan.ID, TaskID: claim.Task.ID, OperationID: operationID,
		Succeeded: succeeded, FailureCode: failureCode, Digest: digest, FinishedAt: finishedAt,
		DurationMS: processDurationMS(result, startedAt),
	}); err != nil {
		runner.log(logging.Event{Level: "error", Code: "plan_task_finish_failed", ErrorCode: "repository_write_failed",
			Stage: "task_execution", ProjectID: project.ID, PlanID: claim.Plan.ID, TaskID: claim.Task.ID})
		return err
	}
	if !succeeded {
		return errLoopAgentExecution
	}
	return nil
}

func loopTaskAgentRequest(project repository.Project, plan domainplan.Plan, task domainplan.Task) (string, processruntime.Spec, string) {
	provider := "codex"
	if plan.PlanExecution.Provider != nil {
		provider = strings.ToLower(strings.TrimSpace(*plan.PlanExecution.Provider))
	} else if plan.AgentCLI.Provider != nil {
		provider = strings.ToLower(strings.TrimSpace(*plan.AgentCLI.Provider))
	}
	command := strings.TrimSpace(plan.PlanExecution.Command)
	if command == "" {
		command = strings.TrimSpace(plan.AgentCLI.Command)
	}
	if command == "" {
		command = provider
	}
	finalValidation := strings.EqualFold(strings.TrimSpace(task.Scope), "validation") ||
		strings.Contains(strings.ToLower(task.Title), "final validation")
	rules := `Implement only this task. Do not modify the plan file or its checkboxes. Do not ask questions or wait for user input. Inspect the repository, make the necessary code changes, and keep unrelated files unchanged. Do not print a full diff or source files.`
	if finalValidation {
		rules = `This is the final validation task. Inspect the completed implementation, run the repository's relevant tests, checks, and build commands, and fix any failures that are within the plan scope. Do not modify the plan file or its checkboxes. Do not ask questions or wait for user input.`
	}
	prompt := fmt.Sprintf(`You are AutoPlan's unattended implementation agent.

Plan file (read-only): %s
Task: %s
Task scope: %s

%s
Exit successfully only when this task is complete.`, filepath.ToSlash(plan.SourceRef), task.RawLine, firstNonEmpty(task.Scope, "repository"), rules)
	args := []string{}
	switch provider {
	case "claude":
		args = []string{"--print", "--output-format", "text", "--dangerously-skip-permissions"}
	case "opencode":
		args = []string{"run", "--format", "default", "--auto", compactLoopPrompt(prompt)}
		prompt = ""
	case "oh-my-pi", "omp":
		provider = "oh-my-pi"
		if command == "oh-my-pi" {
			command = "omp"
		}
		args = []string{"--print"}
	default:
		provider, command = "codex", firstNonEmpty(command, "codex")
		effort := "medium"
		if plan.PlanExecution.CodexReasoningEffort != nil {
			effort = strings.ToLower(strings.TrimSpace(*plan.PlanExecution.CodexReasoningEffort))
		} else if plan.AgentCLI.CodexReasoningEffort != nil {
			effort = strings.ToLower(strings.TrimSpace(*plan.AgentCLI.CodexReasoningEffort))
		}
		if effort != "low" && effort != "medium" && effort != "high" && effort != "xhigh" {
			effort = "medium"
		}
		args = []string{"exec", "-c", `model_reasoning_effort="` + effort + `"`, "--color", "never", "--sandbox", "danger-full-access", "--skip-git-repo-check", "-"}
	}
	return provider, processruntime.Spec{
		ProjectID: project.ID, Workspace: project.WorkspacePath, WorkingDirectory: project.WorkspacePath,
		Executable: command, Args: args, Timeout: 30 * time.Minute,
	}, prompt
}

func markPlanTaskCompleted(workspace, sourceRef, taskKey string) (string, error) {
	root, err := filepath.EvalSymlinks(strings.TrimSpace(workspace))
	if err != nil {
		return "", err
	}
	reference := filepath.Clean(filepath.FromSlash(strings.ReplaceAll(strings.TrimSpace(sourceRef), `\`, "/")))
	if reference == "." || filepath.IsAbs(reference) || filepath.VolumeName(reference) != "" ||
		reference == ".." || strings.HasPrefix(reference, ".."+string(filepath.Separator)) {
		return "", errors.New("unsafe plan reference")
	}
	target, err := filepath.EvalSymlinks(filepath.Join(root, reference))
	if err != nil {
		return "", err
	}
	relative, err := filepath.Rel(root, target)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) || filepath.IsAbs(relative) {
		return "", errors.New("unsafe plan target")
	}
	content, err := os.ReadFile(target)
	if err != nil {
		return "", err
	}
	lines := strings.Split(string(content), "\n")
	updated := false
	for index, line := range lines {
		if !strings.Contains(line, taskKey) {
			continue
		}
		if marker := strings.Index(line, "[ ]"); marker >= 0 {
			lines[index] = line[:marker] + "[x]" + line[marker+3:]
			updated = true
			break
		}
	}
	if !updated {
		return "", errors.New("task checkbox not found")
	}
	result := []byte(strings.Join(lines, "\n"))
	info, err := os.Stat(target)
	if err != nil || !info.Mode().IsRegular() {
		return "", errors.New("plan target is not regular")
	}
	if err := os.WriteFile(target, result, info.Mode().Perm()); err != nil {
		return "", err
	}
	hash := sha256.Sum256(result)
	return hex.EncodeToString(hash[:]), nil
}

func loopAgentRequest(project repository.Project, intake domainintake.Intake) (processruntime.Spec, string) {
	provider := "codex"
	if intake.AgentCLI.Provider != nil {
		provider = strings.ToLower(strings.TrimSpace(*intake.AgentCLI.Provider))
	}
	command := strings.TrimSpace(intake.AgentCLI.Command)
	if command == "" {
		command = provider
	}
	prompt := fmt.Sprintf(`You are AutoPlan's plan generator. Analyze the repository and the requirement, but do not modify any files. Return exactly one JSON object and no markdown fences or commentary, using this schema:
{"title":"specific plan title","summary":"implementation approach","tasks":[{"title":"concrete task","scope":"files or subsystem","acceptance":"observable completion criteria"}],"finalValidation":"commands and checks proving the whole requirement"}
Provide 1-20 ordered implementation tasks. Every task must be concrete and repository-specific.

Requirement title: %s
Requirement body:
%s`, intake.Title, intake.Body)
	args := []string{}
	switch provider {
	case "claude":
		args = []string{"--print", "--output-format", "text", "--dangerously-skip-permissions"}
	case "opencode":
		args = []string{"run", "--format", "default", "--auto", compactLoopPrompt(prompt)}
		prompt = ""
	case "oh-my-pi", "omp":
		if command == "oh-my-pi" {
			command = "omp"
		}
		args = []string{"--print"}
	default:
		provider, command = "codex", firstNonEmpty(command, "codex")
		effort := "medium"
		if intake.AgentCLI.CodexReasoningEffort != nil {
			effort = strings.ToLower(strings.TrimSpace(*intake.AgentCLI.CodexReasoningEffort))
		}
		if effort != "low" && effort != "medium" && effort != "high" && effort != "xhigh" {
			effort = "medium"
		}
		args = []string{"exec", "-c", `model_reasoning_effort="` + effort + `"`, "--color", "never", "--sandbox", "danger-full-access", "--skip-git-repo-check", "-"}
	}
	return processruntime.Spec{ProjectID: project.ID, Workspace: project.WorkspacePath, WorkingDirectory: project.WorkspacePath,
		Executable: command, Args: args, Timeout: 45 * time.Minute}, prompt
}

type generatedPlanSpec struct {
	Title   string `json:"title"`
	Summary string `json:"summary"`
	Tasks   []struct {
		Title      string `json:"title"`
		Scope      string `json:"scope"`
		Acceptance string `json:"acceptance"`
	} `json:"tasks"`
	FinalValidation string `json:"finalValidation"`
}

func parseGeneratedPlan(output string) (generatedPlanSpec, error) {
	output = strings.TrimSpace(output)
	for index := 0; index < len(output); index++ {
		if output[index] != '{' {
			continue
		}
		var value generatedPlanSpec
		decoder := json.NewDecoder(strings.NewReader(output[index:]))
		if decoder.Decode(&value) != nil {
			continue
		}
		value.Title, value.Summary, value.FinalValidation = strings.TrimSpace(value.Title), strings.TrimSpace(value.Summary), strings.TrimSpace(value.FinalValidation)
		if value.Title == "" || value.Summary == "" || value.FinalValidation == "" || len(value.Tasks) == 0 || len(value.Tasks) > 20 {
			continue
		}
		valid := true
		for taskIndex := range value.Tasks {
			value.Tasks[taskIndex].Title = strings.TrimSpace(value.Tasks[taskIndex].Title)
			value.Tasks[taskIndex].Scope = strings.TrimSpace(value.Tasks[taskIndex].Scope)
			value.Tasks[taskIndex].Acceptance = strings.TrimSpace(value.Tasks[taskIndex].Acceptance)
			if value.Tasks[taskIndex].Title == "" || value.Tasks[taskIndex].Acceptance == "" {
				valid = false
			}
		}
		if valid {
			return value, nil
		}
	}
	return generatedPlanSpec{}, errors.New("generated plan invalid")
}

func buildGeneratedPlan(project repository.Project, intake domainintake.Intake, plan generatedPlanSpec) (repository.GeneratedPlanInput, string, error) {
	now := time.Now().UTC()
	relative := filepath.ToSlash(filepath.Join("docs", "plan", fmt.Sprintf("autoplan_%s_%d_%d.md", intake.Type, intake.ID, now.UnixMilli())))
	absolute := filepath.Join(project.WorkspacePath, filepath.FromSlash(relative))
	if err := os.MkdirAll(filepath.Dir(absolute), 0o700); err != nil {
		return repository.GeneratedPlanInput{}, "", err
	}
	var markdown strings.Builder
	fmt.Fprintf(&markdown, "# %s\n\n%s\n\n## Tasks\n\n", plan.Title, plan.Summary)
	tasks := make([]repository.GeneratedPlanTask, 0, len(plan.Tasks)+1)
	for index, task := range plan.Tasks {
		key := fmt.Sprintf("P%03d", index+1)
		scope := firstNonEmpty(task.Scope, "repository")
		raw := fmt.Sprintf("- [ ] %s: %s <!-- scope: %s -->", key, task.Title, scope)
		fmt.Fprintf(&markdown, "%s\n  - Acceptance: %s\n", raw, task.Acceptance)
		tasks = append(tasks, repository.GeneratedPlanTask{Key: key, Title: task.Title, RawLine: raw, Scope: scope, SortOrder: int64(index + 1)})
	}
	key := fmt.Sprintf("P%03d", len(tasks)+1)
	raw := fmt.Sprintf("- [ ] %s: Final validation <!-- scope: validation -->", key)
	fmt.Fprintf(&markdown, "%s\n  - Acceptance: %s\n", raw, plan.FinalValidation)
	tasks = append(tasks, repository.GeneratedPlanTask{Key: key, Title: "Final validation", RawLine: raw, Scope: "validation", SortOrder: int64(len(tasks) + 1)})
	content := []byte(markdown.String())
	if err := os.WriteFile(absolute, content, 0o600); err != nil {
		return repository.GeneratedPlanInput{}, "", err
	}
	digest := sha256.Sum256(content)
	issue := sha256.Sum256([]byte(fmt.Sprintf("%s:%d:%s:%s", intake.Type, intake.ID, intake.Title, intake.Body)))
	status := domainplan.StatusPending
	if intake.Status == domainintake.StatusDraft {
		status = domainplan.StatusDraft
	}
	return repository.GeneratedPlanInput{ProjectID: project.ID, IntakeType: intake.Type, IntakeID: intake.ID,
		Status: status, IssueHash: hex.EncodeToString(issue[:]), FilePath: relative, Digest: hex.EncodeToString(digest[:]),
		AgentCLI: intake.AgentCLI, PlanGeneration: intake.PlanGeneration, Tasks: tasks, CreatedAt: now.Format(time.RFC3339Nano)}, absolute, nil
}

func compactLoopPrompt(value string) string {
	value = strings.Join(strings.Fields(value), " ")
	if len(value) > 7800 {
		value = value[:7800]
	}
	return value
}

func firstNonEmpty(value, fallback string) string {
	if value != "" {
		return value
	}
	return fallback
}

func loopProcessEnvironment(configuration []string) map[string]string {
	result := make(map[string]string)
	for _, allowed := range configuration {
		for _, item := range os.Environ() {
			name, value, found := strings.Cut(item, "=")
			if found && strings.EqualFold(name, allowed) && value != "" {
				result[allowed] = value
				break
			}
		}
	}
	return result
}
