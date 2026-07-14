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

	applicationconfig "github.com/lyming99/autoplan/backend/internal/application/config"
	"github.com/lyming99/autoplan/backend/internal/config"
	"github.com/lyming99/autoplan/backend/internal/domain/contracts"
	domainproject "github.com/lyming99/autoplan/backend/internal/domain/project"
	"github.com/lyming99/autoplan/backend/internal/platform/session"
	"github.com/lyming99/autoplan/backend/internal/repository"
)

type configServiceFixture struct {
	snapshot       contracts.AppSnapshot
	err            error
	getCalls       int
	configureCalls int
	resetCalls     int
	lastID         int64
	lastConfigure  applicationconfig.ConfigureCommand
	lastReset      applicationconfig.ResetCommand
}

func (fixture *configServiceFixture) Get(_ context.Context, projectID int64, _ domainproject.Visibility) (contracts.AppSnapshot, error) {
	fixture.getCalls++
	fixture.lastID = projectID
	return fixture.snapshot, fixture.err
}

func (fixture *configServiceFixture) Configure(_ context.Context, command applicationconfig.ConfigureCommand, _ domainproject.Visibility) (contracts.AppSnapshot, error) {
	fixture.configureCalls++
	fixture.lastConfigure = command
	fixture.lastID = command.ProjectID
	return fixture.snapshot, fixture.err
}

func (fixture *configServiceFixture) Reset(_ context.Context, command applicationconfig.ResetCommand, _ domainproject.Visibility) (contracts.AppSnapshot, error) {
	fixture.resetCalls++
	fixture.lastReset = command
	fixture.lastID = command.ProjectID
	return fixture.snapshot, fixture.err
}

func TestConfigRoutesUseVersionedSharedServiceAndSafeSnapshot(t *testing.T) {
	fixture := &configServiceFixture{snapshot: configSnapshotFixture()}
	router, credential := newConfigRouter(t, fixture)

	get := serveConfigRequest(router, credential, http.MethodGet, "/api/v1/projects/1/loop-config", "", "")
	if get.Code != http.StatusOK || fixture.getCalls != 1 || fixture.lastID != 1 {
		t.Fatalf("get status=%d calls=%d", get.Code, fixture.getCalls)
	}

	patch := serveConfigRequest(router, credential, http.MethodPatch, "/api/v1/projects/1/loop-config", validConfigBody(), "config-intent")
	if patch.Code != http.StatusOK || fixture.configureCalls != 1 || fixture.lastConfigure.ExpectedVersion != 7 ||
		fixture.lastConfigure.Config.IntervalSeconds != 9 || fixture.lastConfigure.Metadata.IdempotencyKey != "config-intent" ||
		fixture.lastConfigure.Metadata.CallerScope == "" {
		t.Fatalf("patch status=%d command=%#v", patch.Code, fixture.lastConfigure)
	}

	reset := serveConfigRequest(router, credential, http.MethodDelete, "/api/v1/projects/1/loop-config", `{"version":8}`, "reset-intent")
	if reset.Code != http.StatusOK || fixture.resetCalls != 1 || fixture.lastReset.ExpectedVersion != 8 {
		t.Fatalf("reset status=%d command=%#v", reset.Code, fixture.lastReset)
	}

	encoded := get.Body.String() + patch.Body.String() + reset.Body.String()
	for _, forbidden := range []string{"X-Autoplan-Session", credential, "config-intent", "PRIVATE_VALUE"} {
		if strings.Contains(encoded, forbidden) {
			t.Fatal("config response leaked transport or secret material")
		}
	}
}

func TestConfigRejectsMalformedInputBeforeApplication(t *testing.T) {
	fixture := &configServiceFixture{snapshot: configSnapshotFixture()}
	router, credential := newConfigRouter(t, fixture)
	cases := []struct {
		body string
		code ErrorCode
	}{
		{`{"version":1,"unknown":true}`, CodeInvalidJSON},
		{`{"version":1,"settings":{"arbitrary":"value"}}`, CodeInvalidJSON},
		{`{"version":1,"secret_refs":["forbidden"]}`, CodeInvalidJSON},
		{strings.Replace(validConfigBody(), `"interval_seconds":9`, `"interval_seconds":0`, 1), CodeInvalidConfig},
	}
	for _, body := range []string{`{}`, `{"version":0}`} {
		invalidVersion := serveConfigRequest(router, credential, http.MethodPatch, "/api/v1/projects/1/loop-config", body, "")
		assertContractError(t, invalidVersion, http.StatusPreconditionRequired, string(CodeVersionRequired), false)
	}
	for _, item := range cases {
		response := serveConfigRequest(router, credential, http.MethodPatch, "/api/v1/projects/1/loop-config", item.body, "")
		assertContractError(t, response, http.StatusBadRequest, string(item.code), false)
	}
	missingVersion := serveConfigRequest(router, credential, http.MethodDelete, "/api/v1/projects/1/loop-config", `{}`, "")
	assertContractError(t, missingVersion, http.StatusPreconditionRequired, string(CodeVersionRequired), false)
	if fixture.configureCalls != 0 || fixture.resetCalls != 0 {
		t.Fatal("invalid config reached application service")
	}
}

