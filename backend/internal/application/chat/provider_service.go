package chat

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	applicationmodelusage "github.com/lyming99/autoplan/backend/internal/application/modelusage"
	applicationoperations "github.com/lyming99/autoplan/backend/internal/application/operations"
	domainchat "github.com/lyming99/autoplan/backend/internal/domain/chat"
	domainmodelusage "github.com/lyming99/autoplan/backend/internal/domain/modelusage"
	domainoperation "github.com/lyming99/autoplan/backend/internal/domain/operation"
	platformsecrets "github.com/lyming99/autoplan/backend/internal/platform/secrets"
	"github.com/lyming99/autoplan/backend/internal/repository"
	"github.com/lyming99/autoplan/backend/internal/runtime/agentcli"
	"github.com/lyming99/autoplan/backend/internal/runtime/process"
)

var (
	ErrProviderUnavailable = errors.New("chat provider is unavailable")
	ErrProviderInvalid     = errors.New("chat provider command is invalid")
	ErrProviderUnknown     = errors.New("chat provider is unknown")
	ErrProviderRejected    = errors.New("chat provider rejected the request")
	ErrProviderOutput      = errors.New("chat provider output is invalid")
	ErrTurnNotReady        = errors.New("chat turn is not ready for provider execution")
	ErrProviderState       = errors.New("chat provider state conflicts")
)

const maximumHTTPProviderResponseBytes = 1 << 20

type ProviderTurnStore interface {
	ClaimNextTurn(context.Context, int64, int64, string) (TurnClaim, error)
	CreateAssistantPartial(context.Context, CreatePartialCommand) (int64, error)
	AppendAssistantPartial(context.Context, AppendPartialCommand) error
	FinishTurn(context.Context, FinishTurnCommand) error
}

type ProviderOperations interface {
	CreateOrReuse(context.Context, applicationoperations.CreateCommand) (applicationoperations.Result, error)
	Claim(context.Context, applicationoperations.ClaimCommand) (applicationoperations.Result, error)
	Succeed(context.Context, applicationoperations.CompleteCommand) (applicationoperations.Result, error)
	Fail(context.Context, applicationoperations.FailCommand) (applicationoperations.Result, error)
	RequestCancel(context.Context, applicationoperations.CancelCommand) (applicationoperations.Result, error)
	ConfirmCancel(context.Context, applicationoperations.CancelCommand) (applicationoperations.Result, error)
}

type ProviderHTTPClient interface {
	Do(*http.Request) (*http.Response, error)
}

type ProviderCLI interface {
	Run(context.Context, agentcli.ChatLaunch) (process.Result, error)
}

type ProviderDependencies struct {
	Turns      ProviderTurnStore
	Operations ProviderOperations
	Usage      applicationmodelusage.Recorder
	HTTP       ProviderHTTPClient
	CLI        ProviderCLI
	Secrets    *platformsecrets.ChatMapper
}

type ProviderService struct {
	turns      ProviderTurnStore
	operations ProviderOperations
	usage      applicationmodelusage.Recorder
	http       ProviderHTTPClient
	cli        ProviderCLI
	secrets    *platformsecrets.ChatMapper
	mu         sync.Mutex
	active     map[string]activeProvider
}

type activeProvider struct {
	projectID int64
	version   int64
	cancel    context.CancelFunc
}

// ProviderCommand is internal application intent. It has no command, argv,
// environment, token, process ID, provider response or authorization override
// field; transports must derive it only from authorized project configuration.
type ProviderCommand struct {
	ProjectID      int64
	ConversationID int64
	Prompt         string
	RequestID      string
	Workspace      string
	WorkingDir     string
	Timeout        time.Duration
	Profile        domainchat.ProviderProfile
}

type ProviderRun struct {
	OperationID        string                   `json:"operation_id"`
	ProjectID          int64                    `json:"project_id"`
	ConversationID     int64                    `json:"conversation_id"`
	MessageID          int64                    `json:"message_id"`
	TurnID             string                   `json:"turn_id"`
	AssistantMessageID int64                    `json:"assistant_message_id,omitempty"`
	OperationStatus    domainoperation.Status   `json:"operation_status"`
	Chunks             int64                    `json:"chunks"`
	Replayed           bool                     `json:"replayed"`
	Usage              *domainmodelusage.Tokens `json:"-"`
}

type ProviderStopCommand struct {
	ProjectID   int64
	OperationID string
	RequestID   string
}

