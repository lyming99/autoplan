package agentcli

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"
	"unicode/utf8"

	domainmodelusage "github.com/lyming99/autoplan/backend/internal/domain/modelusage"
	"github.com/lyming99/autoplan/backend/internal/runtime/process"
)

var ErrChatAdapter = errors.New("chat cli adapter is unavailable")

type ChatProvider string

const (
	ChatProviderClaude ChatProvider = "claude_cli"
	ChatProviderCodex  ChatProvider = "codex_cli"
)

// ChatLaunch is application-internal launch intent. Executables are selected
// from ChatAdapter configuration, never from a chat request or transport.
type ChatLaunch struct {
	ProjectID        int64
	Workspace        string
	WorkingDirectory string
	Prompt           string
	Provider         ChatProvider
	Model            string
	Endpoint         string
	ReasoningEffort  string
	Timeout          time.Duration
	Credential       *process.SecretEnvironment
}

type ChatRunner interface {
	RunWithInput(context.Context, process.Spec, []byte) (process.Result, error)
}

type ChatAdapterConfig struct {
	ClaudeExecutable string
	CodexExecutable  string
}

type ChatAdapter struct {
	runner           ChatRunner
	claudeExecutable string
	codexExecutable  string
}

// ChatOutput remains internal and contains only Runner-redacted, bounded
// text. ProviderService applies a second Chat-specific chunk filter before
// it can become a Message or event.
type ChatOutput struct {
	Text       string
	Reasoning  string
	ToolCalls  *json.RawMessage
	ToolResult *json.RawMessage
}

func NewChatAdapter(runner ChatRunner, config ChatAdapterConfig) *ChatAdapter {
	claude := config.ClaudeExecutable
	if claude == "" {
		claude = "claude"
	}
	codex := config.CodexExecutable
	if codex == "" {
		codex = "codex"
	}
	if runner == nil || !validCommand(claude) || !validCommand(codex) {
		return nil
	}
	return &ChatAdapter{runner: runner, claudeExecutable: claude, codexExecutable: codex}
}

func (adapter *ChatAdapter) Run(ctx context.Context, launch ChatLaunch) (process.Result, error) {
	if adapter == nil || adapter.runner == nil {
		return process.Result{}, ErrChatAdapter
	}
	spec, err := adapter.Prepare(launch)
	if err != nil {
		return process.Result{}, err
	}
	return adapter.runner.RunWithInput(ctx, spec, []byte(launch.Prompt))
}

func (adapter *ChatAdapter) Prepare(launch ChatLaunch) (process.Spec, error) {
	if adapter == nil || adapter.runner == nil || !validChatLaunch(launch) {
		return process.Spec{}, ErrChatAdapter
	}
	spec := process.Spec{
		ProjectID: launch.ProjectID, Workspace: launch.Workspace, WorkingDirectory: launch.WorkingDirectory,
		Timeout: launch.Timeout,
	}
	switch launch.Provider {
	case ChatProviderClaude:
		spec.Executable = adapter.claudeExecutable
		spec.Args = []string{"--print", "--output-format", "stream-json", "--verbose"}
		spec.Environment = map[string]string{"ANTHROPIC_MODEL": launch.Model}
		if launch.Endpoint != "" {
			spec.Environment["ANTHROPIC_BASE_URL"] = launch.Endpoint
		}
		if launch.Credential != nil {
			credential := *launch.Credential
			spec.SecretEnvironment = []process.SecretEnvironment{credential}
		}
	case ChatProviderCodex:
		spec.Executable = adapter.codexExecutable
		reasoning := launch.ReasoningEffort
		if reasoning == "" {
			reasoning = DefaultReasoning
		}
		spec.Args = []string{"exec", "--json", "--color", "never", "--model", launch.Model, "-c", `model_reasoning_effort="` + reasoning + `"`, "--sandbox", "read-only", "--skip-git-repo-check", "-"}
	default:
		return process.Spec{}, ErrChatAdapter
	}
	return spec, nil
}

