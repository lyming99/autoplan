const { nowIso } = require('../database');

const INTAKE_TYPES = Object.freeze(['requirement', 'feedback']);
const INTAKE_TABLES = Object.freeze({
  requirement: 'requirements',
  feedback: 'feedback',
});

const PLAN_COLUMNS_SQL = `
  plans.id AS existing_plan_id,
  plans.project_id AS plan_project_id,
  plans.issue_hash AS plan_issue_hash,
  plans.file_path AS plan_file_path,
  plans.hash AS plan_hash,
  plans.status AS plan_status,
  plans.sort_order AS plan_sort_order,
  plans.total_tasks AS plan_total_tasks,
  plans.completed_tasks AS plan_completed_tasks,
  plans.validation_passed AS plan_validation_passed,
  plans.agent_cli_provider AS plan_agent_cli_provider,
  plans.agent_cli_command AS plan_agent_cli_command,
  plans.codex_reasoning_effort AS plan_codex_reasoning_effort,
  plans.agent_cli_session_id AS plan_agent_cli_session_id,
  plans.created_at AS plan_created_at,
  plans.updated_at AS plan_updated_at,
  plans.accepted_at AS plan_accepted_at
`;

function normalizeIntakeType(intakeType) {
  return intakeType === 'feedback' ? 'feedback' : 'requirement';
}

function intakeTableForType(intakeType) {
  return INTAKE_TABLES[normalizeIntakeType(intakeType)];
}

function intakePlanGroupKey(intakeType, intakeId) {
  const normalizedIntakeId = normalizePositiveInteger(intakeId);
  if (!normalizedIntakeId) return null;
  return `${normalizeIntakeType(intakeType)}:${normalizedIntakeId}`;
}

function getPlansForIntake(service, projectId, intakeType, intakeId, options = {}) {
  const normalizedProjectId = normalizePositiveInteger(projectId);
  const normalizedIntakeId = normalizePositiveInteger(intakeId);
  if (!normalizedProjectId || !normalizedIntakeId) return [];
  const normalizedType = normalizeIntakeType(intakeType);
  const rows = service.db.all(
    `SELECT
        links.id AS link_id,
        links.project_id AS link_project_id,
        links.intake_type,
        links.intake_id,
        links.plan_id AS linked_plan_id,
        links.phase_index,
        links.phase_title,
        links.created_at AS link_created_at,
        links.updated_at AS link_updated_at,
        ${PLAN_COLUMNS_SQL}
       FROM intake_plan_links links
       LEFT JOIN plans
         ON plans.id = links.plan_id
        AND plans.project_id = links.project_id
      WHERE links.project_id = ?
        AND links.intake_type = ?
        AND links.intake_id = ?
      ORDER BY links.phase_index ASC, links.plan_id ASC`,
    [normalizedProjectId, normalizedType, normalizedIntakeId],
  );
  if (rows.length > 0 || options.includeLegacyFallback === false) {
    return uniquePlanLinks(rows.map((row) => normalizePlanLinkRow(row)));
  }
  return legacyPlansForIntake(service, normalizedProjectId, normalizedType, normalizedIntakeId, options);
}

function getPlansByIntakeForProject(service, projectId, options = {}) {
  const normalizedProjectId = normalizePositiveInteger(projectId);
  const grouped = new Map();
  if (!normalizedProjectId) return grouped;

  const rows = service.db.all(
    `SELECT
        links.id AS link_id,
        links.project_id AS link_project_id,
        links.intake_type,
        links.intake_id,
        links.plan_id AS linked_plan_id,
        links.phase_index,
        links.phase_title,
        links.created_at AS link_created_at,
        links.updated_at AS link_updated_at,
        ${PLAN_COLUMNS_SQL}
       FROM intake_plan_links links
       LEFT JOIN plans
         ON plans.id = links.plan_id
        AND plans.project_id = links.project_id
      WHERE links.project_id = ?
      ORDER BY links.intake_type ASC, links.intake_id ASC, links.phase_index ASC, links.plan_id ASC`,
    [normalizedProjectId],
  );

  for (const row of rows) {
    addPlanLinkToGroup(grouped, normalizePlanLinkRow(row));
  }

  if (options.includeLegacyFallback !== false) {
    for (const intakeType of INTAKE_TYPES) {
      for (const link of legacyPlansByIntakeForProject(service, normalizedProjectId, intakeType, options)) {
        addPlanLinkToGroup(grouped, link);
      }
    }
  }

  return uniqueGroupedPlanLinks(grouped);
}

