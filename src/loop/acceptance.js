const { nowIso } = require('../database');
const planLifecycle = require('./planLifecycle');

// 人工验收态与执行态正交：只允许对「已完成」项验收（计划 status='completed'、任务 status ∈ 已完成集合），
// 与渲染层 matchesTaskStatusFilter 的「已完成」语义一致，不新增 status 取值。
const ACCEPTABLE_PLAN_STATUS = 'completed';
const ACCEPTABLE_TASK_STATUSES = Object.freeze(['completed', 'done', 'passed']);
const REDO_SUPPLEMENT_MAX_LENGTH = 2000;

/** 单项人工验收：对已完成的计划/任务置 accepted_at（不改变执行态 status），并记事件；重复验收覆盖时间戳。 */
function acceptItem(service, projectId, { targetType, id } = {}) {
  const target = acceptanceTargetRow(service, projectId, targetType, id);
  const acceptedAt = nowIso();
  const result = writeAcceptance(service, targetType, target, acceptedAt, projectId);
  service.emitUpdate(projectId);
  return result;
}

/** 取消人工验收：清空 accepted_at（NULL），不改变执行态 status，并记事件；重复取消保持 NULL 不报错。 */
function unacceptItem(service, projectId, { targetType, id } = {}) {
  const target = acceptanceTargetRow(service, projectId, targetType, id, { requireCompleted: false });
  const updatedAt = nowIso();
  const result = writeAcceptance(service, targetType, target, null, projectId, updatedAt);
  service.emitUpdate(projectId);
  return result;
}

/** 验收重做：清理人工验收态，将已完成/已验收目标退回 pending，并记录 plan.redo/task.redo 事件。 */
function redoAcceptanceItem(service, projectId, { targetType, id, supplement } = {}) {
  const target = acceptanceTargetRow(service, projectId, targetType, id, { requireCompleted: false });
  const normalizedSupplement = normalizeRedoSupplement(supplement);
  ensureRedoTargetAllowed(service, projectId, targetType, target);
  const updatedAt = nowIso();

  if (targetType === 'plan') {
    const updated = planLifecycle.reExecutePlan(service, projectId, target.id, {
      updatedAt,
      clearAcceptedAt: true,
      eventType: 'plan.redo',
      eventMessage: `plan #${target.id} 已退回重做`,
      eventMeta: {
        targetType: 'plan',
        id: target.id,
        planId: target.id,
        taskId: null,
        previousStatus: target.status,
        previousAcceptedAt: target.accepted_at || null,
        previousValidationPassed: Number(target.validation_passed || 0),
        supplement: normalizedSupplement,
      },
    });
    return {
      targetType: 'plan',
      id: target.id,
      planId: target.id,
      status: updated?.status || 'pending',
      accepted_at: updated?.accepted_at ?? null,
      supplement: normalizedSupplement,
    };
  }

  const updated = planLifecycle.redoTask(service, projectId, target.id, {
    updatedAt,
    eventType: 'task.redo',
    eventMessage: `${target.task_key} 已退回重做`,
    eventMeta: {
      supplement: normalizedSupplement,
      previousAcceptedAt: target.accepted_at || null,
    },
  });
  return {
    targetType: 'task',
    id: target.id,
    taskId: target.id,
    planId: target.plan_id,
    status: updated?.status || 'pending',
    accepted_at: updated?.accepted_at ?? null,
    supplement: normalizedSupplement,
  };
}

/** 校验收目标：按 targetType 路由 plan/task、校验归属当前项目与「已完成」态；不存在或不可验收时抛中文错误。 */
function acceptanceTargetRow(service, projectId, targetType, id, options = {}) {
  const normalizedId = Number(id);
  if (!Number.isFinite(normalizedId) || normalizedId <= 0) throw new Error('验收目标 ID 无效');
  const requireCompleted = options.requireCompleted !== false;
  if (targetType === 'plan') {
    const plan = service.db.get('SELECT * FROM plans WHERE id = ? AND project_id = ?', [normalizedId, projectId]);
    if (!plan) throw new Error('计划不存在');
    if (requireCompleted && plan.status !== ACCEPTABLE_PLAN_STATUS) {
      throw new Error('仅可验收已完成的计划/任务');
    }
    return plan;
  }
  if (targetType === 'task') {
    const task = service.db.get(
      `SELECT plan_tasks.*
       FROM plan_tasks JOIN plans ON plans.id = plan_tasks.plan_id
       WHERE plan_tasks.id = ? AND plans.project_id = ?`,
      [normalizedId, projectId],
    );
    if (!task) throw new Error('任务不存在');
    if (requireCompleted && !ACCEPTABLE_TASK_STATUSES.includes(task.status)) {
      throw new Error('仅可验收已完成的计划/任务');
    }
    return task;
  }
  throw new Error('验收目标类型无效');
}

