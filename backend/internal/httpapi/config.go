package httpapi

import (
	"context"
	"errors"
	"net/http"
	"strings"

	"github.com/lyming99/autoplan/backend/internal/application"
	applicationconfig "github.com/lyming99/autoplan/backend/internal/application/config"
	domainconfig "github.com/lyming99/autoplan/backend/internal/domain/config"
	"github.com/lyming99/autoplan/backend/internal/domain/contracts"
	domainproject "github.com/lyming99/autoplan/backend/internal/domain/project"
	"github.com/lyming99/autoplan/backend/internal/repository"
)

const ProjectLoopConfigPath = "/api/v1/projects/{project_id}/loop-config"

const (
	AIConfigsPath              = "/api/v1/ai-configs"
	AIConfigPath               = "/api/v1/ai-configs/{ai_config_id}"
	ClaudeCLIConfigsPath       = "/api/v1/claude-cli-configs"
	ClaudeCLIConfigPath        = "/api/v1/claude-cli-configs/{claude_config_id}"
	ClaudeCLIConfigDefaultPath = "/api/v1/claude-cli-configs/{claude_config_id}/default"
	MCPConfigPath              = "/api/v1/mcp-config"
)

type ConfigService interface {
	Get(context.Context, int64, domainproject.Visibility) (contracts.AppSnapshot, error)
	Configure(context.Context, applicationconfig.ConfigureCommand, domainproject.Visibility) (contracts.AppSnapshot, error)
	Reset(context.Context, applicationconfig.ResetCommand, domainproject.Visibility) (contracts.AppSnapshot, error)
}

var _ ConfigService = (*applicationconfig.Service)(nil)

type StaticConfigService interface {
	ListAIConfigs(context.Context) ([]applicationconfig.AIConfigDTO, error)
	CreateAIConfig(context.Context, domainconfig.AIConfigInput) (applicationconfig.AIConfigDTO, error)
	UpdateAIConfig(context.Context, int64, int64, domainconfig.AIConfigInput) (applicationconfig.AIConfigDTO, error)
	DeleteAIConfig(context.Context, int64, int64) error
	ListClaudeCLIConfigs(context.Context) ([]applicationconfig.ClaudeCLIConfigDTO, error)
	CreateClaudeCLIConfig(context.Context, domainconfig.ClaudeCLIConfigInput) (applicationconfig.ClaudeCLIConfigDTO, error)
	UpdateClaudeCLIConfig(context.Context, int64, int64, domainconfig.ClaudeCLIConfigInput) (applicationconfig.ClaudeCLIConfigDTO, error)
	DeleteClaudeCLIConfig(context.Context, int64, int64) error
	SetDefaultClaudeCLIConfig(context.Context, int64, int64) (applicationconfig.ClaudeCLIConfigDTO, error)
	GetMCPConfig(context.Context, map[string]string) (applicationconfig.MCPConfigDTO, error)
	SaveMCPConfig(context.Context, domainconfig.MCPInput) (applicationconfig.MCPConfigDTO, error)
}

var _ StaticConfigService = (*applicationconfig.StaticService)(nil)

type aiConfigRequest struct {
	Name                 *string `json:"name"`
	Provider             *string `json:"provider"`
	BaseURL              *string `json:"base_url"`
	APIKey               *string `json:"api_key"`
	Model                *string `json:"model"`
	Temperature          *string `json:"temperature"`
	ThinkingDepth        *string `json:"thinking_depth"`
	ThinkingBudgetTokens *int64  `json:"thinking_budget_tokens"`
	Version              *int64  `json:"version"`
}

type claudeConfigRequest struct {
	Name      *string `json:"name"`
	BaseURL   *string `json:"base_url"`
	AuthToken *string `json:"auth_token"`
	Model     *string `json:"model"`
	Version   *int64  `json:"version"`
}

type mcpConfigRequest struct {
	Enabled   *bool   `json:"enabled"`
	Transport *string `json:"transport"`
	Host      *string `json:"host"`
	Port      *int64  `json:"port"`
	Path      *string `json:"path"`
	AuthToken *string `json:"auth_token"`
}

