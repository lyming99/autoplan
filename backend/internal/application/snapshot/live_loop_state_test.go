package snapshot

import (
	"encoding/json"
	"testing"

	domainproject "github.com/lyming99/autoplan/backend/internal/domain/project"
	"github.com/lyming99/autoplan/backend/internal/repository"
)

func TestSnapshotPreservesLiveLoopRunningAndWaitingState(t *testing.T) {
	project := repository.Project{
		ID: 7, Name: "fixture", WorkspacePath: `D:\fixture`,
		CreatedAt: "2026-07-14T00:00:00.000Z", UpdatedAt: "2026-07-14T00:00:00.000Z",
	}
	state := repository.ProjectState{
		ProjectID: 7, Running: 1, Phase: "waiting", IntervalSeconds: 5,
		AgentCLIProvider: "codex", PlanGenerationStrategy: "external-cli-markdown",
		PlanExecutionStrategy: "external-cli", UpdatedAt: "2026-07-14T00:00:01.000Z", Version: 2,
	}
	value := stateOrDefault(project, state, true)
	if value.Running != 1 || value.Phase != "waiting" {
		t.Fatalf("normalized state=%#v", value)
	}
	snapshot, err := stateSnapshot(project, state, true, domainproject.Visibility{WorkspacePath: true})
	var running int64
	var phase string
	if err == nil {
		err = json.Unmarshal(snapshot["running"], &running)
	}
	if err == nil {
		err = json.Unmarshal(snapshot["phase"], &phase)
	}
	if err != nil || running != 1 || phase != "waiting" {
		t.Fatalf("snapshot=%#v err=%v", snapshot, err)
	}
	contract, err := projectContract(project, &state, domainproject.Visibility{WorkspacePath: true})
	if err != nil || contract.Running == nil || *contract.Running != 1 || contract.Phase == nil || *contract.Phase != "waiting" {
		t.Fatalf("contract=%#v err=%v", contract, err)
	}
}

func TestSnapshotPreservesStoppedState(t *testing.T) {
	if normalizedPhase("stopped") != "stopped" || normalizedPhase("running") != "running" || normalizedPhase("") != "idle" {
		t.Fatal("loop phase normalization changed live state")
	}
}
