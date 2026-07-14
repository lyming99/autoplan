package httpapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	applicationintake "github.com/lyming99/autoplan/backend/internal/application/intake"
	domainintake "github.com/lyming99/autoplan/backend/internal/domain/intake"
	domainproject "github.com/lyming99/autoplan/backend/internal/domain/project"
	"github.com/lyming99/autoplan/backend/internal/platform/session"
	"github.com/lyming99/autoplan/backend/internal/repository"
)

type p008IntakeServiceSpy struct {
	calls int
	err   error
}

func (spy *p008IntakeServiceSpy) List(context.Context, applicationintake.ListQuery) ([]applicationintake.IntakeDTO, error) {
	spy.calls++
	return nil, spy.err
}

func (spy *p008IntakeServiceSpy) Get(context.Context, int64, domainintake.Type, int64) (applicationintake.IntakeDTO, error) {
	spy.calls++
	return applicationintake.IntakeDTO{}, spy.err
}

func (spy *p008IntakeServiceSpy) Create(context.Context, applicationintake.CreateCommand, domainproject.Visibility) (applicationintake.MutationResult, error) {
	spy.calls++
	return applicationintake.MutationResult{}, spy.err
}

func (spy *p008IntakeServiceSpy) Update(context.Context, applicationintake.UpdateCommand, domainproject.Visibility) (applicationintake.MutationResult, error) {
	spy.calls++
	return applicationintake.MutationResult{}, spy.err
}

func (spy *p008IntakeServiceSpy) SetAcceptance(context.Context, applicationintake.AcceptanceCommand, domainproject.Visibility) (applicationintake.MutationResult, error) {
	spy.calls++
	return applicationintake.MutationResult{}, spy.err
}

func (spy *p008IntakeServiceSpy) RetryPlanGeneration(context.Context, applicationintake.RetryPlanGenerationCommand, domainproject.Visibility) (applicationintake.MutationResult, error) {
	spy.calls++
	return applicationintake.MutationResult{}, spy.err
}

func (spy *p008IntakeServiceSpy) InterruptPlans(context.Context, applicationintake.PlanActionCommand, domainproject.Visibility) (applicationintake.MutationResult, error) {
	spy.calls++
	return applicationintake.MutationResult{}, spy.err
}

func (spy *p008IntakeServiceSpy) ResumePlans(context.Context, applicationintake.PlanActionCommand, domainproject.Visibility) (applicationintake.MutationResult, error) {
	spy.calls++
	return applicationintake.MutationResult{}, spy.err
}

func (spy *p008IntakeServiceSpy) AppendTask(context.Context, applicationintake.PlanActionCommand, domainproject.Visibility) (applicationintake.MutationResult, error) {
	spy.calls++
	return applicationintake.MutationResult{}, spy.err
}

func (spy *p008IntakeServiceSpy) Links(context.Context, int64, domainintake.Type, int64) ([]applicationintake.LinkedPlanDTO, error) {
	spy.calls++
	return nil, spy.err
}

func (spy *p008IntakeServiceSpy) ReplaceLinks(context.Context, applicationintake.ReplaceLinksCommand, domainproject.Visibility) (applicationintake.MutationResult, error) {
	spy.calls++
	return applicationintake.MutationResult{}, spy.err
}

func (spy *p008IntakeServiceSpy) Delete(context.Context, applicationintake.DeleteCommand, domainproject.Visibility) (applicationintake.MutationResult, error) {
	spy.calls++
	return applicationintake.MutationResult{}, spy.err
}

