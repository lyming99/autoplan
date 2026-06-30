const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { AsyncLocalStorage } = require('node:async_hooks');
const { spawn } = require('node:child_process');
const { nowIso } = require('./database');
const { CodexActivityPrinter } = require('./codexActivity');
const { ClaudeStreamJsonPrinter } = require('./claudeActivity');
const {
  codexNewSessionArgs,
  codexResumeSessionArgs,
  createChunkDecoder,
  runAgentCliAttempt,
} = require('./agentCli');
const {
  DEFAULT_AGENT_CLI_PROVIDER,
  LOOP_CONFIG_INPUT_KEYS,
  VALIDATION_COMMAND_INPUT_KEYS,
  agentCliContextFields,
  agentCliOperationFields,
  agentCliProviderDisplayName,
  agentCliStateUpdates,
  clearCodexSessionFields,
  codexSessionContextFields,
  effectiveAgentCliConfig,
  extractCodexSessionId,
  hasAgentCliOverride,
  hasAnyOwnProperty,
  hasCodexSessionOption,
  isCodexResumeFailure,
  nextAgentCliConfig,
  nextIntakeAgentCliConfig,
  normalizeAgentCliConfig,
  normalizeAgentCliSessionId,
  normalizeCodexSessionId,
  normalizeIntakeAgentCliConfig,
  operationCodexSessionId,
  opencodeSessionContextFields,
  planAgentCliColumnValues,
  readFirstOwnValue,
  shortAgentCliSessionId,
  shortCodexSessionId,
} = require('./loop/agentCliConfig');
const {
  archiveRuntimeOperation,
  createThrottledUpdateEmitter,
  createUnrefInterval,
  ensureProjectRuntime,
  existingProjectRuntime,
  findActiveRuntimeProject,
  normalizeRuntimeStatus,
  recordRuntimeError,
  registerRuntimeOperation,
  resetStoredRuntimeState,
  runtimeProjectSummary,
  scheduleProjectRuntime,
  setProjectPhase,
  stopRuntimePlanOperations,
  stopProjectRuntime,
  stopRuntimeTask,
  waitForChild,
} = require('./loop/runtime');
const planGeneration = require('./loop/planGeneration');
const planParser = require('./loop/planParser');
const planTaskSync = require('./loop/planTaskSync');
const snapshots = require('./loop/snapshots');
const concurrency = require('./loop/concurrency');
const workspaceFiles = require('./loop/workspaceFiles');
const intakeAttachments = require('./loop/intakeAttachments');
const { parseEventMeta } = snapshots;
const { isAcceptanceTask } = concurrency;
const {
  hashFile,
  hashText,
  normalizeRelative,
  readSnippet,
  resolveSafeAutoPlanIntakePlanPath,
  safePart,
  tailText,
  workspaceKey,
  workspaceToolEnv,
} = workspaceFiles;
const taskExecution = require('./loop/taskExecution');
const validationFlow = require('./loop/validation');
const { classifyExecutionFailure } = validationFlow;
const scriptHooks = require('./loop/scriptHooks');
const {
  LEGACY_TASK_EVENT_TYPES,
  TASK_EVENT_COMPATIBILITY,
  TASK_EVENT_SEMANTICS,
  TASK_EVENT_STATUS,
  TASK_EVENT_TYPES,
  normalizeDurationMs,
  syncedTaskStatus,
  taskEventMessage,
  taskEventMeta,
  taskRunDurationMs,
  withTaskDurationMeta,
} = require('./loop/taskEvents');

const SHELL_COMMAND_TIMEOUT_MS = 10 * 60 * 1000;
const PLAN_GENERATION_FORMAT_GUARD_TITLE = 'AutoPlan 任务拆解格式硬性要求（必须遵守）';
const CLAUDE_SESSION_INPUT_KEYS = [
  'agentCliSessionId',
  'agentCliSessionRequestedId',
  'claudeSessionId',
  'claudeSessionRequestedId',
  'sessionId',
];

// 人工验收态与执行态正交：只允许对「已完成」项验收（计划 status='completed'、任务 status ∈ 已完成集合），
// 与渲染层 matchesTaskStatusFilter 的「已完成」语义一致，不新增 status 取值。
const ACCEPTABLE_PLAN_STATUS = 'completed';
const ACCEPTABLE_TASK_STATUSES = Object.freeze(['completed', 'done', 'passed']);
const LINKED_INTAKE_COMPLETED_STATUS = 'completed';
const LINKED_INTAKE_TERMINAL_STATUSES = Object.freeze(['completed', 'closed']);
const LINKED_INTAKE_COMPLETION_SOURCES = Object.freeze([
  { table: 'requirements', countKey: 'requirements', idsKey: 'requirementIds' },
  { table: 'feedback', countKey: 'feedback', idsKey: 'feedbackIds' },
]);

class LoopService extends EventEmitter {
  constructor(db) {
    super();
    this.db = db;
    this.runtimes = new Map();
    // 由 main.js 在持有 mcpServer 句柄后注入：返回 mcpServer?.status?.()，供快照叠加实时运行态。
    this.mcpStatusProvider = null;
    this.hookOperationContext = new AsyncLocalStorage();
    // 全局定时调度器句柄（setInterval，60s，unref 不阻塞进程退出）：由 main.js 创建 loop 后调
    // startScheduler、will-quit 调 stopScheduler 启停；独立于循环运行态。
    this.scheduleTimer = null;
    this.updateEmitter = createThrottledUpdateEmitter({
      snapshot: (projectId) => this.snapshot(projectId),
      emit: (snapshot) => this.emit('update', snapshot),
    });
    this.resetRuntimeState();
  }

  runtime(projectId) {
    return ensureProjectRuntime(this.runtimes, projectId);
  }

  existingRuntime(projectId) {
    return existingProjectRuntime(this.runtimes, projectId);
  }

  projects() {
    return this.db
      .all('SELECT * FROM projects ORDER BY updated_at DESC, id DESC')
      .map((project) => this.withProjectRuntimeSummary(project));
  }

  withProjectRuntimeSummary(project) {
    const state =
      this.db.get(
        'SELECT * FROM project_states WHERE project_id = ?',
        [project.id],
      ) || {};
    const runtime = this.existingRuntime(project.id);
    const agentCliConfig = normalizeAgentCliConfig(state);
    return runtimeProjectSummary(project, state, runtime, agentCliConfig);
  }

  project(projectId) {
    if (!projectId) return null;
    return this.db.get('SELECT * FROM projects WHERE id = ?', [projectId]);
  }

  defaultProjectId() {
    return this.projects()[0]?.id || null;
  }

  ensureProjectState(projectId) {
    if (!projectId) return;
    if (this.db.get('SELECT project_id FROM project_states WHERE project_id = ?', [projectId])) return;
    this.db.run(
      `INSERT OR IGNORE INTO project_states
       (project_id, running, phase, interval_seconds, validation_command, updated_at)
       VALUES (?, 0, 'idle', 5, '', ?)`,
      [projectId, nowIso()],
    );
  }

  hasRuntimeConfigInput(input = {}) {
    return hasAnyOwnProperty(input, LOOP_CONFIG_INPUT_KEYS);
  }

  resetRuntimeState() {
    resetStoredRuntimeState(this.db);
  }

  status(projectId = this.defaultProjectId()) {
    if (!projectId) return null;
    this.ensureProjectState(projectId);
    return this.normalizeRuntimeStatus(projectId, this.db.get('SELECT * FROM project_states WHERE project_id = ?', [projectId]));
  }

  normalizeRuntimeStatus(projectId, state) {
    if (!state) return null;
    const agentCliConfig = normalizeAgentCliConfig(state);
    return normalizeRuntimeStatus(state, this.existingRuntime(projectId), agentCliConfig);
  }

  configure(projectId, config = {}) {
    const { workspacePath, intervalSeconds } = config;
    const current = this.status(projectId);
    const project = this.project(projectId);
    const runtime = this.existingRuntime(projectId);
    const nextWorkspace = workspacePath ?? project?.workspace_path;
    const workspaceOwner = this.activeProjectForWorkspace(nextWorkspace, projectId);
    if ((runtime?.running || runtime?.busy) && workspaceOwner) {
      throw new Error(`工作区正在被项目「${workspaceOwner.name}」使用，请先停止对应循环`);
    }
    if (!project || !current) throw new Error('项目不存在');

    this.db.run(
      `UPDATE projects
       SET workspace_path = ?, updated_at = ?
       WHERE id = ?`,
      [nextWorkspace, nowIso(), projectId],
    );
    const nextInterval = Number(intervalSeconds || current.interval_seconds || 5);
    const agentCliConfig = nextAgentCliConfig(current, config);
    const nextValidationCommand = hasAnyOwnProperty(config, VALIDATION_COMMAND_INPUT_KEYS)
      ? String(readFirstOwnValue(config, VALIDATION_COMMAND_INPUT_KEYS) ?? '')
      : current.validation_command;
    const stateUpdates = [
      ['interval_seconds', nextInterval],
      ['validation_command', nextValidationCommand],
      ...agentCliStateUpdates(this.projectStateColumns(), agentCliConfig),
      ['updated_at', nowIso()],
    ];
    if (Array.isArray(config.envVars) && this.projectStateColumns().has('env_vars')) {
      stateUpdates.splice(stateUpdates.length - 1, 0, ['env_vars', normalizeEnvVarsJson(config.envVars)]);
    }
    this.db.run(
      `UPDATE project_states
       SET ${stateUpdates.map(([column]) => `${column} = ?`).join(', ')}
       WHERE project_id = ?`,
      [...stateUpdates.map(([, value]) => value), projectId],
    );
    if (runtime?.running) this.scheduleProject(projectId, nextInterval);
    this.emitUpdate(projectId);
  }

