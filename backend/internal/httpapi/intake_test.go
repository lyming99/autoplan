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

	"github.com/lyming99/autoplan/backend/internal/application/intake"
	"github.com/lyming99/autoplan/backend/internal/config"
	domainintake "github.com/lyming99/autoplan/backend/internal/domain/intake"
	domainproject "github.com/lyming99/autoplan/backend/internal/domain/project"
	"github.com/lyming99/autoplan/backend/internal/platform/session"
	"github.com/lyming99/autoplan/backend/internal/repository"
)

type p005IntakeFixture struct {
	items              []intake.IntakeDTO
	item               intake.IntakeDTO
	listCalls          int
	createCalls        int
	retryCalls         int
	planActionCalls    int
	lastCreate         intake.CreateCommand
	lastRetry          intake.RetryPlanGenerationCommand
	lastPlanAction     intake.PlanActionCommand
	lastPlanActionName string
	getError           error
	visible            bool
}

func (fixture *p005IntakeFixture) List(_ context.Context, query intake.ListQuery) ([]intake.IntakeDTO, error) {
	fixture.listCalls++
	if query.Type != domainintake.Requirement && query.Type != domainintake.Feedback {
		return nil, intake.ErrInvalidCommand
	}
	return fixture.items, nil
}

func (fixture *p005IntakeFixture) Get(_ context.Context, _ int64, _ domainintake.Type, _ int64) (intake.IntakeDTO, error) {
	return fixture.item, fixture.getError
}

func (fixture *p005IntakeFixture) Create(_ context.Context, command intake.CreateCommand, visibility domainproject.Visibility) (intake.MutationResult, error) {
	fixture.createCalls++
	fixture.lastCreate = command
	fixture.visible = visibility.WorkspacePath
	return intake.MutationResult{}, nil
}

func (fixture *p005IntakeFixture) Update(context.Context, intake.UpdateCommand, domainproject.Visibility) (intake.MutationResult, error) {
	return intake.MutationResult{}, nil
}

func (fixture *p005IntakeFixture) SetAcceptance(context.Context, intake.AcceptanceCommand, domainproject.Visibility) (intake.MutationResult, error) {
	return intake.MutationResult{}, nil
}

func (fixture *p005IntakeFixture) RetryPlanGeneration(_ context.Context, command intake.RetryPlanGenerationCommand, _ domainproject.Visibility) (intake.MutationResult, error) {
	fixture.retryCalls++
	fixture.lastRetry = command
	return intake.MutationResult{}, nil
}

func (fixture *p005IntakeFixture) InterruptPlans(_ context.Context, command intake.PlanActionCommand, _ domainproject.Visibility) (intake.MutationResult, error) {
	fixture.planActionCalls++
	fixture.lastPlanAction, fixture.lastPlanActionName = command, "interrupt"
	return intake.MutationResult{}, nil
}

func (fixture *p005IntakeFixture) ResumePlans(_ context.Context, command intake.PlanActionCommand, _ domainproject.Visibility) (intake.MutationResult, error) {
	fixture.planActionCalls++
	fixture.lastPlanAction, fixture.lastPlanActionName = command, "resume"
	return intake.MutationResult{}, nil
}

func (fixture *p005IntakeFixture) AppendTask(_ context.Context, command intake.PlanActionCommand, _ domainproject.Visibility) (intake.MutationResult, error) {
	fixture.planActionCalls++
	fixture.lastPlanAction, fixture.lastPlanActionName = command, "append-task"
	return intake.MutationResult{}, nil
}

func (fixture *p005IntakeFixture) Links(context.Context, int64, domainintake.Type, int64) ([]intake.LinkedPlanDTO, error) {
	return []intake.LinkedPlanDTO{}, nil
}

func (fixture *p005IntakeFixture) ReplaceLinks(context.Context, intake.ReplaceLinksCommand, domainproject.Visibility) (intake.MutationResult, error) {
	return intake.MutationResult{}, nil
}