func TestP008IntakeAuthorizationMatrixRejectsBeforeService(t *testing.T) {
	service := &p008IntakeServiceSpy{}
	router, credential := newP005IntakeRouter(t, service)
	path := "/api/v1/projects/1/requirements/9"
	cases := []struct {
		name    string
		prepare func(*http.Request)
		status  int
		code    ErrorCode
	}{
		{
			name:    "missing session",
			prepare: func(request *http.Request) { request.Header.Set("Origin", testOrigin) },
			status:  http.StatusUnauthorized, code: CodeUnauthorized,
		},
		{
			name: "forged session",
			prepare: func(request *http.Request) {
				request.Header.Set("Origin", testOrigin)
				request.Header.Set(session.HeaderName, "forged")
			},
			status: http.StatusUnauthorized, code: CodeUnauthorized,
		},
		{
			name: "foreign origin",
			prepare: func(request *http.Request) {
				request.Header.Set("Origin", "http://127.0.0.1:43125")
				request.Header.Set(session.HeaderName, credential)
			},
			status: http.StatusForbidden, code: CodeOriginForbidden,
		},
		{
			name: "forged host",
			prepare: func(request *http.Request) {
				request.Host = "127.0.0.1:43124"
				request.Header.Set("Origin", testOrigin)
				request.Header.Set(session.HeaderName, credential)
			},
			status: http.StatusForbidden, code: CodeOriginForbidden,
		},
		{
			name: "forwarded host",
			prepare: func(request *http.Request) {
				request.Header.Set("Origin", testOrigin)
				request.Header.Set(session.HeaderName, credential)
				request.Header.Set("X-Forwarded-Host", "private.example")
			},
			status: http.StatusForbidden, code: CodeOriginForbidden,
		},
	}
	for _, item := range cases {
		t.Run(item.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodGet, "http://"+testAuthority+path, nil)
			item.prepare(request)
			response := httptest.NewRecorder()
			router.ServeHTTP(response, request)
			assertContractError(t, response, item.status, string(item.code), false)
		})
	}
	if service.calls != 0 {
		t.Fatalf("unauthorized intake requests reached service %d times", service.calls)
	}
}

func TestP008IntakeCrossProjectEnumerationAndUnavailableWriterHaveStableErrors(t *testing.T) {
	service := &p008IntakeServiceSpy{err: repository.ErrProjectMismatch}
	router, credential := newP005IntakeRouter(t, service)
	response := serveP008Intake(router, credential, http.MethodGet, "/api/v1/projects/1/feedback/99", nil, "")
	assertContractError(t, response, http.StatusNotFound, string(CodeIntakeNotFound), false)
	if strings.Contains(response.Body.String(), "99") || strings.Contains(response.Body.String(), "project") {
		t.Fatalf("enumeration response leaked resource identity: %s", response.Body.String())
	}

	service.err = repository.ErrWriterUnauthorized
	response = serveP008Intake(router, credential, http.MethodGet, "/api/v1/projects/1/requirements?page=1&page_size=1", nil, "")
	assertContractError(t, response, http.StatusServiceUnavailable, string(CodeRepositoryUnavailable), true)
	if service.calls != 2 {
		t.Fatalf("authorized requests should reach application exactly twice, calls=%d", service.calls)
	}
}

func TestP008IntakeRejectsUnknownOrOversizedBodiesBeforeService(t *testing.T) {
	service := &p008IntakeServiceSpy{}
	router, credential := newP005IntakeRouter(t, service)
	response := serveP008Intake(router, credential, http.MethodPost, "/api/v1/projects/1/requirements",
		strings.NewReader(`{"body":"fixture","unexpected":true}`), "body-unknown")
	assertContractError(t, response, http.StatusBadRequest, string(CodeInvalidJSON), false)

	response = serveP008Intake(router, credential, http.MethodPost, "/api/v1/projects/1/requirements",
		strings.NewReader(`{"body":"`+strings.Repeat("x", 2048)+`"}`), "body-large")
	assertContractError(t, response, http.StatusRequestEntityTooLarge, string(CodeBodyTooLarge), false)
	if service.calls != 0 {
		t.Fatalf("invalid input reached service %d times", service.calls)
	}
}

func serveP008Intake(router http.Handler, credential, method, target string, body *strings.Reader, key string) *httptest.ResponseRecorder {
	var reader *strings.Reader
	if body == nil {
		reader = strings.NewReader("")
	} else {
		reader = body
	}
	request := httptest.NewRequest(method, "http://"+testAuthority+target, reader)
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
