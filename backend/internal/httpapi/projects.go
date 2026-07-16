package httpapi

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"

	"github.com/lyming99/autoplan/backend/internal/application"
	applicationprojects "github.com/lyming99/autoplan/backend/internal/application/projects"
	domainconfig "github.com/lyming99/autoplan/backend/internal/domain/config"
	"github.com/lyming99/autoplan/backend/internal/domain/contracts"
	domainproject "github.com/lyming99/autoplan/backend/internal/domain/project"
	"github.com/lyming99/autoplan/backend/internal/repository"
)

var maximumInt = int(^uint(0) >> 1)

const (
	ProjectsPath        = "/api/v1/projects"
	ProjectPath         = "/api/v1/projects/{project_id}"
	ProjectSnapshotPath = "/api/v1/projects/{project_id}/snapshot"

	DefaultProjectPageSize = 50
	MaximumProjectPageSize = 200
	ProjectSortUpdatedDesc = "updated_at_desc"
	ProjectSortUpdatedAsc  = "updated_at_asc"
	ProjectSortNameAsc     = "name_asc"
	ProjectSortNameDesc    = "name_desc"
	ProjectSortIDAsc       = "id_asc"
	ProjectSortIDDesc      = "id_desc"
)

type ProjectService interface {
	List(context.Context, domainproject.Visibility) ([]contracts.Project, error)
	Get(context.Context, int64, domainproject.Visibility) (contracts.Project, error)
	Snapshot(context.Context, *int64, domainproject.Visibility) (contracts.AppSnapshot, error)
	Create(context.Context, applicationprojects.CreateCommand, domainproject.Visibility) (contracts.AppSnapshot, error)
	Update(context.Context, applicationprojects.UpdateCommand, domainproject.Visibility) (contracts.AppSnapshot, error)
	Delete(context.Context, applicationprojects.DeleteCommand, domainproject.Visibility) (contracts.AppSnapshot, error)
}

var _ ProjectService = (*applicationprojects.Service)(nil)

type responseEnvelope struct {
	Data      any    `json:"data"`
	RequestID string `json:"request_id"`
}

type projectListEnvelope struct {
	Data       []contracts.Project `json:"data"`
	Pagination paginationEnvelope  `json:"pagination"`
	RequestID  string              `json:"request_id"`
}

type paginationEnvelope struct {
	Page     int  `json:"page"`
	PageSize int  `json:"page_size"`
	Total    int  `json:"total"`
	NextPage *int `json:"next_page"`
}

type projectPagination struct {
	page     int
	pageSize int
	sort     string
	filter   string
}

type createProjectRequest struct {
	Name          string  `json:"name"`
	WorkspacePath string  `json:"workspace_path"`
	Description   string  `json:"description"`

	AgentCLIProvider     *string `json:"agent_cli_provider,omitempty"`
	AgentCLICommand      *string `json:"agent_cli_command,omitempty"`
	CodexReasoningEffort *string `json:"codex_reasoning_effort,omitempty"`

	PlanGenerationStrategy             *string `json:"plan_generation_strategy,omitempty"`
	PlanGenerationProvider             *string `json:"plan_generation_provider,omitempty"`
	PlanGenerationCommand              *string `json:"plan_generation_command,omitempty"`
	PlanGenerationModel                *string `json:"plan_generation_model,omitempty"`
	PlanGenerationCodexReasoningEffort *string `json:"plan_generation_codex_reasoning_effort,omitempty"`

	PlanExecutionStrategy             *string `json:"plan_execution_strategy,omitempty"`
	PlanExecutionProvider             *string `json:"plan_execution_provider,omitempty"`
	PlanExecutionCommand              *string `json:"plan_execution_command,omitempty"`
	PlanExecutionModel                *string `json:"plan_execution_model,omitempty"`
	PlanExecutionCodexReasoningEffort *string `json:"plan_execution_codex_reasoning_effort,omitempty"`
}

