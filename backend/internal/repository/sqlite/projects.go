package sqlite

import (
	"context"
	"database/sql"
	"os"
	"sort"

	domainconfig "github.com/lyming99/autoplan/backend/internal/domain/config"
	domainproject "github.com/lyming99/autoplan/backend/internal/domain/project"
	"github.com/lyming99/autoplan/backend/internal/repository"
)

const projectSelectColumns = "id, name, workspace_path, description, created_at, updated_at"

func (reader *Reader) load(ctx context.Context, db *database) error {
	projectRows, err := db.readRows(ctx, "projects")
	if err != nil {
		return err
	}
	settingRows, err := db.readRows(ctx, "settings")
	if err != nil {
		return err
	}
	stateRows, err := db.readRows(ctx, "project_states")
	if err != nil {
		return err
	}
	projects, err := decodeProjects(projectRows)
	if err != nil {
		return err
	}
	settings, err := decodeSettings(settingRows)
	if err != nil {
		return err
	}
	states, err := decodeProjectStates(stateRows)
	if err != nil {
		return err
	}
	reader.projects = projects
	reader.settings = settings
	reader.states = states
	return nil
}

func decodeProjects(rows []tableRow) ([]repository.Project, error) {
	projects := make([]repository.Project, 0, len(rows))
	seen := make(map[int64]struct{}, len(rows))
	for _, row := range rows {
		if len(row.values) != 6 {
			return nil, repository.ErrSchemaDrift
		}
		id, ok := integerValue(row.values[0])
		if !ok || id <= 0 {
			return nil, repository.ErrSchemaDrift
		}
		if _, duplicate := seen[id]; duplicate {
			return nil, repository.ErrSchemaDrift
		}
		seen[id] = struct{}{}
		name, nameOK := textValue(row.values[1])
		workspace, workspaceOK := textValue(row.values[2])
		description, descriptionOK := textValue(row.values[3])
		createdAt, createdOK := textValue(row.values[4])
		updatedAt, updatedOK := textValue(row.values[5])
		if !nameOK || !workspaceOK || !descriptionOK || !createdOK || !updatedOK {
			return nil, repository.ErrSchemaDrift
		}
		projects = append(projects, repository.Project{
			ID: id, Name: name, WorkspacePath: workspace, Description: description,
			CreatedAt: createdAt, UpdatedAt: updatedAt,
		})
	}
	sort.SliceStable(projects, func(left, right int) bool {
		if projects[left].UpdatedAt == projects[right].UpdatedAt {
			return projects[left].ID > projects[right].ID
		}
		return projects[left].UpdatedAt > projects[right].UpdatedAt
	})
	return projects, nil
}

func (reader *Reader) ListProjects(ctx context.Context) ([]repository.Project, error) {
	reader.mu.RLock()
	defer reader.mu.RUnlock()
	if err := reader.guard(ctx); err != nil {
		return nil, err
	}
	return append([]repository.Project(nil), reader.projects...), nil
}

func (reader *Reader) GetProject(ctx context.Context, id int64) (repository.Project, bool, error) {
	reader.mu.RLock()
	defer reader.mu.RUnlock()
	if err := reader.guard(ctx); err != nil {
		return repository.Project{}, false, err
	}
	if id <= 0 {
		return repository.Project{}, false, nil
	}
	for _, project := range reader.projects {
		if project.ID == id {
			return project, true, nil
		}
	}
	return repository.Project{}, false, nil
}