type envVarRequest struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

// loopConfigRequest is a complete target representation. Required pointers
// distinguish omitted fields from explicit empty values without transport-side
// merging. Secret-bearing inputs are write-only and never appear in responses.
type loopConfigRequest struct {
	Version           *int64  `json:"version"`
	IntervalSeconds   *int64  `json:"interval_seconds"`
	ValidationCommand *string `json:"validation_command"`
	ProjectPrompt     *string `json:"project_prompt"`
	AgentCLIProvider  *string `json:"agent_cli_provider"`
	AgentCLICommand   *string `json:"agent_cli_command"`

	CodexReasoningEffort *string `json:"codex_reasoning_effort"`

	PlanGenerationStrategy             *string `json:"plan_generation_strategy"`
	PlanGenerationProvider             *string `json:"plan_generation_provider"`
	PlanGenerationCommand              *string `json:"plan_generation_command"`
	PlanGenerationModel                *string `json:"plan_generation_model"`
	PlanGenerationCodexReasoningEffort *string `json:"plan_generation_codex_reasoning_effort"`
	PlanGenerationClaudeBaseURL        *string `json:"plan_generation_claude_base_url"`
	PlanGenerationClaudeAuthToken      *string `json:"plan_generation_claude_auth_token"`
	PlanGenerationClaudeModel          *string `json:"plan_generation_claude_model"`
	PlanGenerationClaudeConfigID       *int64  `json:"plan_generation_claude_config_id"`

	PlanExecutionStrategy             *string `json:"plan_execution_strategy"`
	PlanExecutionProvider             *string `json:"plan_execution_provider"`
	PlanExecutionCommand              *string `json:"plan_execution_command"`
	PlanExecutionModel                *string `json:"plan_execution_model"`
	PlanExecutionCodexReasoningEffort *string `json:"plan_execution_codex_reasoning_effort"`
	PlanExecutionClaudeBaseURL        *string `json:"plan_execution_claude_base_url"`
	PlanExecutionClaudeAuthToken      *string `json:"plan_execution_claude_auth_token"`
	PlanExecutionClaudeModel          *string `json:"plan_execution_claude_model"`
	PlanExecutionClaudeConfigID       *int64  `json:"plan_execution_claude_config_id"`

	EnvVars []envVarRequest `json:"env_vars"`
}

type resetConfigRequest struct {
	Version *int64 `json:"version"`
}

func RegisterConfig(router *Router, security *Security, service ConfigService) error {
	if router == nil || security == nil || service == nil {
		return ErrRouterDependency
	}
	get := security.Protect(TransportREST, getConfigEndpoint(service))
	patch := security.Protect(TransportREST, patchConfigEndpoint(service, router.BodyLimitBytes()))
	reset := security.Protect(TransportREST, resetConfigEndpoint(service, router.BodyLimitBytes()))
	for _, item := range []struct {
		method   string
		endpoint Endpoint
	}{{http.MethodGet, get}, {http.MethodHead, get}, {http.MethodPatch, patch}, {http.MethodDelete, reset}} {
		if err := router.HandlePattern(item.method, ProjectLoopConfigPath, item.endpoint); err != nil {
			return err
		}
	}
	return nil
}

