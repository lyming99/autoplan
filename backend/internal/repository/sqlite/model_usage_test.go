package sqlite

import (
	"context"
	"database/sql"
	"errors"
	"math"
	"path/filepath"
	"strings"
	"testing"

	domainmodelusage "github.com/lyming99/autoplan/backend/internal/domain/modelusage"
	"github.com/lyming99/autoplan/backend/internal/repository"
)

func TestModelUsageIdempotentWriteAndProjectAggregate(t *testing.T) {
	writer, database := newModelUsageTestWriter(t)
	defer database.Close()
	defer writer.Close()
	ctx := context.Background()

	records := []domainmodelusage.Record{
		modelUsageRecord(1, "invocation-openai-before", "openai", "2026-07-14T23:59:59Z", 20, 10, 4, 0, 34),
		modelUsageRecord(1, "invocation-openai-today", "openai", "2026-07-15T01:00:00Z", 10, 5, 0, 2, 17),
		modelUsageRecord(1, "invocation-anthropic-boundary", "anthropic", "2026-07-15T00:00:00.500Z", 3, 7, 1, 2, 13),
	}
	for index := range records {
		if err := transactModelUsage(ctx, writer, func(transaction repository.ModelUsageWriteTransaction) error {
			inserted, err := transaction.RecordModelUsage(ctx, records[index])
			if err == nil && !inserted {
				t.Fatal("new invocation was not inserted")
			}
			return err
		}); err != nil {
			t.Fatal(err)
		}
	}

	if err := transactModelUsage(ctx, writer, func(transaction repository.ModelUsageWriteTransaction) error {
		inserted, err := transaction.RecordModelUsage(ctx, records[1])
		if err == nil && inserted {
			t.Fatal("exact replay inserted a duplicate")
		}
		return err
	}); err != nil {
		t.Fatal(err)
	}

	var aggregate domainmodelusage.Aggregate
	if err := transactModelUsage(ctx, writer, func(transaction repository.ModelUsageWriteTransaction) error {
		var err error
		aggregate, err = transaction.AggregateModelUsage(ctx, 1, "2026-07-15T00:00:00Z", "2026-07-16T00:00:00Z")
		return err
	}); err != nil {
		t.Fatal(err)
	}
	assertUsageTotals(t, aggregate.Cumulative, domainmodelusage.Totals{Input: 33, Output: 22, Cached: 5, Reasoning: 4, Total: 64})
	assertUsageTotals(t, aggregate.Today, domainmodelusage.Totals{Input: 13, Output: 12, Cached: 1, Reasoning: 4, Total: 30})
	if len(aggregate.ByProvider) != 2 || aggregate.ByProvider[0].Provider != "anthropic" || aggregate.ByProvider[1].Provider != "openai" {
		t.Fatalf("provider buckets = %#v", aggregate.ByProvider)
	}
	assertUsageTotals(t, aggregate.ByProvider[0].Cumulative, domainmodelusage.Totals{Input: 3, Output: 7, Cached: 1, Reasoning: 2, Total: 13})
	assertUsageTotals(t, aggregate.ByProvider[0].Today, domainmodelusage.Totals{Input: 3, Output: 7, Cached: 1, Reasoning: 2, Total: 13})
	assertUsageTotals(t, aggregate.ByProvider[1].Today, domainmodelusage.Totals{Input: 10, Output: 5, Reasoning: 2, Total: 17})

	conflict := records[1]
	conflict.Model = "different-model"
	err := transactModelUsage(ctx, writer, func(transaction repository.ModelUsageWriteTransaction) error {
		_, err := transaction.RecordModelUsage(ctx, conflict)
		return err
	})
	if !errors.Is(err, repository.ErrIdempotencyKeyReuse) {
		t.Fatalf("conflicting replay error = %v", err)
	}
	var count int
	if err := database.QueryRow("SELECT COUNT(*) FROM model_usage WHERE project_id = 1").Scan(&count); err != nil || count != 3 {
		t.Fatalf("persisted count = %d, %v", count, err)
	}
}

