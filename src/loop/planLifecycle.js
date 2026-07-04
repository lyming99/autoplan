const { nowIso } = require('../database');
const { planAgentCliColumnValues } = require('./agentCliConfig');
const intakePlanLinks = require('./intakePlanLinks');
const planBackendConfig = require('./planBackendConfig');
const { TASK_EVENT_STATUS, TASK_EVENT_TYPES } = require('./taskEvents');

const LINKED_INTAKE_COMPLETED_STATUS = 'completed';
const LINKED_INTAKE_TERMINAL_STATUSES = Object.freeze(['completed', 'closed']);
const LINKED_INTAKE_COMPLETION_SOURCES = Object.freeze([
  { table: 'requirements', countKey: 'requirements', idsKey: 'requirementIds' },
  { table: 'feedback', countKey: 'feedback', idsKey: 'feedbackIds' },
]);

const PLAN_RUNNING_STATUS = 'running';
const PLAN_INTERRUPTED_STATUS = 'interrupted';
const PLAN_UNFINISHED_TASK_STATUSES = Object.freeze(['pending', TASK_EVENT_STATUS.RUNNING]);
const PLAN_COMPLETED_STATUSES = Object.freeze(['completed']);

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

function planForProject(service, projectId, planId) {
  const normalizedProjectId = Number(projectId || 0);
  const normalizedPlanId = Number(planId || 0);
  if (!normalizedProjectId || !service.project(normalizedProjectId)) throw new Error('项目不存在');
  if (!normalizedPlanId) throw new Error('计划不存在');
  const plan = service.db.get('SELECT * FROM plans WHERE id = ? AND project_id = ?', [
    normalizedPlanId,
    normalizedProjectId,
  ]);
  if (!plan) throw new Error('计划不存在');
  return plan;
}

function findPlanForProject(service, projectId, planId) {
  if (!planId) return null;
  return service.db.get('SELECT * FROM plans WHERE id = ? AND project_id = ?', [planId, projectId]);
}

function hasRunningPlanTask(service, planId) {
  return Boolean(
    service.db.get('SELECT 1 FROM plan_tasks WHERE plan_id = ? AND status = ? LIMIT 1', [
      planId,
      TASK_EVENT_STATUS.RUNNING,
    ]),
  );
}

function hasActivePlanOperation(service, projectId, planId) {
  const runtime = typeof service.existingRuntime === 'function' ? service.existingRuntime(projectId) : null;
  if (!runtime?.activeOperations) return false;
  for (const operation of runtime.activeOperations.values()) {
    if (Number(operation?.planId) === Number(planId)) return true;
  }
  return false;
}

function isPlanRunning(service, projectId, plan) {
  if (!plan?.id) return false;
  if (String(plan.status || '') === PLAN_RUNNING_STATUS) return true;
  if (hasRunningPlanTask(service, plan.id)) return true;
  return hasActivePlanOperation(service, projectId, plan.id);
}

function interruptPlan(service, projectId, planId, options = {}) {
  const normalizedProjectId = Number(projectId || 0);
  const normalizedPlanId = Number(planId || 0);
  const plan = options.throwIfMissing
    ? planForProject(service, normalizedProjectId, normalizedPlanId)
    : findPlanForProject(service, normalizedProjectId, normalizedPlanId);
  if (!plan) return null;
  if (options.requireRunning && !isPlanRunning(service, normalizedProjectId, plan)) {
    throw new Error('计划未在运行中');
  }

  const finishedAt = options.finishedAt || nowIso();
  const unfinishedTaskCount = Number(
    service.db.get(
      `SELECT COUNT(*) AS count
       FROM plan_tasks
       WHERE plan_id = ? AND status IN (${PLAN_UNFINISHED_TASK_STATUSES.map(() => '?').join(', ')})`,
      [plan.id, ...PLAN_UNFINISHED_TASK_STATUSES],
    )?.count || 0,
  );
  const stopped = service.stopPlanOperations(normalizedProjectId, plan.id, {
    taskStatus: 'blocked',
    taskEventType: TASK_EVENT_TYPES.INTERRUPTED,
    taskEventStatus: TASK_EVENT_STATUS.INTERRUPTED,
    errorMessage: options.errorMessage || `plan #${plan.id} 已中断`,
    addOperationEvent: false,
    finishedAt,
  });
  service.db.runBatch([
    {
      sql: `UPDATE plan_tasks SET status = ?, updated_at = ?
            WHERE plan_id = ? AND status IN (${PLAN_UNFINISHED_TASK_STATUSES.map(() => '?').join(', ')})`,
      params: ['blocked', finishedAt, plan.id, ...PLAN_UNFINISHED_TASK_STATUSES],
    },
    {
      sql: 'UPDATE plans SET status = ?, updated_at = ? WHERE id = ? AND project_id = ?',
      params: [PLAN_INTERRUPTED_STATUS, finishedAt, plan.id, normalizedProjectId],
    },
  ]);
  service.addEvent(
    normalizedProjectId,
    options.eventType || 'plan.interrupted',
    options.eventMessage || `plan #${plan.id} 已中断，未完成任务已挂起`,
    {
      planId: plan.id,
      previousStatus: plan.status,
      status: PLAN_INTERRUPTED_STATUS,
      stoppedOperations: stopped.length,
      blockedTasks: unfinishedTaskCount,
    },
  );
  service.emitUpdate(normalizedProjectId);
  return service.db.get('SELECT * FROM plans WHERE id = ? AND project_id = ?', [plan.id, normalizedProjectId]);
}

