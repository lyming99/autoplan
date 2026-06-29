const fs = require('node:fs');
const { nowIso } = require('../database');
const { hashFile } = require('./workspaceFiles');
const { syncedTaskStatus, TASK_EVENT_STATUS } = require('./taskEvents');

const PLAN_TASK_LINE_RE = /^\uFEFF?\s*[-*+]\s+\[([ xX])\]\s+(.+?)\s*$/;
const PLAN_TASK_KEY_RE = /^([A-Za-z]+[-_]?\d+|P\d+)\s*(?::|：|[-–—]+|\.|．|、|\)|）|\s+)\s*(.*)$/;
const PLAN_TASK_SCOPE_LABEL_RE = '(?:scope|scopes|files?|影响范围|并发键)';
const PLAN_TASK_SCOPE_RE = new RegExp(`${PLAN_TASK_SCOPE_LABEL_RE}\\s*[:=：]\\s*([^>\\]\\n]+)`, 'i');
const PLAN_TASK_SCOPE_COMMENT_RE = new RegExp(`\\s*<!--\\s*${PLAN_TASK_SCOPE_LABEL_RE}\\s*[:=：]\\s*([^>]*?)\\s*-->\\s*`, 'i');
const PLAN_TASK_SCOPE_SPLIT_RE = /[,，、;；]+/;
const PLAN_TASK_PATH_RE = /[\w./\\-]+\.(?:dart|js|jsx|ts|tsx|css|scss|html|md|json|ya?ml)/gi;

