// Package logging emits fixed-schema, single-line JSON events. It does not
// accept arbitrary maps, request bodies, headers, paths, or error chains.
package logging

import (
	"encoding/json"
	"errors"
	"io"
	"log"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/lyming99/autoplan/backend/internal/platform/redaction"
)

type Clock interface {
	Now() time.Time
}

type Logger interface {
	Log(Event) error
}

// Event is the complete logging allowlist for the HTTP foundation.
type Event struct {
	OccurredAt      time.Time `json:"occurred_at"`
	Level           string    `json:"level"`
	Code            string    `json:"code"`
	ErrorCode       string    `json:"error_code,omitempty"`
	RequestID       string    `json:"request_id,omitempty"`
	Method          string    `json:"method,omitempty"`
	Route           string    `json:"route,omitempty"`
	Provider        string    `json:"provider,omitempty"`
	Stage           string    `json:"stage,omitempty"`
	Status          int       `json:"status,omitempty"`
	DurationMS      int64     `json:"duration_ms,omitempty"`
	ProjectID       int64     `json:"project_id,omitempty"`
	IntakeID        int64     `json:"intake_id,omitempty"`
	PlanID          int64     `json:"plan_id,omitempty"`
	TaskID          int64     `json:"task_id,omitempty"`
	ExitCode        int       `json:"exit_code,omitempty"`
	StdoutBytes     int64     `json:"stdout_bytes,omitempty"`
	StderrBytes     int64     `json:"stderr_bytes,omitempty"`
	StdoutLines     int64     `json:"stdout_lines,omitempty"`
	StderrLines     int64     `json:"stderr_lines,omitempty"`
	PendingIntakes  int       `json:"pending_intakes,omitempty"`
	GeneratedPlans  int       `json:"generated_plans,omitempty"`
	ProcessedPlans  int       `json:"processed_plans,omitempty"`
	Retryable       bool      `json:"retryable"`
	TimedOut        bool      `json:"timed_out,omitempty"`
	Cancelled       bool      `json:"cancelled,omitempty"`
	OutputTruncated bool      `json:"output_truncated,omitempty"`
	RedactionFailed bool      `json:"redaction_failed,omitempty"`
}

var safeToken = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$`)
var safeRoute = regexp.MustCompile(`^/[a-zA-Z0-9._~!$&'()*+,;=:@%/-]{0,255}$`)

type JSONLogger struct {
	mu     sync.Mutex
	writer io.Writer
	clock  Clock
}

func NewJSONLogger(writer io.Writer, clock Clock) (*JSONLogger, error) {
	if writer == nil || clock == nil {
		return nil, errors.New("logging dependency is missing")
	}
	return &JSONLogger{writer: writer, clock: clock}, nil
}

func (logger *JSONLogger) Log(event Event) error {
	event = normalize(event, logger.clock)
	logger.mu.Lock()
	defer logger.mu.Unlock()
	return json.NewEncoder(logger.writer).Encode(event)
}

type Nop struct{}

func (Nop) Log(Event) error { return nil }

// StandardLogger adapts standard-library server diagnostics without forwarding
// their free-form text, which may contain paths, URLs, or parser details.
func StandardLogger(logger Logger, clock Clock) *log.Logger {
	return log.New(standardWriter{logger: logger, clock: clock}, "", 0)
}

type standardWriter struct {
	logger Logger
	clock  Clock
}

func (writer standardWriter) Write(content []byte) (written int, err error) {
	defer func() {
		if recover() != nil {
			written = len(content)
			err = nil
		}
	}()
	if writer.logger != nil && writer.clock != nil {
		_ = writer.logger.Log(Event{
			OccurredAt: clockTime(writer.clock), Level: "warn",
			Code: "server_diagnostic_redacted", Retryable: false,
		})
	}
	return len(content), nil
}

func normalize(event Event, clock Clock) Event {
	if event.OccurredAt.IsZero() {
		event.OccurredAt = clockTime(clock)
	}
	event.OccurredAt = event.OccurredAt.UTC()
	event.Level = safeValue(strings.ToLower(event.Level), "info")
	event.Code = safeValue(event.Code, "invalid_log_code")
	event.ErrorCode = safeOptional(event.ErrorCode)
	event.RequestID = safeOptional(event.RequestID)
	event.Method = safeOptional(event.Method)
	event.Provider = safeOptional(event.Provider)
	event.Stage = safeOptional(event.Stage)
	if event.Route != "" && event.Route != "unmatched" && !safeRoute.MatchString(event.Route) {
		event.Route = "redacted"
	}
	if event.Status < 0 || event.Status > 999 {
		event.Status = 0
	}
	if event.DurationMS < 0 {
		event.DurationMS = 0
	}
	if event.ProjectID < 0 {
		event.ProjectID = 0
	}
	if event.IntakeID < 0 {
		event.IntakeID = 0
	}
	if event.PlanID < 0 {
		event.PlanID = 0
	}
	if event.TaskID < 0 {
		event.TaskID = 0
	}
	if event.ExitCode < -255 || event.ExitCode > 255 {
		event.ExitCode = 0
	}
	event.StdoutBytes = nonNegative(event.StdoutBytes)
	event.StderrBytes = nonNegative(event.StderrBytes)
	event.StdoutLines = nonNegative(event.StdoutLines)
	event.StderrLines = nonNegative(event.StderrLines)
	if event.PendingIntakes < 0 {
		event.PendingIntakes = 0
	}
	if event.GeneratedPlans < 0 {
		event.GeneratedPlans = 0
	}
	if event.ProcessedPlans < 0 {
		event.ProcessedPlans = 0
	}
	return event
}

func nonNegative(value int64) int64 {
	if value < 0 {
		return 0
	}
	return value
}

func clockTime(clock Clock) (result time.Time) {
	defer func() {
		if recover() != nil {
			result = time.Now().UTC()
		}
	}()
	result = clock.Now().UTC()
	if result.IsZero() {
		return time.Now().UTC()
	}
	return result
}

func safeValue(value, fallback string) string {
	value = redaction.String(value)
	if !safeToken.MatchString(value) {
		return fallback
	}
	return value
}

func safeOptional(value string) string {
	if value == "" {
		return ""
	}
	return safeValue(value, "redacted")
}