func TestConfigStableMutationErrors(t *testing.T) {
	fixture := &configServiceFixture{snapshot: configSnapshotFixture()}
	router, credential := newConfigRouter(t, fixture)
	cases := []struct {
		err       error
		status    int
		code      ErrorCode
		retryable bool
	}{
		{repository.ErrVersionConflict, http.StatusConflict, CodeVersionConflict, false},
		{repository.ErrIdempotencyKeyReuse, http.StatusConflict, CodeIdempotencyKeyReused, false},
		{repository.ErrProjectRunning, http.StatusLocked, CodeProjectRunning, false},
		{repository.ErrTransaction, http.StatusLocked, CodeRepositoryBusy, true},
		{errors.New("sensitive internal detail"), http.StatusInternalServerError, CodeInternal, false},
	}
	for _, item := range cases {
		fixture.err = item.err
		response := serveConfigRequest(router, credential, http.MethodPatch, "/api/v1/projects/1/loop-config", validConfigBody(), "")
		assertContractError(t, response, item.status, string(item.code), item.retryable)
		if strings.Contains(response.Body.String(), item.err.Error()) {
			t.Fatal("application error detail escaped")
		}
	}
}

func TestStaticConfigRequestsPreserveWriteOnlySecrets(t *testing.T) {
	apiKey := "sk-write-only"
	authToken := "claude-write-only"
	ai := (aiConfigRequest{APIKey: &apiKey}).value()
	claude := (claudeConfigRequest{AuthToken: &authToken}).value()
	if ai.APIKey == nil || *ai.APIKey != apiKey {
		t.Fatalf("AI API key was dropped: %#v", ai.APIKey)
	}
	if claude.AuthToken == nil || *claude.AuthToken != authToken {
		t.Fatalf("Claude auth token was dropped: %#v", claude.AuthToken)
	}
	mcp := mcpConfigRequest{AuthToken: &authToken}
	if mcp.AuthToken == nil || *mcp.AuthToken != authToken {
		t.Fatalf("MCP auth token was dropped: %#v", mcp.AuthToken)
	}
}

func newConfigRouter(t *testing.T, service ConfigService) (*Router, string) {
	t.Helper()
	clock := fixedClock{value: time.Date(2026, 7, 11, 10, 0, 0, 0, time.UTC)}
	logger := &recordingLogger{}
	manager, err := session.New(bytes.NewReader(bytes.Repeat([]byte{0x47}, 32)))
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
		RequestIDs: fixedRequestIDs{}, BodyLimitBytes: 4096,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := RegisterConfig(router, security, service); err != nil {
		t.Fatal(err)
	}
	return router, string(manager.CredentialCopy())
}

func serveConfigRequest(router http.Handler, credential, method, target, body, key string) *httptest.ResponseRecorder {
	var reader *strings.Reader
	if body != "" {
		reader = strings.NewReader(body)
	} else {
		reader = strings.NewReader("")
	}
	request := httptest.NewRequest(method, "http://"+testAuthority+target, reader)
	request.Header.Set("Origin", testOrigin)
	request.Header.Set(session.HeaderName, credential)
	if body != "" {
		request.Header.Set("Content-Type", "application/json")
	}
	if key != "" {
		request.Header.Set(IdempotencyKeyHeader, key)
	}
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	return response
}

func validConfigBody() string {
	return `{"version":7,"interval_seconds":9,"validation_command":"","project_prompt":"safe",` +
		`"agent_cli_provider":"codex","agent_cli_command":"","codex_reasoning_effort":"high",` +
		`"plan_generation_strategy":"external-cli-markdown","plan_generation_provider":"codex",` +
		`"plan_generation_command":"","plan_generation_model":"","plan_generation_codex_reasoning_effort":"high",` +
		`"plan_execution_strategy":"external-cli","plan_execution_provider":"codex",` +
		`"plan_execution_command":"","plan_execution_model":"","plan_execution_codex_reasoning_effort":"high"}`
}

func configSnapshotFixture() contracts.AppSnapshot {
	project := projectContractFixture(1)
	snapshot := contractSnapshot(project)
	state := contracts.SanitizedObject{"version": json.RawMessage("8")}
	snapshot.State = &state
	return snapshot
}