func NewProviderService(dependencies ProviderDependencies) *ProviderService {
	return &ProviderService{
		turns: dependencies.Turns, operations: dependencies.Operations, http: dependencies.HTTP,
		usage: dependencies.Usage, cli: dependencies.CLI, secrets: dependencies.Secrets, active: make(map[string]activeProvider),
	}
}

func (service *ProviderService) Configured() bool {
	return service != nil && service.turns != nil && service.operations != nil
}

// RequestCancel targets only an Operation that this ProviderService currently
// owns. It first records durable cancellation intent, then interrupts the
// matching provider context. Unknown, completed, or another-runtime turns are
// never guessed from conversation state.
func (service *ProviderService) RequestCancel(ctx context.Context, command ProviderStopCommand) (domainoperation.Operation, error) {
	if !service.Configured() || command.ProjectID <= 0 || !validRequestID(command.RequestID) || !validProviderOperationID(command.OperationID) {
		return domainoperation.Operation{}, ErrProviderInvalid
	}
	service.mu.Lock()
	active, found := service.active[command.OperationID]
	service.mu.Unlock()
	if !found || active.projectID != command.ProjectID || active.version <= 0 || active.cancel == nil {
		return domainoperation.Operation{}, ErrProviderState
	}
	updated, err := service.operations.RequestCancel(ctx, applicationoperations.CancelCommand{
		Caller:    applicationoperations.Caller{ID: "chat-runtime", ProjectID: command.ProjectID},
		ProjectID: command.ProjectID, OperationID: command.OperationID, ExpectedVersion: active.version, RequestID: command.RequestID,
	})
	if err != nil {
		return domainoperation.Operation{}, err
	}
	service.mu.Lock()
	latest, stillActive := service.active[command.OperationID]
	if stillActive && latest.projectID == command.ProjectID {
		latest.version = updated.Operation.Version
		service.active[command.OperationID] = latest
	}
	service.mu.Unlock()
	active.cancel()
	return updated.Operation, nil
}

// Execute claims exactly one durable FIFO turn and performs its provider side
// effect only after a Chat Operation has committed running. Replays of an
// already-running or terminal Operation never launch a second provider call.
func (service *ProviderService) Execute(ctx context.Context, command ProviderCommand) (ProviderRun, error) {
	if !service.Configured() {
		return ProviderRun{}, ErrProviderUnavailable
	}
	if !command.Profile.Kind.Valid() {
		return ProviderRun{}, ErrProviderUnknown
	}
	if !validProviderCommand(command) {
		return ProviderRun{}, ErrProviderInvalid
	}
	if command.Profile.Kind.UsesHTTP() && (service.http == nil || service.secrets == nil) {
		return ProviderRun{}, ErrProviderUnavailable
	}
	if command.Profile.Kind.UsesCLI() && service.cli == nil {
		return ProviderRun{}, ErrProviderUnavailable
	}
	if ctx == nil {
		ctx = context.Background()
	}
	if command.Timeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, command.Timeout)
		defer cancel()
	}
	claim, err := service.turns.ClaimNextTurn(ctx, command.ProjectID, command.ConversationID, command.RequestID)
	if err != nil {
		return ProviderRun{}, err
	}
	if !claim.Claimed || claim.MessageID <= 0 || claim.TurnID == "" {
		return ProviderRun{}, ErrTurnNotReady
	}
	return service.executeClaimed(ctx, command, claim)
}

