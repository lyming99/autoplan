package mcp

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
)

func TestHTTPAndStdioShareResultAndErrorProjection(t *testing.T) {
	registry, err := NewFrozenRegistry(AdapterFactoryFunc(func(descriptor ToolDescriptor) ToolHandler {
		return ToolHandlerFunc(func(_ context.Context, call ToolCall) (ToolResult, error) {
			value := map[string]any{"tool": call.Name, "operation": "recorded", "audit": "recorded", "post_state": "shared"}
			encoded, marshalErr := json.Marshal(value)
			if marshalErr != nil {
				return ToolResult{}, marshalErr
			}
			return ToolResult{Content: []ToolTextContent{{Type: "text", Text: string(encoded)}}, StructuredContent: value}, nil
		})
	}))
	if err != nil {
		t.Fatal(err)
	}
	for index, descriptor := range FrozenToolDescriptors() {
		request := []byte(fmt.Sprintf(`{"jsonrpc":"2.0","id":%d,"method":"tools/call","params":{"name":%q,"arguments":{}}}`, index+1, descriptor.Name))
		httpResult := callHTTPContract(t, registry, request)
		stdioResult := callStdioContract(t, registry, request)
		if !reflect.DeepEqual(httpResult, stdioResult) {
			t.Fatalf("%s cross-transport result differs: http=%#v stdio=%#v", descriptor.Name, httpResult, stdioResult)
		}
	}
}

func TestHTTPAndStdioShareStableErrorProjection(t *testing.T) {
	registry, err := NewFrozenRegistry(nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, request := range [][]byte{
		[]byte(`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_projects","arguments":{}}}`),
		[]byte(`{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"unknown_tool","arguments":{}}}`),
		[]byte(`{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_projects","arguments":{"unexpected":true}}}`),
	} {
		httpResult := callHTTPContract(t, registry, request)
		stdioResult := callStdioContract(t, registry, request)
		if !reflect.DeepEqual(httpResult, stdioResult) {
			t.Fatalf("cross-transport error differs: http=%#v stdio=%#v", httpResult, stdioResult)
		}
	}
}

func contractServer(t *testing.T, transport Transport, registry *Registry) *Server {
	t.Helper()
	configuration := DefaultConfig()
	configuration.Enabled, configuration.Transport = true, transport
	if transport == TransportHTTP {
		configuration.AllowedOrigins = []string{"http://127.0.0.1:1"}
	}
	server, err := NewServer(ServerOptions{Config: configuration, Registry: registry, SessionToken: bytes.Repeat([]byte{'a'}, 32)})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = server.Close(context.Background()) })
	return server
}

func callHTTPContract(t *testing.T, registry *Registry, body []byte) any {
	t.Helper()
	server := contractServer(t, TransportHTTP, registry)
	request := httptest.NewRequest(http.MethodPost, "/mcp", bytes.NewReader(body))
	request.Host = "127.0.0.1:43847"
	request.Header.Set("Origin", "http://127.0.0.1:1")
	request.Header.Set("Authorization", "Bearer "+strings.Repeat("a", 32))
	request.Header.Set("X-Autoplan-Session", strings.Repeat("a", 32))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	server.http.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("HTTP status = %d", response.Code)
	}
	return contractResult(t, response.Body.Bytes())
}

func callStdioContract(t *testing.T, registry *Registry, body []byte) any {
	t.Helper()
	server := contractServer(t, TransportStdio, registry)
	var output bytes.Buffer
	if err := server.ServeStdio(context.Background(), strings.NewReader(string(body)+"\n"), &output, &bytes.Buffer{}); err != nil {
		t.Fatal(err)
	}
	return contractResult(t, output.Bytes())
}

func contractResult(t *testing.T, body []byte) any {
	t.Helper()
	var envelope struct {
		Result any `json:"result"`
	}
	if err := json.Unmarshal(body, &envelope); err != nil {
		t.Fatal(err)
	}
	return envelope.Result
}
