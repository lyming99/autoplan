const { spawn } = require('node:child_process');
const { nowIso } = require('../database');
const {
  DEFAULT_AGENT_CLI_PROVIDER,
  agentCliContextFields,
  codexSessionContextFields,
  opencodeSessionContextFields,
} = require('./agentCliConfig');
const {
  TASK_EVENT_STATUS,
  TASK_EVENT_TYPES,
} = require('./taskEvents');

const ACTIVE_RUNTIME_PHASES = new Set(['running', 'scan', 'generate-plan', 'execute-task', 'validate']);
const ACTIVE_RUNTIME_PHASE_SQL = "('running','scan','generate-plan','execute-task','validate')";
const DEFAULT_UPDATE_THROTTLE_MS = 3000;

/**
 * plugin 持久进程注册表：key `${projectId}:${executorId}` → 子进程句柄。
 * 与 executorRunner.pluginProcesses 单一来源协作：本表登记直接注册的进程，
 * 查找/停止时未命中则委托给 executorRunner（lazy require，规避循环依赖）。
 */
const activePluginProcesses = new Map();

function createProjectRuntime() {
  return {
    timer: null,
    running: false,
    busy: false,
    activeChild: null,
    activeOperation: null,
    activeChildren: new Map(),
    activeOperations: new Map(),
    lastOperation: null,
  };
}

function createThrottledUpdateEmitter(options = {}) {
  const throttleMs = Number(options.throttleMs || DEFAULT_UPDATE_THROTTLE_MS);
  const pendingTimers = new Map();
  const pendingModes = new Map();
  const lastEmittedAt = new Map();
  const snapshot = options.snapshot;
  const patch = options.patch;
  const emit = options.emit;
  const emitPatch = options.emitPatch;

  const modeFor = (scheduleOptions = {}) =>
    scheduleOptions.lightweight && typeof patch === 'function' && typeof emitPatch === 'function'
      ? 'patch'
      : 'snapshot';

  const flushKey = (key, projectId, mode = pendingModes.get(key) || 'snapshot') => {
    const timer = pendingTimers.get(key);
    if (timer) clearTimeout(timer);
    pendingTimers.delete(key);
    pendingModes.delete(key);
    lastEmittedAt.set(key, Date.now());
    if (mode === 'patch') emitPatch(patch(projectId));
    else emit(snapshot(projectId));
  };

  const schedule = (projectId, scheduleOptions = {}) => {
    const key = String(projectId || 'all');
    const mode = modeFor(scheduleOptions);
    if (scheduleOptions.immediate) {
      const pendingMode = pendingModes.get(key);
      flushKey(key, projectId, pendingMode === 'snapshot' && mode === 'patch' ? 'snapshot' : mode);
      return;
    }

    const elapsed = Date.now() - (lastEmittedAt.get(key) || 0);
    if (elapsed >= throttleMs) {
      flushKey(key, projectId, mode);
      return;
    }
    if (pendingTimers.has(key)) {
      if (mode === 'snapshot') pendingModes.set(key, mode);
      return;
    }
    pendingModes.set(key, mode);
    const timer = setTimeout(() => flushKey(key, projectId), throttleMs - elapsed);
    if (typeof timer.unref === 'function') timer.unref();
    pendingTimers.set(key, timer);
  };

  return {
    emit: schedule,
    flush() {
      for (const key of Array.from(pendingTimers.keys())) {
        flushKey(key, key === 'all' ? null : Number(key));
      }
    },
  };
}

function ensureProjectRuntime(runtimes, projectId) {
  const id = Number(projectId || 0);
  if (!id) return null;
  let runtime = runtimes.get(id);
  if (!runtime) {
    runtime = createProjectRuntime();
    runtimes.set(id, runtime);
  }
  return runtime;
}

function existingProjectRuntime(runtimes, projectId) {
  return runtimes.get(Number(projectId || 0)) || null;
}

