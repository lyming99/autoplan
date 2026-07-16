package bootstrap

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/lyming99/autoplan/backend/internal/application/capabilities"
	"github.com/lyming99/autoplan/backend/internal/config"
	"github.com/lyming99/autoplan/backend/internal/httpapi"
	"github.com/lyming99/autoplan/backend/internal/platform/logging"
	"github.com/lyming99/autoplan/backend/internal/platform/session"
	backendruntime "github.com/lyming99/autoplan/backend/internal/runtime"
)

func TestRuntimeRoutesExposeIntakePreflight(t *testing.T) {
	configuration := config.Defaults()
	configuration.HTTP.AllowedOrigins = []string{"http://127.0.0.1:5173"}
	dependencies, err := AssembleDependencies(configuration, DependencyOverrides{})
	if err != nil {
		t.Fatal(err)
	}
	defer dependencies.Close(context.Background())
	clock := backendruntime.SystemClock{}
	router, err := httpapi.NewRouter(httpapi.RouterOptions{
		Application: dependencies.Application, Logger: logging.Nop{}, Clock: clock,
		BodyLimitBytes: config.DefaultBodyLimit,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := dependencies.RegisterRuntimeRoutes(router, logging.Nop{}, clock); err != nil {
		t.Fatal(err)
	}

	request := httptest.NewRequest(http.MethodOptions,
		"http://127.0.0.1:43123/api/v1/projects/1/requirements", nil)
	request.Header.Set("Origin", "http://127.0.0.1:5173")
	request.Header.Set("Access-Control-Request-Method", http.MethodPost)
	request.Header.Set("Access-Control-Request-Headers", "content-type,idempotency-key,x-autoplan-session")
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)

	if response.Code != http.StatusNoContent ||
		response.Header().Get("Access-Control-Allow-Origin") != "http://127.0.0.1:5173" ||
		!strings.Contains(response.Header().Get("Access-Control-Allow-Methods"), http.MethodPost) ||
		response.Header().Get("Access-Control-Allow-Headers") == "" {
		t.Fatalf("intake preflight status=%d headers=%v", response.Code, response.Header())
	}
}

func TestRuntimeRoutesRegisterProjectEventStream(t *testing.T) {
	configuration := config.Defaults()
	configuration.HTTP.AllowedOrigins = []string{"http://127.0.0.1:5173"}
	dependencies, err := AssembleDependencies(configuration, DependencyOverrides{})
	if err != nil {
		t.Fatal(err)
	}
	defer dependencies.Close(context.Background())
	clock := backendruntime.SystemClock{}
	router, err := httpapi.NewRouter(httpapi.RouterOptions{
		Application: dependencies.Application, Logger: logging.Nop{}, Clock: clock,
		BodyLimitBytes: config.DefaultBodyLimit,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := dependencies.RegisterRuntimeRoutes(router, logging.Nop{}, clock); err != nil {
		t.Fatal(err)
	}

	request := httptest.NewRequest(http.MethodGet,
		"http://127.0.0.1:43123/api/v1/projects/1/events", nil)
	request.Header.Set("Accept", "text/event-stream")
	request.Header.Set("Origin", "http://127.0.0.1:5173")
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)

	// The request must reach the registered security wrapper. Depending on the
	// exact loopback authority it may reject origin before credentials; a
	// missing route would return 404 and silently disable all live refreshes.
	if response.Code == http.StatusNotFound {
		t.Fatalf("project event route status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestRuntimeRoutesExposeCapabilitiesAndPlanDelete(t *testing.T) {
	configuration := config.Defaults()
	configuration.HTTP.ListenPort = 43123
	configuration.HTTP.AllowedOrigins = []string{"http://127.0.0.1:5173"}
	dependencies, err := AssembleDependencies(configuration, DependencyOverrides{})
	if err != nil {
		t.Fatal(err)
	}
	defer dependencies.Close(context.Background())
	clock := backendruntime.SystemClock{}
	router, err := httpapi.NewRouter(httpapi.RouterOptions{
		Application: dependencies.Application, Logger: logging.Nop{}, Clock: clock,
		BodyLimitBytes: config.DefaultBodyLimit,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := dependencies.RegisterRuntimeRoutes(router, logging.Nop{}, clock); err != nil {
		t.Fatal(err)
	}
	credential := string(dependencies.SessionCopy())

	capabilityRequest := httptest.NewRequest(http.MethodGet, httpapi.CapabilitiesPath, nil)
	capabilityRequest.Host = "127.0.0.1:43123"
	capabilityRequest.Header.Set("Origin", "http://127.0.0.1:5173")
	capabilityRequest.Header.Set(session.HeaderName, credential)
	capabilityResponse := httptest.NewRecorder()
	router.ServeHTTP(capabilityResponse, capabilityRequest)
	if capabilityResponse.Code != http.StatusOK {
		t.Fatalf("capabilities status=%d body=%s", capabilityResponse.Code, capabilityResponse.Body.String())
	}
	var envelope struct {
		Data struct {
			Capabilities []capabilities.Capability `json:"capabilities"`
		} `json:"data"`
	}
	if err := json.Unmarshal(capabilityResponse.Body.Bytes(), &envelope); err != nil {
		t.Fatal(err)
	}
	deleteEnabled := false
	for _, capability := range envelope.Data.Capabilities {
		if capability.ID == capabilities.PlansDelete {
			deleteEnabled = capability.Enabled
			break
		}
	}
	if !deleteEnabled {
		t.Fatal("plans.delete capability is not enabled in the daemon catalog")
	}

	deleteRequest := httptest.NewRequest(http.MethodDelete, httpapi.PlansPath, strings.NewReader(
		`{"project_id":7,"plan_id":12,"expected_updated_at":"2026-07-15T01:02:03.000Z"}`))
	deleteRequest.Host = "127.0.0.1:43123"
	deleteRequest.Header.Set("Origin", "http://127.0.0.1:5173")
	deleteRequest.Header.Set(session.HeaderName, credential)
	deleteRequest.Header.Set("Content-Type", "application/json")
	deleteRequest.Header.Set(httpapi.IdempotencyKeyHeader, "runtime-route-delete")
	deleteResponse := httptest.NewRecorder()
	router.ServeHTTP(deleteResponse, deleteRequest)
	if deleteResponse.Code != http.StatusServiceUnavailable {
		t.Fatalf("plan delete did not reach the daemon service: status=%d body=%s", deleteResponse.Code, deleteResponse.Body.String())
	}
	if deleteResponse.Header().Get("Access-Control-Allow-Origin") != "http://127.0.0.1:5173" {
		t.Fatal("plan delete did not pass through the shared security middleware")
	}
}