func ParseChatOutput(provider ChatProvider, result process.Result) []ChatOutput {
	if result.Stdout.RedactionFailed || result.Stderr.RedactionFailed || result.Stdout.Truncated {
		return nil
	}
	text := strings.TrimSpace(result.Stdout.Tail)
	if text == "" {
		return nil
	}
	if provider == ChatProviderCodex {
		return parseCodexChatOutput(text)
	}
	if provider != ChatProviderClaude {
		return nil
	}
	outputs := make([]ChatOutput, 0)
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		var event struct {
			Type  string `json:"type"`
			Delta struct {
				Type     string `json:"type"`
				Text     string `json:"text"`
				Thinking string `json:"thinking"`
			} `json:"delta"`
			ContentBlock struct {
				Type  string          `json:"type"`
				Name  string          `json:"name"`
				Input json.RawMessage `json:"input"`
			} `json:"content_block"`
		}
		if json.Unmarshal([]byte(line), &event) != nil {
			continue
		}
		if event.Delta.Text != "" {
			outputs = append(outputs, ChatOutput{Text: event.Delta.Text})
		}
		if event.Delta.Thinking != "" {
			outputs = append(outputs, ChatOutput{Reasoning: event.Delta.Thinking})
		}
		if event.ContentBlock.Type == "tool_use" && event.ContentBlock.Name != "" {
			payload, err := json.Marshal([]map[string]any{{"name": event.ContentBlock.Name, "input": event.ContentBlock.Input}})
			if err == nil {
				raw := json.RawMessage(payload)
				outputs = append(outputs, ChatOutput{ToolCalls: &raw})
			}
		}
	}
	return outputs
}

func parseCodexChatOutput(text string) []ChatOutput {
	outputs := make([]ChatOutput, 0)
	valid := eachJSONLine(text, func(data []byte) bool {
		var event struct {
			Type string `json:"type"`
			Item struct {
				Type string `json:"type"`
				Text string `json:"text"`
			} `json:"item"`
		}
		if json.Unmarshal(data, &event) != nil {
			return false
		}
		if event.Type == "item.completed" && event.Item.Text != "" {
			switch event.Item.Type {
			case "agent_message":
				outputs = append(outputs, ChatOutput{Text: event.Item.Text})
			case "reasoning":
				outputs = append(outputs, ChatOutput{Reasoning: event.Item.Text})
			}
		}
		return true
	})
	if !valid {
		return nil
	}
	return outputs
}

// ParseChatTokenUsage exposes only normalized counters from a CLI chat run.
func ParseChatTokenUsage(provider ChatProvider, result process.Result) *domainmodelusage.Tokens {
	switch provider {
	case ChatProviderClaude:
		return ParseTokenUsage(ParserClaude, result)
	case ChatProviderCodex:
		return ParseTokenUsage(ParserCodex, result)
	default:
		return nil
	}
}

func validChatLaunch(value ChatLaunch) bool {
	if value.ProjectID <= 0 || !validTextPath(value.Workspace) || !validTextPath(value.WorkingDirectory) ||
		value.Prompt == "" || len(value.Prompt) > maximumPromptBytes || !utf8.ValidString(value.Prompt) || strings.ContainsRune(value.Prompt, 0) ||
		(value.Provider != ChatProviderClaude && value.Provider != ChatProviderCodex) || !validProviderField(value.Model) ||
		value.Timeout < 0 || value.Timeout > 2*time.Hour {
		return false
	}
	if value.Provider == ChatProviderClaude {
		if !validOptionalProviderField(value.Endpoint) || (value.Credential != nil && value.Credential.Name != "ANTHROPIC_AUTH_TOKEN") {
			return false
		}
		return true
	}
	return value.Endpoint == "" && value.Credential == nil && (value.ReasoningEffort == "" ||
		value.ReasoningEffort == "low" || value.ReasoningEffort == "medium" || value.ReasoningEffort == "high" || value.ReasoningEffort == "xhigh")
}

func validProviderField(value string) bool {
	return value != "" && len(value) <= 500 && utf8.ValidString(value) && strings.TrimSpace(value) == value && !strings.ContainsAny(value, "\x00\r\n")
}

func validOptionalProviderField(value string) bool {
	return value == "" || (len(value) <= 4096 && utf8.ValidString(value) && strings.TrimSpace(value) == value && !strings.ContainsAny(value, "\x00\r\n"))
}

var _ ChatRunner = (*process.Runner)(nil)