func (input createProjectRequest) loopConfig() *domainconfig.LoopConfig {
	config := domainconfig.LoopConfig{}
	if input.AgentCLIProvider != nil {
		config.AgentCLIProvider = *input.AgentCLIProvider
	}
	if input.AgentCLICommand != nil {
		config.AgentCLICommand = *input.AgentCLICommand
	}
	if input.CodexReasoningEffort != nil {
		config.CodexReasoningEffort = input.CodexReasoningEffort
	}
	if input.PlanGenerationStrategy != nil {
		config.PlanGenerationStrategy = *input.PlanGenerationStrategy
	}
	if input.PlanGenerationProvider != nil {
		config.PlanGenerationProvider = input.PlanGenerationProvider
	}
	if input.PlanGenerationCommand != nil {
		config.PlanGenerationCommand = *input.PlanGenerationCommand
	}
	if input.PlanGenerationModel != nil {
		config.PlanGenerationModel = *input.PlanGenerationModel
	}
	if input.PlanGenerationCodexReasoningEffort != nil {
		config.PlanGenerationCodexReasoningEffort = input.PlanGenerationCodexReasoningEffort
	}
	if input.PlanExecutionStrategy != nil {
		config.PlanExecutionStrategy = *input.PlanExecutionStrategy
	}
	if input.PlanExecutionProvider != nil {
		config.PlanExecutionProvider = input.PlanExecutionProvider
	}
	if input.PlanExecutionCommand != nil {
		config.PlanExecutionCommand = *input.PlanExecutionCommand
	}
	if input.PlanExecutionModel != nil {
		config.PlanExecutionModel = *input.PlanExecutionModel
	}
	if input.PlanExecutionCodexReasoningEffort != nil {
		config.PlanExecutionCodexReasoningEffort = input.PlanExecutionCodexReasoningEffort
	}
	if config == (domainconfig.LoopConfig{}) {
		return nil
	}
	return &config
}

type updateProjectRequest struct {
	Name          *string `json:"name"`
	WorkspacePath *string `json:"workspace_path"`
	Description   *string `json:"description"`
}

func RegisterProjects(router *Router, security *Security, service ProjectService) error {
	if router == nil || security == nil || service == nil {
		return ErrRouterDependency
	}
	list := security.Protect(TransportREST, projectListEndpoint(service))
	project := security.Protect(TransportREST, projectEndpoint(service))
	snapshot := security.Protect(TransportREST, projectSnapshotEndpoint(service))
	create := security.Protect(TransportREST, createProjectEndpoint(service, router.BodyLimitBytes()))
	update := security.Protect(TransportREST, updateProjectEndpoint(service, router.BodyLimitBytes()))
	remove := security.Protect(TransportREST, deleteProjectEndpoint(service))
	registrations := []struct {
		method   string
		path     string
		pattern  bool
		endpoint Endpoint
	}{
		{http.MethodGet, ProjectsPath, false, list},
		{http.MethodHead, ProjectsPath, false, list},
		{http.MethodPost, ProjectsPath, false, create},
		{http.MethodGet, ProjectPath, true, project},
		{http.MethodHead, ProjectPath, true, project},
		{http.MethodPatch, ProjectPath, true, update},
		{http.MethodDelete, ProjectPath, true, remove},
		{http.MethodGet, ProjectSnapshotPath, true, snapshot},
		{http.MethodHead, ProjectSnapshotPath, true, snapshot},
	}
	for _, registration := range registrations {
		var err error
		if registration.pattern {
			err = router.HandlePattern(registration.method, registration.path, registration.endpoint)
		} else {
			err = router.Handle(registration.method, registration.path, registration.endpoint)
		}
		if err != nil {
			return err
		}
	}
	return nil
}

func projectListEndpoint(service ProjectService) Endpoint {
	return func(_ application.Boundary, writer http.ResponseWriter, request *http.Request) {
		pagination, failure := parseProjectPagination(request.URL)
		if failure != nil {
			WriteError(writer, request, *failure)
			return
		}
		projects, err := service.List(request.Context(), authorizedProjectVisibility(request))
		if err != nil {
			writeProjectServiceError(writer, request, err)
			return
		}
		projects = pagination.apply(projects)
		start, end := pagination.bounds(len(projects))
		page := make([]contracts.Project, end-start)
		copy(page, projects[start:end])
		var nextPage *int
		if end < len(projects) {
			next := pagination.page + 1
			nextPage = &next
		}
		WriteResponse(writer, request, http.StatusOK, projectListEnvelope{
			Data: page,
			Pagination: paginationEnvelope{
				Page: pagination.page, PageSize: pagination.pageSize,
				Total: len(projects), NextPage: nextPage,
			},
			RequestID: RequestID(request.Context()),
		})
	}
}

