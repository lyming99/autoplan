package httpapi

import (
	"testing"

	applicationloop "github.com/lyming99/autoplan/backend/internal/application/loop"
)

func TestAcceptanceAdaptersPreserveCanonicalIntent(t *testing.T) {
	single := acceptanceCommand(applicationloop.CommandAcceptanceRedo, 7, acceptanceTargetRequest{
		TargetType: "task", ID: 19, Supplement: "rerun the focused regression",
	})
	if single.PlanID != 0 || single.TaskID != 0 || single.Action != "" || single.Acceptance == nil ||
		len(single.Acceptance.Targets) != 1 || single.Acceptance.Targets[0].TargetType != "task" ||
		single.Acceptance.Targets[0].ID != 19 || single.Acceptance.Supplement != "rerun the focused regression" {
		t.Fatalf("single acceptance command=%#v", single)
	}
	batch := acceptanceBatchCommand(applicationloop.CommandAcceptanceAcceptBatch, 7, acceptanceTargetsRequest{
		Targets: []acceptanceTargetRequest{{TargetType: "plan", ID: 3}, {TargetType: "task", ID: 9}},
	})
	if batch.Acceptance == nil || len(batch.Acceptance.Targets) != 2 ||
		batch.Acceptance.Targets[0].ID != 3 || batch.Acceptance.Targets[1].ID != 9 {
		t.Fatalf("batch acceptance command=%#v", batch)
	}
}