func TestModelUsageWriteRejectsInvalidFieldsOwnershipAndOverflow(t *testing.T) {
	writer, database := newModelUsageTestWriter(t)
	defer database.Close()
	defer writer.Close()
	ctx := context.Background()
	valid := modelUsageRecord(1, "valid-invocation", "openai", "2026-07-15T01:00:00Z", 1, 1, 1, 1, 4)
	operationID := "operation-project-two"
	valid.OperationID = &operationID

	err := transactModelUsage(ctx, writer, func(transaction repository.ModelUsageWriteTransaction) error {
		_, err := transaction.RecordModelUsage(ctx, valid)
		return err
	})
	if !errors.Is(err, repository.ErrProjectMismatch) {
		t.Fatalf("cross-project operation error = %v", err)
	}

	invalidRecords := []domainmodelusage.Record{
		modelUsageRecord(1, "negative", "openai", "2026-07-15T01:00:00Z", -1, 0, 0, 0, 0),
		modelUsageRecord(1, strings.Repeat("k", 257), "openai", "2026-07-15T01:00:00Z", 1, 0, 0, 0, 1),
		modelUsageRecord(1, "provider-too-long", strings.Repeat("p", 65), "2026-07-15T01:00:00Z", 1, 0, 0, 0, 1),
	}
	modelTooLong := modelUsageRecord(1, "model-too-long", "openai", "2026-07-15T01:00:00Z", 1, 0, 0, 0, 1)
	modelTooLong.Model = strings.Repeat("m", 501)
	invalidRecords = append(invalidRecords, modelTooLong)
	for index := range invalidRecords {
		err := transactModelUsage(ctx, writer, func(transaction repository.ModelUsageWriteTransaction) error {
			_, err := transaction.RecordModelUsage(ctx, invalidRecords[index])
			return err
		})
		if !errors.Is(err, repository.ErrInvalidModelUsage) {
			t.Fatalf("invalid record %d error = %v", index, err)
		}
	}

	maximum := modelUsageRecord(2, "maximum", "openai", "2026-07-15T01:00:00Z", math.MaxInt64, 0, 0, 0, math.MaxInt64)
	if err := transactModelUsage(ctx, writer, func(transaction repository.ModelUsageWriteTransaction) error {
		_, err := transaction.RecordModelUsage(ctx, maximum)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	overflow := modelUsageRecord(2, "overflow", "openai", "2026-07-15T02:00:00Z", 1, 0, 0, 0, 1)
	err = transactModelUsage(ctx, writer, func(transaction repository.ModelUsageWriteTransaction) error {
		_, err := transaction.RecordModelUsage(ctx, overflow)
		return err
	})
	if !errors.Is(err, repository.ErrInvalidModelUsage) {
		t.Fatalf("aggregate overflow error = %v", err)
	}
}

func TestModelUsageAggregateValidatesProjectAndDayWindow(t *testing.T) {
	writer, database := newModelUsageTestWriter(t)
	defer database.Close()
	defer writer.Close()
	ctx := context.Background()

	var empty domainmodelusage.Aggregate
	if err := transactModelUsage(ctx, writer, func(transaction repository.ModelUsageWriteTransaction) error {
		var err error
		empty, err = transaction.AggregateModelUsage(ctx, 1, "2026-07-15T00:00:00Z", "2026-07-16T00:00:00Z")
		return err
	}); err != nil || empty.ByProvider == nil || len(empty.ByProvider) != 0 {
		t.Fatalf("empty aggregate = %#v, %v", empty, err)
	}

	err := transactModelUsage(ctx, writer, func(transaction repository.ModelUsageWriteTransaction) error {
		_, err := transaction.AggregateModelUsage(ctx, 99, "2026-07-15T00:00:00Z", "2026-07-16T00:00:00Z")
		return err
	})
	if !errors.Is(err, repository.ErrNotFound) {
		t.Fatalf("missing project error = %v", err)
	}
	err = transactModelUsage(ctx, writer, func(transaction repository.ModelUsageWriteTransaction) error {
		_, err := transaction.AggregateModelUsage(ctx, 1, "2026-07-16T00:00:00Z", "2026-07-15T00:00:00Z")
		return err
	})
	if !errors.Is(err, repository.ErrInvalidModelUsage) {
		t.Fatalf("invalid day error = %v", err)
	}
}

func newModelUsageTestWriter(t *testing.T) (*Writer, *sql.DB) {
	t.Helper()
	database, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "model-usage.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	database.SetMaxOpenConns(1)
	statements := []string{
		"PRAGMA foreign_keys = ON",
		"CREATE TABLE projects (id INTEGER PRIMARY KEY)",
		"CREATE TABLE operations (operation_id TEXT PRIMARY KEY, project_id INTEGER, FOREIGN KEY (project_id) REFERENCES projects(id))",
		`CREATE TABLE model_usage (
			id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL,
			invocation_key TEXT NOT NULL UNIQUE, provider TEXT NOT NULL, model TEXT NOT NULL DEFAULT '',
			source TEXT NOT NULL, operation_id TEXT, input_tokens INTEGER, output_tokens INTEGER,
			cached_tokens INTEGER, reasoning_tokens INTEGER, total_tokens INTEGER, collected_at TEXT NOT NULL,
			FOREIGN KEY (project_id) REFERENCES projects(id), FOREIGN KEY (operation_id) REFERENCES operations(operation_id)
		)`,
		"INSERT INTO projects (id) VALUES (1), (2)",
		"INSERT INTO operations (operation_id, project_id) VALUES ('operation-project-one', 1), ('operation-project-two', 2)",
	}
	for _, statement := range statements {
		if _, err := database.Exec(statement); err != nil {
			database.Close()
			t.Fatal(err)
		}
	}
	writer, err := newWriter(sqlBeginner{database: database}, writeTestGate{}, writeTestOwner{"model-usage-fixture"}, true, SchemaVersion)
	if err != nil {
		database.Close()
		t.Fatal(err)
	}
	return writer, database
}

func transactModelUsage(ctx context.Context, writer *Writer, operation func(repository.ModelUsageWriteTransaction) error) error {
	return writer.TransactModelUsage(ctx, operation)
}

func modelUsageRecord(projectID int64, key, provider, collectedAt string, input, output, cached, reasoning, total int64) domainmodelusage.Record {
	return domainmodelusage.Record{
		ProjectID: projectID, InvocationKey: key, Provider: provider, Model: "fixture-model",
		Source: domainmodelusage.SourceTaskExecution, CollectedAt: collectedAt,
		Tokens: domainmodelusage.Tokens{
			Input: &input, Output: &output, Cached: &cached, Reasoning: &reasoning, Total: &total,
		},
	}
}

func assertUsageTotals(t *testing.T, actual, expected domainmodelusage.Totals) {
	t.Helper()
	if actual != expected {
		t.Fatalf("usage totals = %#v, want %#v", actual, expected)
	}
}
