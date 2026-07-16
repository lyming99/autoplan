package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/lyming99/autoplan/backend/internal/domain/contracts"
	domainproject "github.com/lyming99/autoplan/backend/internal/domain/project"
	"github.com/lyming99/autoplan/backend/internal/platform/session"
	"github.com/lyming99/autoplan/backend/internal/repository"
)

func TestProjectsHTTPContractPaginationAndSharedService(t *testing.T) {
	service := &projectServiceFixture{projects: []contracts.Project{
		projectContractFixture(5), projectContractFixture(4), projectContractFixture(3),
		projectContractFixture(2), projectContractFixture(1),
	}}
	router, credential := newProjectsRouter(t, service, 0)
	cases := []struct {
		page     int
		ids      []int64
		nextPage *int
	}{
		{1, []int64{5, 4}, intPointer(2)},
		{2, []int64{3, 2}, intPointer(3)},
		{3, []int64{1}, nil},
		{4, []int64{}, nil},
	}
	for _, item := range cases {
		response := serveProjectRequest(router, credential, http.MethodGet,
			ProjectsPath+"?page="+strconvItoa(item.page)+"&page_size=2")
		if response.Code != http.StatusOK || response.Header().Get("Content-Type") != contentTypeJSON ||
			response.Header().Get(RequestIDHeader) != "req_generated_fixture" {
			t.Fatalf("page %d response contract drifted", item.page)
		}
		var envelope struct {
			Data       []contracts.Project `json:"data"`
			Pagination paginationEnvelope  `json:"pagination"`
			RequestID  string              `json:"request_id"`
		}
		if json.Unmarshal(response.Body.Bytes(), &envelope) != nil || envelope.RequestID != "req_generated_fixture" ||
			envelope.Pagination.Page != item.page || envelope.Pagination.PageSize != 2 ||
			envelope.Pagination.Total != 5 || !equalOptionalInt(envelope.Pagination.NextPage, item.nextPage) {
			t.Fatalf("page %d envelope drifted", item.page)
		}
		ids := make([]int64, len(envelope.Data))
		for index := range envelope.Data {
			ids[index] = envelope.Data[index].ID
		}
		if !equalInt64s(ids, item.ids) {
			t.Fatalf("page %d ids=%v", item.page, ids)
		}
	}
	if service.listCalls != len(cases) || !service.visiblePath {
		t.Fatal("pagination did not use the one protected application service")
	}
}

func TestProjectsHTTPSingleSnapshotAndStableFailureCatalog(t *testing.T) {
	project := projectContractFixture(7)
	service := &projectServiceFixture{project: project, snapshot: contractSnapshot(project)}
	router, credential := newProjectsRouter(t, service, 0)

	request := httptest.NewRequest(http.MethodGet, "http://"+testAuthority+"/api/v1/projects/7", nil)
	request.Header.Set("Origin", testOrigin)
	request.Header.Set(session.HeaderName, credential)
	request.Header.Set(RequestIDHeader, "req_contract_caller")
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Code != http.StatusOK || response.Header().Get(RequestIDHeader) != "req_contract_caller" ||
		service.getCalls != 1 || service.lastID != 7 {
		t.Fatal("single project response did not preserve request/service identity")
	}
	var projectEnvelope struct {
		Data      contracts.Project `json:"data"`
		RequestID string            `json:"request_id"`
	}
	if json.Unmarshal(response.Body.Bytes(), &projectEnvelope) != nil ||
		projectEnvelope.Data.ID != 7 || projectEnvelope.RequestID != "req_contract_caller" {
		t.Fatal("single project envelope drifted")
	}

	snapshotResponse := serveProjectRequest(router, credential, http.MethodGet, "/api/v1/projects/7/snapshot")
	if snapshotResponse.Code != http.StatusOK || service.snapshotCalls != 1 || service.lastID != 7 {
		t.Fatal("snapshot did not use the shared service")
	}
	var snapshotEnvelope struct {
		Data contracts.AppSnapshot `json:"data"`
	}
	if json.Unmarshal(snapshotResponse.Body.Bytes(), &snapshotEnvelope) != nil ||
		snapshotEnvelope.Data.ActiveProjectID == nil || *snapshotEnvelope.Data.ActiveProjectID != 7 ||
		snapshotEnvelope.Data.ModelUsage.Cumulative.TotalTokens != 48 ||
		len(snapshotEnvelope.Data.ModelUsage.ByProvider) != 1 ||
		snapshotEnvelope.Data.ModelUsage.ByProvider[0].Provider != "openai" {
		t.Fatal("snapshot envelope drifted")
	}
	if !strings.Contains(snapshotResponse.Body.String(), `"modelUsage"`) ||
		!strings.Contains(snapshotResponse.Body.String(), `"inputTokens"`) {
		t.Fatal("strongly typed model usage was not present in the HTTP contract")
	}

	failures := []struct {
		name      string
		prepare   func()
		method    string
		path      string
		status    int
		code      ErrorCode
		retryable bool
	}{
		{"invalid pagination", func() {}, http.MethodGet, ProjectsPath + "?page=0", 400, CodeInvalidPagination, false},
		{"invalid id", func() {}, http.MethodGet, "/api/v1/projects/no", 400, CodeInvalidProjectID, false},
		{"missing", func() { service.getError = domainproject.ErrNotFound }, http.MethodGet, "/api/v1/projects/8", 404, CodeProjectNotFound, false},
		{"method", func() {}, http.MethodDelete, ProjectsPath, 405, CodeMethodNotAllowed, false},
		{"schema", func() { service.getError = repository.ErrSchemaDrift }, http.MethodGet, "/api/v1/projects/8", 500, CodeRepositorySchemaDrift, false},
		{"readonly", func() { service.getError = repository.ErrInvalidStore }, http.MethodGet, "/api/v1/projects/8", 503, CodeRepositoryUnavailable, true},
		{"internal", func() { service.getError = errors.New("repository internal detail") }, http.MethodGet, "/api/v1/projects/8", 500, CodeInternal, false},
	}
	for _, item := range failures {
		service.getError = nil
		item.prepare()
		failure := serveProjectRequest(router, credential, item.method, item.path)
		assertContractError(t, failure, item.status, string(item.code), item.retryable)
		if strings.Contains(failure.Body.String(), "repository internal detail") {
			t.Fatal("internal repository detail escaped")
		}
	}
}

