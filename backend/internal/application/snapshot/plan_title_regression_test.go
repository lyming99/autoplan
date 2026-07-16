package snapshot

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/lyming99/autoplan/backend/internal/domain/contracts"
	domainevent "github.com/lyming99/autoplan/backend/internal/domain/event"
	domainintake "github.com/lyming99/autoplan/backend/internal/domain/intake"
	domainplan "github.com/lyming99/autoplan/backend/internal/domain/plan"
)

type planTitleRegressionStore struct {
	plans []domainplan.Plan
	tasks map[int64][]domainplan.Task
}

func (store planTitleRegressionStore) ListPlans(_ context.Context, options domainplan.ListOptions) ([]domainplan.Plan, error) {
	if options.Offset >= len(store.plans) {
		return nil, nil
	}
	end := options.Offset + options.Limit
	if end > len(store.plans) {
		end = len(store.plans)
	}
	return append([]domainplan.Plan(nil), store.plans[options.Offset:end]...), nil
}

func (store planTitleRegressionStore) GetPlan(_ context.Context, projectID, planID int64) (domainplan.Plan, bool, error) {
	for _, plan := range store.plans {
		if plan.ProjectID == projectID && plan.ID == planID {
			return plan, true, nil
		}
	}
	return domainplan.Plan{}, false, nil
}

func (store planTitleRegressionStore) ListPlanTasks(_ context.Context, projectID, planID int64) ([]domainplan.Task, error) {
	result := make([]domainplan.Task, 0, len(store.tasks[planID]))
	for _, task := range store.tasks[planID] {
		if task.ProjectID == projectID {
			result = append(result, task)
		}
	}
	return result, nil
}

func (store planTitleRegressionStore) GetPlanTask(_ context.Context, projectID, planID, taskID int64) (domainplan.Task, bool, error) {
	for _, task := range store.tasks[planID] {
		if task.ProjectID == projectID && task.ID == taskID {
			return task, true, nil
		}
	}
	return domainplan.Task{}, false, nil
}

func (planTitleRegressionStore) ListEvents(context.Context, domainevent.ListOptions) ([]domainevent.Event, error) {
	return nil, nil
}

func TestPlanTitleDisplayChainKeepsFilePathAsPathOnly(t *testing.T) {
	workspace := t.TempDir()
	fixtures := []struct {
		id       int64
		filePath string
		markdown string
		title    string
	}{
		{1, "docs/plan/generated-file-name.md", "## Earlier secondary heading\n\n# Level One Wins\n", "Level One Wins"},
		{2, "docs/plan/secondary-only.md", "plain text\n\n### Secondary Heading\n", "Secondary Heading"},
		{3, "docs/plan/closing-hashes.md", "# Release C# ###\n", "Release C#"},
	}

	store := planTitleRegressionStore{tasks: make(map[int64][]domainplan.Task)}
	for _, fixture := range fixtures {
		absolutePath := filepath.Join(workspace, filepath.FromSlash(fixture.filePath))
		if err := os.MkdirAll(filepath.Dir(absolutePath), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(absolutePath, []byte(fixture.markdown), 0o600); err != nil {
			t.Fatal(err)
		}
		store.plans = append(store.plans, domainplan.Plan{
			ID: fixture.id, ProjectID: 7, SourceRef: fixture.filePath,
			Status: domainplan.StatusCompleted, SortOrder: fixture.id,
		})
		store.tasks[fixture.id] = []domainplan.Task{{
			ID: fixture.id * 10, ProjectID: 7, PlanID: fixture.id,
			Title: "Task", Status: domainplan.TaskPending, SortOrder: 1,
		}}
	}

	plansByID, planTitles, planRows, taskRows, _, err := planSnapshotRows(context.Background(), store, 7, workspace)
	if err != nil {
		t.Fatal(err)
	}
	if len(planRows) != len(fixtures) || len(taskRows) != len(fixtures) {
		t.Fatalf("projection counts: plans=%d tasks=%d", len(planRows), len(taskRows))
	}
	for index, fixture := range fixtures {
		assertSnapshotString(t, planRows[index], "title", fixture.title)
		assertSnapshotString(t, planRows[index], "file_path", fixture.filePath)
		assertSnapshotString(t, taskRows[index], "plan_title", fixture.title)
		assertSnapshotString(t, taskRows[index], "file_path", fixture.filePath)
	}

	linkedPlanID := int64(1)
	for _, intakeType := range []domainintake.Type{domainintake.Requirement, domainintake.Feedback} {
		t.Run(string(intakeType), func(t *testing.T) {
			intake := domainintake.Intake{
				ID: 21, ProjectID: 7, Type: intakeType, Title: "Intake",
				Status: domainintake.StatusOpen, LinkedPlanID: &linkedPlanID,
				CreatedAt: "2026-07-15T00:00:00.000Z", UpdatedAt: "2026-07-15T00:00:00.000Z",
			}
			links := make([]domainintake.PlanLink, 0, len(fixtures))
			for index, fixture := range fixtures {
				links = append(links, domainintake.PlanLink{
					ID: int64(index + 1), ProjectID: 7, IntakeType: intakeType,
					IntakeID: intake.ID, PlanID: fixture.id, PhaseIndex: int64(index + 1),
				})
			}
			intakeRow, mapErr := intakeSnapshot(intake, links, plansByID, planTitles)
			if mapErr != nil {
				t.Fatal(mapErr)
			}
			assertSnapshotString(t, intakeRow, "plan_title", fixtures[0].title)
			assertSnapshotString(t, intakeRow, "linked_plan_title", fixtures[0].title)

			var linkedRows []map[string]any
			if err := json.Unmarshal(intakeRow["linked_plans"], &linkedRows); err != nil {
				t.Fatal(err)
			}
			if len(linkedRows) != len(fixtures) {
				t.Fatalf("linked_plans count=%d", len(linkedRows))
			}
			for index, fixture := range fixtures {
				if linkedRows[index]["title"] != fixture.title || linkedRows[index]["file_path"] != fixture.filePath {
					t.Fatalf("linked_plans[%d]=%#v", index, linkedRows[index])
				}
			}
		})
	}
}

func assertSnapshotString(t *testing.T, object contracts.SanitizedObject, field, expected string) {
	t.Helper()
	var actual string
	if err := json.Unmarshal(object[field], &actual); err != nil {
		t.Fatalf("%s is not a string: %v", field, err)
	}
	if actual != expected {
		t.Fatalf("%s=%q want=%q", field, actual, expected)
	}
}
