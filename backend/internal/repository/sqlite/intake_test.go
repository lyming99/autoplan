package sqlite

import (
	"context"
	"database/sql/driver"
	"errors"
	"sync"
	"testing"

	domainintake "github.com/lyming99/autoplan/backend/internal/domain/intake"
	"github.com/lyming99/autoplan/backend/internal/repository"
)

const intakeTestTime = "2026-07-11T00:00:00.000Z"

func TestNormalizeDuplicateTextPreservesLineBoundaries(t *testing.T) {
	left := domainintake.NormalizeDuplicateText("  Title\tvalue \r\n second   line  ")
	right := domainintake.NormalizeDuplicateText("Title value\nsecond line")
	if left != right {
		t.Fatalf("normalized values differ: %q != %q", left, right)
	}
	if domainintake.DuplicateEquivalent("Title", "line one\nline two", "Title", "line one line two") {
		t.Fatal("line boundaries must remain significant")
	}
}

func TestCreateRequirementChecksDuplicateInsideTransaction(t *testing.T) {
	backend := &scriptBackend{steps: []scriptStep{
		queryStep("SELECT 1 FROM projects", []string{"1"}, []driver.Value{int64(1)}),
		queryStep("COALESCE(status, 'open')", intakeTestColumns()),
		execStep("INSERT INTO requirements", 1, 2),
		queryStep("FROM requirements WHERE project_id", intakeTestColumns(),
			intakeTestValues(domainintake.Requirement, 2, 1, nil, "Synthetic requirement", "Body", "open", nil)),
	}}
	writer, cleanup := newTestWriter(t, backend)
	defer cleanup()
	var created domainintake.Intake
	err := writer.TransactIntake(context.Background(), func(transaction repository.IntakeWriteTransaction) error {
		var err error
		created, err = transaction.CreateIntake(context.Background(), domainintake.Create{
			ProjectID: 1, Type: domainintake.Requirement, Title: "Synthetic requirement",
			Body: "Body", Status: domainintake.StatusOpen, CreatedAt: intakeTestTime, UpdatedAt: intakeTestTime,
		})
		return err
	})
	if err != nil || created.ID != 2 || created.ProjectID != 1 || created.Type != domainintake.Requirement {
		t.Fatalf("created = %#v, error = %v", created, err)
	}
	backend.assertFinished(t, 1, 0)
}

func TestCreateRejectsNormalizedDuplicateWithoutWriting(t *testing.T) {
	candidate := intakeTestValues(domainintake.Requirement, 7, 1, nil,
		" Duplicate   title ", "First line\r\n second  line", "open", nil)
	backend := &scriptBackend{steps: []scriptStep{
		queryStep("SELECT 1 FROM projects", []string{"1"}, []driver.Value{int64(1)}),
		queryStep("COALESCE(status, 'open')", intakeTestColumns(), candidate),
	}}
	writer, cleanup := newTestWriter(t, backend)
	defer cleanup()
	err := writer.TransactIntake(context.Background(), func(transaction repository.IntakeWriteTransaction) error {
		_, err := transaction.CreateIntake(context.Background(), domainintake.Create{
			ProjectID: 1, Type: domainintake.Requirement, Title: "Duplicate title",
			Body: "First line\nsecond line", Status: domainintake.StatusOpen,
			CreatedAt: intakeTestTime, UpdatedAt: intakeTestTime,
		})
		return err
	})
	if !errors.Is(err, repository.ErrDuplicate) {
		t.Fatalf("duplicate error = %v", err)
	}
	backend.assertFinished(t, 0, 1)
}