// RegisterStaticConfig registers persisted AI, Claude CLI, and MCP settings.
// It intentionally omits listener start/stop routes and never passes process
// environment values to the MCP configuration service.
func RegisterStaticConfig(router *Router, security *Security, service StaticConfigService) error {
	if router == nil || security == nil || service == nil {
		return ErrRouterDependency
	}
	aiCollection := security.Protect(TransportREST, aiConfigsEndpoint(service, router.BodyLimitBytes()))
	aiItem := security.Protect(TransportREST, aiConfigEndpoint(service, router.BodyLimitBytes()))
	claudeCollection := security.Protect(TransportREST, claudeConfigsEndpoint(service, router.BodyLimitBytes()))
	claudeItem := security.Protect(TransportREST, claudeConfigEndpoint(service, router.BodyLimitBytes()))
	claudeDefault := security.Protect(TransportREST, claudeDefaultEndpoint(service, router.BodyLimitBytes()))
	mcp := security.Protect(TransportREST, mcpConfigEndpoint(service, router.BodyLimitBytes()))
	for _, route := range []struct {
		method, path string
		pattern      bool
		endpoint     Endpoint
	}{
		{http.MethodGet, AIConfigsPath, false, aiCollection}, {http.MethodHead, AIConfigsPath, false, aiCollection}, {http.MethodPost, AIConfigsPath, false, aiCollection},
		{http.MethodGet, AIConfigPath, true, aiItem}, {http.MethodHead, AIConfigPath, true, aiItem}, {http.MethodPatch, AIConfigPath, true, aiItem}, {http.MethodDelete, AIConfigPath, true, aiItem},
		{http.MethodGet, ClaudeCLIConfigsPath, false, claudeCollection}, {http.MethodHead, ClaudeCLIConfigsPath, false, claudeCollection}, {http.MethodPost, ClaudeCLIConfigsPath, false, claudeCollection},
		{http.MethodGet, ClaudeCLIConfigPath, true, claudeItem}, {http.MethodHead, ClaudeCLIConfigPath, true, claudeItem}, {http.MethodPatch, ClaudeCLIConfigPath, true, claudeItem}, {http.MethodDelete, ClaudeCLIConfigPath, true, claudeItem},
		{http.MethodPost, ClaudeCLIConfigDefaultPath, true, claudeDefault}, {http.MethodGet, MCPConfigPath, false, mcp}, {http.MethodHead, MCPConfigPath, false, mcp}, {http.MethodPatch, MCPConfigPath, false, mcp},
	} {
		var err error
		if route.pattern {
			err = router.HandlePattern(route.method, route.path, route.endpoint)
		} else {
			err = router.Handle(route.method, route.path, route.endpoint)
		}
		if err != nil {
			return err
		}
	}
	return nil
}

func aiConfigsEndpoint(service StaticConfigService, bodyLimit int64) Endpoint {
	return func(_ application.Boundary, writer http.ResponseWriter, request *http.Request) {
		switch request.Method {
		case http.MethodGet, http.MethodHead:
			result, err := service.ListAIConfigs(request.Context())
			if err != nil {
				writeStaticConfigError(writer, request, err)
				return
			}
			WriteResponse(writer, request, http.StatusOK, responseEnvelope{Data: result, RequestID: RequestID(request.Context())})
		case http.MethodPost:
			var input aiConfigRequest
			if failure := DecodeJSON(writer, request, &input, bodyLimit); failure != nil {
				WriteError(writer, request, *failure)
				return
			}
			result, err := service.CreateAIConfig(request.Context(), input.value())
			if err != nil {
				writeStaticConfigError(writer, request, err)
				return
			}
			WriteResponse(writer, request, http.StatusCreated, responseEnvelope{Data: result, RequestID: RequestID(request.Context())})
		}
	}
}

