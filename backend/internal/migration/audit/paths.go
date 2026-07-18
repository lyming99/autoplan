package audit

import (
	"context"
	"database/sql"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

type PathInspector interface {
	Lstat(string) (os.FileInfo, error)
	EvalSymlinks(string) (string, error)
}

type OSPathInspector struct{}

func (OSPathInspector) Lstat(name string) (os.FileInfo, error)   { return os.Lstat(name) }
func (OSPathInspector) EvalSymlinks(name string) (string, error) { return filepath.EvalSymlinks(name) }

type pathSpec struct {
	table    string
	column   string
	required bool
	query    string
}

var pathSpecs = []pathSpec{
	{table: "projects", column: "workspace_path", query: `SELECT CAST(id AS TEXT), workspace_path FROM projects ORDER BY id`},
	{table: "requirements", column: "source_path", query: `SELECT CAST(id AS TEXT), source_path FROM requirements ORDER BY id`},
	{table: "requirements", column: "last_generate_log_file", query: `SELECT CAST(id AS TEXT), last_generate_log_file FROM requirements ORDER BY id`},
	{table: "feedback", column: "last_generate_log_file", query: `SELECT CAST(id AS TEXT), last_generate_log_file FROM feedback ORDER BY id`},
	{table: "attachments", column: "stored_path", required: true, query: `SELECT CAST(id AS TEXT), stored_path FROM attachments ORDER BY id`},
	{table: "plans", column: "file_path", required: true, query: `SELECT CAST(id AS TEXT), file_path FROM plans ORDER BY id`},
	{table: "scripts", column: "path", query: `SELECT CAST(id AS TEXT), path FROM scripts ORDER BY id`},
	{table: "scripts", column: "work_dir", query: `SELECT CAST(id AS TEXT), work_dir FROM scripts ORDER BY id`},
	{table: "scan_files", column: "file_path", required: true, query: `SELECT CAST(project_id AS TEXT) || ':' || scan_type || ':' || CAST(size AS TEXT), file_path
FROM scan_files ORDER BY project_id, scan_type, file_path`},
	{table: "settings", column: "update.localInstallerPath", query: `SELECT key, value FROM settings WHERE key = 'update.localInstallerPath' ORDER BY key`},
}

type pathAccumulator struct {
	metric      PathMetric
	limit       int
	fingerprint *recordSetHasher
}

var windowsDrivePath = regexp.MustCompile(`^[A-Za-z]:`)

func auditPaths(ctx context.Context, database Queryer, available map[string]struct{}, options Options, report *Report) error {
	roots, err := authorizedRoots(options.AuthorizedRoots, options.Paths)
	if err != nil {
		return err
	}
	if options.ProjectWorkspacesAreRoots {
		workspaceRoots, workspaceErr := persistedProjectWorkspaceRoots(ctx, database, available, options.Paths)
		if workspaceErr != nil {
			return workspaceErr
		}
		roots, err = authorizedRoots(append(roots, workspaceRoots...), options.Paths)
		if err != nil {
			return err
		}
	}
	for index := range roots {
		report.AuthorizedRoots = append(report.AuthorizedRoots, "authorized-root-"+zeroPaddedIndex(index+1))
	}
	metrics := make(map[string]*pathAccumulator)
	for _, spec := range pathSpecs {
		if _, exists := available[spec.table]; !exists {
			key := spec.table + "\x00" + spec.column + "\x00not_applicable"
			metrics[key] = &pathAccumulator{metric: PathMetric{
				Table: spec.table, Column: spec.column, Classification: "not_applicable", Evaluated: false,
			}, limit: options.MaximumRecordIDs, fingerprint: newRecordSetHasher()}
			continue
		}
		observed := false
		rows, err := database.QueryContext(ctx, spec.query)
		if err != nil {
			return err
		}
		for rows.Next() {
			observed = true
			if err := ctx.Err(); err != nil {
				_ = rows.Close()
				return err
			}
			var key string
			var value sql.NullString
			if err := rows.Scan(&key, &value); err != nil {
				_ = rows.Close()
				return err
			}
			classification, blockingValue := classifyPath(value, spec.required, roots, options.Paths)
			if options.ProjectWorkspacesAreRoots && spec.table == "projects" && spec.column == "workspace_path" {
				classification, blockingValue = classifyStartupProjectWorkspacePath(value, roots, options.Paths, classification, blockingValue)
			}
			metricKey := spec.table + "\x00" + spec.column + "\x00" + classification
			accumulator := metrics[metricKey]
			if accumulator == nil {
				accumulator = &pathAccumulator{metric: PathMetric{
					Table: spec.table, Column: spec.column, Classification: classification,
					Blocking: blockingValue, Evaluated: true,
				}, limit: options.MaximumRecordIDs, fingerprint: newRecordSetHasher()}
				metrics[metricKey] = accumulator
			}
			accumulator.metric.Count++
			identifier := recordIdentifier(spec.table+"."+spec.column, key)
			accumulator.fingerprint.Add(identifier)
			if len(accumulator.metric.RecordIDs) < accumulator.limit {
				accumulator.metric.RecordIDs = append(accumulator.metric.RecordIDs, identifier)
			}
		}
		if err := rows.Close(); err != nil || rows.Err() != nil {
			return ErrAuditIncomplete
		}
		if !observed {
			key := spec.table + "\x00" + spec.column + "\x00none"
			metrics[key] = &pathAccumulator{metric: PathMetric{
				Table: spec.table, Column: spec.column, Classification: "none", Evaluated: true,
			}, limit: options.MaximumRecordIDs, fingerprint: newRecordSetHasher()}
		}
	}
	keys := make([]string, 0, len(metrics))
	for key := range metrics {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		metric := metrics[key].metric
		metric.RecordSetSHA256 = metrics[key].fingerprint.Sum()
		metric.Truncated = metric.Count > int64(len(metric.RecordIDs))
		report.Paths = append(report.Paths, metric)
		if metric.Blocking && metric.Count > 0 {
			report.Findings = append(report.Findings, blocking("path", "path_"+metric.Classification,
				metric.Table, metric.Column, metric.Count, metric.RecordIDs))
		}
	}
	return nil
}

func persistedProjectWorkspaceRoots(
	ctx context.Context,
	database Queryer,
	available map[string]struct{},
	inspector PathInspector,
) ([]string, error) {
	if _, exists := available["projects"]; !exists {
		return nil, nil
	}
	rows, err := database.QueryContext(ctx, `SELECT CAST(id AS TEXT), workspace_path FROM projects ORDER BY id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]string, 0)
	for rows.Next() {
		var key string
		var workspace sql.NullString
		if err := rows.Scan(&key, &workspace); err != nil {
			return nil, err
		}
		if !workspace.Valid || strings.TrimSpace(workspace.String) == "" {
			continue
		}
		normalized, normalizeErr := authorizedRoots([]string{workspace.String}, inspector)
		if normalizeErr == nil {
			result = append(result, normalized...)
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return result, nil
}

func classifyStartupProjectWorkspacePath(
	value sql.NullString,
	roots []string,
	inspector PathInspector,
	classification string,
	blocking bool,
) (string, bool) {
	if !blocking {
		return classification, blocking
	}
	switch classification {
	case "missing":
		return "workspace_missing", false
	case "absolute_unapproved", "drive_absolute_unapproved", "unc_absolute_unapproved":
		if startupWorkspaceMissing(value, inspector) {
			return "workspace_missing", false
		}
	}
	return classification, blocking
}

func startupWorkspaceMissing(value sql.NullString, inspector PathInspector) bool {
	if !value.Valid {
		return false
	}
	pathValue := strings.TrimSpace(value.String)
	if pathValue == "" || strings.ContainsRune(pathValue, '\x00') || !filepath.IsAbs(pathValue) {
		return false
	}
	portable := strings.ReplaceAll(pathValue, "\\", "/")
	for _, component := range strings.Split(portable, "/") {
		if component == ".." {
			return false
		}
	}
	_, err := inspector.Lstat(filepath.Clean(pathValue))
	return errors.Is(err, os.ErrNotExist)
}

func zeroPaddedIndex(value int) string {
	if value < 10 {
		return "0" + string(rune('0'+value))
	}
	return strconv.Itoa(value)
}

func classifyPath(value sql.NullString, required bool, roots []string, inspector PathInspector) (string, bool) {
	if !value.Valid || strings.TrimSpace(value.String) == "" {
		return "empty", required
	}
	pathValue := value.String
	if strings.ContainsRune(pathValue, '\x00') {
		return "invalid", true
	}
	portable := strings.ReplaceAll(pathValue, "\\", "/")
	for _, component := range strings.Split(portable, "/") {
		if component == ".." {
			return "traversal", true
		}
	}
	driveAbsolute := windowsDrivePath.MatchString(pathValue)
	uncAbsolute := strings.HasPrefix(pathValue, `\\`) || strings.HasPrefix(pathValue, "//")
	absolute := filepath.IsAbs(pathValue) || driveAbsolute || uncAbsolute
	if !absolute {
		if cleaned := filepath.Clean(pathValue); cleaned == "." || cleaned == ".." {
			return "invalid", true
		}
		return "relative", false
	}
	if !filepath.IsAbs(pathValue) {
		if driveAbsolute {
			return "drive_absolute_unapproved", true
		}
		return "unc_absolute_unapproved", true
	}
	cleaned := filepath.Clean(pathValue)
	root := matchingRoot(cleaned, roots)
	if root == "" {
		if driveAbsolute {
			return "drive_absolute_unapproved", true
		}
		if uncAbsolute {
			return "unc_absolute_unapproved", true
		}
		return "absolute_unapproved", true
	}
	info, err := inspector.Lstat(cleaned)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return "missing", true
		}
		return "unreadable", true
	}
	resolved, err := inspector.EvalSymlinks(cleaned)
	if err != nil {
		return "unreadable", true
	}
	resolved = filepath.Clean(resolved)
	if !withinOrEqualPath(resolved, root) {
		return "symlink_escape", true
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return "symlink_inside_root", false
	}
	if cleaned != resolved && strings.EqualFold(cleaned, resolved) {
		return "case_mismatch", false
	}
	if cleaned != pathValue {
		return "absolute_normalized", false
	}
	if uncAbsolute {
		return "unc_absolute_allowed", false
	}
	if driveAbsolute {
		return "drive_absolute_allowed", false
	}
	return "absolute_allowed", false
}

func authorizedRoots(values []string, inspector PathInspector) ([]string, error) {
	result := make([]string, 0, len(values))
	for _, value := range values {
		if !filepath.IsAbs(value) {
			return nil, ErrAuditInvalid
		}
		cleaned := filepath.Clean(value)
		info, err := inspector.Lstat(cleaned)
		if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return nil, ErrAuditInvalid
		}
		resolved, err := inspector.EvalSymlinks(cleaned)
		if err != nil || !withinOrEqualPath(filepath.Clean(resolved), cleaned) {
			return nil, ErrAuditInvalid
		}
		result = append(result, filepath.Clean(resolved))
	}
	sort.Strings(result)
	unique := result[:0]
	for _, root := range result {
		if len(unique) == 0 || !strings.EqualFold(unique[len(unique)-1], root) {
			unique = append(unique, root)
		}
	}
	return unique, nil
}

func matchingRoot(target string, roots []string) string {
	for _, root := range roots {
		if withinOrEqualPath(target, root) {
			return root
		}
	}
	return ""
}

func withinOrEqualPath(target, root string) bool {
	if strings.EqualFold(filepath.Clean(target), filepath.Clean(root)) {
		return true
	}
	relative, err := filepath.Rel(filepath.Clean(root), filepath.Clean(target))
	return err == nil && relative != "." && relative != ".." && !filepath.IsAbs(relative) &&
		!strings.HasPrefix(relative, ".."+string(filepath.Separator))
}
