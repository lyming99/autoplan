package agentcli

import (
	"os"
	"testing"

	"github.com/lyming99/autoplan/backend/internal/runtime/process"
)

func TestParseTokenUsageProviderFixtures(t *testing.T) {
	tests := []struct {
		name, fixture                           string
		kind                                    ParserKind
		input, output, cached, reasoning, total *int64
	}{
		{name: "claude", fixture: "testdata/claude_usage.jsonl", kind: ParserClaude, input: usageInt(120), output: usageInt(45), cached: usageInt(35)},
		{name: "codex", fixture: "testdata/codex_usage.jsonl", kind: ParserCodex, input: usageInt(90), output: usageInt(18), cached: usageInt(20), reasoning: usageInt(7)},
		{name: "oh-my-pi", fixture: "testdata/oh_my_pi_usage.jsonl", kind: ParserOhMyPi, input: usageInt(70), output: usageInt(15), cached: usageInt(14), reasoning: usageInt(6), total: usageInt(101)},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			data, err := os.ReadFile(test.fixture)
			if err != nil {
				t.Fatal(err)
			}
			usage := ParseTokenUsage(test.kind, process.Result{Stdout: process.Output{Tail: string(data)}})
			if usage == nil || !sameUsageValue(usage.Input, test.input) || !sameUsageValue(usage.Output, test.output) ||
				!sameUsageValue(usage.Cached, test.cached) || !sameUsageValue(usage.Reasoning, test.reasoning) || !sameUsageValue(usage.Total, test.total) {
				t.Fatalf("usage=%#v", usage)
			}
		})
	}
}

func TestParseTokenUsageRejectsIncompleteOrMalformedCapture(t *testing.T) {
	valid := `{"type":"turn.completed","usage":{"input_tokens":4}}`
	values := []process.Result{
		{Stdout: process.Output{Tail: valid, Truncated: true}},
		{Stdout: process.Output{Tail: valid, RedactionFailed: true}},
		{Stdout: process.Output{Tail: valid + "\nnot-json"}},
		{Stdout: process.Output{Tail: `{"type":"turn.completed","usage":{"input_tokens":-1}}`}},
	}
	for index, value := range values {
		if usage := ParseTokenUsage(ParserCodex, value); usage != nil {
			t.Fatalf("case %d usage=%#v", index, usage)
		}
	}
}

func usageInt(value int64) *int64 { return &value }

func sameUsageValue(actual, expected *int64) bool {
	return actual == nil && expected == nil || actual != nil && expected != nil && *actual == *expected
}