function normalizeRuntimePhase(phase, runtime) {
  const current = phase || 'idle';
  if (!runtime?.running && !runtime?.busy && ACTIVE_RUNTIME_PHASES.has(String(current || ''))) return 'stopped';
  return current;
}

function runtimeProjectSummary(project, state = {}, runtime = null, agentCliConfig) {
  return {
    ...project,
    running: runtime?.running ? 1 : 0,
    phase: normalizeRuntimePhase(state.phase || 'idle', runtime),
    interval_seconds: Number(state.interval_seconds || 5),
    validation_command: state.validation_command || '',
    project_prompt: state.project_prompt ?? '',
    agent_cli_provider: agentCliConfig.provider,
    agent_cli_command: agentCliConfig.command,
  };
}

function normalizeRuntimeStatus(state, runtime = null, agentCliConfig) {
  if (!state) return null;
  const runtimeRunning = Boolean(runtime?.running);
  const normalized = {
    ...state,
    running: runtimeRunning ? 1 : 0,
    validation_command: state.validation_command ?? '',
    project_prompt: state.project_prompt ?? '',
    agent_cli_provider: agentCliConfig.provider,
    agent_cli_command: agentCliConfig.command,
    codex_reasoning_effort: agentCliConfig.codexReasoningEffort,
  };
  normalized.phase = normalizeRuntimePhase(normalized.phase, runtime);
  return normalized;
}

function resetStoredRuntimeState(db, now = nowIso()) {
  const statements = [
    {
      sql: `UPDATE project_states
            SET running = 0,
                phase = CASE WHEN phase IN ${ACTIVE_RUNTIME_PHASE_SQL} THEN 'stopped' ELSE phase END,
                updated_at = ?
            WHERE running != 0 OR phase IN ${ACTIVE_RUNTIME_PHASE_SQL}`,
      params: [now],
    },
    {
      sql: `UPDATE loop_state
            SET running = 0,
                phase = CASE WHEN phase IN ${ACTIVE_RUNTIME_PHASE_SQL} THEN 'stopped' ELSE phase END,
                updated_at = ?
            WHERE id = 1 AND (running != 0 OR phase IN ${ACTIVE_RUNTIME_PHASE_SQL})`,
      params: [now],
    },
    {
      sql: 'UPDATE plan_tasks SET status = ?, updated_at = ? WHERE status = ?',
      params: ['pending', now, 'running'],
    },
  ];
  if (typeof db.runBatch === 'function') {
    db.runBatch(statements);
    return;
  }
  for (const statement of statements) db.run(statement.sql, statement.params);
}

function scheduleProjectRuntime(runtime, intervalSeconds, runOnce) {
  if (!runtime) return;
  if (runtime.timer) clearInterval(runtime.timer);
  const intervalMs = Math.max(5, Number(intervalSeconds || 5)) * 1000;
  runtime.timer = setInterval(() => {
    if (!runtime.running) return;
    runOnce();
  }, intervalMs);
}

/** 创建一个会 unref 的 setInterval（不阻塞进程退出），沿用 scheduleProjectRuntime 的 timer 句柄风格。
 *  供全局定时调度器等「进程空闲时应自动退出」的周期任务复用；返回 timer 句柄供 clearInterval。 */
function createUnrefInterval(callback, ms) {
  const timer = setInterval(callback, ms);
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}

function findActiveRuntimeProject(runtimes, workspace, projectId, projectForId, workspaceKey) {
  const key = workspaceKey(workspace);
  if (!key) return null;
  for (const [id, runtime] of runtimes.entries()) {
    if (Number(id) === Number(projectId)) continue;
    if (!runtime.running && !runtime.busy && !runtime.activeChild) continue;
    const project = projectForId(id);
    if (workspaceKey(project?.workspace_path) === key) return project;
  }
  return null;
}

