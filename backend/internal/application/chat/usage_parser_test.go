package chat

import (
	"bytes"
	"encoding/json"
	"os"
	"testing"

	domainchat "github.com/lyming99/autoplan/backend/internal/domain/chat"
)

func TestParseHTTPUsageFixtures(t *testing.T) {
	tests := []struct {
		name, fixture                           string
		provider                                domainchat.ProviderKind
		input, output, cached, reasoning, total int64
	}{
		{name: "openai", fixture: "testdata/openai_usage.sse", provider: domainchat.ProviderOpenAI, input: 12, output: 5, cached: 3, reasoning: 2, total: 17},
		{name: "anthropic", fixture: "testdata/anthropic_usage.sse", provider: domainchat.ProviderAnthropic, input: 14, output: 6, cached: 6},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			data, err := os.ReadFile(test.fixture)
			if err != nil {
				t.Fatal(err)
			}
			chunks, usage, err := parseHTTPChunks(bytes.NewReader(data), "text/event-stream", test.provider)
			if err != nil || len(chunks) != 1 || usage == nil || usageValue(usage.Input) != test.input || usageValue(usage.Output) != test.output ||
				usageValue(usage.Cached) != test.cached || usageValue(usage.Reasoning) != test.reasoning || usageValue(usage.Total) != test.total {
				t.Fatalf("chunks=%#v usage=%#v err=%v", chunks, usage, err)
			}
		})
	}
}

func TestParseHTTPUsageRejectsTruncatedSSE(t *testing.T) {
	body := `data: {"choices":[],"usage":{"prompt_tokens":12}}\n\n`
	if chunks, usage, err := parseHTTPChunks(bytes.NewBufferString(body), "text/event-stream", domainchat.ProviderOpenAI); err == nil || chunks != nil || usage != nil {
		t.Fatalf("chunks=%#v usage=%#v err=%v", chunks, usage, err)
	}
}

func TestOpenAIStreamingRequestIncludesUsage(t *testing.T) {
	body, _, err := providerHTTPRequest(ProviderCommand{Profile: domainchat.ProviderProfile{
		Kind: domainchat.ProviderOpenAI, Model: "fixture-model", Endpoint: "https://fixture.invalid",
	}})
	if err != nil {
		t.Fatal(err)
	}
	var payload struct {
		StreamOptions struct {
			IncludeUsage bool `json:"include_usage"`
		} `json:"stream_options"`
	}
	if json.Unmarshal(body, &payload) != nil || !payload.StreamOptions.IncludeUsage {
		t.Fatalf("request did not enable streaming usage: %s", body)
	}
}

func usageValue(value *int64) int64 {
	if value == nil {
		return 0
	}
	return *value
}
