const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { nowIso } = require('../database');
const {
  getExecutor,
  listExecutors,
  updateExecutorRunState,
} = require('./executorStore');
const { resolveWorkspaceCwd } = require('../loop/workspaceFiles');
const { stopRuntimeExecutorOperations } = require('../loop/runtime');

const LAST_LOG_MAX_CHARS = 24000;
const PLUGIN_SIGTERM_GRACE_MS = 5000;
const PLUGIN_SIGKILL_GRACE_MS = 3000;
const PLUGIN_STOP_COMMAND_TIMEOUT_MS = 10000;
const PLUGIN_RELOAD_COMMAND_TIMEOUT_MS = 15000;

/**
 * plugin 持久进程注册表：key `${projectId}:${executorId}` → 进程条目。
 * 与 shell/process 的「一次性 runShell」不同，plugin 通过 child_process.spawn 启动长驻进程，
 * 句柄存于此处，支持 stdin 热刷新与三级降级停止（stop 命令 → SIGTERM → SIGKILL/taskkill）。
 */
const pluginProcesses = new Map();

async function runExecutor(service, projectId, executorId) {
  const project = requireProjectWorkspace(service, projectId);
  const rootExecutor = requireRunnableExecutor(service, project.id, executorId);
  service.ensureWorkspaceDirs(project.workspace);

  if (rootExecutor.type === 'plugin') {
    const pluginContext = createRunContext(service, project, rootExecutor);
    return startPluginExecutor(service, pluginContext, rootExecutor);
  }

  const context = createRunContext(service, project, rootExecutor);
  const result = await runExecutorNode(service, context, rootExecutor.id, null, []);
  return {
    snapshot: service.snapshot(project.id),
    executorId: rootExecutor.id,
    label: rootExecutor.label,
    status: result.status,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    log: result.log,
    logFile: result.logFile || null,
    timedOut: Boolean(result.timedOut),
    error: result.errorMessage || null,
    dependencyResults: result.dependencies || [],
  };
}

async function stopExecutor(service, projectId, executorId) {
  const id = positiveInteger(executorId, 'executorId');
  const project = service.project(projectId);
  if (!project) throw new Error('项目不存在');
  const executor = getExecutor(service.db, project.id, id);
  if (!executor) throw new Error('执行器不存在');

  if (executor.type === 'plugin') {
    const context = createPluginActionContext(project, executor, 'stop');
    const result = await stopPluginExecutor(service, context, executor);
    service.emitUpdate(project.id, { immediate: true });
    return { stopped: result.stopped ? 1 : 0, executorId: id, label: executor.label };
  }

  const runtime = service.existingRuntime(project.id);
  const stopped = stopRuntimeExecutorOperations(runtime, id, {
    errorMessage: '执行器已停止',
  });
  if (stopped.length > 0) service.emitUpdate(project.id, { immediate: true });
  return { stopped: stopped.length, executorId: id, label: executor.label };
}

function createRunContext(service, project, rootExecutor) {
  const executors = listExecutors(service.db, project.id);
  const executorsById = new Map(executors.map((executor) => [Number(executor.id), executor]));
  const executorByLabel = new Map();
  for (const executor of executors) {
    if (!executorByLabel.has(executor.label)) executorByLabel.set(executor.label, executor);
  }
  return {
    projectId: Number(project.id),
    workspace: project.workspace,
    rootExecutorId: Number(rootExecutor.id),
    rootExecutorLabel: rootExecutor.label,
    executorRunId: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    executorsById,
    executorByLabel,
    runPromises: new Map(),
    resultsById: new Map(),
  };
}

async function runExecutorNode(service, context, executorId, parentExecutorId, stack) {
  const id = Number(executorId);
  if (stack.includes(id)) {
    const executor = context.executorsById.get(id);
    return dependencyOnlyResult(executor, '执行器依赖存在循环引用');
  }
  if (context.resultsById.has(id)) return context.resultsById.get(id);
  if (context.runPromises.has(id)) return context.runPromises.get(id);

  const promise = runExecutorNodeOnce(service, context, id, parentExecutorId, stack);
  context.runPromises.set(id, promise);
  try {
    const result = await promise;
    context.resultsById.set(id, result);
    return result;
  } finally {
    context.runPromises.delete(id);
  }
}