function stopProjectRuntime(projectId, runtime, callbacks) {
  if (runtime?.timer) clearInterval(runtime.timer);
  if (runtime) {
    runtime.timer = null;
    runtime.running = false;
  }
  if (runtime?.activeOperations?.size) {
    for (const [operationKey, operation] of Array.from(runtime.activeOperations.entries())) {
      const child = runtime.activeChildren.get(operationKey);
      const activeTaskId = operation?.taskId || null;
      const finishedAt = nowIso();
      killChildProcess(child);
      const activeTask = activeTaskId ? callbacks.taskForProject(projectId, activeTaskId) : null;
      const stoppedTask = activeTaskId
        ? callbacks.finishTaskRun(activeTaskId, TASK_EVENT_STATUS.PENDING, finishedAt, { onlyIfRunning: true })
        : null;
      const eventTask = stoppedTask || activeTask || (activeTaskId ? { id: activeTaskId, plan_id: operation?.planId } : null);
      if (eventTask) {
        callbacks.addTaskLifecycleEvent(projectId, TASK_EVENT_TYPES.STOPPED, eventTask, {
          ...agentCliContextFields(operation, { defaultProvider: true }),
          status: TASK_EVENT_STATUS.STOPPED,
          finishedAt,
          log: operation?.logFile,
          exitCode: typeof operation?.exitCode === 'number' ? operation.exitCode : undefined,
        });
      } else {
        callbacks.addEvent(projectId, 'operation.stopping', operation?.label || '');
      }
    }
  }
  // 清理该项目全部 plugin 持久进程（本表 + executorRunner 注册表）
  try { clearRuntimePluginProcesses(projectId); } catch { /* ignore */ }
  callbacks.markStopped(projectId);
  callbacks.addEvent(projectId, 'loop.stopped', '循环已停止');
  callbacks.emitUpdate(projectId);
}

function stopRuntimeTask(projectId, taskId, task, runtime, callbacks) {
  const activeEntry = findRuntimeOperation(runtime, (operation) => Number(operation?.taskId) === Number(taskId));
  if (activeEntry) {
    killChildProcess(activeEntry.child);
    const finishedAt = nowIso();
    const stoppedTask = runtime?.running
      ? task
      : callbacks.finishTaskRun(taskId, TASK_EVENT_STATUS.PENDING, finishedAt, { onlyIfRunning: true }) || task;
    if (!runtime.running) {
      callbacks.addTaskLifecycleEvent(projectId, TASK_EVENT_TYPES.STOPPED, stoppedTask, {
        ...agentCliContextFields(activeEntry.operation, { defaultProvider: true }),
        status: TASK_EVENT_STATUS.STOPPED,
        finishedAt,
        log: activeEntry.operation?.logFile,
        exitCode: typeof activeEntry.operation?.exitCode === 'number' ? activeEntry.operation.exitCode : undefined,
      });
    }
  } else {
    const finishedAt = nowIso();
    const stoppedTask = callbacks.finishTaskRun(taskId, TASK_EVENT_STATUS.PENDING, finishedAt, { onlyIfRunning: true }) || task;
    const taskPlan = callbacks.taskPlan(task);
    callbacks.addTaskLifecycleEvent(projectId, TASK_EVENT_TYPES.STOP_REQUESTED, stoppedTask, {
      ...agentCliContextFields(taskPlan ? callbacks.planAgentCliConfig(taskPlan) : callbacks.status(projectId), { defaultProvider: true }),
      status: TASK_EVENT_STATUS.STOPPING,
      finishedAt,
    });
  }

  if (runtime?.running) callbacks.stopProject(projectId);
  else callbacks.setPhase(projectId, 'stopped');
}

function stopRuntimePlanOperations(runtime, planId, options = {}) {
  if (!runtime?.activeOperations || !planId) return [];
  const archive = options.archive !== false;
  const stoppedAt = options.stoppedAt || nowIso();
  const matches = findRuntimeOperations(
    runtime,
    (operation) => Number(operation?.planId) === Number(planId),
  );
  const stopped = [];
  for (const entry of matches) {
    if (entry.operation) {
      entry.operation.cancelled = true;
      entry.operation.cancelledAt = stoppedAt;
    }
    if (entry.operation && options.errorMessage && !entry.operation.errorMessage) {
      entry.operation.errorMessage = options.errorMessage;
    }
    killChildProcess(entry.child);
    stopped.push({ ...entry, stoppedAt });
    if (archive) archiveRuntimeOperation(runtime, entry.operationKey);
    else removeRuntimeOperation(runtime, entry.operationKey);
  }
  refreshRuntimeActive(runtime);
  return stopped;
}