func TestProjectSnapshotHTTPExposesStrongModelUsageContract(t *testing.T) {
	project := projectContractFixture(7)
	service := &projectServiceFixture{snapshot: contractSnapshot(project)}
	router, credential := newProjectsRouter(t, service, 0)
	request := httptest.NewRequest(http.MethodGet, "/api/v1/projects/7/snapshot", nil)
	request.Host = testAuthority
	request.Header.Set("Origin", testOrigin)
	request.Header.Set(session.HeaderName, credential)
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	var envelope struct {
		Data contracts.AppSnapshot `json:"data"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &envelope); err != nil {
		t.Fatal(err)
	}
	if envelope.Data.ModelUsage.Cumulative.TotalTokens != 48 ||
		envelope.Data.ModelUsage.Today.TotalTokens != 17 || len(envelope.Data.ModelUsage.ByProvider) != 1 {
		t.Fatalf("model usage=%#v", envelope.Data.ModelUsage)
	}
}

func TestProjectsHTTPRejectsSecurityAndCancellationBeforeDataEscapes(t *testing.T) {
	service := &projectServiceFixture{}
	router, credential := newProjectsRouter(t, service, 0)

	missingSession := httptest.NewRequest(http.MethodGet, "http://"+testAuthority+ProjectsPath, nil)
	missingSession.Header.Set("Origin", testOrigin)
	missingResponse := httptest.NewRecorder()
	router.ServeHTTP(missingResponse, missingSession)
	assertContractError(t, missingResponse, 401, string(CodeUnauthorized), false)

	badOrigin := httptest.NewRequest(http.MethodGet, "http://"+testAuthority+ProjectsPath, nil)
	badOrigin.Header.Set("Origin", "http://127.0.0.1:43125")
	badOrigin.Header.Set(session.HeaderName, credential)
	badOriginResponse := httptest.NewRecorder()
	router.ServeHTTP(badOriginResponse, badOrigin)
	assertContractError(t, badOriginResponse, 403, string(CodeOriginForbidden), false)
	if service.listCalls != 0 {
		t.Fatal("security rejection reached the application service")
	}

	service.waitForCancel = true
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	cancelledRequest := httptest.NewRequest(http.MethodGet, "http://"+testAuthority+ProjectsPath, nil).WithContext(cancelled)
	cancelledRequest.Header.Set("Origin", testOrigin)
	cancelledRequest.Header.Set(session.HeaderName, credential)
	cancelledResponse := httptest.NewRecorder()
	router.ServeHTTP(cancelledResponse, cancelledRequest)
	assertContractError(t, cancelledResponse, 504, string(CodeRequestTimeout), true)
}

func TestProjectsHTTPMutationFailureCatalogPreservesRequestIDAndHidesIntent(t *testing.T) {
	service := &projectServiceFixture{snapshot: contractSnapshot(projectContractFixture(7))}
	router, credential := newProjectsRouter(t, service, 0)
	cases := []struct {
		name      string
		err       error
		status    int
		code      ErrorCode
		retryable bool
	}{
		{"missing", repository.ErrNotFound, http.StatusNotFound, CodeProjectNotFound, false},
		{"version required", repository.ErrVersionRequired, http.StatusPreconditionRequired, CodeVersionRequired, false},
		{"version conflict", repository.ErrVersionConflict, http.StatusConflict, CodeVersionConflict, false},
		{"key reused", repository.ErrIdempotencyKeyReuse, http.StatusConflict, CodeIdempotencyKeyReused, false},
		{"in progress", repository.ErrDuplicate, http.StatusConflict, CodeRequestInProgress, true},
		{"running", repository.ErrProjectRunning, http.StatusLocked, CodeProjectRunning, false},
		{"relation", repository.ErrRelationConflict, http.StatusConflict, CodeRelationConflict, false},
		{"busy", repository.ErrCommit, http.StatusLocked, CodeRepositoryBusy, true},
		{"schema", repository.ErrSchemaDrift, http.StatusInternalServerError, CodeRepositorySchemaDrift, false},
		{"unavailable", repository.ErrWriterUnauthorized, http.StatusServiceUnavailable, CodeRepositoryUnavailable, true},
		{"internal", errors.New("synthetic private application detail"), http.StatusInternalServerError, CodeInternal, false},
	}
	for _, item := range cases {
		t.Run(item.name, func(t *testing.T) {
			service.mutationError = item.err
			request := httptest.NewRequest(http.MethodPatch,
				"http://"+testAuthority+ProjectsPath+"/7", strings.NewReader(`{"description":"safe"}`))
			request.Header.Set("Origin", testOrigin)
			request.Header.Set(session.HeaderName, credential)
			request.Header.Set("Content-Type", contentTypeJSON)
			request.Header.Set(IdempotencyKeyHeader, "intent-contract-fixture")
			request.Header.Set(RequestIDHeader, "req_mutation_contract")
			response := httptest.NewRecorder()
			router.ServeHTTP(response, request)
			assertContractError(t, response, item.status, string(item.code), item.retryable)
			if response.Header().Get(RequestIDHeader) != "req_mutation_contract" ||
				strings.Contains(response.Body.String(), "intent-contract-fixture") ||
				strings.Contains(response.Body.String(), "synthetic private") ||
				strings.Contains(response.Body.String(), credential) {
				t.Fatal("mutation failure leaked request material or lost request identity")
			}
		})
	}
}

func TestProjectsHTTPRejectsHostAndMalformedBodyBeforeMutationService(t *testing.T) {
	service := &projectServiceFixture{snapshot: contractSnapshot(projectContractFixture(1))}
	router, credential := newProjectsRouter(t, service, 0)

	badHost := httptest.NewRequest(http.MethodPost, "http://127.0.0.1:43124"+ProjectsPath,
		strings.NewReader(`{"name":"Synthetic"}`))
	badHost.Host = "127.0.0.1:43124"
	badHost.Header.Set("Origin", testOrigin)
	badHost.Header.Set(session.HeaderName, credential)
	badHost.Header.Set("Content-Type", contentTypeJSON)
	badHostResponse := httptest.NewRecorder()
	router.ServeHTTP(badHostResponse, badHost)
	assertContractError(t, badHostResponse, http.StatusForbidden, string(CodeOriginForbidden), false)

	malformed := serveProjectJSON(router, credential, http.MethodPost, ProjectsPath,
		`{"name":"Synthetic"} trailing`, "intent-malformed")
	assertContractError(t, malformed, http.StatusBadRequest, string(CodeInvalidJSON), false)
	if service.createCalls != 0 || service.updateCalls != 0 || service.deleteCalls != 0 {
		t.Fatal("security or JSON rejection reached the mutation application service")
	}
}

func contractSnapshot(project contracts.Project) contracts.AppSnapshot {
	id := project.ID
	state := contracts.SanitizedObject{}
	return contracts.AppSnapshot{
		ActiveProjectID: &id, ActiveProject: &project, Projects: []contracts.Project{project},
		MCP: contracts.SanitizedObject{}, State: &state,
		Requirements: []contracts.SanitizedObject{}, Feedback: []contracts.SanitizedObject{},
		Attachments: []contracts.SanitizedObject{}, Plans: []contracts.SanitizedObject{},
		Tasks: []contracts.SanitizedObject{}, Events: []contracts.SanitizedObject{},
		Scans: []contracts.SanitizedObject{}, ScanSummary: contracts.SanitizedObject{},
		Scripts: []contracts.SanitizedObject{}, Executors: []contracts.SanitizedObject{},
		Terminals: []contracts.SanitizedObject{}, ActiveOperations: []contracts.SanitizedObject{},
		ModelUsage: contracts.ModelUsageSummary{
			Cumulative: contracts.ModelUsageTotals{InputTokens: 30, OutputTokens: 12, CachedTokens: 4, ReasoningTokens: 2, TotalTokens: 48},
			Today:      contracts.ModelUsageTotals{InputTokens: 10, OutputTokens: 5, CachedTokens: 1, ReasoningTokens: 1, TotalTokens: 17},
			ByProvider: []contracts.ModelUsageProvider{{
				Provider:   "openai",
				Cumulative: contracts.ModelUsageTotals{InputTokens: 30, OutputTokens: 12, CachedTokens: 4, ReasoningTokens: 2, TotalTokens: 48},
				Today:      contracts.ModelUsageTotals{InputTokens: 10, OutputTokens: 5, CachedTokens: 1, ReasoningTokens: 1, TotalTokens: 17},
			}},
		},
	}
}

func intPointer(value int) *int { return &value }

func equalOptionalInt(left, right *int) bool {
	return left == nil && right == nil || left != nil && right != nil && *left == *right
}

func equalInt64s(left, right []int64) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}

func strconvItoa(value int) string {
	const digits = "0123456789"
	if value >= 0 && value < len(digits) {
		return string(digits[value])
	}
	return "0"
}
