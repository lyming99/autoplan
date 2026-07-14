package bootstrap

import (
	"context"
	"os"
	"path/filepath"
	"strings"

	domainfiles "github.com/lyming99/autoplan/backend/internal/domain/files"
	domainterminal "github.com/lyming99/autoplan/backend/internal/domain/terminal"
	"github.com/lyming99/autoplan/backend/internal/repository"
)

// repositoryTerminalAccess is the production adapter shared by terminal
// authorization, workspace resolution and the final PTY cwd policy. It grants
// only an existing directory inside the server-side project workspace.
type repositoryTerminalAccess struct {
	getProject   func(context.Context, int64) (repository.Project, bool, error)
	listProjects func(context.Context) ([]repository.Project, error)
}

func newRepositoryTerminalAccess(writer repository.Transactional) *repositoryTerminalAccess {
	access := &repositoryTerminalAccess{}
	access.getProject = func(ctx context.Context, projectID int64) (project repository.Project, found bool, err error) {
		err = writer.Transact(ctx, func(transaction repository.WriteTransaction) error {
			project, found, err = transaction.GetProject(ctx, projectID)
			return err
		})
		return project, found, err
	}
	access.listProjects = func(ctx context.Context) (projects []repository.Project, err error) {
		err = writer.Transact(ctx, func(transaction repository.WriteTransaction) error {
			projects, err = transaction.ListProjects(ctx)
			return err
		})
		return projects, err
	}
	return access
}

func (access *repositoryTerminalAccess) ListProjects(ctx context.Context) ([]repository.Project, error) {
	if access == nil || access.listProjects == nil {
		return nil, repository.ErrNotConfigured
	}
	return access.listProjects(ctx)
}

func (access *repositoryTerminalAccess) AuthorizeTerminal(ctx context.Context, caller domainterminal.Caller, projectID int64) error {
	if access == nil || access.getProject == nil || !caller.Valid() || projectID <= 0 {
		return domainterminal.ErrForbidden
	}
	_, found, err := access.getProject(ctx, projectID)
	if err != nil || !found {
		return domainterminal.ErrForbidden
	}
	return nil
}

func (access *repositoryTerminalAccess) TerminalWorkspace(ctx context.Context, caller domainterminal.Caller, projectID int64) (string, error) {
	if err := access.AuthorizeTerminal(ctx, caller, projectID); err != nil {
		return "", err
	}
	project, found, err := access.getProject(ctx, projectID)
	if err != nil || !found || strings.TrimSpace(project.WorkspacePath) == "" {
		return "", domainterminal.ErrForbidden
	}
	return project.WorkspacePath, nil
}

func (*repositoryTerminalAccess) AuthorizeTerminalWorkingDirectory(_ context.Context, workspace, target string) (domainfiles.Decision, error) {
	workspace = strings.TrimSpace(workspace)
	target = strings.TrimSpace(target)
	if workspace == "" || target == "" {
		return domainfiles.Decision{}, domainfiles.ErrInvalidPath
	}
	workspacePath, err := filepath.EvalSymlinks(workspace)
	if err != nil {
		return domainfiles.Decision{}, domainfiles.ErrResolutionFailed
	}
	targetPath, err := filepath.EvalSymlinks(target)
	if err != nil {
		return domainfiles.Decision{}, domainfiles.ErrResolutionFailed
	}
	workspacePath, err = filepath.Abs(workspacePath)
	if err != nil {
		return domainfiles.Decision{}, domainfiles.ErrResolutionFailed
	}
	targetPath, err = filepath.Abs(targetPath)
	if err != nil {
		return domainfiles.Decision{}, domainfiles.ErrResolutionFailed
	}
	relative, err := filepath.Rel(filepath.Clean(workspacePath), filepath.Clean(targetPath))
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) || filepath.IsAbs(relative) {
		return domainfiles.Decision{}, domainfiles.ErrOutsideScope
	}
	return domainfiles.Decision{
		Allowed: true, ResolvedTarget: filepath.Clean(targetPath), DisplayPath: relative, RootLabel: "workspace",
	}, nil
}

func (access *repositoryTerminalAccess) AuthorizeWorkingDirectory(ctx context.Context, workspace, target string) (domainfiles.Decision, error) {
	return access.AuthorizeTerminalWorkingDirectory(ctx, workspace, target)
}

func (access *repositoryTerminalAccess) AuthorizeScriptSource(ctx context.Context, workspace, target string) (domainfiles.Decision, error) {
	decision, err := access.AuthorizeTerminalWorkingDirectory(ctx, workspace, target)
	if err != nil {
		return domainfiles.Decision{}, err
	}
	info, err := os.Stat(decision.ResolvedTarget)
	if err != nil {
		return domainfiles.Decision{}, domainfiles.ErrResolutionFailed
	}
	if !info.Mode().IsRegular() {
		return domainfiles.Decision{}, domainfiles.ErrInvalidPath
	}
	return decision, nil
}
