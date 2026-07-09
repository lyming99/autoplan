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

// AutoPlan \u8BA1\u5212 markdown \u5FC5\u9700\u7684\u4E09\u4E2A\u4E8C\u7EA7\u6807\u9898\uFF1BvalidatePlanContent / validatePhasePlanContent
// \u4F9D\u8D56\u5176\u7CBE\u786E\u5199\u6CD5\uFF08`##` \u540E\u53EA\u5141\u8BB8\u7A7A\u767D\u518D\u63A5\u6807\u9898\u6587\u672C\uFF09\u3002
const PLAN_REQUIRED_HEADINGS = ['\u4EFB\u52A1\u62C6\u89E3', '\u603B\u4F53\u9A8C\u6536\u6807\u51C6', '\u8FDB\u5EA6\u533A'];
// LLM \u5076\u53D1\u6DFB\u52A0\u7684\u7F16\u53F7\u524D\u7F00\uFF1A\u963F\u62C9\u4F2F\u6570\u5B57\uFF082. / 2\u3001 / 2) / 2\uFF1A\uFF09\u6216\u4E2D\u6587\u6570\u5B57\uFF08\u4E8C\u3001 / \u4E8C.\uFF09\u3002
const PLAN_HEADING_NUMBER_PREFIX = '(?:\\d{1,3}\\s*[.\u3001)\uFF09:\uFF1A]|[\u4E00\u4E8C\u4E09\u56DB\u4E94\u516D\u4E03\u516B\u4E5D\u5341\u767E]+\\s*[\u3001.])';
// \u5339\u914D\u8FD9\u4E09\u7C7B\u6807\u9898\u7684\u4EFB\u610F\u5C42\u7EA7\uFF08#~######\uFF09\u4E0E\u7F16\u53F7\u524D\u7F00\u53D8\u4F53\uFF1B\u6355\u83B7\uFF1A1=#\u6807\u8BB0 2=\u6807\u9898\u6587\u672C 3=\u884C\u5C3E\u5269\u4F59\u3002
const PLAN_HEADING_NORMALIZE_RE = new RegExp(
  '^(#{1,6})[^\\S\\r\\n]*(?:' + PLAN_HEADING_NUMBER_PREFIX + '[^\\S\\r\\n]*)?(' +
    PLAN_REQUIRED_HEADINGS.join('|') + ')([^\\n]*)$',
);
const PLAN_TASK_SECTION_HEADING_RE = /^\uFEFF?##[ \t]+\u4EFB\u52A1\u62C6\u89E3[ \t]*$/;
const PLAN_NEXT_SECTION_HEADING_RE = /^\uFEFF?##[ \t]+\S.*$/;
// \u5339\u914D\u4EFB\u52A1\u590D\u9009\u6846\u884C\uFF1B\u6355\u83B7\uFF1A1=\u7F29\u8FDB 2=\u5217\u8868\u6807\u8BB0 3=\u52FE\u9009\u72B6\u6001 4=\u6B63\u6587\u3002
const PLAN_TASK_CHECKBOX_LINE_RE = /^(\uFEFF?)(-)\s*\[\s*([ xX]?)\s*\]\s+(.*)$/;
// \u5339\u914D\u56F4\u680F\u4EE3\u7801\u5757\u884C\uFF08``` \u6216 ~~~\uFF09\uFF0C\u7528\u4E8E\u89C4\u8303\u5316\u65F6\u8DF3\u8FC7\u4EE3\u7801\u5757\u5185\u5BB9\u3002
const CODE_FENCE_LINE_RE = /^(\s*)(`{3,}|~{3,})/;
const FINAL_ACCEPTANCE_RE = /\u5B8C\u6574\u9A8C\u6536|\u6574\u4F53\u9A8C\u6536|\u603B\u4F53\u9A8C\u6536|\u6700\u7EC8\u9A8C\u6536|\u5B8C\u6574\u9A8C\u8BC1|\u6700\u7EC8\u9A8C\u8BC1|acceptance|validation/i;

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

    // Append to the canonical task section parsed by syncPlanTasks.
    let content = fs.readFileSync(planFile, 'utf8');
    const line = ensureTaskScopeComment(`- [ ] ${taskKey}: ${cleanTitle}`);
    const taskSectionIdx = content.search(PLAN_TASK_SECTION_HEADING_RE);
    const lastTask = service.db.get(
      'SELECT * FROM plan_tasks WHERE plan_id = ? ORDER BY sort_order DESC, id DESC LIMIT 1',
      [planId],
    );
    const { isAcceptanceTask } = helpers;
    if (taskSectionIdx === -1) {
      content = `${content.trim()}\n\n## 任务拆解\n${line}\n`;
    } else if (isAcceptanceTask(lastTask)) {
      content = insertTaskLineBeforeTask(content, lastTask, line);
    } else {
      content = insertTaskLineAtTaskSectionEnd(content, line);
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
    const lines = planTaskSectionLinesFromMarkdown(text);
    const tasks = [];
    let inFence = false;
    for (const line of lines) {
      const trimmed = line.trim();
      if (/^(?:```|~~~)/.test(trimmed)) {
        inFence = !inFence;
        continue;
      }
      if (inFence || /^[>|]/.test(line.trimStart())) continue;
      const match = line.match(PLAN_TASK_CHECKBOX_LINE_RE);
      if (!match) continue;
      const index = tasks.length + 1;
      const rawTitle = match[4].trim();
      const titleWithoutScope = stripTaskScopeComment(rawTitle);
      const idMatch = titleWithoutScope.match(/^([A-Za-z]+[-_]?\d+|P\d+)[:：\s-]+(.+)$/);
      const parsedTitle = idMatch?.[2]?.trim() || titleWithoutScope || rawTitle;
      const fallbackScope = isFinalAcceptanceTitle(titleWithoutScope) ? 'validation' : 'unknown';
      const rawLine = ensureTaskScopeComment(line, fallbackScope);
      tasks.push({
        key: idMatch?.[1] || `P${String(index).padStart(3, '0')}`,
        title: parsedTitle,
        rawLine,
        scope: fallbackScope === 'validation' ? 'validation' : taskScopeText({ raw_line: rawLine, title: rawTitle }, fallbackScope),
        status: match[3].toLowerCase() === 'x' ? 'completed' : 'pending',
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

function planTaskSectionLinesFromMarkdown(markdown) {
  const lines = String(markdown || '').split(/\r?\n/);
  const start = lines.findIndex((line) => PLAN_TASK_SECTION_HEADING_RE.test(line));
  if (start === -1) return [];
  const sectionLines = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (PLAN_NEXT_SECTION_HEADING_RE.test(line)) break;
    sectionLines.push(line);
  }
  return sectionLines;
}

function taskScopeText(task, fallbackScope = 'unknown') {
  const explicit = taskDeclaredScopes(task, { keepUnknown: true, includePathFallback: false });
  if (explicit.length) return explicit.join(', ');
  const fallback = normalizeTaskScope(fallbackScope, { keepUnknown: true });
  if (fallback) return fallback;
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
  const next = rewritePlanTaskSectionLines(content, (line) => {
    if (!PLAN_TASK_CHECKBOX_LINE_RE.test(line) || TASK_SCOPE_RE.test(line)) return line;
    changed = true;
    return ensureTaskScopeComment(line, isFinalAcceptanceTitle(line) ? 'validation' : 'unknown');
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

function insertTaskLineAtTaskSectionEnd(content, line) {
  const text = String(content || '');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((value) => PLAN_TASK_SECTION_HEADING_RE.test(value));
  if (start === -1) return `${text.trimEnd()}${eol}${line}${eol}`;
  let insertIndex = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (PLAN_NEXT_SECTION_HEADING_RE.test(lines[index])) {
      insertIndex = index;
      break;
    }
  }
  while (insertIndex > start + 1 && lines[insertIndex - 1].trim() === '') insertIndex -= 1;
  lines.splice(insertIndex, 0, line);
  return lines.join(eol);
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

// 对 plan markdown 做确定性规范化（反馈 #95）：
//  - 把带数字/中文编号前缀或错误层级（# / ### 等）的 任务拆解 / 总体验收标准 / 进度区 标题
//    改写为规范二级标题（`## 任务拆解` / `## 总体验收标准` / `## 进度区`）；
//  - 对任务复选框行按出现顺序补齐连续 P0NN 编号（P001、P002…，不跳号），缺失 scope 注释的
//    复用 ensureTaskScopeComment 补 unknown，已有 scope 予以保留；
//  - 跳过围栏代码块，且只动上述已知标题与任务行，正文段落/表格等其它内容原样保留。
// 规范化幂等：已是规范内容的 plan 经本函数处理后字符串不变。
function normalizePlanMarkdown(content) {
  const text = String(content || '');
  if (!text) return text;
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  let inFence = false;
  let fenceChar = '';
  let inTaskSection = false;
  let taskIndex = 0;
  const out = [];
  for (const line of lines) {
    const fence = line.match(CODE_FENCE_LINE_RE);
    if (fence) {
      const ch = fence[2][0];
      if (!inFence) {
        inFence = true;
        fenceChar = ch;
      } else if (ch === fenceChar) {
        inFence = false;
        fenceChar = '';
      }
      out.push(line);
      continue;
    }
    if (inFence) {
      out.push(line);
      continue;
    }
    const heading = normalizePlanHeadingLine(line);
    if (heading !== null) {
      inTaskSection = PLAN_TASK_SECTION_HEADING_RE.test(heading);
      out.push(heading);
      continue;
    }
    if (PLAN_NEXT_SECTION_HEADING_RE.test(line)) inTaskSection = false;
    if (inTaskSection) {
      const task = normalizePlanTaskLine(line, taskIndex + 1);
      if (task !== null) {
        taskIndex += 1;
        out.push(task);
        continue;
      }
    }
    out.push(line);
  }
  return out.join(eol);
}

// 把单行标题改写为规范二级标题；非目标标题行返回 null。
function normalizePlanHeadingLine(line) {
  const m = line.match(PLAN_HEADING_NORMALIZE_RE);
  if (!m) return null;
  return `## ${m[2]}${m[3] || ''}`;
}

// 把单行任务复选框改写为规范 `P0NN: title <!-- scope: ... -->`；非任务行（或空标题）返回 null。
function normalizePlanTaskLine(line, index) {
  const m = line.match(PLAN_TASK_CHECKBOX_LINE_RE);
  if (!m) return null;
  const [, bom, marker, check, body] = m;
  const scopeMatch = body.match(TASK_SCOPE_COMMENT_RE);
  const scopeValue = scopeMatch ? scopeMatch[1].trim() : '';
  const title = stripTaskScopeComment(body)
    .replace(/^P0*\d+\s*[:：]\s*/i, '')
    .trim();
  if (!title) return null;
  const checkChar = check && check.toLowerCase() === 'x' ? 'x' : ' ';
  const taskKey = `P${String(index).padStart(3, '0')}`;
  const base = `${taskKey}: ${title}`;
  const validationLike = isFinalAcceptanceTitle(title);
  const newBody = validationLike
    ? `${base} <!-- scope: validation -->`
    : (scopeValue ? `${base} <!-- scope: ${scopeValue} -->` : ensureTaskScopeComment(base, 'unknown'));
  return `${bom}${marker} [${checkChar}] ${newBody}`;
}

function rewritePlanTaskSectionLines(content, rewriteLine) {
  const text = String(content || '');
  if (!text) return text;
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  let inTaskSection = false;
  let inFence = false;
  let fenceChar = '';
  const out = [];
  for (const line of lines) {
    const fence = line.match(CODE_FENCE_LINE_RE);
    if (fence) {
      const ch = fence[2][0];
      if (!inFence) {
        inFence = true;
        fenceChar = ch;
      } else if (ch === fenceChar) {
        inFence = false;
        fenceChar = '';
      }
      out.push(line);
      continue;
    }
    if (!inFence) {
      if (PLAN_TASK_SECTION_HEADING_RE.test(line)) {
        inTaskSection = true;
      } else if (PLAN_NEXT_SECTION_HEADING_RE.test(line)) {
        inTaskSection = false;
      }
    }
    out.push(inTaskSection && !inFence ? rewriteLine(line) : line);
  }
  return out.join(eol);
}

function isFinalAcceptanceTitle(value) {
  return FINAL_ACCEPTANCE_RE.test(String(value || ''));
}

// 文件级规范化：读盘 -> 规范化 -> 仅在内容变化时写回（幂等，无变化不写盘）。
function normalizePlanMarkdownFile(planFile) {
  if (!fs.existsSync(planFile)) return false;
  const original = fs.readFileSync(planFile, 'utf8');
  const normalized = normalizePlanMarkdown(original);
  if (normalized === original) return false;
  fs.writeFileSync(planFile, normalized, 'utf8');
  return true;
}

module.exports = {
  addScopeParts,
  appendTask,
  cleanMarkdownHeadingTitle,
  ensureTaskScopeComment,
  explicitTaskScopeParts,
  extractMarkdownTitle,
  insertTaskLineBeforeTask,
  normalizePlanMarkdown,
  normalizePlanMarkdownFile,
  normalizePlanTaskScopes,
  normalizeTaskScope,
  planTaskSectionLinesFromMarkdown,
  stripTaskScopeComment,
  syncPlanTasks,
  taskDeclaredScopes,
  taskScopeText,
};
