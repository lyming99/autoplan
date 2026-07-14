package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"github.com/lyming99/autoplan/backend/internal/application"
	applicationintake "github.com/lyming99/autoplan/backend/internal/application/intake"
	domainintake "github.com/lyming99/autoplan/backend/internal/domain/intake"
	domainproject "github.com/lyming99/autoplan/backend/internal/domain/project"
	"github.com/lyming99/autoplan/backend/internal/repository"
)

const (
	RequirementsPath           = "/api/v1/projects/{project_id}/requirements"
	RequirementPath            = "/api/v1/projects/{project_id}/requirements/{intake_id}"
	RequirementAcceptancePath  = RequirementPath + "/accept"
	RequirementPlanLinksPath   = RequirementPath + "/plan-links"
	RequirementAttachmentsPath = RequirementPath + "/attachments"
	FeedbackPath               = "/api/v1/projects/{project_id}/feedback"
	FeedbackItemPath           = "/api/v1/projects/{project_id}/feedback/{intake_id}"
	FeedbackAcceptancePath     = FeedbackItemPath + "/accept"
	FeedbackPlanLinksPath      = FeedbackItemPath + "/plan-links"
	FeedbackAttachmentsPath    = FeedbackItemPath + "/attachments"
	DefaultIntakePageSize      = 50
	MaximumIntakePageSize      = 200
)

type IntakeService interface {
	List(context.Context, applicationintake.ListQuery) ([]applicationintake.IntakeDTO, error)
	Get(context.Context, int64, domainintake.Type, int64) (applicationintake.IntakeDTO, error)
	Create(context.Context, applicationintake.CreateCommand, domainproject.Visibility) (applicationintake.MutationResult, error)
	Update(context.Context, applicationintake.UpdateCommand, domainproject.Visibility) (applicationintake.MutationResult, error)
	SetAcceptance(context.Context, applicationintake.AcceptanceCommand, domainproject.Visibility) (applicationintake.MutationResult, error)
	RetryPlanGeneration(context.Context, applicationintake.RetryPlanGenerationCommand, domainproject.Visibility) (applicationintake.MutationResult, error)
	InterruptPlans(context.Context, applicationintake.PlanActionCommand, domainproject.Visibility) (applicationintake.MutationResult, error)
	ResumePlans(context.Context, applicationintake.PlanActionCommand, domainproject.Visibility) (applicationintake.MutationResult, error)
	AppendTask(context.Context, applicationintake.PlanActionCommand, domainproject.Visibility) (applicationintake.MutationResult, error)
	Links(context.Context, int64, domainintake.Type, int64) ([]applicationintake.LinkedPlanDTO, error)
	ReplaceLinks(context.Context, applicationintake.ReplaceLinksCommand, domainproject.Visibility) (applicationintake.MutationResult, error)
	Delete(context.Context, applicationintake.DeleteCommand, domainproject.Visibility) (applicationintake.MutationResult, error)
}

var _ IntakeService = (*applicationintake.Service)(nil)

type intakeListEnvelope struct {
	Data       []applicationintake.IntakeDTO `json:"data"`
	Pagination paginationEnvelope            `json:"pagination"`
	RequestID  string                        `json:"request_id"`
}

type intakeMutationEnvelope struct {
	Data      applicationintake.MutationResult `json:"data"`
	RequestID string                           `json:"request_id"`
}

type intakeCreateRequest struct {
	RequirementID  *int64                     `json:"requirement_id"`
	Title          string                     `json:"title"`
	Body           *string                    `json:"body"`
	Status         domainintake.Status        `json:"status"`
	AgentCLI       *intakeAgentCLIRequest     `json:"agent_cli"`
	PlanGeneration *intakePlanGenerationInput `json:"plan_generation"`
}

type intakeUpdateRequest struct {
	ExpectedUpdatedAt string                     `json:"expected_updated_at"`
	RequirementID     optionalInt64              `json:"requirement_id"`
	Title             *string                    `json:"title"`
	Body              *string                    `json:"body"`
	Status            *domainintake.Status       `json:"status"`
	AgentCLI          *intakeAgentCLIRequest     `json:"agent_cli"`
	PlanGeneration    *intakePlanGenerationInput `json:"plan_generation"`
}

type intakeAgentCLIRequest struct {
	Provider             *string `json:"provider"`
	Command              string  `json:"command"`
	CodexReasoningEffort *string `json:"codex_reasoning_effort"`
}