function resumePlan(service, projectId, planId, options = {}) {
  const normalizedProjectId = Number(projectId || 0);
  const normalizedPlanId = Number(planId || 0);
  const plan = options.throwIfMissing
    ? planForProject(service, normalizedProjectId, normalizedPlanId)
    : findPlanForProject(service, normalizedProjectId, normalizedPlanId);
  if (!plan) return null;

  const updatedAt = options.updatedAt || nowIso();
  const blockedTaskCount = Number(
    service.db.get(
      'SELECT COUNT(*) AS count FROM plan_tasks WHERE plan_id = ? AND status = ?',
      [plan.id, 'blocked'],
    )?.count || 0,
  );
  service.db.runBatch([
    {
      sql: `UPDATE plan_tasks SET status = ?, updated_at = ?
            WHERE plan_id = ? AND status = ?`,
      params: ['pending', updatedAt, plan.id, 'blocked'],
    },
    {
      sql: 'UPDATE plans SET status = ?, updated_at = ? WHERE id = ? AND project_id = ?',
      params: ['pending', updatedAt, plan.id, normalizedProjectId],
    },
  ]);
  if (!options.suppressEvent) {
    service.addEvent(
      normalizedProjectId,
      options.eventType || 'plan.resumed',
      options.eventMessage || `plan #${plan.id} 已恢复`,
      {
        planId: plan.id,
        previousStatus: plan.status,
        status: 'pending',
        resumedTasks: blockedTaskCount,
      },
    );
  }
  service.emitUpdate(normalizedProjectId);
  return service.db.get('SELECT * FROM plans WHERE id = ? AND project_id = ?', [plan.id, normalizedProjectId]);
}

function stopPlan(service, projectId, planId) {
  const normalizedProjectId = Number(projectId || 0);
  const plan = planForProject(service, normalizedProjectId, planId);
  if (!isPlanRunning(service, normalizedProjectId, plan)) throw new Error('计划未在运行中');
  interruptPlan(service, normalizedProjectId, plan.id, {
    requireRunning: false,
    eventType: 'plan.stopped',
    eventMessage: `plan #${plan.id} 已停止，未完成任务已挂起`,
    errorMessage: `plan #${plan.id} 已停止`,
  });
  return service.snapshot(normalizedProjectId);
}

function linkedPlansForIntake(service, projectId, intakeType, intakeId) {
  const normalizedProjectId = Number(projectId || 0);
  const normalizedIntakeId = Number(intakeId || 0);
  if (!normalizedProjectId || !normalizedIntakeId) return [];
  return intakePlanLinks
    .getPlansForIntake(service, normalizedProjectId, intakeType, normalizedIntakeId)
    .filter((entry) => entry?.plan?.id && Number(entry.plan.project_id) === normalizedProjectId)
    .sort((a, b) => Number(a.phaseIndex || 0) - Number(b.phaseIndex || 0) || Number(a.planId || 0) - Number(b.planId || 0));
}

function interruptPlansForIntake(service, projectId, intakeType, intakeId) {
  const normalizedProjectId = Number(projectId || 0);
  const plans = linkedPlansForIntake(service, normalizedProjectId, intakeType, intakeId);
  const interrupted = [];
  for (const link of plans.filter((item) => !isCompletedPlan(item.plan))) {
    const interruptedPlan = interruptPlan(service, normalizedProjectId, link.planId);
    if (interruptedPlan) interrupted.push({ link, plan: interruptedPlan });
  }
  const summary = linkedIntakePlanActionSummary('interrupt', normalizedProjectId, intakeType, intakeId, plans, interrupted);
  if (plans.length > 0) {
    service.addEvent(
      normalizedProjectId,
      'intake.plans.interrupted',
      `关联计划已中断：${interrupted.length}/${plans.length}`,
      summary,
    );
  }
  return summary;
}

