package plans

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf8"

	domainplan "github.com/lyming99/autoplan/backend/internal/domain/plan"
	"github.com/lyming99/autoplan/backend/internal/repository"
)

const MaximumPlanMarkdownBytes int64 = 2 << 20

var ErrUnsafeContent = errors.New("plan content path is unsafe")

type ContentDTO struct {
	Plan      PlanDTO   `json:"plan"`
	Tasks     []TaskDTO `json:"tasks"`
	Markdown  string    `json:"markdown"`
	ErrorCode string    `json:"error_code,omitempty"`
}

// ReadContent resolves the stored project-scoped plan reference beneath the
// authorized workspace. The filesystem read happens only after both project
// and plan ownership are loaded in one bounded repository transaction.
func (service *Service) ReadContent(ctx context.Context, projectID, planID int64) (ContentDTO, error) {
	if err := service.ready(ctx); err != nil {
		return ContentDTO{}, err
	}
	if projectID <= 0 || planID <= 0 {
		return ContentDTO{}, ErrInvalidCommand
	}
	var project repository.Project
	var plan domainplan.Plan
	var tasks []domainplan.Task
	err := service.writer.TransactPlans(ctx, func(transaction repository.PlanWriteTransaction) error {
		var found bool
		var loadErr error
		project, found, loadErr = transaction.GetProject(ctx, projectID)
		if loadErr != nil {
			return loadErr
		}
		if !found {
			return repository.ErrNotFound
		}
		plan, found, loadErr = transaction.GetPlan(ctx, projectID, planID)
		if loadErr != nil {
			return loadErr
		}
		if !found {
			return repository.ErrNotFound
		}
		tasks, loadErr = transaction.ListPlanTasks(ctx, projectID, planID)
		return loadErr
	})
	if err != nil {
		return ContentDTO{}, err
	}
	planValue := planDTO(plan)
	result := ContentDTO{Plan: planValue, Tasks: make([]TaskDTO, 0, len(tasks))}
	for _, task := range tasks {
		result.Tasks = append(result.Tasks, taskDTO(task, planValue))
	}
	markdown, code, readErr := readWorkspacePlan(project.WorkspacePath, plan.SourceRef)
	if readErr != nil {
		return ContentDTO{}, readErr
	}
	result.Markdown, result.ErrorCode = markdown, code
	return result, nil
}

func readWorkspacePlan(workspace, sourceRef string) (string, string, error) {
	workspace = strings.TrimSpace(workspace)
	sourceRef = strings.TrimSpace(sourceRef)
	if workspace == "" {
		return "", "workspace_unavailable", nil
	}
	if sourceRef == "" {
		return "", "file_path_empty", nil
	}
	normalized := filepath.FromSlash(strings.ReplaceAll(sourceRef, `\`, "/"))
	cleaned := filepath.Clean(normalized)
	if cleaned == "." || filepath.IsAbs(cleaned) || filepath.VolumeName(cleaned) != "" ||
		cleaned == ".." || strings.HasPrefix(cleaned, ".."+string(filepath.Separator)) || strings.ContainsRune(cleaned, 0) {
		return "", "", ErrUnsafeContent
	}
	root, err := filepath.EvalSymlinks(workspace)
	if err != nil {
		return "", "workspace_unavailable", nil
	}
	target, err := filepath.EvalSymlinks(filepath.Join(root, cleaned))
	if err != nil {
		if os.IsNotExist(err) {
			return "", "file_not_found", nil
		}
		return "", "read_failed", nil
	}
	relative, err := filepath.Rel(root, target)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) || filepath.IsAbs(relative) {
		return "", "", ErrUnsafeContent
	}
	file, err := os.Open(target)
	if err != nil {
		if os.IsNotExist(err) {
			return "", "file_not_found", nil
		}
		return "", "read_failed", nil
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return "", "read_failed", nil
	}
	if info.Size() > MaximumPlanMarkdownBytes {
		return "", "file_too_large", nil
	}
	content, err := io.ReadAll(io.LimitReader(file, MaximumPlanMarkdownBytes+1))
	if err != nil {
		return "", "read_failed", nil
	}
	if int64(len(content)) > MaximumPlanMarkdownBytes {
		return "", "file_too_large", nil
	}
	if !utf8.Valid(content) {
		return "", "invalid_encoding", nil
	}
	return string(content), "", nil
}
