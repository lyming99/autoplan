package mcp

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"strconv"
	"strings"
	"sync"
	"time"
)

var (
	ErrDisabled           = errors.New("mcp transport is disabled")
	ErrTransportInvalid   = errors.New("mcp transport is invalid")
	ErrAlreadyRunning     = errors.New("mcp transport is already running")
	ErrStdioAlreadyActive = errors.New("mcp stdio transport is already active")
)

type ServerOptions struct {
	Config       Config
	Registry     *Registry
	Audit        AuditSink
	SessionToken []byte
	AuthToken    []byte
}

// Server is the sole lifecycle owner for the MCP transports. It has no
// repository, database, scheduler, process, or business-state dependency;
// those remain behind the shared application-service adapter factory.
type Server struct {
	config   Config
	registry *Registry
	auth     *Authenticator
	audit    AuditSink
	http     *httpTransport

	mu          sync.RWMutex
	running     bool
	stdioActive bool
	startedAt   *time.Time
	lastError   string
}

func NewServer(options ServerOptions) (*Server, error) {
	configuration := options.Config.clone()
	if err := configuration.Validate(); err != nil {
		return nil, err
	}
	if options.Registry == nil {
		return nil, ErrInvalidRegistry
	}
	auth, err := newAuthenticator(options.SessionToken, options.AuthToken, configuration.AllowedOrigins)
	if err != nil {
		return nil, err
	}
	audit := options.Audit
	if audit == nil {
		audit = nopAudit{}
	}
	result := &Server{config: configuration, registry: options.Registry, auth: auth, audit: audit}
	result.http = newHTTPTransport(result)
	return result, nil
}

func (server *Server) Start(ctx context.Context) error {
	if server == nil {
		return ErrTransportInvalid
	}
	if err := contextError(ctx); err != nil {
		return err
	}
	if !server.config.Enabled {
		return ErrDisabled
	}
	if server.config.Transport != TransportHTTP {
		return ErrTransportInvalid
	}
	if err := server.http.start(ctx); err != nil {
		server.markFailure()
		return err
	}
	return nil
}

func (server *Server) ServeStdio(ctx context.Context, input io.Reader, output, diagnostic io.Writer) error {
	if server == nil || input == nil || output == nil {
		return ErrTransportInvalid
	}
	if err := contextError(ctx); err != nil {
		return err
	}
	if !server.config.Enabled {
		return ErrDisabled
	}
	if server.config.Transport != TransportStdio {
		return ErrTransportInvalid
	}
	server.mu.Lock()
	if server.stdioActive || server.running {
		server.mu.Unlock()
		return ErrStdioAlreadyActive
	}
	server.stdioActive = true
	server.setRunningLocked()
	server.mu.Unlock()
	defer func() {
		server.mu.Lock()
		server.stdioActive = false
		server.running = false
		server.mu.Unlock()
	}()
	return serveStdioTransport(ctx, server, input, output, diagnostic)
}

// Close stops only the transport owned by this Server. It never closes a
// repository or starts an alternative Node transport after a failure.
func (server *Server) Close(ctx context.Context) error {
	if server == nil {
		return nil
	}
	if ctx == nil {
		ctx = context.Background()
	}
	shutdownContext, cancel := context.WithTimeout(ctx, server.config.ShutdownTimeout)
	defer cancel()
	err := server.http.close(shutdownContext)
	server.mu.Lock()
	server.running = false
	server.mu.Unlock()
	if server.auth != nil {
		server.auth.Close()
	}
	return err
}

func (server *Server) Config() ConfigDTO {
	if server == nil {
		return ConfigDTO{}
	}
	hasToken, mask := false, ""
	if server.auth != nil {
		hasToken, mask = server.auth.HasToken(), server.auth.MaskedToken()
	}
	return server.config.Public(hasToken, mask)
}

func (server *Server) Status() Status {
	if server == nil {
		return Status{State: "error", LocalOnly: true, Note: "MCP transport unavailable."}
	}
	server.mu.RLock()
	running := server.running
	startedAt := cloneTime(server.startedAt)
	lastError := server.lastError
	server.mu.RUnlock()
	hasToken, mask := false, ""
	if server.auth != nil {
		hasToken, mask = server.auth.HasToken(), server.auth.MaskedToken()
	}
	status := Status{
		Enabled: server.config.Enabled, Running: running, Transport: string(server.config.Transport),
		HasAuthToken: hasToken, AuthTokenMasked: mask,
		LocalOnly: true,
		Tools:     toolNames(server.registry), ToolDocs: server.registry.List(),
		Note:      "Local MCP transport; application authorization remains authoritative.",
		StartedAt: startedAt,
	}
	if hasToken {
		status.AuthHeader = "Authorization: Bearer <token>"
	}
	if !server.config.Enabled {
		status.State = "disabled"
		return status
	}
	host, path, port := server.config.Host, server.config.Path, server.config.Port
	status.Host, status.Path, status.Port = &host, &path, &port
	if server.config.Transport == TransportHTTP {
		url := "http://" + server.config.Host + ":" + strconv.Itoa(server.config.Port) + server.config.Path
		status.URL = &url
		status.ConnectionExample = "POST " + url
		if hasToken {
			status.ConnectionExample += " with Authorization: Bearer <token>"
		}
	} else {
		status.ConnectionExample = "autoplan-server mcp-stdio"
	}
	if running {
		status.State = "running"
	} else if lastError != "" {
		status.State = "error"
		status.LastError = &lastError
	} else {
		status.State = "configured"
	}
	return status
}

