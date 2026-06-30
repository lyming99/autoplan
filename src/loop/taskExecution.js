const fs = require('node:fs');
const path = require('node:path');
const { nowIso } = require('../database');
const {
  DEFAULT_AGENT_CLI_PROVIDER,
  agentCliContextFields,
  agentCliProviderDisplayName,
  codexSessionContextFields,
  opencodeSessionContextFields,
  normalizeAgentCliSessionId,
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
const { MAX_PARALLEL_TASKS, taskParallelScopes } = require('./concurrency');
const { taskScopeText } = require('./planParser');
const { normalizeRelative } = require('./workspaceFiles');
const { agentCliSessionContextFields } = require('./agentCliRunner');
const {
  taskAgentCliSessionId,
  taskResultSessionId,
  taskResultSessionContextFields,
} = require('./taskSessionContext');

/** 退避重试序列：首次等待 5s，逐次递增，上限 30s */
const TASK_RETRY_BACKOFF_SECONDS = Object.freeze([5, 10, 20, 30]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isEnvironmentBlocking(result) {
  const failure = classifyExecutionFailure(result);
  return failure.environmentBlocked === true;
}

async function processPlan(service, helpers, workspace, plan) {
    plan = service.activateDraftPlan ? service.activateDraftPlan(plan) : plan;
    if (!plan) return;
    if (!planTargetExists(service, plan)) return;
    const planFile = path.join(workspace, plan.file_path);
    service.syncPlanTasks(plan.id, planFile);
    if (!planTargetExists(service, plan)) return;
    const syncedPlan = service.db.get('SELECT * FROM plans WHERE id = ?', [plan.id]);
    if (syncedPlan) plan = syncedPlan;
    const pendingTasks = service.db.all(
      `SELECT * FROM plan_tasks WHERE plan_id = ? AND status = 'pending'
       ORDER BY sort_order ASC`,
      [plan.id],
    );
    if (pendingTasks.length) {
      const firstPendingTask = pendingTasks[0];
      if (service.isFinalAcceptanceTask(plan.id, firstPendingTask)) {
        const result = await service.validatePlan(workspace, plan, { task: firstPendingTask });
        if (result?.cancelled) return;
        return;
      }
      service.setPhase(plan.project_id, 'execute-task');
      let attempt = 0;
      let result;
      do {
        if (!taskTargetExists(service, plan, firstPendingTask)) return;
        result = await service.executeTask(workspace, plan, firstPendingTask);
        if (!taskTargetExists(service, plan, firstPendingTask) || result?.cancelled) return;
        if (result.exitCode === 0) break;
        attempt++;
        if (attempt <= TASK_RETRY_BACKOFF_SECONDS.length && !isEnvironmentBlocking(result)) {
          const delaySeconds = TASK_RETRY_BACKOFF_SECONDS[attempt - 1];
          service.addEvent(plan.project_id, 'task.retry',
            `任务 ${firstPendingTask.task_key} 第 ${attempt} 次重试，等待 ${delaySeconds}s`,
            {
              planId: plan.id,
              taskId: firstPendingTask.id,
              taskKey: firstPendingTask.task_key,
              attempt,
              delaySeconds,
            });
          await sleep(delaySeconds * 1000);
          if (!taskTargetExists(service, plan, firstPendingTask)) return;
        }
      } while (result.exitCode !== 0 && attempt <= TASK_RETRY_BACKOFF_SECONDS.length && !isEnvironmentBlocking(result));
      if (result.exitCode === 0) {
        await service.completeTask(workspace, plan, firstPendingTask, result);
      }
      return;
    }
    if (service.hasFinalAcceptanceTask(plan.id)) {
      const currentPlan = service.db.get('SELECT status, validation_passed FROM plans WHERE id = ?', [plan.id]);
      if (currentPlan?.validation_passed || currentPlan?.status === 'completed') return;
    }
    const result = await service.validatePlan(workspace, plan);
    if (result?.cancelled) return;
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

function previousPlanAgentCliSessionId(service, helpers, planId, task) {
    if (!task) return '';
    const previousTask = service.db.get(
      `SELECT agent_cli_session_id
       FROM plan_tasks
       WHERE plan_id = ?
         AND status = ?
         AND agent_cli_session_id IS NOT NULL
         AND agent_cli_session_id != ''
         AND (sort_order < ? OR (sort_order = ? AND id < ?))
       ORDER BY sort_order DESC, id DESC
       LIMIT 1`,
      [planId, TASK_EVENT_STATUS.COMPLETED, task.sort_order || 0, task.sort_order || 0, task.id || 0],
    );
    return normalizeAgentCliSessionId(previousTask?.agent_cli_session_id);
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
    if (agentContext.agentCliProvider === 'opencode') {
      service.addEvent(
        plan.project_id,
        'tasks.parallel.serialized',
        `OpenCode 会话复用已将并发批次转为串行执行：${tasks.map((task) => task.task_key).join(', ')}`,
        {
          ...agentContext,
          planId: plan.id,
          taskIds: tasks.map((task) => task.id),
          batchIndex: options.batchIndex,
          batchCount: options.batchCount,
        },
      );
      const results = [];
      for (const task of tasks) {
        let result = null;
        try {
          let attempt = 0;
          do {
            if (!taskTargetExists(service, plan, task)) {
              result = cancelledTaskResult();
              break;
            }
            result = await service.executeTask(workspace, plan, task, { parallel: false });
            if (!taskTargetExists(service, plan, task) || result?.cancelled) {
              result = cancelledTaskResult(result);
              break;
            }
            if (result.exitCode === 0) break;
            attempt++;
            if (attempt <= TASK_RETRY_BACKOFF_SECONDS.length && !isEnvironmentBlocking(result)) {
              const delaySeconds = TASK_RETRY_BACKOFF_SECONDS[attempt - 1];
              service.addEvent(plan.project_id, 'task.retry',
                `任务 ${task.task_key} 第 ${attempt} 次重试，等待 ${delaySeconds}s`,
                {
                  planId: plan.id,
                  taskId: task.id,
                  taskKey: task.task_key,
                  attempt,
                  delaySeconds,
                });
              await sleep(delaySeconds * 1000);
              if (!taskTargetExists(service, plan, task)) {
                result = cancelledTaskResult(result);
                break;
              }
            }
          } while (result.exitCode !== 0 && attempt <= TASK_RETRY_BACKOFF_SECONDS.length && !isEnvironmentBlocking(result));
        } catch (error) {
          const finishedAt = nowIso();
          if (!taskTargetExists(service, plan, task)) {
            results.push({ task, result: { exitCode: -1, finishedAt, cancelled: true } });
            break;
          }
          if (!taskLifecycleEventRecorded(error)) {
            service.recordTaskFailure(plan.project_id, plan, task, finishedAt, {
              error: error?.message || String(error),
            });
          }
          results.push({ task, result: { exitCode: -1, finishedAt } });
          break;
        }
        if (!taskTargetExists(service, plan, task) || result?.cancelled) {
          results.push({ task, result: cancelledTaskResult(result) });
          break;
        }
        if (result.exitCode === 0) {
          await service.completeTask(workspace, plan, task, result);
        }
        results.push({ task, result });
        if (result.exitCode !== 0) break;
      }
      return results;
    }
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
        let result = null;
        try {
          let attempt = 0;
          do {
            if (!taskTargetExists(service, plan, task)) {
              result = cancelledTaskResult();
              break;
            }
            result = await service.executeTask(workspace, plan, task, { parallel: true });
            if (!taskTargetExists(service, plan, task) || result?.cancelled) {
              result = cancelledTaskResult(result);
              break;
            }
            if (result.exitCode === 0) break;
            attempt++;
            if (attempt <= TASK_RETRY_BACKOFF_SECONDS.length && !isEnvironmentBlocking(result)) {
              const delaySeconds = TASK_RETRY_BACKOFF_SECONDS[attempt - 1];
              service.addEvent(plan.project_id, 'task.retry',
                `任务 ${task.task_key} 第 ${attempt} 次重试，等待 ${delaySeconds}s`,
                {
                  planId: plan.id,
                  taskId: task.id,
                  taskKey: task.task_key,
                  attempt,
                  delaySeconds,
                },
              );
              await sleep(delaySeconds * 1000);
              if (!taskTargetExists(service, plan, task)) {
                result = cancelledTaskResult(result);
                break;
              }
            }
          } while (result.exitCode !== 0 && attempt <= TASK_RETRY_BACKOFF_SECONDS.length && !isEnvironmentBlocking(result));
        } catch (error) {
          const finishedAt = nowIso();
          if (!taskTargetExists(service, plan, task)) {
            return { task, result: { exitCode: -1, finishedAt, cancelled: true } };
          }
          if (!taskLifecycleEventRecorded(error)) {
            service.recordTaskFailure(plan.project_id, plan, task, finishedAt, {
              error: error?.message || String(error),
            });
          }
          return { task, result: { exitCode: -1, finishedAt } };
        }
        if (!taskTargetExists(service, plan, task) || result?.cancelled) return { task, result: cancelledTaskResult(result) };
        if (result.exitCode === 0) {
          await service.completeTask(workspace, plan, task, result);
        }
        return { task, result };
      }),
    );
    return results;
  }

