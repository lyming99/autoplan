const fs = require('node:fs');
const path = require('node:path');
const { nowIso } = require('../database');
const {
  DEFAULT_AGENT_CLI_PROVIDER,
  agentCliContextFields,
  codexSessionContextFields,
  normalizeAgentCliSessionId,
  normalizeCodexSessionId,
  normalizeOptionalNumber,
  operationCodexSessionId,
} = require('./agentCliConfig');
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
    if (!taskTargetExists(service, plan, task)) return null;
    const planFile = path.join(workspace, plan.file_path);
    const finishedAt = result?.finishedAt || nowIso();
    service.markTaskCompletedInPlan(workspace, planFile, task, result);
    if (!taskTargetExists(service, plan, task)) return null;
    const completedTask = service.finishTaskRun(task.id, TASK_EVENT_STATUS.COMPLETED, finishedAt) || task;
    if (!taskTargetExists(service, plan, completedTask)) return null;
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
    service.completeLinkedIntakesForPlan(plan);
    const planAgentCliContext = agentCliContextFields(service.planAgentCliConfig(plan), { defaultProvider: true });
    service.addTaskLifecycleEvent(plan.project_id, TASK_EVENT_TYPES.SUCCEEDED, completedTask, {
      ...planAgentCliContext,
      ...validationResultSessionContextFields(result, planAgentCliContext.agentCliProvider),
      planId: plan.id,
      status: TASK_EVENT_STATUS.COMPLETED,
      finishedAt,
      exitCode: result?.exitCode,
      log: result?.logFile,
      acceptanceTask: true,
    });
    service.emitUpdate(plan.project_id);
    return completedTask;
  }

