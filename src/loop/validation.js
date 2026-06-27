const fs = require('node:fs');
const path = require('node:path');
const { nowIso } = require('../database');
const { agentCliContextFields, normalizeOptionalNumber } = require('./agentCliConfig');
const { compactEventMeta, TASK_EVENT_STATUS, TASK_EVENT_TYPES } = require('./taskEvents');

function isFinalAcceptanceTask(service, helpers, planId, task) {
  const { isAcceptanceTask } = helpers;
    if (!task) return false;
    const lastTask = service.db.get(
      'SELECT * FROM plan_tasks WHERE plan_id = ? ORDER BY sort_order DESC, id DESC LIMIT 1',
      [planId],
    );
    return Number(lastTask?.id) === Number(task.id) && isAcceptanceTask(task);
  }

function hasFinalAcceptanceTask(service, helpers, planId) {
  const { isAcceptanceTask } = helpers;
    const lastTask = service.db.get(
      'SELECT * FROM plan_tasks WHERE plan_id = ? ORDER BY sort_order DESC, id DESC LIMIT 1',
      [planId],
    );
    return isAcceptanceTask(lastTask);
  }

function completeAcceptanceTask(service, helpers, workspace, plan, task, result) {
  const { hashFile } = helpers;
    const planFile = path.join(workspace, plan.file_path);
    const finishedAt = result?.finishedAt || nowIso();
    service.markTaskCompletedInPlan(workspace, planFile, task, result);
    const completedTask = service.finishTaskRun(task.id, TASK_EVENT_STATUS.COMPLETED, finishedAt) || task;
    const totals = service.db.get(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed
       FROM plan_tasks
       WHERE plan_id = ?`,
      [plan.id],
    ) || { total: 0, completed: 0 };
    const hash = fs.existsSync(planFile) ? hashFile(planFile) : '';
    service.db.run(
      'UPDATE plans SET hash = ?, status = ?, total_tasks = ?, completed_tasks = ?, validation_passed = 1, updated_at = ? WHERE id = ?',
      [hash, 'completed', Number(totals.total || 0), Number(totals.completed || 0), nowIso(), plan.id],
    );
    service.addTaskLifecycleEvent(plan.project_id, TASK_EVENT_TYPES.SUCCEEDED, completedTask, {
      ...agentCliContextFields(service.planAgentCliConfig(plan), { defaultProvider: true }),
      planId: plan.id,
      status: TASK_EVENT_STATUS.COMPLETED,
      finishedAt,
      exitCode: result?.exitCode,
      log: result?.logFile,
      acceptanceTask: true,
    });
    service.emitUpdate(plan.project_id);
  }

async function validatePlan(service, helpers, workspace, plan, options = {}) {
  const { tailText } = helpers;
    service.setPhase(plan.project_id, 'validate');
    const planFile = path.join(workspace, plan.file_path);
    const planAgentCliContext = agentCliContextFields(service.planAgentCliConfig(plan), { defaultProvider: true });
    const acceptanceTask = options.task || null;
    let startedAcceptanceTask = acceptanceTask;
    if (acceptanceTask) {
      const startedAt = nowIso();
      startedAcceptanceTask = service.startTaskRun(acceptanceTask.id, startedAt) || acceptanceTask;
      service.addTaskLifecycleEvent(plan.project_id, TASK_EVENT_TYPES.STARTED, startedAcceptanceTask, {
        ...planAgentCliContext,
        planId: plan.id,
        status: TASK_EVENT_STATUS.RUNNING,
        startedAt,
        acceptanceTask: true,
      });
    }
    const command = String(service.status(plan.project_id)?.validation_command || '').trim();
    if (!command) {
      // 验收命令为空：跳过校验，直接标记完成。
      const validation = { exitCode: 0, output: '', logFile: null, finishedAt: nowIso() };
      service.db.run(
        'UPDATE plans SET status = ?, validation_passed = 1, updated_at = ? WHERE id = ?',
        ['completed', validation.finishedAt, plan.id],
      );
      service.addEvent(plan.project_id, 'plan.completed', '任务全部完成（验收命令为空，已跳过校验）', {
        ...planAgentCliContext,
        planId: plan.id,
      });
      if (startedAcceptanceTask) service.completeAcceptanceTask(workspace, plan, startedAcceptanceTask, validation);
      return validation;
    }
    let validation = await service.runShell(workspace, command, `validate-${plan.id}`, { projectId: plan.project_id });
    let validationFailure = classifyExecutionFailure(validation);
    for (
      let attempt = 1;
      validation.exitCode !== 0 && attempt <= 2 && !isEnvironmentBlockingFailure(validationFailure);
      attempt += 1
    ) {
      service.db.run('UPDATE plans SET status = ?, updated_at = ? WHERE id = ?', [
        'validation_failed',
        nowIso(),
        plan.id,
      ]);
      const prompt = [
        'plan 已完成，但宿主项目验收失败。请只修复验证错误。',
        `plan 文件（只读）：${planFile}`,
        '不要修改 plan 文件、checkbox 或进度区。',
        `失败命令：${command}`,
        '失败输出摘要：',
        tailText(validation.output, 12000),
      ].join('\n');
      await service.runCodexWithPlanGuard(workspace, prompt, `repair-${plan.id}-${attempt}`, {
        projectId: plan.project_id,
        planId: plan.id,
        ...planAgentCliContext,
      }, planFile);
      validation = await service.runShell(workspace, command, `validate-${plan.id}-repair-${attempt}`, {
        projectId: plan.project_id,
      });
      validationFailure = classifyExecutionFailure(validation);
    }

    if (validation.exitCode === 0) {
      validation.finishedAt = nowIso();
      service.db.run(
        'UPDATE plans SET status = ?, validation_passed = 1, updated_at = ? WHERE id = ?',
        ['completed', validation.finishedAt, plan.id],
      );
      service.addEvent(plan.project_id, 'plan.completed', plan.file_path, { ...planAgentCliContext, planId: plan.id });
      if (startedAcceptanceTask) service.completeAcceptanceTask(workspace, plan, startedAcceptanceTask, validation);
    } else {
      validation.finishedAt = nowIso();
      service.db.run('UPDATE plans SET status = ?, updated_at = ? WHERE id = ?', [
        'validation_failed',
        validation.finishedAt,
        plan.id,
      ]);
      const eventType = isEnvironmentBlockingFailure(validationFailure) ? 'validation.blocked' : 'validation.failed';
      service.addEvent(plan.project_id, eventType, validation.logFile || validationFailure.failureSummary || command, {
        ...planAgentCliContext,
        planId: plan.id,
        exitCode: validation.exitCode,
        log: validation.logFile,
        ...validationFailure,
      });
      if (startedAcceptanceTask) {
        service.recordTaskFailure(plan.project_id, plan, startedAcceptanceTask, validation.finishedAt, {
          ...planAgentCliContext,
          exitCode: validation.exitCode,
          log: validation.logFile,
          acceptanceTask: true,
          ...validationFailure,
        });
      }
    }
    return validation;
  }

function classifyExecutionFailure(result = {}) {
  const exitCode = typeof result.exitCode === 'number' ? result.exitCode : null;
  if (exitCode === 0) return {};

  const text = [result.errorMessage, result.output].filter(Boolean).join('\n');
  const timedOut = Boolean(result.timedOut) || /(?:timed\s*out|timeout|ETIMEDOUT)/i.test(text);
  let failureKind = 'command_failed';
  let failureCategory = 'execution';
  let environmentBlocked = false;

  if (/(?:PathAccessException|Permission\s+denied|Access\s+is\s+denied|EACCES|EPERM|errno\s*=\s*5|拒绝访问|存取被拒)/i.test(text)) {
    failureKind = 'environment_permission';
    failureCategory = 'environment';
    environmentBlocked = true;
  } else if (timedOut) {
    failureKind = 'timeout';
    failureCategory = 'environment';
    environmentBlocked = true;
  } else if (/(?:command not found|not recognized as (?:an internal|a cmdlet)|ENOENT|spawn .* ENOENT)/i.test(text)) {
    failureKind = 'tool_missing';
    failureCategory = 'environment';
    environmentBlocked = true;
  } else if (/(?:No tests? (?:match|matched|were found)|does not match any tests?)/i.test(text)) {
    failureKind = 'test_filter';
    failureCategory = 'test';
  } else if (/(?:Some tests failed|Test failed|TestFailure|Failed assertion|Expected:|Actual:|EXCEPTION CAUGHT BY FLUTTER TEST FRAMEWORK)/i.test(text)) {
    failureKind = 'test_failure';
    failureCategory = 'test';
  } else if (/(?:Compilation failed|Dart compiler exited|Error: The Dart compiler|Failed to compile|Target kernel_snapshot failed|SyntaxError)/i.test(text)) {
    failureKind = 'compile_failure';
    failureCategory = 'compile';
  } else if (/(?:Agent CLI|Codex CLI|Claude CLI)/i.test(text)) {
    failureKind = 'agent_failure';
    failureCategory = 'agent';
  }

  return compactEventMeta({
    failureKind,
    failureCategory,
    failureSummary: summarizeFailure(text, exitCode, failureKind),
    environmentBlocked,
    timedOut,
    timeoutMs: normalizeOptionalNumber(result.timeoutMs),
  });
}

function isEnvironmentBlockingFailure(failure = {}) {
  return Boolean(failure.environmentBlocked || failure.failureCategory === 'environment');
}

function summarizeFailure(text, exitCode, failureKind) {
  const fallback = exitCode === null ? failureKind : `${failureKind}; exitCode=${exitCode}`;
  const line = String(text || '')
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find(Boolean);
  if (!line) return fallback;
  return line.length > 240 ? `${line.slice(0, 237)}...` : line;
}

function formatDurationMs(milliseconds) {
  const seconds = Math.max(1, Math.round(Number(milliseconds || 0) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.round(seconds / 60)}m`;
}

module.exports = {
  classifyExecutionFailure,
  completeAcceptanceTask,
  formatDurationMs,
  hasFinalAcceptanceTask,
  isEnvironmentBlockingFailure,
  isFinalAcceptanceTask,
  validatePlan,
};
