const fs = require('node:fs');
const path = require('node:path');
const { nowIso } = require('../database');
const {
  DEFAULT_AGENT_CLI_PROVIDER,
  agentCliContextFields,
  codexSessionContextFields,
  normalizeCodexSessionId,
  operationCodexSessionId,
} = require('./agentCliConfig');
const {
  TASK_EVENT_STATUS,
  TASK_EVENT_TYPES,
  markTaskLifecycleEventRecorded,
  taskLifecycleEventRecorded,
} = require('./taskEvents');
const { classifyExecutionFailure } = require('./validation');

async function processPlan(service, helpers, workspace, plan) {
    plan = service.activateDraftPlan ? service.activateDraftPlan(plan) : plan;
    const planFile = path.join(workspace, plan.file_path);
    service.syncPlanTasks(plan.id, planFile);
    const pendingTasks = service.db.all(
      `SELECT * FROM plan_tasks WHERE plan_id = ? AND status = 'pending'
       ORDER BY sort_order ASC`,
      [plan.id],
    );
    if (pendingTasks.length) {
      const firstPendingTask = pendingTasks[0];
      if (service.isFinalAcceptanceTask(plan.id, firstPendingTask)) {
        await service.validatePlan(workspace, plan, { task: firstPendingTask });
        return;
      }
      const result = await service.executeTask(workspace, plan, firstPendingTask);
      if (result.exitCode === 0) {
        service.completeTask(workspace, plan, firstPendingTask, result);
      }
      return;
    }
    if (service.hasFinalAcceptanceTask(plan.id)) {
      const currentPlan = service.db.get('SELECT status, validation_passed FROM plans WHERE id = ?', [plan.id]);
      if (currentPlan?.validation_passed || currentPlan?.status === 'completed') return;
    }
    await service.validatePlan(workspace, plan);
  }

function previousPlanCodexSessionId(service, helpers, planId, task) {
    if (!task) return '';
    const previousTask = service.db.get(
      `SELECT codex_session_id
       FROM plan_tasks
       WHERE plan_id = ?
         AND status = ?
         AND codex_session_id IS NOT NULL
         AND codex_session_id != ''
         AND (sort_order < ? OR (sort_order = ? AND id < ?))
       ORDER BY sort_order DESC, id DESC
       LIMIT 1`,
      [planId, TASK_EVENT_STATUS.COMPLETED, task.sort_order || 0, task.sort_order || 0, task.id || 0],
    );
    return normalizeCodexSessionId(previousTask?.codex_session_id);
  }

function parallelTaskBatch(service, helpers, tasks) {
    const selected = [];
    const usedScopes = new Set();
    for (const task of tasks) {
      if (selected.length >= MAX_PARALLEL_TASKS) break;
      const scopes = taskParallelScopes(task);
      if (!scopes.length) {
        if (!selected.length) return [task];
        continue;
      }
      if (scopes.some((scope) => usedScopes.has(scope))) continue;
      selected.push(task);
      for (const scope of scopes) usedScopes.add(scope);
    }
    return selected.length > 1 ? selected : [tasks[0]];
  }

async function executeTaskBatch(service, helpers, workspace, plan, tasks, options = {}) {
    service.setPhase(plan.project_id, 'execute-task');
    const agentContext = agentCliContextFields(service.planAgentCliConfig(plan), { defaultProvider: true });
    service.addEvent(
      plan.project_id,
      'tasks.parallel.started',
      `${agentCliProviderDisplayName(agentContext.agentCliProvider)} 并发执行 ${tasks.map((task) => task.task_key).join(', ')}`,
      {
        ...agentContext,
        planId: plan.id,
        taskIds: tasks.map((task) => task.id),
        batchIndex: options.batchIndex,
        batchCount: options.batchCount,
      },
    );
    const results = await Promise.all(
      tasks.map(async (task) => {
        let result;
        try {
          result = await service.executeTask(workspace, plan, task, { parallel: true });
        } catch (error) {
          const finishedAt = nowIso();
          if (!taskLifecycleEventRecorded(error)) {
            service.recordTaskFailure(plan.project_id, plan, task, finishedAt, {
              error: error?.message || String(error),
            });
          }
          return { task, result: { exitCode: -1, finishedAt } };
        }
        if (result.exitCode === 0) {
          service.completeTask(workspace, plan, task, result);
        }
        return { task, result };
      }),
    );
    return results;
  }