type intakePlanGenerationInput struct {
	Strategy             *string `json:"strategy"`
	Provider             *string `json:"provider"`
	Command              string  `json:"command"`
	Model                string  `json:"model"`
	CodexReasoningEffort *string `json:"codex_reasoning_effort"`
	ClaudeBaseURL        string  `json:"claude_base_url"`
	ClaudeAuthToken      string  `json:"claude_auth_token"`
	ClaudeModel          string  `json:"claude_model"`
	ClaudeConfigID       int64   `json:"claude_config_id"`
}

type optionalInt64 struct {
	Set   bool
	Value *int64
}

func (value *optionalInt64) UnmarshalJSON(input []byte) error {
	value.Set = true
	if string(input) == "null" {
		value.Value = nil
		return nil
	}
	var parsed int64
	if err := json.Unmarshal(input, &parsed); err != nil {
		return err
	}
	value.Value = &parsed
	return nil
}

type replacePlanLinksRequest struct {
	Links *[]planLinkRequest `json:"links"`
}

type planLinkRequest struct {
	PlanID     int64  `json:"plan_id"`
	PhaseIndex int64  `json:"phase_index"`
	PhaseTitle string `json:"phase_title"`
}

func RegisterIntake(router *Router, security *Security, service IntakeService) error {
	if router == nil || security == nil || service == nil {
		return ErrRouterDependency
	}
	list := security.Protect(TransportREST, intakeListEndpoint(service))
	detail := security.Protect(TransportREST, intakeDetailEndpoint(service))
	create := security.Protect(TransportREST, intakeCreateEndpoint(service, router.BodyLimitBytes()))
	update := security.Protect(TransportREST, intakeUpdateEndpoint(service, router.BodyLimitBytes()))
	remove := security.Protect(TransportREST, intakeDeleteEndpoint(service))
	acceptance := security.Protect(TransportREST, intakeAcceptanceEndpoint(service))
	links := security.Protect(TransportREST, intakeLinksEndpoint(service))
	replaceLinks := security.Protect(TransportREST, intakeReplaceLinksEndpoint(service, router.BodyLimitBytes()))
	registrations := []struct {
		method   string
		path     string
		endpoint Endpoint
	}{
		{http.MethodGet, RequirementsPath, list},
		{http.MethodHead, RequirementsPath, list},
		{http.MethodPost, RequirementsPath, create},
		{http.MethodGet, RequirementPath, detail},
		{http.MethodHead, RequirementPath, detail},
		{http.MethodPatch, RequirementPath, update},
		{http.MethodDelete, RequirementPath, remove},
		{http.MethodPost, RequirementAcceptancePath, acceptance},
		{http.MethodDelete, RequirementAcceptancePath, acceptance},
		{http.MethodGet, RequirementPlanLinksPath, links},
		{http.MethodHead, RequirementPlanLinksPath, links},
		{http.MethodPut, RequirementPlanLinksPath, replaceLinks},
		{http.MethodGet, FeedbackPath, list},
		{http.MethodHead, FeedbackPath, list},
		{http.MethodPost, FeedbackPath, create},
		{http.MethodGet, FeedbackItemPath, detail},
		{http.MethodHead, FeedbackItemPath, detail},
		{http.MethodPatch, FeedbackItemPath, update},
		{http.MethodDelete, FeedbackItemPath, remove},
		{http.MethodPost, FeedbackAcceptancePath, acceptance},
		{http.MethodDelete, FeedbackAcceptancePath, acceptance},
		{http.MethodGet, FeedbackPlanLinksPath, links},
		{http.MethodHead, FeedbackPlanLinksPath, links},
		{http.MethodPut, FeedbackPlanLinksPath, replaceLinks},
	}
	for _, registration := range registrations {
		if err := router.HandlePattern(registration.method, registration.path, registration.endpoint); err != nil {
			return err
		}
	}
	return RegisterIntakeActionRoutes(router, security, service)
}

