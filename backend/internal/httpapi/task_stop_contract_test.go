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

	"github.com/lyming99/autoplan/backend/internal/application/capabilities"
	applicationloop "github.com/lyming99/autoplan/backend/internal/application/loop"
	applicationtasks "github.com/lyming99/autoplan/backend/internal/application/tasks"
	"github.com/lyming99/autoplan/backend/internal/config"
	"github.com/lyming99/autoplan/backend/internal/platform/logging"
	"github.com/lyming99/autoplan/backend/internal/platform/session"
)

type taskStopRuntimeSpy struct {
	commands []applicationloop.Command
	reject   func(applicationloop.Command) error
}

func (spy *taskStopRuntimeSpy) Dispatch(_ context.Context, command applicationloop.Command) (applicationloop.Result, error) {
	spy.commands = append(spy.commands, command)
	if spy.reject != nil {
		if err := spy.reject(command); err != nil {
			return applicationloop.Result{}, err
		}
	}
	return applicationloop.Result{Operation: capabilities.OperationReference{
		OperationID: "operation-task-stop-fixture", Type: string(command.Kind), Status: "accepted",
		RequestID: command.RequestID, AcceptedAt: "2026-07-15T00:00:00.000Z",
	}}, nil
}

func TestTaskStopProjectRouteDispatchesClosedRuntimeCommand(t *testing.T) {
	spy := &taskStopRuntimeSpy{}
	router, credential := taskStopContractRouter(t, spy)
	response := serveTaskStopContractRequest(router, credential,
		"/api/v1/projects/7/tasks/11/actions/stop", `{"plan_id":3}`)

	if response.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	if strings.Contains(response.Body.String(), string(CodeRuntimeCommand)) {
		t.Fatalf("valid task.stop returned %s: %s", CodeRuntimeCommand, response.Body.String())
	}
	if len(spy.commands) != 1 {
		t.Fatalf("runtime dispatches=%d want=1", len(spy.commands))
	}
	command := spy.commands[0]
	if command.Version != applicationloop.ContractVersion || command.Kind != applicationloop.CommandTaskStop ||
		command.ProjectID != 7 || command.PlanID != 3 || command.TaskID != 11 ||
		command.CallerScope == "" || command.RequestID != "req_task_stop_fixture" ||
		command.IdempotencyKey != "task-stop-fixture" {
		t.Fatalf("runtime command=%#v", command)
	}
	var accepted operationAcceptedEnvelope
	if err := json.Unmarshal(response.Body.Bytes(), &accepted); err != nil {
		t.Fatal(err)
	}
	if accepted.Data.Type != string(applicationloop.CommandTaskStop) || accepted.Data.Status != "accepted" ||
		accepted.Data.RequestID != command.RequestID {
		t.Fatalf("accepted response=%#v", accepted)
	}
}

func TestTaskStopProjectRouteRejectsInvalidTargetsBeforeRuntime(t *testing.T) {
	for _, item := range []struct {
		name   string
		path   string
		body   string
		status int
		code   ErrorCode
	}{
		{"missing plan", "/api/v1/projects/7/tasks/11/actions/stop", `{}`, http.StatusUnprocessableEntity, CodeRuntimeCommand},
		{"negative plan", "/api/v1/projects/7/tasks/11/actions/stop", `{"plan_id":-3}`, http.StatusUnprocessableEntity, CodeRuntimeCommand},
		{"zero task", "/api/v1/projects/7/tasks/0/actions/stop", `{"plan_id":3}`, http.StatusUnprocessableEntity, CodeRuntimeCommand},
		{"non canonical task", "/api/v1/projects/7/tasks/011/actions/stop", `{"plan_id":3}`, http.StatusUnprocessableEntity, CodeRuntimeCommand},
		{"invalid task", "/api/v1/projects/7/tasks/not-a-task/actions/stop", `{"plan_id":3}`, http.StatusUnprocessableEntity, CodeRuntimeCommand},
		{"non canonical project", "/api/v1/projects/07/tasks/11/actions/stop", `{"plan_id":3}`, http.StatusBadRequest, CodeInvalidProjectID},
	} {
		t.Run(item.name, func(t *testing.T) {
			spy := &taskStopRuntimeSpy{}
			router, credential := taskStopContractRouter(t, spy)
			response := serveTaskStopContractRequest(router, credential, item.path, item.body)
			assertContractError(t, response, item.status, string(item.code), false)
			if len(spy.commands) != 0 {
				t.Fatalf("invalid target reached runtime: %#v", spy.commands)
			}
		})
	}
}

func TestTaskStopRuntimeOwnershipFailureUsesStableHTTPError(t *testing.T) {
	spy := &taskStopRuntimeSpy{reject: func(command applicationloop.Command) error {
		if command.ProjectID == 8 && command.PlanID == 3 && command.TaskID == 11 {
			return applicationloop.ErrInvalidCommand
		}
		return nil
	}}
	router, credential := taskStopContractRouter(t, spy)
	response := serveTaskStopContractRequest(router, credential,
		"/api/v1/projects/8/tasks/11/actions/stop", `{"plan_id":3}`)

	assertContractError(t, response, http.StatusUnprocessableEntity, string(CodeRuntimeCommand), false)
	if len(spy.commands) != 1 || spy.commands[0].Kind != applicationloop.CommandTaskStop {
		t.Fatalf("ownership check command=%#v", spy.commands)
	}
}

func taskStopContractRouter(t *testing.T, dispatcher applicationloop.Dispatcher) (*Router, string) {
	t.Helper()
	clock := fixedClock{value: time.Date(2026, 7, 15, 0, 0, 0, 0, time.UTC)}
	manager, err := session.New(bytes.NewReader(bytes.Repeat([]byte{0x3a}, 32)))
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
		ExpectedPort: 43123, Logger: logging.Nop{}, Clock: clock,
	})
	if err != nil {
		t.Fatal(err)
	}
	router, err := NewRouter(RouterOptions{
		Application: &testApplication{}, Logger: logging.Nop{}, Clock: clock,
		RequestIDs: fixedRequestIDs{}, BodyLimitBytes: 1024,
	})
	if err != nil {
		t.Fatal(err)
	}
	bridge, err := applicationloop.NewBridge(applicationtasks.NewRuntimeHandler(dispatcher))
	if err != nil {
		t.Fatal(err)
	}
	if err := RegisterProjectTaskActionRoutes(router, security, bridge); err != nil {
		t.Fatal(err)
	}
	credentialBytes := manager.CredentialCopy()
	if len(credentialBytes) == 0 {
		t.Fatal("session manager did not create a credential")
	}
	credential := string(credentialBytes)
	for index := range credentialBytes {
		credentialBytes[index] = 0
	}
	return router, credential
}

func serveTaskStopContractRequest(router *Router, credential, path, body string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	request.Host = testAuthority
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Origin", testOrigin)
	request.Header.Set(session.HeaderName, credential)
	request.Header.Set(RequestIDHeader, "req_task_stop_fixture")
	request.Header.Set(IdempotencyKeyHeader, "task-stop-fixture")
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	return response
}

var _ applicationloop.Dispatcher = (*taskStopRuntimeSpy)(nil)
