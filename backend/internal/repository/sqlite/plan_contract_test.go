package sqlite

import (
	"context"
	"database/sql/driver"
	"errors"
	"sync"
	"testing"

	domainevent "github.com/lyming99/autoplan/backend/internal/domain/event"
	domainplan "github.com/lyming99/autoplan/backend/internal/domain/plan"
	"github.com/lyming99/autoplan/backend/internal/repository"
)

func TestPlanContractListsProjectScopedStableOrder(t *testing.T) {
	first := planTestValues(9, 4, "completed", intakeTestTime, nil)
	first[6] = int64(1)
	second := planTestValues(8, 4, "pending", intakeTestTime, nil)
	second[6] = int64(2)
	backend := &scriptBackend{steps: []scriptStep{
		queryStep("SELECT 1 FROM projects", []string{"1"}, []driver.Value{int64(1)}),
		queryStep("ORDER BY sort_order ASC, created_at ASC, id ASC", planTestColumns(), first, second),
	}}
	writer, cleanup := newTestWriter(t, backend)
	defer cleanup()

	var records []domainplan.Plan
	err := writer.TransactPlans(context.Background(), func(transaction repository.PlanWriteTransaction) error {
		var listErr error
		records, listErr = transaction.ListPlans(context.Background(), domainplan.ListOptions{ProjectID: 4, Limit: 2})
		return listErr
	})
	if err != nil || len(records) != 2 || records[0].ID != 9 || records[1].ID != 8 {
		t.Fatalf("records=%#v error=%v", records, err)
	}
	backend.assertFinished(t, 1, 0)
}

func TestPlanContractRejectsStaleReorderBeforeWrites(t *testing.T) {
	backend := &scriptBackend{steps: []scriptStep{
		queryStep("SELECT 1 FROM projects", []string{"1"}, []driver.Value{int64(1)}),
		queryStep("SELECT id, sort_order, updated_at FROM plans", []string{"id", "sort_order", "updated_at"},
			[]driver.Value{int64(8), int64(1), intakeTestTime}),
	}}
	writer, cleanup := newTestWriter(t, backend)
	defer cleanup()

	err := writer.TransactPlans(context.Background(), func(transaction repository.PlanWriteTransaction) error {
		_, reorderErr := transaction.ReorderPlans(context.Background(), domainplan.Reorder{
			ProjectID: 4, IDs: []int64{8},
			ExpectedUpdatedAt: map[int64]string{8: "2026-07-11T00:00:01.000Z"},
			UpdatedAt:         "2026-07-11T00:00:02.000Z",
		})
		return reorderErr
	})
	if !errors.Is(err, repository.ErrVersionConflict) {
		t.Fatalf("stale reorder error=%v", err)
	}
	backend.assertFinished(t, 0, 1)
}

func TestPlanContractFaultAfterAcceptanceWriteRollsBack(t *testing.T) {
	acceptedAt := "2026-07-11T00:00:01.000Z"
	backend := &scriptBackend{steps: []scriptStep{
		queryStep("FROM plans WHERE project_id", planTestColumns(), planTestValues(8, 4, "completed", intakeTestTime, nil)),
		execStep("UPDATE plans SET accepted_at", 1, 0),
	}}
	writer, cleanup := newTestWriter(t, backend)
	defer cleanup()
	writer.faults.afterWrite = func(label string) error {
		if label == "plans:acceptance" {
			return errors.New("acceptance write interrupted")
		}
		return nil
	}

	err := writer.TransactPlans(context.Background(), func(transaction repository.PlanWriteTransaction) error {
		_, updateErr := transaction.SetPlanAcceptance(context.Background(), domainplan.AcceptanceUpdate{
			ProjectID: 4, ID: 8, AcceptedAt: &acceptedAt, ExpectedUpdatedAt: intakeTestTime, UpdatedAt: acceptedAt,
		})
		return updateErr
	})
	if !errors.Is(err, repository.ErrTransaction) {
		t.Fatalf("fault-injected error=%v", err)
	}
	backend.assertFinished(t, 0, 1)
}