function stopRuntimeExecutorOperations(runtime, executorId, options = {}) {
  // plugin 持久进程：顺带停止该执行器对应的 plugin 进程（无活跃 operation 时也需处理）
  if (executorId && options.projectId) {
    try { stopRuntimePluginProcess(options.projectId, executorId); } catch { /* ignore */ }
  }
  if (!runtime?.activeOperations || !executorId) return [];
  const archive = options.archive !== false;
  const stoppedAt = options.stoppedAt || nowIso();
  const targetId = Number(executorId);
  const matches = findRuntimeOperations(
    runtime,
    (operation) => operation?.operationType === 'executor' && (
      Number(operation?.executorId) === targetId ||
      Number(operation?.rootExecutorId) === targetId
    ),
  );
  const stopped = [];
  for (const entry of matches) {
    if (entry.operation) {
      entry.operation.cancelled = true;
      entry.operation.cancelledAt = stoppedAt;
      if (options.errorMessage && !entry.operation.errorMessage) {
        entry.operation.errorMessage = options.errorMessage;
      }
    }
    killChildProcess(entry.child);
    stopped.push({ ...entry, stoppedAt });
    if (archive) archiveRuntimeOperation(runtime, entry.operationKey);
    else removeRuntimeOperation(runtime, entry.operationKey);
  }
  refreshRuntimeActive(runtime);
  return stopped;
}

function setProjectPhase(db, projectId, phase) {
  db.run('UPDATE project_states SET phase = ?, updated_at = ? WHERE project_id = ? AND phase != ?', [
    phase,
    nowIso(),
    projectId,
    phase,
  ]);
}

function timeoutMinutesForOperation(operation = {}) {
  const explicit = Number(operation.timeoutMinutes);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const timeoutMs = Number(operation.timeoutMs);
  return Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.round((timeoutMs / 60000) * 100) / 100 : null;
}

function operationTimeoutSnapshotFields(operation = {}) {
  const timeoutMs = Number(operation.timeoutMs);
  const timeoutMinutes = timeoutMinutesForOperation(operation);
  return {
    ...(operation.timedOut !== undefined ? { timedOut: Boolean(operation.timedOut) } : {}),
    ...(Number.isFinite(timeoutMs) && timeoutMs > 0 ? { timeoutMs } : {}),
    ...(timeoutMinutes ? { timeoutMinutes } : {}),
    ...(operation.taskSessionMode ? { taskSessionMode: operation.taskSessionMode } : {}),
    ...(operation.taskSessionState ? { taskSessionState: operation.taskSessionState } : {}),
    ...(operation.taskSessionResetReason ? { taskSessionResetReason: operation.taskSessionResetReason } : {}),
    ...(operation.willRetryWithNewSession !== undefined ? { willRetryWithNewSession: Boolean(operation.willRetryWithNewSession) } : {}),
    ...(operation.reopenContextOnRetry !== undefined ? { reopenContextOnRetry: Boolean(operation.reopenContextOnRetry) } : {}),
  };
}

function recordRuntimeError(db, projectId, error, addEvent, emitUpdate) {
  const message = error?.stack || error?.message || String(error);
  db.run(
    `UPDATE project_states
        SET phase = ?, last_error = ?, updated_at = ?
      WHERE project_id = ?
        AND (phase != ? OR COALESCE(last_error, '') != ?)`,
    ['error', message, nowIso(), projectId, 'error', message],
  );
  addEvent(projectId, 'loop.error', message);
  emitUpdate(projectId);
}

