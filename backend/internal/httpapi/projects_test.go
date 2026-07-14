package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	applicationprojects "github.com/lyming99/autoplan/backend/internal/application/projects"
	"github.com/lyming99/autoplan/backend/internal/config"
	"github.com/lyming99/autoplan/backend/internal/domain/contracts"
	domainproject "github.com/lyming99/autoplan/backend/internal/domain/project"
	"github.com/lyming99/autoplan/backend/internal/platform/session"
	"github.com/lyming99/autoplan/backend/internal/repository"
)

type projectServiceFixture struct {
	projects      []contracts.Project
	project       contracts.Project
	snapshot      contracts.AppSnapshot
	listError     error
	getError      error
	snapshotError error
	waitForCancel bool
	listCalls     int
	getCalls      int
	snapshotCalls int
	createCalls   int
	updateCalls   int
	deleteCalls   int
	lastID        int64
	visiblePath   bool
	mutationError error
	lastCreate    applicationprojects.CreateCommand
	lastUpdate    applicationprojects.UpdateCommand
	lastDelete    applicationprojects.DeleteCommand
}

func (fixture *projectServiceFixture) List(
	ctx context.Context,
	visibility domainproject.Visibility,
) ([]contracts.Project, error) {
	fixture.listCalls++
	fixture.visiblePath = visibility.WorkspacePath
	if fixture.waitForCancel {
		<-ctx.Done()
		return nil, ctx.Err()
	}
	return fixture.projects, fixture.listError
}

func (fixture *projectServiceFixture) Get(
	_ context.Context,
	projectID int64,
	visibility domainproject.Visibility,
) (contracts.Project, error) {
	fixture.getCalls++
	fixture.lastID = projectID
	fixture.visiblePath = visibility.WorkspacePath
	return fixture.project, fixture.getError
}

func (fixture *projectServiceFixture) Snapshot(
	_ context.Context,
	projectID *int64,
	visibility domainproject.Visibility,
) (contracts.AppSnapshot, error) {
	fixture.snapshotCalls++
	if projectID != nil {
		fixture.lastID = *projectID
	}
	fixture.visiblePath = visibility.WorkspacePath
	return fixture.snapshot, fixture.snapshotError
}

func (fixture *projectServiceFixture) Create(_ context.Context, command applicationprojects.CreateCommand, visibility domainproject.Visibility) (contracts.AppSnapshot, error) {
	fixture.createCalls++
	fixture.lastCreate = command
	fixture.visiblePath = visibility.WorkspacePath
	return fixture.snapshot, fixture.mutationError
}

func (fixture *projectServiceFixture) Update(_ context.Context, command applicationprojects.UpdateCommand, visibility domainproject.Visibility) (contracts.AppSnapshot, error) {
	fixture.updateCalls++
	fixture.lastUpdate = command
	fixture.lastID = command.ProjectID
	fixture.visiblePath = visibility.WorkspacePath
	return fixture.snapshot, fixture.mutationError
}

func (fixture *projectServiceFixture) Delete(_ context.Context, command applicationprojects.DeleteCommand, visibility domainproject.Visibility) (contracts.AppSnapshot, error) {
	fixture.deleteCalls++
	fixture.lastDelete = command
	fixture.lastID = command.ProjectID
	fixture.visiblePath = visibility.WorkspacePath
	return fixture.snapshot, fixture.mutationError
}