func TestFeedbackAssociationRejectsCrossProjectRequirement(t *testing.T) {
	requirementID := int64(11)
	backend := &scriptBackend{steps: []scriptStep{
		queryStep("SELECT 1 FROM projects", []string{"1"}, []driver.Value{int64(1)}),
		queryStep("SELECT project_id FROM requirements", []string{"project_id"}, []driver.Value{int64(2)}),
	}}
	writer, cleanup := newTestWriter(t, backend)
	defer cleanup()
	err := writer.TransactIntake(context.Background(), func(transaction repository.IntakeWriteTransaction) error {
		_, err := transaction.CreateIntake(context.Background(), domainintake.Create{
			ProjectID: 1, Type: domainintake.Feedback, RequirementID: &requirementID,
			Title: "Feedback", Body: "Body", Status: domainintake.StatusOpen,
			CreatedAt: intakeTestTime, UpdatedAt: intakeTestTime,
		})
		return err
	})
	if !errors.Is(err, repository.ErrProjectMismatch) {
		t.Fatalf("cross-project error = %v", err)
	}
	backend.assertFinished(t, 0, 1)
}

func TestReplacePlanLinksValidatesThenSortsAndSyncsLegacy(t *testing.T) {
	backend := &scriptBackend{steps: []scriptStep{
		queryStep("FROM requirements WHERE project_id", intakeTestColumns(),
			intakeTestValues(domainintake.Requirement, 3, 1, nil, "Requirement", "Body", "open", nil)),
		queryStep("SELECT project_id FROM plans", []string{"project_id"}, []driver.Value{int64(1)}),
		queryStep("SELECT project_id FROM plans", []string{"project_id"}, []driver.Value{int64(1)}),
		queryStep("FROM intake_plan_links", planLinkTestColumns()),
		execStep("DELETE FROM intake_plan_links", 0, 0),
		execStep("INSERT INTO intake_plan_links", 1, 1),
		execStep("INSERT INTO intake_plan_links", 1, 2),
		execStep("UPDATE requirements SET linked_plan_id", 1, 0),
		queryStep("FROM intake_plan_links", planLinkTestColumns(),
			planLinkTestValues(1, 1, domainintake.Requirement, 3, 10, 1, "Discover"),
			planLinkTestValues(2, 1, domainintake.Requirement, 3, 20, 2, "Implement")),
	}}
	writer, cleanup := newTestWriter(t, backend)
	defer cleanup()
	var links []domainintake.PlanLink
	err := writer.TransactIntake(context.Background(), func(transaction repository.IntakeWriteTransaction) error {
		var err error
		links, err = transaction.ReplacePlanLinks(context.Background(), 1, domainintake.Requirement, 3,
			[]domainintake.PlanLinkInput{
				{PlanID: 20, PhaseIndex: 2, PhaseTitle: " Implement "},
				{PlanID: 10, PhaseIndex: 1, PhaseTitle: "Discover"},
			}, intakeTestTime)
		return err
	})
	if err != nil || len(links) != 2 || links[0].PlanID != 10 || links[1].PlanID != 20 {
		t.Fatalf("links = %#v, error = %v", links, err)
	}
	backend.assertFinished(t, 1, 0)
}

func TestReplacePlanLinksSameTargetIsBusinessIdempotent(t *testing.T) {
	backend := &scriptBackend{steps: []scriptStep{
		queryStep("FROM requirements WHERE project_id", intakeTestColumns(),
			intakeTestValues(domainintake.Requirement, 3, 1, nil, "Requirement", "Body", "open", intakeInt64Pointer(10))),
		queryStep("SELECT project_id FROM plans", []string{"project_id"}, []driver.Value{int64(1)}),
		queryStep("FROM intake_plan_links", planLinkTestColumns(),
			planLinkTestValues(1, 1, domainintake.Requirement, 3, 10, 1, "Discover")),
	}}
	writer, cleanup := newTestWriter(t, backend)
	defer cleanup()
	err := writer.TransactIntake(context.Background(), func(transaction repository.IntakeWriteTransaction) error {
		links, err := transaction.ReplacePlanLinks(context.Background(), 1, domainintake.Requirement, 3,
			[]domainintake.PlanLinkInput{{PlanID: 10, PhaseIndex: 1, PhaseTitle: "Discover"}},
			"2026-07-11T00:00:05.000Z")
		if err == nil && (len(links) != 1 || links[0].UpdatedAt != intakeTestTime) {
			return errors.New("idempotent replay rewrote existing link")
		}
		return err
	})
	if err != nil {
		t.Fatalf("idempotent replacement = %v", err)
	}
	backend.assertFinished(t, 1, 0)
}