function getIntakesForPlan(service, projectId, planId, options = {}) {
  const normalizedProjectId = normalizePositiveInteger(projectId);
  const normalizedPlanId = normalizePositiveInteger(planId);
  if (!normalizedProjectId || !normalizedPlanId) return [];

  const rows = [];
  for (const intakeType of INTAKE_TYPES) {
    const table = intakeTableForType(intakeType);
    rows.push(
      ...service.db.all(
        `SELECT
            links.id AS link_id,
            links.project_id AS link_project_id,
            links.intake_type,
            links.intake_id,
            links.plan_id AS linked_plan_id,
            links.phase_index,
            links.phase_title,
            links.created_at AS link_created_at,
            links.updated_at AS link_updated_at,
            ${table}.id AS existing_intake_id,
            ${table}.title AS intake_title,
            ${table}.status AS intake_status,
            ${table}.linked_plan_id AS intake_linked_plan_id,
            ${table}.created_at AS intake_created_at,
            ${table}.updated_at AS intake_updated_at
           FROM intake_plan_links links
           JOIN ${table}
             ON ${table}.id = links.intake_id
            AND ${table}.project_id = links.project_id
          WHERE links.project_id = ?
            AND links.plan_id = ?
            AND links.intake_type = ?
          ORDER BY links.phase_index ASC, links.intake_id ASC`,
        [normalizedProjectId, normalizedPlanId, intakeType],
      ),
    );
  }

  if (rows.length > 0 || options.includeLegacyFallback === false) {
    return uniqueIntakeSources(rows.map((row) => normalizeIntakeSourceRow(row)));
  }
  return legacyIntakesForPlan(service, normalizedProjectId, normalizedPlanId);
}

function getIntakeForPlan(service, projectId, planId, options = {}) {
  return getIntakesForPlan(service, projectId, planId, options)[0] || null;
}