func intakeListEndpoint(service IntakeService) Endpoint {
	return func(_ application.Boundary, writer http.ResponseWriter, request *http.Request) {
		projectID, intakeType, failure := intakeListPath(request.URL.Path)
		if failure != nil {
			WriteError(writer, request, *failure)
			return
		}
		pagination, status, failure := parseIntakePagination(request.URL)
		if failure != nil {
			WriteError(writer, request, *failure)
			return
		}
		items, err := service.List(request.Context(), applicationintake.ListQuery{
			ProjectID: projectID, Type: intakeType, Status: status,
			Limit: pagination.PageSize, Offset: (pagination.Page - 1) * pagination.PageSize,
		})
		if err != nil {
			writeIntakeServiceError(writer, request, err)
			return
		}
		var nextPage *int
		if len(items) == pagination.PageSize {
			next := pagination.Page + 1
			nextPage = &next
		}
		WriteResponse(writer, request, http.StatusOK, intakeListEnvelope{
			Data:       items,
			Pagination: paginationEnvelope{Page: pagination.Page, PageSize: pagination.PageSize, Total: len(items), NextPage: nextPage},
			RequestID:  RequestID(request.Context()),
		})
	}
}

func intakeDetailEndpoint(service IntakeService) Endpoint {
	return func(_ application.Boundary, writer http.ResponseWriter, request *http.Request) {
		projectID, intakeType, intakeID, failure := intakePath(request.URL.Path, "")
		if failure != nil {
			WriteError(writer, request, *failure)
			return
		}
		item, err := service.Get(request.Context(), projectID, intakeType, intakeID)
		if err != nil {
			writeIntakeServiceError(writer, request, err)
			return
		}
		WriteResponse(writer, request, http.StatusOK, responseEnvelope{Data: item, RequestID: RequestID(request.Context())})
	}
}

func intakeCreateEndpoint(service IntakeService, bodyLimit int64) Endpoint {
	return func(_ application.Boundary, writer http.ResponseWriter, request *http.Request) {
		projectID, intakeType, failure := intakeListPath(request.URL.Path)
		if failure != nil {
			WriteError(writer, request, *failure)
			return
		}
		metadata, failure := mutationRequestContext(request)
		if failure != nil {
			WriteError(writer, request, *failure)
			return
		}
		var input intakeCreateRequest
		if failure := DecodeJSON(writer, request, &input, bodyLimit); failure != nil {
			WriteError(writer, request, *failure)
			return
		}
		if input.Body == nil || (intakeType == domainintake.Requirement && input.RequirementID != nil) {
			WriteError(writer, request, NewAPIError(CodeInvalidIntake, nil))
			return
		}
		result, err := service.Create(request.Context(), applicationintake.CreateCommand{
			ProjectID: projectID, Type: intakeType, RequirementID: input.RequirementID, Title: input.Title, Body: *input.Body,
			Status: input.Status, AgentCLI: input.agentCLI(), PlanGeneration: input.planGeneration(), Metadata: intakeMutationMetadata(metadata),
		}, authorizedProjectVisibility(request))
		if err != nil {
			writeIntakeServiceError(writer, request, err)
			return
		}
		WriteResponse(writer, request, http.StatusCreated, intakeMutationEnvelope{Data: result, RequestID: RequestID(request.Context())})
	}
}

func intakeUpdateEndpoint(service IntakeService, bodyLimit int64) Endpoint {
	return func(_ application.Boundary, writer http.ResponseWriter, request *http.Request) {
		projectID, intakeType, intakeID, failure := intakePath(request.URL.Path, "")
		if failure != nil {
			WriteError(writer, request, *failure)
			return
		}
		metadata, failure := mutationRequestContext(request)
		if failure != nil {
			WriteError(writer, request, *failure)
			return
		}
		var input intakeUpdateRequest
		if failure := DecodeJSON(writer, request, &input, bodyLimit); failure != nil {
			WriteError(writer, request, *failure)
			return
		}
		if input.Title == nil && input.Body == nil && input.Status == nil && !input.RequirementID.Set && input.AgentCLI == nil && input.PlanGeneration == nil {
			WriteError(writer, request, NewAPIError(CodeInvalidIntake, nil))
			return
		}
		if intakeType == domainintake.Requirement && input.RequirementID.Set {
			WriteError(writer, request, NewAPIError(CodeInvalidIntake, nil))
			return
		}
		result, err := service.Update(request.Context(), applicationintake.UpdateCommand{
			ProjectID: projectID, Type: intakeType, ID: intakeID, ExpectedUpdatedAt: input.ExpectedUpdatedAt,
			RequirementID: applicationintake.NullableInt64{Set: input.RequirementID.Set, Value: input.RequirementID.Value},
			Title:         input.Title, Body: input.Body, Status: input.Status, AgentCLI: input.agentCLIPointer(),
			PlanGeneration: input.planGenerationPointer(), Metadata: intakeMutationMetadata(metadata),
		}, authorizedProjectVisibility(request))
		if err != nil {
			writeIntakeServiceError(writer, request, err)
			return
		}
		WriteResponse(writer, request, http.StatusOK, intakeMutationEnvelope{Data: result, RequestID: RequestID(request.Context())})
	}
}