func (fixture *p005IntakeFixture) Delete(context.Context, intake.DeleteCommand, domainproject.Visibility) (intake.MutationResult, error) {
	return intake.MutationResult{}, nil
}

func TestP005IntakeRoutesUseSharedServiceAndStrictJSON(t *testing.T) {
	service := &p005IntakeFixture{items: []intake.IntakeDTO{{ID: 7, ProjectID: 4, Type: domainintake.Requirement, Title: "fixture", Body: "body", Status: domainintake.StatusOpen, LinkedPlans: []intake.LinkedPlanDTO{}}}}
	router, credential := newP005IntakeRouter(t, service)
	requirementsURL := "/api/v1/projects/4/requirements"

	listed := serveP005IntakeRequest(router, credential, http.MethodGet, requirementsURL+"?page=1&page_size=50", nil, "")
	if listed.Code != http.StatusOK || service.listCalls != 1 {
		t.Fatalf("list status=%d calls=%d", listed.Code, service.listCalls)
	}
	var listBody struct {
		Data []intake.IntakeDTO `json:"data"`
	}
	if err := json.Unmarshal(listed.Body.Bytes(), &listBody); err != nil || len(listBody.Data) != 1 || listBody.Data[0].ID != 7 {
		t.Fatalf("list contract drift: %v %s", err, listed.Body.String())
	}

	created := serveP005IntakeRequest(router, credential, http.MethodPost, requirementsURL,
		strings.NewReader(`{"title":"new","body":"details","status":"open"}`), "intent-p005")
	if created.Code != http.StatusCreated || service.createCalls != 1 || service.lastCreate.ProjectID != 4 ||
		service.lastCreate.Type != domainintake.Requirement || service.lastCreate.Body != "details" ||
		service.lastCreate.Metadata.IdempotencyKey != "intent-p005" || !service.visible {
		t.Fatalf("create status=%d command=%#v", created.Code, service.lastCreate)
	}

	invalid := serveP005IntakeRequest(router, credential, http.MethodPost, requirementsURL,
		strings.NewReader(`{"body":"details","unknown":true}`), "intent-p006")
	assertContractError(t, invalid, http.StatusBadRequest, string(CodeInvalidJSON), false)
	if service.createCalls != 1 {
		t.Fatal("unknown JSON field reached intake service")
	}
	badPage := serveP005IntakeRequest(router, credential, http.MethodGet, requirementsURL+"?status=wrong", nil, "")
	assertContractError(t, badPage, http.StatusBadRequest, string(CodeInvalidPagination), false)
}

func TestP005IntakeErrorsRemainTransportSafe(t *testing.T) {
	service := &p005IntakeFixture{getError: repository.ErrNotFound}
	router, credential := newP005IntakeRouter(t, service)
	response := serveP005IntakeRequest(router, credential, http.MethodGet, "/api/v1/projects/4/requirements/9", nil, "")
	assertContractError(t, response, http.StatusNotFound, string(CodeIntakeNotFound), false)

	unauthorized := httptest.NewRequest(http.MethodPost, "http://"+testAuthority+RequirementsPath[:len(RequirementsPath)-len("{project_id}")]+"4/requirements", strings.NewReader(strings.Repeat("x", 2048)))
	unauthorized.Header.Set("Origin", testOrigin)
	unauthorized.Header.Set("Content-Type", "multipart/form-data; boundary=p005")
	response = httptest.NewRecorder()
	router.ServeHTTP(response, unauthorized)
	assertContractError(t, response, http.StatusUnauthorized, string(CodeUnauthorized), false)
}