async function executeTask(service, helpers, workspace, plan, task, options = {}) {
  const { tailText } = helpers;
    if (!taskTargetExists(service, plan, task)) {
      return { exitCode: -1, output: '', errorMessage: '任务目标已删除', cancelled: true, finishedAt: nowIso() };
    }
    service.setPhase(plan.project_id, 'execute-task');
    const startedAt = nowIso();
    const startedTask = service.startTaskRun(task.id, startedAt) || task;
    if (!taskTargetExists(service, plan, startedTask)) {
      return { exitCode: -1, output: '', errorMessage: '任务目标已删除', cancelled: true, finishedAt: nowIso() };
    }
    const taskAgentCliContext = agentCliContextFields(service.planAgentCliConfig(plan), { defaultProvider: true });
    const isTaskCodexProvider = taskAgentCliContext.agentCliProvider === DEFAULT_AGENT_CLI_PROVIDER;
    const isTaskClaudeProvider = taskAgentCliContext.agentCliProvider === 'claude';
    const isTaskOpenCodeProvider = taskAgentCliContext.agentCliProvider === 'opencode';
    const taskSessionId = isTaskCodexProvider
      ? operationCodexSessionId(startedTask)
      : isTaskClaudeProvider
        ? taskAgentCliSessionId(startedTask)
        : '';
    const planSessionId = (isTaskCodexProvider || isTaskClaudeProvider) && !options.parallel
      ? (isTaskCodexProvider
          ? service.previousPlanCodexSessionId(plan.id, startedTask)
          : service.previousPlanAgentCliSessionId(plan.id, startedTask))
      : '';
    const openCodeSessionId = isTaskOpenCodeProvider ? service.planAgentCliSessionId(plan.id) : '';
    const existingSessionId = taskSessionId || planSessionId;
    const inheritedPlanSession = Boolean(!taskSessionId && planSessionId);
    const startedSessionContext = isTaskCodexProvider
      ? codexSessionContextFields({
          codexSessionId: existingSessionId,
          codexSessionMode: existingSessionId ? 'resume' : 'new',
          codexSessionState: inheritedPlanSession ? 'plan-resume' : undefined,
        })
      : isTaskClaudeProvider
        ? agentCliSessionContextFields('claude', {
            sessionId: existingSessionId,
            requestedId: existingSessionId,
            mode: existingSessionId ? 'resume' : 'new',
            state: inheritedPlanSession ? 'plan-resume' : undefined,
          })
      : isTaskOpenCodeProvider
        ? opencodeSessionContextFields({
            opencodeSessionId: openCodeSessionId,
            opencodeSessionMode: openCodeSessionId ? 'resume' : 'new',
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
    clearTaskCompletionMarkInPlan(planFile, startedTask);
    const completionRules = [
      '- 这是无人值守执行：不要提问、不要请求确认、不要等待用户输入，所有不确定项自行基于代码推断并直接落地修改',
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
      completionRules.unshift(`- 当前任务已恢复同一 plan 前序任务的 ${agentCliProviderDisplayName(taskAgentCliContext.agentCliProvider)} 会话，请沿用已有分析结论和修改背景，避免重新从零梳理`);
    }
    if (options.parallel) {
      completionRules.unshift('- 当前为并发执行模式，不要读写其它任务的 scope');
    }
    const prompt = [
      '你是开发执行者，在无人值守模式下工作：禁止反问用户、禁止请求确认或补充信息、禁止输出“请告诉我…/是否需要…”之类等待回复的话；遇到不确定一律自行从代码推断，按最合理的工程方案直接推进，不要停下来等待输入。',
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
        ...startedSessionContext,
        ...(isTaskCodexProvider && existingSessionId ? { codexSessionId: existingSessionId } : {}),
        ...(isTaskClaudeProvider && existingSessionId ? { agentCliSessionId: existingSessionId } : {}),
        ...(isTaskCodexProvider && inheritedPlanSession ? { codexSessionState: 'plan-resume' } : {}),
        ...(isTaskClaudeProvider && inheritedPlanSession ? { agentCliSessionState: 'plan-resume' } : {}),
      }, planFile);
    } catch (error) {
      const finishedAt = nowIso();
      if (!taskTargetExists(service, plan, task)) {
        markTaskLifecycleEventRecorded(error);
        return { exitCode: -1, output: '', errorMessage: '任务目标已删除', cancelled: true, finishedAt };
      }
      const errorMessage = error?.message || String(error);
      const failure = classifyExecutionFailure({ exitCode: -1, errorMessage });
      const failedTask = service.recordTaskFailure(plan.project_id, plan, task, finishedAt, {
        ...taskAgentCliContext,
        error: errorMessage,
        ...failure,
        ...startedSessionContext,
      });
      if (failedTask) markTaskLifecycleEventRecorded(error);
      await service.runHookScripts(plan.project_id, 'on:fail', {
        failedStage: 'task',
        planId: plan.id,
        taskId: task.id,
        taskKey: task.task_key,
        error: errorMessage,
        ...failure,
      });
      throw error;
    }
    const finishedAt = nowIso();
    result.finishedAt = finishedAt;
    if (!taskTargetExists(service, plan, task)) {
      return { ...result, exitCode: -1, cancelled: true };
    }
    const capturedSessionId = taskResultSessionId(result);
    if (capturedSessionId) {
      if (result.agentCliProvider === DEFAULT_AGENT_CLI_PROVIDER) {
        service.updateTaskCodexSession(task.id, capturedSessionId, finishedAt);
      } else if (result.agentCliProvider === 'claude') {
        service.updateTaskAgentCliSession(task.id, capturedSessionId, finishedAt);
      }
    }
    const succeeded = result.exitCode === 0;
    if (!succeeded) {
      if (!taskTargetExists(service, plan, task)) {
        return { ...result, exitCode: -1, cancelled: true };
      }
      const failure = classifyExecutionFailure(result);
      service.recordTaskFailure(plan.project_id, plan, task, finishedAt, {
        ...agentCliContextFields(result, { defaultProvider: true }),
        exitCode: result.exitCode,
        log: result.logFile,
        ...failure,
        ...taskResultSessionContextFields(result),
      });
      await service.runHookScripts(plan.project_id, 'on:fail', {
        failedStage: 'task',
        planId: plan.id,
        taskId: task.id,
        taskKey: task.task_key,
        exitCode: result.exitCode,
        log: result.logFile || null,
        ...failure,
      });
    }
    return result;
  }