func (service *ProviderService) executeClaimed(ctx context.Context, command ProviderCommand, claim TurnClaim) (ProviderRun, error) {
	caller := applicationoperations.Caller{ID: "chat-runtime", ProjectID: command.ProjectID}
	digest := providerDigest(command, claim)
	created, err := service.operations.CreateOrReuse(ctx, applicationoperations.CreateCommand{
		Caller: caller, ProjectID: command.ProjectID, Type: applicationoperations.ChatProviderOperationType,
		IdempotencyKey: claim.TurnID, RequestDigest: digest, RequestID: command.RequestID,
	})
	if err != nil {
		_ = service.finishTurn(ctx, command, claim, 0, domainchat.StatusError)
		return ProviderRun{}, err
	}
	run := ProviderRun{
		OperationID: created.Operation.OperationID, ProjectID: command.ProjectID, ConversationID: command.ConversationID,
		MessageID: claim.MessageID, TurnID: claim.TurnID, OperationStatus: created.Operation.Status, Replayed: !created.Changed,
	}
	if created.Operation.Status.Terminal() {
		return run, nil
	}
	claimed, err := service.operations.Claim(ctx, applicationoperations.ClaimCommand{
		Caller: caller, ProjectID: command.ProjectID, OperationID: created.Operation.OperationID,
		ExpectedVersion: created.Operation.Version, RequestDigest: digest, RequestID: command.RequestID,
	})
	if err != nil {
		_ = service.finishTurn(ctx, command, claim, 0, domainchat.StatusError)
		return run, err
	}
	run.OperationStatus = claimed.Operation.Status
	if !claimed.Changed {
		run.Replayed = true
		return run, nil
	}
	executionCtx, cancel := context.WithCancel(ctx)
	service.activate(claimed.Operation.OperationID, command.ProjectID, claimed.Operation.Version, cancel)
	defer service.deactivate(claimed.Operation.OperationID)
	chunks, usage, output, executeErr := service.runProvider(executionCtx, command)
	run.Usage = usage
	operation := service.activeOperation(claimed.Operation)
	if usageErr := service.recordUsage(ctx, command, claim, operation.OperationID, usage); usageErr != nil {
		return service.failExecution(ctx, command, claim, operation, output, run, usageErr)
	}
	if executeErr != nil {
		return service.failExecution(ctx, command, claim, operation, output, run, executeErr)
	}
	if err := executionCtx.Err(); err != nil {
		return service.failExecution(ctx, command, claim, service.activeOperation(operation), output, run, err)
	}
	assistantID, count, persistErr := service.persistChunks(ctx, command, claim, chunks)
	run.AssistantMessageID, run.Chunks = assistantID, count
	if persistErr != nil {
		return service.failExecution(ctx, command, claim, operation, output, run, persistErr)
	}
	if assistantID == 0 {
		assistantID, persistErr = service.turns.CreateAssistantPartial(ctx, CreatePartialCommand{
			ProjectID: command.ProjectID, ConversationID: command.ConversationID, RequestID: command.RequestID,
		})
		run.AssistantMessageID = assistantID
		if persistErr != nil {
			return service.failExecution(ctx, command, claim, operation, output, run, persistErr)
		}
	}
	if err := service.finishTurn(ctx, command, claim, assistantID, domainchat.StatusDone); err != nil {
		return service.failExecution(ctx, command, claim, operation, output, run, err)
	}
	result := providerOperationResult(command, claim, count)
	completed, err := service.operations.Succeed(ctx, applicationoperations.CompleteCommand{
		Caller: caller, ProjectID: command.ProjectID, OperationID: claimed.Operation.OperationID,
		ExpectedVersion: operation.Version, RequestID: command.RequestID, Result: result, Output: output,
	})
	if err != nil {
		return run, err
	}
	run.OperationStatus = completed.Operation.Status
	return run, nil
}

func (service *ProviderService) runProvider(ctx context.Context, command ProviderCommand) ([]domainchat.ProviderChunk, *domainmodelusage.Tokens, *applicationoperations.OutputCapture, error) {
	switch command.Profile.Kind {
	case domainchat.ProviderOpenAI, domainchat.ProviderAnthropic:
		return service.runHTTP(ctx, command)
	case domainchat.ProviderClaudeCLI, domainchat.ProviderCodexCLI:
		return service.runCLI(ctx, command)
	default:
		return nil, nil, nil, ErrProviderUnavailable
	}
}

func (service *ProviderService) runCLI(ctx context.Context, command ProviderCommand) ([]domainchat.ProviderChunk, *domainmodelusage.Tokens, *applicationoperations.OutputCapture, error) {
	launch := agentcli.ChatLaunch{
		ProjectID: command.ProjectID, Workspace: command.Workspace, WorkingDirectory: command.WorkingDir,
		Prompt: command.Prompt, Model: command.Profile.Model, ReasoningEffort: command.Profile.ReasoningEffort,
		Timeout: command.Timeout,
	}
	switch command.Profile.Kind {
	case domainchat.ProviderClaudeCLI:
		launch.Provider, launch.Endpoint = agentcli.ChatProviderClaude, command.Profile.Endpoint
		if command.Profile.Credential != nil {
			environment, err := platformsecrets.ClaudeEnvironment(command.Profile.Credential.Binding, command.Profile.Credential.Reference)
			if err != nil {
				return nil, nil, nil, ErrProviderUnavailable
			}
			launch.Credential = &process.SecretEnvironment{Name: environment.Name, Binding: environment.Binding, Reference: environment.Reference}
		}
	case domainchat.ProviderCodexCLI:
		launch.Provider = agentcli.ChatProviderCodex
	}
	raw, err := service.cli.Run(ctx, launch)
	output := &applicationoperations.OutputCapture{Stdout: []byte(raw.Stdout.Tail), Stderr: []byte(raw.Stderr.Tail)}
	usage := agentcli.ParseChatTokenUsage(launch.Provider, raw)
	if err != nil || raw.ExitCode != 0 || raw.TimedOut || raw.Cancelled || raw.Stdout.RedactionFailed || raw.Stderr.RedactionFailed {
		if err != nil {
			return nil, usage, output, err
		}
		return nil, usage, output, ErrProviderRejected
	}
	parsed := agentcli.ParseChatOutput(launch.Provider, raw)
	return chatChunksFromCLI(parsed), usage, output, nil
}

