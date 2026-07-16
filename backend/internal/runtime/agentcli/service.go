package agentcli

import (
	"context"
	"errors"
	"strconv"
	"time"

	filesapp "github.com/lyming99/autoplan/backend/internal/application/files"
	secretsapp "github.com/lyming99/autoplan/backend/internal/application/secrets"
	domainmodelusage "github.com/lyming99/autoplan/backend/internal/domain/modelusage"
	domainsecrets "github.com/lyming99/autoplan/backend/internal/domain/secrets"
	platformsecrets "github.com/lyming99/autoplan/backend/internal/platform/secrets"
	"github.com/lyming99/autoplan/backend/internal/runtime/process"
)

// ProcessExecutor is the P003 runner's non-interactive surface.
type ProcessExecutor interface {
	Run(context.Context, process.Spec) (process.Result, error)
}

// InputProcessExecutor is the stdin-capable P003 runner adapter. The input is
// written directly to the child stdin, is never copied into Spec or Result,
// and must use the same Process Runner lifecycle/cleanup behavior.
type InputProcessExecutor interface {
	RunWithInput(context.Context, process.Spec, []byte) (process.Result, error)
}

// SecretResolver is implemented by application/secrets.Service. It returns an
// opaque secret binding only for internal runtime use.
type SecretResolver interface {
	ResolveEnvironmentBinding(context.Context, secretsapp.EnvironmentBindingRequest) (platformsecrets.EnvironmentBinding, error)
}

type Dependencies struct {
	Runner      ProcessExecutor
	InputRunner InputProcessExecutor
	Secrets     SecretResolver
	Artifacts   ArtifactWriter
	Providers   []Adapter
}

type Service struct {
	runner      ProcessExecutor
	inputRunner InputProcessExecutor
	secrets     SecretResolver
	artifacts   ArtifactWriter
	providers   map[Provider]Adapter
}

// Result is safe runtime metadata. It intentionally excludes the launch
// command, args, cwd, prompt, environment, raw output and artifact paths.
type Result struct {
	Provider            Provider
	ExitCode            int
	TimedOut            bool
	Cancelled           bool
	OutputTruncated     bool
	Session             Session
	SessionLookupFailed bool
	Summary             string
	Usage               *domainmodelusage.Tokens
}

type attempt struct {
	prepared Prepared
	raw      process.Result
	parsed   parsedOutput
	err      error
}

func NewService(dependencies Dependencies) (*Service, error) {
	if dependencies.Runner == nil {
		return nil, ErrUnavailable
	}
	providers := dependencies.Providers
	if len(providers) == 0 {
		providers = []Adapter{codexAdapter{}, claudeAdapter{}, openCodeAdapter{}, ohMyPiAdapter{}}
	}
	items := make(map[Provider]Adapter, len(providers))
	for _, adapter := range providers {
		if adapter == nil || !adapter.Provider().Valid() {
			return nil, ErrUnavailable
		}
		if _, duplicate := items[adapter.Provider()]; duplicate {
			return nil, ErrUnavailable
		}
		items[adapter.Provider()] = adapter
	}
	for _, provider := range []Provider{ProviderCodex, ProviderClaude, ProviderOpenCode, ProviderOhMyPi} {
		if items[provider] == nil {
			return nil, ErrUnavailable
		}
	}
	return &Service{
		runner: dependencies.Runner, inputRunner: dependencies.InputRunner, secrets: dependencies.Secrets,
		artifacts: dependencies.Artifacts, providers: items,
	}, nil
}

func (service *Service) Run(ctx context.Context, request Request) (Result, error) {
	if service == nil || service.runner == nil {
		return Result{}, ErrUnavailable
	}
	if !validRequest(request) {
		return Result{}, ErrInvalidRequest
	}
	if ctx == nil {
		ctx = context.Background()
	}
	adapter := service.providers[request.Provider]
	if adapter == nil {
		return Result{}, ErrUnknownProvider
	}
	request.Timeout = effectiveTimeout(request.Timeout)
	first := service.execute(ctx, adapter, request)
	result := resultFromAttempt(request.Provider, first)
	if first.err != nil {
		return result, first.err
	}
	if !shouldFallback(first) {
		if request.Provider == ProviderOpenCode && first.raw.ExitCode == 0 && !first.raw.TimedOut && !first.raw.Cancelled {
			service.lookupOpenCodeSession(ctx, request, &result)
		}
		return result, nil
	}

	fallback := request
	fallback.Session = fallbackSession(first.prepared.Session)
	second := service.execute(ctx, adapter, fallback)
	result = resultFromAttempt(request.Provider, second)
	result.Session.Fallback = true
	result.Session.RequestedID = fallback.Session.RequestedID
	result.Session.State = "fallback-new"
	if second.err != nil {
		return result, second.err
	}
	if request.Provider == ProviderOpenCode && second.raw.ExitCode == 0 && !second.raw.TimedOut && !second.raw.Cancelled {
		service.lookupOpenCodeSession(ctx, fallback, &result)
	}
	return result, nil
}

