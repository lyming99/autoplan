const { spawn } = require('node:child_process');
const { nowIso } = require('../database');
const {
  DEFAULT_AGENT_CLI_PROVIDER,
  agentCliContextFields,
  codexSessionContextFields,
} = require('./agentCliConfig');
const {
  TASK_EVENT_STATUS,
  TASK_EVENT_TYPES,
} = require('./taskEvents');

const ACTIVE_RUNTIME_PHASES = new Set(['running', 'scan', 'generate-plan', 'execute-task', 'validate']);
const ACTIVE_RUNTIME_PHASE_SQL = "('running','scan','generate-plan','execute-task','validate')";
const DEFAULT_UPDATE_THROTTLE_MS = 1200;

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
  const lastEmittedAt = new Map();
  const snapshot = options.snapshot;
  const emit = options.emit;

  const flushKey = (key, projectId) => {
    const timer = pendingTimers.get(key);
    if (timer) clearTimeout(timer);
    pendingTimers.delete(key);
    lastEmittedAt.set(key, Date.now());
    emit(snapshot(projectId));
  };

  const schedule = (projectId, scheduleOptions = {}) => {
    const key = String(projectId || 'all');
    if (scheduleOptions.immediate) {
      flushKey(key, projectId);
      return;
    }

    const elapsed = Date.now() - (lastEmittedAt.get(key) || 0);
    if (elapsed >= throttleMs) {
      flushKey(key, projectId);
      return;
    }
    if (pendingTimers.has(key)) return;
    const timer = setTimeout(() => flushKey(key, projectId), throttleMs - elapsed);
    if (typeof timer.unref === 'function') timer.unref();
    pendingTimers.set(key, timer);
  };

  return {
    emit: schedule,
    flush() {
      for (const key of Array.from(pendingTimers.keys())) {
        schedule(key === 'all' ? null : Number(key), { immediate: true });
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
    agent_cli_provider: agentCliConfig.provider,
    agent_cli_command: agentCliConfig.command,
    codex_reasoning_effort: agentCliConfig.codexReasoningEffort,
  };
  normalized.phase = normalizeRuntimePhase(normalized.phase, runtime);
  return normalized;
}

function resetStoredRuntimeState(db, now = nowIso()) {
  db.run(
    `UPDATE project_states
     SET running = 0,
         phase = CASE WHEN phase IN ${ACTIVE_RUNTIME_PHASE_SQL} THEN 'stopped' ELSE phase END,
         updated_at = ?
     WHERE running != 0 OR phase IN ${ACTIVE_RUNTIME_PHASE_SQL}`,
    [now],
  );
  db.run(
    `UPDATE loop_state
     SET running = 0,
         phase = CASE WHEN phase IN ${ACTIVE_RUNTIME_PHASE_SQL} THEN 'stopped' ELSE phase END,
         updated_at = ?
     WHERE id = 1 AND (running != 0 OR phase IN ${ACTIVE_RUNTIME_PHASE_SQL})`,
    [now],
  );
  db.run('UPDATE plan_tasks SET status = ?, updated_at = ? WHERE status = ?', ['pending', now, 'running']);
}

function scheduleProjectRuntime(runtime, intervalSeconds, runOnce) {
  if (!runtime) return;
  if (runtime.timer) clearInterval(runtime.timer);
  runtime.timer = setInterval(() => {
    if (!runtime.running) return;
    runOnce();
  }, Math.max(1, Number(intervalSeconds || 5)) * 1000);
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

function setProjectPhase(db, projectId, phase) {
  db.run('UPDATE project_states SET phase = ?, updated_at = ? WHERE project_id = ?', [
    phase,
    nowIso(),
    projectId,
  ]);
}

function recordRuntimeError(db, projectId, error, addEvent, emitUpdate) {
  const message = error?.stack || error?.message || String(error);
  db.run(
    'UPDATE project_states SET phase = ?, last_error = ?, updated_at = ? WHERE project_id = ?',
    ['error', message, nowIso(), projectId],
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
      ...agentCliContextFields(op),
      logFile: op.logFile || null,
      lastFile: op.lastFile || null,
      errorMessage: op.errorMessage || '',
      startedAt: op.startedAt || null,
      finishedAt: nowIso(),
      exitCode: typeof op.exitCode === 'number' ? op.exitCode : null,
      logTail: (op.logBuffer || '').slice(-8000),
      activity: op.activity ? op.activity.getLines() : [],
      ...(op.agentCliProvider === DEFAULT_AGENT_CLI_PROVIDER ? codexSessionContextFields(op) : {}),
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

function operationSnapshotRow(operation) {
  if (!operation) return null;
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
    ...agentCliContextFields(operation),
    startedAt: operation.startedAt || null,
    ...(operation.finishedAt ? { finishedAt: operation.finishedAt } : {}),
    ...(typeof operation.exitCode === 'number' ? { exitCode: operation.exitCode } : {}),
    ...(operation.logFile ? { logFile: operation.logFile } : {}),
    ...(operation.lastFile ? { lastFile: operation.lastFile } : {}),
    ...(operation.errorMessage ? { errorMessage: operation.errorMessage } : {}),
    logTail: (operation.logBuffer || operation.logTail || '').slice(-8000),
    activity,
    ...codexSessionContextFields(operation),
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
    ...(agentContext.agentCliProvider === DEFAULT_AGENT_CLI_PROVIDER ? codexSessionContextFields(operation) : {}),
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
  if (!child || child.killed) return;
  if (process.platform === 'win32' && child.pid) {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    killer.on('error', () => child.kill());
    return;
  }
  child.kill('SIGTERM');
}

module.exports = {
  ACTIVE_RUNTIME_PHASES,
  ACTIVE_RUNTIME_PHASE_SQL,
  archiveRuntimeOperation,
  createProjectRuntime,
  createThrottledUpdateEmitter,
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
  setProjectPhase,
  stopProjectRuntime,
  stopRuntimeTask,
  waitForChild,
};
