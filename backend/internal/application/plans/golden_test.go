package plans

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"testing"

	domainplan "github.com/lyming99/autoplan/backend/internal/domain/plan"
)

func TestPlanGoldenSnapshotHasStableSnakeCaseSurface(t *testing.T) {
	snapshot, err := PlanSnapshot(domainplan.Plan{
		ID: 8, ProjectID: 4, IssueHash: "issue-digest", SourceRef: "docs/plan/fixture.md", Digest: "plan-digest",
		Status: domainplan.StatusCompleted, SortOrder: 2, TotalTasks: 2, CompletedTasks: 2, ValidationPassed: true,
		PlanGeneration: domainplan.BackendConfig{Strategy: "external-cli-markdown"},
		PlanExecution:  domainplan.BackendConfig{Strategy: "external-cli"},
		CreatedAt:      "2026-07-11T00:00:00.000Z", UpdatedAt: "2026-07-11T00:00:00.000Z",
	})
	if err != nil {
		t.Fatal(err)
	}
	keys := make([]string, 0, len(snapshot))
	for key := range snapshot {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	expected := []string{
		"accepted_at", "agent_cli_command", "agent_cli_provider", "agent_cli_session_id", "codex_reasoning_effort",
		"completed_tasks", "concurrency_suggestion", "created_at", "file_path", "hash", "id", "is_draft", "issue_hash",
		"plan_execution_claude_auth_token", "plan_execution_claude_base_url", "plan_execution_claude_config_id",
		"plan_execution_claude_model", "plan_execution_command", "plan_execution_codex_reasoning_effort", "plan_execution_has_claude_auth_token",
		"plan_execution_model", "plan_execution_provider", "plan_execution_strategy", "plan_generation_claude_auth_token",
		"plan_generation_claude_base_url", "plan_generation_claude_config_id", "plan_generation_claude_model",
		"plan_generation_codex_reasoning_effort", "plan_generation_command", "plan_generation_duration_ms",
		"plan_generation_has_claude_auth_token", "plan_generation_model", "plan_generation_provider", "plan_generation_strategy",
		"project_id", "sort_order", "status", "title", "total_tasks", "updated_at", "validation_passed",
	}
	sort.Strings(expected)
	if len(keys) != len(expected) {
		t.Fatalf("snapshot keys=%v", keys)
	}
	for index := range expected {
		if keys[index] != expected[index] {
			t.Fatalf("snapshot keys=%v want=%v", keys, expected)
		}
	}
	var sourceRef, title string
	if err := json.Unmarshal(snapshot["file_path"], &sourceRef); err != nil || sourceRef != "docs/plan/fixture.md" {
		t.Fatalf("file_path=%q error=%v", sourceRef, err)
	}
	if err := json.Unmarshal(snapshot["title"], &title); err != nil || title != "Plan #8" {
		t.Fatalf("title=%q error=%v", title, err)
	}
}

func TestPlanGoldenFixtureIsSyntheticAndVersioned(t *testing.T) {
	_, source, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("caller unavailable")
	}
	data, err := os.ReadFile(filepath.Join(filepath.Dir(source), "..", "..", "..", "..", "fixtures", "migration", "p07", "state-machine-cases.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		SchemaVersion int    `json:"schemaVersion"`
		Version       string `json:"version"`
		Source        string `json:"source"`
		Scenarios     []struct {
			ID       string `json:"id"`
			Response struct {
				OK          bool `json:"ok"`
				Mutation    bool `json:"mutation"`
				AuditEvents int  `json:"audit_events"`
			} `json:"response"`
		} `json:"scenarios"`
	}
	if err := json.Unmarshal(data, &fixture); err != nil {
		t.Fatal(err)
	}
	if fixture.SchemaVersion != 1 || fixture.Version != "p07-node-plan-golden-v1" || fixture.Source != "synthetic-node-reference" || len(fixture.Scenarios) < 16 {
		t.Fatalf("fixture header or coverage drift: %#v", fixture)
	}
	for _, scenario := range fixture.Scenarios {
		if scenario.ID == "" || (!scenario.Response.OK && (scenario.Response.Mutation || scenario.Response.AuditEvents != 0)) {
			t.Fatalf("unsafe failure scenario: %#v", scenario)
		}
	}
}
