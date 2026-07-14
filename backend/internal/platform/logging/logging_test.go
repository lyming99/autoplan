package logging

import (
	"bytes"
	"encoding/json"
	"testing"
	"time"
)

type fixedClock struct{ value time.Time }

func (clock fixedClock) Now() time.Time { return clock.value }

func TestJSONLoggerKeepsOnlyStructuredLoopDiagnostics(t *testing.T) {
	var output bytes.Buffer
	clock := fixedClock{value: time.Date(2026, 7, 14, 1, 2, 3, 0, time.UTC)}
	logger, err := NewJSONLogger(&output, clock)
	if err != nil {
		t.Fatal(err)
	}
	if err := logger.Log(Event{
		Level: "error", Code: "agent_cli_finished", ErrorCode: "invalid_runtime_command",
		Provider: "codex", Stage: "plan_generation", ProjectID: 7, IntakeID: 3,
		ExitCode: 1, StdoutBytes: 42, StderrBytes: 9, RedactionFailed: true,
	}); err != nil {
		t.Fatal(err)
	}
	var event map[string]any
	if err := json.Unmarshal(output.Bytes(), &event); err != nil {
		t.Fatal(err)
	}
	if event["code"] != "agent_cli_finished" || event["provider"] != "codex" ||
		event["project_id"] != float64(7) || event["stdout_bytes"] != float64(42) ||
		event["redaction_failed"] != true {
		t.Fatalf("event=%#v", event)
	}
}

func TestJSONLoggerNormalizesUnsafeMetadata(t *testing.T) {
	var output bytes.Buffer
	logger, _ := NewJSONLogger(&output, fixedClock{value: time.Now()})
	_ = logger.Log(Event{Level: "ERROR with secret", Code: "bad token=value", Provider: "C:\\private path", ProjectID: -1})
	var event map[string]any
	_ = json.Unmarshal(output.Bytes(), &event)
	if event["level"] != "info" || event["code"] != "invalid_log_code" || event["provider"] != "redacted" {
		t.Fatalf("event=%#v", event)
	}
	if _, exists := event["project_id"]; exists {
		t.Fatalf("negative project id leaked: %#v", event)
	}
}