func TestP005RetryPlanGenerationUsesFixedIntakeMutationRoute(t *testing.T) {
	service := &p005IntakeFixture{}
	router, credential := newP005IntakeRouter(t, service)
	response := serveP005IntakeRequest(router, credential, http.MethodPost,
		"/api/v1/projects/4/intake/requirement/9/actions/retry-plan-generation", strings.NewReader(`{}`), "retry-plan-9")
	if response.Code != http.StatusOK || service.retryCalls != 1 || service.lastRetry.ProjectID != 4 ||
		service.lastRetry.Type != domainintake.Requirement || service.lastRetry.ID != 9 || service.lastRetry.Metadata.IdempotencyKey != "retry-plan-9" {
		t.Fatalf("status=%d calls=%d command=%#v body=%s", response.Code, service.retryCalls, service.lastRetry, response.Body.String())
	}
}

func TestIntakeLinkedPlanActionsUseGoServiceAndPreserveAppendTitle(t *testing.T) {
	service := &p005IntakeFixture{}
	router, credential := newP005IntakeRouter(t, service)
	cases := []struct {
		name, path, body, action, title string
	}{
		{"interrupt", "/api/v1/projects/4/intake/requirement/9/actions/interrupt", `{}`, "interrupt", ""},
		{"resume", "/api/v1/projects/4/intake/feedback/9/actions/resume", `{}`, "resume", ""},
		{"append", "/api/v1/projects/4/intake/requirement/9/actions/append-task", `{"title":"write Go tests"}`, "append-task", "write Go tests"},
	}
	for _, item := range cases {
		t.Run(item.name, func(t *testing.T) {
			response := serveP005IntakeRequest(router, credential, http.MethodPost, item.path,
				strings.NewReader(item.body), "intake-action-"+item.name)
			if response.Code != http.StatusOK || service.lastPlanActionName != item.action ||
				service.lastPlanAction.ProjectID != 4 || service.lastPlanAction.ID != 9 ||
				service.lastPlanAction.Title != item.title ||
				service.lastPlanAction.Metadata.IdempotencyKey != "intake-action-"+item.name {
				t.Fatalf("status=%d action=%s command=%#v body=%s", response.Code, service.lastPlanActionName, service.lastPlanAction, response.Body.String())
			}
		})
	}
	if service.planActionCalls != len(cases) {
		t.Fatalf("plan action call count=%d", service.planActionCalls)
	}
}

func newP005IntakeRouter(t *testing.T, service IntakeService) (*Router, string) {
	t.Helper()
	clock := fixedClock{value: time.Date(2026, 7, 11, 4, 0, 0, 0, time.UTC)}
	manager, err := session.New(bytes.NewReader(bytes.Repeat([]byte{0x4a}, 32)))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(manager.Close)
	origins, err := config.NewOriginSet([]string{testOrigin})
	if err != nil {
		t.Fatal(err)
	}
	security, err := NewSecurity(SecurityOptions{Sessions: manager, Origins: origins, ExpectedHost: config.DefaultListenHost, ExpectedPort: 43123, Logger: &recordingLogger{}, Clock: clock})
	if err != nil {
		t.Fatal(err)
	}
	router, err := NewRouter(RouterOptions{Application: &testApplication{}, Logger: &recordingLogger{}, Clock: clock, RequestIDs: fixedRequestIDs{}, BodyLimitBytes: 1024})
	if err != nil {
		t.Fatal(err)
	}
	if err := RegisterIntake(router, security, service); err != nil {
		t.Fatal(err)
	}
	return router, string(manager.CredentialCopy())
}

func serveP005IntakeRequest(router http.Handler, credential, method, target string, body *strings.Reader, key string) *httptest.ResponseRecorder {
	var content *strings.Reader
	if body == nil {
		content = strings.NewReader("")
	} else {
		content = body
	}
	request := httptest.NewRequest(method, target, content)
	request.Host = testAuthority
	request.Header.Set("Origin", testOrigin)
	request.Header.Set(session.HeaderName, credential)
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	if key != "" {
		request.Header.Set(IdempotencyKeyHeader, key)
	}
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	return response
}
