const fs = require('node:fs');
const { TASK_EVENT_STATUS } = require('./taskEvents');
const { normalizeTaskScope, taskDeclaredScopes } = require('./planParser');
const { resolveWorkspaceChildPath } = require('./workspaceFiles');

const MAX_PARALLEL_TASKS = 2;
const SPECIAL_TASK_SCOPES = new Set(['unknown', 'validation']);
const ACCEPTANCE_TASK_RE = /(\u5b8c\u6574\u9a8c\u6536|\u6574\u4f53\u9a8c\u6536|\u603b\u4f53\u9a8c\u6536|\u6700\u7ec8\u9a8c\u6536|\u5b8c\u6574\u9a8c\u8bc1|\u6700\u7ec8\u9a8c\u8bc1|acceptance|validation)/i;
const PARALLEL_BLOCKING_TASK_RE = /(\u5168\u91cf|\u56de\u5f52|\u9a8c\u8bc1|\u9a8c\u6536|\u6d4b\u8bd5|\u8bb0\u5f55|\u6574\u7406|\u53d1\u5e03|\u90e8\u7f72|test|validate|regression|release|deploy)/i;

function validatedParallelTaskBatches(service, workspace, plan, confirmedBatches) {
  const batches = normalizeConfirmedTaskBatches(confirmedBatches);
  if (!batches.length) throw new Error('\u672a\u9009\u62e9\u5e76\u53d1\u4efb\u52a1\u6279\u6b21');
  const seenTaskIds = new Set();
  return batches.map((batchTaskIds, batchIndex) => {
    if (batchTaskIds.length < 2) throw new Error(`\u7b2c ${batchIndex + 1} \u6279\u81f3\u5c11\u9700\u8981 2 \u4e2a\u4efb\u52a1`);
    if (batchTaskIds.length > MAX_PARALLEL_TASKS) {
      throw new Error(`\u7b2c ${batchIndex + 1} \u6279\u8d85\u8fc7\u6700\u5927\u5e76\u53d1\u6570 ${MAX_PARALLEL_TASKS}`);
    }
    const scopeSet = new Set();
    return batchTaskIds.map((taskId) => {
      if (seenTaskIds.has(taskId)) throw new Error(`\u4efb\u52a1 #${taskId} \u88ab\u91cd\u590d\u9009\u62e9`);
      seenTaskIds.add(taskId);
      const task = service.taskForProject(plan.project_id, taskId);
      if (!task || Number(task.plan_id) !== Number(plan.id)) throw new Error(`\u4efb\u52a1 #${taskId} \u88ab\u91cd\u590d\u9009\u62e9??`);
      if (task.status !== TASK_EVENT_STATUS.PENDING) {
        throw new Error(`${task.task_key || `\u4efb\u52a1 #${task.id}`} \u4e0d\u662f\u5f85\u6267\u884c\u72b6\u6001`);
      }
      const scopes = taskParallelScopes(task);
      if (!scopes.length) throw new Error(`${task.task_key || `\u4efb\u52a1 #${task.id}`} \u7f3a\u5c11\u53ef\u5e76\u53d1 scope`);
      const analysis = taskConcurrencyAnalysis(workspace, task);
      if (!analysis.canRunInParallel) throw new Error(`${task.task_key || `\u4efb\u52a1 #${task.id}`} \u4e0d\u5efa\u8bae\u5e76\u53d1\uFF1A${analysis.reason}`);
      for (const scope of scopes) {
        if (scopeSet.has(scope)) throw new Error(`\u7b2c ${batchIndex + 1} \u6279\u5b58\u5728 scope \u51b2\u7a81\uFF1A${scope}`);
        scopeSet.add(scope);
      }
      return task;
    });
  });
}

function isAcceptanceTask(task) {
  if (!task) return false;
  const text = `${task.task_key || task.key || ''} ${task.title || ''} ${task.raw_line || task.rawLine || ''}`;
  return ACCEPTANCE_TASK_RE.test(text);
}

function taskScopeFileInfos(workspace, task) {
  const scopes = Array.from(new Set(taskDeclaredScopes(task, { keepUnknown: true, includePathFallback: false })));
  if (!scopes.length) return [taskScopeFileInfo(workspace, 'unknown')];
  return scopes.map((scope) => taskScopeFileInfo(workspace, scope));
}

function taskScopeFileInfo(workspace, scope) {
  const normalizedPath = normalizeTaskScope(scope, { keepUnknown: true });
  const special = SPECIAL_TASK_SCOPES.has(normalizedPath) ? normalizedPath : '';
  const result = {
    path: normalizedPath || 'unknown',
    exists: false,
    isDirectory: false,
    canOpen: false,
    isUnknown: special === 'unknown' || !normalizedPath,
    isValidation: special === 'validation',
    reason: '',
  };
  if (result.isUnknown) {
    result.reason = 'scope unknown，无法安全判断影响范围';
    return result;
  }
  if (result.isValidation) {
    result.reason = 'validation 任务需串行验收，不建议并发';
    return result;
  }
  const fullPath = resolveWorkspaceChildPath(workspace, normalizedPath);
  if (!fullPath) {
    result.reason = '路径不在工作区内，不能打开';
    return result;
  }
  try {
    const stat = fs.statSync(fullPath);
    result.exists = true;
    result.isDirectory = stat.isDirectory();
    result.canOpen = stat.isFile();
    result.reason = result.canOpen
      ? ''
      : result.isDirectory
        ? 'scope 指向目录，不能作为文件打开'
        : '文件不存在，后续任务可能会创建';
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
      result.reason = '文件不存在，后续任务可能会创建';
    } else {
      result.reason = error?.message || '无法读取文件状态';
    }
  }
  return result;
}

function planConcurrencySuggestion(workspace, tasks) {
  const candidates = [];
  const serialTasks = [];
  for (const task of tasks) {
    if (task.status !== TASK_EVENT_STATUS.PENDING) continue;
    const analysis = taskConcurrencyAnalysis(workspace, task);
    if (analysis.canRunInParallel) {
      candidates.push({ task, analysis });
    } else {
      serialTasks.push(concurrencyTaskSummary(task, analysis.reason, analysis.scopes));
    }
  }

  const batches = [];
  for (const entry of candidates) {
    let placed = false;
    for (const batch of batches) {
      if (batch.tasks.length >= MAX_PARALLEL_TASKS) continue;
      if (entry.analysis.scopes.some((scope) => batch.scopeSet.has(scope))) continue;
      batch.tasks.push(concurrencyTaskSummary(entry.task, 'scope 无交集，可与本批任务并发', entry.analysis.scopes));
      for (const scope of entry.analysis.scopes) batch.scopeSet.add(scope);
      placed = true;
      break;
    }
    if (!placed) {
      batches.push({
        reason: '批次内任务 scope 互不重叠，可安全并发',
        scopeSet: new Set(entry.analysis.scopes),
        tasks: [concurrencyTaskSummary(entry.task, 'scope 无交集，可与本批任务并发', entry.analysis.scopes)],
      });
    }
  }

  const safeBatches = batches
    .filter((batch) => batch.tasks.length > 1)
    .map((batch, index) => ({
      batch: index + 1,
      reason: batch.reason,
      tasks: batch.tasks,
    }));
  const singleCandidateTasks = batches
    .filter((batch) => batch.tasks.length <= 1)
    .flatMap((batch) => batch.tasks)
    .map((task) => ({ ...task, reason: '没有可配对的无冲突任务，建议串行执行' }));

  return {
    hasSafeParallelBatches: safeBatches.length > 0,
    parallelTaskCount: safeBatches.reduce((sum, batch) => sum + batch.tasks.length, 0),
    batchCount: safeBatches.length,
    serialTaskCount: serialTasks.length + singleCandidateTasks.length,
    maxParallelTasks: MAX_PARALLEL_TASKS,
    batches: safeBatches,
    serialTasks: [...serialTasks, ...singleCandidateTasks],
  };
}

function taskConcurrencyAnalysis(workspace, task) {
  const scopeFiles = taskScopeFileInfos(workspace, task);
  const scopes = scopeFiles
    .filter((file) => !file.isUnknown && !file.isValidation)
    .map((file) => file.path);
  if (isAcceptanceTask(task) || scopeFiles.some((file) => file.isValidation)) {
    return { canRunInParallel: false, scopes, reason: 'validation/验收任务必须串行执行' };
  }
  if (scopeFiles.some((file) => file.isUnknown)) {
    return { canRunInParallel: false, scopes, reason: 'scope unknown，无法判断冲突' };
  }
  if (!scopes.length) {
    return { canRunInParallel: false, scopes, reason: 'scope 为空或无法解析，无法判断冲突' };
  }
  if (PARALLEL_BLOCKING_TASK_RE.test(`${task.task_key || ''} ${task.title || ''} ${task.raw_line || ''}`)) {
    return { canRunInParallel: false, scopes, reason: '任务标题包含测试/验收/发布等串行关键词' };
  }
  return { canRunInParallel: true, scopes, reason: 'scope 明确且可用于冲突检测' };
}

function concurrencyTaskSummary(task, reason, scopes = []) {
  return {
    id: task.id,
    task_key: task.task_key,
    title: task.title,
    status: task.status,
    scopes: Array.from(new Set(scopes)),
    reason,
  };
}

function emptyConcurrencySuggestion() {
  return {
    hasSafeParallelBatches: false,
    parallelTaskCount: 0,
    batchCount: 0,
    serialTaskCount: 0,
    maxParallelTasks: MAX_PARALLEL_TASKS,
    batches: [],
    serialTasks: [],
  };
}

function normalizeConfirmedTaskBatches(value) {
  if (!Array.isArray(value)) return [];
  const batches = [];
  for (const batch of value) {
    const rawTaskIds = Array.isArray(batch)
      ? batch
      : Array.isArray(batch?.taskIds)
        ? batch.taskIds
        : Array.isArray(batch?.tasks)
          ? batch.tasks.map((task) => task?.id ?? task)
          : [];
    const taskIds = Array.from(new Set(rawTaskIds.map((taskId) => Number(taskId)).filter(Boolean)));
    if (taskIds.length) batches.push(taskIds);
  }
  return batches;
}

function taskParallelScopes(task) {
  const raw = `${task.task_key || ''} ${task.title || ''} ${task.raw_line || ''}`;
  if (PARALLEL_BLOCKING_TASK_RE.test(raw)) return [];
  return taskDeclaredScopes(task, { keepUnknown: false });
}

module.exports = {
  MAX_PARALLEL_TASKS,
  concurrencyTaskSummary,
  emptyConcurrencySuggestion,
  isAcceptanceTask,
  normalizeConfirmedTaskBatches,
  planConcurrencySuggestion,
  taskConcurrencyAnalysis,
  taskParallelScopes,
  taskScopeFileInfo,
  taskScopeFileInfos,
  validatedParallelTaskBatches,
};