func TestPlanContractProtectsRunningAggregateWithoutWrites(t *testing.T) {
	backend := &scriptBackend{steps: []scriptStep{
		queryStep("FROM plans WHERE project_id", planTestColumns(), planTestValues(8, 4, "running", intakeTestTime, nil)),
	}}
	writer, cleanup := newTestWriter(t, backend)
	defer cleanup()

	err := writer.TransactPlans(context.Background(), func(transaction repository.PlanWriteTransaction) error {
		_, deleteErr := transaction.DeletePlanAggregate(context.Background(), domainplan.Delete{
			ProjectID: 4, PlanID: 8, ExpectedUpdatedAt: intakeTestTime, UpdatedAt: "2026-07-11T00:00:01.000Z",
		})
		return deleteErr
	})
	if !errors.Is(err, repository.ErrRelationConflict) {
		t.Fatalf("running aggregate delete error=%v", err)
	}
	backend.assertFinished(t, 0, 1)
}

func TestPlanContractDeleteSyncsLinkedRequirementBeforeRemovingAggregate(t *testing.T) {
	backend := &scriptBackend{steps: []scriptStep{
		queryStep("FROM plans WHERE project_id", planTestColumns(), planTestValues(8, 4, "draft", intakeTestTime, nil)),
		queryStep("SELECT COUNT(*) FROM plan_tasks", []string{"count"}, []driver.Value{int64(0)}),
		queryStep("FROM intake_plan_links AS links", []string{"project_id", "intake_type", "intake_id"},
			[]driver.Value{int64(4), "requirement", int64(6)}),
		execStep("DELETE FROM intake_plan_links", 1, 0),
		execStep("UPDATE requirements SET linked_plan_id", 1, 0),
		execStep("DELETE FROM plan_tasks", 2, 0),
		execStep("DELETE FROM plans", 1, 0),
		execStep("DELETE FROM scan_files", 1, 0),
	}}
	writer, cleanup := newTestWriter(t, backend)
	defer cleanup()

	var result domainplan.DeleteResult
	err := writer.TransactPlans(context.Background(), func(transaction repository.PlanWriteTransaction) error {
		var deleteErr error
		result, deleteErr = transaction.DeletePlanAggregate(context.Background(), domainplan.Delete{
			ProjectID: 4, PlanID: 8, ExpectedUpdatedAt: intakeTestTime, UpdatedAt: "2026-07-11T00:00:01.000Z",
		})
		return deleteErr
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.PlanID != 8 || result.DeletedTaskCount != 2 || result.DeletedScanCount != 1 ||
		len(result.LinkedIntakes) != 1 || result.LinkedIntakes[0].IntakeType != "requirement" {
		t.Fatalf("delete result=%#v", result)
	}
	backend.assertFinished(t, 1, 0)
}

func TestPlanContractConcurrentEventWritesCommitIndependently(t *testing.T) {
	metadata := `{}`
	backend := &scriptBackend{steps: []scriptStep{
		queryStep("SELECT 1 FROM projects", []string{"1"}, []driver.Value{int64(1)}),
		execStep("INSERT INTO events", 1, 1), execStep("INSERT INTO event_outbox", 1, 1),
		queryStep("SELECT 1 FROM projects", []string{"1"}, []driver.Value{int64(1)}),
		execStep("INSERT INTO events", 1, 2), execStep("INSERT INTO event_outbox", 1, 2),
	}}
	writer, cleanup := newTestWriter(t, backend)
	defer cleanup()

	errorsSeen := make(chan error, 2)
	var group sync.WaitGroup
	for index := 0; index < 2; index++ {
		index := index
		group.Add(1)
		go func() {
			defer group.Done()
			errorsSeen <- writer.TransactPlans(context.Background(), func(transaction repository.PlanWriteTransaction) error {
				return transaction.AppendEvent(context.Background(), domainevent.PendingEvent{
					EventID: "event-plan-contract-" + string(rune('a'+index)), StreamKey: "project:4", Sequence: int64(index),
					Type: "plan.accepted", RequestID: "request-plan-contract", ProjectID: 4, Message: "accepted",
					MetaJSON: &metadata, OccurredAt: intakeTestTime, CreatedAt: intakeTestTime,
				})
			})
		}()
	}
	group.Wait()
	close(errorsSeen)
	for err := range errorsSeen {
		if err != nil {
			t.Fatalf("concurrent plan event error=%v", err)
		}
	}
	backend.assertFinished(t, 2, 0)
}