func aiConfigEndpoint(service StaticConfigService, bodyLimit int64) Endpoint {
	return func(_ application.Boundary, writer http.ResponseWriter, request *http.Request) {
		id, failure := staticConfigID(request.URL.Path, "ai-configs", "ai_config_id")
		if failure != nil {
			WriteError(writer, request, *failure)
			return
		}
		switch request.Method {
		case http.MethodGet, http.MethodHead:
			configs, err := service.ListAIConfigs(request.Context())
			if err != nil {
				writeStaticConfigError(writer, request, err)
				return
			}
			for _, item := range configs {
				if item.ID == id {
					WriteResponse(writer, request, http.StatusOK, responseEnvelope{Data: item, RequestID: RequestID(request.Context())})
					return
				}
			}
			WriteError(writer, request, NewAPIError(CodeConfigNotFound, nil))
		case http.MethodPatch:
			var input aiConfigRequest
			if failure := DecodeJSON(writer, request, &input, bodyLimit); failure != nil {
				WriteError(writer, request, *failure)
				return
			}
			if input.Version == nil || *input.Version <= 0 {
				WriteError(writer, request, NewAPIError(CodeVersionRequired, &ErrorDetails{Field: "version"}))
				return
			}
			result, err := service.UpdateAIConfig(request.Context(), id, *input.Version, input.value())
			if err != nil {
				writeStaticConfigError(writer, request, err)
				return
			}
			WriteResponse(writer, request, http.StatusOK, responseEnvelope{Data: result, RequestID: RequestID(request.Context())})
		case http.MethodDelete:
			version, failure := expectedVersion(request.URL)
			if failure != nil {
				WriteError(writer, request, *failure)
				return
			}
			if err := service.DeleteAIConfig(request.Context(), id, version); err != nil {
				writeStaticConfigError(writer, request, err)
				return
			}
			WriteResponse(writer, request, http.StatusOK, responseEnvelope{Data: map[string]bool{"deleted": true}, RequestID: RequestID(request.Context())})
		}
	}
}

func claudeConfigsEndpoint(service StaticConfigService, bodyLimit int64) Endpoint {
	return func(_ application.Boundary, writer http.ResponseWriter, request *http.Request) {
		switch request.Method {
		case http.MethodGet, http.MethodHead:
			result, err := service.ListClaudeCLIConfigs(request.Context())
			if err != nil {
				writeStaticConfigError(writer, request, err)
				return
			}
			WriteResponse(writer, request, http.StatusOK, responseEnvelope{Data: result, RequestID: RequestID(request.Context())})
		case http.MethodPost:
			var input claudeConfigRequest
			if failure := DecodeJSON(writer, request, &input, bodyLimit); failure != nil {
				WriteError(writer, request, *failure)
				return
			}
			result, err := service.CreateClaudeCLIConfig(request.Context(), input.value())
			if err != nil {
				writeStaticConfigError(writer, request, err)
				return
			}
			WriteResponse(writer, request, http.StatusCreated, responseEnvelope{Data: result, RequestID: RequestID(request.Context())})
		}
	}
}

func claudeConfigEndpoint(service StaticConfigService, bodyLimit int64) Endpoint {
	return func(_ application.Boundary, writer http.ResponseWriter, request *http.Request) {
		id, failure := staticConfigID(request.URL.Path, "claude-cli-configs", "claude_config_id")
		if failure != nil {
			WriteError(writer, request, *failure)
			return
		}
		switch request.Method {
		case http.MethodGet, http.MethodHead:
			configs, err := service.ListClaudeCLIConfigs(request.Context())
			if err != nil {
				writeStaticConfigError(writer, request, err)
				return
			}
			for _, item := range configs {
				if item.ID == id {
					WriteResponse(writer, request, http.StatusOK, responseEnvelope{Data: item, RequestID: RequestID(request.Context())})
					return
				}
			}
			WriteError(writer, request, NewAPIError(CodeConfigNotFound, nil))
		case http.MethodPatch:
			var input claudeConfigRequest
			if failure := DecodeJSON(writer, request, &input, bodyLimit); failure != nil {
				WriteError(writer, request, *failure)
				return
			}
			if input.Version == nil || *input.Version <= 0 {
				WriteError(writer, request, NewAPIError(CodeVersionRequired, &ErrorDetails{Field: "version"}))
				return
			}
			result, err := service.UpdateClaudeCLIConfig(request.Context(), id, *input.Version, input.value())
			if err != nil {
				writeStaticConfigError(writer, request, err)
				return
			}
			WriteResponse(writer, request, http.StatusOK, responseEnvelope{Data: result, RequestID: RequestID(request.Context())})
		case http.MethodDelete:
			version, failure := expectedVersion(request.URL)
			if failure != nil {
				WriteError(writer, request, *failure)
				return
			}
			if err := service.DeleteClaudeCLIConfig(request.Context(), id, version); err != nil {
				writeStaticConfigError(writer, request, err)
				return
			}
			WriteResponse(writer, request, http.StatusOK, responseEnvelope{Data: map[string]bool{"deleted": true}, RequestID: RequestID(request.Context())})
		}
	}
}