async function executeTask(service, helpers, workspace, plan, task, options = {}) {
  const { tailText } = helpers;
    service.setPhase(plan.project_id, 'execute-task');
    const startedAt = nowIso();
    const startedTask = service.startTaskRun(task.id, startedAt) || task;
    const taskAgentCliContext = agentCliContextFields(service.planAgentCliConfig(plan), { defaultProvider: true });
    const isTaskCodexProvider = taskAgentCliContext.agentCliProvider === DEFAULT_AGENT_CLI_PROVIDER;
    const taskSessionId = isTaskCodexProvider ? operationCodexSessionId(startedTask) : '';
    const planSessionId = isTaskCodexProvider && !options.parallel
      ? service.previousPlanCodexSessionId(plan.id, startedTask)
      : '';
    const existingSessionId = taskSessionId || planSessionId;
    const inheritedPlanSession = Boolean(!taskSessionId && planSessionId);
    const startedSessionContext = isTaskCodexProvider
      ? codexSessionContextFields({
          codexSessionId: existingSessionId,
          codexSessionMode: existingSessionId ? 'resume' : 'new',
          codexSessionState: inheritedPlanSession ? 'plan-resume' : undefined,
        })
      : {};
    service.addTaskLifecycleEvent(plan.project_id, TASK_EVENT_TYPES.STARTED, startedTask, {
      ...taskAgentCliContext,
      planId: plan.id,
      status: TASK_EVENT_STATUS.RUNNING,
      startedAt,
      ...startedSessionContext,
    });
    const planFile = path.join(workspace, plan.file_path);
    const completionRules = [
      '- plan 文件是只读上下文：不要修改 plan 文件，不要勾选 checkbox，不要更新 plan 进度区',
      '- AutoPlan 会在任务成功后统一写回数据库、checkbox 和进度区',
      '- 只修改当前任务 scope 直接相关的业务文件',
      '- 当前阶段只做开发修改，不运行测试、回归、验收、构建、lint/analyze、coverage、e2e 或 benchmark 命令；AutoPlan 会在所有任务完成后统一执行最终验收命令',
      '- 即使任务验收要点提到测试，也只补充或调整必要代码/测试文件，不在当前任务内启动测试进程；除非当前任务或 plan 总体说明明确写着“本任务必须执行某命令”',
      '- 若识别到 Flutter/Dart 项目，可遵循其代码组织、格式和测试文件约定，但当前任务内不要运行 flutter test、dart test、flutter analyze 或 dart analyze',
      '- 如果工具链命令因 PathAccessException、Permission denied、拒绝访问或超时失败，停止重试并说明环境阻塞，把验证留给最终验收阶段',
      '- 不输出完整 diff、源码全文或长文件列表',
      '- 中文文件读写使用 UTF-8',
    ];
    if (inheritedPlanSession) {
      completionRules.unshift('- 当前任务已恢复同一 plan 前序任务的 Codex 会话，请沿用已有分析结论和修改背景，避免重新从零梳理');
    }
    if (options.parallel) {
      completionRules.unshift('- 当前为并发执行模式，不要读写其它任务的 scope');
    }
    const prompt = [
      '你是开发执行者。',
      `请只执行指定任务 ${task.task_key}，不要提前执行其它任务，也不要顺手处理其它 checkbox。`,
      '',
      `plan 文件（只读）：${planFile}`,
      `指定任务：${task.raw_line}`,
      `任务 scope：${task.scope || taskScopeText(task) || 'unknown'}`,
      '',
      '完成后必须：',
      ...completionRules,
    ].join('\n');
    let result;
    try {
      result = await service.runCodexWithPlanGuard(workspace, prompt, `execute-${task.task_key}`, {
        projectId: plan.project_id,
        planId: plan.id,
        taskId: task.id,
        parallel: Boolean(options.parallel),
        ...taskAgentCliContext,
        ...(isTaskCodexProvider && existingSessionId ? { codexSessionId: existingSessionId } : {}),
        ...(inheritedPlanSession ? { codexSessionState: 'plan-resume' } : {}),
      }, planFile);
    } catch (error) {
      const finishedAt = nowIso();
      const errorMessage = error?.message || String(error);
      const failure = classifyExecutionFailure({ exitCode: -1, errorMessage });
      const failedTask = service.recordTaskFailure(plan.project_id, plan, task, finishedAt, {
        ...taskAgentCliContext,
        error: errorMessage,
        ...failure,
        ...startedSessionContext,
      });
      if (failedTask) markTaskLifecycleEventRecorded(error);
      throw error;
    }
    const finishedAt = nowIso();
    result.finishedAt = finishedAt;
    const capturedSessionId = operationCodexSessionId(result);
    if (capturedSessionId) service.updateTaskCodexSession(task.id, capturedSessionId, finishedAt);
    const succeeded = result.exitCode === 0;
    if (!succeeded) {
      const failure = classifyExecutionFailure(result);
      service.recordTaskFailure(plan.project_id, plan, task, finishedAt, {
        ...agentCliContextFields(result, { defaultProvider: true }),
        exitCode: result.exitCode,
        log: result.logFile,
        ...failure,
        ...(result.agentCliProvider === DEFAULT_AGENT_CLI_PROVIDER ? codexSessionContextFields(result) : {}),
      });
    }
    return result;
  }

