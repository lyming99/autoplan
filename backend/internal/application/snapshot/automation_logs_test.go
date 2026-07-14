package snapshot

import (
	"encoding/json"
	"testing"

	domainautomation "github.com/lyming99/autoplan/backend/internal/domain/automation"
)

func TestAutomationSnapshotsExposeOnlyRepositoryArchivedLogTail(t *testing.T) {
	projectID := int64(7)
	logTail := "stdout:\ncompleted\n"
	script, err := scriptSnapshot(domainautomation.Script{
		ID: 11, ProjectID: &projectID, Name: "fixture", Runtime: "node", Description: "fixture",
		TriggerMode: "manual", Enabled: true, TimeoutSeconds: 60, ContextInject: "none",
		LastLog: &logTail, CreatedAt: "2026-07-14T00:00:00Z", UpdatedAt: "2026-07-14T00:00:01Z", SourceType: "inline",
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	var scriptLog *string
	if err := json.Unmarshal(script["last_log"], &scriptLog); err != nil || scriptLog == nil || *scriptLog != logTail {
		t.Fatalf("script last_log = %q, err = %v", valueOrEmpty(scriptLog), err)
	}

	executor, err := executorSnapshot(domainautomation.Executor{
		ID: 12, ProjectID: projectID, Label: "fixture", Type: "shell",
		LastLog: &logTail, CreatedAt: "2026-07-14T00:00:00Z", UpdatedAt: "2026-07-14T00:00:01Z",
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	var executorLog *string
	if err := json.Unmarshal(executor["last_log"], &executorLog); err != nil || executorLog == nil || *executorLog != logTail {
		t.Fatalf("executor last_log = %q, err = %v", valueOrEmpty(executorLog), err)
	}
}

func valueOrEmpty(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}