function resumePlansForIntake(service, projectId, intakeType, intakeId) {
  const normalizedProjectId = Number(projectId || 0);
  const plans = linkedPlansForIntake(service, normalizedProjectId, intakeType, intakeId);
  const resumed = [];
  for (const link of plans.filter((item) => isResumeTargetPlan(service, item.plan))) {
    const resumedPlan = resumePlan(service, normalizedProjectId, link.planId);
    if (resumedPlan) resumed.push({ link, plan: resumedPlan });
  }
  const summary = linkedIntakePlanActionSummary('resume', normalizedProjectId, intakeType, intakeId, plans, resumed);
  if (plans.length > 0) {
    service.addEvent(
      normalizedProjectId,
      'intake.plans.resumed',
      `关联计划已恢复：${resumed.length}/${plans.length}`,
      summary,
    );
  }
  return summary;
}

function appendTaskToIntakePlan(service, projectId, intakeType, intakeId, title) {
  const normalizedProjectId = Number(projectId || 0);
  const plans = linkedPlansForIntake(service, normalizedProjectId, intakeType, intakeId);
  if (plans.length === 0) throw new Error('该需求/反馈尚未生成计划');
  const target = plans.find((link) => !PLAN_COMPLETED_STATUSES.includes(String(link.plan?.status || '').toLowerCase()))
    || plans[plans.length - 1];
  const taskKey = service.appendTask(normalizedProjectId, target.planId, title);
  const summary = {
    action: 'appendTask',
    projectId: normalizedProjectId,
    intakeType: intakeType === 'feedback' ? 'feedback' : 'requirement',
    intakeId: Number(intakeId || 0) || null,
    planId: target.planId,
    taskKey,
    phaseIndex: target.phaseIndex,
    phaseTitle: target.phaseTitle || '',
    planIds: plans.map((link) => Number(link.planId)),
  };
  service.addEvent(
    normalizedProjectId,
    'intake.task.appended',
    `关联计划 #${target.planId} 已追加任务 ${taskKey}`,
    summary,
  );
  return summary;
}

function isCompletedPlan(plan) {
  return PLAN_COMPLETED_STATUSES.includes(String(plan?.status || '').toLowerCase());
}

function isResumeTargetPlan(service, plan) {
  if (!plan?.id || isCompletedPlan(plan)) return false;
  if (String(plan.status || '').toLowerCase() === PLAN_INTERRUPTED_STATUS) return true;
  return Boolean(
    service.db.get('SELECT 1 FROM plan_tasks WHERE plan_id = ? AND status = ? LIMIT 1', [plan.id, 'blocked']),
  );
}