func TestDeleteRequirementDetachesFeedbackAndDeletesMetadataAtomically(t *testing.T) {
	backend := &scriptBackend{steps: []scriptStep{
		queryStep("FROM requirements WHERE project_id", intakeTestColumns(),
			intakeTestValues(domainintake.Requirement, 4, 1, nil, "Requirement", "Body", "open", nil)),
		queryStep("FROM intake_plan_links", planLinkTestColumns()),
		queryStep("SELECT linked_plan_id FROM requirements", []string{"linked_plan_id"}, []driver.Value{nil}),
		queryStep("SELECT id FROM attachments", []string{"id"}, []driver.Value{int64(5)}),
		execStep("UPDATE feedback SET requirement_id = NULL", 1, 0),
		execStep("DELETE FROM intake_plan_links", 0, 0),
		execStep("DELETE FROM attachments", 1, 0),
		execStep("DELETE FROM requirements", 1, 0),
	}}
	writer, cleanup := newTestWriter(t, backend)
	defer cleanup()
	var result domainintake.DeleteResult
	err := writer.TransactIntake(context.Background(), func(transaction repository.IntakeWriteTransaction) error {
		var err error
		result, err = transaction.DeleteIntake(context.Background(), 1, domainintake.Requirement, 4, intakeTestTime)
		return err
	})
	if err != nil || result.FeedbackDetached != 1 || len(result.AttachmentIDs) != 1 || result.AttachmentIDs[0] != 5 {
		t.Fatalf("delete result = %#v, error = %v", result, err)
	}
	backend.assertFinished(t, 1, 0)
}

func TestIntakeMutationAndPendingEventRollbackTogether(t *testing.T) {
	backend := &scriptBackend{steps: []scriptStep{
		queryStep("SELECT 1 FROM projects", []string{"1"}, []driver.Value{int64(1)}),
		queryStep("COALESCE(status, 'open')", intakeTestColumns()),
		execStep("INSERT INTO requirements", 1, 8),
		queryStep("FROM requirements WHERE project_id", intakeTestColumns(),
			intakeTestValues(domainintake.Requirement, 8, 1, nil, "Requirement", "Body", "open", nil)),
		queryStep("SELECT 1 FROM projects", []string{"1"}, []driver.Value{int64(1)}),
		execStep("INSERT INTO events", 1, 22),
		execStep("INSERT INTO event_outbox", 1, 30),
	}}
	writer, cleanup := newTestWriter(t, backend)
	defer cleanup()
	writer.faults.afterWrite = func(label string) error {
		if label == "event-outbox:append-intake" {
			return errors.New("synthetic outbox failure")
		}
		return nil
	}
	err := writer.TransactIntake(context.Background(), func(transaction repository.IntakeWriteTransaction) error {
		if _, err := transaction.CreateIntake(context.Background(), domainintake.Create{
			ProjectID: 1, Type: domainintake.Requirement, Title: "Requirement", Body: "Body",
			Status: domainintake.StatusOpen, CreatedAt: intakeTestTime, UpdatedAt: intakeTestTime,
		}); err != nil {
			return err
		}
		return transaction.AppendIntakeEvent(context.Background(), domainintake.PendingEvent{
			EventID: "event-1", StreamKey: "project:1", Sequence: 1, Type: "requirement.created",
			RequestID: "request-1", ProjectID: 1, Message: "created", DataJSON: `{"intake_id":8}`,
			OccurredAt: intakeTestTime, CreatedAt: intakeTestTime,
		})
	})
	if !errors.Is(err, repository.ErrTransaction) {
		t.Fatalf("rollback error = %v", err)
	}
	backend.assertFinished(t, 0, 1)
}

