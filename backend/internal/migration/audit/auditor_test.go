package audit

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type fakeRow struct {
	values []any
	err    error
}

func (row fakeRow) Scan(destinations ...any) error {
	if row.err != nil {
		return row.err
	}
	if len(destinations) != len(row.values) {
		return errors.New("scan_count")
	}
	for index, value := range row.values {
		if err := assign(destinations[index], value); err != nil {
			return err
		}
	}
	return nil
}

type fakeRows struct {
	values [][]any
	index  int
	err    error
	closed bool
}

func (rows *fakeRows) Next() bool {
	if rows.closed || rows.index >= len(rows.values) {
		return false
	}
	rows.index++
	return true
}

func (rows *fakeRows) Scan(destinations ...any) error {
	return fakeRow{values: rows.values[rows.index-1]}.Scan(destinations...)
}

func (rows *fakeRows) Err() error { return rows.err }

func (rows *fakeRows) Close() error {
	rows.closed = true
	return nil
}

func assign(destination, value any) error {
	switch target := destination.(type) {
	case *string:
		*target = value.(string)
	case *int:
		*target = int(value.(int64))
	case *int64:
		*target = value.(int64)
	case *any:
		*target = value
	case *sql.NullInt64:
		if value == nil {
			*target = sql.NullInt64{}
		} else {
			*target = sql.NullInt64{Int64: value.(int64), Valid: true}
		}
	case *sql.NullString:
		if value == nil {
			*target = sql.NullString{}
		} else {
			*target = sql.NullString{String: value.(string), Valid: true}
		}
	default:
		return errors.New("scan_type")
	}
	return nil
}

type fakeDatabase struct {
	integrity       []string
	foreign         [][]any
	tables          []string
	tableRows       int64
	projectPaths    [][]any
	countOverrides  map[string]int64
	sampleOverrides map[string][][]any
	failContains    string
}

func newFakeDatabase() *fakeDatabase {
	return &fakeDatabase{
		integrity: []string{"ok"}, tables: []string{"projects"},
		countOverrides: map[string]int64{}, sampleOverrides: map[string][][]any{},
	}
}

func (database *fakeDatabase) QueryRowContext(_ context.Context, query string, _ ...any) Row {
	if database.failContains != "" && strings.Contains(query, database.failContains) {
		return fakeRow{err: errors.New("synthetic_query_failure")}
	}
	if strings.Contains(query, `SELECT COUNT(*) FROM "projects"`) {
		return fakeRow{values: []any{database.tableRows}}
	}
	if strings.Contains(query, `FROM "projects" ORDER BY "id" ASC`) {
		if database.tableRows == 0 {
			return fakeRow{values: []any{""}}
		}
		return fakeRow{values: []any{"1"}}
	}
	if strings.Contains(query, `FROM "projects" ORDER BY "id" DESC`) {
		return fakeRow{values: []any{fmt.Sprint(database.tableRows)}}
	}
	for marker, count := range database.countOverrides {
		if strings.Contains(query, marker) {
			return fakeRow{values: []any{count}}
		}
	}
	return fakeRow{values: []any{int64(0)}}
}

func (database *fakeDatabase) QueryContext(_ context.Context, query string, _ ...any) (Rows, error) {
	if database.failContains != "" && strings.Contains(query, database.failContains) {
		return nil, errors.New("synthetic_query_failure")
	}
	switch {
	case query == "PRAGMA integrity_check":
		rows := &fakeRows{}
		for _, value := range database.integrity {
			rows.values = append(rows.values, []any{value})
		}
		return rows, nil
	case query == "PRAGMA foreign_key_check":
		return &fakeRows{values: database.foreign}, nil
	case strings.Contains(query, "FROM sqlite_schema WHERE"):
		values := [][]any{{"index", "idx_projects_updated", "projects", "CREATE INDEX idx_projects_updated ON projects(updated_at DESC)"}}
		for _, table := range database.tables {
			statement := "CREATE TABLE " + table + " (id INTEGER PRIMARY KEY)"
			if table == "projects" {
				statement = "CREATE TABLE projects (id INTEGER PRIMARY KEY, workspace_path TEXT, updated_at TEXT)"
			}
			values = append(values, []any{"table", table, table, statement})
		}
		return &fakeRows{values: values}, nil
	case strings.Contains(query, `PRAGMA table_info("projects")`):
		return &fakeRows{values: [][]any{
			{int64(0), "id", "INTEGER", int64(0), nil, int64(1)},
			{int64(1), "workspace_path", "TEXT", int64(1), "''", int64(0)},
			{int64(2), "updated_at", "TEXT", int64(1), nil, int64(0)},
		}}, nil
	case strings.Contains(query, `PRAGMA table_info("`):
		return &fakeRows{values: [][]any{{int64(0), "id", "INTEGER", int64(0), nil, int64(1)}}}, nil
	case strings.Contains(query, "SELECT CAST(id AS TEXT), workspace_path FROM projects"):
		return &fakeRows{values: database.projectPaths}, nil
	}
	for marker, values := range database.sampleOverrides {
		if strings.Contains(query, marker) {
			return &fakeRows{values: values}, nil
		}
	}
	return &fakeRows{}, nil
}