function archiveRuntimeOperation(runtime, operationKey) {
  if (!runtime) return;
  const op = operationKey ? runtime.activeOperations.get(operationKey) : runtime.activeOperation;
  if (op) {
    if (op.activity && typeof op.activity.flush === 'function') {
      op.activity.flush();
    }
    runtime.lastOperation = {
      label: op.label || '',
      projectId: op.projectId || null,
      planId: op.planId || null,
      taskId: op.taskId || null,
      operationType: op.operationType || null,
      executorId: op.executorId || null,
      executorLabel: op.executorLabel || null,
      rootExecutorId: op.rootExecutorId || null,
      rootExecutorLabel: op.rootExecutorLabel || null,
      parentExecutorId: op.parentExecutorId || null,
      executorRunId: op.executorRunId || null,
      cancelled: Boolean(op.cancelled),
      cancelledAt: op.cancelledAt || null,
      ...agentCliContextFields(op),
      logFile: op.logFile || null,
      lastFile: op.lastFile || null,
      errorMessage: op.errorMessage || '',
      startedAt: op.startedAt || null,
      finishedAt: nowIso(),
      exitCode: typeof op.exitCode === 'number' ? op.exitCode : null,
      timedOut: Boolean(op.timedOut),
      timeoutMs: Number.isFinite(Number(op.timeoutMs)) && Number(op.timeoutMs) > 0 ? Number(op.timeoutMs) : null,
      timeoutMinutes: timeoutMinutesForOperation(op),
      taskSessionMode: op.taskSessionMode || null,
      taskSessionState: op.taskSessionState || null,
      taskSessionResetReason: op.taskSessionResetReason || null,
      willRetryWithNewSession: op.willRetryWithNewSession === true,
      reopenContextOnRetry: op.reopenContextOnRetry === true,
      logTail: (op.logBuffer || '').slice(-8000),
      activity: op.activity ? op.activity.getLines() : [],
      ...(op.agentCliProvider === DEFAULT_AGENT_CLI_PROVIDER ? codexSessionContextFields(op) : {}),
      ...(op.agentCliProvider === 'opencode' ? opencodeSessionContextFields(op) : {}),
    };
  }
  if (operationKey) {
    runtime.activeChildren.delete(operationKey);
    runtime.activeOperations.delete(operationKey);
  } else {
    runtime.activeChildren.clear();
    runtime.activeOperations.clear();
  }
  refreshRuntimeActive(runtime);
}

function removeRuntimeOperation(runtime, operationKey) {
  if (!runtime) return;
  if (operationKey) {
    runtime.activeChildren?.delete(operationKey);
    runtime.activeOperations?.delete(operationKey);
  } else {
    runtime.activeChildren?.clear();
    runtime.activeOperations?.clear();
  }
  refreshRuntimeActive(runtime);
}

function operationSnapshotRow(operation) {
  if (!operation) return null;
  const agentContext = agentCliContextFields(operation);
  const activity = Array.isArray(operation.activity)
    ? operation.activity
    : operation.activity && typeof operation.activity.getLines === 'function'
      ? operation.activity.getLines()
      : [];
  return {
    label: operation.label || '',
    projectId: operation.projectId || null,
    planId: operation.planId || null,
    taskId: operation.taskId || null,
    operationType: operation.operationType || null,
    executorId: operation.executorId || null,
    executorLabel: operation.executorLabel || null,
    rootExecutorId: operation.rootExecutorId || null,
    rootExecutorLabel: operation.rootExecutorLabel || null,
    parentExecutorId: operation.parentExecutorId || null,
    executorRunId: operation.executorRunId || null,
    ...agentContext,
    startedAt: operation.startedAt || null,
    ...(operation.finishedAt ? { finishedAt: operation.finishedAt } : {}),
    ...(typeof operation.exitCode === 'number' ? { exitCode: operation.exitCode } : {}),
    ...operationTimeoutSnapshotFields(operation),
    ...(operation.logFile ? { logFile: operation.logFile } : {}),
    ...(operation.lastFile ? { lastFile: operation.lastFile } : {}),
    ...(operation.errorMessage ? { errorMessage: operation.errorMessage } : {}),
    logTail: (operation.logBuffer || operation.logTail || '').slice(-8000),
    activity,
    ...(agentContext.agentCliProvider === DEFAULT_AGENT_CLI_PROVIDER ? codexSessionContextFields(operation) : {}),
    ...(agentContext.agentCliProvider === 'opencode' ? opencodeSessionContextFields(operation) : {}),
  };
}