func intakeDeleteEndpoint(service IntakeService) Endpoint {
	return func(_ application.Boundary, writer http.ResponseWriter, request *http.Request) {
		projectID, intakeType, intakeID, failure := intakePath(request.URL.Path, "")
		if failure != nil {
			WriteError(writer, request, *failure)
			return
		}
		metadata, failure := mutationRequestContext(request)
		if failure != nil {
			WriteError(writer, request, *failure)
			return
		}
		result, err := service.Delete(request.Context(), applicationintake.DeleteCommand{
			ProjectID: projectID, Type: intakeType, ID: intakeID, Metadata: intakeMutationMetadata(metadata),
		}, authorizedProjectVisibility(request))
		if err != nil {
			writeIntakeServiceError(writer, request, err)
			return
		}
		WriteResponse(writer, request, http.StatusOK, intakeMutationEnvelope{Data: result, RequestID: RequestID(request.Context())})
	}
}

func intakeAcceptanceEndpoint(service IntakeService) Endpoint {
	return func(_ application.Boundary, writer http.ResponseWriter, request *http.Request) {
		projectID, intakeType, intakeID, failure := intakePath(request.URL.Path, "accept")
		if failure != nil {
			WriteError(writer, request, *failure)
			return
		}
		metadata, failure := mutationRequestContext(request)
		if failure != nil {
			WriteError(writer, request, *failure)
			return
		}
		result, err := service.SetAcceptance(request.Context(), applicationintake.AcceptanceCommand{
			ProjectID: projectID, Type: intakeType, ID: intakeID, Accept: request.Method == http.MethodPost,
			Metadata: intakeMutationMetadata(metadata),
		}, authorizedProjectVisibility(request))
		if err != nil {
			writeIntakeServiceError(writer, request, err)
			return
		}
		WriteResponse(writer, request, http.StatusOK, intakeMutationEnvelope{Data: result, RequestID: RequestID(request.Context())})
	}
}

func intakeLinksEndpoint(service IntakeService) Endpoint {
	return func(_ application.Boundary, writer http.ResponseWriter, request *http.Request) {
		projectID, intakeType, intakeID, failure := intakePath(request.URL.Path, "plan-links")
		if failure != nil {
			WriteError(writer, request, *failure)
			return
		}
		links, err := service.Links(request.Context(), projectID, intakeType, intakeID)
		if err != nil {
			writeIntakeServiceError(writer, request, err)
			return
		}
		WriteResponse(writer, request, http.StatusOK, responseEnvelope{Data: links, RequestID: RequestID(request.Context())})
	}
}

func intakeReplaceLinksEndpoint(service IntakeService, bodyLimit int64) Endpoint {
	return func(_ application.Boundary, writer http.ResponseWriter, request *http.Request) {
		projectID, intakeType, intakeID, failure := intakePath(request.URL.Path, "plan-links")
		if failure != nil {
			WriteError(writer, request, *failure)
			return
		}
		metadata, failure := mutationRequestContext(request)
		if failure != nil {
			WriteError(writer, request, *failure)
			return
		}
		var input replacePlanLinksRequest
		if failure := DecodeJSON(writer, request, &input, bodyLimit); failure != nil {
			WriteError(writer, request, *failure)
			return
		}
		if input.Links == nil {
			WriteError(writer, request, NewAPIError(CodeInvalidIntake, nil))
			return
		}
		links := make([]domainintake.PlanLinkInput, 0, len(*input.Links))
		for _, link := range *input.Links {
			links = append(links, domainintake.PlanLinkInput{PlanID: link.PlanID, PhaseIndex: link.PhaseIndex, PhaseTitle: link.PhaseTitle})
		}
		result, err := service.ReplaceLinks(request.Context(), applicationintake.ReplaceLinksCommand{
			ProjectID: projectID, Type: intakeType, ID: intakeID, Links: links, Metadata: intakeMutationMetadata(metadata),
		}, authorizedProjectVisibility(request))
		if err != nil {
			writeIntakeServiceError(writer, request, err)
			return
		}
		WriteResponse(writer, request, http.StatusOK, intakeMutationEnvelope{Data: result, RequestID: RequestID(request.Context())})
	}
}

