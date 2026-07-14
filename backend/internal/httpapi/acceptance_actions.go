package httpapi

import (
	"net/http"
	"strings"

	applicationloop "github.com/lyming99/autoplan/backend/internal/application/loop"
)

const (
	AcceptanceAcceptActionPath        = "/api/v1/projects/{project_id}/acceptance/actions/accept"
	AcceptanceUnacceptActionPath      = "/api/v1/projects/{project_id}/acceptance/actions/unaccept"
	AcceptanceRedoActionPath          = "/api/v1/projects/{project_id}/acceptance/actions/redo"
	AcceptanceAcceptBatchActionPath   = "/api/v1/projects/{project_id}/acceptance/actions/accept-batch"
	AcceptanceUnacceptBatchActionPath = "/api/v1/projects/{project_id}/acceptance/actions/unaccept-batch"
)

type acceptanceTargetRequest struct {
	TargetType string `json:"target_type"`
	ID         int64  `json:"id"`
	Supplement string `json:"supplement,omitempty"`
}

type acceptanceTargetsRequest struct {
	Targets []acceptanceTargetRequest `json:"targets"`
}

func RegisterAcceptanceActionRoutes(router *Router, security *Security, service RuntimeActionService) error {
	if router == nil || security == nil || service == nil {
		return ErrRouterDependency
	}
	for _, route := range []struct {
		path string
		kind applicationloop.CommandKind
	}{
		{AcceptanceAcceptActionPath, applicationloop.CommandAcceptanceAccept},
		{AcceptanceUnacceptActionPath, applicationloop.CommandAcceptanceUnaccept},
		{AcceptanceRedoActionPath, applicationloop.CommandAcceptanceRedo},
	} {
		kind := route.kind
		if err := router.HandlePattern(http.MethodPost, route.path, security.Protect(TransportREST,
			runtimeActionEndpoint(service, router.BodyLimitBytes(), func(writer http.ResponseWriter, request *http.Request, projectID int64) (applicationloop.Command, *APIError) {
				var input acceptanceTargetRequest
				if failure := DecodeJSON(writer, request, &input, router.BodyLimitBytes()); failure != nil {
					return applicationloop.Command{}, failure
				}
				if !validAcceptanceTarget(input) || (kind != applicationloop.CommandAcceptanceRedo && input.Supplement != "") || len([]rune(input.Supplement)) > 2000 {
					failure := NewAPIError(CodeRuntimeCommand, &ErrorDetails{Field: "target"})
					return applicationloop.Command{}, &failure
				}
				return acceptanceCommand(kind, projectID, input), nil
			}),
		)); err != nil {
			return err
		}
	}
	for _, route := range []struct {
		path string
		kind applicationloop.CommandKind
	}{
		{AcceptanceAcceptBatchActionPath, applicationloop.CommandAcceptanceAcceptBatch},
		{AcceptanceUnacceptBatchActionPath, applicationloop.CommandAcceptanceUnacceptBatch},
	} {
		kind := route.kind
		if err := router.HandlePattern(http.MethodPost, route.path, security.Protect(TransportREST,
			runtimeActionEndpoint(service, router.BodyLimitBytes(), func(writer http.ResponseWriter, request *http.Request, projectID int64) (applicationloop.Command, *APIError) {
				var input acceptanceTargetsRequest
				if failure := DecodeJSON(writer, request, &input, router.BodyLimitBytes()); failure != nil {
					return applicationloop.Command{}, failure
				}
				if len(input.Targets) == 0 || len(input.Targets) > 100 {
					failure := NewAPIError(CodeRuntimeCommand, &ErrorDetails{Field: "targets"})
					return applicationloop.Command{}, &failure
				}
				for _, target := range input.Targets {
					if !validAcceptanceTarget(target) || target.Supplement != "" {
						failure := NewAPIError(CodeRuntimeCommand, &ErrorDetails{Field: "targets"})
						return applicationloop.Command{}, &failure
					}
				}
				return acceptanceBatchCommand(kind, projectID, input), nil
			}),
		)); err != nil {
			return err
		}
	}
	return nil
}

func acceptanceBatchCommand(kind applicationloop.CommandKind, projectID int64, input acceptanceTargetsRequest) applicationloop.Command {
	targets := make([]applicationloop.AcceptanceTarget, 0, len(input.Targets))
	for _, target := range input.Targets {
		targets = append(targets, applicationloop.AcceptanceTarget{TargetType: target.TargetType, ID: target.ID})
	}
	return applicationloop.Command{Kind: kind, ProjectID: projectID,
		Acceptance: &applicationloop.AcceptanceInput{Targets: targets}}
}

func acceptanceCommand(kind applicationloop.CommandKind, projectID int64, input acceptanceTargetRequest) applicationloop.Command {
	return applicationloop.Command{Kind: kind, ProjectID: projectID, Acceptance: &applicationloop.AcceptanceInput{
		Targets:    []applicationloop.AcceptanceTarget{{TargetType: input.TargetType, ID: input.ID}},
		Supplement: input.Supplement,
	}}
}

func validAcceptanceTarget(input acceptanceTargetRequest) bool {
	return input.ID > 0 && (input.TargetType == "plan" || input.TargetType == "task") &&
		!strings.ContainsAny(input.Supplement, "\x00\r")
}
