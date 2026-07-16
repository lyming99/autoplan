package sqlite

import (
	"context"
	"database/sql/driver"
	"errors"
	"testing"

	domainintake "github.com/lyming99/autoplan/backend/internal/domain/intake"
	domainplan "github.com/lyming99/autoplan/backend/internal/domain/plan"
	"github.com/lyming99/autoplan/backend/internal/repository"
)

func TestCreateGeneratedPlanPersistsAndReadsGenerationDuration(t *testing.T) {
	const durationMS int64 = 4321
	created := planTestValues(11, 1, "pending", intakeTestTime, nil)
	created[25] = durationMS
	legacy := planTestValues(10, 1, "pending", intakeTestTime, nil)
	backend := &scriptBackend{steps: []scriptStep{
		queryStep("FROM requirements WHERE project_id", intakeTestColumns(),
			intakeTestValues(domainintake.Requirement, 3, 1, nil, "Requirement", "Body", "open", nil)),
		queryStep("SELECT COALESCE(MAX(sort_order)", []string{"sort_order"}, []driver.Value{int64(2)}),
		execStep("INSERT INTO plans", 1, 11),
		execStep("INSERT INTO plan_tasks", 1, 1),
		execStep("INSERT INTO intake_plan_links", 1, 1),
		execStep("UPDATE requirements SET linked_plan_id", 1, 0),
		queryStep("SELECT 1 FROM projects", []string{"1"}, []driver.Value{int64(1)}),
		queryStep("ORDER BY sort_order ASC, created_at ASC, id ASC", planTestColumns(), created, legacy),
	}}
	writer, cleanup := newTestWriter(t, backend)
	defer cleanup()

	input := generatedPlanTestInput(durationMS)
	planID, err := writer.CreateGeneratedPlan(context.Background(), input)
	if err != nil || planID != 11 {
		t.Fatalf("created plan id=%d error=%v", planID, err)
	}
	executions := backend.recordedExecArgs()
	if len(executions) == 0 || len(executions[0]) <= 19 || executions[0][19].Value != durationMS {
		t.Fatalf("plan INSERT duration argument=%#v, want %d", executions, durationMS)
	}

	var plans []domainplan.Plan
	err = writer.TransactPlans(context.Background(), func(transaction repository.PlanWriteTransaction) error {
		var listErr error
		plans, listErr = transaction.ListPlans(context.Background(), domainplan.ListOptions{ProjectID: 1, Limit: 10})
		return listErr
	})
	if err != nil || len(plans) != 2 {
		backend.mu.Lock()
		remaining, commits, rollbacks := len(backend.steps), backend.commits, backend.rollbacks
		backend.mu.Unlock()
		t.Fatalf("plans=%#v error=%v remaining=%d commits=%d rollbacks=%d", plans, err, remaining, commits, rollbacks)
	}
	if plans[0].GenerationMillis != durationMS || plans[1].GenerationMillis != 0 {
		t.Fatalf("generation durations=%d,%d, want %d,0", plans[0].GenerationMillis, plans[1].GenerationMillis, durationMS)
	}
	backend.assertFinished(t, 2, 0)
}

func TestCreateGeneratedPlanRejectsNegativeGenerationDuration(t *testing.T) {
	backend := &scriptBackend{}
	writer, cleanup := newTestWriter(t, backend)
	defer cleanup()

	_, err := writer.CreateGeneratedPlan(context.Background(), generatedPlanTestInput(-1))
	if !errors.Is(err, repository.ErrInvalidPlan) {
		t.Fatalf("negative duration error=%v", err)
	}
	backend.assertFinished(t, 0, 0)
}

func generatedPlanTestInput(durationMS int64) repository.GeneratedPlanInput {
	return repository.GeneratedPlanInput{
		ProjectID: 1, IntakeType: domainintake.Requirement, IntakeID: 3,
		Status: domainplan.StatusPending, IssueHash: "issue-digest", FilePath: "docs/plan/generated.md",
		Digest: "plan-digest", GenerationDurationMS: durationMS, CreatedAt: intakeTestTime,
		Tasks: []repository.GeneratedPlanTask{{
			Key: "P001", Title: "Persist duration", RawLine: "- [ ] P001: Persist duration",
			Scope: "backend", SortOrder: 1,
		}},
	}
}
