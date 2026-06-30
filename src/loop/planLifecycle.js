const { nowIso } = require('../database');
const { hasAgentCliOverride, planAgentCliColumnValues } = require('./agentCliConfig');

const LINKED_INTAKE_COMPLETED_STATUS = 'completed';
const LINKED_INTAKE_TERMINAL_STATUSES = Object.freeze(['completed', 'closed']);
const LINKED_INTAKE_COMPLETION_SOURCES = Object.freeze([
  { table: 'requirements', countKey: 'requirements', idsKey: 'requirementIds' },
  { table: 'feedback', countKey: 'feedback', idsKey: 'feedbackIds' },
]);

function linkedIntakeCompletionResult(planId, projectId, overrides = {}) {
  const requirements = Number(overrides.requirements || 0);
  const feedback = Number(overrides.feedback || 0);
  return {
    planId: Number(planId || 0) || null,
    projectId: Number(projectId || 0) || null,
    requirements,
    feedback,
    total: requirements + feedback,
    requirementIds: Array.isArray(overrides.requirementIds) ? overrides.requirementIds : [],
    feedbackIds: Array.isArray(overrides.feedbackIds) ? overrides.feedbackIds : [],
    updatedAt: overrides.updatedAt || null,
  };
}

function hasPlanForIssueHash(service, projectId, issueHash) {
  return Boolean(
    service.db.get('SELECT id FROM plans WHERE project_id = ? AND issue_hash = ? LIMIT 1', [projectId, issueHash]),
  );
}

function nextRunnablePlan(service, projectId) {
  return service.db.get(
    `SELECT * FROM plans
     WHERE project_id = ? AND status NOT IN ('completed', 'interrupted', 'draft')
     ORDER BY sort_order ASC, created_at ASC, id ASC
     LIMIT 1`,
    [projectId],
  );
}

function nextPlanSortOrder(service, projectId) {
  const row = service.db.get('SELECT COALESCE(MAX(sort_order), 0) AS sort_order FROM plans WHERE project_id = ?', [projectId]);
  return Number(row?.sort_order || 0) + 1;
}

function activateDraftPlan(service, plan) {
  if (!plan?.id) return plan;
  const currentPlan = plan.project_id != null
    ? service.db.get('SELECT * FROM plans WHERE id = ? AND project_id = ?', [plan.id, plan.project_id])
    : service.db.get('SELECT * FROM plans WHERE id = ?', [plan.id]);
  if (!currentPlan) return plan;
  if (currentPlan.status !== 'draft') return currentPlan;

  const updatedAt = nowIso();
  service.db.runBatch([
    {
      sql: 'UPDATE plans SET status = ?, updated_at = ? WHERE id = ? AND status = ?',
      params: ['running', updatedAt, currentPlan.id, 'draft'],
    },
    {
      sql: `INSERT INTO events (project_id, type, message, meta, created_at)
            SELECT ?, ?, ?, ?, ?
            WHERE EXISTS (
              SELECT 1 FROM plans
              WHERE id = ? AND status != ? AND updated_at = ?
            )`,
      params: [
        currentPlan.project_id,
        'plan.draft.started',
        `草稿计划 #${currentPlan.id} 已开始执行`,
        JSON.stringify({ planId: currentPlan.id }),
        updatedAt,
        currentPlan.id,
        'draft',
        updatedAt,
      ],
    },
  ]);
  const activatedPlan = service.db.get('SELECT * FROM plans WHERE id = ?', [currentPlan.id]);
  if (!activatedPlan) return currentPlan;
  if (activatedPlan.status === 'draft') {
    throw new Error(`草稿计划 #${currentPlan.id} 激活失败`);
  }
  service.emitUpdate(activatedPlan.project_id);
  return activatedPlan;
}

function reorderPlans(service, projectId, planIds) {
  const normalizedProjectId = Number(projectId || 0);
  if (!normalizedProjectId || !service.project(normalizedProjectId)) throw new Error('项目不存在');
  if (!Array.isArray(planIds)) throw new Error('计划顺序无效');

  const orderedIds = planIds.map((id) => Number(id));
  if (orderedIds.some((id) => !Number.isInteger(id) || id <= 0)) throw new Error('计划顺序包含非法 ID');
  if (new Set(orderedIds).size !== orderedIds.length) throw new Error('计划顺序包含重复 ID');

  const existingPlans = service.db.all(
    'SELECT id, sort_order FROM plans WHERE project_id = ? ORDER BY sort_order ASC, created_at ASC, id ASC',
    [normalizedProjectId],
  );
  if (orderedIds.length !== existingPlans.length) throw new Error('计划顺序缺少或多出计划');

  const existingIds = new Set(existingPlans.map((plan) => Number(plan.id)));
  for (const id of orderedIds) {
    if (!existingIds.has(id)) throw new Error('计划顺序包含不属于当前项目的计划');
  }

  const currentOrderById = new Map(existingPlans.map((plan) => [Number(plan.id), Number(plan.sort_order || 0)]));
  const updatedAt = nowIso();
  orderedIds.forEach((id, index) => {
    const sortOrder = index + 1;
    if (currentOrderById.get(id) === sortOrder) return;
    service.db.run('UPDATE plans SET sort_order = ?, updated_at = ? WHERE id = ? AND project_id = ?', [
      sortOrder,
      updatedAt,
      id,
      normalizedProjectId,
    ]);
  });
  service.emitUpdate(normalizedProjectId);
  return service.snapshot(normalizedProjectId);
}

