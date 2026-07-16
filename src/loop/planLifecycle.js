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
const TASK_REDO_COMPLETED_STATUSES = Object.freeze(['completed', 'done', 'passed']);
const PLAN_AUTO_RUNNABLE_STATUSES = Object.freeze(['pending', PLAN_RUNNING_STATUS, 'ready_for_validation']);
const PLAN_EXECUTION_CONFIG_SYNC_STATUSES = Object.freeze([
  'pending',
  PLAN_RUNNING_STATUS,
  'ready_for_validation',
  PLAN_INTERRUPTED_STATUS,
  'stopped',
  'validation_failed',
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
  const placeholders = PLAN_AUTO_RUNNABLE_STATUSES.map(() => '?').join(', ');
  return service.db.get(
    `SELECT * FROM plans
     WHERE project_id = ?
       AND LOWER(TRIM(COALESCE(status, ''))) IN (${placeholders})
     ORDER BY sort_order ASC, created_at ASC, id ASC
     LIMIT 1`,
    [projectId, ...PLAN_AUTO_RUNNABLE_STATUSES],
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

function hasActiveTaskOperation(service, projectId, taskId) {
  const runtime = typeof service.existingRuntime === 'function' ? service.existingRuntime(projectId) : null;
  if (!runtime?.activeOperations) return false;
  for (const operation of runtime.activeOperations.values()) {
    if (Number(operation?.taskId) === Number(taskId)) return true;
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
  const status = String(plan.status || '').toLowerCase();
  const resumableTaskStatuses = status === 'validation_failed'
    ? ['blocked', TASK_EVENT_STATUS.FAILED]
    : ['blocked'];
  const resumableTaskStatusPlaceholders = resumableTaskStatuses.map(() => '?').join(', ');
  const resumedTaskCount = Number(
    service.db.get(
      `SELECT COUNT(*) AS count
       FROM plan_tasks
       WHERE plan_id = ?
         AND status IN (${resumableTaskStatusPlaceholders})`,
      [plan.id, ...resumableTaskStatuses],
    )?.count || 0,
  );
  service.db.runBatch([
    {
      sql: `UPDATE plan_tasks SET status = ?, updated_at = ?
            WHERE plan_id = ?
              AND status IN (${resumableTaskStatusPlaceholders})`,
      params: ['pending', updatedAt, plan.id, ...resumableTaskStatuses],
    },
    {
      sql: 'UPDATE plans SET status = ?, validation_passed = 0, updated_at = ? WHERE id = ? AND project_id = ?',
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
        resumedTasks: resumedTaskCount,
      },
    );
  }
  service.emitUpdate(normalizedProjectId);
  return service.db.get('SELECT * FROM plans WHERE id = ? AND project_id = ?', [plan.id, normalizedProjectId]);
}

function reExecutePlan(service, projectId, planId, options = {}) {
  const normalizedProjectId = Number(projectId || 0);
  const normalizedPlanId = Number(planId || 0);
  const plan = options.throwIfMissing
    ? planForProject(service, normalizedProjectId, normalizedPlanId)
    : findPlanForProject(service, normalizedProjectId, normalizedPlanId);
  if (!plan) return null;

  if (!isCompletedPlan(plan)) {
    throw new Error('仅可重新执行已完成的计划');
  }

  const updatedAt = options.updatedAt || nowIso();
  const status = options.status || 'pending';
  const completedTaskCount = Number(
    service.db.get(
      'SELECT COUNT(*) AS count FROM plan_tasks WHERE plan_id = ? AND status = ?',
      [plan.id, 'completed'],
    )?.count || 0,
  );
  service.db.runBatch([
    {
      sql: `UPDATE plan_tasks SET status = ?, updated_at = ?
            WHERE plan_id = ? AND status = ?`,
      params: [status, updatedAt, plan.id, 'completed'],
    },
    {
      sql: `UPDATE plans
            SET status = ?,
                validation_passed = 0,
                accepted_at = CASE WHEN ? THEN NULL ELSE accepted_at END,
                updated_at = ?
            WHERE id = ? AND project_id = ?`,
      params: [status, options.clearAcceptedAt ? 1 : 0, updatedAt, plan.id, normalizedProjectId],
    },
  ]);
  if (!options.suppressEvent) {
    service.addEvent(
      normalizedProjectId,
      options.eventType || 'plan.reexecuted',
      options.eventMessage || `计划 #${plan.id} 已重新激活执行`,
      {
        planId: plan.id,
        previousStatus: plan.status,
        status,
        resetTasks: completedTaskCount,
        ...(options.eventMeta || {}),
      },
      options.suppressEmit ? { suppressUpdate: true } : undefined,
    );
  }
  if (!options.suppressEmit) service.emitUpdate(normalizedProjectId);
  return service.db.get('SELECT * FROM plans WHERE id = ? AND project_id = ?', [plan.id, normalizedProjectId]);
}

function redoTask(service, projectId, taskId, options = {}) {
  const normalizedProjectId = Number(projectId || 0);
  const normalizedTaskId = Number(taskId || 0);
  if (!normalizedProjectId || !service.project(normalizedProjectId)) throw new Error('项目不存在');
  if (!normalizedTaskId) throw new Error('任务不存在');
  const task = service.db.get(
    `SELECT plan_tasks.*, plans.status AS plan_status, plans.accepted_at AS plan_accepted_at
     FROM plan_tasks JOIN plans ON plans.id = plan_tasks.plan_id
     WHERE plan_tasks.id = ? AND plans.project_id = ?`,
    [normalizedTaskId, normalizedProjectId],
  );
  if (!task) throw new Error('任务不存在');

  const plan = { id: task.plan_id, project_id: normalizedProjectId, status: task.plan_status };
  if (isPlanRunning(service, normalizedProjectId, plan) || hasActiveTaskOperation(service, normalizedProjectId, task.id)) {
    throw new Error('任务正在运行中，不能重做');
  }

  const taskStatus = String(task.status || '').toLowerCase();
  if (!TASK_REDO_COMPLETED_STATUSES.includes(taskStatus) && !task.accepted_at) {
    throw new Error('仅可重做已完成或已验收的计划/任务');
  }

  const updatedAt = options.updatedAt || nowIso();
  service.db.runBatch([
    {
      sql: `UPDATE plan_tasks
            SET status = ?,
                accepted_at = NULL,
                updated_at = ?
            WHERE id = ?`,
      params: ['pending', updatedAt, task.id],
    },
    {
      sql: `UPDATE plans
            SET status = ?,
                validation_passed = 0,
                accepted_at = NULL,
                updated_at = ?
            WHERE id = ? AND project_id = ?`,
      params: ['pending', updatedAt, task.plan_id, normalizedProjectId],
    },
  ]);
  if (!options.suppressEvent) {
    service.addEvent(
      normalizedProjectId,
      options.eventType || 'task.redo',
      options.eventMessage || `${task.task_key} 已退回重做`,
      {
        targetType: 'task',
        id: task.id,
        taskId: task.id,
        planId: task.plan_id,
        taskKey: task.task_key,
        previousStatus: task.status,
        previousPlanStatus: task.plan_status,
        status: 'pending',
        ...(options.eventMeta || {}),
      },
      options.suppressEmit ? { suppressUpdate: true } : undefined,
    );
  }
  if (!options.suppressEmit) service.emitUpdate(normalizedProjectId);
  return service.db.get('SELECT * FROM plan_tasks WHERE id = ?', [task.id]);
}

async function recreatePlanFromIntake(service, projectId, planId, options = {}) {
  const normalizedProjectId = Number(projectId || 0);
  const normalizedPlanId = Number(planId || 0);
  const plan = options.throwIfMissing
    ? planForProject(service, normalizedProjectId, normalizedPlanId)
    : findPlanForProject(service, normalizedProjectId, normalizedPlanId);
  if (!plan) return null;

  if (!isCompletedPlan(plan)) {
    throw new Error('仅可基于已完成的计划重新创建');
  }

  const intakeLink = intakePlanLinks.getIntakeForPlan(service, normalizedProjectId, normalizedPlanId, {
    includeLegacyFallback: true,
  });
  if (!intakeLink || !intakeLink.intakeId) {
    throw new Error('计划未关联需求/反馈，无法重新创建');
  }

  const intakeType = intakeLink.intakeType;
  const table = intakeType === 'feedback' ? 'feedback' : 'requirements';
  const intake = service.db.get(
    `SELECT * FROM ${table} WHERE id = ? AND project_id = ?`,
    [intakeLink.intakeId, normalizedProjectId],
  );
  if (!intake) throw new Error('关联的需求/反馈不存在');

  const workspace = service.project(normalizedProjectId)?.workspace_path;
  if (!workspace) throw new Error('请先设置项目工作区路径');

  const newPlanId = await service.generatePlanForIntake(
    normalizedProjectId,
    workspace,
    { ...intake, __type: intakeType },
  );

  if (newPlanId) {
    service.addEvent(
      normalizedProjectId,
      options.eventType || 'plan.recreated',
      options.eventMessage || `计划 #${plan.id} 已重新创建为计划 #${newPlanId}`,
      {
        previousPlanId: plan.id,
        planId: newPlanId,
        intakeType,
        intakeId: intakeLink.intakeId,
      },
    );
  }

  service.emitUpdate(normalizedProjectId);
  return newPlanId;
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
  const nonCompleted = plans.find((link) => !PLAN_COMPLETED_STATUSES.includes(String(link.plan?.status || '').toLowerCase()));
  const target = nonCompleted || plans[plans.length - 1];
  const allCompleted = !nonCompleted;

  // 所有关联计划均已完成时，自动重新激活最后一个计划再追加任务
  let reExecuted = false;
  if (allCompleted && target.planId) {
    reExecutePlan(service, normalizedProjectId, target.planId, { suppressEvent: false });
    reExecuted = true;
  }

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
    reExecuted: reExecuted || undefined,
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
  planGenerationDurationMs,
  plan_generation_duration_ms: planGenerationDurationMsSnake,
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
  const planColumns = service.planColumns();
  const normalizedPlanGenerationDurationMs = normalizePlanGenerationDurationMs(
    planGenerationDurationMs ?? planGenerationDurationMsSnake,
  );
  if (planColumns.has('plan_generation_duration_ms') && normalizedPlanGenerationDurationMs != null) {
    columns.push('plan_generation_duration_ms');
    values.push(normalizedPlanGenerationDurationMs);
  }
  for (const [column, value] of planAgentCliColumnValues(planColumns, agentCliConfig)) {
    columns.push(column);
    values.push(value);
  }
  for (const [column, value] of planBackendColumnValues(planColumns, 'plan_generation', planGenerationConfig)) {
    columns.push(column);
    values.push(value);
  }
  for (const [column, value] of planBackendColumnValues(planColumns, 'plan_execution', planExecutionConfig)) {
    columns.push(column);
    values.push(value);
  }
  return service.db.insert(
    `INSERT INTO plans (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
    values,
  );
}

function normalizePlanGenerationDurationMs(value) {
  if (value == null || value === '') return null;
  const duration = Number(value);
  if (!Number.isFinite(duration)) return 0;
  return Math.max(0, Math.floor(duration));
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

function updatePlanExecutionConfig(service, projectId, planId, input = {}) {
  const normalizedProjectId = Number(projectId || 0);
  const normalizedPlanId = Number(planId || 0);
  const plan = planForProject(service, normalizedProjectId, normalizedPlanId);

  if (isCompletedPlan(plan)) {
    throw new Error('已完成计划不允许修改执行配置');
  }

  const config = planBackendConfig.planExecutionConfigFields({
    strategy: input.strategy ?? input.planExecutionStrategy ?? plan.plan_execution_strategy,
    provider: input.provider ?? input.planExecutionProvider ?? plan.plan_execution_provider,
    command: input.command ?? input.planExecutionCommand ?? plan.plan_execution_command,
    model: input.model ?? input.planExecutionModel ?? plan.plan_execution_model,
    codexReasoningEffort: input.codexReasoningEffort ?? input.planExecutionCodexReasoningEffort ?? plan.plan_execution_codex_reasoning_effort,
    claudeBaseUrl: input.claudeBaseUrl ?? input.planExecutionClaudeBaseUrl ?? plan.plan_execution_claude_base_url,
    claudeAuthToken: input.claudeAuthToken ?? input.planExecutionClaudeAuthToken ?? plan.plan_execution_claude_auth_token,
    claudeModel: input.claudeModel ?? input.planExecutionClaudeModel ?? plan.plan_execution_claude_model,
    claudeConfigId: input.claudeConfigId ?? input.planExecutionClaudeConfigId ?? plan.plan_execution_claude_config_id,
  });

  const columns = service.planColumns();
  const updatedAt = nowIso();
  const updates = [];

  addPlanBackendColumnValue(updates, columns, 'plan_execution_strategy', config.strategy);
  addPlanBackendColumnValue(updates, columns, 'plan_execution_provider', config.provider);
  addPlanBackendColumnValue(updates, columns, 'plan_execution_command', config.command || '');
  addPlanBackendColumnValue(updates, columns, 'plan_execution_model', config.model || '');
  addPlanBackendColumnValue(updates, columns, 'plan_execution_codex_reasoning_effort', config.codexReasoningEffort || null);
  addPlanBackendColumnValue(updates, columns, 'plan_execution_claude_base_url', config.claudeBaseUrl || '');
  addPlanBackendColumnValue(updates, columns, 'plan_execution_claude_auth_token', config.claudeAuthToken || '');
  addPlanBackendColumnValue(updates, columns, 'plan_execution_claude_model', config.claudeModel || '');
  addPlanBackendColumnValue(updates, columns, 'plan_execution_claude_config_id', config.claudeConfigId || 0);

  if (updates.length === 0) return plan;

  updates.push(['updated_at', updatedAt]);

  service.db.run(
    `UPDATE plans SET ${updates.map(([col]) => `${col} = ?`).join(', ')} WHERE id = ? AND project_id = ?`,
    [...updates.map(([, val]) => val), normalizedPlanId, normalizedProjectId],
  );

  // provider 变更时清除 plan 级 agent_cli_session_id，避免跨后端 session 污染
  // （如 opencode → codex → opencode 的来回切换导致旧 opencode session 被沿用）
  const previousProvider = String(plan.plan_execution_provider || '').toLowerCase();
  const nextProvider = String(config.provider || '').toLowerCase();
  const providerChanged = nextProvider && previousProvider !== nextProvider;
  const sessionCleared = providerChanged && columns.has('agent_cli_session_id')
    && Boolean(plan.agent_cli_session_id);
  if (sessionCleared) {
    service.db.run(
      'UPDATE plans SET agent_cli_session_id = NULL, updated_at = ? WHERE id = ? AND project_id = ?',
      [updatedAt, normalizedPlanId, normalizedProjectId],
    );
  }

  service.addEvent(
    normalizedProjectId,
    'plan.execution_config.updated',
    `计划 #${plan.id} 执行配置已更新`,
    {
      planId: plan.id,
      previousProvider: plan.plan_execution_provider || '',
      previousCommand: plan.plan_execution_command || '',
      previousCodexReasoningEffort: plan.plan_execution_codex_reasoning_effort || null,
      provider: config.provider || '',
      command: config.command || '',
      codexReasoningEffort: config.codexReasoningEffort || null,
      previousAgentCliSessionId: sessionCleared ? (plan.agent_cli_session_id || '') : undefined,
      agentCliSessionCleared: sessionCleared || undefined,
    },
  );

  service.emitUpdate(normalizedProjectId);
  return service.db.get('SELECT * FROM plans WHERE id = ? AND project_id = ?', [normalizedPlanId, normalizedProjectId]);
}


function syncUnfinishedPlanExecutionCodexReasoningEffort(service, projectId, config = {}) {
  const normalizedProjectId = Number(projectId || 0);
  if (!normalizedProjectId) return;
  const columns = service.planColumns();
  if (!columns.has('plan_execution_codex_reasoning_effort')) return;

  const normalized = planBackendConfig.planExecutionConfigFields({
    strategy: config.strategy ?? config.planExecutionStrategy,
    provider: config.provider ?? config.planExecutionProvider,
    command: config.command ?? config.planExecutionCommand,
    model: config.model ?? config.planExecutionModel,
    codexReasoningEffort: config.codexReasoningEffort ?? config.planExecutionCodexReasoningEffort,
  });
  const nextCodexReasoningEffort = normalized.codexReasoningEffort || null;
  const updatedAt = nowIso();
  const statusPlaceholders = PLAN_EXECUTION_CONFIG_SYNC_STATUSES.map(() => '?').join(', ');
  const statusCondition = `LOWER(TRIM(COALESCE(status, ''))) IN (${statusPlaceholders})`;
  const statusParams = [...PLAN_EXECUTION_CONFIG_SYNC_STATUSES];

  if (!nextCodexReasoningEffort) {
    service.db.run(
      `UPDATE plans
       SET plan_execution_codex_reasoning_effort = NULL, updated_at = ?
       WHERE project_id = ?
         AND ${statusCondition}
         AND plan_execution_codex_reasoning_effort IS NOT NULL`,
      [updatedAt, normalizedProjectId, ...statusParams],
    );
    return;
  }

  if (!columns.has('plan_execution_provider')) {
    service.db.run(
      `UPDATE plans
       SET plan_execution_codex_reasoning_effort = ?, updated_at = ?
       WHERE project_id = ?
         AND ${statusCondition}
         AND COALESCE(plan_execution_codex_reasoning_effort, '') != ?`,
      [nextCodexReasoningEffort, updatedAt, normalizedProjectId, ...statusParams, nextCodexReasoningEffort],
    );
    return;
  }

  service.db.run(
    `UPDATE plans
     SET plan_execution_codex_reasoning_effort = ?, updated_at = ?
     WHERE project_id = ?
       AND ${statusCondition}
       AND LOWER(TRIM(COALESCE(plan_execution_provider, ''))) IN ('', ?)
       AND COALESCE(plan_execution_codex_reasoning_effort, '') != ?`,
    [nextCodexReasoningEffort, updatedAt, normalizedProjectId, ...statusParams, 'codex', nextCodexReasoningEffort],
  );
  service.db.run(
    `UPDATE plans
     SET plan_execution_codex_reasoning_effort = NULL, updated_at = ?
     WHERE project_id = ?
       AND ${statusCondition}
       AND LOWER(TRIM(COALESCE(plan_execution_provider, ''))) NOT IN ('', ?)
       AND plan_execution_codex_reasoning_effort IS NOT NULL`,
    [updatedAt, normalizedProjectId, ...statusParams, 'codex'],
  );
}

module.exports = {
  hasPlanForIssueHash,
  nextRunnablePlan,
  nextPlanSortOrder,
  activateDraftPlan,
  interruptPlan,
  resumePlan,
  reExecutePlan,
  redoTask,
  recreatePlanFromIntake,
  stopPlan,
  updatePlanExecutionConfig,
  syncUnfinishedPlanExecutionCodexReasoningEffort,
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