func TestIntakeLinkedPlanInterruptAndResumePersistBoundedTransitions(t *testing.T) {
	for _, item := range []struct {
		name, status string
		action       repository.IntakePlanAction
		steps        []scriptStep
	}{
		{
			name: "interrupt", status: "running", action: repository.IntakePlanInterrupt,
			steps: []scriptStep{
				execStep("UPDATE plan_tasks", 2, 0),
				execStep("UPDATE plans SET status", 1, 0),
			},
		},
		{
			name: "resume", status: "interrupted", action: repository.IntakePlanResume,
			steps: []scriptStep{
				queryStep("SELECT COUNT(*) FROM plan_tasks", []string{"count"}, []driver.Value{int64(2)}),
				execStep("UPDATE plan_tasks", 2, 0),
				execStep("UPDATE plans", 1, 0),
			},
		},
	} {
		t.Run(item.name, func(t *testing.T) {
			steps := []scriptStep{
				queryStep("FROM requirements WHERE project_id", intakeTestColumns(),
					intakeTestValues(domainintake.Requirement, 4, 1, nil, "Requirement", "Body", "open", intakeInt64Pointer(8))),
				queryStep("FROM intake_plan_links", planLinkTestColumns(),
					planLinkTestValues(1, 1, domainintake.Requirement, 4, 8, 1, "Implement")),
				queryStep("FROM plans WHERE project_id", planTestColumns(), planTestValues(8, 1, item.status, intakeTestTime, nil)),
			}
			steps = append(steps, item.steps...)
			backend := &scriptBackend{steps: steps}
			writer, cleanup := newTestWriter(t, backend)
			defer cleanup()
			var result repository.IntakePlanActionResult
			err := writer.TransactIntake(context.Background(), func(transaction repository.IntakeWriteTransaction) error {
				actions := transaction.(repository.IntakePlanActions)
				var err error
				result, err = actions.ApplyIntakePlanAction(context.Background(), repository.IntakePlanActionInput{
					ProjectID: 1, Type: domainintake.Requirement, IntakeID: 4, Action: item.action,
					UpdatedAt: "2026-07-11T00:00:01.000Z",
				})
				return err
			})
			if err != nil || len(result.AffectedPlanIDs) != 1 || result.AffectedPlanIDs[0] != 8 || result.AffectedTasks != 2 {
				t.Fatalf("result=%#v error=%v", result, err)
			}
			backend.assertFinished(t, 1, 0)
		})
	}
}

func TestIntakeAppendTaskReactivatesCompletedLinkedPlan(t *testing.T) {
	backend := &scriptBackend{steps: []scriptStep{
		queryStep("FROM requirements WHERE project_id", intakeTestColumns(),
			intakeTestValues(domainintake.Requirement, 4, 1, nil, "Requirement", "Body", "open", intakeInt64Pointer(8))),
		queryStep("FROM intake_plan_links", planLinkTestColumns(),
			planLinkTestValues(1, 1, domainintake.Requirement, 4, 8, 1, "Implement")),
		queryStep("FROM plans WHERE project_id", planTestColumns(), planTestValues(8, 1, "completed", intakeTestTime, nil)),
		queryStep("FROM plans WHERE project_id", planTestColumns(), planTestValues(8, 1, "completed", intakeTestTime, nil)),
		queryStep("FROM plan_tasks JOIN plans", planTaskTestColumns()),
		execStep("INSERT INTO plan_tasks", 1, 21),
		execStep("UPDATE plans", 1, 0),
	}}
	writer, cleanup := newTestWriter(t, backend)
	defer cleanup()
	var result repository.IntakePlanActionResult
	err := writer.TransactIntake(context.Background(), func(transaction repository.IntakeWriteTransaction) error {
		actions := transaction.(repository.IntakePlanActions)
		var err error
		result, err = actions.ApplyIntakePlanAction(context.Background(), repository.IntakePlanActionInput{
			ProjectID: 1, Type: domainintake.Requirement, IntakeID: 4, Action: repository.IntakePlanAppend,
			Title: "Add regression coverage", UpdatedAt: "2026-07-11T00:00:01.000Z",
		})
		return err
	})
	if err != nil || result.PlanID != 8 || result.TaskID != 21 || result.TaskKey != "P001" || !result.Reactivated {
		t.Fatalf("result=%#v error=%v", result, err)
	}
	backend.assertFinished(t, 1, 0)
}