async function validatePlan(service, helpers, workspace, plan, options = {}) {
  const { tailText } = helpers;
    if (!planTargetExists(service, plan)) {
      return { exitCode: -1, output: '', errorMessage: '计划目标已删除', cancelled: true, finishedAt: nowIso() };
    }
    service.setPhase(plan.project_id, 'validate');
    const planFile = path.join(workspace, plan.file_path);
    const planAgentCliContext = agentCliContextFields(service.planAgentCliConfig(plan), { defaultProvider: true });
    const acceptanceTask = options.task || null;
    let startedAcceptanceTask = acceptanceTask;
    let acceptanceStartedAt = null;
    if (acceptanceTask) {
      acceptanceStartedAt = nowIso();
      startedAcceptanceTask = service.startTaskRun(acceptanceTask.id, acceptanceStartedAt) || acceptanceTask;
      if (!taskTargetExists(service, plan, startedAcceptanceTask)) {
        return { exitCode: -1, output: '', errorMessage: '验收任务目标已删除', cancelled: true, finishedAt: nowIso() };
      }
    }
    let validationSessionId = validationTaskSessionId(startedAcceptanceTask, planAgentCliContext.agentCliProvider);
    let validationSessionState = validationSessionId ? 'resume' : 'new';
    if (!validationSessionId) {
      validationSessionId = previousValidationSessionId(service, plan.id, startedAcceptanceTask, planAgentCliContext.agentCliProvider);
      if (validationSessionId) validationSessionState = 'plan-resume';
    }
    if (acceptanceTask) {
      service.addTaskLifecycleEvent(plan.project_id, TASK_EVENT_TYPES.STARTED, startedAcceptanceTask, {
        ...planAgentCliContext,
        ...validationSessionContextFields(planAgentCliContext.agentCliProvider, {
          sessionId: validationSessionId,
          requestedId: validationSessionId,
          mode: validationSessionId ? 'resume' : 'new',
          state: validationSessionState,
        }),
        planId: plan.id,
        status: TASK_EVENT_STATUS.RUNNING,
        startedAt: startedAcceptanceTask.started_at || acceptanceStartedAt,
        acceptanceTask: true,
      });
    }
    const command = String(service.status(plan.project_id)?.validation_command || '').trim();
    if (!command) {
      // 验收命令为空：跳过校验，直接标记完成。
      const validation = { exitCode: 0, output: '', logFile: null, finishedAt: nowIso() };
      attachValidationSessionContext(validation, planAgentCliContext.agentCliProvider, validationSessionId, validationSessionState);
      if (!planTargetExists(service, plan)) return { ...validation, exitCode: -1, cancelled: true };
      service.db.run(
        'UPDATE plans SET status = ?, validation_passed = 1, updated_at = ? WHERE id = ?',
        ['completed', validation.finishedAt, plan.id],
      );
      const linkedIntakes = service.completeLinkedIntakesForPlan(plan);
      service.addEvent(plan.project_id, 'plan.completed', '任务全部完成（验收命令为空，已跳过校验）', {
        ...planAgentCliContext,
        ...validationResultSessionContextFields(validation, planAgentCliContext.agentCliProvider),
        planId: plan.id,
        linkedIntakes,
      });
      if (startedAcceptanceTask) service.completeAcceptanceTask(workspace, plan, startedAcceptanceTask, validation);
      return validation;
    }
    // validation:before 前置钩子：fail_aborts=1 且退出码非零时中断验收
    const beforeHook = await service.runHookScripts(plan.project_id, 'validation:before', {
      planId: plan.id,
      planFilePath: plan.file_path,
      validationCommand: command,
    });
    if (!planTargetExists(service, plan)) {
      return { exitCode: -1, output: '', logFile: null, errorMessage: '计划目标已删除', cancelled: true, finishedAt: nowIso() };
    }
    if (beforeHook.aborted) {
      const aborted = { exitCode: 1, output: '', logFile: null, errorMessage: '前置钩子中断了验收', finishedAt: nowIso() };
      attachValidationSessionContext(aborted, planAgentCliContext.agentCliProvider, validationSessionId, validationSessionState);
      if (!planTargetExists(service, plan)) return { ...aborted, exitCode: -1, cancelled: true };
      service.db.run('UPDATE plans SET status = ?, updated_at = ? WHERE id = ?', ['validation_failed', aborted.finishedAt, plan.id]);
      service.addEvent(plan.project_id, 'validation.aborted', `前置钩子中断了验收：${command}`, {
        ...planAgentCliContext,
        ...validationResultSessionContextFields(aborted, planAgentCliContext.agentCliProvider),
        planId: plan.id,
        stage: 'validation:before',
        exitCode: 1,
        acceptanceTask: Boolean(startedAcceptanceTask),
      });
      if (startedAcceptanceTask) {
        service.recordTaskFailure(plan.project_id, plan, startedAcceptanceTask, aborted.finishedAt, {
          ...planAgentCliContext,
          ...validationResultSessionContextFields(aborted, planAgentCliContext.agentCliProvider),
          exitCode: 1,
          log: null,
          acceptanceTask: true,
        });
      }
      return aborted;
    }
    let validation = await service.runShell(workspace, command, `validate-${plan.id}`, {
      projectId: plan.project_id,
      planId: plan.id,
      taskId: startedAcceptanceTask?.id,
    });
    if (validation?.cancelled || !planTargetExists(service, plan)) return { ...validation, exitCode: -1, cancelled: true, finishedAt: nowIso() };
    let validationFailure = classifyExecutionFailure(validation);
    for (
      let attempt = 1;
      validation.exitCode !== 0 && attempt <= 2 && !isEnvironmentBlockingFailure(validationFailure);
      attempt += 1
    ) {
      if (!planTargetExists(service, plan)) return { ...validation, exitCode: -1, cancelled: true, finishedAt: nowIso() };
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
      const repair = await service.runCodexWithPlanGuard(workspace, prompt, `repair-${plan.id}-${attempt}`, {
        projectId: plan.project_id,
        planId: plan.id,
        taskId: startedAcceptanceTask?.id,
        ...planAgentCliContext,
        ...validationSessionContextFields(planAgentCliContext.agentCliProvider, {
          sessionId: validationSessionId,
          requestedId: validationSessionId,
          mode: validationSessionId ? 'resume' : 'new',
          state: validationSessionState,
        }),
      }, planFile);
      if (repair?.cancelled || !planTargetExists(service, plan)) return { ...repair, exitCode: -1, cancelled: true, finishedAt: nowIso() };
      const repairSessionId = validationResultSessionId(repair, planAgentCliContext.agentCliProvider);
      if (repairSessionId) {
        validationSessionId = repairSessionId;
        validationSessionState = validationResultSessionState(repair, planAgentCliContext.agentCliProvider);
        writeValidationSession(service, plan, startedAcceptanceTask, planAgentCliContext.agentCliProvider, repairSessionId, nowIso());
      }
      validation = await service.runShell(workspace, command, `validate-${plan.id}-repair-${attempt}`, {
        projectId: plan.project_id,
        planId: plan.id,
        taskId: startedAcceptanceTask?.id,
      });
      if (validation?.cancelled || !planTargetExists(service, plan)) return { ...validation, exitCode: -1, cancelled: true, finishedAt: nowIso() };
      validationFailure = classifyExecutionFailure(validation);
    }
    attachValidationSessionContext(validation, planAgentCliContext.agentCliProvider, validationSessionId, validationSessionState);

    if (validation.exitCode === 0) {
      validation.finishedAt = nowIso();
      if (validation?.cancelled || !planTargetExists(service, plan)) return { ...validation, exitCode: -1, cancelled: true };
      service.db.run(
        'UPDATE plans SET status = ?, validation_passed = 1, updated_at = ? WHERE id = ?',
        ['completed', validation.finishedAt, plan.id],
      );
      const linkedIntakes = service.completeLinkedIntakesForPlan(plan);
      service.addEvent(plan.project_id, 'plan.completed', plan.file_path, {
        ...planAgentCliContext,
        ...validationResultSessionContextFields(validation, planAgentCliContext.agentCliProvider),
        planId: plan.id,
        linkedIntakes,
      });
      if (startedAcceptanceTask) service.completeAcceptanceTask(workspace, plan, startedAcceptanceTask, validation);
    } else {
      validation.finishedAt = nowIso();
      if (validation?.cancelled || !planTargetExists(service, plan)) return { ...validation, exitCode: -1, cancelled: true };
      service.db.run('UPDATE plans SET status = ?, updated_at = ? WHERE id = ?', [
        'validation_failed',
        validation.finishedAt,
        plan.id,
      ]);
      const eventType = isEnvironmentBlockingFailure(validationFailure) ? 'validation.blocked' : 'validation.failed';
      service.addEvent(plan.project_id, eventType, validation.logFile || validationFailure.failureSummary || command, {
        ...planAgentCliContext,
        ...validationResultSessionContextFields(validation, planAgentCliContext.agentCliProvider),
        planId: plan.id,
        exitCode: validation.exitCode,
        log: validation.logFile,
        ...validationFailure,
      });
      if (startedAcceptanceTask) {
        service.recordTaskFailure(plan.project_id, plan, startedAcceptanceTask, validation.finishedAt, {
          ...planAgentCliContext,
          ...validationResultSessionContextFields(validation, planAgentCliContext.agentCliProvider),
          exitCode: validation.exitCode,
          log: validation.logFile,
          acceptanceTask: true,
          ...validationFailure,
        });
      }
      // on:fail 钩子：验收失败时触发，携带错误信息与所处阶段上下文
      await service.runHookScripts(plan.project_id, 'on:fail', {
        failedStage: 'validation',
        planId: plan.id,
        validationCommand: command,
        exitCode: validation.exitCode,
        log: validation.logFile || null,
        ...validationFailure,
      });
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
  } else if (/(?:Agent CLI|Codex CLI|Claude CLI|OpenCode CLI|Oh My Pi CLI)/i.test(text)) {
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

function supportsValidationSession(provider) {
  return provider === DEFAULT_AGENT_CLI_PROVIDER || provider === 'claude';
}

function validationTaskSessionId(task, provider) {
  if (!task || !supportsValidationSession(provider)) return '';
  if (provider === DEFAULT_AGENT_CLI_PROVIDER) return operationCodexSessionId(task);
  return normalizeAgentCliSessionId(
    task.agent_cli_session_id
      || task.agentCliSessionId
      || task.claude_session_id
      || task.claudeSessionId,
  );
}

function previousValidationSessionId(service, planId, task, provider) {
  if (!supportsValidationSession(provider)) return '';
  if (task) {
    const previousTaskSession = provider === DEFAULT_AGENT_CLI_PROVIDER
      ? service.previousPlanCodexSessionId(planId, task)
      : service.previousPlanAgentCliSessionId(planId, task);
    return previousTaskSession || normalizeAgentCliSessionId(service.planAgentCliSessionId(planId));
  }
  return normalizeAgentCliSessionId(service.planAgentCliSessionId(planId))
    || latestCompletedPlanSessionId(service, planId, provider);
}

function latestCompletedPlanSessionId(service, planId, provider) {
  const sessionColumn = provider === DEFAULT_AGENT_CLI_PROVIDER ? 'codex_session_id' : 'agent_cli_session_id';
  const previousTask = service.db.get(
    `SELECT ${sessionColumn} AS session_id
     FROM plan_tasks
     WHERE plan_id = ?
       AND status = ?
       AND ${sessionColumn} IS NOT NULL
       AND ${sessionColumn} != ''
     ORDER BY sort_order DESC, id DESC
     LIMIT 1`,
    [planId, TASK_EVENT_STATUS.COMPLETED],
  );
  if (provider === DEFAULT_AGENT_CLI_PROVIDER) return normalizeCodexSessionId(previousTask?.session_id);
  return normalizeAgentCliSessionId(previousTask?.session_id);
}

function validationSessionContextFields(provider, options = {}) {
  if (!supportsValidationSession(provider)) return {};
  const sessionId = normalizeAgentCliSessionId(options.sessionId);
  const requestedId = normalizeAgentCliSessionId(options.requestedId);
  const mode = options.mode || (sessionId ? 'resume' : 'new');
  const state = options.state || mode;
  if (provider === DEFAULT_AGENT_CLI_PROVIDER) {
    return codexSessionContextFields({
      codexSessionId: sessionId,
      codexSessionRequestedId: requestedId,
      codexSessionMode: mode,
      codexSessionState: state,
      codexSessionFallback: options.fallback,
    });
  }
  return agentCliSessionContextFields('claude', {
    sessionId,
    requestedId,
    mode,
    state,
    fallback: options.fallback,
  });
}

function validationResultSessionContextFields(result, provider) {
  if (!result) return {};
  if (!supportsValidationSession(provider)) return {};
  if (provider === DEFAULT_AGENT_CLI_PROVIDER) return codexSessionContextFields(result);
  return agentCliSessionContextFields('claude', {
    sessionId: result?.agentCliSessionId || result?.claudeSessionId || result?.sessionId,
    requestedId: result?.agentCliSessionRequestedId || result?.claudeSessionRequestedId,
    mode: result?.agentCliSessionMode || result?.claudeSessionMode,
    state: result?.agentCliSessionState || result?.claudeSessionState,
    fallback: result?.agentCliSessionFallback || result?.claudeSessionFallback,
  });
}

function validationResultSessionId(result, provider) {
  if (provider === DEFAULT_AGENT_CLI_PROVIDER) return operationCodexSessionId(result);
  if (provider === 'claude') {
    return normalizeAgentCliSessionId(
      result?.agentCliSessionId
        || result?.claudeSessionId
        || result?.sessionId,
    );
  }
  return '';
}

function validationResultSessionState(result, provider) {
  if (provider === DEFAULT_AGENT_CLI_PROVIDER) {
    return result?.codexSessionState || result?.codexSessionMode || (result?.resumed ? 'resume' : 'new');
  }
  if (provider === 'claude') {
    return result?.agentCliSessionState
      || result?.claudeSessionState
      || result?.agentCliSessionMode
      || result?.claudeSessionMode
      || (result?.resumed ? 'resume' : 'new');
  }
  return 'new';
}

function attachValidationSessionContext(result, provider, sessionId, state) {
  Object.assign(result, validationSessionContextFields(provider, {
    sessionId,
    requestedId: sessionId,
    mode: sessionId ? 'resume' : 'new',
    state,
  }));
  if (provider === 'claude' && sessionId) {
    result.agentCliSessionId = sessionId;
    result.claudeSessionId = sessionId;
  }
  if (provider === DEFAULT_AGENT_CLI_PROVIDER && sessionId) {
    result.sessionId = sessionId;
    result.codexSessionId = sessionId;
  }
  return result;
}

function writeValidationSession(service, plan, task, provider, sessionId, updatedAt = nowIso()) {
  const normalizedSessionId = normalizeAgentCliSessionId(sessionId);
  if (!normalizedSessionId || !supportsValidationSession(provider)) return;
  if (!planTargetExists(service, plan)) return;
  if (task?.id) {
    if (!taskTargetExists(service, plan, task)) return;
    if (provider === DEFAULT_AGENT_CLI_PROVIDER) {
      service.updateTaskCodexSession(task.id, normalizedSessionId, updatedAt);
    } else if (provider === 'claude') {
      service.updateTaskAgentCliSession(task.id, normalizedSessionId, updatedAt);
    }
    return;
  }
  service.updatePlanAgentCliSession(plan.id, normalizedSessionId, updatedAt);
}

function planTargetExists(service, plan) {
  const planId = Number(plan?.id || 0);
  const projectId = Number(plan?.project_id || 0);
  if (!planId) return false;
  if (typeof service.planExists === 'function') return service.planExists(projectId, planId);
  return Boolean(service.db.get('SELECT 1 FROM plans WHERE id = ?', [planId]));
}

function taskTargetExists(service, plan, task) {
  const taskId = Number(task?.id || 0);
  if (!taskId) return false;
  const planId = Number(plan?.id || task?.plan_id || 0);
  const projectId = Number(plan?.project_id || 0);
  if (typeof service.taskExists === 'function') return service.taskExists(projectId, planId, taskId);
  return Boolean(service.db.get('SELECT 1 FROM plan_tasks WHERE id = ? AND plan_id = ?', [taskId, planId]));
}

function agentCliSessionContextFields(provider, options = {}) {
  const sessionId = normalizeAgentCliSessionId(options.sessionId);
  const requestedId = normalizeAgentCliSessionId(options.requestedId);
  const mode = options.mode || (sessionId ? 'resume' : 'new');
  const state = options.state || mode;
  const context = {
    agentCliSessionMode: mode,
    agentCliSessionState: state,
  };
  if (sessionId) context.agentCliSessionId = sessionId;
  if (requestedId) context.agentCliSessionRequestedId = requestedId;
  if (options.fallback) context.agentCliSessionFallback = true;
  if (provider === 'claude') {
    if (sessionId) context.claudeSessionId = sessionId;
    if (requestedId) context.claudeSessionRequestedId = requestedId;
    context.claudeSessionMode = mode;
    context.claudeSessionState = state;
    if (options.fallback) context.claudeSessionFallback = true;
  }
  return context;
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