func (service *ProviderService) recordUsage(
	ctx context.Context,
	command ProviderCommand,
	claim TurnClaim,
	operationID string,
	tokens *domainmodelusage.Tokens,
) error {
	if tokens == nil {
		return nil
	}
	if service.usage == nil {
		return repository.ErrNotConfigured
	}
	finalize, cancel := providerFinalizationContext(ctx)
	defer cancel()
	return service.usage.Record(finalize, domainmodelusage.Record{
		ProjectID:     command.ProjectID,
		InvocationKey: fmt.Sprintf("chat:%s:conversation:%d:turn:%d", operationID, command.ConversationID, claim.MessageID),
		Provider:      chatUsageProvider(command.Profile.Kind), Model: command.Profile.Model, Source: domainmodelusage.SourceChat,
		OperationID: &operationID, Tokens: *tokens, CollectedAt: time.Now().UTC().Format(time.RFC3339Nano),
	})
}

func chatUsageProvider(kind domainchat.ProviderKind) string {
	switch kind {
	case domainchat.ProviderClaudeCLI:
		return "claude"
	case domainchat.ProviderCodexCLI:
		return "codex"
	default:
		return string(kind)
	}
}

func (service *ProviderService) runHTTP(ctx context.Context, command ProviderCommand) ([]domainchat.ProviderChunk, *domainmodelusage.Tokens, *applicationoperations.OutputCapture, error) {
	credential, err := service.secrets.ResolveHTTP(ctx, httpProvider(command.Profile.Kind), command.Profile.Credential.Binding, command.Profile.Credential.Reference)
	if err != nil {
		return nil, nil, nil, ErrProviderUnavailable
	}
	defer credential.Clear()
	body, endpoint, err := providerHTTPRequest(command)
	if err != nil {
		return nil, nil, nil, ErrProviderUnavailable
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, nil, nil, ErrProviderUnavailable
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set(credential.Name, credential.Value)
	if command.Profile.Kind == domainchat.ProviderAnthropic {
		request.Header.Set("anthropic-version", "2023-06-01")
	}
	response, err := service.http.Do(request)
	request.Header.Del(credential.Name)
	if err != nil {
		return nil, nil, nil, ErrProviderRejected
	}
	if response == nil || response.Body == nil {
		return nil, nil, nil, ErrProviderRejected
	}
	defer response.Body.Close()
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		return nil, nil, nil, ErrProviderRejected
	}
	chunks, usage, err := parseHTTPChunks(response.Body, response.Header.Get("Content-Type"), command.Profile.Kind)
	return chunks, usage, nil, err
}