async function runExecutorNodeOnce(service, context, executorId, parentExecutorId, stack) {
  const executor = context.executorsById.get(Number(executorId));
  if (!executor) {
    return missingDependencyResult(executorId, '依赖执行器不存在');
  }
  if (!executor.enabled) {
    return recordExecutorFailure(service, context, executor, parentExecutorId, '执行器已禁用');
  }
  const dependencyResults = await runExecutorDependencies(
    service,
    context,
    executor,
    stack.concat(Number(executor.id)),
  );
  const failedDependency = dependencyResults.find((result) => result.status !== 'ok');
  if (failedDependency) {
    const stopped = failedDependency.status === 'stopped';
    const reason = stopped
      ? '执行器已停止'
      : `依赖执行器失败：${failedDependency.label || failedDependency.dependencyLabel || failedDependency.executorId}`;
    return recordExecutorFailure(service, context, executor, parentExecutorId, reason, {
      status: stopped ? 'stopped' : 'bad',
      dependencies: dependencyResults,
      dependencyFailure: failedDependency,
    });
  }

  return executeExecutorCommand(service, context, executor, parentExecutorId, dependencyResults);
}

async function runExecutorDependencies(service, context, executor, stack) {
  const labels = Array.isArray(executor.dependsOn) ? executor.dependsOn : [];
  if (labels.length === 0) return [];

  const runOne = (label) => {
    const dependency = context.executorByLabel.get(String(label));
    if (!dependency) return Promise.resolve(missingDependencyResult(null, `依赖执行器不存在：${label}`, label));
    return runExecutorNode(service, context, dependency.id, executor.id, stack);
  };

  if (executor.dependsOrder === 'sequence') {
    const results = [];
    for (const label of labels) {
      const result = await runOne(label);
      results.push(result);
      if (result.status !== 'ok') break;
    }
    return results;
  }

  return Promise.all(labels.map((label) => runOne(label)));
}

async function executeExecutorCommand(service, context, executor, parentExecutorId, dependencyResults = []) {
  const startedAt = Date.now();
  let cwd;
  let command;
  let timeoutMs;
  try {
    cwd = resolveExecutorCwd(context.workspace, executor);
    command = buildExecutorCommand(executor);
    timeoutMs = normalizeTimeoutMs(executor.options?.timeoutMs ?? executor.options?.timeout_ms);
  } catch (error) {
    return recordExecutorFailure(service, context, executor, parentExecutorId, error?.message || String(error), {
      startedAt,
      dependencies: dependencyResults,
    });
  }

  const runAt = nowIso();
  updateExecutorRunState(service.db, context.projectId, executor.id, {
    lastStatus: 'running',
    lastExitCode: null,
    lastDurationMs: null,
    lastLog: '',
    lastRunAt: runAt,
  });
  service.emitUpdate(context.projectId);
  service.addEvent(context.projectId, 'executor.run.started', `${executor.label} 执行器开始运行`, executorEventMeta(context, executor, {
    parentExecutorId,
    dependencies: dependencyResults,
  }));

  try {
    const operation = {
      operationType: 'executor',
      projectId: context.projectId,
      executorId: executor.id,
      executorLabel: executor.label,
      rootExecutorId: context.rootExecutorId,
      rootExecutorLabel: context.rootExecutorLabel,
      parentExecutorId: parentExecutorId || null,
      executorRunId: context.executorRunId,
      cwd,
      extraEnv: executorEnv(context, executor),
    };
    if (timeoutMs) operation.timeoutMs = timeoutMs;

    const result = await service.runShell(
      context.workspace,
      command,
      `executor-${executor.id}-${executor.label}`,
      operation,
    );
    const durationMs = Date.now() - startedAt;
    const exitCode = typeof result.exitCode === 'number' ? result.exitCode : -1;
    const stopped = Boolean(result.cancelled);
    const status = stopped ? 'stopped' : (exitCode === 0 ? 'ok' : 'bad');
    const log = combineLog(result);
    const outcome = {
      executorId: executor.id,
      label: executor.label,
      status,
      exitCode,
      durationMs,
      log,
      logFile: result.logFile || null,
      timedOut: Boolean(result.timedOut),
      errorMessage: result.errorMessage || '',
      dependencies: dependencyResults,
    };
    recordExecutorOutcome(service, context, executor, parentExecutorId, outcome);
    return outcome;
  } catch (error) {
    return recordExecutorFailure(service, context, executor, parentExecutorId, error?.message || String(error), {
      startedAt,
      dependencies: dependencyResults,
    });
  }
}

