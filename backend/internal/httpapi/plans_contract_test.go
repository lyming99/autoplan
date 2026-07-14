package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/lyming99/autoplan/backend/internal/application/capabilities"
)

func TestP07CapabilitiesContractKeepsActionsDisabled(t *testing.T) {
	router, err := p07ContractRouter()
	if err != nil {
		t.Fatal(err)
	}
	if err := router.Handle(http.MethodGet, CapabilitiesPath, CapabilitiesEndpoint(capabilities.NewService())); err != nil {
		t.Fatal(err)
	}
	response := httptest.NewRecorder()
	router.ServeHTTP(response, httptest.NewRequest(http.MethodGet, CapabilitiesPath, nil))
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	var envelope struct {
		Data struct {
			Version      string                    `json:"version"`
			Capabilities []capabilities.Capability `json:"capabilities"`
		} `json:"data"`
		RequestID string `json:"request_id"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &envelope); err != nil {
		t.Fatal(err)
	}
	if envelope.Data.Version != capabilities.ContractVersion || envelope.RequestID == "" {
		t.Fatalf("capabilities envelope drift: %#v", envelope)
	}
	got := make(map[capabilities.ID]bool, len(envelope.Data.Capabilities))
	for _, item := range envelope.Data.Capabilities {
		got[item.ID] = item.Enabled
	}
	for _, id := range []capabilities.ID{
		capabilities.PlansRun, capabilities.PlansStop, capabilities.PlansResume, capabilities.PlansReexecute,
		capabilities.PlansRecreate, capabilities.TasksRun, capabilities.TasksRunBatches, capabilities.TasksStop,
	} {
		enabled, exists := got[id]
		if !exists || enabled {
			t.Fatalf("long action capability %q enabled=%t exists=%t", id, enabled, exists)
		}
	}
	for _, id := range []capabilities.ID{capabilities.PlansQuery, capabilities.PlansReorder, capabilities.EventsQuery} {
		if !got[id] {
			t.Fatalf("shared persistence capability %q is unexpectedly disabled", id)
		}
	}
}

func p07ContractRouter() (*Router, error) {
	return NewRouter(RouterOptions{
		Application: &testApplication{}, Logger: &recordingLogger{},
		Clock:      fixedClock{value: time.Date(2026, 7, 11, 0, 0, 0, 0, time.UTC)},
		RequestIDs: fixedRequestIDs{}, BodyLimitBytes: 1024,
	})
}