func TestProjectsListUsesStableEnvelopeAndPagination(t *testing.T) {
	service := &projectServiceFixture{projects: []contracts.Project{
		projectContractFixture(3), projectContractFixture(2), projectContractFixture(1),
	}}
	router, credential := newProjectsRouter(t, service, 0)

	response := serveProjectRequest(router, credential, http.MethodGet, ProjectsPath+"?page=1&page_size=2&sort=updated_at_desc")
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	var body struct {
		Data       []contracts.Project `json:"data"`
		Pagination struct {
			Page     int  `json:"page"`
			PageSize int  `json:"page_size"`
			Total    int  `json:"total"`
			NextPage *int `json:"next_page"`
		} `json:"pagination"`
		RequestID string `json:"request_id"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if len(body.Data) != 2 || body.Data[0].ID != 3 || body.Data[1].ID != 2 ||
		body.Pagination.Page != 1 || body.Pagination.PageSize != 2 || body.Pagination.Total != 3 ||
		body.Pagination.NextPage == nil || *body.Pagination.NextPage != 2 ||
		body.RequestID != "req_generated_fixture" {
		t.Fatalf("unexpected list envelope: %+v", body)
	}
	if !service.visiblePath || response.Header().Get("Cache-Control") != "no-store" ||
		response.Header().Get("Content-Type") != contentTypeJSON {
		t.Fatal("protected project response headers or visibility drifted")
	}

	empty := serveProjectRequest(router, credential, http.MethodGet, ProjectsPath+"?page=3&page_size=2")
	if empty.Code != http.StatusOK {
		t.Fatalf("empty page status=%d", empty.Code)
	}
	var emptyBody struct {
		Data       []contracts.Project `json:"data"`
		Pagination struct {
			NextPage *int `json:"next_page"`
		} `json:"pagination"`
	}
	if json.Unmarshal(empty.Body.Bytes(), &emptyBody) != nil || len(emptyBody.Data) != 0 || emptyBody.Pagination.NextPage != nil {
		t.Fatal("out-of-range page must be a stable empty page")
	}
}

func TestProjectsRejectInvalidPaginationBeforeService(t *testing.T) {
	service := &projectServiceFixture{}
	router, credential := newProjectsRouter(t, service, 0)
	queries := []string{
		"page=0", "page=-1", "page=01", "page=one", "page=1&page=2", "page_size=0",
		"page_size=201", "page_size=", "sort=name", "sort=updated_at_desc&sort=updated_at_desc",
		"cursor=fixture", "bad;query=value",
	}
	for _, query := range queries {
		response := serveProjectRequest(router, credential, http.MethodGet, ProjectsPath+"?"+query)
		assertContractError(t, response, http.StatusBadRequest, string(CodeInvalidPagination), false)
	}
	if service.listCalls != 0 {
		t.Fatal("invalid pagination reached the application service")
	}
}

func TestProjectsRejectMissingSessionBeforeService(t *testing.T) {
	service := &projectServiceFixture{}
	router, _ := newProjectsRouter(t, service, 0)
	request := httptest.NewRequest(http.MethodGet, "http://"+testAuthority+ProjectsPath, nil)
	request.Header.Set("Origin", testOrigin)
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	assertContractError(t, response, http.StatusUnauthorized, string(CodeUnauthorized), false)
	if service.listCalls != 0 {
		t.Fatal("unauthorized request reached the application service")
	}
}

func TestProjectAndSnapshotRoutesValidateIDAndUseSharedService(t *testing.T) {
	service := &projectServiceFixture{
		project: projectContractFixture(7),
		snapshot: contracts.AppSnapshot{
			Projects: []contracts.Project{}, MCP: contracts.SanitizedObject{},
			Requirements: []contracts.SanitizedObject{}, Feedback: []contracts.SanitizedObject{},
			Attachments: []contracts.SanitizedObject{}, Plans: []contracts.SanitizedObject{},
			Tasks: []contracts.SanitizedObject{}, Events: []contracts.SanitizedObject{},
			Scans: []contracts.SanitizedObject{}, ScanSummary: contracts.SanitizedObject{},
			Scripts: []contracts.SanitizedObject{}, Executors: []contracts.SanitizedObject{},
			Terminals: []contracts.SanitizedObject{}, ActiveOperations: []contracts.SanitizedObject{},
		},
	}
	router, credential := newProjectsRouter(t, service, 0)

	project := serveProjectRequest(router, credential, http.MethodGet, "/api/v1/projects/7")
	if project.Code != http.StatusOK || service.getCalls != 1 || service.lastID != 7 || !service.visiblePath {
		t.Fatalf("project route status=%d calls=%d id=%d", project.Code, service.getCalls, service.lastID)
	}
	snapshot := serveProjectRequest(router, credential, http.MethodGet, "/api/v1/projects/7/snapshot")
	if snapshot.Code != http.StatusOK || service.snapshotCalls != 1 || service.lastID != 7 {
		t.Fatalf("snapshot route status=%d calls=%d id=%d", snapshot.Code, service.snapshotCalls, service.lastID)
	}
	for _, path := range []string{"/api/v1/projects/0", "/api/v1/projects/-1", "/api/v1/projects/01", "/api/v1/projects/not-an-id/snapshot"} {
		response := serveProjectRequest(router, credential, http.MethodGet, path)
		assertContractError(t, response, http.StatusBadRequest, string(CodeInvalidProjectID), false)
	}
}

func TestProjectsHEADMethodAndServiceErrorsAreStable(t *testing.T) {
	service := &projectServiceFixture{projects: []contracts.Project{projectContractFixture(1)}}
	router, credential := newProjectsRouter(t, service, 0)
	head := serveProjectRequest(router, credential, http.MethodHead, ProjectsPath)
	if head.Code != http.StatusOK || head.Body.Len() != 0 || head.Header().Get("Content-Type") != contentTypeJSON ||
		head.Header().Get("Content-Length") == "" {
		t.Fatalf("HEAD status=%d length=%d content-type=%q", head.Code, head.Body.Len(), head.Header().Get("Content-Type"))
	}
	method := serveProjectRequest(router, credential, http.MethodPut, ProjectsPath)
	assertContractError(t, method, http.StatusMethodNotAllowed, string(CodeMethodNotAllowed), false)
	if method.Header().Get("Allow") != "GET, HEAD, POST" {
		t.Fatalf("Allow=%q", method.Header().Get("Allow"))
	}

	cases := []struct {
		err       error
		status    int
		code      ErrorCode
		retryable bool
	}{
		{domainproject.ErrNotFound, http.StatusNotFound, CodeProjectNotFound, false},
		{repository.ErrSchemaDrift, http.StatusInternalServerError, CodeRepositorySchemaDrift, false},
		{repository.ErrInvalidStore, http.StatusServiceUnavailable, CodeRepositoryUnavailable, true},
		{errors.New("sensitive internal failure"), http.StatusInternalServerError, CodeInternal, false},
	}
	for _, item := range cases {
		service.getError = item.err
		response := serveProjectRequest(router, credential, http.MethodGet, "/api/v1/projects/9")
		assertContractError(t, response, item.status, string(item.code), item.retryable)
		if item.code == CodeInternal && bytes.Contains(response.Body.Bytes(), []byte(item.err.Error())) {
			t.Fatal("internal error text leaked into the response")
		}
	}
}

func TestProjectMutationsUseStrictJSONIdempotencyAndSharedService(t *testing.T) {
	service := &projectServiceFixture{snapshot: contractSnapshot(projectContractFixture(1))}
	router, credential := newProjectsRouter(t, service, 0)

	created := serveProjectJSON(router, credential, http.MethodPost, ProjectsPath,
		`{"name":"Synthetic","workspace_path":"fixture/workspace","description":"safe"}`, "intent-1")
	if created.Code != http.StatusCreated || service.createCalls != 1 || service.lastCreate.Project.Name != "Synthetic" ||
		service.lastCreate.Metadata.IdempotencyKey != "intent-1" || service.lastCreate.Metadata.CallerScope == "" ||
		strings.Contains(service.lastCreate.Metadata.CallerScope, credential) ||
		service.lastCreate.Metadata.RequestID != "req_generated_fixture" {
		t.Fatalf("create status=%d command=%#v", created.Code, service.lastCreate)
	}

	updated := serveProjectJSON(router, credential, http.MethodPatch, ProjectsPath+"/1",
		`{"description":"updated"}`, "intent-2")
	if updated.Code != http.StatusOK || service.updateCalls != 1 || service.lastUpdate.ProjectID != 1 ||
		service.lastUpdate.Project.Description == nil || *service.lastUpdate.Project.Description != "updated" {
		t.Fatalf("update status=%d command=%#v", updated.Code, service.lastUpdate)
	}

	deleted := serveProjectRequest(router, credential, http.MethodDelete, ProjectsPath+"/1")
	if deleted.Code != http.StatusOK || service.deleteCalls != 1 || service.lastDelete.ProjectID != 1 {
		t.Fatalf("delete status=%d command=%#v", deleted.Code, service.lastDelete)
	}

	for _, body := range []string{`{}`, `{"name":"x","unknown":true}`, `{"name":"` + strings.Repeat("x", 201) + `"}`} {
		response := serveProjectJSON(router, credential, http.MethodPatch, ProjectsPath+"/1", body, "")
		if response.Code != http.StatusBadRequest {
			t.Fatalf("invalid body status=%d body=%s", response.Code, response.Body.String())
		}
	}
	badKey := serveProjectJSON(router, credential, http.MethodPost, ProjectsPath, `{"name":"Synthetic"}`, "bad key")
	assertContractError(t, badKey, http.StatusBadRequest, string(CodeInvalidIdempotencyKey), false)
	oversized := serveProjectJSON(router, credential, http.MethodPost, ProjectsPath,
		`{"name":"`+strings.Repeat("x", 1100)+`"}`, "")
	assertContractError(t, oversized, http.StatusRequestEntityTooLarge, string(CodeBodyTooLarge), false)
	unauthorizedOversized := httptest.NewRequest(http.MethodPost, "http://"+testAuthority+ProjectsPath,
		strings.NewReader(`{"name":"`+strings.Repeat("x", 1100)+`"}`))
	unauthorizedOversized.Header.Set("Origin", testOrigin)
	unauthorizedOversized.Header.Set("Content-Type", "application/json")
	unauthorizedResponse := httptest.NewRecorder()
	router.ServeHTTP(unauthorizedResponse, unauthorizedOversized)
	assertContractError(t, unauthorizedResponse, http.StatusUnauthorized, string(CodeUnauthorized), false)
	plainRequest := httptest.NewRequest(http.MethodPost, "http://"+testAuthority+ProjectsPath, strings.NewReader(`{"name":"Synthetic"}`))
	plainRequest.Header.Set("Origin", testOrigin)
	plainRequest.Header.Set(session.HeaderName, credential)
	plainResponse := httptest.NewRecorder()
	router.ServeHTTP(plainResponse, plainRequest)
	assertContractError(t, plainResponse, http.StatusUnsupportedMediaType, string(CodeUnsupportedMediaType), false)
}

func TestProjectListFilterAndSortWhitelist(t *testing.T) {
	service := &projectServiceFixture{projects: []contracts.Project{
		{ID: 2, Name: "beta", CreatedAt: "2026-01-01T00:00:00.000Z", UpdatedAt: "2026-01-02T00:00:00.000Z"},
		{ID: 3, Name: "Alpha", CreatedAt: "2026-01-01T00:00:00.000Z", UpdatedAt: "2026-01-02T00:00:00.000Z"},
		{ID: 1, Name: "alphabet", CreatedAt: "2026-01-01T00:00:00.000Z", UpdatedAt: "2026-01-01T00:00:00.000Z"},
	}}
	router, credential := newProjectsRouter(t, service, 0)
	response := serveProjectRequest(router, credential, http.MethodGet, ProjectsPath+"?filter=alpha&sort=name_desc")
	var envelope projectListEnvelope
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &envelope) != nil || len(envelope.Data) != 2 ||
		envelope.Data[0].ID != 1 || envelope.Data[1].ID != 3 || envelope.Pagination.Total != 2 {
		t.Fatalf("filtered response=%s", response.Body.String())
	}
}

func TestProjectsTimeoutMapsWithoutLeakingServiceError(t *testing.T) {
	service := &projectServiceFixture{waitForCancel: true}
	router, credential := newProjectsRouter(t, service, time.Nanosecond)
	response := serveProjectRequest(router, credential, http.MethodGet, ProjectsPath)
	assertContractError(t, response, http.StatusGatewayTimeout, string(CodeRequestTimeout), true)
}

func newProjectsRouter(t *testing.T, service ProjectService, timeout time.Duration) (*Router, string) {
	t.Helper()
	clock := fixedClock{value: time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)}
	logger := &recordingLogger{}
	manager, err := session.New(bytes.NewReader(bytes.Repeat([]byte{0x37}, 32)))
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
		ExpectedPort: 43123, Logger: logger, Clock: clock,
	})
	if err != nil {
		t.Fatal(err)
	}
	router, err := NewRouter(RouterOptions{
		Application: &testApplication{}, Logger: logger, Clock: clock,
		RequestIDs: fixedRequestIDs{}, BodyLimitBytes: 1024, RequestTimeout: timeout,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := RegisterProjects(router, security, service); err != nil {
		t.Fatal(err)
	}
	credential := manager.CredentialCopy()
	return router, string(credential)
}

func serveProjectRequest(router http.Handler, credential, method, target string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, "http://"+testAuthority+target, nil)
	request.Header.Set("Origin", testOrigin)
	request.Header.Set(session.HeaderName, credential)
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	return response
}

func serveProjectJSON(router http.Handler, credential, method, target, body, key string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, "http://"+testAuthority+target, strings.NewReader(body))
	request.Header.Set("Origin", testOrigin)
	request.Header.Set(session.HeaderName, credential)
	request.Header.Set("Content-Type", "application/json")
	if key != "" {
		request.Header.Set(IdempotencyKeyHeader, key)
	}
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	return response
}

func projectContractFixture(id int64) contracts.Project {
	return contracts.Project{
		ID: id, Name: "fixture", WorkspacePath: "C:\\synthetic\\workspace",
		Description: "fixture", CreatedAt: "2026-01-02T03:04:05.000Z",
		UpdatedAt: "2026-01-02T03:04:05.000Z",
	}
}
