package logging

import (
	"bytes"
	"encoding/json"
	"strings"
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
	fingerprint := "sha256:" + strings.Repeat("a", 64)
	if err := logger.Log(Event{
		Level: "error", Code: "agent_cli_finished", ErrorCode: "invalid_runtime_command",
		Provider: "codex", Stage: "plan_generation", ProjectID: 7, IntakeID: 3,
		SessionMode: "resume", ContextState: "reused", SessionFingerprint: fingerprint,
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
		event["session_mode"] != "resume" || event["context_state"] != "reused" ||
		event["session_fingerprint"] != fingerprint || event["redaction_failed"] != true {
		t.Fatalf("event=%#v", event)
	}
}

func TestJSONLoggerNormalizesUnsafeMetadata(t *testing.T) {
	var output bytes.Buffer
	logger, _ := NewJSONLogger(&output, fixedClock{value: time.Now()})
	_ = logger.Log(Event{Level: "ERROR with secret", Code: "bad token=value", Provider: "C:\\private path", ProjectID: -1,
		SessionMode: "resume with secret", ContextState: "reused with secret",
		SessionFingerprint: "00000000-aaaa-bbbb-cccc-000000000001"})
	var event map[string]any
	_ = json.Unmarshal(output.Bytes(), &event)
	if event["level"] != "info" || event["code"] != "invalid_log_code" || event["provider"] != "redacted" {
		t.Fatalf("event=%#v", event)
	}
	if _, exists := event["project_id"]; exists {
		t.Fatalf("negative project id leaked: %#v", event)
	}
	if _, exists := event["session_fingerprint"]; exists {
		t.Fatalf("raw session id leaked as fingerprint: %#v", event)
	}
}
