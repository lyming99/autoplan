package agentcli

import (
	"context"
	"strings"
)

type codexAdapter struct{}

func (codexAdapter) Provider() Provider { return ProviderCodex }

func (codexAdapter) Prepare(_ context.Context, request Request, _ ArtifactWriter) (Prepared, error) {
	command, err := resolvedCommand(ProviderCodex, request.Command)
	if err != nil {
		return Prepared{}, err
	}
	session, err := normalizeSession(ProviderCodex, request.Session)
	if err != nil || request.LastOutputFile == "" {
		return Prepared{}, ErrIncompleteConfig
	}
	reasoning := normalizeReasoning(request.ReasoningEffort)
	arguments := []string{"exec"}
	if session.Mode == SessionResume {
		arguments = append(arguments, "resume")
	}
	arguments = append(arguments,
		"-c", `model_reasoning_effort="`+reasoning+`"`,
		"--json",
	)
	if session.Mode == SessionResume {
		arguments = append(arguments, "-o", request.LastOutputFile, "--skip-git-repo-check", session.ID, "-")
	} else {
		arguments = append(arguments,
			"--color", "never", "-o", request.LastOutputFile,
			"--sandbox", "danger-full-access", "--skip-git-repo-check", "-",
		)
	}
	return Prepared{
		Executable: command, Arguments: arguments, PromptMode: PromptStdin, Prompt: request.Prompt,
		Parser: ParserCodex, Session: session,
	}, nil
}

func normalizeReasoning(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "low", "medium", "high", "xhigh":
		return strings.ToLower(strings.TrimSpace(value))
	default:
		return DefaultReasoning
	}
}
