package bootstrap

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/lyming99/autoplan/backend/internal/config"
	"github.com/lyming99/autoplan/backend/internal/httpapi"
	"github.com/lyming99/autoplan/backend/internal/platform/logging"
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
