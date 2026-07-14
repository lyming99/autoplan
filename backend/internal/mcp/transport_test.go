package mcp

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestHTTPTransportRejectsInvalidCredentialsWithoutEchoingThem(t *testing.T) {
	server := newTransportTestServer(t, TransportHTTP)
	request := httptest.NewRequest(http.MethodPost, "/mcp", strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"tools/list"}`))
	request.Host = "127.0.0.1:43847"
	request.Header.Set("Origin", "http://127.0.0.1:1")
	request.Header.Set("Authorization", "Bearer wrong-token")
	request.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()

	server.http.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d", recorder.Code)
	}
	if strings.Contains(recorder.Body.String(), "wrong-token") {
		t.Fatal("response exposed the presented credential")
	}
}

func TestHTTPTransportRequiresExactSessionOriginAndToken(t *testing.T) {
	server := newTransportTestServer(t, TransportHTTP)
	request := httptest.NewRequest(http.MethodPost, "/mcp", strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"tools/list"}`))
	request.Host = "127.0.0.1:43847"
	request.Header.Set("Origin", "http://127.0.0.1:1")
	request.Header.Set("Authorization", "Bearer "+strings.Repeat("a", 32))
	request.Header.Set("X-Autoplan-Session", strings.Repeat("a", 32))
	request.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()

	server.http.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusOK || !strings.Contains(recorder.Body.String(), "list_projects") {
		t.Fatalf("unexpected response: status=%d body=%s", recorder.Code, recorder.Body.String())
	}
}

func TestHTTPAndStdioUseSameFrozenCatalog(t *testing.T) {
	httpServer := newTransportTestServer(t, TransportHTTP)
	httpResponse, respond := httpServer.processFrame(context.Background(), []byte(`{"jsonrpc":"2.0","id":1,"method":"tools/list"}`), TransportHTTP, ToolContext{})
	if !respond || httpResponse == nil {
		t.Fatal("HTTP tools/list did not respond")
	}
	var httpBody struct {
		Result struct {
			Tools []ToolDescriptor `json:"tools"`
		} `json:"result"`
	}
	encodedHTTP, err := json.Marshal(httpResponse)
	if err != nil || json.Unmarshal(encodedHTTP, &httpBody) != nil {
		t.Fatal("HTTP response was not valid JSON")
	}

	stdioServer := newTransportTestServer(t, TransportStdio)
	var stdout, stderr bytes.Buffer
	if err := stdioServer.ServeStdio(context.Background(), strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"tools/list"}`+"\n"), &stdout, &stderr); err != nil {
		t.Fatalf("ServeStdio() error = %v", err)
	}
	var stdioBody struct {
		Result struct {
			Tools []ToolDescriptor `json:"tools"`
		} `json:"result"`
	}
	if err := json.Unmarshal(stdout.Bytes(), &stdioBody); err != nil {
		t.Fatalf("stdio response was not valid JSON: %v", err)
	}
	if stderr.Len() != 0 || len(httpBody.Result.Tools) != 28 || len(stdioBody.Result.Tools) != 28 {
		t.Fatal("transports did not expose one frozen catalog")
	}
	for index := range httpBody.Result.Tools {
		if httpBody.Result.Tools[index].Name != stdioBody.Result.Tools[index].Name {
			t.Fatalf("tool %d differs across transports", index)
		}
	}
}

func TestInvalidHTTPConfigurationFailsClosed(t *testing.T) {
	registry, err := NewFrozenRegistry(nil)
	if err != nil {
		t.Fatal(err)
	}
	configuration := DefaultConfig()
	configuration.Enabled = true
	if _, err := NewServer(ServerOptions{Config: configuration, Registry: registry, SessionToken: bytes.Repeat([]byte{'a'}, 32)}); err == nil {
		t.Fatal("HTTP configuration without an exact origin was accepted")
	}
}

func newTransportTestServer(t *testing.T, transport Transport) *Server {
	t.Helper()
	registry, err := NewFrozenRegistry(nil)
	if err != nil {
		t.Fatal(err)
	}
	configuration := DefaultConfig()
	configuration.Enabled = true
	configuration.Transport = transport
	if transport == TransportHTTP {
		configuration.AllowedOrigins = []string{"http://127.0.0.1:1"}
	}
	server, err := NewServer(ServerOptions{
		Config: configuration, Registry: registry, SessionToken: bytes.Repeat([]byte{'a'}, 32),
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = server.Close(context.Background()) })
	return server
}
