package httpapi

import (
	"context"
	"errors"
	"net/http"

	"github.com/lyming99/autoplan/backend/internal/application"
	applicationloop "github.com/lyming99/autoplan/backend/internal/application/loop"
)

const RuntimeBridgePath = "/api/v1/runtime/commands"

// RuntimeBridgeService is shared by REST, MCP and the future Node bridge. It
// accepts only the closed application DTO, not a repository, SQL string or
// process command.
type RuntimeBridgeService interface {
	Execute(context.Context, applicationloop.Command) (applicationloop.Result, error)
}

var _ RuntimeBridgeService = (*applicationloop.Bridge)(nil)

type runtimeBridgeEnvelope struct {
	Data      applicationloop.Result `json:"data"`
	RequestID string                 `json:"request_id"`
}

func RegisterRuntimeBridge(router *Router, security *Security, service RuntimeBridgeService) error {
	if router == nil || security == nil || service == nil {
		return ErrRouterDependency
	}
	if err := router.Handle(http.MethodPost, RuntimeBridgePath, security.Protect(
		TransportREST,
		runtimeBridgeEndpoint(service, router.BodyLimitBytes()),
	)); err != nil {
		return err
	}
	// The generic bridge remains available for the compatibility client. New
	// resource routes are registered with the same service so REST never gains
	// a transport-specific dispatcher or business-rule fork.
	return RegisterRuntimeActionRoutes(router, security, service)
}

func runtimeBridgeEndpoint(service RuntimeBridgeService, bodyLimit int64) Endpoint {
	return func(_ application.Boundary, writer http.ResponseWriter, request *http.Request) {
		metadata, failure := mutationRequestContext(request)
		if failure != nil {
			WriteError(writer, request, *failure)
			return
		}
		var command applicationloop.Command
		if failure := DecodeJSON(writer, request, &command, bodyLimit); failure != nil {
			WriteError(writer, request, *failure)
			return
		}
		command.CallerScope = metadata.CallerScope
		command.RequestID = metadata.RequestID
		command.IdempotencyKey = metadata.IdempotencyKey
		result, err := service.Execute(request.Context(), command)
		if err != nil {
			writeRuntimeBridgeError(writer, request, err)
			return
		}
		WriteResponse(writer, request, http.StatusAccepted, runtimeBridgeEnvelope{Data: result, RequestID: RequestID(request.Context())})
	}
}

func writeRuntimeBridgeError(writer http.ResponseWriter, request *http.Request, err error) {
	code := CodeInternal
	switch {
	case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded):
		code = CodeRequestTimeout
	case errors.Is(err, applicationloop.ErrInvalidCommand), errors.Is(err, applicationloop.ErrUnsupportedCommand):
		code = CodeRuntimeCommand
	case errors.Is(err, applicationloop.ErrStateConflict):
		code = CodePreconditionFailed
	case errors.Is(err, applicationloop.ErrNotFound):
		code = CodeNotFound
	case errors.Is(err, applicationloop.ErrRepositoryUnavailable):
		code = CodeRepositoryUnavailable
	case errors.Is(err, applicationloop.ErrCancellationFailed):
		code = CodeOperationCancelled
	case errors.Is(err, applicationloop.ErrCancelled):
		code = CodeOperationCancelled
	case errors.Is(err, applicationloop.ErrUnavailable):
		code = CodeServiceUnavailable
	}
	WriteError(writer, request, NewAPIError(code, nil))
}