func testAuditor(t *testing.T, database *fakeDatabase, roots []string) *Auditor {
	t.Helper()
	auditor, err := New(database, Options{
		Phase: "post", MigrationVersion: 1, ExpectedTables: append([]string(nil), database.tables...),
		ExpectedIndexes: []string{"idx_projects_updated"}, AuthorizedRoots: roots, MaximumRecordIDs: 2,
	})
	if err != nil {
		t.Fatal(err)
	}
	return auditor
}

func TestAuditIsDeterministicCompleteAndContainsNoDatabaseValues(t *testing.T) {
	root := t.TempDir()
	database := newFakeDatabase()
	database.tableRows = 2
	database.projectPaths = [][]any{
		{"1", "docs/project"},
		{"2", filepath.Join(root, "missing-private-fixture-file")},
	}
	auditor := testAuditor(t, database, []string{root})
	first, err := auditor.Audit(context.Background())
	if err != nil {
		t.Fatalf("Audit() error = %v", err)
	}
	second, err := auditor.Audit(context.Background())
	if err != nil {
		t.Fatalf("second Audit() error = %v", err)
	}
	firstJSON, err := first.JSON()
	if err != nil {
		t.Fatal(err)
	}
	secondJSON, err := second.JSON()
	if err != nil {
		t.Fatal(err)
	}
	if string(firstJSON) != string(secondJSON) {
		t.Fatal("audit JSON is not deterministic")
	}
	if first.OK || !strings.Contains(string(firstJSON), "path_missing") {
		t.Fatalf("missing path did not block: %s", firstJSON)
	}
	for _, forbidden := range []string{root, "missing-private-fixture-file", "docs/project"} {
		if strings.Contains(string(firstJSON), forbidden) {
			t.Fatalf("audit leaked path/content %q", forbidden)
		}
	}
	if !strings.Contains(string(firstJSON), "authorized-root-01") {
		t.Fatalf("authorized root placeholder missing: %s", firstJSON)
	}
	if !strings.HasPrefix(first.HumanSummary(), "audit=p04-audit-v1 phase=post schema=1 status=blocked") {
		t.Fatalf("unexpected summary: %s", first.HumanSummary())
	}
}

func TestAuditReportsIntegrityRelationAndAggregateFailuresWithHashedIDs(t *testing.T) {
	database := newFakeDatabase()
	database.tables = append(database.tables, "plans", "plan_tasks")
	database.integrity = []string{"page-corrupt", "second-result"}
	database.foreign = [][]any{{"plan_tasks", int64(99), "plans", int64(0)}}
	database.countOverrides["FROM plan_tasks t LEFT JOIN plans p"] = 3
	database.sampleOverrides["FROM plan_tasks t LEFT JOIN plans p"] = [][]any{{"99"}, {"100"}, {"101"}}
	database.countOverrides["p.total_tasks != COALESCE"] = 1
	database.sampleOverrides["p.total_tasks != COALESCE"] = [][]any{{"7"}}
	report, err := testAuditor(t, database, nil).Audit(context.Background())
	if err != nil {
		t.Fatalf("Audit() error = %v", err)
	}
	if report.OK {
		t.Fatal("invalid database unexpectedly audited ok")
	}
	encoded, _ := report.JSON()
	for _, required := range []string{"integrity_failed", "foreign_key_violation", "orphan_plan_task", "plan_task_aggregate_mismatch", "rid-"} {
		if !strings.Contains(string(encoded), required) {
			t.Fatalf("report missing %q: %s", required, encoded)
		}
	}
	for _, forbidden := range []string{"page-corrupt", `"99"`, `"100"`} {
		if strings.Contains(string(encoded), forbidden) {
			t.Fatalf("report leaked raw database value %q", forbidden)
		}
	}
}