func (service *ProviderService) persistChunks(ctx context.Context, command ProviderCommand, claim TurnClaim, values []domainchat.ProviderChunk) (int64, int64, error) {
	collector := &ChunkCollector{}
	assistantID := int64(0)
	count := int64(0)
	persist := func(chunks []StreamChunk) error {
		for _, chunk := range chunks {
			count++
			switch chunk.Kind {
			case domainchat.ChunkText:
				if assistantID == 0 {
					id, err := service.turns.CreateAssistantPartial(ctx, CreatePartialCommand{
						ProjectID: command.ProjectID, ConversationID: command.ConversationID, Content: chunk.Text, RequestID: command.RequestID,
					})
					if err != nil {
						return err
					}
					assistantID = id
				} else if err := service.turns.AppendAssistantPartial(ctx, AppendPartialCommand{
					ProjectID: command.ProjectID, ConversationID: command.ConversationID, MessageID: assistantID, Content: chunk.Text, RequestID: command.RequestID,
				}); err != nil {
					return err
				}
			case domainchat.ChunkToolCall, domainchat.ChunkToolResult:
				if assistantID == 0 {
					id, err := service.turns.CreateAssistantPartial(ctx, CreatePartialCommand{
						ProjectID: command.ProjectID, ConversationID: command.ConversationID, ToolCalls: chunk.ToolCalls,
						ToolResult: chunk.ToolResult, RequestID: command.RequestID,
					})
					if err != nil {
						return err
					}
					assistantID = id
				}
			}
		}
		return nil
	}
	for _, value := range values {
		chunks, err := collector.Push(value)
		if err != nil {
			return assistantID, count, err
		}
		if err := persist(chunks); err != nil {
			return assistantID, count, err
		}
	}
	chunks, err := collector.Flush()
	if err != nil {
		return assistantID, count, err
	}
	if err := persist(chunks); err != nil {
		return assistantID, count, err
	}
	return assistantID, count, nil
}

func (service *ProviderService) failExecution(
	ctx context.Context,
	command ProviderCommand,
	claim TurnClaim,
	operation domainoperation.Operation,
	output *applicationoperations.OutputCapture,
	run ProviderRun,
	cause error,
) (ProviderRun, error) {
	finalize, cancel := providerFinalizationContext(ctx)
	defer cancel()
	caller := applicationoperations.Caller{ID: "chat-runtime", ProjectID: command.ProjectID}
	status := domainchat.StatusError
	if errors.Is(cause, context.Canceled) || errors.Is(cause, context.DeadlineExceeded) || errors.Is(cause, process.ErrCancelled) || errors.Is(cause, process.ErrTimedOut) {
		status = domainchat.StatusAborted
	}
	_ = service.finishTurn(finalize, command, claim, run.AssistantMessageID, status)
	if status == domainchat.StatusAborted {
		updated, err := service.operations.ConfirmCancel(finalize, applicationoperations.CancelCommand{
			Caller: caller, ProjectID: command.ProjectID, OperationID: operation.OperationID,
			ExpectedVersion: operation.Version, RequestID: command.RequestID, Output: output,
		})
		if err == nil {
			run.OperationStatus = updated.Operation.Status
		}
	} else {
		updated, err := service.operations.Fail(finalize, applicationoperations.FailCommand{
			Caller: caller, ProjectID: command.ProjectID, OperationID: operation.OperationID,
			ExpectedVersion: operation.Version, RequestID: command.RequestID, Code: "CHAT_PROVIDER_FAILED",
			Summary: "Chat provider did not complete the requested turn.", Output: output,
		})
		if err == nil {
			run.OperationStatus = updated.Operation.Status
		}
	}
	return run, cause
}

func (service *ProviderService) activate(operationID string, projectID, version int64, cancel context.CancelFunc) {
	if service == nil || operationID == "" || projectID <= 0 || version <= 0 || cancel == nil {
		return
	}
	service.mu.Lock()
	defer service.mu.Unlock()
	if service.active == nil {
		service.active = make(map[string]activeProvider)
	}
	service.active[operationID] = activeProvider{projectID: projectID, version: version, cancel: cancel}
}

func (service *ProviderService) deactivate(operationID string) {
	if service == nil || operationID == "" {
		return
	}
	service.mu.Lock()
	active, found := service.active[operationID]
	delete(service.active, operationID)
	service.mu.Unlock()
	if found && active.cancel != nil {
		active.cancel()
	}
}

func (service *ProviderService) activeOperation(operation domainoperation.Operation) domainoperation.Operation {
	if service == nil || operation.OperationID == "" {
		return operation
	}
	service.mu.Lock()
	active, found := service.active[operation.OperationID]
	service.mu.Unlock()
	if found && active.projectID == operation.ProjectID && active.version > 0 {
		operation.Version = active.version
	}
	return operation
}

func providerFinalizationContext(ctx context.Context) (context.Context, context.CancelFunc) {
	if ctx != nil && ctx.Err() == nil {
		return ctx, func() {}
	}
	return context.WithTimeout(context.Background(), 5*time.Second)
}

func validProviderOperationID(value string) bool {
	if value == "" || len(value) > 128 || strings.TrimSpace(value) != value || strings.ContainsRune(value, 0) {
		return false
	}
	for _, character := range value {
		if !(character >= 'A' && character <= 'Z') && !(character >= 'a' && character <= 'z') &&
			!(character >= '0' && character <= '9') && character != '.' && character != '_' && character != ':' && character != '-' {
			return false
		}
	}
	return true
}

