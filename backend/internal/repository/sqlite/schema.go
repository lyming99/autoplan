package sqlite

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"sort"
)

const SchemaVersion = 4

var ErrSchemaMismatch = errors.New("sqlite_schema_v1_mismatch")

var RequiredTables = []string{
	"ai_configs", "attachments", "chat_messages", "claude_cli_configs", "conversations",
	"event_cursors", "event_outbox", "event_retention_watermarks", "events", "executors", "feedback",
	"intake_plan_links", "loop_state", "operations", "plan_tasks", "plans", "project_revisions",
	"project_states", "projects", "requirements", "scan_files", "schema_migrations", "scripts", "model_usage",
	"secret_refs", "settings",
}

var RequiredIndexes = []string{
	"idx_ai_configs_project", "idx_attachments_owner", "idx_chat_messages_conversation",
	"idx_chat_messages_project", "idx_claude_cli_configs_project", "idx_conversations_project",
	"idx_conversations_project_pinned_updated", "idx_event_outbox_pending",
	"idx_event_outbox_operation_cursor", "idx_event_outbox_p10_cursor", "idx_event_outbox_project_revision",
	"idx_event_outbox_stream", "idx_executors_project_label", "idx_executors_project_sort",
	"idx_intake_plan_links_intake", "idx_intake_plan_links_intake_phase",
	"idx_intake_plan_links_plan", "idx_operations_idempotency", "idx_operations_project_status",
	"idx_operations_project_type_status",
	"idx_model_usage_invocation_key", "idx_model_usage_project_collected_at", "idx_model_usage_project_provider",
	"idx_plan_tasks_plan_status_sort",
	"idx_plans_project_sort", "idx_projects_updated", "idx_scripts_project",
	"idx_scripts_project_hook_stage", "idx_secret_refs_owner",
}

var CriticalVersionColumns = []string{"settings", "project_states", "ai_configs", "claude_cli_configs"}

var RequiredColumns = map[string][]string{
	"schema_migrations": {"version", "name", "checksum", "applied_at"},
	"operations": {"operation_id", "project_id", "type", "status", "request_id", "idempotency_scope",
		"idempotency_key", "request_hash", "cancel_requested_at", "created_at", "updated_at", "started_at", "finished_at",
		"result_json", "error_json", "output_json", "version"},
	"event_outbox": {"id", "event_id", "schema_version", "stream_key", "sequence", "type", "request_id",
		"operation_id", "project_id", "event_class", "project_revision", "occurred_at", "data_json", "published_at", "attempts", "last_error", "created_at"},
	"project_revisions":          {"project_id", "revision"},
	"event_cursors":              {"name", "next_event_id"},
	"event_retention_watermarks": {"project_id", "deleted_through_event_id", "updated_at"},
	"secret_refs": {"id", "owner_type", "owner_id", "field_name", "provider", "reference", "has_value",
		"created_at", "updated_at", "version"},
	"model_usage": {"id", "project_id", "invocation_key", "provider", "model", "source", "operation_id",
		"input_tokens", "output_tokens", "cached_tokens", "reasoning_tokens", "total_tokens", "collected_at"},
}

type SchemaSQL interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

func ValidateSchemaV1(ctx context.Context, database SchemaSQL) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	var userVersion int
	if err := database.QueryRowContext(ctx, "PRAGMA user_version").Scan(&userVersion); err != nil || userVersion != SchemaVersion {
		return ErrSchemaMismatch
	}
	tables, err := schemaNames(ctx, database, "table")
	if err != nil || !containsExactly(tables, RequiredTables) {
		return ErrSchemaMismatch
	}
	indexes, err := schemaNames(ctx, database, "index")
	if err != nil || !containsExactly(indexes, RequiredIndexes) {
		return ErrSchemaMismatch
	}
	for table, expected := range RequiredColumns {
		columns, err := tableColumns(ctx, database, table)
		if err != nil || !containsExactly(columns, expected) {
			return ErrSchemaMismatch
		}
	}
	for _, table := range CriticalVersionColumns {
		query := fmt.Sprintf("PRAGMA table_info(%q)", table)
		rows, err := database.QueryContext(ctx, query)
		if err != nil {
			return ErrSchemaMismatch
		}
		found := false
		for rows.Next() {
			var cid, notNull, primaryKey int
			var name, columnType string
			var defaultValue any
			if err := rows.Scan(&cid, &name, &columnType, &notNull, &defaultValue, &primaryKey); err != nil {
				_ = rows.Close()
				return ErrSchemaMismatch
			}
			if name == "version" && columnType == "INTEGER" && notNull == 1 && fmt.Sprint(defaultValue) == "1" {
				found = true
			}
		}
		if err := rows.Close(); err != nil || rows.Err() != nil || !found {
			return ErrSchemaMismatch
		}
	}
	foreignKeyRows, err := database.QueryContext(ctx, "PRAGMA foreign_key_check")
	if err != nil {
		return ErrSchemaMismatch
	}
	hasViolation := foreignKeyRows.Next()
	closeErr := foreignKeyRows.Close()
	if hasViolation || closeErr != nil || foreignKeyRows.Err() != nil {
		return ErrSchemaMismatch
	}
	return nil
}

func schemaNames(ctx context.Context, database SchemaSQL, kind string) ([]string, error) {
	rows, err := database.QueryContext(ctx,
		"SELECT name FROM sqlite_schema WHERE type = ? AND name NOT LIKE 'sqlite_%' ORDER BY name", kind)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]string, 0)
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, err
		}
		result = append(result, name)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return result, nil
}

func tableColumns(ctx context.Context, database SchemaSQL, table string) ([]string, error) {
	rows, err := database.QueryContext(ctx, fmt.Sprintf("PRAGMA table_info(%q)", table))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]string, 0)
	for rows.Next() {
		var cid, notNull, primaryKey int
		var name, columnType string
		var defaultValue any
		if err := rows.Scan(&cid, &name, &columnType, &notNull, &defaultValue, &primaryKey); err != nil {
			return nil, err
		}
		result = append(result, name)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return result, nil
}

func containsExactly(actual, expected []string) bool {
	if len(actual) != len(expected) {
		return false
	}
	got := append([]string(nil), actual...)
	want := append([]string(nil), expected...)
	sort.Strings(got)
	sort.Strings(want)
	for index := range want {
		if got[index] != want[index] {
			return false
		}
	}
	return true
}
