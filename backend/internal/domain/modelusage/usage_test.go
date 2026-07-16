package modelusage

import "testing"

func TestRecordPreservesUnknownTokenFields(t *testing.T) {
	input := int64(12)
	total := int64(12)
	record := Record{
		ProjectID: 7, InvocationKey: "plan:7:attempt:1", Provider: "codex", Model: "gpt-5",
		Source: SourcePlanGeneration, Tokens: Tokens{Input: &input, Total: &total},
		CollectedAt: "2026-07-15T00:00:00Z",
	}
	if err := ValidateRecord(record); err != nil {
		t.Fatalf("ValidateRecord() error = %v", err)
	}
	if record.Tokens.Output != nil || record.Tokens.Cached != nil || record.Tokens.Reasoning != nil {
		t.Fatal("unknown token fields were converted to values")
	}
}

func TestRecordRejectsInvalidAccounting(t *testing.T) {
	negative := int64(-1)
	cases := []Record{
		{ProjectID: 1, InvocationKey: "key", Provider: "codex", Source: SourceTaskExecution, Tokens: Tokens{Input: &negative}, CollectedAt: "2026-07-15T00:00:00Z"},
		{ProjectID: 1, InvocationKey: "key", Provider: "codex", Source: SourceTaskExecution, CollectedAt: "2026-07-15T00:00:00Z"},
		{ProjectID: 1, InvocationKey: "key", Provider: "codex", Source: "unknown", Tokens: Tokens{Input: pointer(1)}, CollectedAt: "2026-07-15T00:00:00Z"},
	}
	for index, record := range cases {
		if err := ValidateRecord(record); err == nil {
			t.Fatalf("case %d accepted invalid record", index)
		}
	}
}

func pointer(value int64) *int64 { return &value }