func (service *ProviderService) finishTurn(ctx context.Context, command ProviderCommand, claim TurnClaim, assistantID int64, status string) error {
	return service.turns.FinishTurn(ctx, FinishTurnCommand{
		ProjectID: command.ProjectID, ConversationID: command.ConversationID, UserMessageID: claim.MessageID,
		AssistantMessageID: assistantID, Status: status, RequestID: command.RequestID,
	})
}

func validProviderCommand(value ProviderCommand) bool {
	return value.ProjectID > 0 && value.ConversationID > 0 && value.Prompt != "" && len(value.Prompt) <= 1000000 &&
		utf8.ValidString(value.Prompt) && !strings.ContainsRune(value.Prompt, 0) &&
		validRequestID(value.RequestID) && validProviderWorkPath(value.Workspace) && validProviderWorkPath(value.WorkingDir) &&
		value.Timeout >= 0 && value.Timeout <= 2*time.Hour && domainchat.ValidateProviderProfile(value.Profile) == nil
}

func validProviderWorkPath(value string) bool {
	return value != "" && len(value) <= 4096 && utf8.ValidString(value) && strings.TrimSpace(value) == value && !strings.ContainsRune(value, 0)
}

func providerDigest(command ProviderCommand, claim TurnClaim) string {
	value := strings.Join([]string{
		claim.TurnID, command.Prompt, string(command.Profile.Kind), command.Profile.Model, command.Profile.Endpoint, command.Profile.ReasoningEffort,
	}, "\x00")
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}

func providerOperationResult(command ProviderCommand, claim TurnClaim, chunks int64) *json.RawMessage {
	value, err := json.Marshal(map[string]any{
		"conversation_id": command.ConversationID,
		"message_id":      claim.MessageID,
		"turn_id":         claim.TurnID,
		"provider":        string(command.Profile.Kind),
		"chunks":          chunks,
	})
	if err != nil {
		return nil
	}
	result := json.RawMessage(value)
	return &result
}

func httpProvider(kind domainchat.ProviderKind) platformsecrets.ChatHTTPProvider {
	if kind == domainchat.ProviderAnthropic {
		return platformsecrets.ChatAnthropicHTTP
	}
	return platformsecrets.ChatOpenAIHTTP
}

func providerHTTPRequest(command ProviderCommand) ([]byte, string, error) {
	endpoint := strings.TrimRight(command.Profile.Endpoint, "/")
	var payload any
	switch command.Profile.Kind {
	case domainchat.ProviderOpenAI:
		endpoint += "/v1/chat/completions"
		payload = map[string]any{
			"model": command.Profile.Model, "stream": true, "stream_options": map[string]bool{"include_usage": true},
			"messages": []map[string]string{{"role": "user", "content": command.Prompt}},
		}
	case domainchat.ProviderAnthropic:
		endpoint += "/v1/messages"
		payload = map[string]any{
			"model": command.Profile.Model, "stream": true, "max_tokens": 4096,
			"messages": []map[string]string{{"role": "user", "content": command.Prompt}},
		}
	default:
		return nil, "", ErrProviderUnavailable
	}
	encoded, err := json.Marshal(payload)
	if err != nil || len(encoded) > maximumHTTPProviderResponseBytes {
		return nil, "", ErrProviderUnavailable
	}
	return encoded, endpoint, nil
}

