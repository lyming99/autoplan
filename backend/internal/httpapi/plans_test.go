package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	applicationplans "github.com/lyming99/autoplan/backend/internal/application/plans"
	"github.com/lyming99/autoplan/backend/internal/config"
	"github.com/lyming99/autoplan/backend/internal/domain/contracts"
	domainproject "github.com/lyming99/autoplan/backend/internal/domain/project"
	"github.com/lyming99/autoplan/backend/internal/platform/session"
	"github.com/lyming99/autoplan/backend/internal/repository"
)

type planMutationServiceSpy struct {
	calls      int
	command    applicationplans.DeleteCommand
	visibility domainproject.Visibility
	result     applicationplans.MutationResult
	err        error
}

func (spy *planMutationServiceSpy) Delete(
	_ context.Context,
	command applicationplans.DeleteCommand,
	visibility domainproject.Visibility,
) (applicationplans.MutationResult, error) {
	spy.calls++
	spy.command = command
	spy.visibility = visibility
	return spy.result, spy.err
}

func TestPlanDeleteHTTPAdapterPassesCommandMetadataAndReturnsSnapshot(t *testing.T) {
	service := &planMutationServiceSpy{result: applicationplans.MutationResult{
		Snapshot: contracts.AppSnapshot{Plans: []contracts.SanitizedObject{
			{"id": json.RawMessage(`13`), "project_id": json.RawMessage(`7`)},
		}},
	}}
	router, credential := newPlanMutationRouter(t, service)
	response := servePlanDelete(router, credential,
		`{"project_id":7,"plan_id":12,"expected_updated_at":"2026-07-15T01:02:03.000Z"}`,
		"delete-plan-7-12")
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	if service.calls != 1 {
		t.Fatalf("delete calls=%d", service.calls)
	}
	if service.command.ProjectID != 7 || service.command.PlanID != 12 ||
		service.command.ExpectedUpdatedAt != "2026-07-15T01:02:03.000Z" ||
		service.command.RequestID != "req_generated_fixture" {
		t.Fatalf("delete command=%+v", service.command)
	}
	if !service.visibility.WorkspacePath {
		t.Fatal("authenticated REST visibility did not permit workspace paths")
	}
	var envelope struct {
		Data struct {
			Snapshot struct {
				Plans []struct {
					ID int64 `json:"id"`
				} `json:"plans"`
			} `json:"snapshot"`
		} `json:"data"`
		RequestID string `json:"request_id"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &envelope); err != nil {
		t.Fatal(err)
	}
	if envelope.RequestID != "req_generated_fixture" {
		t.Fatalf("request_id=%q", envelope.RequestID)
	}
	if len(envelope.Data.Snapshot.Plans) != 1 || envelope.Data.Snapshot.Plans[0].ID != 13 {
		t.Fatalf("delete snapshot plans=%+v", envelope.Data.Snapshot.Plans)
	}
	for _, plan := range envelope.Data.Snapshot.Plans {
		if plan.ID == 12 {
			t.Fatal("delete response snapshot still contains the target plan")
		}
	}
}

func TestPlanDeleteHTTPAdapterRejectsInvalidTransportInputBeforeService(t *testing.T) {
	service := &planMutationServiceSpy{}
	router, credential := newPlanMutationRouter(t, service)
	cases := []struct {
		name, target, body, key string
		status                  int
		code                    ErrorCode
	}{
		{"query", PlansPath + "?project_id=7", `{}`, "delete-query", http.StatusUnprocessableEntity, CodeInvalidPlan},
		{"unknown field", PlansPath, `{"project_id":7,"plan_id":12,"expected_updated_at":"2026-07-15T01:02:03.000Z","extra":true}`, "delete-extra", http.StatusBadRequest, CodeInvalidJSON},
		{"malformed json", PlansPath, `{`, "delete-json", http.StatusBadRequest, CodeInvalidJSON},
		{"missing content type", PlansPath, `{}`, "delete-content", http.StatusUnsupportedMediaType, CodeUnsupportedMediaType},
		{"invalid idempotency key", PlansPath, `{}`, "bad key", http.StatusBadRequest, CodeInvalidIdempotencyKey},
	}
	for _, item := range cases {
		t.Run(item.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodDelete, item.target, strings.NewReader(item.body))
			request.Host = testAuthority
			request.Header.Set("Origin", testOrigin)
			request.Header.Set(session.HeaderName, credential)
			request.Header.Set(IdempotencyKeyHeader, item.key)
			if item.name != "missing content type" {
				request.Header.Set("Content-Type", "application/json")
			}
			response := httptest.NewRecorder()
			router.ServeHTTP(response, request)
			assertContractError(t, response, item.status, string(item.code), false)
		})
	}
	if service.calls != 0 {
		t.Fatalf("invalid requests reached service %d times", service.calls)
	}
}

func TestPlanDeleteHTTPAdapterMapsApplicationFailures(t *testing.T) {
	service := &planMutationServiceSpy{}
	router, credential := newPlanMutationRouter(t, service)
	cases := []struct {
		name      string
		err       error
		status    int
		code      ErrorCode
		retryable bool
	}{
		{"invalid", applicationplans.ErrInvalidCommand, http.StatusUnprocessableEntity, CodeInvalidPlan, false},
		{"missing", repository.ErrNotFound, http.StatusNotFound, CodeNotFound, false},
		{"stale", applicationplans.ErrStateConflict, http.StatusPreconditionFailed, CodePreconditionFailed, false},
		{"protected", applicationplans.ErrProtected, http.StatusConflict, CodeRelationConflict, false},
		{"unavailable", applicationplans.ErrUnavailable, http.StatusServiceUnavailable, CodeRepositoryUnavailable, true},
		{"busy", repository.ErrTransaction, http.StatusLocked, CodeRepositoryBusy, true},
	}
	for _, item := range cases {
		t.Run(item.name, func(t *testing.T) {
			service.err = item.err
			response := servePlanDelete(router, credential,
				`{"project_id":7,"plan_id":12,"expected_updated_at":"2026-07-15T01:02:03.000Z"}`,
				"delete-"+item.name)
			assertContractError(t, response, item.status, string(item.code), item.retryable)
		})
	}
}

func newPlanMutationRouter(t *testing.T, service PlanMutationService) (*Router, string) {
	t.Helper()
	clock := fixedClock{value: time.Date(2026, 7, 15, 1, 2, 3, 0, time.UTC)}
	manager, err := session.New(bytes.NewReader(bytes.Repeat([]byte{0x5b}, 32)))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(manager.Close)
	origins, err := config.NewOriginSet([]string{testOrigin})
	if err != nil {
		t.Fatal(err)
	}
	security, err := NewSecurity(SecurityOptions{
		Sessions: manager, Origins: origins, ExpectedHost: config.DefaultListenHost,
		ExpectedPort: 43123, Logger: &recordingLogger{}, Clock: clock,
	})
	if err != nil {
		t.Fatal(err)
	}
	router, err := NewRouter(RouterOptions{
		Application: &testApplication{}, Logger: &recordingLogger{}, Clock: clock,
		RequestIDs: fixedRequestIDs{}, BodyLimitBytes: 1024,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := RegisterPlanMutations(router, security, service); err != nil {
		t.Fatal(err)
	}
	return router, string(manager.CredentialCopy())
}

func servePlanDelete(router http.Handler, credential, body, key string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(http.MethodDelete, PlansPath, strings.NewReader(body))
	request.Host = testAuthority
	request.Header.Set("Origin", testOrigin)
	request.Header.Set(session.HeaderName, credential)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set(IdempotencyKeyHeader, key)
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	return response
}