function runtimeOperationContextByTask(runtime, projectId) {
  const contexts = new Map();
  if (runtime?.lastOperation && Number(runtime.lastOperation.projectId) === Number(projectId) && runtime.lastOperation.taskId) {
    contexts.set(Number(runtime.lastOperation.taskId), operationTaskContextFields(runtime.lastOperation));
  }
  for (const operation of runtime?.activeOperations?.values?.() || []) {
    if (Number(operation.projectId) !== Number(projectId) || !operation.taskId) continue;
    contexts.set(Number(operation.taskId), operationTaskContextFields(operation));
  }
  return contexts;
}

function operationTaskContextFields(operation = {}) {
  const agentContext = agentCliContextFields(operation, { defaultProvider: true });
  return {
    ...agentContext,
    ...operationTimeoutSnapshotFields(operation),
    ...(agentContext.agentCliProvider === DEFAULT_AGENT_CLI_PROVIDER ? codexSessionContextFields(operation) : {}),
    ...(agentContext.agentCliProvider === 'opencode' ? opencodeSessionContextFields(operation) : {}),
  };
}

function registerRuntimeOperation(runtime, child, operation) {
  if (!runtime.activeChildren) runtime.activeChildren = new Map();
  if (!runtime.activeOperations) runtime.activeOperations = new Map();
  const operationKey = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  runtime.activeChildren.set(operationKey, child);
  runtime.activeOperations.set(operationKey, operation);
  runtime.activeChild = child;
  runtime.activeOperation = operation;
  return operationKey;
}

function refreshRuntimeActive(runtime) {
  const entries = Array.from(runtime.activeOperations?.entries?.() || []);
  const latest = entries.at(-1);
  if (!latest) {
    runtime.activeChild = null;
    runtime.activeOperation = null;
    return;
  }
  runtime.activeChild = runtime.activeChildren.get(latest[0]) || null;
  runtime.activeOperation = latest[1] || null;
}

function findRuntimeOperation(runtime, predicate) {
  return findRuntimeOperations(runtime, predicate)[0] || null;
}

function findRuntimeOperations(runtime, predicate) {
  if (!runtime?.activeOperations) return [];
  const matches = [];
  for (const [operationKey, operation] of runtime.activeOperations.entries()) {
    if (predicate(operation)) {
      matches.push({
        operationKey,
        operation,
        child: runtime.activeChildren?.get(operationKey) || null,
      });
    }
  }
  return matches;
}

function waitForChild(child, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    let killTimer = null;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve(code ?? 0);
    };
    const timer = setTimeout(() => {
      child.__autoplanTimedOut = true;
      killChildProcess(child);
      killTimer = setTimeout(() => finish(-1), 5000);
    }, timeoutMs);
    child.on('exit', (code) => {
      finish(code);
    });
    child.on('error', () => finish(-1));
  });
}

function killChildProcess(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32' && child.pid) {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    killer.on('error', () => child.kill());
    return;
  }
  child.kill('SIGTERM');
}

// ┌─────────────────────────────────────────────────────────────────────────┐
// │ plugin 持久进程句柄管理                                                    │
// └─────────────────────────────────────────────────────────────────────────┘

function pluginProcessKey(projectId, executorId) {
  return `${Number(projectId)}:${Number(executorId)}`;
}

/** 延迟加载 executorRunner，规避 runtime ↔ executorRunner 的循环依赖（仅在调用时取值） */
function loadExecutorRunner() {
  try { return require('../executors/executorRunner'); } catch { return null; }
}

