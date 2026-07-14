package bootstrap

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	domainterminal "github.com/lyming99/autoplan/backend/internal/domain/terminal"
	"github.com/lyming99/autoplan/backend/internal/repository"
)

type terminalProjectsFixture struct{ project repository.Project }

func (fixture terminalProjectsFixture) ListProjects(context.Context) ([]repository.Project, error) {
	return []repository.Project{fixture.project}, nil
}
func (fixture terminalProjectsFixture) GetProject(_ context.Context, id int64) (repository.Project, bool, error) {
	return fixture.project, fixture.project.ID == id, nil
}

func TestRepositoryTerminalAccessUsesServerProjectAndBoundsCWD(t *testing.T) {
	workspace := t.TempDir()
	child := filepath.Join(workspace, "child")
	if err := os.Mkdir(child, 0o700); err != nil {
		t.Fatal(err)
	}
	script := filepath.Join(child, "fixture.js")
	if err := os.WriteFile(script, []byte("process.exit(0)"), 0o600); err != nil {
		t.Fatal(err)
	}
	fixture := terminalProjectsFixture{project: repository.Project{
		ID: 7, Name: "fixture", WorkspacePath: workspace,
		CreatedAt: "2026-07-14T00:00:00.000Z", UpdatedAt: "2026-07-14T00:00:00.000Z",
	}}
	access := &repositoryTerminalAccess{getProject: fixture.GetProject}
	caller := domainterminal.Caller{ID: "renderer"}
	if err := access.AuthorizeTerminal(context.Background(), caller, 7); err != nil {
		t.Fatalf("authorize: %v", err)
	}
	resolved, err := access.TerminalWorkspace(context.Background(), caller, 7)
	if err != nil || resolved != workspace {
		t.Fatalf("workspace=%q err=%v", resolved, err)
	}
	decision, err := access.AuthorizeTerminalWorkingDirectory(context.Background(), workspace, child)
	if err != nil || !decision.Allowed || decision.ResolvedTarget != child {
		t.Fatalf("decision=%#v err=%v", decision, err)
	}
	if _, err := access.AuthorizeTerminalWorkingDirectory(context.Background(), workspace, t.TempDir()); err == nil {
		t.Fatal("outside working directory was accepted")
	}
	scriptDecision, err := access.AuthorizeScriptSource(context.Background(), workspace, script)
	if err != nil || !scriptDecision.Allowed || scriptDecision.ResolvedTarget != script {
		t.Fatalf("script decision=%#v err=%v", scriptDecision, err)
	}
	if _, err := access.AuthorizeScriptSource(context.Background(), workspace, child); err == nil {
		t.Fatal("directory was accepted as script source")
	}
	if err := access.AuthorizeTerminal(context.Background(), caller, 8); err == nil {
		t.Fatal("unknown project was accepted")
	}
}