function recordExecutorFailure(service, context, executor, parentExecutorId, message, options = {}) {
  const durationMs = Math.max(0, Date.now() - Number(options.startedAt || Date.now()));
  const outcome = {
    executorId: executor.id,
    label: executor.label,
    status: options.status || 'bad',
    exitCode: -1,
    durationMs,
    log: message,
    logFile: null,
    timedOut: false,
    errorMessage: message,
    dependencies: options.dependencies || [],
    dependencyFailure: options.dependencyFailure || null,
  };
  recordExecutorOutcome(service, context, executor, parentExecutorId, outcome);
  return outcome;
}

function dependencyOnlyResult(executor, message) {
  return {
    executorId: executor?.id || null,
    dependencyLabel: executor?.label || null,
    label: executor?.label || null,
    status: 'bad',
    exitCode: -1,
    durationMs: 0,
    log: message,
    logFile: null,
    timedOut: false,
    errorMessage: message,
    dependencies: [],
  };
}

function recordExecutorOutcome(service, context, executor, parentExecutorId, outcome) {
  updateExecutorRunState(service.db, context.projectId, executor.id, {
    lastStatus: outcome.status,
    lastExitCode: outcome.exitCode,
    lastDurationMs: outcome.durationMs,
    lastLog: outcome.log,
    lastRunAt: nowIso(),
  });

  const eventType = outcome.status === 'ok'
    ? 'executor.run.succeeded'
    : (outcome.status === 'stopped' ? 'executor.run.stopped' : 'executor.run.failed');
  const statusText = outcome.status === 'ok'
    ? '运行成功'
    : (outcome.status === 'stopped' ? '已停止' : '运行失败');
  service.addEvent(
    context.projectId,
    eventType,
    `${executor.label} 执行器${statusText}`,
    executorEventMeta(context, executor, {
      parentExecutorId,
      exitCode: outcome.exitCode,
      durationMs: outcome.durationMs,
      logFile: outcome.logFile,
      timedOut: outcome.timedOut,
      errorMessage: outcome.errorMessage,
      dependencies: outcome.dependencies,
      dependencyFailure: outcome.dependencyFailure,
    }),
  );
  service.emitUpdate(context.projectId);
}

function executorEventMeta(context, executor, extra = {}) {
  return {
    executorId: executor.id,
    label: executor.label,
    rootExecutorId: context.rootExecutorId,
    rootExecutorLabel: context.rootExecutorLabel,
    executorRunId: context.executorRunId,
    type: executor.type,
    command: executor.command,
    isDependency: Number(executor.id) !== Number(context.rootExecutorId),
    parentExecutorId: extra.parentExecutorId || null,
    dependsOn: executor.dependsOn || [],
    dependsOrder: executor.dependsOrder || 'parallel',
    dependency: {
      isDependency: Number(executor.id) !== Number(context.rootExecutorId),
      parentExecutorId: extra.parentExecutorId || null,
      dependsOn: executor.dependsOn || [],
      dependsOrder: executor.dependsOrder || 'parallel',
      results: compactDependencyResults(extra.dependencies || []),
      failure: extra.dependencyFailure ? compactDependencyResult(extra.dependencyFailure) : null,
    },
    exitCode: typeof extra.exitCode === 'number' ? extra.exitCode : undefined,
    durationMs: typeof extra.durationMs === 'number' ? extra.durationMs : undefined,
    logFile: extra.logFile || null,
    timedOut: Boolean(extra.timedOut),
    errorMessage: extra.errorMessage || '',
  };
}

function compactDependencyResults(results = []) {
  return results.map(compactDependencyResult);
}

function compactDependencyResult(result = {}) {
  return {
    executorId: result.executorId || null,
    label: result.label || result.dependencyLabel || null,
    status: result.status || 'bad',
    exitCode: typeof result.exitCode === 'number' ? result.exitCode : null,
    durationMs: typeof result.durationMs === 'number' ? result.durationMs : null,
    errorMessage: result.errorMessage || '',
  };
}