function ensureRedoTargetAllowed(service, projectId, targetType, target) {
  if (targetType === 'plan') {
    if (isPlanRedoTargetRunning(service, projectId, target.id, target.status)) {
      throw new Error('计划正在运行中，不能重做');
    }
    if (target.status !== ACCEPTABLE_PLAN_STATUS && !target.accepted_at) {
      throw new Error('仅可重做已完成或已验收的计划/任务');
    }
    if (target.status !== ACCEPTABLE_PLAN_STATUS) {
      throw new Error('仅可重做已完成或已验收的计划/任务');
    }
    return;
  }

  if (isTaskRedoTargetRunning(service, projectId, target)) {
    throw new Error('任务正在运行中，不能重做');
  }
  if (!ACCEPTABLE_TASK_STATUSES.includes(target.status) && !target.accepted_at) {
    throw new Error('仅可重做已完成或已验收的计划/任务');
  }
}

function isPlanRedoTargetRunning(service, projectId, planId, status) {
  if (String(status || '') === 'running') return true;
  if (service.db.get('SELECT 1 FROM plan_tasks WHERE plan_id = ? AND status = ? LIMIT 1', [planId, 'running'])) {
    return true;
  }
  return hasActiveOperation(service, projectId, (operation) => Number(operation?.planId) === Number(planId));
}

function isTaskRedoTargetRunning(service, projectId, task) {
  if (String(task?.status || '') === 'running') return true;
  const plan = service.db.get('SELECT status FROM plans WHERE id = ? AND project_id = ?', [task.plan_id, projectId]);
  if (String(plan?.status || '') === 'running') return true;
  return hasActiveOperation(service, projectId, (operation) =>
    Number(operation?.taskId) === Number(task.id) || Number(operation?.planId) === Number(task.plan_id),
  );
}

function hasActiveOperation(service, projectId, predicate) {
  const runtime = typeof service.existingRuntime === 'function' ? service.existingRuntime(projectId) : null;
  if (!runtime?.activeOperations) return false;
  for (const operation of runtime.activeOperations.values()) {
    if (predicate(operation)) return true;
  }
  return false;
}

function normalizeRedoSupplement(value) {
  if (value == null) return '';
  const normalized = String(value).replace(/\r\n?/g, '\n').trim();
  if (!normalized) return '';
  return Array.from(normalized).slice(0, REDO_SUPPLEMENT_MAX_LENGTH).join('');
}

/**
 * 写入单条验收态的私有 helper（acceptItem/unacceptItem 与 acceptItems/unacceptItems 共用）。
 * 只置/清 accepted_at 并记事件，绝不执行脚本或任务——验收模块是纯人工确认，与
 * 「完整验收」任务经 runTask→validatePlan 执行 validation_command 的链路完全解耦。
 * acceptedAt 非空 → 验收（accepted_at=acceptedAt、updated_at=acceptedAt，记 *.accepted 事件）；
 * acceptedAt 为 null → 取消验收（accepted_at=NULL、updated_at=updatedAt，记 *.unaccepted 事件）。
 * 返回 { targetType, id, accepted_at }，供单目标/批量调用方回传。
 */
function writeAcceptance(service, targetType, row, acceptedAt, projectId, updatedAt = acceptedAt ?? nowIso()) {
  if (targetType === 'plan') {
    if (acceptedAt) {
      service.db.run(
        'UPDATE plans SET accepted_at = ?, updated_at = ? WHERE id = ? AND project_id = ?',
        [acceptedAt, acceptedAt, row.id, projectId],
      );
      service.addEvent(projectId, 'plan.accepted', `plan #${row.id} 已验收`, {
        targetType: 'plan',
        id: row.id,
        planId: row.id,
        accepted_at: acceptedAt,
      });
    } else {
      service.db.run(
        'UPDATE plans SET accepted_at = NULL, updated_at = ? WHERE id = ? AND project_id = ?',
        [updatedAt, row.id, projectId],
      );
      service.addEvent(projectId, 'plan.unaccepted', `plan #${row.id} 已取消验收`, {
        targetType: 'plan',
        id: row.id,
        planId: row.id,
        accepted_at: null,
      });
    }
    return { targetType, id: row.id, accepted_at: acceptedAt ?? null };
  }
  if (acceptedAt) {
    service.db.run(
      'UPDATE plan_tasks SET accepted_at = ?, updated_at = ? WHERE id = ?',
      [acceptedAt, acceptedAt, row.id],
    );
    service.addEvent(projectId, 'task.accepted', `${row.task_key} 已验收`, {
      targetType: 'task',
      id: row.id,
      taskId: row.id,
      planId: row.plan_id,
      taskKey: row.task_key,
      accepted_at: acceptedAt,
    });
  } else {
    service.db.run(
      'UPDATE plan_tasks SET accepted_at = NULL, updated_at = ? WHERE id = ?',
      [updatedAt, row.id],
    );
    service.addEvent(projectId, 'task.unaccepted', `${row.task_key} 已取消验收`, {
      targetType: 'task',
      id: row.id,
      taskId: row.id,
      planId: row.plan_id,
      taskKey: row.task_key,
      accepted_at: null,
    });
  }
  return { targetType, id: row.id, accepted_at: acceptedAt ?? null };
}