function insertPlan(service, { projectId, issueHash, filePath, hash, status, sortOrder, agentCliConfig }) {
  const createdAt = nowIso();
  const normalizedSortOrder = Number.isFinite(Number(sortOrder)) && Number(sortOrder) > 0
    ? Number(sortOrder)
    : nextPlanSortOrder(service, projectId);
  const columns = [
    'project_id',
    'issue_hash',
    'file_path',
    'hash',
    'status',
    'sort_order',
    'total_tasks',
    'completed_tasks',
    'validation_passed',
    'created_at',
    'updated_at',
  ];
  const values = [projectId, issueHash, filePath, hash, status, normalizedSortOrder, 0, 0, 0, createdAt, createdAt];
  for (const [column, value] of planAgentCliColumnValues(service.planColumns(), agentCliConfig)) {
    columns.push(column);
    values.push(value);
  }
  return service.db.insert(
    `INSERT INTO plans (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
    values,
  );
}

function completeLinkedIntakesForPlan(service, plan) {
  const requestedPlanId = Number(plan?.id || 0);
  let projectId = Number(plan?.project_id || 0);
  if (!requestedPlanId) return linkedIntakeCompletionResult(requestedPlanId, projectId);

  if (!projectId) {
    const persistedPlan = service.db.get('SELECT project_id FROM plans WHERE id = ?', [requestedPlanId]);
    projectId = Number(persistedPlan?.project_id || 0);
  }
  if (!projectId) return linkedIntakeCompletionResult(requestedPlanId, projectId);

  const rowsBySource = Object.fromEntries(
    LINKED_INTAKE_COMPLETION_SOURCES.map((source) => [
      source.countKey,
      service.db.all(
        `SELECT id FROM ${source.table}
         WHERE project_id = ? AND linked_plan_id = ?
           AND (status IS NULL OR LOWER(TRIM(status)) NOT IN (?, ?))
         ORDER BY id ASC`,
        [projectId, requestedPlanId, ...LINKED_INTAKE_TERMINAL_STATUSES],
      ),
    ]),
  );
  const completionSummary = {};
  for (const source of LINKED_INTAKE_COMPLETION_SOURCES) {
    const rows = rowsBySource[source.countKey] || [];
    completionSummary[source.countKey] = rows.length;
    completionSummary[source.idsKey] = rows.map((row) => Number(row.id));
  }
  const result = linkedIntakeCompletionResult(requestedPlanId, projectId, completionSummary);
  if (result.total === 0) return result;

  const updatedAt = nowIso();
  result.updatedAt = updatedAt;
  service.db.runBatch([
    ...LINKED_INTAKE_COMPLETION_SOURCES.map((source) => ({
      sql: `UPDATE ${source.table}
            SET status = ?, updated_at = ?
            WHERE project_id = ? AND linked_plan_id = ?
              AND (status IS NULL OR LOWER(TRIM(status)) NOT IN (?, ?))`,
      params: [
        LINKED_INTAKE_COMPLETED_STATUS,
        updatedAt,
        projectId,
        requestedPlanId,
        ...LINKED_INTAKE_TERMINAL_STATUSES,
      ],
    })),
    {
      sql: 'INSERT INTO events (project_id, type, message, meta, created_at) VALUES (?, ?, ?, ?, ?)',
      params: [
        projectId,
        'plan.linked_intakes.completed',
        `关联需求/反馈已标记完成：需求 ${result.requirements} 条，反馈 ${result.feedback} 条`,
        JSON.stringify(result),
        updatedAt,
      ],
    },
  ]);
  service.emitUpdate(projectId);
  return result;
}

module.exports = {
  hasPlanForIssueHash,
  nextRunnablePlan,
  nextPlanSortOrder,
  activateDraftPlan,
  reorderPlans,
  insertPlan,
  completeLinkedIntakesForPlan,
  linkedIntakeCompletionResult,
  LINKED_INTAKE_COMPLETED_STATUS,
  LINKED_INTAKE_TERMINAL_STATUSES,
  LINKED_INTAKE_COMPLETION_SOURCES,
};