func (service *Service) execute(ctx context.Context, adapter Adapter, request Request) attempt {
	if request.Provider == ProviderCodex {
		if service.artifacts == nil || service.artifacts.AuthorizeAgentOutput(ctx, request.Workspace, request.LastOutputFile) != nil {
			return attempt{err: ErrControlledArtifact}
		}
	}
	prepared, err := adapter.Prepare(ctx, request, service.artifacts)
	if err != nil {
		return attempt{err: err}
	}
	spec, err := service.processSpec(ctx, request, prepared)
	if err != nil {
		return service.finishAttempt(prepared, attempt{prepared: prepared, err: err})
	}
	var raw process.Result
	if prepared.PromptMode == PromptStdin {
		if service.inputRunner == nil {
			return service.finishAttempt(prepared, attempt{prepared: prepared, err: ErrPromptTransport})
		}
		raw, err = service.inputRunner.RunWithInput(ctx, spec, []byte(prepared.Prompt))
	} else {
		raw, err = service.runner.Run(ctx, spec)
	}
	result := attempt{prepared: prepared, raw: raw, err: mapExecutionError(err, raw)}
	if result.err != nil {
		return service.finishAttempt(prepared, result)
	}
	result.parsed = parseOutput(request.Provider, prepared.Parser, raw)
	if result.parsed.ParseFailed && raw.ExitCode == 0 {
		result.err = ErrOutputParse
	}
	return service.finishAttempt(prepared, result)
}

func (service *Service) finishAttempt(prepared Prepared, current attempt) attempt {
	if prepared.Cleanup == nil {
		return current
	}
	cleanup, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := prepared.Cleanup(cleanup); err != nil && current.err == nil {
		current.err = ErrControlledArtifact
	}
	return current
}

func (service *Service) processSpec(ctx context.Context, request Request, prepared Prepared) (process.Spec, error) {
	spec := process.Spec{
		ProjectID: request.ProjectID, Workspace: request.Workspace, WorkingDirectory: request.WorkingDirectory,
		Executable: prepared.Executable, Args: copyArguments(prepared.Arguments), Environment: prepared.Environment,
		Timeout: request.Timeout,
	}
	if request.Provider != ProviderClaude || request.ClaudeAuthToken == nil {
		return spec, nil
	}
	if service.secrets == nil || !validClaudeTokenKind(request.ClaudeAuthToken.Kind) {
		return process.Spec{}, ErrIncompleteConfig
	}
	binding, err := service.secrets.ResolveEnvironmentBinding(ctx, secretsapp.EnvironmentBindingRequest{
		Name: "ANTHROPIC_AUTH_TOKEN", Kind: request.ClaudeAuthToken.Kind, Owner: request.ClaudeAuthToken.Owner,
	})
	if err != nil {
		return process.Spec{}, ErrIncompleteConfig
	}
	spec.SecretEnvironment = []process.SecretEnvironment{{Name: binding.Name, Binding: binding.Binding, Reference: binding.Reference}}
	return spec, nil
}

func validClaudeTokenKind(kind domainsecrets.Kind) bool {
	switch kind {
	case domainsecrets.KindClaudeCLIAuthToken, domainsecrets.KindPlanGenerationClaudeAuthToken, domainsecrets.KindPlanExecutionClaudeAuthToken:
		return true
	default:
		return false
	}
}

func (service *Service) lookupOpenCodeSession(ctx context.Context, request Request, result *Result) {
	if result == nil || result.Session.Title == "" {
		return
	}
	command, err := resolvedCommand(ProviderOpenCode, request.Command)
	if err != nil {
		result.SessionLookupFailed = true
		return
	}
	timeout := request.Timeout
	if timeout > 15*time.Second {
		timeout = 15 * time.Second
	}
	lookup := process.Spec{
		ProjectID: request.ProjectID, Workspace: request.Workspace, WorkingDirectory: request.WorkingDirectory,
		Executable: command,
		Args:       []string{"session", "list", "--format", "json", "--max-count", strconv.Itoa(maximumSessionLookup)},
		Timeout:    timeout,
	}
	raw, runErr := service.runner.Run(ctx, lookup)
	if runErr != nil {
		result.SessionLookupFailed = true
		return
	}
	if sessionID, parsed := parseOpenCodeSessions(raw, result.Session.Title); parsed {
		result.Session.ID = sessionID
	} else {
		result.SessionLookupFailed = true
	}
}

func shouldFallback(current attempt) bool {
	if current.err != nil || current.raw.ExitCode == 0 || current.raw.TimedOut || current.raw.Cancelled || current.prepared.Session.Mode != SessionResume {
		return false
	}
	return current.parsed.SessionID == "" && current.parsed.SessionMissing
}

func resultFromAttempt(provider Provider, current attempt) Result {
	result := Result{Provider: provider, ExitCode: current.raw.ExitCode, Session: current.prepared.Session}
	result.TimedOut = current.raw.TimedOut || errors.Is(current.err, process.ErrTimedOut)
	result.Cancelled = current.raw.Cancelled || errors.Is(current.err, process.ErrCancelled)
	result.OutputTruncated = current.raw.Stdout.Truncated || current.raw.Stderr.Truncated
	if current.parsed.SessionID != "" {
		result.Session.ID = current.parsed.SessionID
	}
	result.Usage = current.parsed.Usage
	if result.TimedOut {
		result.Summary = "timed_out"
	} else if result.Cancelled {
		result.Summary = "cancelled"
	} else if errors.Is(current.err, ErrOutputParse) {
		result.Summary = "parse_failed"
	} else if current.err != nil || result.ExitCode != 0 {
		result.Summary = "failed"
	} else if result.OutputTruncated {
		result.Summary = "output_truncated"
	} else {
		result.Summary = "succeeded"
	}
	return result
}

func mapExecutionError(err error, raw process.Result) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, process.ErrTimedOut) || errors.Is(err, process.ErrCancelled) {
		return err
	}
	if errors.Is(err, process.ErrOutputRedaction) || errors.Is(err, process.ErrOutputRead) || raw.Stdout.RedactionFailed || raw.Stderr.RedactionFailed {
		return ErrOutputParse
	}
	return ErrExecution
}

var _ ArtifactWriter = (*filesapp.ControlledWriter)(nil)
var _ SecretResolver = (*secretsapp.Service)(nil)