func parseHTTPChunks(reader io.Reader, contentType string, provider domainchat.ProviderKind) ([]domainchat.ProviderChunk, *domainmodelusage.Tokens, error) {
	limited := io.LimitReader(reader, maximumHTTPProviderResponseBytes+1)
	body, err := io.ReadAll(limited)
	if err != nil || len(body) > maximumHTTPProviderResponseBytes {
		return nil, nil, ErrProviderOutput
	}
	if strings.Contains(strings.ToLower(contentType), "text/event-stream") {
		scanner := bufio.NewScanner(bytes.NewReader(body))
		scanner.Buffer(make([]byte, 4096), 64<<10)
		chunks := make([]domainchat.ProviderChunk, 0)
		usage := &httpUsageAccumulator{}
		terminated := false
		for scanner.Scan() {
			line := strings.TrimSpace(scanner.Text())
			if !strings.HasPrefix(line, "data:") {
				continue
			}
			data := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
			if data == "" {
				continue
			}
			if data == "[DONE]" {
				terminated = provider == domainchat.ProviderOpenAI
				continue
			}
			parsed, err := parseProviderJSON([]byte(data), provider)
			if err != nil {
				return nil, nil, err
			}
			chunks = append(chunks, parsed...)
			if !usage.push([]byte(data), provider) {
				return nil, nil, ErrProviderOutput
			}
			if provider == domainchat.ProviderAnthropic && anthropicEventType([]byte(data)) == "message_stop" {
				terminated = true
			}
		}
		if err := scanner.Err(); err != nil {
			return nil, nil, ErrProviderOutput
		}
		if !terminated {
			return nil, nil, ErrProviderOutput
		}
		return chunks, usage.tokens(), nil
	}
	chunks, err := parseProviderJSON(body, provider)
	if err != nil {
		return nil, nil, err
	}
	usage := &httpUsageAccumulator{}
	if !usage.push(body, provider) {
		return nil, nil, ErrProviderOutput
	}
	return chunks, usage.tokens(), nil
}

func parseProviderJSON(data []byte, provider domainchat.ProviderKind) ([]domainchat.ProviderChunk, error) {
	if provider == domainchat.ProviderAnthropic {
		return parseAnthropicJSON(data)
	}
	return parseOpenAIJSON(data)
}

type httpUsageAccumulator struct {
	input, output, cached, reasoning, total *int64
	seen                                    bool
}

func (usage *httpUsageAccumulator) push(data []byte, provider domainchat.ProviderKind) bool {
	if usage == nil {
		return false
	}
	if provider == domainchat.ProviderAnthropic {
		var event struct {
			Type    string `json:"type"`
			Message struct {
				Usage struct {
					Input         *int64 `json:"input_tokens"`
					Output        *int64 `json:"output_tokens"`
					CacheRead     *int64 `json:"cache_read_input_tokens"`
					CacheCreation *int64 `json:"cache_creation_input_tokens"`
				} `json:"usage"`
			} `json:"message"`
			Usage struct {
				Input         *int64 `json:"input_tokens"`
				Output        *int64 `json:"output_tokens"`
				CacheRead     *int64 `json:"cache_read_input_tokens"`
				CacheCreation *int64 `json:"cache_creation_input_tokens"`
			} `json:"usage"`
		}
		if json.Unmarshal(data, &event) != nil {
			return false
		}
		fields := event.Usage
		if event.Type == "message_start" {
			fields = event.Message.Usage
		}
		cached, ok := checkedOptionalSum(fields.CacheRead, fields.CacheCreation)
		if !ok || !usage.replace(fields.Input, fields.Output, cached, nil, nil) {
			return false
		}
		return true
	}

	var event struct {
		Usage *struct {
			Input     *int64 `json:"prompt_tokens"`
			Output    *int64 `json:"completion_tokens"`
			Total     *int64 `json:"total_tokens"`
			InputInfo struct {
				Cached *int64 `json:"cached_tokens"`
			} `json:"prompt_tokens_details"`
			OutputInfo struct {
				Reasoning *int64 `json:"reasoning_tokens"`
			} `json:"completion_tokens_details"`
		} `json:"usage"`
	}
	if json.Unmarshal(data, &event) != nil {
		return false
	}
	if event.Usage == nil {
		return true
	}
	return usage.replace(event.Usage.Input, event.Usage.Output, event.Usage.InputInfo.Cached, event.Usage.OutputInfo.Reasoning, event.Usage.Total)
}

func (usage *httpUsageAccumulator) replace(input, output, cached, reasoning, total *int64) bool {
	for _, value := range []*int64{input, output, cached, reasoning, total} {
		if value != nil && *value < 0 {
			return false
		}
	}
	for _, pair := range []struct {
		target **int64
		value  *int64
	}{{&usage.input, input}, {&usage.output, output}, {&usage.cached, cached}, {&usage.reasoning, reasoning}, {&usage.total, total}} {
		if pair.value != nil {
			value := *pair.value
			*pair.target = &value
			usage.seen = true
		}
	}
	return true
}

func (usage *httpUsageAccumulator) tokens() *domainmodelusage.Tokens {
	if usage == nil || !usage.seen {
		return nil
	}
	return &domainmodelusage.Tokens{
		Input: usage.input, Output: usage.output, Cached: usage.cached,
		Reasoning: usage.reasoning, Total: usage.total,
	}
}

