package sqlite

import (
	"context"
	"database/sql/driver"
	"errors"
	"testing"

	domainplan "github.com/lyming99/autoplan/backend/internal/domain/plan"
	"github.com/lyming99/autoplan/backend/internal/repository"
)

const planStopUpdatedAt = "2026-07-15T00:00:05.000Z"

func TestStopPlanAtomicallyInterruptsPlanAndBlocksUnfinishedTasks(t *testing.T) {
	currentPlan := planTestValues(11, 7, "running", intakeTestTime, nil)
	stoppedPlan := planTestValues(11, 7, "interrupted", planStopUpdatedAt, nil)
	backend := &scriptBackend{steps: []scriptStep{
		queryStep("FROM plans WHERE project_id", planTestColumns(), currentPlan),
		queryStep("FROM plans WHERE project_id", planTestColumns(), currentPlan),
		queryStep("FROM plan_tasks JOIN plans", planTaskTestColumns(),
			planStopTaskValues(12, "running", intakeTestTime),
			planStopTaskValues(13, "pending", intakeTestTime),
			planStopTaskValues(14, "completed", intakeTestTime)),
		execStep("UPDATE plan_tasks", 2, 0),
		execStep("UPDATE plans", 1, 0),
		queryStep("FROM plans WHERE project_id", planTestColumns(), stoppedPlan),
		queryStep("FROM plans WHERE project_id", planTestColumns(), stoppedPlan),
		queryStep("FROM plan_tasks JOIN plans", planTaskTestColumns(),
			planStopTaskValues(12, "blocked", planStopUpdatedAt),
			planStopTaskValues(13, "blocked", planStopUpdatedAt),
			planStopTaskValues(14, "completed", intakeTestTime)),
	}}
	writer, cleanup := newTestWriter(t, backend)
	defer cleanup()

	var stopped domainplan.PlanStopResult
	err := writer.TransactPlans(context.Background(), func(transaction repository.PlanWriteTransaction) error {
		var stopErr error
		stopped, stopErr = transaction.StopPlan(context.Background(), domainplan.PlanStop{
			ProjectID: 7, PlanID: 11, UpdatedAt: planStopUpdatedAt,
		})
		return stopErr
	})
	if err != nil || stopped.Plan.Status != domainplan.StatusInterrupted || len(stopped.AffectedTasks) != 2 {
		t.Fatalf("stop=%#v error=%v", stopped, err)
	}
	for _, task := range stopped.AffectedTasks {
		if task.Status != domainplan.TaskBlocked || task.ProjectID != 7 || task.PlanID != 11 {
			t.Fatalf("affected task=%#v", task)
		}
	}
	backend.assertFinished(t, 1, 0)
}

func TestStopPlanRejectsMissingCrossProjectAndInactiveTargetsBeforeWrites(t *testing.T) {
	tests := []struct {
		name  string
		steps []scriptStep
		want  error
	}{
		{
			name:  "missing or cross-project",
			steps: []scriptStep{queryStep("FROM plans WHERE project_id", planTestColumns())},
			want:  repository.ErrNotFound,
		},
		{
			name: "inactive",
			steps: []scriptStep{
				queryStep("FROM plans WHERE project_id", planTestColumns(), planTestValues(11, 7, "pending", intakeTestTime, nil)),
				queryStep("FROM plans WHERE project_id", planTestColumns(), planTestValues(11, 7, "pending", intakeTestTime, nil)),
				queryStep("FROM plan_tasks JOIN plans", planTaskTestColumns(), planStopTaskValues(13, "pending", intakeTestTime)),
			},
			want: repository.ErrInvalidPlan,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			backend := &scriptBackend{steps: test.steps}
			writer, cleanup := newTestWriter(t, backend)
			defer cleanup()
			err := writer.TransactPlans(context.Background(), func(transaction repository.PlanWriteTransaction) error {
				_, stopErr := transaction.StopPlan(context.Background(), domainplan.PlanStop{
					ProjectID: 7, PlanID: 11, UpdatedAt: planStopUpdatedAt,
				})
				return stopErr
			})
			if !errors.Is(err, test.want) {
				t.Fatalf("error=%v want=%v", err, test.want)
			}
			backend.assertFinished(t, 0, 1)
		})
	}
}

func TestStopPlanRollsBackTaskWriteWhenPlanWriteFails(t *testing.T) {
	currentPlan := planTestValues(11, 7, "running", intakeTestTime, nil)
	backend := &scriptBackend{steps: []scriptStep{
		queryStep("FROM plans WHERE project_id", planTestColumns(), currentPlan),
		queryStep("FROM plans WHERE project_id", planTestColumns(), currentPlan),
		queryStep("FROM plan_tasks JOIN plans", planTaskTestColumns(), planStopTaskValues(12, "running", intakeTestTime)),
		execStep("UPDATE plan_tasks", 1, 0),
	}}
	writer, cleanup := newTestWriter(t, backend)
	defer cleanup()
	writer.faults.afterWrite = func(label string) error {
		if label == "plan-stop:tasks" {
			return errors.New("injected failure")
		}
		return nil
	}

	err := writer.TransactPlans(context.Background(), func(transaction repository.PlanWriteTransaction) error {
		_, stopErr := transaction.StopPlan(context.Background(), domainplan.PlanStop{
			ProjectID: 7, PlanID: 11, UpdatedAt: planStopUpdatedAt,
		})
		return stopErr
	})
	if !errors.Is(err, repository.ErrTransaction) {
		t.Fatalf("error=%v", err)
	}
	backend.assertFinished(t, 0, 1)
}

func planStopTaskValues(id int64, status, updatedAt string) []driver.Value {
	return []driver.Value{
		id, int64(7), int64(11), "P001", "task", "- [ ] task", "", status, id - 11,
		nil, nil, int64(0), updatedAt, nil,
	}
}