  /** 读取项目用户自定义环境变量：解析 project_states.env_vars（JSON 数组 [{name,value}]）为 { [name]: value }。
   *  JSON 解析失败/非数组安全降级为 {}；跳过空名、按 name 去空白；不缓存（每次执行取最新值，保证保存即时生效）。 */
  projectEnvVars(projectId) {
    if (!projectId) return {};
    const row = this.db.get('SELECT env_vars FROM project_states WHERE project_id = ?', [projectId]);
    const raw = row?.env_vars;
    if (!raw) return {};
    let entries;
    try {
      entries = JSON.parse(raw);
    } catch {
      return {};
    }
    if (!Array.isArray(entries)) return {};
    const env = {};
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') continue;
      const name = String(entry.name ?? '').trim();
      if (!name) continue;
      env[name] = String(entry.value ?? '');
    }
    return env;
  }

  projectStateColumns() {
    if (!this._projectStateColumns) {
      this._projectStateColumns = new Set(this.db.all('PRAGMA table_info(project_states)').map((column) => column.name));
    }
    return this._projectStateColumns;
  }

  planColumns() {
    if (!this._planColumns) {
      this._planColumns = new Set(this.db.all('PRAGMA table_info(plans)').map((column) => column.name));
    }
    return this._planColumns;
  }

  scheduleProject(projectId, intervalSeconds) {
    const runtime = this.runtime(projectId);
    scheduleProjectRuntime(runtime, intervalSeconds, () => {
      this.runOnce(projectId).catch((error) => this.recordError(projectId, error));
    });
  }

  activeProjectForWorkspace(workspace, projectId) {
    return findActiveRuntimeProject(this.runtimes, workspace, projectId, (id) => this.project(id), workspaceKey);
  }

  start(projectId) {
    const state = this.status(projectId);
    const project = this.project(projectId);
    if (!project || !state) throw new Error('项目不存在');
    if (!project.workspace_path) throw new Error('请先设置项目工作区路径');
    const runtime = this.runtime(projectId);
    if (!runtime) return;
    if (runtime.running) return;
    const workspaceOwner = this.activeProjectForWorkspace(project.workspace_path, projectId);
    if (workspaceOwner) {
      throw new Error(`工作区正在被项目「${workspaceOwner.name}」使用，请先停止对应循环`);
    }

    runtime.running = true;
    this.db.run(
      'UPDATE project_states SET running = 1, phase = ?, updated_at = ? WHERE project_id = ?',
      ['running', nowIso(), projectId],
    );
    this.emitUpdate(projectId);
    this.runOnce(projectId).catch((error) => this.recordError(projectId, error));
    this.scheduleProject(projectId, state.interval_seconds);
  }

  stop(projectId = null) {
    if (!projectId) {
      for (const id of Array.from(this.runtimes.keys())) this.stop(id);
      return;
    }
    const runtime = this.runtime(projectId);
    stopProjectRuntime(projectId, runtime, {
      taskForProject: (id, taskId) => this.taskForProject(id, taskId),
      finishTaskRun: (taskId, status, finishedAt, options) => this.finishTaskRun(taskId, status, finishedAt, options),
      addTaskLifecycleEvent: (id, type, task, meta) => this.addTaskLifecycleEvent(id, type, task, meta),
      addEvent: (id, type, message, meta) => this.addEvent(id, type, message, meta),
      markStopped: (id) => {
        this.db.run(
          'UPDATE project_states SET running = 0, phase = ?, updated_at = ? WHERE project_id = ?',
          ['stopped', nowIso(), id],
        );
      },
      emitUpdate: (id) => this.emitUpdate(id),
    });
  }

  async runOnce(projectId = this.defaultProjectId()) {
    if (!projectId) return;
    const runtime = this.runtime(projectId);
    if (!runtime || runtime.busy) return;
    const startedFromRunningLoop = runtime.running;
    runtime.busy = true;
    const cycleSummary = { stage: 'loop:end', pendingIntakes: 0, generatedPlanId: null };
    try {
      const project = this.project(projectId);
      const workspace = project?.workspace_path;
      if (!workspace) return;
      this.setPhase(projectId, 'scan');
      this.ensureWorkspaceDirs(workspace);

      // 扫描未完成、未中断、尚未生成计划的需求和反馈
      const pendingRequirements = this.db
        .all(
          `SELECT * FROM requirements
           WHERE project_id = ? AND linked_plan_id IS NULL
             AND status NOT IN ('completed', 'closed')
             AND (generate_fail_count < 3 OR (generate_fail_count >= 3 AND last_generate_fail_at < datetime('now','-15 minutes')))
           ORDER BY created_at ASC`,
          [projectId],
        )
        .map((row) => ({ ...row, __type: 'requirement' }));
      const pendingFeedback = this.db
        .all(
          `SELECT * FROM feedback
           WHERE project_id = ? AND linked_plan_id IS NULL
             AND status NOT IN ('completed', 'closed')
             AND (generate_fail_count < 3 OR (generate_fail_count >= 3 AND last_generate_fail_at < datetime('now','-15 minutes')))
           ORDER BY created_at ASC`,
          [projectId],
        )
        .map((row) => ({ ...row, __type: 'feedback' }));
      const pendingIntakes = [...pendingRequirements, ...pendingFeedback];
      cycleSummary.pendingIntakes = pendingIntakes.length;
      this.addEvent(projectId, 'scan.done', `待处理需求/反馈=${pendingIntakes.length}`);

      // 一次只生成一个计划（保持串行，避免 codex 并发），剩余等下一轮 timer
      let generatedPlanId = null;
      if (pendingIntakes.length > 0) {
        generatedPlanId = await this.generatePlanForIntake(projectId, workspace, pendingIntakes[0]);
      }
      cycleSummary.generatedPlanId = generatedPlanId;

      // 同步 docs/plan 目录下的 plan 文件（兼容文件式需求）
      const planScan = await this.scanDirectoryInWorker(path.join(workspace, 'docs', 'plan'), workspace, ['.md']);
      if (startedFromRunningLoop && !runtime.running) return;
      this.saveScan(projectId, 'plan', planScan);

      // 执行队列里可运行的 plan
      const generatedPlan = generatedPlanId
        ? this.db.get('SELECT * FROM plans WHERE id = ? AND project_id = ?', [generatedPlanId, projectId])
        : null;
      const nextPlan = generatedPlan && generatedPlan.status !== 'draft'
        ? generatedPlan
        : this.nextRunnablePlan(projectId);
      if (!nextPlan) {
        if (runtime.running || this.db.get('SELECT phase FROM project_states WHERE project_id = ?', [projectId])?.phase !== 'stopped') {
          this.setPhase(projectId, pendingIntakes.length > 0 && runtime.running ? 'waiting' : 'idle');
        }
        return;
      }

      await this.processPlan(workspace, nextPlan);
      if (!this.planExists(projectId, nextPlan.id)) return;
      if (runtime.running) {
        this.setPhase(projectId, 'waiting');
      } else if (this.db.get('SELECT phase FROM project_states WHERE project_id = ?', [projectId])?.phase !== 'stopped') {
        this.setPhase(projectId, 'idle');
      }
    } finally {
      // loop:end 钩子：本周期结束触发，携带本周期汇总；失败仅记事件，绝不中断后续循环
      cycleSummary.phase = this.db.get('SELECT phase FROM project_states WHERE project_id = ?', [projectId])?.phase || null;
      try {
        await this.runHookScripts(projectId, 'loop:end', { summary: cycleSummary, workspace: this.project(projectId)?.workspace_path || '' });
      } catch (error) {
        this.addEvent(projectId, 'script.hook.error', `loop:end 钩子执行异常：${error?.message || error}`);
      }
      runtime.busy = false;
      this.emitUpdate(projectId);
    }
  }

  async runTask(projectId, taskId) {
    const runtime = this.runtime(projectId);
    if (!runtime) return;
    if (runtime.busy) throw new Error('该项目已有任务正在执行，请稍后再试');
    const project = this.project(projectId);
    const task = this.taskForProject(projectId, taskId);
    const plan = task ? this.db.get('SELECT * FROM plans WHERE id = ? AND project_id = ?', [task.plan_id, projectId]) : null;
    const workspace = project?.workspace_path;
    if (!project || !task || !plan) throw new Error('任务不存在');
    if (!workspace) throw new Error('请先设置项目工作区路径');
    const workspaceOwner = this.activeProjectForWorkspace(workspace, projectId);
    if (workspaceOwner) {
      throw new Error(`工作区正在被项目「${workspaceOwner.name}」使用，请先停止对应循环`);
    }

    const executablePlan = this.activateDraftPlan(plan);
    runtime.busy = true;
    try {
      if (this.isFinalAcceptanceTask(executablePlan.id, task)) {
        const result = await this.validatePlan(workspace, executablePlan, { task });
        if (result?.cancelled || !this.planExists(projectId, executablePlan.id)) return;
      } else {
        const backoff = taskExecution.TASK_RETRY_BACKOFF_SECONDS;
        let attempt = 0;
        let result;
        do {
          result = await this.executeTask(workspace, executablePlan, task);
          if (result?.cancelled || !this.taskExists(projectId, executablePlan.id, task.id)) return;
          if (result.exitCode === 0) break;
          attempt++;
          if (attempt <= backoff.length && !classifyExecutionFailure(result).environmentBlocked) {
            const delaySeconds = backoff[attempt - 1];
            this.addEvent(projectId, 'task.retry',
              `任务 ${task.task_key} 第 ${attempt} 次重试，等待 ${delaySeconds}s`,
              {
                planId: executablePlan.id,
                taskId: task.id,
                taskKey: task.task_key,
                attempt,
                delaySeconds,
              },
            );
            await new Promise((resolve) => setTimeout(resolve, delaySeconds * 1000));
            if (!this.taskExists(projectId, executablePlan.id, task.id)) return;
          }
        } while (result.exitCode !== 0 && attempt <= backoff.length && !classifyExecutionFailure(result).environmentBlocked);
        if (result.exitCode === 0) {
          await this.completeTask(workspace, executablePlan, task, result);
        }
      }
      if (!this.planExists(projectId, executablePlan.id)) return;
      if (runtime.running) {
        this.setPhase(projectId, 'waiting');
      } else if (this.db.get('SELECT phase FROM project_states WHERE project_id = ?', [projectId])?.phase !== 'stopped') {
        this.setPhase(projectId, 'idle');
      }
    } finally {
      runtime.busy = false;
      this.emitUpdate(projectId);
    }
  }

  async runTaskBatches(projectId, planId, confirmedBatches) {
    const runtime = this.runtime(projectId);
    if (!runtime) return;
    if (runtime.busy) throw new Error('该项目已有任务正在执行，请稍后再试');
    const project = this.project(projectId);
    const plan = this.db.get('SELECT * FROM plans WHERE id = ? AND project_id = ?', [planId, projectId]);
    const workspace = project?.workspace_path;
    if (!project || !plan) throw new Error('计划不存在');
    if (plan.validation_passed || plan.status === 'completed') throw new Error('计划已完成，不能启动并发执行');
    if (!workspace) throw new Error('请先设置项目工作区路径');
    const workspaceOwner = this.activeProjectForWorkspace(workspace, projectId);
    if (workspaceOwner) {
      throw new Error(`工作区正在被项目「${workspaceOwner.name}」使用，请先停止对应循环`);
    }

    const executablePlan = this.activateDraftPlan(plan);
    if (executablePlan.validation_passed || executablePlan.status === 'completed') throw new Error('计划已完成，不能启动并发执行');
    const batches = this.validatedParallelTaskBatches(workspace, executablePlan, confirmedBatches);
    runtime.busy = true;
    try {
      for (let index = 0; index < batches.length; index += 1) {
        const tasks = batches[index];
        const results = await this.executeTaskBatch(workspace, executablePlan, tasks, {
          batchIndex: index + 1,
          batchCount: batches.length,
        });
        if (!this.planExists(projectId, executablePlan.id)) return;
        if (results.some((entry) => entry?.result?.cancelled)) return;
        const failedTaskIds = results
          .filter((entry) => Number(entry?.result?.exitCode) !== 0)
          .map((entry) => entry.task.id);
        const continueNext = failedTaskIds.length === 0;
        this.addEvent(projectId, 'tasks.parallel.finished', `并发批次 ${index + 1}/${batches.length} 执行完成`, {
          planId: executablePlan.id,
          batchIndex: index + 1,
          batchCount: batches.length,
          taskIds: tasks.map((task) => task.id),
          failedTaskIds,
          continueNext,
        });
        if (!continueNext) break;
      }
      if (runtime.running) {
        this.setPhase(projectId, 'waiting');
      } else if (this.db.get('SELECT phase FROM project_states WHERE project_id = ?', [projectId])?.phase !== 'stopped') {
        this.setPhase(projectId, 'idle');
      }
    } finally {
      runtime.busy = false;
      this.emitUpdate(projectId);
    }
  }

  validatedParallelTaskBatches(workspace, plan, confirmedBatches) {
    return concurrency.validatedParallelTaskBatches(this, workspace, plan, confirmedBatches);
  }

  stopTask(projectId, taskId) {
    const task = this.taskForProject(projectId, taskId);
    if (!task) throw new Error('任务不存在');
    const runtime = this.runtime(projectId);
    stopRuntimeTask(projectId, taskId, task, runtime, {
      finishTaskRun: (id, status, finishedAt, options) => this.finishTaskRun(id, status, finishedAt, options),
      addTaskLifecycleEvent: (id, type, eventTask, meta) => this.addTaskLifecycleEvent(id, type, eventTask, meta),
      taskPlan: (eventTask) => this.db.get('SELECT * FROM plans WHERE id = ? AND project_id = ?', [eventTask.plan_id, projectId]),
      planAgentCliConfig: (plan) => this.planAgentCliConfig(plan),
      status: (id) => this.status(id),
      stopProject: (id) => this.stop(id),
      setPhase: (id, phase) => this.setPhase(id, phase),
    });
  }

  taskForProject(projectId, taskId) {
    if (!taskId) return null;
    return this.db.get(
      `SELECT plan_tasks.*
       FROM plan_tasks JOIN plans ON plans.id = plan_tasks.plan_id
       WHERE plan_tasks.id = ? AND plans.project_id = ?`,
      [taskId, projectId],
    );
  }

  planExists(projectId, planId) {
    if (!planId) return false;
    if (!projectId) return Boolean(this.db.get('SELECT 1 FROM plans WHERE id = ?', [planId]));
    return Boolean(this.db.get('SELECT 1 FROM plans WHERE id = ? AND project_id = ?', [planId, projectId]));
  }

  taskExists(projectId, planId, taskId) {
    if (!planId || !taskId) return false;
    if (!projectId) {
      return Boolean(this.db.get('SELECT 1 FROM plan_tasks WHERE id = ? AND plan_id = ?', [taskId, planId]));
    }
    return Boolean(
      this.db.get(
        `SELECT 1
         FROM plan_tasks JOIN plans ON plans.id = plan_tasks.plan_id
         WHERE plan_tasks.id = ? AND plan_tasks.plan_id = ? AND plans.project_id = ?`,
        [taskId, planId, projectId],
      ),
    );
  }

  operationTargetExists(operation = {}) {
    const projectId = Number(operation.projectId || 0);
    const planId = Number(operation.planId || 0);
    const taskId = Number(operation.taskId || 0);
    if (!planId) return true;
    if (!this.planExists(projectId, planId)) return false;
    if (taskId && !this.taskExists(projectId, planId, taskId)) return false;
    return true;
  }

  stopPlanOperations(projectId, planId, options = {}) {
    const runtime = this.existingRuntime(projectId);
    const stopped = stopRuntimePlanOperations(runtime, planId, {
      archive: options.archive !== false,
      errorMessage: options.errorMessage || `plan #${planId} 已停止`,
    });
    if (!stopped.length) return stopped;
    const finishedAt = options.finishedAt || nowIso();
    for (const entry of stopped) {
      const operation = entry.operation || {};
      const activeTaskId = operation.taskId || null;
      const activeTask = activeTaskId ? this.taskForProject(projectId, activeTaskId) : null;
      const stoppedTask = activeTaskId && options.taskStatus
        ? this.finishTaskRun(activeTaskId, options.taskStatus, finishedAt, { onlyIfRunning: true })
        : null;
      const eventTask = stoppedTask || activeTask || (activeTaskId ? { id: activeTaskId, plan_id: planId } : null);
      if (eventTask && options.taskEventType) {
        this.addTaskLifecycleEvent(projectId, options.taskEventType, eventTask, {
          ...agentCliContextFields(operation, { defaultProvider: true }),
          planId,
          taskId: activeTaskId || undefined,
          status: options.taskEventStatus || options.taskStatus,
          finishedAt,
          log: operation.logFile,
          exitCode: typeof operation.exitCode === 'number' ? operation.exitCode : undefined,
        });
      } else if (options.addOperationEvent !== false) {
        this.addEvent(projectId, 'operation.stopping', operation.label || `plan #${planId}`);
      }
    }
    this.emitUpdate(projectId, { immediate: true });
    return stopped;
  }

  startTaskRun(taskId, startedAt = nowIso()) {
    this.db.run(
      `UPDATE plan_tasks
       SET status = ?,
           started_at = CASE WHEN status = ? AND started_at IS NOT NULL THEN started_at ELSE ? END,
           finished_at = NULL,
           updated_at = ?
       WHERE id = ?`,
      [TASK_EVENT_STATUS.RUNNING, TASK_EVENT_STATUS.RUNNING, startedAt, startedAt, taskId],
    );
    return this.db.get('SELECT * FROM plan_tasks WHERE id = ?', [taskId]);
  }

  updateTaskCodexSession(taskId, sessionId, updatedAt = nowIso()) {
    const normalizedSessionId = normalizeCodexSessionId(sessionId);
    if (!normalizedSessionId) return this.db.get('SELECT * FROM plan_tasks WHERE id = ?', [taskId]);
    this.db.run(
      `UPDATE plan_tasks
       SET codex_session_id = ?, updated_at = ?
       WHERE id = ?`,
      [normalizedSessionId, updatedAt, taskId],
    );
    return this.db.get('SELECT * FROM plan_tasks WHERE id = ?', [taskId]);
  }

  updateTaskAgentCliSession(taskId, sessionId, updatedAt = nowIso()) {
    const normalizedSessionId = normalizeAgentCliSessionId(sessionId);
    if (!normalizedSessionId) return this.db.get('SELECT * FROM plan_tasks WHERE id = ?', [taskId]);
    this.db.run(
      `UPDATE plan_tasks
       SET agent_cli_session_id = ?, updated_at = ?
       WHERE id = ?`,
      [normalizedSessionId, updatedAt, taskId],
    );
    return this.db.get('SELECT * FROM plan_tasks WHERE id = ?', [taskId]);
  }

  planAgentCliSessionId(planId) {
    if (!planId) return '';
    const row = this.db.get('SELECT agent_cli_session_id FROM plans WHERE id = ?', [planId]);
    return normalizeAgentCliSessionId(row?.agent_cli_session_id);
  }

  updatePlanAgentCliSession(planId, sessionId, updatedAt = nowIso()) {
    if (!planId) return null;
    const normalizedSessionId = normalizeAgentCliSessionId(sessionId);
    this.db.run(
      `UPDATE plans
       SET agent_cli_session_id = ?, updated_at = ?
       WHERE id = ?`,
      [normalizedSessionId || null, updatedAt, planId],
    );
    return this.db.get('SELECT * FROM plans WHERE id = ?', [planId]);
  }

  finishTaskRun(taskId, status, finishedAt = nowIso(), options = {}) {
    const task = this.db.get('SELECT * FROM plan_tasks WHERE id = ?', [taskId]);
    if (!task) return null;
    const isRunning = task.status === TASK_EVENT_STATUS.RUNNING;
    if (options.onlyIfRunning && !isRunning) return withTaskDurationMeta(task);

    const runDurationMs = isRunning ? taskRunDurationMs(task.started_at, finishedAt) : undefined;
    const durationMs = normalizeDurationMs(task.duration_ms) + (runDurationMs || 0);
    this.db.run(
      `UPDATE plan_tasks
       SET status = ?, duration_ms = ?, finished_at = ?, updated_at = ?
       WHERE id = ?`,
      [status, durationMs, finishedAt, finishedAt, taskId],
    );
    return withTaskDurationMeta(
      {
        ...task,
        status,
        duration_ms: durationMs,
        finished_at: finishedAt,
        updated_at: finishedAt,
      },
      runDurationMs,
    );
  }

  addTaskLifecycleEvent(projectId, type, task, metaOverrides = {}) {
    const meta = taskEventMeta(task, metaOverrides);
    this.addEvent(projectId, type, taskEventMessage(type, task, meta), meta);
  }

  recordTaskFailure(projectId, plan, task, finishedAt = nowIso(), metaOverrides = {}) {
    const currentTask = this.db.get('SELECT * FROM plan_tasks WHERE id = ?', [task.id]) || task;
    if (currentTask.status !== TASK_EVENT_STATUS.RUNNING) return null;
    const failedTask = this.finishTaskRun(task.id, TASK_EVENT_STATUS.PENDING, finishedAt, { onlyIfRunning: true }) || currentTask;
    this.addTaskLifecycleEvent(projectId, TASK_EVENT_TYPES.FAILED, failedTask, {
      planId: plan?.id,
      status: TASK_EVENT_STATUS.FAILED,
      finishedAt,
      ...metaOverrides,
    });
    return failedTask;
  }

  /** 中断某个 plan：停止正在执行的 codex 进程，未完成任务标记为 blocked，plan 标记为 interrupted */
  interruptPlan(projectId, planId) {
    const plan = this.db.get('SELECT * FROM plans WHERE id = ? AND project_id = ?', [planId, projectId]);
    if (!plan) return;
    this.stopPlanOperations(projectId, planId, {
      taskStatus: 'blocked',
      taskEventType: TASK_EVENT_TYPES.INTERRUPTED,
      taskEventStatus: TASK_EVENT_STATUS.INTERRUPTED,
      errorMessage: `plan #${planId} 已中断`,
      addOperationEvent: false,
    });
    // 其余未完成任务 → blocked
    this.db.run(
      `UPDATE plan_tasks SET status = ?, updated_at = ?
       WHERE plan_id = ? AND status IN ('pending', 'running')`,
      ['blocked', nowIso(), planId],
    );
    this.db.run('UPDATE plans SET status = ?, updated_at = ? WHERE id = ?', ['interrupted', nowIso(), planId]);
    this.addEvent(projectId, 'plan.interrupted', `plan #${planId} 已中断，未完成任务已挂起`);
    this.emitUpdate(projectId);
  }

  deleteIntake(projectId, intakeType, intakeId, options = {}) {
    const normalizedType = intakeType === 'feedback' ? 'feedback' : 'requirement';
    const table = normalizedType === 'feedback' ? 'feedback' : 'requirements';
    const ownerTypes = intakeAttachments.intakeAttachmentOwnerTypes(normalizedType);
    const sourceName = normalizedType === 'feedback' ? '反馈' : '需求';
    const intake = this.db.get(`SELECT * FROM ${table} WHERE id = ? AND project_id = ?`, [intakeId, projectId]);
    if (!intake) throw new Error(`${sourceName}不存在`);

    const project = this.project(projectId);
    const attachments = this.db.all(
      `SELECT * FROM attachments
       WHERE project_id = ? AND owner_id = ? AND owner_type IN (${ownerTypes.map(() => '?').join(',')})
       ORDER BY id ASC`,
      [projectId, intakeId, ...ownerTypes],
    );
    const planId = Number(intake.linked_plan_id || 0) || null;
    const plan = planId
      ? this.db.get('SELECT * FROM plans WHERE id = ? AND project_id = ?', [planId, projectId])
      : null;
    if (planId) {
      this.stopPlanOperations(projectId, planId, {
        archive: false,
        errorMessage: `${sourceName} #${intakeId} 已删除，关联计划已停止`,
        addOperationEvent: false,
      });
    }

    const planFileDelete = plan
      ? this.safeAutoPlanIntakePlanFileDeleteTarget(project, plan, normalizedType, intakeId)
      : null;
    const updatedAt = nowIso();
    const statements = [];
    if (normalizedType === 'requirement') {
      statements.push({
        sql: 'UPDATE feedback SET requirement_id = NULL, updated_at = ? WHERE project_id = ? AND requirement_id = ?',
        params: [updatedAt, projectId, intakeId],
      });
    }
    if (plan) {
      statements.push(
        { sql: 'DELETE FROM plan_tasks WHERE plan_id = ?', params: [plan.id] },
        { sql: 'DELETE FROM plans WHERE id = ? AND project_id = ?', params: [plan.id, projectId] },
      );
      for (const scanPath of uniqueNonEmptyStrings(plan.file_path, planFileDelete?.relativePath)) {
        statements.push({
          sql: "DELETE FROM scan_files WHERE project_id = ? AND scan_type = 'plan' AND file_path = ?",
          params: [projectId, scanPath],
        });
      }
    }
    statements.push(
      {
        sql: `DELETE FROM attachments
              WHERE project_id = ? AND owner_id = ? AND owner_type IN (${ownerTypes.map(() => '?').join(',')})`,
        params: [projectId, intakeId, ...ownerTypes],
      },
      { sql: `DELETE FROM ${table} WHERE id = ? AND project_id = ?`, params: [intakeId, projectId] },
    );
    this.db.runBatch(statements);
    if (planFileDelete) {
      if (planFileDelete.safe) this.deleteResolvedPlanFile(plan, planFileDelete);
      else this.recordPlanFileDeleteSkipped(plan, planFileDelete);
    }
    const attachmentFiles = this.deleteAttachmentFiles(attachments, options.attachmentsRoot);
    this.addEvent(projectId, 'intake.deleted', `${sourceName} #${intakeId} 已删除${plan ? '，关联计划和任务已删除' : ''}`, {
      intakeType: normalizedType,
      intakeId,
      planId: plan?.id || null,
      planFile: planFileDelete,
      attachments: {
        total: attachments.length,
        ...attachmentFiles,
      },
    });
    this.emitUpdate(projectId, { immediate: true });
    return this.snapshot(projectId);
  }

  deleteAttachmentFiles(attachments = [], attachmentsRoot = '') {
    const root = String(attachmentsRoot || '').trim();
    const result = { deleted: 0, skipped: 0, failed: 0 };
    if (!root) {
      result.skipped = attachments.length;
      return result;
    }
    const rootPath = path.resolve(root);
    for (const attachment of attachments) {
      const storedPath = String(attachment?.stored_path || '').trim();
      const filePath = storedPath
        ? (path.isAbsolute(storedPath) ? path.resolve(storedPath) : path.resolve(rootPath, storedPath))
        : '';
      if (!filePath || !isInsideDirectory(rootPath, filePath)) {
        result.skipped += 1;
        continue;
      }
      try {
        if (fs.existsSync(filePath)) {
          if (!fs.statSync(filePath).isFile()) {
            result.skipped += 1;
            continue;
          }
          fs.unlinkSync(filePath);
          result.deleted += 1;
        } else {
          result.skipped += 1;
        }
      } catch {
        result.failed += 1;
      }
    }
    return result;
  }

  safeAutoPlanIntakePlanFileDeleteTarget(project, plan, intakeType, intakeId) {
    const safety = resolveSafeAutoPlanIntakePlanPath(project?.workspace_path, plan?.file_path, intakeType, intakeId);
    const result = {
      safe: safety.safe,
      reason: safety.reason || '',
      relativePath: safety.relativePath || String(plan?.file_path || ''),
      filePath: safety.filePath || '',
      planDir: safety.planDir || '',
      intakeType,
      intakeId,
      deleted: false,
    };
    if (!safety.safe) result.expectedPattern = safety.expectedPattern || '';
    return result;
  }

  recordPlanFileDeleteSkipped(plan, result = {}) {
    if (!plan) return;
    this.addEvent(plan.project_id, 'plan.file.delete.skipped', `关联计划文件未删除：${result.reason || '路径不安全'}`, {
      planId: plan.id,
      intakeType: result.intakeType,
      intakeId: result.intakeId,
      filePath: plan.file_path,
      reason: result.reason,
      expectedPattern: result.expectedPattern,
    });
  }

  deleteResolvedPlanFile(plan, result) {
    if (!result?.safe || !result.filePath) return result;
    try {
      if (fs.existsSync(result.filePath)) {
        const realPlanDir = fs.realpathSync(result.planDir);
        const realFilePath = fs.realpathSync(result.filePath);
        if (!isInsideDirectory(realPlanDir, realFilePath)) {
          result.safe = false;
          result.reason = 'realpath_outside_docs_plan';
          this.addEvent(plan.project_id, 'plan.file.delete.skipped', '关联计划文件未删除：真实路径超出 docs/plan', {
            planId: plan.id,
            filePath: result.relativePath,
            intakeType: result.intakeType,
            intakeId: result.intakeId,
            reason: result.reason,
          });
          return result;
        }
        fs.unlinkSync(result.filePath);
        result.deleted = true;
      }
      return result;
    } catch (error) {
      result.reason = error?.message || String(error);
      this.addEvent(plan.project_id, 'plan.file.delete.failed', `关联计划文件删除失败：${result.reason}`, {
        planId: plan.id,
        filePath: result.relativePath,
        intakeType: result.intakeType,
        intakeId: result.intakeId,
        error: result.reason,
      });
      return result;
    }
  }

  /** 恢复被中断的 plan：blocked → pending，plan → pending，循环运行时自动继续执行 */
  resumePlan(projectId, planId) {
    this.db.run(
      `UPDATE plan_tasks SET status = ?, updated_at = ?
       WHERE plan_id = ? AND status = ?`,
      ['pending', nowIso(), planId, 'blocked'],
    );
    this.db.run('UPDATE plans SET status = ?, updated_at = ? WHERE id = ?', ['pending', nowIso(), planId]);
    this.addEvent(projectId, 'plan.resumed', `plan #${planId} 已恢复`);
    this.emitUpdate(projectId);
  }

  /** 人工验收：对已完成的计划/任务置 accepted_at（不改变执行态 status），并记事件；重复验收刷新时间不报错。 */
  acceptItem(projectId, { targetType, id } = {}) {
    const target = this.acceptanceTargetRow(projectId, targetType, id);
    const acceptedAt = nowIso();
    const result = this.writeAcceptance(targetType, target, acceptedAt, projectId);
    this.emitUpdate(projectId);
    return result;
  }

  /** 取消人工验收：清空 accepted_at（NULL），不改变执行态 status，并记事件；重复取消保持 NULL 不报错。 */
  unacceptItem(projectId, { targetType, id } = {}) {
    const target = this.acceptanceTargetRow(projectId, targetType, id, { requireCompleted: false });
    const updatedAt = nowIso();
    const result = this.writeAcceptance(targetType, target, null, projectId, updatedAt);
    this.emitUpdate(projectId);
    return result;
  }

  /** 校验收目标：按 targetType 路由 plan/task、校验归属当前项目与「已完成」态；不存在或不可验收时抛中文错误。 */
  acceptanceTargetRow(projectId, targetType, id, options = {}) {
    const normalizedId = Number(id);
    if (!Number.isFinite(normalizedId) || normalizedId <= 0) throw new Error('验收目标 ID 无效');
    const requireCompleted = options.requireCompleted !== false;
    if (targetType === 'plan') {
      const plan = this.db.get('SELECT * FROM plans WHERE id = ? AND project_id = ?', [normalizedId, projectId]);
      if (!plan) throw new Error('计划不存在');
      if (requireCompleted && plan.status !== ACCEPTABLE_PLAN_STATUS) {
        throw new Error('仅可验收已完成的计划/任务');
      }
      return plan;
    }
    if (targetType === 'task') {
      const task = this.db.get(
        `SELECT plan_tasks.*
         FROM plan_tasks JOIN plans ON plans.id = plan_tasks.plan_id
         WHERE plan_tasks.id = ? AND plans.project_id = ?`,
        [normalizedId, projectId],
      );
      if (!task) throw new Error('任务不存在');
      if (requireCompleted && !ACCEPTABLE_TASK_STATUSES.includes(task.status)) {
        throw new Error('仅可验收已完成的计划/任务');
      }
      return task;
    }
    throw new Error('验收目标类型无效');
  }

  /**
   * 写入单条验收态的私有 helper（acceptItem/unacceptItem 与 acceptItems/unacceptItems 共用）。
   * 只置/清 accepted_at 并记事件，绝不执行脚本或任务——验收模块是纯人工确认，与
   * 「完整验收」任务经 runTask→validatePlan 执行 validation_command 的链路完全解耦。
   * acceptedAt 非空 → 验收（accepted_at=acceptedAt、updated_at=acceptedAt，记 *.accepted 事件）；
   * acceptedAt 为 null → 取消验收（accepted_at=NULL、updated_at=updatedAt，记 *.unaccepted 事件）。
   * 返回 { targetType, id, accepted_at }，供单目标/批量调用方回传。
   */
  writeAcceptance(targetType, row, acceptedAt, projectId, updatedAt = acceptedAt ?? nowIso()) {
    if (targetType === 'plan') {
      if (acceptedAt) {
        this.db.run(
          'UPDATE plans SET accepted_at = ?, updated_at = ? WHERE id = ? AND project_id = ?',
          [acceptedAt, acceptedAt, row.id, projectId],
        );
        this.addEvent(projectId, 'plan.accepted', `plan #${row.id} 已验收`, {
          targetType: 'plan',
          id: row.id,
          planId: row.id,
          accepted_at: acceptedAt,
        });
      } else {
        this.db.run(
          'UPDATE plans SET accepted_at = NULL, updated_at = ? WHERE id = ? AND project_id = ?',
          [updatedAt, row.id, projectId],
        );
        this.addEvent(projectId, 'plan.unaccepted', `plan #${row.id} 已取消验收`, {
          targetType: 'plan',
          id: row.id,
          planId: row.id,
          accepted_at: null,
        });
      }
      return { targetType, id: row.id, accepted_at: acceptedAt ?? null };
    }
    if (acceptedAt) {
      this.db.run(
        'UPDATE plan_tasks SET accepted_at = ?, updated_at = ? WHERE id = ?',
        [acceptedAt, acceptedAt, row.id],
      );
      this.addEvent(projectId, 'task.accepted', `${row.task_key} 已验收`, {
        targetType: 'task',
        id: row.id,
        taskId: row.id,
        planId: row.plan_id,
        taskKey: row.task_key,
        accepted_at: acceptedAt,
      });
    } else {
      this.db.run(
        'UPDATE plan_tasks SET accepted_at = NULL, updated_at = ? WHERE id = ?',
        [updatedAt, row.id],
      );
      this.addEvent(projectId, 'task.unaccepted', `${row.task_key} 已取消验收`, {
        targetType: 'task',
        id: row.id,
        taskId: row.id,
        planId: row.plan_id,
        taskKey: row.task_key,
        accepted_at: null,
      });
    }
    return { targetType, id: row.id, accepted_at: acceptedAt ?? null };
  }

  /**
   * 批量人工验收：对一组已完成的计划/任务一次性置 accepted_at（不改变执行态 status）。
   * 先全量预校验（acceptanceTargetRow，requireCompleted:true），任一目标非法即整体抛中文错误、
   * 不写任何行（全有或全无）；全部通过后用同一时间戳逐条 UPDATE+addEvent，最后一次 emitUpdate。
   * 纯人工确认：绝不调用 validatePlan/runShell/runCodex/executeTask/runOnce，不读/不执行 validation_command，不启动任何任务/脚本。
   */
  acceptItems(projectId, targets) {
    const normalized = normalizeAcceptanceTargets(targets, '批量验收目标列表为空');
    // 先全量预校验（全有或全无）：任一目标非法即整体抛错，在此之前不写任何行
    const rows = normalized.map(({ targetType, id }) => ({
      targetType,
      row: this.acceptanceTargetRow(projectId, targetType, id),
    }));
    // 全部校验通过 → 用同一时间戳逐条写入 + 记事件（不执行任何脚本/任务）
    const acceptedAt = nowIso();
    const items = rows.map(({ targetType, row }) =>
      this.writeAcceptance(targetType, row, acceptedAt, projectId),
    );
    this.emitUpdate(projectId);
    return { accepted: items.length, items };
  }

  /**
   * 批量取消人工验收：对一组计划/任务一次性清空 accepted_at（NULL），不改变执行态 status。
   * 先全量预校验（acceptanceTargetRow，requireCompleted:false），任一目标非法即整体抛中文错误、
   * 不写任何行；全部通过后用同一时间戳逐条 UPDATE+addEvent，最后一次 emitUpdate。
   * 纯人工确认：绝不调用 validatePlan/runShell/runCodex/executeTask/runOnce，不读/不执行 validation_command，不启动任何任务/脚本。
   */
  unacceptItems(projectId, targets) {
    const normalized = normalizeAcceptanceTargets(targets, '批量取消验收目标列表为空');
    // 先全量预校验（全有或全无）
    const rows = normalized.map(({ targetType, id }) => ({
      targetType,
      row: this.acceptanceTargetRow(projectId, targetType, id, { requireCompleted: false }),
    }));
    // 全部校验通过 → 用同一时间戳逐条写入 + 记事件
    const updatedAt = nowIso();
    const items = rows.map(({ targetType, row }) =>
      this.writeAcceptance(targetType, row, null, projectId, updatedAt),
    );
    this.emitUpdate(projectId);
    return { unaccepted: items.length, items };
  }

  /** 向现有 plan 追加一个任务：写回 plan 文件 + syncPlanTasks 重新解析 */
  appendTask(projectId, planId, title) {
    return planParser.appendTask(this, loopFlowHelpers(), projectId, planId, title);
  }

  ensureWorkspaceDirs(workspace) {
    return workspaceFiles.ensureWorkspaceDirs(this, loopFlowHelpers(), workspace);
  }

  scanDirectory(root, workspace, extensions) {
    return workspaceFiles.scanDirectory(this, loopFlowHelpers(), root, workspace, extensions);
  }

  scanDirectoryInWorker(root, workspace, extensions) {
    return workspaceFiles.scanDirectoryInWorker(root, workspace, extensions);
  }

  saveScan(projectId, type, scan) {
    return workspaceFiles.saveScan(this, loopFlowHelpers(), projectId, type, scan);
  }

  hasPlanForIssueHash(projectId, issueHash) {
    return Boolean(
      this.db.get('SELECT id FROM plans WHERE project_id = ? AND issue_hash = ? LIMIT 1', [projectId, issueHash]),
    );
  }

  nextRunnablePlan(projectId) {
    return this.db.get(
      `SELECT * FROM plans
       WHERE project_id = ? AND status NOT IN ('completed', 'interrupted', 'draft')
       ORDER BY sort_order ASC, created_at ASC, id ASC
       LIMIT 1`,
      [projectId],
    );
  }

  nextPlanSortOrder(projectId) {
    const row = this.db.get('SELECT COALESCE(MAX(sort_order), 0) AS sort_order FROM plans WHERE project_id = ?', [projectId]);
    return Number(row?.sort_order || 0) + 1;
  }

  activateDraftPlan(plan) {
    if (!plan?.id) return plan;
    const currentPlan = plan.project_id != null
      ? this.db.get('SELECT * FROM plans WHERE id = ? AND project_id = ?', [plan.id, plan.project_id])
      : this.db.get('SELECT * FROM plans WHERE id = ?', [plan.id]);
    if (!currentPlan) return plan;
    if (currentPlan.status !== 'draft') return currentPlan;

    const updatedAt = nowIso();
    this.db.runBatch([
      {
        sql: 'UPDATE plans SET status = ?, updated_at = ? WHERE id = ? AND status = ?',
        params: ['running', updatedAt, currentPlan.id, 'draft'],
      },
      {
        sql: `INSERT INTO events (project_id, type, message, meta, created_at)
              SELECT ?, ?, ?, ?, ?
              WHERE EXISTS (
                SELECT 1 FROM plans
                WHERE id = ? AND status != ? AND updated_at = ?
              )`,
        params: [
          currentPlan.project_id,
          'plan.draft.started',
          `草稿计划 #${currentPlan.id} 已开始执行`,
          JSON.stringify({ planId: currentPlan.id }),
          updatedAt,
          currentPlan.id,
          'draft',
          updatedAt,
        ],
      },
    ]);
    const activatedPlan = this.db.get('SELECT * FROM plans WHERE id = ?', [currentPlan.id]);
    if (!activatedPlan) return currentPlan;
    if (activatedPlan.status === 'draft') {
      throw new Error(`草稿计划 #${currentPlan.id} 激活失败`);
    }
    this.emitUpdate(activatedPlan.project_id);
    return activatedPlan;
  }

  reorderPlans(projectId, planIds) {
    const normalizedProjectId = Number(projectId || 0);
    if (!normalizedProjectId || !this.project(normalizedProjectId)) throw new Error('项目不存在');
    if (!Array.isArray(planIds)) throw new Error('计划顺序无效');

    const orderedIds = planIds.map((id) => Number(id));
    if (orderedIds.some((id) => !Number.isInteger(id) || id <= 0)) throw new Error('计划顺序包含非法 ID');
    if (new Set(orderedIds).size !== orderedIds.length) throw new Error('计划顺序包含重复 ID');

    const existingPlans = this.db.all(
      'SELECT id, sort_order FROM plans WHERE project_id = ? ORDER BY sort_order ASC, created_at ASC, id ASC',
      [normalizedProjectId],
    );
    if (orderedIds.length !== existingPlans.length) throw new Error('计划顺序缺少或多出计划');

    const existingIds = new Set(existingPlans.map((plan) => Number(plan.id)));
    for (const id of orderedIds) {
      if (!existingIds.has(id)) throw new Error('计划顺序包含不属于当前项目的计划');
    }

    const currentOrderById = new Map(existingPlans.map((plan) => [Number(plan.id), Number(plan.sort_order || 0)]));
    const updatedAt = nowIso();
    orderedIds.forEach((id, index) => {
      const sortOrder = index + 1;
      if (currentOrderById.get(id) === sortOrder) return;
      this.db.run('UPDATE plans SET sort_order = ?, updated_at = ? WHERE id = ? AND project_id = ?', [
        sortOrder,
        updatedAt,
        id,
        normalizedProjectId,
      ]);
    });
    this.emitUpdate(normalizedProjectId);
    return this.snapshot(normalizedProjectId);
  }

  insertPlan({ projectId, issueHash, filePath, hash, status, sortOrder, agentCliConfig }) {
    const createdAt = nowIso();
    const normalizedSortOrder = Number.isFinite(Number(sortOrder)) && Number(sortOrder) > 0
      ? Number(sortOrder)
      : this.nextPlanSortOrder(projectId);
    const columns = [
      'project_id',
      'issue_hash',
      'file_path',
      'hash',
      'status',
      'sort_order',
      'total_tasks',
      'completed_tasks',
      'validation_passed',
      'created_at',
      'updated_at',
    ];
    const values = [projectId, issueHash, filePath, hash, status, normalizedSortOrder, 0, 0, 0, createdAt, createdAt];
    for (const [column, value] of planAgentCliColumnValues(this.planColumns(), agentCliConfig)) {
      columns.push(column);
      values.push(value);
    }
    return this.db.insert(
      `INSERT INTO plans (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
      values,
    );
  }

  planAgentCliConfig(plan) {
    const projectDefaults = this.status(plan.project_id);
    const eventSnapshot = this.planAgentCliEventSnapshot(plan.project_id, plan.id);
    const sourceSnapshot = this.planSourceAgentCliSnapshot(plan.project_id, plan.id);
    const snapshotDefaults = eventSnapshot || sourceSnapshot || projectDefaults;
    if (hasAgentCliOverride(plan)) return effectiveAgentCliConfig(snapshotDefaults, plan);
    if (eventSnapshot) return effectiveAgentCliConfig(projectDefaults, eventSnapshot);
    if (sourceSnapshot) return effectiveAgentCliConfig(projectDefaults, sourceSnapshot);
    return effectiveAgentCliConfig(projectDefaults);
  }

  planSnapshotAgentCliConfig(plan) {
    return this.planAgentCliConfig(plan);
  }

  planAgentCliEventSnapshot(projectId, planId) {
    const rows = this.db.all(
      `SELECT meta FROM events
       WHERE project_id = ? AND type = 'plan.generated' AND meta IS NOT NULL
       ORDER BY id DESC
       LIMIT 40`,
      [projectId],
    );
    for (const row of rows) {
      const meta = parseEventMeta(row.meta);
      if (!meta || typeof meta !== 'object') continue;
      if (Number(meta.planId ?? meta.plan_id) === Number(planId) && hasAgentCliOverride(meta)) return meta;
    }
    return null;
  }

  planSourceAgentCliSnapshot(projectId, planId) {
    const requirement = this.db.get('SELECT * FROM requirements WHERE project_id = ? AND linked_plan_id = ? LIMIT 1', [
      projectId,
      planId,
    ]);
    if (requirement && hasAgentCliOverride(requirement)) return requirement;
    const feedback = this.db.get('SELECT * FROM feedback WHERE project_id = ? AND linked_plan_id = ? LIMIT 1', [projectId, planId]);
    if (feedback && hasAgentCliOverride(feedback)) return feedback;
    return null;
  }

  completeLinkedIntakesForPlan(plan) {
    const requestedPlanId = Number(plan?.id || 0);
    let projectId = Number(plan?.project_id || 0);
    if (!requestedPlanId) return linkedIntakeCompletionResult(requestedPlanId, projectId);

    if (!projectId) {
      const persistedPlan = this.db.get('SELECT project_id FROM plans WHERE id = ?', [requestedPlanId]);
      projectId = Number(persistedPlan?.project_id || 0);
    }
    if (!projectId) return linkedIntakeCompletionResult(requestedPlanId, projectId);

    const rowsBySource = Object.fromEntries(
      LINKED_INTAKE_COMPLETION_SOURCES.map((source) => [
        source.countKey,
        this.db.all(
          `SELECT id FROM ${source.table}
           WHERE project_id = ? AND linked_plan_id = ?
             AND (status IS NULL OR LOWER(TRIM(status)) NOT IN (?, ?))
           ORDER BY id ASC`,
          [projectId, requestedPlanId, ...LINKED_INTAKE_TERMINAL_STATUSES],
        ),
      ]),
    );
    const completionSummary = {};
    for (const source of LINKED_INTAKE_COMPLETION_SOURCES) {
      const rows = rowsBySource[source.countKey] || [];
      completionSummary[source.countKey] = rows.length;
      completionSummary[source.idsKey] = rows.map((row) => Number(row.id));
    }
    const result = linkedIntakeCompletionResult(requestedPlanId, projectId, completionSummary);
    if (result.total === 0) return result;

    const updatedAt = nowIso();
    result.updatedAt = updatedAt;
    this.db.runBatch([
      ...LINKED_INTAKE_COMPLETION_SOURCES.map((source) => ({
        sql: `UPDATE ${source.table}
              SET status = ?, updated_at = ?
              WHERE project_id = ? AND linked_plan_id = ?
                AND (status IS NULL OR LOWER(TRIM(status)) NOT IN (?, ?))`,
        params: [
          LINKED_INTAKE_COMPLETED_STATUS,
          updatedAt,
          projectId,
          requestedPlanId,
          ...LINKED_INTAKE_TERMINAL_STATUSES,
        ],
      })),
      {
        sql: 'INSERT INTO events (project_id, type, message, meta, created_at) VALUES (?, ?, ?, ?, ?)',
        params: [
          projectId,
          'plan.linked_intakes.completed',
          `关联需求/反馈已标记完成：需求 ${result.requirements} 条，反馈 ${result.feedback} 条`,
          JSON.stringify(result),
          updatedAt,
        ],
      },
    ]);
    this.emitUpdate(projectId);
    return result;
  }

  async generatePlan(projectId, workspace, issueScan) {
    return planGeneration.generatePlan(this, loopFlowHelpers(), projectId, workspace, issueScan);
  }

  /** 为单条需求/反馈生成计划（调 codex），并回写 linked_plan_id。失败返回 null，下轮重试。 */
  async generatePlanForIntake(projectId, workspace, intake) {
    return planGeneration.generatePlanForIntake(this, loopFlowHelpers(), projectId, workspace, intake);
  }

  intakeAttachmentPrompt(projectId, workspace, intake, sourceName) {
    return planGeneration.intakeAttachmentPrompt(this, loopFlowHelpers(), projectId, workspace, intake, sourceName);
  }

  async processPlan(workspace, plan) {
    return taskExecution.processPlan(this, loopFlowHelpers(), workspace, plan);
  }

  isFinalAcceptanceTask(planId, task) {
    return validationFlow.isFinalAcceptanceTask(this, loopFlowHelpers(), planId, task);
  }

  hasFinalAcceptanceTask(planId) {
    return validationFlow.hasFinalAcceptanceTask(this, loopFlowHelpers(), planId);
  }

  previousPlanCodexSessionId(planId, task) {
    return taskExecution.previousPlanCodexSessionId(this, loopFlowHelpers(), planId, task);
  }

  previousPlanAgentCliSessionId(planId, task) {
    return taskExecution.previousPlanAgentCliSessionId(this, loopFlowHelpers(), planId, task);
  }

  parallelTaskBatch(tasks) {
    return taskExecution.parallelTaskBatch(this, loopFlowHelpers(), tasks);
  }

  async executeTaskBatch(workspace, plan, tasks, options = {}) {
    return taskExecution.executeTaskBatch(this, loopFlowHelpers(), workspace, plan, tasks, options);
  }

  async executeTask(workspace, plan, task, options = {}) {
    return taskExecution.executeTask(this, loopFlowHelpers(), workspace, plan, task, options);
  }

  completeTask(workspace, plan, task, result) {
    return taskExecution.completeTask(this, loopFlowHelpers(), workspace, plan, task, result);
  }

  completeAcceptanceTask(workspace, plan, task, result) {
    return validationFlow.completeAcceptanceTask(this, loopFlowHelpers(), workspace, plan, task, result);
  }

  refreshPlanProgress(planId, planFile) {
    return taskExecution.refreshPlanProgress(this, loopFlowHelpers(), planId, planFile);
  }

  markTaskCompletedInPlan(workspace, planFile, task, result) {
    return taskExecution.markTaskCompletedInPlan(this, loopFlowHelpers(), workspace, planFile, task, result);
  }

  async validatePlan(workspace, plan, options = {}) {
    return validationFlow.validatePlan(this, loopFlowHelpers(), workspace, plan, options);
  }

  syncPlanTasks(planId, planFile) {
    return planTaskSync.syncPlanTasksFromMarkdown(this, planId, planFile);
  }

  /** 把当前 activeOperation 转存为 lastOperation（保留日志），然后清空 active */
  archiveOperation(projectId, operationKey) {
    archiveRuntimeOperation(this.runtime(projectId), operationKey);
  }

  async runCodexWithPlanGuard(workspace, prompt, label, operation, planFile) {
    const before = planFile && fs.existsSync(planFile) ? fs.readFileSync(planFile, 'utf8') : null;
    const result = await this.runCodex(workspace, prompt, label, operation);
    if (!this.operationTargetExists(operation)) return result;
    if (before !== null) {
      const changed = !fs.existsSync(planFile) || fs.readFileSync(planFile, 'utf8') !== before;
      if (changed) {
        fs.writeFileSync(planFile, before, 'utf8');
        this.addEvent(operation.projectId, 'plan.guard.restored', `${agentCliProviderDisplayName(result.agentCliProvider)} 修改了 plan，已恢复：${normalizeRelative(workspace, planFile)}`, {
          ...agentCliContextFields(result),
          ...agentCliResultSessionContextFields(result),
          planId: operation.planId || null,
          taskId: operation.taskId || null,
        });
      }
    }
    return result;
  }

  async runCodex(workspace, prompt, label, operation = {}) {
    const projectIdForEmit = operation.projectId;
    const runtime = this.runtime(projectIdForEmit);
    if (!runtime) throw new Error('projectId is required for codex operations');
    const effectivePrompt = planGenerationGuardedPrompt(prompt, label, operation);
    const projectStatus = projectIdForEmit ? this.status(projectIdForEmit) : null;
    const agentCliConfig = effectiveAgentCliConfig(projectStatus, operation);
    const agentCliProvider = agentCliConfig.provider;
    const agentCliCommand = agentCliConfig.command;
    const codexReasoningEffort = agentCliConfig.codexReasoningEffort;
    const isCodexProvider = agentCliProvider === DEFAULT_AGENT_CLI_PROVIDER;
    const isClaudeProvider = agentCliProvider === 'claude';
    const isOpenCodeProvider = agentCliProvider === 'opencode';
    const opencodePlanId = isOpenCodeProvider && operation.planId ? operation.planId : null;
    const requestedClaudeSessionId = isClaudeProvider ? requestedAgentCliSessionId(operation) : '';
    const hasClaudeSessionOption = isClaudeProvider && hasAnyOwnProperty(operation, CLAUDE_SESSION_INPUT_KEYS);
    const requestedOpenCodeSessionId = opencodePlanId ? this.planAgentCliSessionId(opencodePlanId) : '';
    const opencodeSessionTitle = opencodePlanId ? opencodePlanSessionTitle(projectIdForEmit, opencodePlanId) : '';
    const logDir = path.join(workspace, 'docs', 'progress', 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    const prefix = `${timestampForPath()}_${safePart(label)}`;
    const logFile = path.join(logDir, `${prefix}.log`);
    const lastFile = path.join(logDir, `${prefix}.last.txt`);
    const hasSessionOption = isCodexProvider && hasCodexSessionOption(operation);
    const requestedSessionId = isCodexProvider ? operationCodexSessionId(operation) : '';
    const activeOperation = {
      ...operation,
      label,
      logFile,
      lastFile,
      agentCliProvider,
      agentCliCommand,
      ...(isCodexProvider ? { codexReasoningEffort } : {}),
      ...(isCodexProvider
        ? {
            codexSessionId: requestedSessionId || null,
            codexSessionRequestedId: requestedSessionId || null,
            codexSessionMode: requestedSessionId ? 'resume' : 'new',
            codexSessionState: requestedSessionId ? 'resume' : 'new',
          }
        : {}),
      ...(isClaudeProvider
        ? agentCliSessionContextFields('claude', {
            sessionId: requestedClaudeSessionId,
            requestedId: requestedClaudeSessionId,
            mode: requestedClaudeSessionId ? 'resume' : 'new',
            state: agentCliSessionStateFor(requestedClaudeSessionId ? 'resume' : 'new', operation.agentCliSessionState),
          })
        : {}),
      ...(isOpenCodeProvider
        ? {
            ...opencodeSessionContextFields({
              opencodeSessionId: requestedOpenCodeSessionId,
              opencodeSessionRequestedId: requestedOpenCodeSessionId,
              opencodeSessionMode: requestedOpenCodeSessionId ? 'resume' : 'new',
            }),
            opencodeSessionTitle,
            agentCliSessionTitle: opencodeSessionTitle,
          }
        : {}),
      logBuffer: '',
      activity: isCodexProvider ? new CodexActivityPrinter(200) : (isClaudeProvider ? new ClaudeStreamJsonPrinter(200) : null),
      startedAt: nowIso(),
    };
    if (!isCodexProvider) clearCodexSessionFields(activeOperation);
    const cancelledResult = () => ({
      exitCode: -1,
      logFile,
      lastFile,
      provider: activeOperation.agentCliProvider,
      agentCliProvider: activeOperation.agentCliProvider,
      command: activeOperation.agentCliCommand,
      agentCliCommand: activeOperation.agentCliCommand,
      output: '',
      errorMessage: '操作目标已删除',
      cancelled: true,
    });
    const operationCancelled = () => Boolean(activeOperation.cancelled) || !this.operationTargetExists(operation);
    let operationKey = null;
    let capturedSessionId = '';
    let capturedClaudeSessionId = '';
    let capturedOpenCodeSessionId = requestedOpenCodeSessionId;
    let sessionScanBuffer = '';
    const stream = fs.createWriteStream(logFile, { encoding: 'utf8' });
    stream.on('error', (error) => {
      activeOperation.errorMessage = error?.message || String(error);
    });
    const safeStreamWrite = (text) => {
      if (stream.destroyed || stream.writableEnded || stream.writableFinished) return;
      try {
        stream.write(text);
      } catch (error) {
        activeOperation.errorMessage = error?.message || String(error);
      }
    };
    const appendInternalLog = (message) => {
      const text = `\n[AutoPlan] ${message}\n`;
      safeStreamWrite(text);
      activeOperation.logBuffer = `${activeOperation.logBuffer || ''}${text}`;
      if (activeOperation.logBuffer.length > 24000) {
        activeOperation.logBuffer = activeOperation.logBuffer.slice(-16000);
      }
    };
    const resultFor = (attempt, mode) => {
      if (activeOperation.activity && typeof activeOperation.activity.flush === 'function') {
        activeOperation.activity.flush();
      }
      const exitCode = typeof attempt?.exitCode === 'number' ? attempt.exitCode : -1;
      const sessionId = capturedSessionId || (mode === 'resume' ? requestedSessionId : '');
      const claudeSessionId = normalizeAgentCliSessionId(
        attempt?.claudeSessionId
          || attempt?.agentCliSessionId
          || capturedClaudeSessionId
          || (mode === 'resume' ? requestedClaudeSessionId : ''),
      );
      const openCodeSessionId = normalizeAgentCliSessionId(
        attempt?.opencodeSessionId || attempt?.agentCliSessionId || capturedOpenCodeSessionId || (mode === 'resume' ? requestedOpenCodeSessionId : ''),
      );
      if (isClaudeProvider && claudeSessionId) {
        capturedClaudeSessionId = claudeSessionId;
        Object.assign(activeOperation, agentCliSessionContextFields('claude', {
          sessionId: claudeSessionId,
          requestedId: requestedClaudeSessionId,
          mode,
          state: agentCliSessionStateFor(mode, operation.agentCliSessionState, activeOperation.agentCliSessionFallback),
          fallback: activeOperation.agentCliSessionFallback,
        }));
      }
      if (isOpenCodeProvider && openCodeSessionId) {
        capturedOpenCodeSessionId = openCodeSessionId;
        activeOperation.agentCliSessionId = openCodeSessionId;
        activeOperation.opencodeSessionId = openCodeSessionId;
      }
      const codexSessionFields = isCodexProvider
        ? codexSessionContextFields({
            codexSessionId: sessionId,
            codexSessionRequestedId: requestedSessionId,
            codexSessionMode: mode,
            codexSessionFallback: mode === 'new' && Boolean(requestedSessionId),
          })
        : {};
      const openCodeSessionFields = isOpenCodeProvider
        ? opencodeSessionContextFields({
            opencodeSessionId: openCodeSessionId,
            opencodeSessionRequestedId: requestedOpenCodeSessionId,
            opencodeSessionMode: mode,
          })
        : {};
      const claudeSessionFields = isClaudeProvider
        ? agentCliSessionContextFields('claude', {
            sessionId: claudeSessionId,
            requestedId: requestedClaudeSessionId,
            mode,
            state: agentCliSessionStateFor(mode, operation.agentCliSessionState, activeOperation.agentCliSessionFallback),
            fallback: activeOperation.agentCliSessionFallback,
          })
        : {};
      return {
        exitCode,
        logFile,
        lastFile,
        provider: activeOperation.agentCliProvider,
        agentCliProvider: activeOperation.agentCliProvider,
        command: activeOperation.agentCliCommand,
        agentCliCommand: activeOperation.agentCliCommand,
        ...(isCodexProvider ? { codexReasoningEffort: activeOperation.codexReasoningEffort } : {}),
        activity: activeOperation.activity ? activeOperation.activity.getLines() : [],
        output: attempt?.output || '',
        errorMessage: attempt?.errorMessage || '',
        timedOut: Boolean(attempt?.timedOut),
        timeoutMs: attempt?.timeoutMs,
        ...(attempt?.sessionLookupError ? { sessionLookupError: attempt.sessionLookupError } : {}),
        ...(isCodexProvider
          ? {
              sessionId: sessionId || null,
              codexSessionId: sessionId || null,
              codexSessionMode: mode,
              resumed: mode === 'resume',
            }
          : {}),
        ...(isClaudeProvider
          ? {
              sessionId: claudeSessionId || null,
              agentCliSessionId: claudeSessionId || null,
              claudeSessionId: claudeSessionId || null,
              resumed: mode === 'resume',
            }
          : {}),
        ...codexSessionFields,
        ...claudeSessionFields,
        ...openCodeSessionFields,
        ...(isOpenCodeProvider && opencodeSessionTitle ? { opencodeSessionTitle, agentCliSessionTitle: opencodeSessionTitle } : {}),
      };
    };
    const runAttempt = async (args, mode) => {
      if (isCodexProvider) {
        activeOperation.codexSessionMode = mode;
        activeOperation.codexSessionState = activeOperation.codexSessionFallback ? 'fallback-new' : mode;
        activeOperation.codexSessionId = mode === 'resume' ? requestedSessionId || null : capturedSessionId || null;
      }
      if (isClaudeProvider) {
        const nextClaudeSessionId = mode === 'resume' ? requestedClaudeSessionId : capturedClaudeSessionId;
        Object.assign(activeOperation, agentCliSessionContextFields('claude', {
          sessionId: nextClaudeSessionId,
          requestedId: requestedClaudeSessionId,
          mode,
          state: agentCliSessionStateFor(mode, operation.agentCliSessionState, activeOperation.agentCliSessionFallback),
          fallback: activeOperation.agentCliSessionFallback,
        }));
        if (!nextClaudeSessionId) {
          activeOperation.agentCliSessionId = null;
          activeOperation.claudeSessionId = null;
        }
      }
      if (isOpenCodeProvider) {
        const openCodeSessionId = mode === 'resume' ? capturedOpenCodeSessionId || requestedOpenCodeSessionId : '';
        Object.assign(activeOperation, opencodeSessionContextFields({
          opencodeSessionId: openCodeSessionId,
          opencodeSessionRequestedId: requestedOpenCodeSessionId,
          opencodeSessionMode: mode,
        }));
      }
      let agentCliOptions;
      if (isClaudeProvider) {
        agentCliOptions = {
          ...activeOperation,
          sessionId: activeOperation.agentCliSessionId || activeOperation.claudeSessionId || '',
        };
      } else if (isOpenCodeProvider) {
        agentCliOptions = {
          sessionId: mode === 'resume' ? capturedOpenCodeSessionId || requestedOpenCodeSessionId : '',
          title: opencodeSessionTitle,
        };
      }
      return runAgentCliAttempt({
        workspace,
        prompt: effectivePrompt,
        lastFile,
        logFile,
        runtime,
        activeOperation,
        operationKey,
        onOperationKey: (nextOperationKey) => {
          operationKey = nextOperationKey;
        },
        registerRuntimeOperation,
        waitForChild,
        stream,
        provider: activeOperation.agentCliProvider,
        command: activeOperation.agentCliCommand,
        codexArgs: args,
        agentCliOptions,
        env: { ...workspaceToolEnv(workspace), ...this.projectEnvVars(projectIdForEmit) },
        onChunk: (text) => {
          if (!isCodexProvider) return;
          sessionScanBuffer = `${sessionScanBuffer}${text}`.slice(-4000);
          const parsedSessionId = extractCodexSessionId(sessionScanBuffer);
          if (parsedSessionId) {
            capturedSessionId = parsedSessionId;
            activeOperation.codexSessionId = parsedSessionId;
          }
        },
      });
    };
    const tailTimer = setInterval(() => {
      if (projectIdForEmit) this.emitUpdate(projectIdForEmit);
    }, 1500);
    try {
      if (isOpenCodeProvider) {
        if (capturedOpenCodeSessionId) {
          this.addEvent(projectIdForEmit, 'opencode.session.resume.started', `尝试恢复 OpenCode 会话 ${shortAgentCliSessionId(capturedOpenCodeSessionId)}`, {
            ...opencodeSessionContextFields({
              opencodeSessionId: capturedOpenCodeSessionId,
              opencodeSessionRequestedId: capturedOpenCodeSessionId,
              opencodeSessionMode: 'resume',
            }),
            label,
            planId: operation.planId || null,
            taskId: operation.taskId || null,
          });
          const resume = await runAttempt([], 'resume');
          if (operationCancelled()) return cancelledResult();
          const resumeMissing = resume.exitCode !== 0 && isOpenCodeSessionMissing(resume.output);
          if (!resumeMissing) {
            const result = resultFor(resume, 'resume');
            if (result.opencodeSessionId && opencodePlanId) {
              this.updatePlanAgentCliSession(opencodePlanId, result.opencodeSessionId);
            }
            return result;
          }

          this.addEvent(projectIdForEmit, 'opencode.session.resume.failed', `恢复 OpenCode 会话失败，已回退新建：${shortAgentCliSessionId(capturedOpenCodeSessionId)}`, {
            ...opencodeSessionContextFields({
              opencodeSessionRequestedId: capturedOpenCodeSessionId,
              opencodeSessionMode: 'new',
              opencodeSessionState: 'fallback-new',
            }),
            label,
            planId: operation.planId || null,
            taskId: operation.taskId || null,
            exitCode: resume.exitCode,
            log: logFile,
          });
          if (opencodePlanId) this.updatePlanAgentCliSession(opencodePlanId, '');
          appendInternalLog(`OpenCode resume failed for session ${capturedOpenCodeSessionId}; falling back to a new session.`);
          capturedOpenCodeSessionId = '';
        }

        const fresh = await runAttempt([], 'new');
        if (operationCancelled()) return cancelledResult();
        const result = resultFor(fresh, 'new');
        if (result.opencodeSessionId && opencodePlanId) {
          this.updatePlanAgentCliSession(opencodePlanId, result.opencodeSessionId);
        } else if (result.sessionLookupError) {
          appendInternalLog(`OpenCode session lookup failed: ${result.sessionLookupError}`);
        }
        return result;
      }

      if (isClaudeProvider) {
        if (requestedClaudeSessionId) {
          const resumeState = agentCliSessionStateFor('resume', operation.agentCliSessionState);
          this.addEvent(projectIdForEmit, 'claude.session.resume.started', `尝试恢复 Claude 会话 ${shortAgentCliSessionId(requestedClaudeSessionId)}`, {
            ...agentCliSessionContextFields('claude', {
              sessionId: requestedClaudeSessionId,
              requestedId: requestedClaudeSessionId,
              mode: 'resume',
              state: resumeState,
            }),
            label,
            planId: operation.planId || null,
            taskId: operation.taskId || null,
          });
          const resume = await runAttempt([], 'resume');
          if (operationCancelled()) return cancelledResult();
          const resumeMissing = resume.exitCode !== 0 && isClaudeSessionMissing(`${resume.output || ''}\n${resume.errorMessage || ''}`);
          if (!resumeMissing) return resultFor(resume, 'resume');

          this.addEvent(projectIdForEmit, 'claude.session.resume.failed', `恢复 Claude 会话失败，已回退新建：${shortAgentCliSessionId(requestedClaudeSessionId)}`, {
            ...agentCliSessionContextFields('claude', {
              requestedId: requestedClaudeSessionId,
              mode: 'new',
              state: 'fallback-new',
              fallback: true,
            }),
            label,
            planId: operation.planId || null,
            taskId: operation.taskId || null,
            exitCode: resume.exitCode,
            log: logFile,
          });
          activeOperation.agentCliSessionFallback = true;
          Object.assign(activeOperation, agentCliSessionContextFields('claude', {
            requestedId: requestedClaudeSessionId,
            mode: 'new',
            state: 'fallback-new',
            fallback: true,
          }));
          activeOperation.agentCliSessionId = null;
          activeOperation.claudeSessionId = null;
          appendInternalLog(`Claude resume failed for session ${requestedClaudeSessionId}; falling back to a new session.`);
          capturedClaudeSessionId = '';
        } else if (hasClaudeSessionOption) {
          this.addEvent(projectIdForEmit, 'claude.session.resume.skipped', 'Claude session id 为空，已新建会话', {
            ...agentCliSessionContextFields('claude', { mode: 'new' }),
            label,
            planId: operation.planId || null,
            taskId: operation.taskId || null,
            reason: 'empty_session_id',
          });
          appendInternalLog('Claude session id was empty; starting a new session.');
        }

        const fresh = await runAttempt([], 'new');
        if (operationCancelled()) return cancelledResult();
        return resultFor(fresh, 'new');
      }

      if (!isCodexProvider) {
        const attempt = await runAttempt([], '');
        if (operationCancelled()) return cancelledResult();
        return resultFor(attempt, '');
      }

      if (requestedSessionId) {
        this.addEvent(projectIdForEmit, 'codex.session.resume.started', `尝试恢复 Codex 会话 ${shortCodexSessionId(requestedSessionId)}`, {
          ...codexSessionContextFields({
            codexSessionId: requestedSessionId,
            codexSessionRequestedId: requestedSessionId,
            codexSessionMode: 'resume',
          }),
          sessionId: requestedSessionId,
          label,
          planId: operation.planId || null,
          taskId: operation.taskId || null,
        });
        const resume = await runAttempt(codexResumeSessionArgs(requestedSessionId, lastFile, { reasoningEffort: codexReasoningEffort }), 'resume');
        if (operationCancelled()) return cancelledResult();
        const resumeFailed = resume.exitCode !== 0 && !extractCodexSessionId(resume.output) && isCodexResumeFailure(resume.output);
        if (!resumeFailed) return resultFor(resume, 'resume');

        this.addEvent(projectIdForEmit, 'codex.session.resume.failed', `恢复 Codex 会话失败，已回退新建：${shortCodexSessionId(requestedSessionId)}`, {
          ...codexSessionContextFields({
            codexSessionRequestedId: requestedSessionId,
            codexSessionMode: 'new',
            codexSessionState: 'fallback-new',
            codexSessionFallback: true,
          }),
          sessionId: requestedSessionId,
          label,
          planId: operation.planId || null,
          taskId: operation.taskId || null,
          exitCode: resume.exitCode,
          log: logFile,
        });
        activeOperation.codexSessionFallback = true;
        activeOperation.codexSessionRequestedId = requestedSessionId;
        activeOperation.codexSessionId = null;
        activeOperation.codexSessionMode = 'new';
        activeOperation.codexSessionState = 'fallback-new';
        appendInternalLog(`Codex resume failed for session ${requestedSessionId}; falling back to a new session.`);
      } else if (hasSessionOption) {
        this.addEvent(projectIdForEmit, 'codex.session.resume.skipped', 'Codex session id 为空，已新建会话', {
          ...codexSessionContextFields({ codexSessionMode: 'new' }),
          label,
          planId: operation.planId || null,
          taskId: operation.taskId || null,
          reason: 'empty_session_id',
        });
        appendInternalLog('Codex session id was empty; starting a new session.');
      }

      const fresh = await runAttempt(codexNewSessionArgs(workspace, lastFile, { reasoningEffort: codexReasoningEffort }), 'new');
      if (operationCancelled()) return cancelledResult();
      return resultFor(fresh, 'new');
    } finally {
      clearInterval(tailTimer);
      if (!stream.destroyed && !stream.writableEnded && !stream.writableFinished) {
        stream.end();
      }
      if (operationKey && runtime.activeOperations.has(operationKey)) {
        this.archiveOperation(projectIdForEmit, operationKey);
      }
    }
  }

  async runShell(workspace, command, label, operation = {}) {
    const inheritedOperation = this.hookOperationContext.getStore() || {};
    operation = {
      ...operation,
      projectId: operation.projectId ?? inheritedOperation.projectId ?? undefined,
      planId: operation.planId ?? inheritedOperation.planId ?? undefined,
      taskId: operation.taskId ?? inheritedOperation.taskId ?? undefined,
    };
    const projectIdForEmit = operation.projectId;
    const runtime = this.runtime(projectIdForEmit);
    if (!runtime) throw new Error('projectId is required for shell operations');
    const logDir = path.join(workspace, 'docs', 'progress', 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    const logFile = path.join(logDir, `${timestampForPath()}_${safePart(label)}.log`);
    const shellCommand = process.platform === 'win32' ? `chcp 65001>nul && ${command}` : command;
    const overrideCwd = String(operation.cwd || '').trim();
    const baseEnv = { ...workspaceToolEnv(workspace), ...this.projectEnvVars(projectIdForEmit) };
    const child = spawn(shellCommand, {
      shell: true,
      cwd: overrideCwd || workspace,
      env: operation.extraEnv ? { ...baseEnv, ...operation.extraEnv } : baseEnv,
    });
    const activeOperation = {
      ...operation,
      label,
      logBuffer: '',
      activity: new CodexActivityPrinter(200),
      startedAt: nowIso(),
    };
    const operationKey = registerRuntimeOperation(runtime, child, activeOperation);
    if (operation.stdin != null && operation.stdin !== '') {
      try {
        child.stdin.end(String(operation.stdin));
      } catch (error) {
        activeOperation.errorMessage = error?.message || String(error);
      }
    }
    const timeoutMs = Number.isFinite(operation.timeoutMs) && operation.timeoutMs > 0
      ? operation.timeoutMs
      : SHELL_COMMAND_TIMEOUT_MS;
    let output = '';
    const shellDecoders = {
      stdout: createChunkDecoder(),
      stderr: createChunkDecoder(),
    };
    const onChunk = (chunk, source) => {
      const text = shellDecoders[source].decode(chunk);
      output += text;
      if (!runtime.activeOperations.has(operationKey)) return;
      activeOperation.logBuffer = (activeOperation.logBuffer || '') + text;
      if (activeOperation.logBuffer.length > 24000) {
        activeOperation.logBuffer = activeOperation.logBuffer.slice(-16000);
      }
      if (activeOperation.activity) activeOperation.activity.offer(text);
    };
    child.stdout.on('data', (chunk) => onChunk(chunk, 'stdout'));
    child.stderr.on('data', (chunk) => onChunk(chunk, 'stderr'));
    const tailTimer = setInterval(() => {
      if (projectIdForEmit) this.emitUpdate(projectIdForEmit);
    }, 1500);
    try {
      const exitCode = await waitForChild(child, timeoutMs);
      const timedOut = Boolean(child.__autoplanTimedOut);
      const errorMessage = timedOut ? `Shell command timed out after ${validationFlow.formatDurationMs(timeoutMs)}` : '';
      if (errorMessage) {
        const text = `\n[AutoPlan] ${errorMessage}\n`;
        output += text;
        if (runtime.activeOperations.has(operationKey)) {
          activeOperation.errorMessage = errorMessage;
          activeOperation.logBuffer = `${activeOperation.logBuffer || ''}${text}`;
        }
      }
      fs.writeFileSync(logFile, output, 'utf8');
      if (runtime.activeOperations.has(operationKey)) activeOperation.exitCode = exitCode;
      if (activeOperation.cancelled || !this.operationTargetExists(operation)) {
        return {
          exitCode: -1,
          output,
          logFile,
          errorMessage: '操作目标已删除',
          timedOut,
          timeoutMs,
          cancelled: true,
        };
      }
      return { exitCode, output, logFile, errorMessage, timedOut, timeoutMs };
    } finally {
      clearInterval(tailTimer);
      if (runtime.activeOperations.has(operationKey)) {
        this.archiveOperation(projectIdForEmit, operationKey);
      }
    }
  }

  setPhase(projectId, phase) {
    setProjectPhase(this.db, projectId, phase);
    this.emitUpdate(projectId);
  }

  /** 循环钩子：执行某阶段下所有已启用脚本，单脚本异常不冒泡；仅 validation:before 可中断 */
  async runHookScripts(projectId, stage, context = {}) {
    return this.hookOperationContext.run(
      {
        projectId,
        planId: context.planId ?? null,
        taskId: context.taskId ?? null,
      },
      () => scriptHooks.runHookScripts(this, projectId, stage, context),
    );
  }

  /** 手动运行单个脚本（scripts:run），返回 ScriptRunResult */
  async runScriptManually(projectId, scriptId) {
    return scriptHooks.runScriptManually(this, projectId, scriptId);
  }

  /** 停止运行中的脚本（scripts:stop），复用 runShell 的 operation 取消能力 */
  stopScript(projectId, scriptId) {
    return scriptHooks.stopScript(this, projectId, scriptId);
  }

  /** 启动全局定时调度器：单一 setInterval（周期 60000ms，unref 不阻塞进程退出），每 tick 调 runScheduledScripts。
   *  独立于循环运行态——循环停止时定时脚本仍按计划执行；禁用脚本（enabled=0）绝不触发。 */
  startScheduler() {
    if (this.scheduleTimer) return;
    this.scheduleTimer = createUnrefInterval(() => {
      this.runScheduledScripts().catch((error) => {
        // runScheduledScripts 内部已逐项兜底；此处为最终安全网，绝不冒泡打断后续 tick。
        console.warn('[loopService] scheduler tick failed:', error?.message || error);
      });
    }, 60000);
  }

  /** 停止全局定时调度器（幂等）。 */
  stopScheduler() {
    if (this.scheduleTimer) {
      clearInterval(this.scheduleTimer);
      this.scheduleTimer = null;
    }
  }

  /** 遍历所有项目，筛选并执行到期定时脚本；单条异常兜底，绝不冒泡打断调度器或同 tick 其它脚本。
   *  对无定时脚本项目为空操作（仅一次 SELECT），开销可忽略。 */
  async runScheduledScripts() {
    const now = new Date();
    for (const project of this.projects()) {
      const projectId = Number(project.id);
      const workspace = String(project.workspace_path || '');
      let scripts = [];
      try {
        scripts = this.db.all(
          `SELECT * FROM scripts WHERE project_id = ? AND enabled = 1 AND trigger_mode = 'schedule'`,
          [projectId],
        );
      } catch {
        continue; // 查询失败兜底，跳过本项目不影响其它项目与后续 tick
      }
      // 非法 cron：记一条失败事件并置 last_status='bad'，同分钟去重避免刷屏；绝不抛错、不影响同 tick 其它脚本与后续 tick
      for (const script of scripts) {
        const cronExpr = String(script.schedule_cron || '').trim();
        if (!cronExpr) continue;
        try {
          scriptHooks.parseCron(cronExpr);
        } catch (error) {
          if (scriptHooks.isRunThisMinute(script.last_run_at, now)) continue;
          const finishedAt = nowIso();
          this.db.run(
            `UPDATE scripts SET last_status = 'bad', last_run_at = ?, updated_at = ? WHERE id = ?`,
            [finishedAt, finishedAt, script.id],
          );
          this.addEvent(
            projectId,
            'script.schedule.error',
            `${script.name} 定时表达式无效：${error?.message || error}`,
            {
              scriptId: script.id,
              scriptName: script.name,
              stage: 'schedule',
              trigger: 'schedule',
              cron: cronExpr,
              errorMessage: error?.message || String(error),
            },
          );
        }
      }
      let due = [];
      try {
        due = scriptHooks.dueScheduledScripts(scripts, now);
      } catch {
        due = []; // 筛选异常兜底，本 tick 跳过该项目
      }
      for (const script of due) {
        const stage = script.hook_stage || 'schedule';
        try {
          await scriptHooks.runScriptOnce(this, script, stage, { trigger: 'schedule', workspace });
        } catch (error) {
          scriptHooks.recordRunFailure(this, script, stage, { trigger: 'schedule', workspace }, error);
        }
      }
    }
  }

  recordError(projectId, error) {
    recordRuntimeError(
      this.db,
      projectId,
      error,
      (id, type, message, meta) => this.addEvent(id, type, message, meta),
      (id) => this.emitUpdate(id),
    );
  }

  addEvent(projectId, type, message, meta = null) {
    this.db.run('INSERT INTO events (project_id, type, message, meta, created_at) VALUES (?, ?, ?, ?, ?)', [
      projectId,
      type,
      message,
      meta ? JSON.stringify(meta) : null,
      nowIso(),
    ]);
    this.emitUpdate(projectId);
  }

  emitUpdate(projectId, options = {}) {
    this.updateEmitter.emit(projectId, options);
  }

  flushPendingUpdates() {
    this.updateEmitter.flush();
  }

  /** 注入实时 MCP 状态提供者（main.js 持有 mcpServer 句柄后调用），使快照反映进程真实运行态而非仅靠事件推导。 */
  setMcpStatusProvider(provider) {
    this.mcpStatusProvider = typeof provider === 'function' ? provider : null;
  }

  snapshot(projectId = null) {
    return snapshots.snapshot(this, loopFlowHelpers(), projectId);
  }
}

function timestampForPath() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(
    now.getHours(),
  )}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

/** 规范化用户环境变量为 JSON 串：过滤空名、按 name 去重保序、value 强制为字符串，JSON.stringify 入库。 */
function normalizeEnvVarsJson(envVars) {
  const seen = new Set();
  const entries = [];
  for (const entry of Array.isArray(envVars) ? envVars : []) {
    if (!entry || typeof entry !== 'object') continue;
    const name = String(entry.name ?? '').trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    entries.push({ name, value: String(entry.value ?? '') });
  }
  return JSON.stringify(entries);
}

function linkedIntakeCompletionResult(planId, projectId, overrides = {}) {
  const requirements = Number(overrides.requirements || 0);
  const feedback = Number(overrides.feedback || 0);
  return {
    planId: Number(planId || 0) || null,
    projectId: Number(projectId || 0) || null,
    requirements,
    feedback,
    total: requirements + feedback,
    requirementIds: Array.isArray(overrides.requirementIds) ? overrides.requirementIds : [],
    feedbackIds: Array.isArray(overrides.feedbackIds) ? overrides.feedbackIds : [],
    updatedAt: overrides.updatedAt || null,
  };
}

/**
 * 规范化批量验收目标列表：非数组/元素非法抛「验收目标列表无效」；去重保序、Number(id)；
 * 空列表抛调用方指定的中文错误。targetType/id 的合法性交由 acceptanceTargetRow 复用既有校验。
 * 去重保序：同目标多次出现只处理一次（幂等，避免重复 UPDATE/事件）。
 */
function normalizeAcceptanceTargets(targets, emptyMessage) {
  if (!Array.isArray(targets)) throw new Error('验收目标列表无效');
  const seen = new Set();
  const normalized = [];
  for (const entry of targets) {
    if (!entry || typeof entry !== 'object') throw new Error('验收目标列表无效');
    const targetType = entry.targetType;
    const id = Number(entry.id);
    const key = `${targetType}:${id}`;
    if (seen.has(key)) continue; // 去重保序：同目标多次出现只处理一次
    seen.add(key);
    normalized.push({ targetType, id });
  }
  if (normalized.length === 0) throw new Error(emptyMessage);
  return normalized;
}

function planGenerationGuardedPrompt(prompt, label, operation = {}) {
  if (!isPlanGenerationOperation(label, operation)) return prompt;
  const text = String(prompt || '');
  if (text.includes(PLAN_GENERATION_FORMAT_GUARD_TITLE)) return text;
  return `${text.trimEnd()}\n\n${PLAN_GENERATION_FORMAT_GUARD_TITLE}\n${[
    '- 必须包含二级标题 `## 任务拆解`，所有开发任务只能放在这个章节里。',
    '- 每个任务行必须独占一行，并严格使用 `- [ ] P001: 任务标题 <!-- scope: src/file.js,src/other.ts -->`。',
    '- 禁止把任务拆解写成普通段落、代码块、表格、引用块或嵌套 checkbox；验收要点可以缩进，但不能写成 checkbox 任务。',
    '- 缺少明确影响范围时写 `<!-- scope: unknown -->`；最后一个完整验收任务也使用连续编号，例如 `- [ ] P007: 完整验收 <!-- scope: validation -->`。',
    '- 任务编号按 P001、P002 递增；不要跳号、复用编号或把多个任务写在同一行。',
  ].join('\n')}`;
}

function isPlanGenerationOperation(label, operation = {}) {
  const text = String(label || '');
  return text === 'generate-plan' || text.startsWith('gen-requirement-') || text.startsWith('gen-feedback-') || Boolean(operation.intakeType);
}

function opencodePlanSessionTitle(projectId, planId) {
  return `AutoPlan project ${Number(projectId || 0)} plan ${Number(planId || 0)}`;
}

function isOpenCodeSessionMissing(output) {
  return /(?:session\s+not\s+found|unknown\s+session|invalid\s+session)/i.test(String(output || ''));
}

function requestedAgentCliSessionId(operation = {}) {
  return normalizeAgentCliSessionId(
    operation.agentCliSessionId
      || operation.agentCliSessionRequestedId
      || operation.claudeSessionId
      || operation.claudeSessionRequestedId
      || operation.sessionId,
  );
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

function agentCliSessionStateFor(mode, requestedState, fallback = false) {
  if (fallback) return 'fallback-new';
  if (mode === 'resume' && requestedState === 'plan-resume') return 'plan-resume';
  return mode || requestedState || 'new';
}

function isClaudeSessionMissing(output) {
  return /(?:session\s+not\s+found|unknown\s+session|invalid\s+session|conversation\s+not\s+found|no\s+conversation)/i.test(String(output || ''));
}

function isInsideDirectory(rootPath, targetPath) {
  const resolvedRoot = normalizePathForCompare(path.resolve(rootPath));
  const resolvedTarget = normalizePathForCompare(path.resolve(targetPath));
  const relativePath = path.relative(resolvedRoot, resolvedTarget);
  return relativePath === '' || (!!relativePath && !relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

function normalizePathForCompare(value) {
  return process.platform === 'win32' ? String(value).toLowerCase() : String(value);
}

function uniqueNonEmptyStrings(...values) {
  return Array.from(new Set(values.map((value) => String(value || '').trim()).filter(Boolean)));
}

function agentCliResultSessionContextFields(result = {}) {
  const provider = result.agentCliProvider || result.provider;
  if (provider === DEFAULT_AGENT_CLI_PROVIDER) return codexSessionContextFields(result);
  if (provider === 'opencode') return opencodeSessionContextFields(result);
  if (provider === 'claude') {
    return agentCliSessionContextFields('claude', {
      sessionId: result.agentCliSessionId || result.claudeSessionId || result.sessionId,
      requestedId: result.agentCliSessionRequestedId || result.claudeSessionRequestedId,
      mode: result.agentCliSessionMode || result.claudeSessionMode,
      state: result.agentCliSessionState || result.claudeSessionState,
      fallback: result.agentCliSessionFallback || result.claudeSessionFallback,
    });
  }
  return {};
}

function loopFlowHelpers() {
  return {
    describeIntakeAttachment: intakeAttachments.describeIntakeAttachment,
    formatIntakeAttachmentEntry: intakeAttachments.formatIntakeAttachmentEntry,
    hashFile,
    hashText,
    intakeAttachmentOwnerTypes: intakeAttachments.intakeAttachmentOwnerTypes,
    isAcceptanceTask,
    normalizeRelative,
    readSnippet,
    tailText,
    timestampForPath,
  };
}

module.exports = {
  LoopService,
  LEGACY_TASK_EVENT_TYPES,
  normalizeIntakeAgentCliConfig,
  nextIntakeAgentCliConfig,
  TASK_EVENT_COMPATIBILITY,
  TASK_EVENT_SEMANTICS,
  TASK_EVENT_STATUS,
  TASK_EVENT_TYPES,
};
