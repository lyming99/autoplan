package plans

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	domainplan "github.com/lyming99/autoplan/backend/internal/domain/plan"
)

func TestExtractMarkdownTitlePrefersLevelOneAndCleansClosingSequence(t *testing.T) {
	markdown := "## Earlier heading\n\n```md\n# Not the title\n```\n\n#  Internal   Plan Title  ###\n"
	if title := extractMarkdownTitle(markdown); title != "Internal Plan Title" {
		t.Fatalf("title=%q", title)
	}
}

func TestExtractMarkdownTitleUsesFirstLegalHeadingWithoutLevelOne(t *testing.T) {
	markdown := "not a heading\n# ###\n####### invalid\n## First C#\n### Later\n"
	if title := extractMarkdownTitle(markdown); title != "First C#" {
		t.Fatalf("title=%q", title)
	}
}

func TestResolvePlanTitleReadsSafelyAndFallsBack(t *testing.T) {
	workspace := t.TempDir()
	path := filepath.Join(workspace, "docs", "plan", "different-name.md")
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("# Display title\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	plan := domainplan.Plan{ID: 42, SourceRef: "docs/plan/different-name.md"}
	if title := ResolvePlanTitle(workspace, plan); title != "Display title" {
		t.Fatalf("title=%q", title)
	}

	for name, sourceRef := range map[string]string{
		"missing": "docs/plan/missing.md",
		"unsafe":  "../outside.md",
	} {
		t.Run(name, func(t *testing.T) {
			plan.SourceRef = sourceRef
			if title := ResolvePlanTitle(workspace, plan); title != "Plan #42" {
				t.Fatalf("title=%q", title)
			}
		})
	}
}

func TestResolvePlanTitleFallsBackForUnreadableMarkdown(t *testing.T) {
	workspace := t.TempDir()
	plan := domainplan.Plan{ID: 9}
	tests := []struct {
		name    string
		content []byte
	}{
		{name: "no heading", content: []byte("plain text\n")},
		{name: "invalid encoding", content: []byte{0xff, 0xfe}},
		{name: "too large", content: []byte(strings.Repeat("x", int(MaximumPlanMarkdownBytes)+1))},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			path := filepath.Join(workspace, strings.ReplaceAll(test.name, " ", "-")+".md")
			if err := os.WriteFile(path, test.content, 0o600); err != nil {
				t.Fatal(err)
			}
			plan.SourceRef = filepath.Base(path)
			if title := ResolvePlanTitle(workspace, plan); title != "Plan #9" {
				t.Fatalf("title=%q", title)
			}
		})
	}
}

func TestProjectionTitleOverridesPropagateWithoutChangingFilePath(t *testing.T) {
	plan := domainplan.Plan{ID: 7, SourceRef: "docs/plan/file-name.md"}
	dto := PlanDTOFromDomain(plan, "  Display   title  ")
	if dto.Title != "Display title" || dto.FilePath != plan.SourceRef {
		t.Fatalf("dto=%#v", dto)
	}

	planSnapshot, err := PlanSnapshot(plan, "Display title")
	if err != nil {
		t.Fatal(err)
	}
	taskSnapshot, err := TaskSnapshot(domainplan.Task{ID: 3, PlanID: 7}, plan, "Display title")
	if err != nil {
		t.Fatal(err)
	}
	var planTitle, taskPlanTitle, filePath string
	if err := json.Unmarshal(planSnapshot["title"], &planTitle); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(taskSnapshot["plan_title"], &taskPlanTitle); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(taskSnapshot["file_path"], &filePath); err != nil {
		t.Fatal(err)
	}
	if planTitle != "Display title" || taskPlanTitle != planTitle || filePath != plan.SourceRef {
		t.Fatalf("plan title=%q task plan title=%q file_path=%q", planTitle, taskPlanTitle, filePath)
	}
}
