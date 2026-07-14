package httpapi

import (
	"net/http"
	"strings"

	"github.com/lyming99/autoplan/backend/internal/application"
	applicationintake "github.com/lyming99/autoplan/backend/internal/application/intake"
	domainintake "github.com/lyming99/autoplan/backend/internal/domain/intake"
)

const IntakeRetryPlanGenerationActionPath = "/api/v1/projects/{project_id}/intake/{intake_type}/{intake_id}/actions/retry-plan-generation"

const (
	IntakeInterruptActionPath  = "/api/v1/projects/{project_id}/intake/{intake_type}/{intake_id}/actions/interrupt"
	IntakeResumeActionPath     = "/api/v1/projects/{project_id}/intake/{intake_type}/{intake_id}/actions/resume"
	IntakeAppendTaskActionPath = "/api/v1/projects/{project_id}/intake/{intake_type}/{intake_id}/actions/append-task"
)

type appendIntakeTaskRequest struct {
	Title *string `json:"title"`
}

// RegisterIntakeActionRoutes keeps retry input intentionally narrow. Retrying
// is a synchronous intake mutation that clears failure state; the normal loop
// scheduler remains the sole owner of the subsequent Agent CLI process.
func RegisterIntakeActionRoutes(router *Router, security *Security, service IntakeService) error {
	if router == nil || security == nil || service == nil {
		return ErrRouterDependency
	}
	retryEndpoint := func(_ application.Boundary, writer http.ResponseWriter, request *http.Request) {
		metadata, failure := mutationRequestContext(request)
		if failure != nil {
			WriteError(writer, request, *failure)
			return
		}
		if request.URL == nil || request.URL.RawQuery != "" {
			WriteError(writer, request, NewAPIError(CodeRuntimeCommand, &ErrorDetails{Field: "query"}))
			return
		}
		projectID, failure := projectIDFromRuntimeActionPath(request.URL.Path)
		if failure != nil {
			WriteError(writer, request, *failure)
			return
		}
		if failure := decodeEmptyRuntimeAction(writer, request, router.BodyLimitBytes()); failure != nil {
			WriteError(writer, request, *failure)
			return
		}
		intakeType, intakeID, failure := intakeTargetFromActionPath(request.URL.Path, projectID, "retry-plan-generation")
		if failure != nil {
			WriteError(writer, request, *failure)
			return
		}
		result, err := service.RetryPlanGeneration(request.Context(), applicationintake.RetryPlanGenerationCommand{
			ProjectID: projectID, Type: intakeType, ID: intakeID, Metadata: intakeMutationMetadata(metadata),
		}, authorizedProjectVisibility(request))
		if err != nil {
			writeIntakeServiceError(writer, request, err)
			return
		}
		WriteResponse(writer, request, http.StatusOK, intakeMutationEnvelope{Data: result, RequestID: RequestID(request.Context())})
	}
	if err := router.HandlePattern(http.MethodPost, IntakeRetryPlanGenerationActionPath, security.Protect(TransportREST, retryEndpoint)); err != nil {
		return err
	}
	for _, route := range []struct {
		path   string
		action string
	}{
		{IntakeInterruptActionPath, "interrupt"},
		{IntakeResumeActionPath, "resume"},
		{IntakeAppendTaskActionPath, "append-task"},
	} {
		action := route.action
		endpoint := security.Protect(TransportREST, intakePlanActionEndpoint(service, router.BodyLimitBytes(), action))
		if err := router.HandlePattern(http.MethodPost, route.path, endpoint); err != nil {
			return err
		}
	}
	return nil
}

func intakeTargetFromRuntimeActionPath(path string, projectID int64) (domainintake.Type, int64, *APIError) {
	return intakeTargetFromActionPath(path, projectID, "retry-plan-generation")
}

func intakeTargetFromActionPath(path string, projectID int64, action string) (domainintake.Type, int64, *APIError) {
	parts := strings.Split(strings.TrimPrefix(path, "/api/v1/projects/"), "/")
	if len(parts) != 6 || parts[0] != decimalRuntimeID(projectID) || parts[1] != "intake" ||
		parts[4] != "actions" || parts[5] != action {
		failure := NewAPIError(CodeInvalidIntake, &ErrorDetails{Field: "intake_id"})
		return "", 0, &failure
	}
	if parts[2] != "requirement" && parts[2] != "feedback" {
		failure := NewAPIError(CodeInvalidIntake, &ErrorDetails{Field: "intake_type"})
		return "", 0, &failure
	}
	id, failure := parseRuntimeResourceID(parts[3], "intake_id")
	if failure != nil {
		return "", 0, failure
	}
	return domainintake.Type(parts[2]), id, nil
}

func intakePlanActionEndpoint(service IntakeService, bodyLimit int64, action string) Endpoint {
	return func(_ application.Boundary, writer http.ResponseWriter, request *http.Request) {
		metadata, failure := mutationRequestContext(request)
		if failure != nil {
			WriteError(writer, request, *failure)
			return
		}
		if request.URL == nil || request.URL.RawQuery != "" {
			WriteError(writer, request, NewAPIError(CodeInvalidIntake, &ErrorDetails{Field: "query"}))
			return
		}
		projectID, failure := projectIDFromRuntimeActionPath(request.URL.Path)
		if failure != nil {
			WriteError(writer, request, *failure)
			return
		}
		intakeType, intakeID, failure := intakeTargetFromActionPath(request.URL.Path, projectID, action)
		if failure != nil {
			WriteError(writer, request, *failure)
			return
		}
		command := applicationintake.PlanActionCommand{
			ProjectID: projectID, Type: intakeType, ID: intakeID, Metadata: intakeMutationMetadata(metadata),
		}
		if action == "append-task" {
			var input appendIntakeTaskRequest
			if failure := DecodeJSON(writer, request, &input, bodyLimit); failure != nil {
				WriteError(writer, request, *failure)
				return
			}
			if input.Title == nil {
				WriteError(writer, request, NewAPIError(CodeInvalidIntake, &ErrorDetails{Field: "title"}))
				return
			}
			command.Title = *input.Title
		} else if failure := decodeEmptyRuntimeAction(writer, request, bodyLimit); failure != nil {
			WriteError(writer, request, *failure)
			return
		}
		visibility := authorizedProjectVisibility(request)
		var result applicationintake.MutationResult
		var err error
		switch action {
		case "interrupt":
			result, err = service.InterruptPlans(request.Context(), command, visibility)
		case "resume":
			result, err = service.ResumePlans(request.Context(), command, visibility)
		case "append-task":
			result, err = service.AppendTask(request.Context(), command, visibility)
		default:
			WriteError(writer, request, NewAPIError(CodeInvalidIntake, nil))
			return
		}
		if err != nil {
			writeIntakeServiceError(writer, request, err)
			return
		}
		WriteResponse(writer, request, http.StatusOK, intakeMutationEnvelope{Data: result, RequestID: RequestID(request.Context())})
	}
}