func createProjectEndpoint(service ProjectService, bodyLimit int64) Endpoint {
	return func(_ application.Boundary, writer http.ResponseWriter, request *http.Request) {
		metadata, failure := mutationRequestContext(request)
		if failure != nil {
			WriteError(writer, request, *failure)
			return
		}
		var input createProjectRequest
		if failure := DecodeJSON(writer, request, &input, bodyLimit); failure != nil {
			WriteError(writer, request, *failure)
			return
		}
		project := domainproject.Create{Name: input.Name, WorkspacePath: input.WorkspacePath, Description: input.Description}
		if domainproject.ValidateCreate(project) != nil {
			WriteError(writer, request, NewAPIError(CodeInvalidProject, nil))
			return
		}
		snapshot, err := service.Create(request.Context(), applicationprojects.CreateCommand{
			Project: project,
			Config:  input.loopConfig(),
			Metadata: applicationprojects.MutationMetadata{
				CallerScope: metadata.CallerScope, IdempotencyKey: metadata.IdempotencyKey, RequestID: metadata.RequestID,
			},
		}, authorizedProjectVisibility(request))
		if err != nil {
			writeProjectServiceError(writer, request, err)
			return
		}
		WriteResponse(writer, request, http.StatusCreated, responseEnvelope{Data: snapshot, RequestID: RequestID(request.Context())})
	}
}

func updateProjectEndpoint(service ProjectService, bodyLimit int64) Endpoint {
	return func(_ application.Boundary, writer http.ResponseWriter, request *http.Request) {
		projectID, failure := projectIDFromPath(request.URL.Path, false)
		if failure != nil {
			WriteError(writer, request, *failure)
			return
		}
		metadata, failure := mutationRequestContext(request)
		if failure != nil {
			WriteError(writer, request, *failure)
			return
		}
		var input updateProjectRequest
		if failure := DecodeJSON(writer, request, &input, bodyLimit); failure != nil {
			WriteError(writer, request, *failure)
			return
		}
		update := domainproject.Update{Name: input.Name, WorkspacePath: input.WorkspacePath, Description: input.Description}
		if !validProjectUpdate(update) {
			WriteError(writer, request, NewAPIError(CodeInvalidProject, nil))
			return
		}
		snapshot, err := service.Update(request.Context(), applicationprojects.UpdateCommand{
			ProjectID: projectID, Project: update,
			Metadata: applicationprojects.MutationMetadata{
				CallerScope: metadata.CallerScope, IdempotencyKey: metadata.IdempotencyKey, RequestID: metadata.RequestID,
			},
		}, authorizedProjectVisibility(request))
		if err != nil {
			writeProjectServiceError(writer, request, err)
			return
		}
		WriteResponse(writer, request, http.StatusOK, responseEnvelope{Data: snapshot, RequestID: RequestID(request.Context())})
	}
}

func deleteProjectEndpoint(service ProjectService) Endpoint {
	return func(_ application.Boundary, writer http.ResponseWriter, request *http.Request) {
		projectID, failure := projectIDFromPath(request.URL.Path, false)
		if failure != nil {
			WriteError(writer, request, *failure)
			return
		}
		metadata, failure := mutationRequestContext(request)
		if failure != nil {
			WriteError(writer, request, *failure)
			return
		}
		snapshot, err := service.Delete(request.Context(), applicationprojects.DeleteCommand{
			ProjectID: projectID,
			Metadata: applicationprojects.MutationMetadata{
				CallerScope: metadata.CallerScope, IdempotencyKey: metadata.IdempotencyKey, RequestID: metadata.RequestID,
			},
		}, authorizedProjectVisibility(request))
		if err != nil {
			writeProjectServiceError(writer, request, err)
			return
		}
		WriteResponse(writer, request, http.StatusOK, responseEnvelope{Data: snapshot, RequestID: RequestID(request.Context())})
	}
}

func projectEndpoint(service ProjectService) Endpoint {
	return func(_ application.Boundary, writer http.ResponseWriter, request *http.Request) {
		projectID, failure := projectIDFromPath(request.URL.Path, false)
		if failure != nil {
			WriteError(writer, request, *failure)
			return
		}
		project, err := service.Get(request.Context(), projectID, authorizedProjectVisibility(request))
		if err != nil {
			writeProjectServiceError(writer, request, err)
			return
		}
		WriteResponse(writer, request, http.StatusOK, responseEnvelope{
			Data: project, RequestID: RequestID(request.Context()),
		})
	}
}