func TestConcurrentEquivalentCreateAllowsOneCommit(t *testing.T) {
	backend := &scriptBackend{steps: []scriptStep{
		queryStep("SELECT 1 FROM projects", []string{"1"}, []driver.Value{int64(1)}),
		queryStep("COALESCE(status, 'open')", intakeTestColumns()),
		execStep("INSERT INTO requirements", 1, 9),
		queryStep("FROM requirements WHERE project_id", intakeTestColumns(),
			intakeTestValues(domainintake.Requirement, 9, 1, nil, "Equivalent", "Body", "open", nil)),
		queryStep("SELECT 1 FROM projects", []string{"1"}, []driver.Value{int64(1)}),
		queryStep("COALESCE(status, 'open')", intakeTestColumns(),
			intakeTestValues(domainintake.Requirement, 9, 1, nil, "Equivalent", "Body", "open", nil)),
	}}
	writer, cleanup := newTestWriter(t, backend)
	defer cleanup()
	errorsSeen := make(chan error, 2)
	var group sync.WaitGroup
	for index := 0; index < 2; index++ {
		group.Add(1)
		go func() {
			defer group.Done()
			errorsSeen <- writer.TransactIntake(context.Background(), func(transaction repository.IntakeWriteTransaction) error {
				_, err := transaction.CreateIntake(context.Background(), domainintake.Create{
					ProjectID: 1, Type: domainintake.Requirement, Title: "Equivalent", Body: "Body",
					Status: domainintake.StatusOpen, CreatedAt: intakeTestTime, UpdatedAt: intakeTestTime,
				})
				return err
			})
		}()
	}
	group.Wait()
	close(errorsSeen)
	var successes, duplicates int
	for err := range errorsSeen {
		if err == nil {
			successes++
		} else if errors.Is(err, repository.ErrDuplicate) {
			duplicates++
		} else {
			t.Fatalf("unexpected concurrent error: %v", err)
		}
	}
	if successes != 1 || duplicates != 1 {
		t.Fatalf("successes=%d duplicates=%d", successes, duplicates)
	}
	backend.assertFinished(t, 1, 1)
}

func intakeTestColumns() []string {
	columns := make([]string, 31)
	for index := range columns {
		columns[index] = "column"
	}
	return columns
}

func intakeTestValues(
	intakeType domainintake.Type,
	id, projectID int64,
	requirementID *int64,
	title, body, status string,
	linkedPlanID *int64,
) []driver.Value {
	var requirementValue, linkedValue driver.Value
	if requirementID != nil {
		requirementValue = *requirementID
	}
	if linkedPlanID != nil {
		linkedValue = *linkedPlanID
	}
	return []driver.Value{
		id, projectID, requirementValue, title, body, status,
		nil, "", nil, nil, nil, "", "", nil, "", "", "", int64(0),
		int64(0), nil, nil, nil, nil, nil, nil, nil, linkedValue,
		intakeTestTime, intakeTestTime, nil, nil,
	}
}

func planLinkTestColumns() []string {
	return []string{"id", "project_id", "intake_type", "intake_id", "plan_id", "phase_index", "phase_title", "created_at", "updated_at"}
}

func planLinkTestValues(
	id, projectID int64,
	intakeType domainintake.Type,
	intakeID, planID, phaseIndex int64,
	phaseTitle string,
) []driver.Value {
	return []driver.Value{id, projectID, string(intakeType), intakeID, planID, phaseIndex, phaseTitle, intakeTestTime, intakeTestTime}
}

func planTaskTestColumns() []string {
	return []string{
		"id", "project_id", "plan_id", "task_key", "title", "raw_line", "scope", "status", "sort_order",
		"started_at", "finished_at", "duration_ms", "updated_at", "accepted_at",
	}
}

func intakeInt64Pointer(value int64) *int64 { return &value }