func claudeDefaultEndpoint(service StaticConfigService, bodyLimit int64) Endpoint {
	return func(_ application.Boundary, writer http.ResponseWriter, request *http.Request) {
		id, failure := staticConfigID(strings.TrimSuffix(request.URL.Path, "/default"), "claude-cli-configs", "claude_config_id")
		if failure != nil {
			WriteError(writer, request, *failure)
			return
		}
		var input struct {
			Version *int64 `json:"version"`
		}
		if failure := DecodeJSON(writer, request, &input, bodyLimit); failure != nil {
			WriteError(writer, request, *failure)
			return
		}
		if input.Version == nil || *input.Version <= 0 {
			WriteError(writer, request, NewAPIError(CodeVersionRequired, &ErrorDetails{Field: "version"}))
			return
		}
		result, err := service.SetDefaultClaudeCLIConfig(request.Context(), id, *input.Version)
		if err != nil {
			writeStaticConfigError(writer, request, err)
			return
		}
		WriteResponse(writer, request, http.StatusOK, responseEnvelope{Data: result, RequestID: RequestID(request.Context())})
	}
}

func mcpConfigEndpoint(service StaticConfigService, bodyLimit int64) Endpoint {
	return func(_ application.Boundary, writer http.ResponseWriter, request *http.Request) {
		switch request.Method {
		case http.MethodGet, http.MethodHead:
			result, err := service.GetMCPConfig(request.Context(), nil)
			if err != nil {
				writeStaticConfigError(writer, request, err)
				return
			}
			WriteResponse(writer, request, http.StatusOK, responseEnvelope{Data: result, RequestID: RequestID(request.Context())})
		case http.MethodPatch:
			var input mcpConfigRequest
			if failure := DecodeJSON(writer, request, &input, bodyLimit); failure != nil {
				WriteError(writer, request, *failure)
				return
			}
			result, err := service.SaveMCPConfig(request.Context(), domainconfig.MCPInput{Enabled: input.Enabled, Transport: input.Transport, Host: input.Host, Port: input.Port, Path: input.Path, AuthToken: input.AuthToken})
			if err != nil {
				writeStaticConfigError(writer, request, err)
				return
			}
			WriteResponse(writer, request, http.StatusOK, responseEnvelope{Data: result, RequestID: RequestID(request.Context())})
		}
	}
}

func (input aiConfigRequest) value() domainconfig.AIConfigInput {
	return domainconfig.AIConfigInput{Name: input.Name, Provider: input.Provider, BaseURL: input.BaseURL, APIKey: input.APIKey, Model: input.Model, Temperature: input.Temperature, ThinkingDepth: input.ThinkingDepth, ThinkingBudgetTokens: input.ThinkingBudgetTokens}
}
func (input claudeConfigRequest) value() domainconfig.ClaudeCLIConfigInput {
	return domainconfig.ClaudeCLIConfigInput{Name: input.Name, BaseURL: input.BaseURL, AuthToken: input.AuthToken, Model: input.Model}
}

func staticConfigID(path, collection, field string) (int64, *APIError) {
	segments := strings.Split(strings.TrimPrefix(path, "/api/v1/"), "/")
	if len(segments) != 2 || segments[0] != collection {
		failure := NewAPIError(CodeNotFound, nil)
		return 0, &failure
	}
	id, valid := parseCanonicalPositiveID(segments[1])
	if !valid {
		failure := NewAPIError(CodeInvalidConfig, &ErrorDetails{Field: field})
		return 0, &failure
	}
	return id, nil
}