func projectSnapshotEndpoint(service ProjectService) Endpoint {
	return func(_ application.Boundary, writer http.ResponseWriter, request *http.Request) {
		projectID, failure := projectIDFromPath(request.URL.Path, true)
		if failure != nil {
			WriteError(writer, request, *failure)
			return
		}
		snapshot, err := service.Snapshot(request.Context(), &projectID, authorizedProjectVisibility(request))
		if err != nil {
			writeProjectServiceError(writer, request, err)
			return
		}
		WriteResponse(writer, request, http.StatusOK, responseEnvelope{
			Data: snapshot, RequestID: RequestID(request.Context()),
		})
	}
}

func parseProjectPagination(location *url.URL) (projectPagination, *APIError) {
	result := projectPagination{page: 1, pageSize: DefaultProjectPageSize, sort: ProjectSortUpdatedDesc}
	if location == nil {
		failure := NewAPIError(CodeInvalidPagination, &ErrorDetails{Field: "query"})
		return result, &failure
	}
	values, err := url.ParseQuery(location.RawQuery)
	if err != nil {
		failure := NewAPIError(CodeInvalidPagination, &ErrorDetails{Field: "query"})
		return result, &failure
	}
	for name, entries := range values {
		if name != "page" && name != "page_size" && name != "sort" && name != "filter" {
			failure := NewAPIError(CodeInvalidPagination, &ErrorDetails{Field: "query"})
			return result, &failure
		}
		if len(entries) != 1 || entries[0] == "" {
			failure := NewAPIError(CodeInvalidPagination, &ErrorDetails{Field: name})
			return result, &failure
		}
	}
	if entries, exists := values["page"]; exists {
		parsed, ok := parsePositiveInt(entries[0], maximumInt)
		if !ok {
			failure := NewAPIError(CodeInvalidPagination, &ErrorDetails{Field: "page"})
			return result, &failure
		}
		result.page = parsed
	}
	if entries, exists := values["page_size"]; exists {
		parsed, ok := parsePositiveInt(entries[0], MaximumProjectPageSize)
		if !ok {
			failure := NewAPIError(CodeInvalidPagination, &ErrorDetails{Field: "page_size"})
			return result, &failure
		}
		result.pageSize = parsed
	}
	if entries, exists := values["sort"]; exists {
		if !validProjectSort(entries[0]) {
			failure := NewAPIError(CodeInvalidPagination, &ErrorDetails{Field: "sort"})
			return result, &failure
		}
		result.sort = entries[0]
	}
	if entries, exists := values["filter"]; exists {
		filter := strings.TrimSpace(entries[0])
		if filter == "" || len(filter) > 200 || strings.IndexFunc(filter, func(character rune) bool { return character < 0x20 }) >= 0 {
			failure := NewAPIError(CodeInvalidPagination, &ErrorDetails{Field: "filter"})
			return result, &failure
		}
		result.filter = strings.ToLower(filter)
	}
	if result.page-1 > maximumInt/result.pageSize {
		failure := NewAPIError(CodeInvalidPagination, &ErrorDetails{Field: "page"})
		return result, &failure
	}
	return result, nil
}

func validProjectSort(value string) bool {
	switch value {
	case ProjectSortUpdatedDesc, ProjectSortUpdatedAsc, ProjectSortNameAsc, ProjectSortNameDesc, ProjectSortIDAsc, ProjectSortIDDesc:
		return true
	default:
		return false
	}
}

func (pagination projectPagination) apply(projects []contracts.Project) []contracts.Project {
	result := make([]contracts.Project, 0, len(projects))
	for _, project := range projects {
		if pagination.filter == "" || strings.Contains(strings.ToLower(project.Name), pagination.filter) {
			result = append(result, project)
		}
	}
	sort.SliceStable(result, func(left, right int) bool {
		first, second := result[left], result[right]
		switch pagination.sort {
		case ProjectSortUpdatedAsc:
			return first.UpdatedAt < second.UpdatedAt || first.UpdatedAt == second.UpdatedAt && first.ID < second.ID
		case ProjectSortNameAsc:
			comparison := strings.Compare(strings.ToLower(first.Name), strings.ToLower(second.Name))
			return comparison < 0 || comparison == 0 && first.ID < second.ID
		case ProjectSortNameDesc:
			comparison := strings.Compare(strings.ToLower(first.Name), strings.ToLower(second.Name))
			return comparison > 0 || comparison == 0 && first.ID > second.ID
		case ProjectSortIDAsc:
			return first.ID < second.ID
		case ProjectSortIDDesc:
			return first.ID > second.ID
		default:
			return first.UpdatedAt > second.UpdatedAt || first.UpdatedAt == second.UpdatedAt && first.ID > second.ID
		}
	})
	return result
}

