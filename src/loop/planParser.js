const fs = require('node:fs');
const path = require('node:path');
const { nowIso } = require('../database');
const { syncedTaskStatus, taskEventMeta, TASK_EVENT_STATUS } = require('./taskEvents');
const { hashFile } = require('./workspaceFiles');

const TASK_SCOPE_LABEL_RE = '(?:scope|scopes|files?|\u5f71\u54cd\u8303\u56f4|\u5e76\u53d1\u952e)';
const TASK_SCOPE_RE = new RegExp(`${TASK_SCOPE_LABEL_RE}\\s*[:=\uFF1A]\\s*([^>\\]\\n]+)`, 'i');
const TASK_SCOPE_COMMENT_RE = new RegExp(`\\s*<!--\\s*${TASK_SCOPE_LABEL_RE}\\s*[:=\uFF1A]\\s*([^>]*?)\\s*-->\\s*`, 'i');
const TASK_SCOPE_SPLIT_RE = /[,\uFF0C\u3001;\uFF1B]+/;
const TASK_PATH_RE = /[\\w./\\\\-]+\\.(?:dart|js|jsx|ts|tsx|css|scss|html|md|json|ya?ml)/gi;

function appendTask(service, helpers, projectId, planId, title) {
    const project = service.project(projectId);
    const workspace = project?.workspace_path;
    const plan = service.db.get('SELECT * FROM plans WHERE id = ? AND project_id = ?', [planId, projectId]);
    if (!plan) throw new Error('计划不存在');
    if (!workspace) throw new Error('请先设置项目工作区路径');

    const planFile = path.join(workspace, plan.file_path);
    if (!fs.existsSync(planFile)) throw new Error('plan 文件不存在，无法追加任务');

    const cleanTitle = String(title || '').trim();
    if (!cleanTitle) throw new Error('任务标题不能为空');

    // 计算下一个 task_key
    const existing = service.db.all('SELECT task_key FROM plan_tasks WHERE plan_id = ? ORDER BY sort_order', [planId]);
    const maxNum = existing.reduce((max, row) => {
      const m = String(row.task_key || '').match(/P0*(\d+)/i);
      return m ? Math.max(max, Number(m[1])) : max;
    }, 0);
    const taskKey = `P${String(maxNum + 1).padStart(3, '0')}`;

    // 追加到 plan 文件的"## 任务计划"段末尾
    let content = fs.readFileSync(planFile, 'utf8');
    const line = ensureTaskScopeComment(`- [ ] ${taskKey}: ${cleanTitle}`);
    const taskSectionIdx = content.search(/##\s*任务计划/);
    const lastTask = service.db.get(
      'SELECT * FROM plan_tasks WHERE plan_id = ? ORDER BY sort_order DESC, id DESC LIMIT 1',
      [planId],
    );
    if (taskSectionIdx === -1) {
  const { isAcceptanceTask } = helpers;
      content = `${content.trim()}\n\n## 任务计划\n${line}\n`;
    } else if (isAcceptanceTask(lastTask)) {
      content = insertTaskLineBeforeTask(content, lastTask, line);
    } else {
      content = `${content.trimEnd()}\n${line}\n`;
    }
    fs.writeFileSync(planFile, content, 'utf8');

    // 若 plan 被中断或已完成，恢复状态让新任务可执行
    if (plan.status === 'interrupted') {
      service.db.run('UPDATE plans SET status = ?, updated_at = ? WHERE id = ?', ['pending', nowIso(), planId]);
    } else if (plan.status === 'completed' || plan.validation_passed === 1) {
      service.db.run(
        'UPDATE plans SET status = ?, validation_passed = 0, updated_at = ? WHERE id = ?',
        ['pending', nowIso(), planId],
      );
      service.addEvent(
        projectId,
        'plan.reactivated',
        `计划 #${planId} 因追加任务 ${taskKey} 重新激活`,
        { planId, reason: 'task_appended', taskKey },
      );
    }
    // 重新解析任务入库
    service.syncPlanTasks(planId, planFile);
    const task = service.db.get('SELECT * FROM plan_tasks WHERE plan_id = ? AND task_key = ?', [planId, taskKey]);
    service.addEvent(
      projectId,
      'task.appended',
      `追加 ${taskKey}: ${cleanTitle}`,
      taskEventMeta(task, {
        planId,
        taskKey,
        taskTitle: cleanTitle,
        status: TASK_EVENT_STATUS.PENDING,
      }),
    );
    service.emitUpdate(projectId);

    // 循环在运行则立即拾取
    if (service.status(projectId)?.running) {
      service.runOnce(projectId).catch((error) => service.recordError(projectId, error));
    }
    return taskKey;
  }

function syncPlanTasks(service, helpers, planId, planFile) {
    if (!fs.existsSync(planFile)) return;
    normalizePlanTaskScopes(planFile);
    const text = fs.readFileSync(planFile, 'utf8');
    const regex = /^\s*[-*]\s+\[([ xX])\]\s+(.+)$/gm;
    const tasks = [];
    let match;
    let index = 0;
    while ((match = regex.exec(text))) {
      index += 1;
      const rawTitle = match[2].trim();
      const titleWithoutScope = stripTaskScopeComment(rawTitle);
      const idMatch = titleWithoutScope.match(/^([A-Za-z]+[-_]?\d+|P\d+)[:：\s-]+(.+)$/);
      tasks.push({
        key: idMatch?.[1] || `P${String(index).padStart(3, '0')}`,
        title: idMatch?.[2]?.trim() || titleWithoutScope || rawTitle,
        rawLine: ensureTaskScopeComment(match[0]),
        scope: taskScopeText({ raw_line: match[0], title: rawTitle }),
        status: match[1].toLowerCase() === 'x' ? 'completed' : 'pending',
        sortOrder: index,
      });
    }

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
          [
            task.title,
            task.rawLine,
            task.scope,
            status,
            task.sortOrder,
            nowIso(),
            existing.id,
          ],
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
      for (const stale of matches) {
        service.db.run('DELETE FROM plan_tasks WHERE id = ?', [stale.id]);
      }
    }

    const completed = syncedStatuses.filter((status) => status === 'completed').length;
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

function taskScopeText(task) {
  const explicit = taskDeclaredScopes(task, { keepUnknown: true, includePathFallback: false });
  if (explicit.length) return explicit.join(', ');
  const inferred = taskDeclaredScopes(task, { keepUnknown: false });
  return inferred.join(', ') || 'unknown';
}

function taskDeclaredScopes(task, options = {}) {
  const { keepUnknown = false, includePathFallback = true } = options;
  const raw = `${task.task_key || ''} ${task.title || ''} ${task.raw_line || ''}`;
  const scopes = new Set();

  addScopeParts(scopes, String(task.scope || '').split(TASK_SCOPE_SPLIT_RE), { keepUnknown });
  addScopeParts(scopes, explicitTaskScopeParts(raw), { keepUnknown });

  if (includePathFallback) {
    for (const match of raw.matchAll(TASK_PATH_RE)) {
      const scope = normalizeTaskScope(match[0], { keepUnknown });
      if (scope && !scope.startsWith('docs/plan/') && !scope.startsWith('docs/progress/')) {
        scopes.add(scope);
      }
    }
  }

  return Array.from(scopes);
}

function explicitTaskScopeParts(raw) {
  const explicit = String(raw || '').match(TASK_SCOPE_RE);
  return explicit?.[1] ? explicit[1].split(TASK_SCOPE_SPLIT_RE) : [];
}

function addScopeParts(scopes, parts, options = {}) {
  for (const part of parts) {
    const scope = normalizeTaskScope(part, options);
    if (scope) scopes.add(scope);
  }
}

function normalizeTaskScope(value, options = {}) {
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

function ensureTaskScopeComment(line, fallbackScope = 'unknown') {
  const text = String(line || '').trimEnd();
  return TASK_SCOPE_RE.test(text) ? text : `${text} <!-- scope: ${fallbackScope} -->`;
}

function stripTaskScopeComment(value) {
  return String(value || '').replace(TASK_SCOPE_COMMENT_RE, ' ').replace(/\s+/g, ' ').trim();
}

function normalizePlanTaskScopes(planFile) {
  const content = fs.readFileSync(planFile, 'utf8');
  let changed = false;
  const next = content.replace(/^(\s*[-*]\s+\[[ xX]\]\s+.+)$/gm, (line) => {
    if (TASK_SCOPE_RE.test(line)) return line;
    changed = true;
    return ensureTaskScopeComment(line);
  });
  if (changed) fs.writeFileSync(planFile, next, 'utf8');
}

function insertTaskLineBeforeTask(content, task, line) {
  const key = escapeRegExp(String(task?.task_key || task?.key || ''));
  if (!key) return `${content.trimEnd()}\n${line}\n`;
  const taskLineRe = new RegExp(`(^\\s*[-*]\\s+\\[[ xX]\\]\\s+${key}(?:\\b|[:：\\s-]).*$)`, 'm');
  if (taskLineRe.test(content)) {
    return content.replace(taskLineRe, `${line}\n$1`);
  }
  return `${content.trimEnd()}\n${line}\n`;
}

function extractMarkdownTitle(markdown) {
  const lines = String(markdown || '').split(/\r?\n/);
  const h1 = lines.find((line) => /^\uFEFF?\s*#\s+\S/.test(line) && !/^\uFEFF?\s*#{2,}\s+/.test(line));
  if (h1) return cleanMarkdownHeadingTitle(h1.replace(/^\uFEFF?\s*#\s+/, ''));

  const heading = lines.find((line) => /^\uFEFF?\s*#{1,6}\s+\S/.test(line));
  return heading ? cleanMarkdownHeadingTitle(heading.replace(/^\uFEFF?\s*#{1,6}\s+/, '')) : '';
}

function cleanMarkdownHeadingTitle(value) {
  return String(value || '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\s+#+\s*$/g, '')
    .trim();
}

module.exports = {
  addScopeParts,
  appendTask,
  cleanMarkdownHeadingTitle,
  ensureTaskScopeComment,
  explicitTaskScopeParts,
  extractMarkdownTitle,
  insertTaskLineBeforeTask,
  normalizePlanTaskScopes,
  normalizeTaskScope,
  stripTaskScopeComment,
  syncPlanTasks,
  taskDeclaredScopes,
  taskScopeText,
};