func intakeListPath(path string) (int64, domainintake.Type, *APIError) {
	segments := strings.Split(strings.TrimPrefix(path, "/api/v1/projects/"), "/")
	if len(segments) != 2 {
		failure := NewAPIError(CodeNotFound, nil)
		return 0, "", &failure
	}
	projectID, failure := parseIntakeProjectID(segments[0])
	if failure != nil {
		return 0, "", failure
	}
	intakeType, valid := intakeTypeForSegment(segments[1])
	if !valid {
		failure := NewAPIError(CodeNotFound, nil)
		return 0, "", &failure
	}
	return projectID, intakeType, nil
}

func intakePath(path, suffix string) (int64, domainintake.Type, int64, *APIError) {
	segments := strings.Split(strings.TrimPrefix(path, "/api/v1/projects/"), "/")
	expected := 3
	if suffix != "" {
		expected++
	}
	if len(segments) != expected || (suffix != "" && segments[len(segments)-1] != suffix) {
		failure := NewAPIError(CodeNotFound, nil)
		return 0, "", 0, &failure
	}
	projectID, failure := parseIntakeProjectID(segments[0])
	if failure != nil {
		return 0, "", 0, failure
	}
	intakeType, valid := intakeTypeForSegment(segments[1])
	if !valid {
		failure := NewAPIError(CodeNotFound, nil)
		return 0, "", 0, &failure
	}
	intakeID, valid := parseCanonicalPositiveID(segments[2])
	if !valid {
		failure := NewAPIError(CodeInvalidIntake, &ErrorDetails{Field: "intake_id"})
		return 0, "", 0, &failure
	}
	return projectID, intakeType, intakeID, nil
}

func parseIntakeProjectID(value string) (int64, *APIError) {
	projectID, valid := parseCanonicalPositiveID(value)
	if !valid {
		failure := NewAPIError(CodeInvalidProjectID, &ErrorDetails{Field: "project_id"})
		return 0, &failure
	}
	return projectID, nil
}

func parseCanonicalPositiveID(value string) (int64, bool) {
	parsed, err := strconv.ParseInt(value, 10, 64)
	return parsed, err == nil && parsed > 0 && strconv.FormatInt(parsed, 10) == value
}

func intakeTypeForSegment(value string) (domainintake.Type, bool) {
	switch value {
	case "requirements":
		return domainintake.Requirement, true
	case "feedback":
		return domainintake.Feedback, true
	default:
		return "", false
	}
}

func parseIntakePagination(location *url.URL) (paginationEnvelope, *domainintake.Status, *APIError) {
	result := paginationEnvelope{Page: 1, PageSize: DefaultIntakePageSize}
	if location == nil {
		failure := NewAPIError(CodeInvalidPagination, &ErrorDetails{Field: "query"})
		return result, nil, &failure
	}
	values, err := url.ParseQuery(location.RawQuery)
	if err != nil {
		failure := NewAPIError(CodeInvalidPagination, &ErrorDetails{Field: "query"})
		return result, nil, &failure
	}
	for name, entries := range values {
		if name != "page" && name != "page_size" && name != "status" || len(entries) != 1 || entries[0] == "" {
			failure := NewAPIError(CodeInvalidPagination, &ErrorDetails{Field: name})
			return result, nil, &failure
		}
	}
	if entries, exists := values["page"]; exists {
		value, valid := parsePositiveInt(entries[0], maximumInt)
		if !valid {
			failure := NewAPIError(CodeInvalidPagination, &ErrorDetails{Field: "page"})
			return result, nil, &failure
		}
		result.Page = value
	}
	if entries, exists := values["page_size"]; exists {
		value, valid := parsePositiveInt(entries[0], MaximumIntakePageSize)
		if !valid {
			failure := NewAPIError(CodeInvalidPagination, &ErrorDetails{Field: "page_size"})
			return result, nil, &failure
		}
		result.PageSize = value
	}
	if result.Page-1 > maximumInt/result.PageSize {
		failure := NewAPIError(CodeInvalidPagination, &ErrorDetails{Field: "page"})
		return result, nil, &failure
	}
	if entries, exists := values["status"]; exists {
		status := domainintake.Status(entries[0])
		if !status.Valid() {
			failure := NewAPIError(CodeInvalidPagination, &ErrorDetails{Field: "status"})
			return result, nil, &failure
		}
		return result, &status, nil
	}
	return result, nil, nil
}