/**
 * 批量人工验收：对一组已完成的计划/任务一次性置 accepted_at（不改变执行态 status）。
 * 先全量预校验（acceptanceTargetRow，requireCompleted:true），任一目标非法即整体抛中文错误、
 * 不写任何行（全有或全无）；全部通过后用同一时间戳逐条 UPDATE+addEvent，最后一次 emitUpdate。
 * 纯人工确认：绝不调用 validatePlan/runShell/runCodex/executeTask/runOnce，不读/不执行 validation_command，不启动任何任务/脚本。
 */
function acceptItems(service, projectId, targets) {
  const normalized = normalizeAcceptanceTargets(targets, '批量验收目标列表为空');
  // 先全量预校验（全有或全无）：任一目标非法即整体抛错，在此之前不写任何行
  const rows = normalized.map(({ targetType, id }) => ({
    targetType,
    row: acceptanceTargetRow(service, projectId, targetType, id),
  }));
  // 全部校验通过 → 用同一时间戳逐条写入 + 记事件（不执行任何脚本/任务）
  const acceptedAt = nowIso();
  const items = rows.map(({ targetType, row }) =>
    writeAcceptance(service, targetType, row, acceptedAt, projectId),
  );
  service.emitUpdate(projectId);
  return { accepted: items.length, items };
}

/**
 * 批量取消人工验收：对一组计划/任务一次性清空 accepted_at（NULL），不改变执行态 status。
 * 先全量预校验（acceptanceTargetRow，requireCompleted:false），任一目标非法即整体抛中文错误、
 * 不写任何行；全部通过后用同一时间戳逐条 UPDATE+addEvent，最后一次 emitUpdate。
 * 纯人工确认：绝不调用 validatePlan/runShell/runCodex/executeTask/runOnce，不读/不执行 validation_command，不启动任何任务/脚本。
 */
function unacceptItems(service, projectId, targets) {
  const normalized = normalizeAcceptanceTargets(targets, '批量取消验收目标列表为空');
  // 先全量预校验（全有或全无）
  const rows = normalized.map(({ targetType, id }) => ({
    targetType,
    row: acceptanceTargetRow(service, projectId, targetType, id, { requireCompleted: false }),
  }));
  // 全部校验通过 → 用同一时间戳逐条写入 + 记事件
  const updatedAt = nowIso();
  const items = rows.map(({ targetType, row }) =>
    writeAcceptance(service, targetType, row, null, projectId, updatedAt),
  );
  service.emitUpdate(projectId);
  return { unaccepted: items.length, items };
}

/**
 * 规范化批量验收目标列表：非数组/元素非法抛「验收目标列表无效」；去重保序、Number(id)；
 * 空列表抛调用方指定的中文错误。targetType/id 的合法性交由 acceptanceTargetRow 复用既有校验。
 * 去重保序：同目标多次出现只处理一次（幂等，避免重复 UPDATE/事件）。
 */
function normalizeAcceptanceTargets(targets, emptyMessage) {
  if (!Array.isArray(targets)) throw new Error('验收目标列表无效');
  const seen = new Set();
  const normalized = [];
  for (const entry of targets) {
    if (!entry || typeof entry !== 'object') throw new Error('验收目标列表无效');
    const targetType = entry.targetType;
    const id = Number(entry.id);
    const key = `${targetType}:${id}`;
    if (seen.has(key)) continue; // 去重保序：同目标多次出现只处理一次
    seen.add(key);
    normalized.push({ targetType, id });
  }
  if (normalized.length === 0) throw new Error(emptyMessage);
  return normalized;
}

module.exports = {
  acceptItem,
  unacceptItem,
  redoAcceptanceItem,
  acceptanceTargetRow,
  writeAcceptance,
  acceptItems,
  unacceptItems,
  normalizeAcceptanceTargets,
  normalizeRedoSupplement,
  ACCEPTABLE_PLAN_STATUS,
  ACCEPTABLE_TASK_STATUSES,
  REDO_SUPPLEMENT_MAX_LENGTH,
};
