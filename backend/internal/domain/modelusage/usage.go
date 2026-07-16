// Package modelusage defines provider-neutral model token accounting values.
// It contains no provider payloads, prompts, credentials, persistence, or
// transport concerns.
package modelusage

import (
	"errors"
	"math"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

var ErrInvalid = errors.New("model usage is invalid")

// Source identifies the application boundary that made the model call.
type Source string

const (
	SourcePlanGeneration Source = "plan_generation"
	SourceTaskExecution  Source = "task_execution"
	SourceChat           Source = "chat"
)

func (source Source) Valid() bool {
	switch source {
	case SourcePlanGeneration, SourceTaskExecution, SourceChat:
		return true
	default:
		return false
	}
}

// Tokens preserves unavailable provider fields as nil. Callers must not infer
// missing values from prompt or response lengths.
type Tokens struct {
	Input     *int64 `json:"input_tokens"`
	Output    *int64 `json:"output_tokens"`
	Cached    *int64 `json:"cached_tokens"`
	Reasoning *int64 `json:"reasoning_tokens"`
	Total     *int64 `json:"total_tokens"`
}

// Totals is the lossless aggregate of the provider-reported fields. Missing
// fields contribute zero; they are never inferred from another field.
type Totals struct {
	Input     int64 `json:"input_tokens"`
	Output    int64 `json:"output_tokens"`
	Cached    int64 `json:"cached_tokens"`
	Reasoning int64 `json:"reasoning_tokens"`
	Total     int64 `json:"total_tokens"`
}

// ProviderAggregate keeps provider buckets deterministic and strongly typed.
type ProviderAggregate struct {
	Provider   string `json:"provider"`
	Cumulative Totals `json:"cumulative"`
	Today      Totals `json:"today"`
}

// Aggregate is a project-scoped usage view for one caller-defined local day.
// Day boundaries are UTC instants so persistence never depends on SQLite's
// process-local timezone.
type Aggregate struct {
	ProjectID      int64               `json:"project_id"`
	Cumulative     Totals              `json:"cumulative"`
	Today          Totals              `json:"today"`
	ByProvider     []ProviderAggregate `json:"by_provider"`
	TodayStartedAt string              `json:"today_started_at"`
	TodayEndsAt    string              `json:"today_ends_at"`
}

func (tokens Tokens) Validate() error {
	known := false
	for _, value := range []*int64{tokens.Input, tokens.Output, tokens.Cached, tokens.Reasoning, tokens.Total} {
		if value == nil {
			continue
		}
		known = true
		if *value < 0 {
			return ErrInvalid
		}
	}
	if !known {
		return ErrInvalid
	}
	return nil
}

// Add rejects overflow instead of allowing aggregate counters to wrap.
func (totals *Totals) Add(tokens Tokens) error {
	if totals == nil || tokens.Validate() != nil {
		return ErrInvalid
	}
	values := []*int64{tokens.Input, tokens.Output, tokens.Cached, tokens.Reasoning, tokens.Total}
	targets := []*int64{&totals.Input, &totals.Output, &totals.Cached, &totals.Reasoning, &totals.Total}
	for index, value := range values {
		if value == nil {
			continue
		}
		if *targets[index] > math.MaxInt64-*value {
			return ErrInvalid
		}
		*targets[index] += *value
	}
	return nil
}

// Record is one provider invocation. InvocationKey is stable across database
// retries; OperationID is optional because some synchronous model calls do not
// have a durable Operation.
type Record struct {
	ID            int64   `json:"id"`
	ProjectID     int64   `json:"project_id"`
	InvocationKey string  `json:"invocation_key"`
	Provider      string  `json:"provider"`
	Model         string  `json:"model"`
	Source        Source  `json:"source"`
	OperationID   *string `json:"operation_id"`
	Tokens        Tokens  `json:"tokens"`
	CollectedAt   string  `json:"collected_at"`
}

// ValidateRecord accepts an unpersisted record with ID zero and a persisted
// record with a positive ID.
func ValidateRecord(value Record) error {
	if value.ID < 0 || value.ProjectID <= 0 || !validIdentifier(value.InvocationKey, 256) ||
		!validLabel(value.Provider, 64, false) || !validLabel(value.Model, 500, true) ||
		!value.Source.Valid() || !validOptionalIdentifier(value.OperationID, 128) ||
		value.Tokens.Validate() != nil || !validTimestamp(value.CollectedAt) {
		return ErrInvalid
	}
	return nil
}

// ValidateAggregateWindow accepts UTC instants bracketing one civil day. The
// upper bound allows daylight-saving transitions while rejecting accidental
// unbounded queries.
func ValidateAggregateWindow(start, end string) error {
	if !validTimestamp(start) || !validTimestamp(end) {
		return ErrInvalid
	}
	startTime, _ := time.Parse(time.RFC3339Nano, start)
	endTime, _ := time.Parse(time.RFC3339Nano, end)
	duration := endTime.Sub(startTime)
	if duration <= 0 || duration > 26*time.Hour {
		return ErrInvalid
	}
	return nil
}

func validIdentifier(value string, maximum int) bool {
	if value == "" || len(value) > maximum || strings.TrimSpace(value) != value || !utf8.ValidString(value) {
		return false
	}
	for _, character := range value {
		if unicode.IsControl(character) || unicode.IsSpace(character) {
			return false
		}
	}
	return true
}

func validOptionalIdentifier(value *string, maximum int) bool {
	return value == nil || validIdentifier(*value, maximum)
}

func validLabel(value string, maximum int, emptyAllowed bool) bool {
	if len(value) > maximum || !utf8.ValidString(value) || strings.TrimSpace(value) != value || strings.ContainsRune(value, 0) {
		return false
	}
	if !emptyAllowed && value == "" {
		return false
	}
	return !strings.ContainsFunc(value, unicode.IsControl)
}

func validTimestamp(value string) bool {
	if !strings.HasSuffix(value, "Z") {
		return false
	}
	parsed, err := time.Parse(time.RFC3339Nano, value)
	return err == nil && parsed.Location() == time.UTC
}