func writeStaticConfigError(writer http.ResponseWriter, request *http.Request, err error) {
	if errors.Is(err, applicationconfig.ErrStaticInvalidCommand) || errors.Is(err, domainconfig.ErrInvalidAIConfig) || errors.Is(err, domainconfig.ErrInvalidClaudeConfig) || errors.Is(err, domainconfig.ErrInvalidMCPConfig) {
		WriteError(writer, request, NewAPIError(CodeInvalidConfig, nil))
		return
	}
	if errors.Is(err, applicationconfig.ErrStaticConflict) || errors.Is(err, repository.ErrVersionConflict) {
		WriteError(writer, request, NewAPIError(CodePreconditionFailed, nil))
		return
	}
	if errors.Is(err, repository.ErrNotFound) {
		WriteError(writer, request, NewAPIError(CodeConfigNotFound, nil))
		return
	}
	if errors.Is(err, applicationconfig.ErrStaticUnavailable) {
		WriteError(writer, request, NewAPIError(CodeRepositoryUnavailable, nil))
		return
	}
	writeConfigServiceError(writer, request, err)
}

func getConfigEndpoint(service ConfigService) Endpoint {
	return func(_ application.Boundary, writer http.ResponseWriter, request *http.Request) {
		projectID, failure := projectIDFromConfigPath(request.URL.Path)
		if failure != nil {
			WriteError(writer, request, *failure)
			return
		}
		snapshot, err := service.Get(request.Context(), projectID, authorizedProjectVisibility(request))
		if err != nil {
			writeConfigServiceError(writer, request, err)
			return
		}
		WriteResponse(writer, request, http.StatusOK, responseEnvelope{Data: snapshot, RequestID: RequestID(request.Context())})
	}
}

func patchConfigEndpoint(service ConfigService, bodyLimit int64) Endpoint {
	return func(_ application.Boundary, writer http.ResponseWriter, request *http.Request) {
		projectID, failure := projectIDFromConfigPath(request.URL.Path)
		if failure != nil {
			WriteError(writer, request, *failure)
			return
		}
		metadata, failure := mutationRequestContext(request)
		if failure != nil {
			WriteError(writer, request, *failure)
			return
		}
		var input loopConfigRequest
		if failure := DecodeJSON(writer, request, &input, bodyLimit); failure != nil {
			WriteError(writer, request, *failure)
			return
		}
		if input.Version == nil || *input.Version <= 0 {
			WriteError(writer, request, NewAPIError(CodeVersionRequired, &ErrorDetails{Field: "version"}))
			return
		}
		version, value, valid := input.domainValue()
		if !valid {
			WriteError(writer, request, NewAPIError(CodeInvalidConfig, nil))
			return
		}
		snapshot, err := service.Configure(request.Context(), applicationconfig.ConfigureCommand{
			ProjectID: projectID, ExpectedVersion: version, Config: value,
			Metadata: applicationconfig.MutationMetadata{
				CallerScope: metadata.CallerScope, IdempotencyKey: metadata.IdempotencyKey, RequestID: metadata.RequestID,
			},
		}, authorizedProjectVisibility(request))
		if err != nil {
			writeConfigServiceError(writer, request, err)
			return
		}
		WriteResponse(writer, request, http.StatusOK, responseEnvelope{Data: snapshot, RequestID: RequestID(request.Context())})
	}
}

func resetConfigEndpoint(service ConfigService, bodyLimit int64) Endpoint {
	return func(_ application.Boundary, writer http.ResponseWriter, request *http.Request) {
		projectID, failure := projectIDFromConfigPath(request.URL.Path)
		if failure != nil {
			WriteError(writer, request, *failure)
			return
		}
		metadata, failure := mutationRequestContext(request)
		if failure != nil {
			WriteError(writer, request, *failure)
			return
		}
		var input resetConfigRequest
		if failure := DecodeJSON(writer, request, &input, bodyLimit); failure != nil {
			WriteError(writer, request, *failure)
			return
		}
		if input.Version == nil || *input.Version <= 0 {
			WriteError(writer, request, NewAPIError(CodeVersionRequired, &ErrorDetails{Field: "version"}))
			return
		}
		snapshot, err := service.Reset(request.Context(), applicationconfig.ResetCommand{
			ProjectID: projectID, ExpectedVersion: *input.Version,
			Metadata: applicationconfig.MutationMetadata{
				CallerScope: metadata.CallerScope, IdempotencyKey: metadata.IdempotencyKey, RequestID: metadata.RequestID,
			},
		}, authorizedProjectVisibility(request))
		if err != nil {
			writeConfigServiceError(writer, request, err)
			return
		}
		WriteResponse(writer, request, http.StatusOK, responseEnvelope{Data: snapshot, RequestID: RequestID(request.Context())})
	}
}