function missingDependencyResult(executorId, message, dependencyLabel = null) {
  return {
    executorId,
    dependencyLabel,
    label: dependencyLabel,
    status: 'bad',
    exitCode: -1,
    durationMs: 0,
    log: message,
    logFile: null,
    timedOut: false,
    errorMessage: message,
    dependencies: [],
  };
}

function requireProjectWorkspace(service, projectId) {
  const id = positiveInteger(projectId, 'projectId');
  const project = service.project(id);
  if (!project) throw new Error('项目不存在');
  const workspace = String(project.workspace_path || '').trim();
  if (!workspace) throw new Error('请先设置项目工作区路径');
  const resolvedWorkspace = path.resolve(workspace);
  if (!fs.existsSync(resolvedWorkspace) || !fs.statSync(resolvedWorkspace).isDirectory()) {
    throw new Error('项目工作区不存在');
  }
  const workspaceOwner = typeof service.activeProjectForWorkspace === 'function'
    ? service.activeProjectForWorkspace(resolvedWorkspace, id)
    : null;
  if (workspaceOwner) {
    throw new Error(`工作区正在被项目「${workspaceOwner.name}」使用，请先停止对应循环`);
  }
  return { id, workspace: resolvedWorkspace };
}

function requireRunnableExecutor(service, projectId, executorId) {
  const id = positiveInteger(executorId, 'executorId');
  const executor = getExecutor(service.db, projectId, id);
  if (!executor) throw new Error('执行器不存在');
  if (!executor.enabled) throw new Error('执行器已禁用');
  return executor;
}

function resolveExecutorCwd(workspace, executor) {
  const result = resolveWorkspaceCwd(workspace, executor.options?.cwd || '');
  if (!result.safe) {
    throw new Error(result.reason === 'outside_workspace'
      ? '执行器 cwd 不能超出项目工作区'
      : '执行器 cwd 无效');
  }
  if (!fs.existsSync(result.cwd) || !fs.statSync(result.cwd).isDirectory()) {
    throw new Error('执行器 cwd 不存在');
  }
  return result.cwd;
}

function buildExecutorCommand(executor, action) {
  if (action) {
    const command = String(action.command || '').trim();
    const args = (Array.isArray(action.args) ? action.args : []).map(formatExecutorArg);
    return [command, ...args].join(' ').trim();
  }
  const command = String(executor.command || '').trim();
  const args = (Array.isArray(executor.args) ? executor.args : []).map(formatExecutorArg);
  if (executor.type === 'process') {
    return [quoteShellArg(command), ...args].join(' ').trim();
  }
  return [command, ...args].join(' ').trim();
}

function formatExecutorArg(arg) {
  if (arg && typeof arg === 'object' && !Array.isArray(arg)) {
    const value = String(arg.value ?? '');
    if (arg.quoting === 'weak') return quoteWeakShellArg(value);
    return quoteShellArg(value);
  }
  return quoteShellArg(String(arg ?? ''));
}

