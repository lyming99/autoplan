package plans

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestReadWorkspacePlanAllowsBoundedUTF8File(t *testing.T) {
	workspace := t.TempDir()
	path := filepath.Join(workspace, "docs", "plan", "fixture.md")
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	const expected = "# 计划\n\n- [ ] P001: 实现功能\n"
	if err := os.WriteFile(path, []byte(expected), 0o600); err != nil {
		t.Fatal(err)
	}
	markdown, code, err := readWorkspacePlan(workspace, "docs/plan/fixture.md")
	if err != nil || code != "" || markdown != expected {
		t.Fatalf("markdown=%q code=%q err=%v", markdown, code, err)
	}
}

func TestReadWorkspacePlanRejectsTraversalAndReportsMissingFileSafely(t *testing.T) {
	workspace := t.TempDir()
	if _, _, err := readWorkspacePlan(workspace, "../private.md"); !errors.Is(err, ErrUnsafeContent) {
		t.Fatalf("traversal error=%v", err)
	}
	markdown, code, err := readWorkspacePlan(workspace, "docs/plan/missing.md")
	if err != nil || markdown != "" || code != "file_not_found" {
		t.Fatalf("markdown=%q code=%q err=%v", markdown, code, err)
	}
}

func TestReadWorkspacePlanRejectsSymlinkEscape(t *testing.T) {
	workspace := t.TempDir()
	outside := t.TempDir()
	outsideFile := filepath.Join(outside, "private.md")
	if err := os.WriteFile(outsideFile, []byte("private"), 0o600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(workspace, "escape.md")
	if err := os.Symlink(outsideFile, link); err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "privilege") || os.IsPermission(err) {
			t.Skip("symlink creation is unavailable on this Windows host")
		}
		t.Fatal(err)
	}
	if _, _, err := readWorkspacePlan(workspace, "escape.md"); !errors.Is(err, ErrUnsafeContent) {
		t.Fatalf("symlink escape error=%v", err)
	}
}