func (input loopConfigRequest) domainValue() (int64, domainconfig.LoopConfig, bool) {
	if input.Version == nil || *input.Version <= 0 || input.IntervalSeconds == nil || *input.IntervalSeconds <= 0 ||
		input.ValidationCommand == nil || input.ProjectPrompt == nil || input.AgentCLIProvider == nil || input.AgentCLICommand == nil ||
		input.PlanGenerationStrategy == nil || input.PlanGenerationCommand == nil || input.PlanGenerationModel == nil ||
		input.PlanExecutionStrategy == nil || input.PlanExecutionCommand == nil || input.PlanExecutionModel == nil ||
		!validLoopConfigShape(input) {
		return 0, domainconfig.LoopConfig{}, false
	}
	value := domainconfig.LoopConfig{
		IntervalSeconds: *input.IntervalSeconds, ValidationCommand: *input.ValidationCommand,
		ProjectPrompt: *input.ProjectPrompt, AgentCLIProvider: *input.AgentCLIProvider, AgentCLICommand: *input.AgentCLICommand,
		CodexReasoningEffort:   input.CodexReasoningEffort,
		PlanGenerationStrategy: *input.PlanGenerationStrategy, PlanGenerationProvider: input.PlanGenerationProvider,
		PlanGenerationCommand: *input.PlanGenerationCommand, PlanGenerationModel: *input.PlanGenerationModel,
		PlanGenerationCodexReasoningEffort: input.PlanGenerationCodexReasoningEffort,
		PlanExecutionStrategy:              inputValue(input.PlanExecutionStrategy), PlanExecutionProvider: input.PlanExecutionProvider,
		PlanExecutionCommand: inputValue(input.PlanExecutionCommand), PlanExecutionModel: inputValue(input.PlanExecutionModel),
		PlanExecutionCodexReasoningEffort: input.PlanExecutionCodexReasoningEffort,
	}
	assignOptionalConfig(&value, input)
	entries := make([]domainconfig.EnvVar, len(input.EnvVars))
	for index, entry := range input.EnvVars {
		entries[index] = domainconfig.EnvVar{Name: entry.Name, Value: entry.Value}
	}
	if len(entries) > 0 {
		value.EnvVars = domainconfig.NormalizeEnvVars(entries)
		if value.EnvVars == "" {
			return 0, domainconfig.LoopConfig{}, false
		}
	}
	normalized, err := domainconfig.NormalizeLoopConfig(value)
	return *input.Version, normalized, err == nil
}

