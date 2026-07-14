package httpapi

import (
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/lyming99/autoplan/backend/internal/application"
	"github.com/lyming99/autoplan/backend/internal/application/capabilities"
	applicationloop "github.com/lyming99/autoplan/backend/internal/application/loop"
)

const (
	LoopStartActionPath   = "/api/v1/projects/{project_id}/loop/actions/start"
	LoopStopActionPath    = "/api/v1/projects/{project_id}/loop/actions/stop"
	LoopRunOnceActionPath = "/api/v1/projects/{project_id}/loop/actions/run-once"
)

// RuntimeActionService is deliberately the same bridge used by the generic
// compatibility endpoint and MCP. Resource routes only translate a stable
// public path into a closed applicationloop.Command.
type RuntimeActionService = RuntimeBridgeService

type operationAcceptedEnvelope struct {
	Data      capabilities.OperationReference `json:"data"`
	RequestID string                          `json:"request_id"`
}

type actionCommandBuilder func(http.ResponseWriter, *http.Request, int64) (applicationloop.Command, *APIError)

// RegisterRuntimeActionRoutes registers the versioned resource action
// adapters as one unit. Bootstrap owns deciding which caller-owned router
// invokes it; none of these adapters discovers a repository or runtime.
func RegisterRuntimeActionRoutes(router *Router, security *Security, service RuntimeActionService) error {
	if router == nil || security == nil || service == nil {
		return ErrRouterDependency
	}
	if err := RegisterLoopActionRoutes(router, security, service); err != nil {
		return err
	}
	if err := RegisterProjectPlanActionRoutes(router, security, service); err != nil {
		return err
	}
	if err := RegisterProjectTaskActionRoutes(router, security, service); err != nil {
		return err
	}
	if err := RegisterAcceptanceActionRoutes(router, security, service); err != nil {
		return err
	}
	return nil
}

func RegisterLoopActionRoutes(router *Router, security *Security, service RuntimeActionService) error {
	if router == nil || security == nil || service == nil {
		return ErrRouterDependency
	}
	for _, route := range []struct {
		path string
		kind applicationloop.CommandKind
	}{
		{LoopStartActionPath, applicationloop.CommandLoopStart},
		{LoopStopActionPath, applicationloop.CommandLoopStop},
		{LoopRunOnceActionPath, applicationloop.CommandLoopRunOnce},
	} {
		kind := route.kind
		if err := router.HandlePattern(http.MethodPost, route.path, security.Protect(TransportREST,
			runtimeActionEndpoint(service, router.BodyLimitBytes(), func(writer http.ResponseWriter, request *http.Request, projectID int64) (applicationloop.Command, *APIError) {
				if failure := decodeEmptyRuntimeAction(writer, request, router.BodyLimitBytes()); failure != nil {
					return applicationloop.Command{}, failure
				}
				return applicationloop.Command{Version: applicationloop.ContractVersion, Kind: kind, ProjectID: projectID}, nil
			}),
		)); err != nil {
			return err
		}
	}
	return nil
}

func runtimeActionEndpoint(service RuntimeActionService, bodyLimit int64, build actionCommandBuilder) Endpoint {
	return func(_ application.Boundary, writer http.ResponseWriter, request *http.Request) {
		metadata, failure := mutationRequestContext(request)
		if failure != nil {
			WriteError(writer, request, *failure)
			return
		}
		if request.URL == nil || request.URL.RawQuery != "" {
			failure := NewAPIError(CodeRuntimeCommand, &ErrorDetails{Field: "query"})
			WriteError(writer, request, failure)
			return
		}
		projectID, failure := projectIDFromRuntimeActionPath(request.URL.Path)
		if failure != nil {
			WriteError(writer, request, *failure)
			return
		}
		command, failure := build(writer, request, projectID)
		if failure != nil {
			WriteError(writer, request, *failure)
			return
		}
		command.Version = applicationloop.ContractVersion
		command.ProjectID = projectID
		command.CallerScope = metadata.CallerScope
		command.RequestID = metadata.RequestID
		command.IdempotencyKey = metadata.IdempotencyKey
		result, err := service.Execute(request.Context(), command)
		if err != nil {
			writeRuntimeActionError(writer, request, err)
			return
		}
		WriteResponse(writer, request, http.StatusAccepted, operationAcceptedEnvelope{Data: result.Operation, RequestID: RequestID(request.Context())})
	}
}

func writeRuntimeActionError(writer http.ResponseWriter, request *http.Request, err error) {
	switch {
	case errors.Is(err, applicationloop.ErrRuntimeUnavailable), errors.Is(err, applicationloop.ErrUnavailable):
		WriteError(writer, request, NewAPIError(CodeServiceUnavailable, nil))
	case errors.Is(err, applicationloop.ErrProjectNotFound):
		WriteError(writer, request, NewAPIError(CodeProjectNotFound, nil))
	case errors.Is(err, applicationloop.ErrRuntimeBusy), errors.Is(err, applicationloop.ErrStateConflict):
		WriteError(writer, request, NewAPIError(CodePreconditionFailed, nil))
	default:
		writeRuntimeBridgeError(writer, request, err)
	}
}

func decodeEmptyRuntimeAction(writer http.ResponseWriter, request *http.Request, bodyLimit int64) *APIError {
	var input struct{}
	return DecodeJSON(writer, request, &input, bodyLimit)
}

func projectIDFromRuntimeActionPath(path string) (int64, *APIError) {
	const prefix = "/api/v1/projects/"
	if !strings.HasPrefix(path, prefix) {
		failure := NewAPIError(CodeInvalidProjectID, &ErrorDetails{Field: "project_id"})
		return 0, &failure
	}
	parts := strings.Split(strings.TrimPrefix(path, prefix), "/")
	if len(parts) < 2 {
		failure := NewAPIError(CodeInvalidProjectID, &ErrorDetails{Field: "project_id"})
		return 0, &failure
	}
	return parseCanonicalProjectID(parts[0])
}

func parseRuntimeResourceID(value string, field string) (int64, *APIError) {
	if value == "" || strings.HasPrefix(value, "+") || (len(value) > 1 && value[0] == '0') {
		failure := NewAPIError(CodeRuntimeCommand, &ErrorDetails{Field: field})
		return 0, &failure
	}
	parsed, err := strconv.ParseInt(value, 10, 64)
	if err != nil || parsed <= 0 || strconv.FormatInt(parsed, 10) != value {
		failure := NewAPIError(CodeRuntimeCommand, &ErrorDetails{Field: field})
		return 0, &failure
	}
	return parsed, nil
}

func decimalRuntimeID(value int64) string {
	return strconv.FormatInt(value, 10)
}