func checkedOptionalSum(left, right *int64) (*int64, bool) {
	if left == nil && right == nil {
		return nil, true
	}
	var total int64
	for _, value := range []*int64{left, right} {
		if value == nil {
			continue
		}
		if *value < 0 || total > math.MaxInt64-*value {
			return nil, false
		}
		total += *value
	}
	return &total, true
}

func anthropicEventType(data []byte) string {
	var event struct {
		Type string `json:"type"`
	}
	if json.Unmarshal(data, &event) != nil {
		return ""
	}
	return event.Type
}

func parseOpenAIJSON(data []byte) ([]domainchat.ProviderChunk, error) {
	var response struct {
		Choices []struct {
			Delta struct {
				Content   string            `json:"content"`
				Reasoning string            `json:"reasoning_content"`
				ToolCalls []json.RawMessage `json:"tool_calls"`
			} `json:"delta"`
			Message struct {
				Content   string            `json:"content"`
				ToolCalls []json.RawMessage `json:"tool_calls"`
			} `json:"message"`
		} `json:"choices"`
	}
	if json.Unmarshal(data, &response) != nil {
		return nil, ErrProviderOutput
	}
	chunks := make([]domainchat.ProviderChunk, 0, 3)
	for _, choice := range response.Choices {
		if choice.Delta.Content != "" {
			chunks = append(chunks, domainchat.ProviderChunk{Kind: domainchat.ChunkText, Text: choice.Delta.Content})
		}
		if choice.Delta.Reasoning != "" {
			chunks = append(chunks, domainchat.ProviderChunk{Kind: domainchat.ChunkReasoning, Text: choice.Delta.Reasoning})
		}
		calls := choice.Delta.ToolCalls
		if len(calls) == 0 {
			calls = choice.Message.ToolCalls
		}
		if len(calls) > 0 {
			raw, err := json.Marshal(calls)
			if err != nil {
				return nil, ErrProviderOutput
			}
			value := json.RawMessage(raw)
			chunks = append(chunks, domainchat.ProviderChunk{Kind: domainchat.ChunkToolCall, ToolCalls: &value})
		}
		if choice.Message.Content != "" {
			chunks = append(chunks, domainchat.ProviderChunk{Kind: domainchat.ChunkText, Text: choice.Message.Content})
		}
	}
	return chunks, nil
}

func parseAnthropicJSON(data []byte) ([]domainchat.ProviderChunk, error) {
	var response struct {
		Type  string `json:"type"`
		Delta struct {
			Text     string `json:"text"`
			Thinking string `json:"thinking"`
		} `json:"delta"`
		Content []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
	}
	if json.Unmarshal(data, &response) != nil {
		return nil, ErrProviderOutput
	}
	chunks := make([]domainchat.ProviderChunk, 0, len(response.Content)+2)
	if response.Delta.Text != "" {
		chunks = append(chunks, domainchat.ProviderChunk{Kind: domainchat.ChunkText, Text: response.Delta.Text})
	}
	if response.Delta.Thinking != "" {
		chunks = append(chunks, domainchat.ProviderChunk{Kind: domainchat.ChunkReasoning, Text: response.Delta.Thinking})
	}
	for _, block := range response.Content {
		if block.Type == "text" && block.Text != "" {
			chunks = append(chunks, domainchat.ProviderChunk{Kind: domainchat.ChunkText, Text: block.Text})
		}
	}
	return chunks, nil
}

func chatChunksFromCLI(values []agentcli.ChatOutput) []domainchat.ProviderChunk {
	result := make([]domainchat.ProviderChunk, 0, len(values))
	for _, value := range values {
		if value.Text != "" {
			result = append(result, domainchat.ProviderChunk{Kind: domainchat.ChunkText, Text: value.Text})
		}
		if value.Reasoning != "" {
			result = append(result, domainchat.ProviderChunk{Kind: domainchat.ChunkReasoning, Text: value.Reasoning})
		}
		if value.ToolCalls != nil {
			result = append(result, domainchat.ProviderChunk{Kind: domainchat.ChunkToolCall, ToolCalls: value.ToolCalls})
		}
		if value.ToolResult != nil {
			result = append(result, domainchat.ProviderChunk{Kind: domainchat.ChunkToolResult, ToolResult: value.ToolResult})
		}
	}
	return result
}

var _ ProviderOperations = (*applicationoperations.Service)(nil)
var _ ProviderTurnStore = (*Service)(nil)
var _ ProviderCLI = (*agentcli.ChatAdapter)(nil)
