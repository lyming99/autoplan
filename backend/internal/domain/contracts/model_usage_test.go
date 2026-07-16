package contracts

import (
	"encoding/json"
	"testing"
)

func TestModelUsageUsesStrongContractWithoutWeakeningSanitization(t *testing.T) {
	var unsafe SanitizedObject
	if err := json.Unmarshal([]byte(`{"inputTokens":12}`), &unsafe); err == nil {
		t.Fatal("SanitizedObject accepted a token-named field")
	}

	content := []byte(`{
		"cumulative":{"inputTokens":12,"outputTokens":4,"cachedTokens":2,"reasoningTokens":1,"totalTokens":19},
		"today":{"inputTokens":3,"outputTokens":1,"cachedTokens":0,"reasoningTokens":0,"totalTokens":4},
		"byProvider":[{"provider":"openai","cumulative":{"inputTokens":12,"outputTokens":4,"cachedTokens":2,"reasoningTokens":1,"totalTokens":19},"today":{"inputTokens":3,"outputTokens":1,"cachedTokens":0,"reasoningTokens":0,"totalTokens":4}}]
	}`)
	var usage ModelUsageSummary
	if err := DecodeStrict(content, &usage); err != nil {
		t.Fatalf("strong model usage was rejected: %v", err)
	}
	if usage.Cumulative.TotalTokens != 19 || len(usage.ByProvider) != 1 {
		t.Fatalf("decoded usage=%#v", usage)
	}
}

func TestModelUsageStrictlyRejectsUnknownNegativeAndNullFields(t *testing.T) {
	cases := []string{
		`{"cumulative":{"inputTokens":0,"outputTokens":0,"cachedTokens":0,"reasoningTokens":0,"totalTokens":-1},"today":{"inputTokens":0,"outputTokens":0,"cachedTokens":0,"reasoningTokens":0,"totalTokens":0},"byProvider":[]}`,
		`{"cumulative":{"inputTokens":0,"outputTokens":0,"cachedTokens":0,"reasoningTokens":0,"totalTokens":0,"extra":1},"today":{"inputTokens":0,"outputTokens":0,"cachedTokens":0,"reasoningTokens":0,"totalTokens":0},"byProvider":[]}`,
		`{"cumulative":{"inputTokens":0,"outputTokens":0,"cachedTokens":0,"reasoningTokens":0,"totalTokens":0},"today":{"inputTokens":0,"outputTokens":0,"cachedTokens":0,"reasoningTokens":0,"totalTokens":0},"byProvider":null}`,
	}
	for index, content := range cases {
		var usage ModelUsageSummary
		if err := DecodeStrict([]byte(content), &usage); err == nil {
			t.Fatalf("case %d accepted invalid model usage", index)
		}
	}
}
