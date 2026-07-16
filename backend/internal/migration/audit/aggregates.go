package audit

import (
	"context"
	"strings"
)

type aggregateSpec struct {
	name        string
	table       string
	code        string
	countQuery  string
	sampleQuery string
}

// RFC3339Nano omits trailing fractional zeroes, so valid timestamps from the
// same second are not lexicographically sortable. SQLite's date conversion
// preserves chronological ordering across those mixed-precision values.
const invalidOperationStatePredicate = `status NOT IN ('queued','running','succeeded','failed','cancelled','interrupted')
 OR (status = 'queued' AND (started_at IS NOT NULL OR finished_at IS NOT NULL OR error_json IS NOT NULL))
 OR (status = 'running' AND (started_at IS NULL OR finished_at IS NOT NULL OR error_json IS NOT NULL))
 OR (status = 'succeeded' AND (started_at IS NULL OR finished_at IS NULL OR error_json IS NOT NULL))
 OR (status = 'failed' AND (started_at IS NULL OR finished_at IS NULL OR error_json IS NULL))
 OR (status IN ('cancelled','interrupted') AND finished_at IS NULL)
 OR julianday(created_at) IS NULL OR julianday(updated_at) IS NULL
 OR (started_at IS NOT NULL AND julianday(started_at) IS NULL)
 OR (finished_at IS NOT NULL AND julianday(finished_at) IS NULL)
 OR julianday(created_at) > julianday(updated_at)
 OR (started_at IS NOT NULL AND julianday(started_at) < julianday(created_at))
 OR (finished_at IS NOT NULL AND started_at IS NOT NULL AND julianday(finished_at) < julianday(started_at))
 OR (finished_at IS NOT NULL AND julianday(finished_at) > julianday(updated_at))
 OR version <= 0`