async function completeTask(service, helpers, workspace, plan, task, result) {
    if (!taskTargetExists(service, plan, task)) return null;
    const planFile = path.join(workspace, plan.file_path);
    const finishedAt = result?.finishedAt || nowIso();
    service.markTaskCompletedInPlan(workspace, planFile, task, result);
    if (!taskTargetExists(service, plan, task)) return null;
    const completedTask = service.finishTaskRun(task.id, TASK_EVENT_STATUS.COMPLETED, finishedAt) || task;
    if (!taskTargetExists(service, plan, completedTask)) return null;
    service.addTaskLifecycleEvent(plan.project_id, TASK_EVENT_TYPES.SUCCEEDED, completedTask, {
      ...agentCliContextFields(result, { defaultProvider: true }),
      planId: plan.id,
      status: TASK_EVENT_STATUS.COMPLETED,
      finishedAt,
      exitCode: result?.exitCode,
      log: result?.logFile,
      ...taskResultSessionContextFields(result),
    });
    service.refreshPlanProgress(plan.id, planFile);
    service.emitUpdate(plan.project_id);
    // task:after 钩子：单任务执行成功后触发，携带 plan/task/workspace/结果
    await service.runHookScripts(plan.project_id, 'task:after', {
      planId: plan.id,
      planFilePath: plan.file_path,
      taskId: completedTask.id,
      taskKey: completedTask.task_key,
      scopeFiles: parseScopeFiles(completedTask.scope),
      exitCode: result?.exitCode,
      log: result?.logFile || null,
    });
    return completedTask;
}