function linkedIntakePlanActionSummary(action, projectId, intakeType, intakeId, plans, affected) {
  return {
    action,
    projectId: Number(projectId || 0) || null,
    intakeType: intakeType === 'feedback' ? 'feedback' : 'requirement',
    intakeId: Number(intakeId || 0) || null,
    totalPlans: plans.length,
    affectedPlans: affected.length,
    planIds: plans.map((link) => Number(link.planId)),
    affectedPlanIds: affected.map((item) => Number(item.link.planId)),
    phases: plans.map((link) => ({
      phaseIndex: link.phaseIndex,
      phaseTitle: link.phaseTitle || '',
      planId: link.planId,
      status: link.plan?.status || '',
    })),
  };
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

function insertPlan(service, {
  projectId,
  issueHash,
  filePath,
  hash,
  status,
  sortOrder,
  agentCliConfig,
  planGenerationConfig,
  planExecutionConfig,
}) {
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
  for (const [column, value] of planBackendColumnValues(service.planColumns(), 'plan_generation', planGenerationConfig)) {
    columns.push(column);
    values.push(value);
  }
  for (const [column, value] of planBackendColumnValues(service.planColumns(), 'plan_execution', planExecutionConfig)) {
    columns.push(column);
    values.push(value);
  }
  return service.db.insert(
    `INSERT INTO plans (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
    values,
  );
}

function planBackendColumnValues(columns, prefix, config) {
  if (!config) return [];
  const normalized = prefix === 'plan_generation'
    ? planBackendConfig.planGenerationConfigFields({
        strategy: config.strategy ?? config.planGenerationStrategy,
        provider: config.provider ?? config.planGenerationProvider,
        command: config.command ?? config.planGenerationCommand,
        model: config.model ?? config.planGenerationModel,
        codexReasoningEffort: config.codexReasoningEffort ?? config.planGenerationCodexReasoningEffort,
      })
    : planBackendConfig.planExecutionConfigFields({
        strategy: config.strategy ?? config.planExecutionStrategy,
        provider: config.provider ?? config.planExecutionProvider,
        command: config.command ?? config.planExecutionCommand,
        model: config.model ?? config.planExecutionModel,
        codexReasoningEffort: config.codexReasoningEffort ?? config.planExecutionCodexReasoningEffort,
      });
  const values = [];
  addPlanBackendColumnValue(values, columns, `${prefix}_strategy`, normalized.strategy);
  addPlanBackendColumnValue(values, columns, `${prefix}_provider`, normalized.provider);
  addPlanBackendColumnValue(values, columns, `${prefix}_command`, normalized.command || '');
  addPlanBackendColumnValue(values, columns, `${prefix}_model`, normalized.model || '');
  addPlanBackendColumnValue(values, columns, `${prefix}_codex_reasoning_effort`, normalized.codexReasoningEffort || null);
  return values;
}

function addPlanBackendColumnValue(values, columns, column, value) {
  if (columns.has(column)) values.push([column, value]);
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

  const sourceByIntakeType = {
    requirement: LINKED_INTAKE_COMPLETION_SOURCES[0],
    feedback: LINKED_INTAKE_COMPLETION_SOURCES[1],
  };
  const readyBySource = Object.fromEntries(
    LINKED_INTAKE_COMPLETION_SOURCES.map((source) => [source.countKey, []]),
  );
  const linkedSources = intakePlanLinks.getIntakesForPlan(service, projectId, requestedPlanId);
  for (const linkedSource of linkedSources) {
    const source = sourceByIntakeType[linkedSource.intakeType];
    if (!source?.table || !linkedSource.intakeId) continue;
    const intake = service.db.get(
      `SELECT id FROM ${source.table}
       WHERE project_id = ?
         AND id = ?
         AND (status IS NULL OR LOWER(TRIM(status)) NOT IN (?, ?))`,
      [projectId, linkedSource.intakeId, ...LINKED_INTAKE_TERMINAL_STATUSES],
    );
    if (!intake) continue;

    const linkedPlans = intakePlanLinks.getPlansForIntake(
      service,
      projectId,
      linkedSource.intakeType,
      linkedSource.intakeId,
    );
    const allLinkedPlansCompleted = linkedPlans.length > 0 && linkedPlans.every(
      (linkedPlan) => String(linkedPlan.plan?.status || '').toLowerCase() === 'completed',
    );
    if (allLinkedPlansCompleted) readyBySource[source.countKey].push({ id: linkedSource.intakeId });
  }

  const completionSummary = {};
  for (const source of LINKED_INTAKE_COMPLETION_SOURCES) {
    const rows = readyBySource[source.countKey] || [];
    completionSummary[source.countKey] = rows.length;
    completionSummary[source.idsKey] = rows.map((row) => Number(row.id));
  }
  const result = linkedIntakeCompletionResult(requestedPlanId, projectId, completionSummary);
  if (result.total === 0) return result;

  const updatedAt = nowIso();
  result.updatedAt = updatedAt;
  const statements = [];
  for (const source of LINKED_INTAKE_COMPLETION_SOURCES) {
    const ids = completionSummary[source.idsKey] || [];
    if (!ids.length) continue;
    statements.push({
      sql: `UPDATE ${source.table}
            SET status = ?, updated_at = ?
            WHERE project_id = ?
              AND id IN (${ids.map(() => '?').join(', ')})
              AND (status IS NULL OR LOWER(TRIM(status)) NOT IN (?, ?))`,
      params: [
        LINKED_INTAKE_COMPLETED_STATUS,
        updatedAt,
        projectId,
        ...ids,
        ...LINKED_INTAKE_TERMINAL_STATUSES,
      ],
    });
  }
  statements.push({
    sql: 'INSERT INTO events (project_id, type, message, meta, created_at) VALUES (?, ?, ?, ?, ?)',
    params: [
      projectId,
      'plan.linked_intakes.completed',
      `关联需求/反馈已标记完成：需求 ${result.requirements} 条，反馈 ${result.feedback} 条`,
      JSON.stringify(result),
      updatedAt,
    ],
  });
  service.db.runBatch(statements);
  service.emitUpdate(projectId);
  return result;
}

module.exports = {
  hasPlanForIssueHash,
  nextRunnablePlan,
  nextPlanSortOrder,
  activateDraftPlan,
  interruptPlan,
  resumePlan,
  stopPlan,
  linkedPlansForIntake,
  interruptPlansForIntake,
  resumePlansForIntake,
  appendTaskToIntakePlan,
  reorderPlans,
  insertPlan,
  completeLinkedIntakesForPlan,
  linkedIntakeCompletionResult,
  LINKED_INTAKE_COMPLETED_STATUS,
  LINKED_INTAKE_TERMINAL_STATUSES,
  LINKED_INTAKE_COMPLETION_SOURCES,
};