func (reader *Reader) guard(ctx context.Context) error {
	if reader.closed {
		return repository.ErrClosed
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	info, err := os.Stat(reader.path)
	if err != nil || reader.info == nil || !os.SameFile(reader.info, info) || info.Size() != reader.size ||
		info.ModTime().UnixNano() != reader.modified || activeSidecar(reader.path) {
		return repository.ErrSourceChanged
	}
	return nil
}

type rowScanner interface {
	Scan(...any) error
}

func scanProject(row rowScanner) (repository.Project, error) {
	var result repository.Project
	if err := row.Scan(
		&result.ID, &result.Name, &result.WorkspacePath, &result.Description,
		&result.CreatedAt, &result.UpdatedAt,
	); err != nil {
		return repository.Project{}, err
	}
	return result, nil
}

func (transaction *writeTransaction) ListProjects(ctx context.Context) ([]repository.Project, error) {
	rows, err := transaction.tx.QueryContext(ctx,
		"SELECT "+projectSelectColumns+" FROM projects ORDER BY updated_at DESC, id DESC")
	if err != nil {
		return nil, safeSQLError(ctx, err)
	}
	defer rows.Close()
	projects := make([]repository.Project, 0)
	for rows.Next() {
		project, scanErr := scanProject(rows)
		if scanErr != nil {
			return nil, safeSQLError(ctx, scanErr)
		}
		projects = append(projects, project)
	}
	if err := rows.Err(); err != nil {
		return nil, safeSQLError(ctx, err)
	}
	return projects, nil
}

func (transaction *writeTransaction) GetProject(ctx context.Context, projectID int64) (repository.Project, bool, error) {
	if projectID <= 0 {
		return repository.Project{}, false, nil
	}
	project, err := scanProject(transaction.tx.QueryRowContext(ctx,
		"SELECT "+projectSelectColumns+" FROM projects WHERE id = ?", projectID))
	if err == sql.ErrNoRows {
		return repository.Project{}, false, nil
	}
	if err != nil {
		return repository.Project{}, false, safeSQLError(ctx, err)
	}
	return project, true, nil
}

func (transaction *writeTransaction) CreateProject(
	ctx context.Context,
	input domainproject.Create,
	updatedAt string,
) (repository.Project, repository.ProjectState, error) {
	input = domainproject.NormalizeCreate(input)
	if domainproject.ValidateCreate(input) != nil || !domainproject.ValidUTCTimestamp(updatedAt) {
		return repository.Project{}, repository.ProjectState{}, repository.ErrTransaction
	}
	result, err := transaction.tx.ExecContext(ctx,
		`INSERT INTO projects (name, workspace_path, description, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?)`,
		input.Name, input.WorkspacePath, input.Description, updatedAt, updatedAt)
	if err != nil {
		return repository.Project{}, repository.ProjectState{}, safeSQLError(ctx, err)
	}
	if err := transaction.wrote("projects:create"); err != nil {
		return repository.Project{}, repository.ProjectState{}, err
	}
	projectID, err := result.LastInsertId()
	if err != nil || projectID <= 0 {
		return repository.Project{}, repository.ProjectState{}, repository.ErrTransaction
	}
	state, err := domainconfig.DefaultProjectState(projectID, updatedAt)
	if err != nil {
		return repository.Project{}, repository.ProjectState{}, repository.ErrTransaction
	}
	if err := transaction.insertProjectState(ctx, state); err != nil {
		return repository.Project{}, repository.ProjectState{}, err
	}
	project := repository.Project{
		ID: projectID, Name: input.Name, WorkspacePath: input.WorkspacePath,
		Description: input.Description, CreatedAt: updatedAt, UpdatedAt: updatedAt,
	}
	return project, state, nil
}

func (transaction *writeTransaction) UpdateProject(
	ctx context.Context,
	projectID int64,
	update domainproject.Update,
	updatedAt string,
) (repository.Project, error) {
	current, found, err := transaction.GetProject(ctx, projectID)
	if err != nil {
		return repository.Project{}, err
	}
	if !found {
		return repository.Project{}, repository.ErrNotFound
	}
	next, err := domainproject.ApplyUpdate(current, update)
	if err != nil || !domainproject.ValidUTCTimestamp(updatedAt) {
		return repository.Project{}, repository.ErrTransaction
	}
	next.UpdatedAt = updatedAt
	if domainproject.ValidateRecord(next) != nil {
		return repository.Project{}, repository.ErrTransaction
	}
	result, err := transaction.tx.ExecContext(ctx,
		`UPDATE projects SET name = ?, workspace_path = ?, description = ?, updated_at = ? WHERE id = ?`,
		next.Name, next.WorkspacePath, next.Description, updatedAt, projectID)
	if err != nil {
		return repository.Project{}, safeSQLError(ctx, err)
	}
	if err := requireOneRow(result); err != nil {
		return repository.Project{}, err
	}
	if err := transaction.wrote("projects:update"); err != nil {
		return repository.Project{}, err
	}
	return next, nil
}

func (transaction *writeTransaction) DeleteProject(ctx context.Context, projectID int64) error {
	if projectID <= 0 {
		return repository.ErrNotFound
	}
	var running int64
	if err := transaction.tx.QueryRowContext(ctx,
		`SELECT project_states.running
		   FROM projects LEFT JOIN project_states ON project_states.project_id = projects.id
		  WHERE projects.id = ?`, projectID).Scan(&running); err == sql.ErrNoRows {
		return repository.ErrNotFound
	} else if err != nil {
		return safeSQLError(ctx, err)
	}
	if running != 0 {
		return repository.ErrProjectRunning
	}
	blocked, err := transaction.hasActiveDeleteBlocker(ctx, projectID)
	if err != nil {
		return err
	}
	if blocked {
		return repository.ErrRelationConflict
	}

	// FK RESTRICT relations are deleted explicitly in child-first order.
	// Project deletion is a user-requested aggregate deletion: historical
	// operations, automation, configuration and outbox rows belong to that
	// aggregate and must not turn into permanent relation blockers.
	for _, statement := range []struct {
		label string
		query string
	}{
		{"event_outbox:delete-project", "DELETE FROM event_outbox WHERE project_id = ? OR operation_id IN (SELECT operation_id FROM operations WHERE project_id = ?1)"},
		{"operations:delete-project", "DELETE FROM operations WHERE project_id = ?"},
		{"event_retention_watermarks:delete-project", "DELETE FROM event_retention_watermarks WHERE project_id = ?"},
		{"project_revisions:delete-project", "DELETE FROM project_revisions WHERE project_id = ?"},
		{"attachments:delete-project", "DELETE FROM attachments WHERE project_id = ?"},
		{"intake_plan_links:delete-project", "DELETE FROM intake_plan_links WHERE project_id = ?"},
		{"feedback:delete-project", "DELETE FROM feedback WHERE project_id = ?"},
		{"requirements:delete-project", "DELETE FROM requirements WHERE project_id = ?"},
		{"plans:delete-project", "DELETE FROM plans WHERE project_id = ?"},
		{"scripts:delete-project", "DELETE FROM scripts WHERE project_id = ?"},
		{"executors:delete-project", "DELETE FROM executors WHERE project_id = ?"},
		{"ai_configs:delete-project", "DELETE FROM ai_configs WHERE project_id = ?"},
		{"claude_cli_configs:delete-project", "DELETE FROM claude_cli_configs WHERE project_id = ?"},
	} {
		if _, err := transaction.tx.ExecContext(ctx, statement.query, projectID); err != nil {
			return safeSQLError(ctx, err)
		}
		if err := transaction.wrote(statement.label); err != nil {
			return err
		}
	}
	if _, err := transaction.tx.ExecContext(ctx,
		`DELETE FROM secret_refs
		  WHERE owner_type IN ('project', 'project_state', 'loop_config') AND owner_id = ?`,
		projectOwnerID(projectID)); err != nil {
		return safeSQLError(ctx, err)
	}
	if err := transaction.wrote("secret_refs:delete-project"); err != nil {
		return err
	}
	result, err := transaction.tx.ExecContext(ctx, "DELETE FROM projects WHERE id = ?", projectID)
	if err != nil {
		return safeSQLError(ctx, err)
	}
	if err := requireOneRow(result); err != nil {
		return err
	}
	return transaction.wrote("projects:delete")
}

func (transaction *writeTransaction) hasActiveDeleteBlocker(ctx context.Context, projectID int64) (bool, error) {
	var count int64
	if err := transaction.tx.QueryRowContext(ctx,
		"SELECT COUNT(*) FROM operations WHERE project_id = ? AND status IN ('queued', 'running')",
		projectID,
	).Scan(&count); err != nil {
		return false, safeSQLError(ctx, err)
	}
	return count != 0, nil
}

func requireOneRow(result sql.Result) error {
	count, err := result.RowsAffected()
	if err != nil {
		return repository.ErrTransaction
	}
	if count != 1 {
		return repository.ErrNotFound
	}
	return nil
}

func projectOwnerID(projectID int64) string {
	// Decimal conversion is deliberately local and never enters an error.
	return fmtInt64(projectID)
}

func fmtInt64(value int64) string {
	if value == 0 {
		return "0"
	}
	negative := value < 0
	if negative {
		value = -value
	}
	buffer := [20]byte{}
	position := len(buffer)
	for value > 0 {
		position--
		buffer[position] = byte('0' + value%10)
		value /= 10
	}
	if negative {
		position--
		buffer[position] = '-'
	}
	return string(buffer[position:])
}