function quoteShellArg(value) {
  const text = String(value);
  if (process.platform === 'win32') return `"${text.replace(/"/g, '\\"')}"`;
  return "'" + text.replace(/'/g, "'\\''") + "'";
}

function quoteWeakShellArg(value) {
  const text = String(value);
  if (process.platform === 'win32') return quoteShellArg(text);
  return '"' + text.replace(/(["\\$`])/g, '\\$1') + '"';
}

function executorEnv(context, executor) {
  return {
    ...(executor.options?.env || {}),
    AUTOPLAN_EXECUTOR_ID: String(executor.id),
    AUTOPLAN_EXECUTOR_LABEL: executor.label,
    AUTOPLAN_EXECUTOR_TYPE: executor.type,
    AUTOPLAN_EXECUTOR_RUN_ID: context.executorRunId,
    AUTOPLAN_ROOT_EXECUTOR_ID: String(context.rootExecutorId),
    AUTOPLAN_ROOT_EXECUTOR_LABEL: context.rootExecutorLabel,
    AUTOPLAN_WORKSPACE: context.workspace,
  };
}

function normalizeTimeoutMs(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : null;
}

function combineLog(result = {}) {
  const output = String(result.output || '');
  const error = String(result.errorMessage || '');
  const log = error && !output.includes(error) ? `${output}\n[AutoPlan] ${error}\n` : output;
  return log.length > LAST_LOG_MAX_CHARS ? log.slice(-LAST_LOG_MAX_CHARS) : log;
}

// ┌─────────────────────────────────────────────────────────────────────────┐
// │ plugin 持久进程生命周期（start / reload / stop）                            │
// └─────────────────────────────────────────────────────────────────────────┘

function pluginProcessKey(projectId, executorId) {
  return `${Number(projectId)}:${Number(executorId)}`;
}

function getPluginProcess(projectId, executorId) {
  return pluginProcesses.get(pluginProcessKey(projectId, executorId)) || null;
}

function registerPluginProcess(projectId, executorId, entry) {
  pluginProcesses.set(pluginProcessKey(projectId, executorId), entry);
}

function unregisterPluginProcess(projectId, executorId) {
  pluginProcesses.delete(pluginProcessKey(projectId, executorId));
}

function isPluginProcessAlive(entry) {
  return Boolean(entry && entry.child && !entry.exited
    && entry.child.exitCode === null && entry.child.signalCode === null);
}

/** 强制停止并清理指定项目的全部 plugin 进程（供循环停止时调用） */
function clearPluginProcesses(projectId) {
  const id = Number(projectId);
  if (!id) return 0;
  let cleared = 0;
  for (const [key, entry] of Array.from(pluginProcesses.entries())) {
    if (Number(entry.projectId) !== id) continue;
    pluginProcesses.delete(key);
    try { forceKillChild(entry.child); } catch { /* ignore */ }
    cleared += 1;
  }
  return cleared;
}

/**
 * 启动 plugin 执行器的 start 命令，不等待退出，记录 PID。
 * 进程句柄注册到 pluginProcesses，stdout/stderr 累积为日志，退出时回写状态为 stopped。
 */
async function startPluginExecutor(service, context, executor) {
  const projectId = Number(context.projectId);
  const workspace = context.workspace;
  const startAction = executor.actions?.start;
  if (!startAction || !String(startAction.command || '').trim()) {
    throw new Error('plugin 执行器未配置 start 启动命令');
  }
  if (isPluginProcessAlive(getPluginProcess(projectId, executor.id))) {
    throw new Error('plugin 执行器已在运行');
  }

  const startedAt = Date.now();
  const runAt = nowIso();

  let cwd;
  let spawnParts;
  try {
    cwd = resolveExecutorCwd(workspace, executor);
    spawnParts = pluginActionSpawnParts(startAction);
    if (!spawnParts.command) throw new Error('start 命令不能为空');
  } catch (error) {
    const message = error?.message || String(error);
    safeUpdatePluginState(service, projectId, executor, {
      lastStatus: 'bad',
      lastExitCode: -1,
      lastLog: message,
      lastRunAt: nowIso(),
      pluginState: { running: false, pid: null, lastAction: 'start', lastActionAt: runAt, startedAt: runAt, exitCode: -1, error: message },
    });
    return pluginResult(service, projectId, executor, 'bad', -1, startedAt, message, null);
  }

  // 标记运行中（pid 待 spawn 后回填）
  safeUpdatePluginState(service, projectId, executor, {
    lastStatus: 'running',
    lastExitCode: null,
    lastDurationMs: null,
    lastLog: '',
    lastRunAt: runAt,
    pluginState: { running: true, pid: null, lastAction: 'start', lastActionAt: runAt, startedAt: runAt, exitCode: null, error: null },
  });
  service.emitUpdate(projectId);
  service.addEvent(projectId, 'executor.plugin.start', `${executor.label} 插件执行器启动`, pluginEventMeta(context, executor));

  let child;
  try {
    const env = { ...process.env, ...executorEnv(context, executor) };
    child = spawn(spawnParts.command, spawnParts.args, { cwd, env, shell: true, windowsHide: true });
  } catch (error) {
    const message = error?.message || String(error);
    safeUpdatePluginState(service, projectId, executor, {
      lastStatus: 'bad',
      lastExitCode: -1,
      lastLog: `启动失败：${message}`,
      lastRunAt: nowIso(),
      pluginState: { running: false, pid: null, lastAction: 'start', lastActionAt: runAt, startedAt: runAt, exitCode: -1, error: message },
    });
    service.emitUpdate(projectId);
    return pluginResult(service, projectId, executor, 'bad', -1, startedAt, `启动失败：${message}`, null);
  }

  const pid = child.pid ?? null;
  const entry = {
    child,
    pid,
    projectId,
    executorId: Number(executor.id),
    label: executor.label,
    startedAtMs: startedAt,
    startedAtIso: runAt,
    logBuffer: '',
    exitCode: null,
    exited: false,
  };
  registerPluginProcess(projectId, executor.id, entry);

  const appendLog = (chunk) => {
    const text = String(chunk || '');
    if (!text) return;
    entry.logBuffer = (entry.logBuffer || '') + text;
    if (entry.logBuffer.length > LAST_LOG_MAX_CHARS) {
      entry.logBuffer = entry.logBuffer.slice(-LAST_LOG_MAX_CHARS);
    }
  };
  if (child.stdout) child.stdout.on('data', appendLog);
  if (child.stderr) child.stderr.on('data', appendLog);
  child.on('error', (error) => {
    const message = error?.message || String(error);
    entry.logBuffer = `${entry.logBuffer || ''}\n[AutoPlan] 进程错误：${message}\n`;
  });
  child.on('exit', (code, signal) => {
    if (entry.exited) return;
    entry.exited = true;
    entry.exitCode = typeof code === 'number' ? code : -1;
    unregisterPluginProcess(projectId, executor.id);
    onPluginProcessExit(service, context, executor, entry, code, signal);
  });

  // 回填 pid
  safeUpdatePluginState(service, projectId, executor, {
    pluginState: { running: true, pid, lastAction: 'start', lastActionAt: runAt, startedAt: runAt, exitCode: null, error: null },
  });

  return pluginResult(service, projectId, executor, 'running', null, startedAt, '', pid);
}

/**
 * 热刷新：reload.type === 'input' 时向运行中进程 stdin 写入文本；
 * 否则执行 reload.command 作为一次性命令。
 */
async function reloadPluginExecutor(service, context, executor) {
  const projectId = Number(context.projectId);
  const reloadAction = executor.actions?.reload;
  if (!reloadAction) throw new Error('plugin 执行器未配置 reload 动作');

  const entry = getPluginProcess(projectId, executor.id);
  if (!isPluginProcessAlive(entry)) throw new Error('plugin 执行器未在运行，无法热刷新');

  const runAt = nowIso();
  if (reloadAction.type === 'input') {
    const input = String(reloadAction.input ?? '');
    const child = entry.child;
    try {
      if (!child.stdin || child.stdin.destroyed) throw new Error('进程 stdin 不可用');
      child.stdin.write(input);
      if (!input.endsWith('\n')) child.stdin.write('\n');
    } catch (error) {
      const message = error?.message || String(error);
      markPluginAction(service, projectId, executor, 'reload', runAt, message);
      return pluginReloadResult(service, projectId, executor, entry, `热刷新失败：${message}`, message);
    }
  } else {
    const reloadCommand = String(reloadAction.command || '').trim();
    if (!reloadCommand) throw new Error('plugin reload 动作未配置 command 或 input');
    try {
      await runPluginActionCommand(service, context, executor, reloadAction, 'reload', PLUGIN_RELOAD_COMMAND_TIMEOUT_MS);
    } catch (error) {
      const message = error?.message || String(error);
      markPluginAction(service, projectId, executor, 'reload', runAt, message);
      return pluginReloadResult(service, projectId, executor, entry, `热刷新失败：${message}`, message);
    }
  }

  markPluginAction(service, projectId, executor, 'reload', runAt, null);
  service.addEvent(projectId, 'executor.plugin.reload', `${executor.label} 插件执行器热刷新`, pluginEventMeta(context, executor));
  service.emitUpdate(projectId);
  return pluginReloadResult(service, projectId, executor, entry, '', null);
}

/**
 * 三级降级停止：stop 命令 → SIGTERM → SIGKILL/taskkill。
 * 进程退出由 startPluginExecutor 注册的 exit 回调统一回写状态为 stopped。
 */
async function stopPluginExecutor(service, context, executor) {
  const projectId = Number(context.projectId);
  const entry = getPluginProcess(projectId, executor.id);
  if (!entry || !isPluginProcessAlive(entry)) {
    safeUpdatePluginState(service, projectId, executor, {
      lastStatus: 'stopped',
      pluginState: { running: false, pid: null, lastAction: 'stop', lastActionAt: nowIso(), startedAt: entry?.startedAtIso || null, exitCode: entry?.exitCode ?? null, error: null },
    });
    return pluginResult(service, projectId, executor, 'stopped', entry?.exitCode ?? null, 0, entry?.logBuffer || '', null);
  }

  const startedAt = Date.now();

  // 1) stop 命令（若配置且有工作区）
  const stopAction = executor.actions?.stop;
  if (stopAction && String(stopAction.command || '').trim() && context.workspace) {
    try {
      await runPluginActionCommand(service, context, executor, stopAction, 'stop', PLUGIN_STOP_COMMAND_TIMEOUT_MS);
    } catch { /* 忽略，继续降级 */ }
  }

  // 2) SIGTERM（Unix 优雅终止；Windows 下 child.kill 即 TerminateProcess）
  if (isPluginProcessAlive(entry)) {
    try { entry.child.kill('SIGTERM'); } catch { /* ignore */ }
    await waitForChildExit(entry.child, PLUGIN_SIGTERM_GRACE_MS);
  }

  // 3) SIGKILL / taskkill /T /F 强制终止
  if (isPluginProcessAlive(entry)) {
    forceKillChild(entry.child);
    await waitForChildExit(entry.child, PLUGIN_SIGKILL_GRACE_MS);
  }

  // exit 回调通常已回写状态；此处兜底确保条目移除与状态一致
  if (!entry.exited) {
    entry.exited = true;
    entry.exitCode = typeof entry.child.exitCode === 'number' ? entry.child.exitCode : -1;
    unregisterPluginProcess(projectId, executor.id);
    onPluginProcessExit(service, context, executor, entry, entry.child.exitCode, entry.child.signalCode);
  }

  return {
    snapshot: service.snapshot(projectId),
    executorId: executor.id,
    label: executor.label,
    status: 'stopped',
    exitCode: entry.exitCode,
    durationMs: Date.now() - startedAt,
    log: entry.logBuffer || '',
    stopped: true,
  };
}

function onPluginProcessExit(service, context, executor, entry, code, signal) {
  const projectId = Number(entry.projectId);
  const finishedAt = nowIso();
  const exitCode = typeof code === 'number' ? code : -1;
  const signalError = signal ? `进程被信号终止：${signal}` : null;
  safeUpdatePluginState(service, projectId, executor, {
    lastStatus: 'stopped',
    lastExitCode: exitCode,
    lastDurationMs: Math.max(0, Date.now() - Number(entry.startedAtMs || Date.now())),
    lastLog: String(entry.logBuffer || ''),
    lastRunAt: finishedAt,
    pluginState: {
      running: false,
      pid: null,
      lastAction: 'stop',
      lastActionAt: finishedAt,
      startedAt: entry.startedAtIso || null,
      exitCode,
      error: signalError,
    },
  });
  try {
    service.addEvent(projectId, 'executor.plugin.stopped', `${executor.label} 插件执行器已停止`, pluginEventMeta(context, executor, { exitCode, signal: signal || null }));
    service.emitUpdate(projectId);
  } catch { /* ignore */ }
}

/** 以一次性 runShell 执行 reload/stop 这类独立命令（命令模式） */
function runPluginActionCommand(service, context, executor, action, actionName, timeoutMs) {
  const command = buildExecutorCommand(executor, action);
  if (!command) return Promise.resolve(null);
  const operation = {
    operationType: 'executor',
    projectId: Number(context.projectId),
    executorId: executor.id,
    executorLabel: executor.label,
    rootExecutorId: Number(context.rootExecutorId || executor.id),
    rootExecutorLabel: context.rootExecutorLabel || executor.label,
    executorRunId: context.executorRunId || `plugin-${executor.id}`,
    cwd: resolveExecutorCwd(context.workspace, executor),
    extraEnv: executorEnv(context, executor),
    timeoutMs,
  };
  return service.runShell(context.workspace, command, `plugin-${executor.id}-${actionName}`, operation);
}

/** 从 action 中提取 spawn 所需的 { command, args }（args 取原始值，不做 shell 转义） */
function pluginActionSpawnParts(action) {
  const command = String(action?.command || '').trim();
  const args = (Array.isArray(action?.args) ? action.args : []).map((arg) => {
    if (arg && typeof arg === 'object' && !Array.isArray(arg)) return String(arg.value ?? '');
    return String(arg ?? '');
  });
  return { command, args };
}

/** 强制终止子进程：Unix 用 SIGKILL，Windows 用 taskkill /T /F 杀整个进程树 */
function forceKillChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32' && child.pid) {
    try {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
      killer.on('error', () => { try { child.kill(); } catch { /* ignore */ } });
      return;
    } catch {
      try { child.kill(); } catch { /* ignore */ }
      return;
    }
  }
  try { child.kill('SIGKILL'); } catch { /* ignore */ }
}

function waitForChildExit(child, timeoutMs) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return resolve(true);
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), Math.max(0, Number(timeoutMs) || 0));
    child.once('exit', () => finish(true));
    child.once('error', () => finish(true));
  });
}