function completeTask(service, helpers, workspace, plan, task, result) {
    const planFile = path.join(workspace, plan.file_path);
    const finishedAt = result?.finishedAt || nowIso();
    service.markTaskCompletedInPlan(workspace, planFile, task, result);
    const completedTask = service.finishTaskRun(task.id, TASK_EVENT_STATUS.COMPLETED, finishedAt) || task;
    service.addTaskLifecycleEvent(plan.project_id, TASK_EVENT_TYPES.SUCCEEDED, completedTask, {
      ...agentCliContextFields(result, { defaultProvider: true }),
      planId: plan.id,
      status: TASK_EVENT_STATUS.COMPLETED,
      finishedAt,
      exitCode: result?.exitCode,
      log: result?.logFile,
      ...(result?.agentCliProvider === DEFAULT_AGENT_CLI_PROVIDER ? codexSessionContextFields(result) : {}),
    });
    service.refreshPlanProgress(plan.id, planFile);
    service.emitUpdate(plan.project_id);
  }

function refreshPlanProgress(service, helpers, planId, planFile) {
  const { hashFile } = helpers;
    const totals = service.db.get(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed
       FROM plan_tasks
       WHERE plan_id = ?`,
      [planId],
    ) || { total: 0, completed: 0 };
    const total = Number(totals.total || 0);
    const completed = Number(totals.completed || 0);
    const status = total > 0 && completed === total ? 'ready_for_validation' : 'running';
    const hash = fs.existsSync(planFile) ? hashFile(planFile) : '';
    service.db.run(
      'UPDATE plans SET hash = ?, status = ?, total_tasks = ?, completed_tasks = ?, updated_at = ? WHERE id = ?',
      [hash, status, total, completed, nowIso(), planId],
    );
  }

function markTaskCompletedInPlan(service, helpers, workspace, planFile, task, result) {
    if (!fs.existsSync(planFile)) return;
    const relativeLog = result?.logFile ? normalizeRelative(workspace, result.logFile) : '';
    const key = escapeRegExp(String(task.task_key || ''));
    const checkboxRe = new RegExp(`(^\\s*[-*]\\s+\\[)([ xX])(\\]\\s+${key}(?:\\b|[:：\\s-]))`, 'm');
    let content = fs.readFileSync(planFile, 'utf8');
    if (checkboxRe.test(content)) {
      content = content.replace(checkboxRe, '$1x$3');
    }

    const note = `- ${task.task_key} AutoPlan 完成：${nowIso()}${relativeLog ? `；日志：${relativeLog}` : ''}`;
    const noteRe = new RegExp(`^\\s*-\\s+${key}\\s+AutoPlan 完成：.*$`, 'm');
    if (noteRe.test(content)) {
      content = content.replace(noteRe, note);
    } else if (/##\s*进度区/.test(content)) {
      content = `${content.trimEnd()}\n${note}\n`;
    } else {
      content = `${content.trimEnd()}\n\n## 进度区\n${note}\n`;
    }
    fs.writeFileSync(planFile, content, 'utf8');
  }

module.exports = {
  completeTask,
  executeTask,
  executeTaskBatch,
  markTaskCompletedInPlan,
  parallelTaskBatch,
  previousPlanCodexSessionId,
  processPlan,
  refreshPlanProgress,
};