func parsePositiveInt(value string, maximum int) (int, bool) {
	if value == "" || strings.HasPrefix(value, "+") || (len(value) > 1 && value[0] == '0') {
		return 0, false
	}
	parsed, err := strconv.ParseUint(value, 10, 63)
	if err != nil || parsed == 0 || parsed > uint64(maximum) {
		return 0, false
	}
	return int(parsed), true
}

func (pagination projectPagination) bounds(total int) (int, int) {
	start := (pagination.page - 1) * pagination.pageSize
	if start >= total {
		return total, total
	}
	if pagination.pageSize > total-start {
		return start, total
	}
	return start, start + pagination.pageSize
}

func projectIDFromPath(path string, snapshot bool) (int64, *APIError) {
	prefix := ProjectsPath + "/"
	value := strings.TrimPrefix(path, prefix)
	if snapshot {
		value = strings.TrimSuffix(value, "/snapshot")
	}
	parsed, err := strconv.ParseInt(value, 10, 64)
	if err != nil || parsed <= 0 || strconv.FormatInt(parsed, 10) != value {
		failure := NewAPIError(CodeInvalidProjectID, &ErrorDetails{Field: "project_id"})
		return 0, &failure
	}
	return parsed, nil
}

func authorizedProjectVisibility(request *http.Request) domainproject.Visibility {
	security, valid := RequestSecurity(request.Context())
	return domainproject.Visibility{WorkspacePath: valid && security.Transport == TransportREST}
}

func writeProjectServiceError(writer http.ResponseWriter, request *http.Request, err error) {
	code := CodeInternal
	switch {
	case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded):
		code = CodeRequestTimeout
	case errors.Is(err, domainproject.ErrNotFound), errors.Is(err, repository.ErrNotFound):
		code = CodeProjectNotFound
	case errors.Is(err, domainproject.ErrInvalidRecord):
		code = CodeRepositorySchemaDrift
	case errors.Is(err, repository.ErrVersionRequired):
		code = CodeVersionRequired
	case errors.Is(err, repository.ErrVersionConflict):
		code = CodeVersionConflict
	case errors.Is(err, domainproject.ErrRunning), errors.Is(err, repository.ErrProjectRunning):
		code = CodeProjectRunning
	case errors.Is(err, domainproject.ErrRelation), errors.Is(err, repository.ErrRelationConflict):
		code = CodeRelationConflict
	case errors.Is(err, repository.ErrIdempotencyKeyReuse):
		code = CodeIdempotencyKeyReused
	case errors.Is(err, repository.ErrDuplicate):
		code = CodeRequestInProgress
	case errors.Is(err, repository.ErrTransaction), errors.Is(err, repository.ErrCommit), errors.Is(err, repository.ErrRollback):
		code = CodeRepositoryBusy
	case errors.Is(err, repository.ErrSchemaDrift):
		code = CodeRepositorySchemaDrift
	case errors.Is(err, domainproject.ErrUnavailable), errors.Is(err, repository.ErrNotConfigured),
		errors.Is(err, repository.ErrUnsafePath), errors.Is(err, repository.ErrInvalidStore),
		errors.Is(err, repository.ErrSourceChanged), errors.Is(err, repository.ErrClosed),
		errors.Is(err, repository.ErrWriterUnauthorized):
		code = CodeRepositoryUnavailable
	}
	WriteError(writer, request, NewAPIError(code, nil))
}

func validProjectUpdate(update domainproject.Update) bool {
	if update.Name == nil && update.WorkspacePath == nil && update.Description == nil {
		return false
	}
	if update.Name != nil && len(strings.TrimSpace(*update.Name)) > 200 {
		return false
	}
	if update.WorkspacePath != nil && (len(*update.WorkspacePath) > 4096 || strings.ContainsRune(*update.WorkspacePath, 0)) {
		return false
	}
	return update.Description == nil || len(*update.Description) <= 10000
}
