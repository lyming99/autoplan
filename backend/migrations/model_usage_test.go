package migrations_test

import (
	"context"
	"database/sql"
	"testing"

	storesqlite "github.com/lyming99/autoplan/backend/internal/repository/sqlite"
	"github.com/lyming99/autoplan/backend/migrations"
	_ "modernc.org/sqlite"
)

func TestVersionThreeDatabaseUpgradesToModelUsageV4WithoutDataLoss(t *testing.T) {
	database, err := sql.Open("sqlite", "file:model-usage-v4?mode=memory&cache=shared")
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	database.SetMaxOpenConns(1)
	ctx := context.Background()
	entries := migrations.NewRegistry(migrations.NewCatalog()).Migrations()
	for _, entry := range entries[:migrations.SchemaV3Version] {
		if _, err := database.ExecContext(ctx, entry.SQL); err != nil {
			t.Fatalf("apply v%d: %v", entry.Version, err)
		}
		if _, err := database.ExecContext(ctx,
			"INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
			entry.Version, entry.Name, entry.Checksum, "2026-07-15T00:00:00Z"); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := database.ExecContext(ctx, "PRAGMA user_version = 3"); err != nil {
		t.Fatal(err)
	}
	if _, err := database.ExecContext(ctx, `INSERT INTO projects
		(id, name, workspace_path, description, created_at, updated_at)
		VALUES (7, 'preserved', 'fixture', '', '2026-07-15T00:00:00Z', '2026-07-15T00:00:00Z')`); err != nil {
		t.Fatal(err)
	}

	v4 := entries[migrations.SchemaV4Version-1]
	if _, err := database.ExecContext(ctx, v4.SQL); err != nil {
		t.Fatalf("apply v4: %v", err)
	}
	if _, err := database.ExecContext(ctx, "PRAGMA user_version = 4"); err != nil {
		t.Fatal(err)
	}
	if err := storesqlite.ValidateSchemaV1(ctx, database); err != nil {
		t.Fatalf("validate v4 schema: %v", err)
	}
	var name string
	if err := database.QueryRowContext(ctx, "SELECT name FROM projects WHERE id = 7").Scan(&name); err != nil || name != "preserved" {
		t.Fatalf("v3 data was not preserved: name=%q err=%v", name, err)
	}
}