var aggregateSpecs = []aggregateSpec{
	{
		name: "plans.task_counts_and_validation", table: "plans", code: "plan_task_aggregate_mismatch",
		countQuery: `SELECT COUNT(*) FROM plans p LEFT JOIN (
  SELECT plan_id, COUNT(*) AS total, SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed
  FROM plan_tasks GROUP BY plan_id
) t ON t.plan_id = p.id
WHERE p.total_tasks != COALESCE(t.total,0) OR p.completed_tasks != COALESCE(t.completed,0)
   OR p.completed_tasks < 0 OR p.completed_tasks > p.total_tasks OR p.validation_passed NOT IN (0,1)
   OR (p.validation_passed = 1 AND (p.completed_tasks != p.total_tasks OR p.status != 'completed'))`,
		sampleQuery: `SELECT CAST(p.id AS TEXT) FROM plans p LEFT JOIN (
  SELECT plan_id, COUNT(*) AS total, SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed
  FROM plan_tasks GROUP BY plan_id
) t ON t.plan_id = p.id
WHERE p.total_tasks != COALESCE(t.total,0) OR p.completed_tasks != COALESCE(t.completed,0)
   OR p.completed_tasks < 0 OR p.completed_tasks > p.total_tasks OR p.validation_passed NOT IN (0,1)
   OR (p.validation_passed = 1 AND (p.completed_tasks != p.total_tasks OR p.status != 'completed'))
ORDER BY p.id LIMIT ?`,
	},
	{
		name: "plans.sort_order", table: "plans", code: "invalid_or_duplicate_plan_sort_order",
		countQuery: `SELECT COALESCE(SUM(c),0) FROM (
  SELECT COUNT(*) AS c FROM plans WHERE sort_order <= 0
  UNION ALL SELECT COUNT(*) AS c FROM (SELECT project_id, sort_order FROM plans GROUP BY project_id, sort_order HAVING COUNT(*) > 1)
)`,
		sampleQuery: `SELECT CAST(MIN(id) AS TEXT) FROM plans GROUP BY project_id, sort_order
HAVING sort_order <= 0 OR COUNT(*) > 1 ORDER BY MIN(id) LIMIT ?`,
	},
	{
		name: "plans.status", table: "plans", code: "invalid_plan_status",
		countQuery: `SELECT COUNT(*) FROM plans WHERE status NOT IN
('draft','pending','running','ready_for_validation','completed','interrupted','stopped','validation_failed')`,
		sampleQuery: `SELECT CAST(id AS TEXT) FROM plans WHERE status NOT IN
('draft','pending','running','ready_for_validation','completed','interrupted','stopped','validation_failed') ORDER BY id LIMIT ?`,
	},
	{
		name: "plan_tasks.status", table: "plan_tasks", code: "invalid_task_status",
		countQuery: `SELECT COUNT(*) FROM plan_tasks WHERE status NOT IN
('pending','running','completed','blocked','failed','stopping','stopped','interrupted','done','passed')`,
		sampleQuery: `SELECT CAST(id AS TEXT) FROM plan_tasks WHERE status NOT IN
('pending','running','completed','blocked','failed','stopping','stopped','interrupted','done','passed') ORDER BY id LIMIT ?`,
	},
	{
		name: "intake_plan_links.phase_uniqueness", table: "intake_plan_links", code: "duplicate_or_invalid_intake_phase",
		countQuery: `SELECT COALESCE(SUM(c),0) FROM (
  SELECT COUNT(*) AS c FROM intake_plan_links WHERE phase_index <= 0
  UNION ALL SELECT COUNT(*) AS c FROM (
    SELECT project_id, intake_type, intake_id, phase_index FROM intake_plan_links
    GROUP BY project_id, intake_type, intake_id, phase_index HAVING COUNT(*) > 1
  )
)`,
		sampleQuery: `SELECT CAST(MIN(id) AS TEXT) FROM intake_plan_links
GROUP BY project_id, intake_type, intake_id, phase_index
HAVING phase_index <= 0 OR COUNT(*) > 1 ORDER BY MIN(id) LIMIT ?`,
	},
	{
		name: "intake.legacy_phase_one_link", table: "intake_plan_links", code: "legacy_link_phase_one_mismatch",
		countQuery: `SELECT
 (SELECT COUNT(*) FROM requirements r LEFT JOIN intake_plan_links l
    ON l.project_id = r.project_id AND l.intake_type = 'requirement' AND l.intake_id = r.id AND l.phase_index = 1
   WHERE (r.linked_plan_id IS NULL AND l.id IS NOT NULL) OR (r.linked_plan_id IS NOT NULL AND (l.id IS NULL OR l.plan_id != r.linked_plan_id)))
 +(SELECT COUNT(*) FROM feedback f LEFT JOIN intake_plan_links l
    ON l.project_id = f.project_id AND l.intake_type = 'feedback' AND l.intake_id = f.id AND l.phase_index = 1
   WHERE (f.linked_plan_id IS NULL AND l.id IS NOT NULL) OR (f.linked_plan_id IS NOT NULL AND (l.id IS NULL OR l.plan_id != f.linked_plan_id)))`,
		sampleQuery: `SELECT key FROM (
 SELECT 'r:' || CAST(r.id AS TEXT) AS key FROM requirements r LEFT JOIN intake_plan_links l
  ON l.project_id = r.project_id AND l.intake_type = 'requirement' AND l.intake_id = r.id AND l.phase_index = 1
 WHERE (r.linked_plan_id IS NULL AND l.id IS NOT NULL) OR (r.linked_plan_id IS NOT NULL AND (l.id IS NULL OR l.plan_id != r.linked_plan_id))
 UNION ALL
 SELECT 'f:' || CAST(f.id AS TEXT) AS key FROM feedback f LEFT JOIN intake_plan_links l
  ON l.project_id = f.project_id AND l.intake_type = 'feedback' AND l.intake_id = f.id AND l.phase_index = 1
 WHERE (f.linked_plan_id IS NULL AND l.id IS NOT NULL) OR (f.linked_plan_id IS NOT NULL AND (l.id IS NULL OR l.plan_id != f.linked_plan_id))
) ORDER BY key LIMIT ?`,
	},
	{
		name: "project_states.singleton", table: "project_states", code: "missing_or_duplicate_project_state",
		countQuery: `SELECT COUNT(*) FROM projects p LEFT JOIN project_states s ON s.project_id = p.id WHERE s.project_id IS NULL`,
		sampleQuery: `SELECT CAST(p.id AS TEXT) FROM projects p LEFT JOIN project_states s ON s.project_id = p.id
WHERE s.project_id IS NULL ORDER BY p.id LIMIT ?`,
	},
	{
		name: "ai_configs.global_and_unique", table: "ai_configs", code: "non_global_or_duplicate_ai_config",
		countQuery: `SELECT
 (SELECT COUNT(*) FROM ai_configs WHERE project_id IS NOT NULL)
 +(SELECT COUNT(*) FROM (
   SELECT name,provider,base_url,api_key,model,temperature,thinking_depth,thinking_budget_tokens
   FROM ai_configs GROUP BY name,provider,base_url,api_key,model,temperature,thinking_depth,thinking_budget_tokens HAVING COUNT(*) > 1
 ))`,
		sampleQuery: `SELECT CAST(id AS TEXT) FROM ai_configs WHERE project_id IS NOT NULL
UNION SELECT CAST(MIN(id) AS TEXT) FROM ai_configs
GROUP BY name,provider,base_url,api_key,model,temperature,thinking_depth,thinking_budget_tokens HAVING COUNT(*) > 1
ORDER BY 1 LIMIT ?`,
	},
	{
		name: "claude_cli_configs.default", table: "claude_cli_configs", code: "invalid_or_duplicate_claude_default",
		countQuery: `SELECT
 (SELECT COUNT(*) FROM claude_cli_configs WHERE is_default NOT IN (0,1))
 +(SELECT COUNT(*) FROM (SELECT COALESCE(project_id,0) FROM claude_cli_configs WHERE is_default = 1
   GROUP BY COALESCE(project_id,0) HAVING COUNT(*) > 1))`,
		sampleQuery: `SELECT CAST(id AS TEXT) FROM claude_cli_configs WHERE is_default NOT IN (0,1)
UNION SELECT CAST(MIN(id) AS TEXT) FROM claude_cli_configs WHERE is_default = 1
GROUP BY COALESCE(project_id,0) HAVING COUNT(*) > 1 ORDER BY 1 LIMIT ?`,
	},
	{
		name: "operations.state_machine", table: "operations", code: "invalid_operation_state",
		countQuery:  `SELECT COUNT(*) FROM operations WHERE ` + invalidOperationStatePredicate,
		sampleQuery: `SELECT operation_id FROM operations WHERE ` + invalidOperationStatePredicate + `
ORDER BY operation_id LIMIT ?`,
	},
	{
		name: "event_outbox.state_and_order", table: "event_outbox", code: "invalid_outbox_state",
		countQuery: `SELECT COUNT(*) FROM event_outbox WHERE schema_version != 1 OR sequence < 0 OR attempts < 0
OR event_id = '' OR stream_key = '' OR type = '' OR request_id = ''`,
		sampleQuery: `SELECT CAST(id AS TEXT) FROM event_outbox WHERE schema_version != 1 OR sequence < 0 OR attempts < 0
OR event_id = '' OR stream_key = '' OR type = '' OR request_id = '' ORDER BY id LIMIT ?`,
	},
	{
		name: "secret_refs.shape", table: "secret_refs", code: "invalid_secret_reference",
		countQuery: `SELECT COUNT(*) FROM secret_refs WHERE owner_type = '' OR owner_id = '' OR field_name = ''
OR provider = '' OR reference = '' OR has_value NOT IN (0,1) OR version <= 0`,
		sampleQuery: `SELECT CAST(id AS TEXT) FROM secret_refs WHERE owner_type = '' OR owner_id = '' OR field_name = ''
OR provider = '' OR reference = '' OR has_value NOT IN (0,1) OR version <= 0 ORDER BY id LIMIT ?`,
	},
	{
		name: "loop_state.singleton", table: "loop_state", code: "invalid_loop_state_singleton",
		countQuery:  `SELECT COUNT(*) FROM loop_state WHERE id != 1`,
		sampleQuery: `SELECT CAST(id AS TEXT) FROM loop_state WHERE id != 1 ORDER BY id LIMIT ?`,
	},
}

