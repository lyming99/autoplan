package snapshot

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/lyming99/autoplan/backend/internal/domain/contracts"
	domainoperation "github.com/lyming99/autoplan/backend/internal/domain/operation"
)

func TestOperationSnapshotsExposeSafeLifecycleLog(t *testing.T) {
	started, finished := "2026-07-14T00:00:01.000Z", "2026-07-14T00:00:03.000Z"
	result := json.RawMessage(`{"pending_intakes":1,"generated_plans":1,"processed_plans":1}`)
	operation := domainoperation.Operation{
		OperationID: "loop-operation-1", ProjectID: 7, Type: "loop.run_once",
		Status: domainoperation.StatusSucceeded, RequestID: "req-1", RequestDigest: strings.Repeat("a", 64),
		Version: 3, CreatedAt: "2026-07-14T00:00:00.000Z", UpdatedAt: finished,
		StartedAt: &started, FinishedAt: &finished, Result: &result,
	}
	snapshot := emptySnapshot(nil, contracts.SanitizedObject{})
	projectID := int64(7)
	snapshot.ActiveProjectID = &projectID
	if err := applyOperationSnapshots(&snapshot, []domainoperation.Operation{operation}); err != nil {
		t.Fatal(err)
	}
	if snapshot.ActiveOperation != nil || snapshot.LastOperation == nil || len(snapshot.ActiveOperations) != 0 {
		t.Fatalf("operation projection=%#v", snapshot)
	}
	var logTail, owner string
	if err := json.Unmarshal((*snapshot.LastOperation)["logTail"], &logTail); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal((*snapshot.LastOperation)["runtimeOwner"], &owner); err != nil {
		t.Fatal(err)
	}
	if owner != "go" || !strings.Contains(logTail, "生成计划 1") || !strings.Contains(logTail, "执行任务 1") ||
		strings.Contains(logTail, "prompt") || strings.Contains(logTail, "stdout") {
		t.Fatalf("owner=%q log=%q", owner, logTail)
	}
}

func TestOperationSnapshotsPreferNewestActiveOperation(t *testing.T) {
	started := "2026-07-14T00:00:02.000Z"
	active := domainoperation.Operation{
		OperationID: "loop-operation-new", ProjectID: 7, Type: "loop.run_once", Status: domainoperation.StatusRunning,
		RequestID: "req-new", RequestDigest: strings.Repeat("b", 64), Version: 2,
		CreatedAt: "2026-07-14T00:00:01.000Z", UpdatedAt: started, StartedAt: &started,
	}
	snapshot := emptySnapshot(nil, contracts.SanitizedObject{})
	if err := applyOperationSnapshots(&snapshot, []domainoperation.Operation{active}); err != nil {
		t.Fatal(err)
	}
	if snapshot.ActiveOperation == nil || len(snapshot.ActiveOperations) != 1 || snapshot.LastOperation != nil {
		t.Fatalf("operation projection=%#v", snapshot)
	}
}
