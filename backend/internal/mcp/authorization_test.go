package mcp

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestHTTPAuthorizationRequiresLoopbackOriginSessionAndToken(t *testing.T) {
	registry, err := NewFrozenRegistry(nil)
	if err != nil {
		t.Fatal(err)
	}
	configuration := DefaultConfig()
	configuration.Enabled, configuration.AllowedOrigins = true, []string{"http://127.0.0.1:1"}
	server, err := NewServer(ServerOptions{Config: configuration, Registry: registry, SessionToken: bytes.Repeat([]byte{'a'}, 32)})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = server.Close(context.Background()) })
	for _, mutate := range []func(*http.Request){
		func(request *http.Request) { request.Header.Del("Origin") },
		func(request *http.Request) { request.Header.Set("Origin", "http://127.0.0.1:2") },
		func(request *http.Request) { request.Header.Del("X-Autoplan-Session") },
		func(request *http.Request) { request.Header.Set("Authorization", "Bearer "+strings.Repeat("b", 32)) },
		func(request *http.Request) { request.Header.Set("Forwarded", "for=127.0.0.1") },
		func(request *http.Request) { request.Host = "localhost:43847" },
	} {
		request := authorizedMCPRequest()
		mutate(request)
		response := httptest.NewRecorder()
		server.http.ServeHTTP(response, request)
		if response.Code != http.StatusUnauthorized || strings.Contains(response.Body.String(), strings.Repeat("a", 32)) {
			t.Fatalf("unexpected authorization failure: %d %s", response.Code, response.Body.String())
		}
	}
	response := httptest.NewRecorder()
	server.http.ServeHTTP(response, authorizedMCPRequest())
	if response.Code != http.StatusOK {
		t.Fatalf("authorized request status = %d", response.Code)
	}
}

func authorizedMCPRequest() *http.Request {
	request := httptest.NewRequest(http.MethodPost, "/mcp", strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"tools/list"}`))
	request.Host = "127.0.0.1:43847"
	request.Header.Set("Origin", "http://127.0.0.1:1")
	request.Header.Set("Authorization", "Bearer "+strings.Repeat("a", 32))
	request.Header.Set("X-Autoplan-Session", strings.Repeat("a", 32))
	request.Header.Set("Content-Type", "application/json")
	return request
}
