package agentcli

import (
	"encoding/json"
	"math"
	"regexp"
	"strings"

	domainmodelusage "github.com/lyming99/autoplan/backend/internal/domain/modelusage"
	"github.com/lyming99/autoplan/backend/internal/runtime/process"
)

type ParserKind string

const (
	ParserCodex    ParserKind = "codex"
	ParserClaude   ParserKind = "claude-stream-json"
	ParserOpenCode ParserKind = "opencode"
	ParserOhMyPi   ParserKind = "oh-my-pi"
)

type parsedOutput struct {
	SessionID      string
	SessionMissing bool
	ParseFailed    bool
	Usage          *domainmodelusage.Tokens
}

// SessionMetadata is the bounded, non-transcript portion of Agent CLI output
// that a workflow may persist between executions.
type SessionMetadata struct {
	ID      string
	Missing bool
}

var codexSessionPattern = regexp.MustCompile(`(?im)(?:session\s+id:\s*|"(?:session_id|sessionId|thread_id)"\s*:\s*"|(?:session_id|sessionId|thread_id)\s*[:=]\s*)([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})`)
var codexResumeFailure = regexp.MustCompile(`(?i)(?:thread/resume|resume failed|no rollout found|session\s+(?:not\s+found|missing)|conversation\s+not\s+found|unknown\s+session|invalid\s+session)`)
var claudeSessionMissing = regexp.MustCompile(`(?i)(?:session\s+not\s+found|unknown\s+session|invalid\s+session|conversation\s+not\s+found|no\s+conversation)`)
var openCodeSessionMissing = regexp.MustCompile(`(?i)(?:session\s+not\s+found|unknown\s+session|invalid\s+session)`)

func parseOutput(_ Provider, kind ParserKind, result process.Result) parsedOutput {
	text := safeProcessText(result)
	parsed := parsedOutput{}
	switch kind {
	case ParserCodex:
		if match := codexSessionPattern.FindStringSubmatch(text); len(match) == 2 {
			parsed.SessionID = normalizeSessionID(ProviderCodex, match[1])
		}
		parsed.SessionMissing = codexResumeFailure.MatchString(text)
	case ParserClaude:
		parsed = parseClaudeStream(text)
		parsed.SessionMissing = parsed.SessionMissing || claudeSessionMissing.MatchString(text)
	case ParserOpenCode:
		parsed.SessionMissing = openCodeSessionMissing.MatchString(text)
	case ParserOhMyPi:
		// oh-my-pi deliberately has no persistent session contract.
	}
	parsed.Usage = ParseTokenUsage(kind, result)
	return parsed
}

// ParseTokenUsage extracts only provider-reported structured counters. It is
// deliberately strict: incomplete capture, redaction failure, malformed JSONL,
// negative counters, and overflow all result in no usage rather than an
// estimate derived from transcript text.
func ParseTokenUsage(kind ParserKind, result process.Result) *domainmodelusage.Tokens {
	if result.Stdout.Truncated || result.Stderr.Truncated || result.Stdout.RedactionFailed || result.Stderr.RedactionFailed {
		return nil
	}
	text := strings.TrimSpace(result.Stdout.Tail)
	if text == "" {
		return nil
	}
	switch kind {
	case ParserClaude:
		return parseClaudeUsage(text)
	case ParserCodex:
		return parseCodexUsage(text)
	case ParserOhMyPi:
		return parseOhMyPiUsage(text)
	default:
		return nil
	}
}

type tokenFields struct {
	Input           *int64 `json:"input_tokens"`
	Output          *int64 `json:"output_tokens"`
	CachedInput     *int64 `json:"cached_input_tokens"`
	ReasoningOutput *int64 `json:"reasoning_output_tokens"`
	CacheRead       *int64 `json:"cache_read_input_tokens"`
	CacheCreation   *int64 `json:"cache_creation_input_tokens"`
	Total           *int64 `json:"total_tokens"`
}

func parseClaudeUsage(text string) *domainmodelusage.Tokens {
	var found *domainmodelusage.Tokens
	if !eachJSONLine(text, func(data []byte) bool {
		var event struct {
			Type  string      `json:"type"`
			Usage tokenFields `json:"usage"`
		}
		if json.Unmarshal(data, &event) != nil {
			return false
		}
		if event.Type == "result" {
			found = tokensFromFields(event.Usage, true)
		}
		return true
	}) {
		return nil
	}
	return found
}

func parseCodexUsage(text string) *domainmodelusage.Tokens {
	var found *domainmodelusage.Tokens
	if !eachJSONLine(text, func(data []byte) bool {
		var event struct {
			Type  string      `json:"type"`
			Usage tokenFields `json:"usage"`
		}
		if json.Unmarshal(data, &event) != nil {
			return false
		}
		if event.Type == "turn.completed" {
			found = tokensFromFields(event.Usage, false)
		}
		return true
	}) {
		return nil
	}
	return found
}