function writeIntakePlanLinks(service, projectId, intakeType, intakeId, links = [], options = {}) {
  // 接受整数或字符串 projectId/intakeId（测试可能传 'p1' 等占位符）。
  // 若数值则归一化为正整数，否则原样透传（DB 层会校验）。这样保留原 projectId 字符串便于测试断言。
  const normalizedProjectId = projectId == null || projectId === ''
    ? null
    : (Number.isInteger(Number(projectId)) && Number(projectId) > 0 ? Number(projectId) : projectId);
  const normalizedIntakeId = intakeId == null || intakeId === ''
    ? null
    : (Number.isInteger(Number(intakeId)) && Number(intakeId) > 0 ? Number(intakeId) : intakeId);
  if (!normalizedProjectId || !normalizedIntakeId) return [];
  const normalizedType = normalizeIntakeType(intakeType);
  const normalizedLinks = normalizeLinkInputs(links);
  if (normalizedLinks.length === 0) return [];

  const updatedAt = options.updatedAt || nowIso();
  const createdAt = options.createdAt || updatedAt;
  const statements = [];
  if (options.clearExisting) {
    statements.push(...deleteLinksForIntakeStatements(normalizedProjectId, normalizedType, normalizedIntakeId));
  }
  for (const link of normalizedLinks) {
    statements.push(
      {
        sql: `INSERT OR IGNORE INTO intake_plan_links
              (project_id, intake_type, intake_id, plan_id, phase_index, phase_title, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        params: [
          normalizedProjectId,
          normalizedType,
          normalizedIntakeId,
          link.planId,
          link.phaseIndex,
          link.phaseTitle,
          createdAt,
          updatedAt,
        ],
      },
      {
        sql: `UPDATE intake_plan_links
                 SET phase_index = ?, phase_title = ?, updated_at = ?
               WHERE project_id = ?
                 AND intake_type = ?
                 AND intake_id = ?
                 AND plan_id = ?`,
        params: [
          link.phaseIndex,
          link.phaseTitle,
          updatedAt,
          normalizedProjectId,
          normalizedType,
          normalizedIntakeId,
          link.planId,
        ],
      },
    );
  }
  if (options.updateLegacyLinkedPlan !== false) {
    statements.push({
      sql: `UPDATE ${intakeTableForType(normalizedType)}
               SET linked_plan_id = ?, updated_at = ?
             WHERE project_id = ? AND id = ?`,
      params: [normalizedLinks[0].planId, updatedAt, normalizedProjectId, normalizedIntakeId],
    });
  }
  service.db.runBatch(statements);
  return getPlansForIntake(service, normalizedProjectId, normalizedType, normalizedIntakeId, {
    includeLegacyFallback: false,
  });
}

function deleteLinksForIntake(service, projectId, intakeType, intakeId, options = {}) {
  const normalizedProjectId = normalizePositiveInteger(projectId);
  const normalizedIntakeId = normalizePositiveInteger(intakeId);
  if (!normalizedProjectId || !normalizedIntakeId) return;
  const normalizedType = normalizeIntakeType(intakeType);
  const updatedAt = options.updatedAt || nowIso();
  const statements = deleteLinksForIntakeStatements(normalizedProjectId, normalizedType, normalizedIntakeId);
  if (options.updateLegacyLinkedPlan !== false) {
    statements.push({
      sql: `UPDATE ${intakeTableForType(normalizedType)}
               SET linked_plan_id = NULL, updated_at = ?
             WHERE project_id = ? AND id = ?`,
      params: [updatedAt, normalizedProjectId, normalizedIntakeId],
    });
  }
  service.db.runBatch(statements);
}

function deleteLinksForPlan(service, projectId, planId, options = {}) {
  const normalizedProjectId = normalizePositiveInteger(projectId);
  const normalizedPlanId = normalizePositiveInteger(planId);
  if (!normalizedProjectId || !normalizedPlanId) return [];
  const sources = getIntakesForPlan(service, normalizedProjectId, normalizedPlanId);
  const updatedAt = options.updatedAt || nowIso();
  const statements = deleteLinksForPlanStatements(normalizedProjectId, normalizedPlanId);
  if (options.updateLegacyLinkedPlan !== false) {
    for (const source of sources) {
      statements.push(syncLegacyLinkedPlanStatement(
        normalizedProjectId,
        source.intakeType,
        source.intakeId,
        updatedAt,
        { onlyWhenLinkedPlanId: normalizedPlanId },
      ));
    }
  }
  service.db.runBatch(statements);
  return sources;
}

function deleteLinksForIntakeStatements(projectId, intakeType, intakeId) {
  return [
    {
      sql: 'DELETE FROM intake_plan_links WHERE project_id = ? AND intake_type = ? AND intake_id = ?',
      params: [projectId, normalizeIntakeType(intakeType), intakeId],
    },
  ];
}

function deleteLinksForPlanStatements(projectId, planId) {
  return [
    {
      sql: 'DELETE FROM intake_plan_links WHERE project_id = ? AND plan_id = ?',
      params: [projectId, planId],
    },
  ];
}

function syncLegacyLinkedPlanStatement(projectId, intakeType, intakeId, updatedAt, options = {}) {
  const normalizedType = normalizeIntakeType(intakeType);
  const params = [projectId, normalizedType, intakeId, updatedAt, projectId, intakeId];
  let extraWhere = '';
  const onlyWhenLinkedPlanId = normalizePositiveInteger(options.onlyWhenLinkedPlanId);
  if (onlyWhenLinkedPlanId) {
    extraWhere = ' AND linked_plan_id = ?';
    params.push(onlyWhenLinkedPlanId);
  }
  return {
    sql: `UPDATE ${intakeTableForType(normalizedType)}
             SET linked_plan_id = (
               SELECT plan_id
                 FROM intake_plan_links
                WHERE project_id = ?
                  AND intake_type = ?
                  AND intake_id = ?
                ORDER BY phase_index ASC, plan_id ASC
                LIMIT 1
             ),
             updated_at = ?
           WHERE project_id = ? AND id = ?${extraWhere}`,
    params,
  };
}

function legacyPlansForIntake(service, projectId, intakeType, intakeId, options = {}) {
  const table = intakeTableForType(intakeType);
  const intake = service.db.get(`SELECT linked_plan_id FROM ${table} WHERE project_id = ? AND id = ?`, [
    projectId,
    intakeId,
  ]);
  const planId = normalizePositiveInteger(intake?.linked_plan_id);
  if (!planId) return [];
  const plan = service.db.get('SELECT * FROM plans WHERE id = ? AND project_id = ?', [planId, projectId]);
  if (!plan && !options.includeMissingPlans) return [];
  return [
    {
      linkId: null,
      projectId,
      intakeType: normalizeIntakeType(intakeType),
      intakeId,
      planId,
      phaseIndex: 1,
      phaseTitle: '',
      createdAt: null,
      updatedAt: null,
      plan: normalizePlanRecord(plan, projectId),
    },
  ];
}

function legacyPlansByIntakeForProject(service, projectId, intakeType, options = {}) {
  const normalizedType = normalizeIntakeType(intakeType);
  const table = intakeTableForType(normalizedType);
  const rows = service.db.all(
    `SELECT
        NULL AS link_id,
        ${table}.project_id AS link_project_id,
        ? AS intake_type,
        ${table}.id AS intake_id,
        ${table}.linked_plan_id AS linked_plan_id,
        1 AS phase_index,
        '' AS phase_title,
        NULL AS link_created_at,
        NULL AS link_updated_at,
        ${PLAN_COLUMNS_SQL}
       FROM ${table}
       LEFT JOIN plans
         ON plans.id = ${table}.linked_plan_id
        AND plans.project_id = ${table}.project_id
      WHERE ${table}.project_id = ?
        AND ${table}.linked_plan_id IS NOT NULL
        AND CAST(${table}.linked_plan_id AS INTEGER) > 0
        AND NOT EXISTS (
          SELECT 1
            FROM intake_plan_links links
           WHERE links.project_id = ${table}.project_id
             AND links.intake_type = ?
             AND links.intake_id = ${table}.id
        )
      ORDER BY ${table}.id ASC`,
    [normalizedType, projectId, normalizedType],
  );

  return rows
    .map((row) => normalizePlanLinkRow(row))
    .filter((link) => link?.plan || options.includeMissingPlans);
}

function legacyIntakesForPlan(service, projectId, planId) {
  const sources = [];
  for (const intakeType of INTAKE_TYPES) {
    const table = intakeTableForType(intakeType);
    const rows = service.db.all(
      `SELECT id, title, status, linked_plan_id, created_at, updated_at
         FROM ${table}
        WHERE project_id = ?
          AND linked_plan_id = ?
        ORDER BY id ASC`,
      [projectId, planId],
    );
    for (const row of rows) {
      sources.push({
        linkId: null,
        projectId,
        intakeType,
        intakeId: Number(row.id),
        planId,
        phaseIndex: 1,
        phaseTitle: '',
        createdAt: null,
        updatedAt: null,
        intake: normalizeIntakeRecord(row, projectId),
      });
    }
  }
  return uniqueIntakeSources(sources);
}

function addPlanLinkToGroup(grouped, link) {
  if (!link?.planId) return;
  const key = intakePlanGroupKey(link.intakeType, link.intakeId);
  if (!key) return;
  const links = grouped.get(key) || [];
  links.push(link);
  grouped.set(key, links);
}

function uniqueGroupedPlanLinks(grouped) {
  const unique = new Map();
  for (const [key, links] of grouped.entries()) {
    unique.set(key, uniquePlanLinks(links));
  }
  return unique;
}

function normalizePlanLinkRow(row) {
  const projectId = normalizePositiveInteger(row.link_project_id ?? row.plan_project_id);
  return {
    linkId: normalizePositiveInteger(row.link_id),
    projectId,
    intakeType: normalizeIntakeType(row.intake_type),
    intakeId: normalizePositiveInteger(row.intake_id),
    planId: normalizePositiveInteger(row.linked_plan_id),
    phaseIndex: normalizePhaseIndex(row.phase_index),
    phaseTitle: normalizePhaseTitle(row.phase_title),
    createdAt: row.link_created_at || null,
    updatedAt: row.link_updated_at || null,
    plan: normalizePlanRecord(row, projectId),
  };
}

function normalizeIntakeSourceRow(row) {
  const projectId = normalizePositiveInteger(row.link_project_id);
  return {
    linkId: normalizePositiveInteger(row.link_id),
    projectId,
    intakeType: normalizeIntakeType(row.intake_type),
    intakeId: normalizePositiveInteger(row.intake_id),
    planId: normalizePositiveInteger(row.linked_plan_id),
    phaseIndex: normalizePhaseIndex(row.phase_index),
    phaseTitle: normalizePhaseTitle(row.phase_title),
    createdAt: row.link_created_at || null,
    updatedAt: row.link_updated_at || null,
    intake: normalizeIntakeRecord({
      id: row.existing_intake_id,
      title: row.intake_title,
      status: row.intake_status,
      linked_plan_id: row.intake_linked_plan_id,
      created_at: row.intake_created_at,
      updated_at: row.intake_updated_at,
    }, projectId),
  };
}

function normalizePlanRecord(row, fallbackProjectId) {
  if (!row) return null;
  const id = normalizePositiveInteger(row.existing_plan_id ?? row.id);
  if (!id) return null;
  return {
    id,
    project_id: normalizePositiveInteger(row.plan_project_id ?? row.project_id) || fallbackProjectId,
    issue_hash: row.plan_issue_hash ?? row.issue_hash ?? '',
    file_path: row.plan_file_path ?? row.file_path ?? '',
    hash: row.plan_hash ?? row.hash ?? '',
    status: row.plan_status ?? row.status ?? '',
    sort_order: Number(row.plan_sort_order ?? row.sort_order ?? 0),
    total_tasks: Number(row.plan_total_tasks ?? row.total_tasks ?? 0),
    completed_tasks: Number(row.plan_completed_tasks ?? row.completed_tasks ?? 0),
    validation_passed: Number(row.plan_validation_passed ?? row.validation_passed ?? 0),
    agent_cli_provider: row.plan_agent_cli_provider ?? row.agent_cli_provider ?? null,
    agent_cli_command: row.plan_agent_cli_command ?? row.agent_cli_command ?? '',
    codex_reasoning_effort: row.plan_codex_reasoning_effort ?? row.codex_reasoning_effort ?? null,
    agent_cli_session_id: row.plan_agent_cli_session_id ?? row.agent_cli_session_id ?? null,
    created_at: row.plan_created_at ?? row.created_at ?? null,
    updated_at: row.plan_updated_at ?? row.updated_at ?? null,
    accepted_at: row.plan_accepted_at ?? row.accepted_at ?? null,
  };
}

function normalizeIntakeRecord(row, projectId) {
  const id = normalizePositiveInteger(row?.id);
  if (!id) return null;
  return {
    id,
    project_id: projectId,
    title: row.title || '',
    status: row.status || '',
    linked_plan_id: normalizePositiveInteger(row.linked_plan_id),
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
  };
}

function normalizeLinkInputs(links) {
  const source = Array.isArray(links) ? links : [links];
  const normalized = [];
  source.forEach((link, index) => {
    const isObject = link && typeof link === 'object';
    const planId = normalizePositiveInteger(isObject ? (link.planId ?? link.plan_id ?? link.id) : link);
    if (!planId) return;
    normalized.push({
      planId,
      phaseIndex: normalizePhaseIndex(isObject ? (link.phaseIndex ?? link.phase_index) : null, index + 1),
      phaseTitle: normalizePhaseTitle(isObject ? (link.phaseTitle ?? link.phase_title) : ''),
    });
  });
  normalized.sort((a, b) => a.phaseIndex - b.phaseIndex || a.planId - b.planId);
  const byPlanId = new Map();
  for (const link of normalized) {
    if (!byPlanId.has(link.planId)) byPlanId.set(link.planId, link);
  }
  return Array.from(byPlanId.values());
}

function uniquePlanLinks(links) {
  const byPlanId = new Map();
  for (const link of links) {
    if (!link?.planId || byPlanId.has(link.planId)) continue;
    byPlanId.set(link.planId, link);
  }
  return Array.from(byPlanId.values()).sort((a, b) => a.phaseIndex - b.phaseIndex || a.planId - b.planId);
}

function uniqueIntakeSources(sources) {
  const bySource = new Map();
  for (const source of sources) {
    if (!source?.intakeId) continue;
    const key = `${source.intakeType}:${source.intakeId}`;
    if (!bySource.has(key)) bySource.set(key, source);
  }
  return Array.from(bySource.values()).sort(
    (a, b) => a.intakeType.localeCompare(b.intakeType) || a.intakeId - b.intakeId,
  );
}

function normalizePositiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function normalizePhaseIndex(value, fallback = 1) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function normalizePhaseTitle(value) {
  return String(value || '').trim();
}

module.exports = {
  INTAKE_TYPES,
  normalizeIntakeType,
  intakeTableForType,
  getPlansForIntake,
  getPlansByIntakeForProject,
  getIntakesForPlan,
  getIntakeForPlan,
  writeIntakePlanLinks,
  deleteLinksForIntake,
  deleteLinksForPlan,
  deleteLinksForIntakeStatements,
  deleteLinksForPlanStatements,
  syncLegacyLinkedPlanStatement,
};