/** 注册 plugin 持久进程；进程退出时自动从表中移除 */
function startRuntimePluginProcess(projectId, executorId, childProcess) {
  if (!childProcess) return;
  const key = pluginProcessKey(projectId, executorId);
  activePluginProcesses.set(key, childProcess);
  if (typeof childProcess.on !== 'function') return;
  const onExit = () => {
    if (activePluginProcesses.get(key) === childProcess) activePluginProcesses.delete(key);
    if (typeof childProcess.removeListener === 'function') childProcess.removeListener('exit', onExit);
  };
  childProcess.on('exit', onExit);
}

/** 查找 plugin 进程句柄：优先本表，未命中委托 executorRunner（runner 为单一来源） */
function findRuntimePluginChild(projectId, executorId) {
  const own = activePluginProcesses.get(pluginProcessKey(projectId, executorId));
  if (own) return { child: own, owned: true };
  const runner = loadExecutorRunner();
  const entry = runner && typeof runner.getPluginProcess === 'function'
    ? runner.getPluginProcess(projectId, executorId)
    : null;
  if (entry && entry.child) return { child: entry.child, owned: false };
  return null;
}

/** 向运行中的 plugin 进程 stdin 写入数据 */
function sendRuntimePluginInput(projectId, executorId, input) {
  const text = String(input ?? '');
  const found = findRuntimePluginChild(projectId, executorId);
  if (!found || !found.child.stdin || found.child.stdin.destroyed) return false;
  try { found.child.stdin.write(text); return true; } catch { return false; }
}

/** 优雅终止 plugin 进程（SIGTERM/taskkill）；未命中返回 false */
function stopRuntimePluginProcess(projectId, executorId) {
  const key = pluginProcessKey(projectId, executorId);
  const own = activePluginProcesses.get(key);
  if (own) {
    activePluginProcesses.delete(key);
    killChildProcess(own);
    return true;
  }
  const runner = loadExecutorRunner();
  const entry = runner && typeof runner.getPluginProcess === 'function'
    ? runner.getPluginProcess(projectId, executorId)
    : null;
  if (entry && entry.child) {
    // 直接终止会触发 executorRunner 注册的 exit 回调，由其回写 stopped 状态
    killChildProcess(entry.child);
    return true;
  }
  return false;
}

/** 循环停止时清理指定项目的全部 plugin 进程（本表 + executorRunner 注册表） */
function clearRuntimePluginProcesses(projectId) {
  const id = Number(projectId);
  let cleared = 0;
  for (const [key, child] of Array.from(activePluginProcesses.entries())) {
    const [pid] = key.split(':');
    if (Number(pid) !== id) continue;
    activePluginProcesses.delete(key);
    killChildProcess(child);
    cleared += 1;
  }
  const runner = loadExecutorRunner();
  if (runner && typeof runner.clearPluginProcesses === 'function') {
    cleared += Number(runner.clearPluginProcesses(id)) || 0;
  }
  return cleared;
}

module.exports = {
  ACTIVE_RUNTIME_PHASES,
  ACTIVE_RUNTIME_PHASE_SQL,
  activePluginProcesses,
  archiveRuntimeOperation,
  clearRuntimePluginProcesses,
  createProjectRuntime,
  createThrottledUpdateEmitter,
  createUnrefInterval,
  ensureProjectRuntime,
  existingProjectRuntime,
  findActiveRuntimeProject,
  findRuntimeOperation,
  findRuntimeOperations,
  killChildProcess,
  normalizeRuntimeStatus,
  operationSnapshotRow,
  recordRuntimeError,
  registerRuntimeOperation,
  resetStoredRuntimeState,
  runtimeOperationContextByTask,
  runtimeProjectSummary,
  scheduleProjectRuntime,
  sendRuntimePluginInput,
  setProjectPhase,
  startRuntimePluginProcess,
  stopRuntimeExecutorOperations,
  stopRuntimePluginProcess,
  stopRuntimePlanOperations,
  stopProjectRuntime,
  stopRuntimeTask,
  waitForChild,
};