function markPluginAction(service, projectId, executor, action, runAt, error) {
  const existing = getPluginProcess(projectId, executor.id);
  safeUpdatePluginState(service, projectId, executor, {
    pluginState: {
      running: isPluginProcessAlive(existing),
      pid: existing?.pid ?? null,
      lastAction: action,
      lastActionAt: runAt,
      startedAt: existing?.startedAtIso || null,
      exitCode: existing?.exitCode ?? null,
      error,
    },
  });
  service.emitUpdate(projectId);
}

function safeUpdatePluginState(service, projectId, executor, patch) {
  try {
    updateExecutorRunState(service.db, projectId, executor.id, patch);
  } catch { /* 执行器可能已被删除，忽略状态回写失败 */ }
}

function pluginResult(service, projectId, executor, status, exitCode, startedAt, log, pid) {
  return {
    snapshot: service.snapshot(projectId),
    executorId: executor.id,
    label: executor.label,
    status,
    exitCode,
    durationMs: Date.now() - startedAt,
    log,
    logFile: null,
    timedOut: false,
    error: status === 'bad' ? log : null,
    pid,
    dependencyResults: [],
  };
}

function pluginReloadResult(service, projectId, executor, entry, message, error) {
  return {
    snapshot: service.snapshot(projectId),
    executorId: executor.id,
    label: executor.label,
    status: 'running',
    exitCode: null,
    durationMs: 0,
    log: message ? `${entry.logBuffer || ''}\n[AutoPlan] ${message}\n` : (entry.logBuffer || ''),
    logFile: null,
    timedOut: false,
    error,
    pid: entry.pid ?? null,
    dependencyResults: [],
  };
}

function pluginEventMeta(context, executor, extra = {}) {
  return {
    executorId: executor.id,
    label: executor.label,
    type: executor.type,
    command: executor.command,
    rootExecutorId: Number(context?.rootExecutorId || executor.id),
    rootExecutorLabel: context?.rootExecutorLabel || executor.label,
    executorRunId: context?.executorRunId || null,
    ...extra,
  };
}

function createPluginActionContext(project, executor, suffix = 'action') {
  return {
    projectId: Number(project.id),
    workspace: resolveProjectWorkspace(project),
    rootExecutorId: Number(executor.id),
    rootExecutorLabel: executor.label,
    executorRunId: `plugin-${suffix}-${executor.id}-${Date.now()}`,
  };
}

function resolveProjectWorkspace(project) {
  const workspace = String(project?.workspace_path || '').trim();
  return workspace ? path.resolve(workspace) : '';
}

function positiveInteger(value, field) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw new Error(`${field} 无效`);
  return id;
}

module.exports = {
  buildExecutorCommand,
  clearPluginProcesses,
  getPluginProcess,
  isPluginProcessAlive,
  reloadPluginExecutor,
  runExecutor,
  startPluginExecutor,
  stopExecutor,
  stopPluginExecutor,
};
