package httpapi

import (
	"context"
	"errors"
	"net/http"

	"github.com/lyming99/autoplan/backend/internal/application"
	applicationplans "github.com/lyming99/autoplan/backend/internal/application/plans"
	domainproject "github.com/lyming99/autoplan/backend/internal/domain/project"
	"github.com/lyming99/autoplan/backend/internal/repository"
)

const PlansPath = "/api/v1/plans"

type PlanMutationService interface {
	Delete(context.Context, applicationplans.DeleteCommand, domainproject.Visibility) (applicationplans.MutationResult, error)
}

var _ PlanMutationService = (*applicationplans.Service)(nil)

type planDeleteRequest struct {
	ProjectID         int64  `json:"project_id"`
	PlanID            int64  `json:"plan_id"`
	ExpectedUpdatedAt string `json:"expected_updated_at"`
}

type planMutationEnvelope struct {
	Data      applicationplans.MutationResult `json:"data"`
	RequestID string                          `json:"request_id"`
}

// RegisterPlanMutations exposes pure persistence mutations only. Runtime plan
// actions remain registered through RegisterRuntimeBridge.
func RegisterPlanMutations(router *Router, security *Security, service PlanMutationService) error {
	if router == nil || security == nil || service == nil {
		return ErrRouterDependency
	}
	endpoint := security.Protect(TransportREST, planDeleteEndpoint(service, router.BodyLimitBytes()))
	return router.Handle(http.MethodDelete, PlansPath, endpoint)
}

func planDeleteEndpoint(service PlanMutationService, bodyLimit int64) Endpoint {
	return func(_ application.Boundary, writer http.ResponseWriter, request *http.Request) {
		if request.URL == nil || request.URL.RawQuery != "" {
			WriteError(writer, request, NewAPIError(CodeInvalidPlan, &ErrorDetails{Field: "query"}))
			return
		}
		metadata, failure := mutationRequestContext(request)
		if failure != nil {
			WriteError(writer, request, *failure)
			return
		}
		var input planDeleteRequest
		if failure := DecodeJSON(writer, request, &input, bodyLimit); failure != nil {
			WriteError(writer, request, *failure)
			return
		}
		result, err := service.Delete(request.Context(), applicationplans.DeleteCommand{
			ProjectID: input.ProjectID, PlanID: input.PlanID,
			ExpectedUpdatedAt: input.ExpectedUpdatedAt, RequestID: metadata.RequestID,
		}, authorizedProjectVisibility(request))
		if err != nil {
			writePlanMutationError(writer, request, err)
			return
		}
		WriteResponse(writer, request, http.StatusOK, planMutationEnvelope{
			Data: result, RequestID: RequestID(request.Context()),
		})
	}
}

func writePlanMutationError(writer http.ResponseWriter, request *http.Request, err error) {
	code := CodeInternal
	switch {
	case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded):
		code = CodeRequestTimeout
	case errors.Is(err, applicationplans.ErrInvalidCommand):
		code = CodeInvalidPlan
	case errors.Is(err, repository.ErrNotFound), errors.Is(err, repository.ErrProjectMismatch):
		code = CodeNotFound
	case errors.Is(err, applicationplans.ErrStateConflict), errors.Is(err, repository.ErrVersionConflict):
		code = CodePreconditionFailed
	case errors.Is(err, applicationplans.ErrProtected), errors.Is(err, repository.ErrRelationConflict):
		code = CodeRelationConflict
	case errors.Is(err, repository.ErrTransaction), errors.Is(err, repository.ErrCommit), errors.Is(err, repository.ErrRollback):
		code = CodeRepositoryBusy
	case errors.Is(err, repository.ErrSchemaDrift):
		code = CodeRepositorySchemaDrift
	case errors.Is(err, applicationplans.ErrUnavailable), errors.Is(err, repository.ErrNotConfigured),
		errors.Is(err, repository.ErrUnsafePath), errors.Is(err, repository.ErrInvalidStore),
		errors.Is(err, repository.ErrSourceChanged), errors.Is(err, repository.ErrClosed),
		errors.Is(err, repository.ErrWriterUnauthorized):
		code = CodeRepositoryUnavailable
	}
	WriteError(writer, request, NewAPIError(code, nil))
}