func parseOhMyPiUsage(text string) *domainmodelusage.Tokens {
	var total domainmodelusage.Tokens
	seen := false
	if !eachJSONLine(text, func(data []byte) bool {
		var event struct {
			Type    string `json:"type"`
			Message struct {
				Role  string `json:"role"`
				Usage struct {
					Input      *int64 `json:"input"`
					Output     *int64 `json:"output"`
					CacheRead  *int64 `json:"cacheRead"`
					CacheWrite *int64 `json:"cacheWrite"`
					Reasoning  *int64 `json:"reasoning"`
					Total      *int64 `json:"totalTokens"`
				} `json:"usage"`
			} `json:"message"`
		}
		if json.Unmarshal(data, &event) != nil {
			return false
		}
		if event.Type != "message_end" || event.Message.Role != "assistant" {
			return true
		}
		cached, ok := addOptional(event.Message.Usage.CacheRead, event.Message.Usage.CacheWrite)
		if !ok {
			return false
		}
		current := domainmodelusage.Tokens{
			Input: event.Message.Usage.Input, Output: event.Message.Usage.Output, Cached: cached,
			Reasoning: event.Message.Usage.Reasoning, Total: event.Message.Usage.Total,
		}
		if !validTokens(current) || !addTokens(&total, current) {
			return false
		}
		seen = true
		return true
	}) || !seen {
		return nil
	}
	return &total
}

func tokensFromFields(fields tokenFields, anthropic bool) *domainmodelusage.Tokens {
	cached := fields.CachedInput
	if anthropic {
		var ok bool
		cached, ok = addOptional(fields.CacheRead, fields.CacheCreation)
		if !ok {
			return nil
		}
	}
	result := domainmodelusage.Tokens{
		Input: fields.Input, Output: fields.Output, Cached: cached,
		Reasoning: fields.ReasoningOutput, Total: fields.Total,
	}
	if !validTokens(result) {
		return nil
	}
	return &result
}

func eachJSONLine(text string, visit func([]byte) bool) bool {
	seen := false
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		seen = true
		if !visit([]byte(line)) {
			return false
		}
	}
	return seen
}

func addOptional(left, right *int64) (*int64, bool) {
	if left == nil && right == nil {
		return nil, true
	}
	var value int64
	for _, item := range []*int64{left, right} {
		if item == nil {
			continue
		}
		if *item < 0 || value > math.MaxInt64-*item {
			return nil, false
		}
		value += *item
	}
	return int64Pointer(value), true
}

func validTokens(value domainmodelusage.Tokens) bool {
	known := false
	for _, item := range []*int64{value.Input, value.Output, value.Cached, value.Reasoning, value.Total} {
		if item != nil {
			known = true
			if *item < 0 {
				return false
			}
		}
	}
	return known
}

func addTokens(target *domainmodelusage.Tokens, value domainmodelusage.Tokens) bool {
	if target == nil || !validTokens(value) {
		return false
	}
	for _, pair := range [][2]**int64{{&target.Input, &value.Input}, {&target.Output, &value.Output}, {&target.Cached, &value.Cached}, {&target.Reasoning, &value.Reasoning}, {&target.Total, &value.Total}} {
		incoming := *pair[1]
		if incoming == nil {
			continue
		}
		if *pair[0] == nil {
			*pair[0] = int64Pointer(*incoming)
			continue
		}
		if **pair[0] > math.MaxInt64-*incoming {
			return false
		}
		**pair[0] += *incoming
	}
	return true
}

func int64Pointer(value int64) *int64 { return &value }

// ParseSessionMetadata extracts only a validated session identifier and the
// provider's explicit "session missing" signal from already-redacted output.
func ParseSessionMetadata(provider Provider, result process.Result) SessionMetadata {
	kind := ParserOhMyPi
	switch provider {
	case ProviderCodex:
		kind = ParserCodex
	case ProviderClaude:
		kind = ParserClaude
	case ProviderOpenCode:
		kind = ParserOpenCode
	case ProviderOhMyPi:
		return SessionMetadata{}
	default:
		return SessionMetadata{}
	}
	parsed := parseOutput(provider, kind, result)
	return SessionMetadata{ID: parsed.SessionID, Missing: parsed.SessionMissing}
}

// ParseOpenCodeSessionList returns the exact titled session from a bounded
// `opencode session list` result. It never returns the list or directory data.
func ParseOpenCodeSessionList(result process.Result, title string) (string, bool) {
	return parseOpenCodeSessions(result, normalizeSessionTitle(title))
}

func parseClaudeStream(text string) parsedOutput {
	result := parsedOutput{}
	seenJSON := false
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		var event struct {
			Type      string `json:"type"`
			SessionID string `json:"session_id"`
		}
		if err := json.Unmarshal([]byte(line), &event); err != nil {
			continue
		}
		seenJSON = true
		if event.Type == "result" {
			result.SessionID = normalizeSessionID(ProviderClaude, event.SessionID)
		}
	}
	if strings.TrimSpace(text) != "" && !seenJSON {
		result.ParseFailed = true
	}
	return result
}

type openCodeSessionRecord struct {
	ID        string `json:"id"`
	Title     string `json:"title"`
	Directory string `json:"directory"`
}

func parseOpenCodeSessions(result process.Result, title string) (string, bool) {
	text := strings.TrimSpace(safeProcessText(result))
	if text == "" || result.ExitCode != 0 || result.TimedOut || result.Cancelled || result.Stdout.Truncated || result.Stderr.Truncated {
		return "", false
	}
	var entries []openCodeSessionRecord
	if err := json.Unmarshal([]byte(text), &entries); err != nil {
		return "", false
	}
	for _, entry := range entries {
		if entry.Title == title {
			if id := normalizeSessionID(ProviderOpenCode, entry.ID); id != "" {
				return id, true
			}
		}
	}
	return "", true
}

func safeProcessText(result process.Result) string {
	// Process.Result has already bounded and redacted both streams. Parser input
	// remains internal and is never copied into an Agent CLI Result or event.
	return result.Stdout.Tail + "\n" + result.Stderr.Tail
}