func intakeMutationMetadata(metadata mutationContext) applicationintake.MutationMetadata {
	return applicationintake.MutationMetadata{
		CallerScope: metadata.CallerScope, IdempotencyKey: metadata.IdempotencyKey, RequestID: metadata.RequestID,
	}
}

func (input intakeCreateRequest) agentCLI() domainintake.AgentCLIConfig {
	if input.AgentCLI == nil {
		return domainintake.AgentCLIConfig{}
	}
	return domainintake.AgentCLIConfig{
		Provider: input.AgentCLI.Provider, Command: input.AgentCLI.Command, CodexReasoningEffort: input.AgentCLI.CodexReasoningEffort,
	}
}

func (input intakeCreateRequest) planGeneration() domainintake.PlanGenerationConfig {
	if input.PlanGeneration == nil {
		return domainintake.PlanGenerationConfig{}
	}
	return input.PlanGeneration.domainValue()
}

func (input intakeUpdateRequest) agentCLIPointer() *domainintake.AgentCLIConfig {
	if input.AgentCLI == nil {
		return nil
	}
	value := domainintake.AgentCLIConfig{
		Provider: input.AgentCLI.Provider, Command: input.AgentCLI.Command, CodexReasoningEffort: input.AgentCLI.CodexReasoningEffort,
	}
	return &value
}

func (input intakeUpdateRequest) planGenerationPointer() *domainintake.PlanGenerationConfig {
	if input.PlanGeneration == nil {
		return nil
	}
	value := input.PlanGeneration.domainValue()
	return &value
}

func (input intakePlanGenerationInput) domainValue() domainintake.PlanGenerationConfig {
	return domainintake.PlanGenerationConfig{
		Strategy: input.Strategy, Provider: input.Provider, Command: input.Command, Model: input.Model,
		CodexReasoningEffort: input.CodexReasoningEffort, ClaudeBaseURL: input.ClaudeBaseURL,
		ClaudeAuthToken: input.ClaudeAuthToken, ClaudeModel: input.ClaudeModel, ClaudeConfigID: input.ClaudeConfigID,
	}
}

func writeIntakeServiceError(writer http.ResponseWriter, request *http.Request, err error) {
	code := CodeInternal
	var duplicate applicationintake.DuplicateError
	switch {
	case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded):
		code = CodeRequestTimeout
	case errors.As(err, &duplicate):
		code = CodeDuplicateIntake
	case errors.Is(err, applicationintake.ErrInvalidCommand), errors.Is(err, applicationintake.ErrInvalidTransition),
		errors.Is(err, domainintake.ErrInvalid), errors.Is(err, domainintake.ErrInvalidLink),
		errors.Is(err, repository.ErrInvalidIntake), errors.Is(err, repository.ErrInvalidTask):
		code = CodeInvalidIntake
	case errors.Is(err, applicationintake.ErrStateConflict):
		code = CodePreconditionFailed
	case errors.Is(err, repository.ErrNotFound), errors.Is(err, repository.ErrProjectMismatch),
		errors.Is(err, repository.ErrRequirementMissing), errors.Is(err, repository.ErrPlanMissing):
		code = CodeIntakeNotFound
	case errors.Is(err, repository.ErrLinkConflict):
		code = CodeRelationConflict
	case errors.Is(err, repository.ErrIdempotencyKeyReuse):
		code = CodeIdempotencyKeyReused
	case errors.Is(err, repository.ErrDuplicate):
		code = CodeRequestInProgress
	case errors.Is(err, repository.ErrTransaction), errors.Is(err, repository.ErrCommit), errors.Is(err, repository.ErrRollback):
		code = CodeRepositoryBusy
	case errors.Is(err, repository.ErrSchemaDrift):
		code = CodeRepositorySchemaDrift
	case errors.Is(err, applicationintake.ErrUnavailable), errors.Is(err, repository.ErrNotConfigured),
		errors.Is(err, repository.ErrUnsafePath), errors.Is(err, repository.ErrInvalidStore),
		errors.Is(err, repository.ErrSourceChanged), errors.Is(err, repository.ErrClosed), errors.Is(err, repository.ErrWriterUnauthorized):
		code = CodeRepositoryUnavailable
	}
	WriteError(writer, request, NewAPIError(code, nil))
}