function syncPlanTasksFromMarkdown(service, planId, planFile) {
  if (!fs.existsSync(planFile)) return;
  const text = fs.readFileSync(planFile, 'utf8');
  const parsedTasks = parsePlanTasksFromMarkdown(text);
  if (!parsedTasks.length) recordEmptyPlanTaskParse(service, planId, planFile, text);
  const { tasks, duplicateKeys } = uniquePlanTasksByKey(parsedTasks);
  if (duplicateKeys.length) recordDuplicatePlanTaskKeys(service, planId, planFile, duplicateKeys);
  const existingTasks = service.db.all('SELECT * FROM plan_tasks WHERE plan_id = ? ORDER BY sort_order ASC, id ASC', [planId]);
  const existingByKey = new Map();
  for (const existing of existingTasks) {
    const matches = existingByKey.get(existing.task_key) || [];
    matches.push(existing);
    existingByKey.set(existing.task_key, matches);
  }

  const syncedStatuses = [];
  for (const task of tasks) {
    const existing = existingByKey.get(task.key)?.shift();
    const status = existing ? syncedTaskStatus(task.status, existing.status) : task.status;
    syncedStatuses.push(status);
    if (existing) {
      service.db.run(
        `UPDATE plan_tasks
         SET title = ?, raw_line = ?, scope = ?, status = ?, sort_order = ?, updated_at = ?
         WHERE id = ?`,
        [task.title, task.rawLine, task.scope, status, task.sortOrder, nowIso(), existing.id],
      );
    } else {
      service.db.run(
        `INSERT INTO plan_tasks (plan_id, task_key, title, raw_line, scope, status, sort_order, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [planId, task.key, task.title, task.rawLine, task.scope, status, task.sortOrder, nowIso()],
      );
    }
  }

  for (const matches of existingByKey.values()) {
    for (const stale of matches) service.db.run('DELETE FROM plan_tasks WHERE id = ?', [stale.id]);
  }

  const completed = syncedStatuses.filter((status) => status === TASK_EVENT_STATUS.COMPLETED).length;
  const currentPlan = service.db.get('SELECT status, validation_passed FROM plans WHERE id = ?', [planId]);
  const status = currentPlan?.validation_passed || currentPlan?.status === 'completed'
    ? 'completed'
    : tasks.length > 0 && completed === tasks.length
      ? 'ready_for_validation'
      : 'running';
  service.db.run(
    'UPDATE plans SET hash = ?, status = ?, total_tasks = ?, completed_tasks = ?, updated_at = ? WHERE id = ?',
    [hashFile(planFile), status, tasks.length, completed, nowIso(), planId],
  );
}

function recordEmptyPlanTaskParse(service, planId, planFile, markdown) {
  const plan = service.db.get('SELECT id, project_id, file_path FROM plans WHERE id = ?', [planId]);
  if (!plan?.project_id) return;
  const filePath = plan.file_path || planFile;
  const message = `计划未解析到任务拆解：${filePath}`;
  const existing = service.db.get('SELECT id FROM events WHERE project_id = ? AND type = ? AND message = ? LIMIT 1', [
    plan.project_id,
    'plan.tasks.parse.empty',
    message,
  ]);
  if (existing) return;
  service.addEvent(plan.project_id, 'plan.tasks.parse.empty', message, {
    planId,
    filePath,
    taskCount: 0,
    markdownBytes: Buffer.byteLength(String(markdown || ''), 'utf8'),
    reason: 'no_parseable_task_lines',
    hint: '任务拆解必须位于 ## 任务拆解 章节，并使用 - [ ] P001: 任务标题 <!-- scope: ... --> 独占一行；不要写成段落、代码块、表格或嵌套 checkbox。',
  });
}

function recordDuplicatePlanTaskKeys(service, planId, planFile, duplicateKeys) {
  const plan = service.db.get('SELECT id, project_id, file_path FROM plans WHERE id = ?', [planId]);
  if (!plan?.project_id) return;
  const filePath = plan.file_path || planFile;
  const keys = duplicateKeys.join(', ');
  const message = `Plan contains duplicate task keys; kept first occurrence: ${keys} (${filePath})`;
  const existing = service.db.get('SELECT id FROM events WHERE project_id = ? AND type = ? AND message = ? LIMIT 1', [
    plan.project_id,
    'plan.tasks.duplicate_keys',
    message,
  ]);
  if (existing) return;
  service.addEvent(plan.project_id, 'plan.tasks.duplicate_keys', message, {
    planId,
    filePath,
    duplicateKeys,
  });
}

function uniquePlanTasksByKey(tasks) {
  const uniqueTasks = [];
  const seenKeys = new Set();
  const duplicateKeys = new Set();
  for (const task of tasks) {
    if (seenKeys.has(task.key)) {
      duplicateKeys.add(task.key);
      continue;
    }
    seenKeys.add(task.key);
    uniqueTasks.push({ ...task, sortOrder: uniqueTasks.length + 1 });
  }
  return { tasks: uniqueTasks, duplicateKeys: Array.from(duplicateKeys) };
}

function parsePlanTasksFromMarkdown(markdown) {
  const tasks = [];
  const lines = String(markdown || '').split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(PLAN_TASK_LINE_RE);
    if (!match) continue;
    const sortOrder = tasks.length + 1;
    const rawTitle = match[2].trim();
    const titleWithoutScope = stripPlanTaskScopeComment(rawTitle);
    const parsedTitle = parsePlanTaskTitle(titleWithoutScope, sortOrder);
    const rawLine = ensurePlanTaskScopeComment(line, parsedTitle.validationLike ? 'validation' : 'unknown');
    tasks.push({
      key: parsedTitle.key,
      title: parsedTitle.title || titleWithoutScope || rawTitle,
      rawLine,
      scope: planTaskScopeText({ raw_line: rawLine, title: rawTitle }, parsedTitle.validationLike ? 'validation' : 'unknown'),
      status: match[1].toLowerCase() === 'x' ? TASK_EVENT_STATUS.COMPLETED : TASK_EVENT_STATUS.PENDING,
      sortOrder,
    });
  }
  return tasks;
}

function parsePlanTaskTitle(title, sortOrder) {
  const text = String(title || '').trim();
  const keyFallback = `P${String(sortOrder).padStart(3, '0')}`;
  const match = text.match(PLAN_TASK_KEY_RE);
  const validationLike = /完整验收|整体验收|总体验收|最终验收|完整验证|最终验证|acceptance|validation/i.test(text);
  if (!match) return { key: keyFallback, title: text, validationLike };
  return {
    key: normalizePlanTaskKey(match[1]) || keyFallback,
    title: cleanPlanTaskTitle(match[2]) || text,
    validationLike,
  };
}

function cleanPlanTaskTitle(value) {
  return String(value || '').replace(/^[-–—:：\s]+/, '').trim();
}

function normalizePlanTaskKey(value) {
  return String(value || '').trim().replace(/^([a-z]+)([-_]?\d+)$/i, (_match, prefix, suffix) => `${prefix.toUpperCase()}${suffix}`);
}

function planTaskScopeText(task, fallbackScope = 'unknown') {
  const explicit = planTaskDeclaredScopes(task, { keepUnknown: true, includePathFallback: false });
  if (explicit.length) return explicit.join(', ');
  const fallback = normalizePlanTaskScope(fallbackScope, { keepUnknown: true });
  if (fallback) return fallback;
  const inferred = planTaskDeclaredScopes(task, { keepUnknown: false });
  return inferred.join(', ') || 'unknown';
}

function planTaskDeclaredScopes(task, options = {}) {
  const { keepUnknown = false, includePathFallback = true } = options;
  const raw = `${task.task_key || ''} ${task.title || ''} ${task.raw_line || ''}`;
  const scopes = new Set();
  addPlanTaskScopeParts(scopes, String(task.scope || '').split(PLAN_TASK_SCOPE_SPLIT_RE), { keepUnknown });
  addPlanTaskScopeParts(scopes, explicitPlanTaskScopeParts(raw), { keepUnknown });
  if (includePathFallback) {
    for (const match of raw.matchAll(PLAN_TASK_PATH_RE)) {
      const scope = normalizePlanTaskScope(match[0], { keepUnknown });
      if (scope && !scope.startsWith('docs/plan/') && !scope.startsWith('docs/progress/')) scopes.add(scope);
    }
  }
  return Array.from(scopes);
}

function explicitPlanTaskScopeParts(raw) {
  const explicit = String(raw || '').match(PLAN_TASK_SCOPE_RE);
  return explicit?.[1] ? explicit[1].split(PLAN_TASK_SCOPE_SPLIT_RE) : [];
}

function addPlanTaskScopeParts(scopes, parts, options = {}) {
  for (const part of parts) {
    const scope = normalizePlanTaskScope(part, options);
    if (scope) scopes.add(scope);
  }
}

function normalizePlanTaskScope(value, options = {}) {
  const scope = String(value || '')
    .trim()
    .replace(/^["'`[{(]+|["'`\]})]+$/g, '')
    .replace(/\s*--$/, '')
    .replaceAll('\\', '/')
    .toLowerCase();
  if (!scope || scope === '-') return '';
  if (scope === 'unknown') return options.keepUnknown ? 'unknown' : '';
  return scope;
}

function ensurePlanTaskScopeComment(line, fallbackScope = 'unknown') {
  const text = String(line || '').trimEnd();
  return PLAN_TASK_SCOPE_RE.test(text) ? text : `${text} <!-- scope: ${fallbackScope} -->`;
}

function stripPlanTaskScopeComment(value) {
  return String(value || '').replace(PLAN_TASK_SCOPE_COMMENT_RE, ' ').replace(/\s+/g, ' ').trim();
}

module.exports = {
  syncPlanTasksFromMarkdown,
  parsePlanTasksFromMarkdown,
};