function parseScopeFiles(scope) {
  return String(scope || '').split(',').map((part) => part.trim()).filter(Boolean);
}

function refreshPlanProgress(service, helpers, planId, planFile) {
  const { hashFile } = helpers;
    const persistedPlan = service.db.get('SELECT * FROM plans WHERE id = ?', [planId]);
    if (!persistedPlan) return null;
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
    return service.db.get('SELECT * FROM plans WHERE id = ?', [planId]);
  }

function clearTaskCompletionMarkInPlan(planFile, task) {
    if (!fs.existsSync(planFile)) return;
    const key = escapeRegExp(String(task.task_key || ''));
    // 将 checkbox 从 [x]/[X] 重置为 [ ]（pending 态）
    const checkboxRe = new RegExp(`(^\\s*[-*]\\s+\\[)([ xX])(\\]\\s+${key}(?:\\b|[:：\\s-]))`, 'm');
    let content = fs.readFileSync(planFile, 'utf8');
    content = content.replace(checkboxRe, '$1 $3');
    // 移除 "AutoPlan 完成" 注释行
    const noteRe = new RegExp(`^\\s*-\\s+${key}\\s+AutoPlan 完成：.*$\\n?`, 'm');
    content = content.replace(noteRe, '');
    fs.writeFileSync(planFile, content, 'utf8');
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

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

function cancelledTaskResult(result = {}) {
  return {
    ...result,
    exitCode: -1,
    cancelled: true,
    errorMessage: result.errorMessage || '任务目标已删除',
    finishedAt: result.finishedAt || nowIso(),
  };
}

module.exports = {
  completeTask,
  executeTask,
  executeTaskBatch,
  markTaskCompletedInPlan,
  parallelTaskBatch,
  previousPlanAgentCliSessionId,
  previousPlanCodexSessionId,
  processPlan,
  refreshPlanProgress,
  TASK_RETRY_BACKOFF_SECONDS,
};

