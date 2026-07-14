package httpapi

import (
	"context"
	"errors"
	"net/http"
	"strings"

	"github.com/lyming99/autoplan/backend/internal/application"
	applicationplans "github.com/lyming99/autoplan/backend/internal/application/plans"
	"github.com/lyming99/autoplan/backend/internal/repository"
)

const ProjectPlanContentPath = "/api/v1/projects/{project_id}/plans/{plan_id}/content"

type PlanContentService interface {
	ReadContent(context.Context, int64, int64) (applicationplans.ContentDTO, error)
}

func RegisterPlanContent(router *Router, security *Security, service PlanContentService) error {
	if router == nil || security == nil || service == nil {
		return ErrRouterDependency
	}
	endpoint := func(_ application.Boundary, writer http.ResponseWriter, request *http.Request) {
		if request.URL == nil || request.URL.RawQuery != "" {
			WriteError(writer, request, NewAPIError(CodeInvalidOperation, &ErrorDetails{Field: "query"}))
			return
		}
		projectID, planID, failure := planContentTarget(request.URL.Path)
		if failure != nil {
			WriteError(writer, request, *failure)
			return
		}
		content, err := service.ReadContent(request.Context(), projectID, planID)
		if err != nil {
			writePlanContentError(writer, request, err)
			return
		}
		WriteResponse(writer, request, http.StatusOK, struct {
			Data      applicationplans.ContentDTO `json:"data"`
			RequestID string                      `json:"request_id"`
		}{Data: content, RequestID: RequestID(request.Context())})
	}
	return router.HandlePattern(http.MethodGet, ProjectPlanContentPath, security.Protect(TransportREST, endpoint))
}

func planContentTarget(path string) (int64, int64, *APIError) {
	const prefix = "/api/v1/projects/"
	parts := strings.Split(strings.TrimPrefix(path, prefix), "/")
	if !strings.HasPrefix(path, prefix) || len(parts) != 4 || parts[1] != "plans" || parts[3] != "content" {
		failure := NewAPIError(CodeInvalidOperation, &ErrorDetails{Field: "plan_id"})
		return 0, 0, &failure
	}
	projectID, failure := parseCanonicalProjectID(parts[0])
	if failure != nil {
		return 0, 0, failure
	}
	planID, failure := parseRuntimeResourceID(parts[2], "plan_id")
	if failure != nil {
		return 0, 0, failure
	}
	return projectID, planID, nil
}

func writePlanContentError(writer http.ResponseWriter, request *http.Request, err error) {
	switch {
	case errors.Is(err, repository.ErrNotFound):
		WriteError(writer, request, NewAPIError(CodeNotFound, nil))
	case errors.Is(err, applicationplans.ErrInvalidCommand), errors.Is(err, applicationplans.ErrUnsafeContent):
		WriteError(writer, request, NewAPIError(CodeInvalidOperation, nil))
	case errors.Is(err, applicationplans.ErrUnavailable), errors.Is(err, repository.ErrNotConfigured), errors.Is(err, repository.ErrClosed):
		WriteError(writer, request, NewAPIError(CodeServiceUnavailable, nil))
	default:
		WriteError(writer, request, NewAPIError(CodeInternal, nil))
	}
}