func TestAuditQueryFailureIsFailClosedAndComparisonRequiresExplainedDeltas(t *testing.T) {
	database := newFakeDatabase()
	database.tables = append(database.tables, "plans", "plan_tasks")
	database.failContains = "FROM plan_tasks t LEFT JOIN plans p"
	report, err := testAuditor(t, database, nil).Audit(context.Background())
	if !errors.Is(err, ErrAuditIncomplete) || report.OK {
		t.Fatalf("Audit() = %#v, %v", report, err)
	}
	encoded, _ := report.JSON()
	if !strings.Contains(string(encoded), "relation_audit_incomplete") || strings.Contains(string(encoded), "synthetic_query_failure") {
		t.Fatalf("query failure was not safely represented: %s", encoded)
	}

	before := Report{MigrationVersion: 0, Tables: []TableMetric{{Table: "projects", RowCount: 1}, {Table: "settings", RowCount: 2}}}
	after := Report{MigrationVersion: 1, Tables: []TableMetric{{Table: "projects", RowCount: 1}, {Table: "settings", RowCount: 3}, {Table: "secret_refs", RowCount: 1}}}
	before.Relations = []RelationMetric{{Relation: "plans.project", Count: 1, RecordSetSHA256: "set-a"}}
	after.Relations = []RelationMetric{{Relation: "plans.project", Count: 1, RecordSetSHA256: "set-b"}}
	comparison := Compare(before, after, []DifferenceRule{{
		Table: "settings", Delta: 1, Classification: ClassificationExplained,
		MigrationVersion: 1, ReasonCode: "v1_default_setting",
	}})
	if comparison.OK {
		t.Fatal("unexplained row/record-set delta unexpectedly accepted")
	}
	blockingByName := map[string]bool{}
	for _, difference := range comparison.Differences {
		if difference.Classification == ClassificationBlocking {
			blockingByName[difference.Name] = true
		}
	}
	if !blockingByName["secret_refs"] || !blockingByName["plans.project"] {
		t.Fatalf("missing blocking differences: %#v", comparison)
	}
}

func TestPathTraversalIsReportedWithoutFilesystemMutation(t *testing.T) {
	root := t.TempDir()
	database := newFakeDatabase()
	database.projectPaths = [][]any{{"1", "../../outside/private-fixture.txt"}}
	report, err := testAuditor(t, database, []string{root}).Audit(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	encoded, _ := report.JSON()
	if report.OK || !strings.Contains(string(encoded), "path_traversal") || strings.Contains(string(encoded), "private-fixture.txt") {
		t.Fatalf("unsafe path report = %s", encoded)
	}
	entries, err := os.ReadDir(root)
	if err != nil || len(entries) != 0 {
		t.Fatalf("path audit mutated authorized root: entries=%d err=%v", len(entries), err)
	}
}

func TestPersistedProjectWorkspacesCanBeStartupAuthorizationRoots(t *testing.T) {
	dataRoot := t.TempDir()
	workspace := t.TempDir()
	database := newFakeDatabase()
	database.tableRows = 1
	database.projectPaths = [][]any{{"1", workspace}}
	auditor := testAuditor(t, database, []string{dataRoot})
	auditor.options.ProjectWorkspacesAreRoots = true

	report, err := auditor.Audit(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !report.OK || len(report.AuthorizedRoots) != 2 || len(report.Findings) != 0 {
		encoded, _ := report.JSON()
		t.Fatalf("stored workspace was not authorized for startup: %s", encoded)
	}
}

func TestStartupAuditToleratesDeletedPersistedProjectWorkspace(t *testing.T) {
	dataRoot := t.TempDir()
	deletedWorkspace := filepath.Join(t.TempDir(), "deleted-workspace")
	database := newFakeDatabase()
	database.tableRows = 1
	database.projectPaths = [][]any{{"1", deletedWorkspace}}
	auditor := testAuditor(t, database, []string{dataRoot})
	auditor.options.ProjectWorkspacesAreRoots = true

	report, err := auditor.Audit(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !report.OK || len(report.Findings) != 0 {
		encoded, _ := report.JSON()
		t.Fatalf("deleted project workspace blocked startup audit: %s", encoded)
	}
	found := false
	for _, metric := range report.Paths {
		if metric.Table == "projects" && metric.Column == "workspace_path" && metric.Classification == "workspace_missing" {
			found = true
			if metric.Blocking || metric.Count != 1 {
				t.Fatalf("workspace_missing metric should be non-blocking count=1: %#v", metric)
			}
		}
	}
	if !found {
		encoded, _ := report.JSON()
		t.Fatalf("missing workspace metric was not reported: %s", encoded)
	}
}

func TestPathClassificationDistinguishesPortableDriveAndUNCForms(t *testing.T) {
	tests := []struct {
		name     string
		value    sql.NullString
		required bool
		want     string
		blocking bool
	}{
		{name: "empty optional", value: sql.NullString{}, want: "empty"},
		{name: "empty required", value: sql.NullString{}, required: true, want: "empty", blocking: true},
		{name: "relative", value: sql.NullString{String: "docs/plan.md", Valid: true}, want: "relative"},
		{name: "drive", value: sql.NullString{String: `Z:\outside\plan.md`, Valid: true}, want: "drive_absolute_unapproved", blocking: true},
		{name: "unc", value: sql.NullString{String: `\\server\share\plan.md`, Valid: true}, want: "unc_absolute_unapproved", blocking: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, blocking := classifyPath(test.value, test.required, nil, OSPathInspector{})
			if got != test.want || blocking != test.blocking {
				t.Fatalf("classifyPath() = %q, %t; want %q, %t", got, blocking, test.want, test.blocking)
			}
		})
	}
}