func (server *Server) markRunning() {
	if server == nil {
		return
	}
	server.mu.Lock()
	server.setRunningLocked()
	server.mu.Unlock()
}

func (server *Server) setRunningLocked() {
	now := time.Now().UTC()
	server.running = true
	server.startedAt = &now
	server.lastError = ""
}

func (server *Server) markStopped() {
	if server == nil {
		return
	}
	server.mu.Lock()
	server.running = false
	server.mu.Unlock()
}

func (server *Server) markFailure() {
	if server == nil {
		return
	}
	server.mu.Lock()
	server.running = false
	server.lastError = "mcp_transport_invalid"
	server.mu.Unlock()
}

type jsonRPCRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params"`
}

type jsonRPCError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type jsonRPCResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Result  any             `json:"result,omitempty"`
	Error   *jsonRPCError   `json:"error,omitempty"`
}

func (server *Server) processFrame(ctx context.Context, frame []byte, transport Transport, caller ToolContext) (*jsonRPCResponse, bool) {
	request, responseID, err := decodeJSONRPCRequest(frame)
	if err != nil {
		return rpcFailure(nil, -32600, "mcp_transport_invalid"), true
	}
	if request.JSONRPC != "2.0" || request.Method == "" {
		return rpcFailure(responseID, -32600, "mcp_transport_invalid"), true
	}
	respond := len(request.ID) != 0 && !bytes.Equal(request.ID, []byte("null"))
	switch request.Method {
	case "initialize":
		return rpcSuccess(responseID, map[string]any{
			"protocolVersion": "2025-06-18",
			"capabilities":    map[string]any{"tools": map[string]bool{"listChanged": false}},
			"serverInfo":      map[string]string{"name": "autoplan", "version": "p13b"},
		}), respond
	case "notifications/initialized":
		return nil, false
	case "ping":
		return rpcSuccess(responseID, map[string]any{}), respond
	case "tools/list":
		return rpcSuccess(responseID, map[string]any{"tools": server.registry.List()}), respond
	case "tools/call":
		var params struct {
			Name      string          `json:"name"`
			Arguments json.RawMessage `json:"arguments"`
		}
		if !decodeExact(request.Params, &params) || strings.TrimSpace(params.Name) == "" || len(params.Arguments) == 0 || !json.Valid(params.Arguments) {
			return rpcSuccess(responseID, errorToolResult("mcp_tool_invalid")), respond
		}
		caller.LocalCaller = transport == TransportStdio
		result, outcome := server.registry.Call(ctx, ToolCall{
			Name: strings.TrimSpace(params.Name), Arguments: append(json.RawMessage(nil), params.Arguments...), Context: caller, Transport: transport,
		})
		recordAudit(ctx, server.audit, AuditEvent{Transport: string(transport), Action: "tools/call", Tool: strings.TrimSpace(params.Name), Outcome: outcome})
		return rpcSuccess(responseID, result), respond
	default:
		return rpcFailure(responseID, -32601, "mcp_transport_invalid"), respond
	}
}

func decodeJSONRPCRequest(frame []byte) (jsonRPCRequest, json.RawMessage, error) {
	var request jsonRPCRequest
	if !decodeExact(frame, &request) {
		return jsonRPCRequest{}, nil, ErrTransportInvalid
	}
	if len(request.ID) != 0 && !validJSONRPCID(request.ID) {
		return jsonRPCRequest{}, nil, ErrTransportInvalid
	}
	return request, append(json.RawMessage(nil), request.ID...), nil
}

func validJSONRPCID(value json.RawMessage) bool {
	if bytes.Equal(value, []byte("null")) {
		return true
	}
	var text string
	if json.Unmarshal(value, &text) == nil {
		return len(text) <= 128
	}
	var number json.Number
	return json.Unmarshal(value, &number) == nil
}

func decodeExact(source []byte, target any) bool {
	decoder := json.NewDecoder(bytes.NewReader(source))
	decoder.DisallowUnknownFields()
	if decoder.Decode(target) != nil {
		return false
	}
	var trailing any
	return decoder.Decode(&trailing) == io.EOF
}

func rpcSuccess(id json.RawMessage, result any) *jsonRPCResponse {
	if len(id) == 0 {
		id = json.RawMessage("null")
	}
	return &jsonRPCResponse{JSONRPC: "2.0", ID: append(json.RawMessage(nil), id...), Result: result}
}

func rpcFailure(id json.RawMessage, code int, message string) *jsonRPCResponse {
	if len(id) == 0 {
		id = json.RawMessage("null")
	}
	return &jsonRPCResponse{JSONRPC: "2.0", ID: append(json.RawMessage(nil), id...), Error: &jsonRPCError{Code: code, Message: message}}
}

func contextError(ctx context.Context) error {
	if ctx == nil {
		return nil
	}
	return ctx.Err()
}

func cloneTime(value *time.Time) *time.Time {
	if value == nil {
		return nil
	}
	copy := *value
	return &copy
}

func toolNames(registry *Registry) []string {
	tools := registry.List()
	result := make([]string, 0, len(tools))
	for _, tool := range tools {
		result = append(result, tool.Name)
	}
	return result
}