func auditAggregates(ctx context.Context, database Queryer, available map[string]struct{}, maximum int, report *Report) error {
	for _, spec := range aggregateSpecs {
		if err := ctx.Err(); err != nil {
			return err
		}
		if !queryTablesAvailable(spec.countQuery, available) {
			report.Aggregates = append(report.Aggregates, AggregateMetric{
				Invariant: spec.name, RecordSetSHA256: newRecordSetHasher().Sum(), Evaluated: false,
			})
			continue
		}
		var count int64
		if err := database.QueryRowContext(ctx, spec.countQuery).Scan(&count); err != nil {
			return err
		}
		identifiers := make([]string, 0)
		fingerprint := newRecordSetHasher()
		if count > 0 {
			query, ok := strings.CutSuffix(spec.sampleQuery, " LIMIT ?")
			if !ok {
				return ErrAuditInvalid
			}
			rows, err := database.QueryContext(ctx, query)
			if err != nil {
				return err
			}
			for rows.Next() {
				var key string
				if err := rows.Scan(&key); err != nil {
					_ = rows.Close()
					return err
				}
				identifier := recordIdentifier(spec.name, key)
				fingerprint.Add(identifier)
				if len(identifiers) < maximum {
					identifiers = append(identifiers, identifier)
				}
			}
			if err := rows.Close(); err != nil || rows.Err() != nil {
				return ErrAuditIncomplete
			}
		}
		report.Aggregates = append(report.Aggregates, AggregateMetric{
			Invariant: spec.name, Count: count, RecordIDs: identifiers, RecordSetSHA256: fingerprint.Sum(),
			Truncated: count > int64(len(identifiers)), Evaluated: true,
		})
		if count > 0 {
			report.Findings = append(report.Findings, blocking("aggregate", spec.code, spec.table, "", count, identifiers))
		}
	}
	return nil
}
