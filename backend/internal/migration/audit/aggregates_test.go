package audit

import (
	"context"
	"database/sql"
	"testing"

	_ "modernc.org/sqlite"
)

func TestOperationStateAuditComparesRFC3339TimestampsChronologically(t *testing.T) {
	database, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	database.SetMaxOpenConns(1)

	if _, err := database.ExecContext(context.Background(), `CREATE TABLE operations (
		operation_id TEXT PRIMARY KEY,
		status TEXT NOT NULL,
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL,
		started_at TEXT,
		finished_at TEXT,
		error_json TEXT,
		version INTEGER NOT NULL
	)`); err != nil {
		t.Fatal(err)
	}
	insert := `INSERT INTO operations (
		operation_id, status, created_at, updated_at, started_at, finished_at, error_json, version
	) VALUES (?, 'succeeded', ?, ?, ?, ?, NULL, 3)`
	if _, err := database.ExecContext(context.Background(), insert,
		"valid-mixed-precision",
		"2026-07-15T03:47:48.254667Z",
		"2026-07-15T03:47:48.2565299Z",
		"2026-07-15T03:47:48.256Z",
		"2026-07-15T03:47:48.2565299Z",
	); err != nil {
		t.Fatal(err)
	}

	var invalid int
	if err := database.QueryRowContext(context.Background(),
		`SELECT COUNT(*) FROM operations WHERE `+invalidOperationStatePredicate).Scan(&invalid); err != nil {
		t.Fatal(err)
	}
	if invalid != 0 {
		t.Fatalf("valid mixed-precision timestamps were rejected: count=%d", invalid)
	}

	if _, err := database.ExecContext(context.Background(), insert,
		"invalid-reversed",
		"2026-07-15T03:47:48.254667Z",
		"2026-07-15T03:47:48.257Z",
		"2026-07-15T03:47:48.2565299Z",
		"2026-07-15T03:47:48.256Z",
	); err != nil {
		t.Fatal(err)
	}
	if err := database.QueryRowContext(context.Background(),
		`SELECT COUNT(*) FROM operations WHERE `+invalidOperationStatePredicate).Scan(&invalid); err != nil {
		t.Fatal(err)
	}
	if invalid != 1 {
		t.Fatalf("chronologically reversed timestamps were not rejected: count=%d", invalid)
	}
}