func validLoopConfigShape(input loopConfigRequest) bool {
	if !oneOf(*input.AgentCLIProvider, "codex", "claude", "opencode", "oh-my-pi") ||
		!oneOf(*input.PlanGenerationStrategy, "external-cli-markdown", "external-cli-structured", "builtin-llm-structured") ||
		!oneOf(*input.PlanExecutionStrategy, "external-cli", "builtin-llm") ||
		!validPlanProvider(input.PlanGenerationProvider, *input.PlanGenerationStrategy) ||
		!validPlanProvider(input.PlanExecutionProvider, *input.PlanExecutionStrategy) ||
		!validEffort(input.CodexReasoningEffort) || !validEffort(input.PlanGenerationCodexReasoningEffort) ||
		!validEffort(input.PlanExecutionCodexReasoningEffort) || len(*input.ValidationCommand) > 65536 ||
		len(*input.ProjectPrompt) > 1000000 || len(*input.AgentCLICommand) > 65536 ||
		len(*input.PlanGenerationCommand) > 65536 || len(*input.PlanExecutionCommand) > 65536 ||
		len(*input.PlanGenerationModel) > 4096 || len(*input.PlanExecutionModel) > 4096 ||
		len(inputValue(input.PlanGenerationClaudeBaseURL)) > 8192 || len(inputValue(input.PlanExecutionClaudeBaseURL)) > 8192 ||
		len(inputValue(input.PlanGenerationClaudeAuthToken)) > 65536 || len(inputValue(input.PlanExecutionClaudeAuthToken)) > 65536 ||
		len(inputValue(input.PlanGenerationClaudeModel)) > 4096 || len(inputValue(input.PlanExecutionClaudeModel)) > 4096 ||
		inputInt64(input.PlanGenerationClaudeConfigID) < 0 || inputInt64(input.PlanExecutionClaudeConfigID) < 0 ||
		len(input.EnvVars) > 256 {
		return false
	}
	seen := make(map[string]struct{}, len(input.EnvVars))
	for _, entry := range input.EnvVars {
		name := strings.TrimSpace(entry.Name)
		if name == "" || len(name) > 256 || len(entry.Value) > 65536 {
			return false
		}
		if _, duplicate := seen[name]; duplicate {
			return false
		}
		seen[name] = struct{}{}
	}
	return true
}

func validEffort(value *string) bool {
	return value == nil || oneOf(*value, "low", "medium", "high", "xhigh")
}

func validPlanProvider(value *string, strategy string) bool {
	if value == nil || strings.TrimSpace(*value) == "" {
		return true
	}
	if strategy == "builtin-llm" || strategy == "builtin-llm-structured" {
		return oneOf(*value, "openai", "deepseek", "anthropic")
	}
	return oneOf(*value, "codex", "claude", "opencode", "oh-my-pi")
}

func oneOf(value string, allowed ...string) bool {
	for _, candidate := range allowed {
		if value == candidate {
			return true
		}
	}
	return false
}

func assignOptionalConfig(value *domainconfig.LoopConfig, input loopConfigRequest) {
	value.PlanGenerationClaudeBaseURL = inputValue(input.PlanGenerationClaudeBaseURL)
	value.PlanGenerationClaudeAuthToken = inputValue(input.PlanGenerationClaudeAuthToken)
	value.PlanGenerationClaudeModel = inputValue(input.PlanGenerationClaudeModel)
	value.PlanGenerationClaudeConfigID = inputInt64(input.PlanGenerationClaudeConfigID)
	value.PlanExecutionClaudeBaseURL = inputValue(input.PlanExecutionClaudeBaseURL)
	value.PlanExecutionClaudeAuthToken = inputValue(input.PlanExecutionClaudeAuthToken)
	value.PlanExecutionClaudeModel = inputValue(input.PlanExecutionClaudeModel)
	value.PlanExecutionClaudeConfigID = inputInt64(input.PlanExecutionClaudeConfigID)
}

func inputValue(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func inputInt64(value *int64) int64 {
	if value == nil {
		return 0
	}
	return *value
}

func projectIDFromConfigPath(path string) (int64, *APIError) {
	if !strings.HasSuffix(path, "/loop-config") {
		failure := NewAPIError(CodeInvalidProjectID, &ErrorDetails{Field: "project_id"})
		return 0, &failure
	}
	trimmed := strings.TrimSuffix(path, "/loop-config")
	return projectIDFromPath(trimmed, false)
}

func writeConfigServiceError(writer http.ResponseWriter, request *http.Request, err error) {
	if errors.Is(err, domainconfig.ErrInvalid) || errors.Is(err, repository.ErrSettingNotWritable) {
		WriteError(writer, request, NewAPIError(CodeInvalidConfig, nil))
		return
	}
	writeProjectServiceError(writer, request, err)
}
