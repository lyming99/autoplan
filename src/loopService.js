const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { nowIso } = require('./database');
const { CodexActivityPrinter } = require('./codexActivity');
const {
  codexNewSessionArgs,
  codexResumeSessionArgs,
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
  normalizeCodexSessionId,
  normalizeIntakeAgentCliConfig,
  operationCodexSessionId,
  planAgentCliColumnValues,
  readFirstOwnValue,
  shortCodexSessionId,
} = require('./loop/agentCliConfig');
const {
  archiveRuntimeOperation,
  ensureProjectRuntime,
  existingProjectRuntime,
  findActiveRuntimeProject,
  findRuntimeOperations,
  killChildProcess,
  normalizeRuntimeStatus,
  recordRuntimeError,
  registerRuntimeOperation,
  resetStoredRuntimeState,
  runtimeProjectSummary,
  scheduleProjectRuntime,
  setProjectPhase,
  stopProjectRuntime,
  stopRuntimeTask,
  waitForChild,
} = require('./loop/runtime');
const planGeneration = require('./loop/planGeneration');
const planParser = require('./loop/planParser');
const snapshots = require('./loop/snapshots');
const concurrency = require('./loop/concurrency');
const workspaceFiles = require('./loop/workspaceFiles');
const { parseEventMeta } = snapshots;
const { isAcceptanceTask } = concurrency;
const {
  hashFile,
  hashText,
  normalizeRelative,
  readSnippet,
  safePart,
  tailText,
  workspaceKey,
  workspaceToolEnv,
} = workspaceFiles;
const taskExecution = require('./loop/taskExecution');
const validationFlow = require('./loop/validation');
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
const WORKSPACE_RUNTIME_DIR = '.autoplan-runtime';
const PLAN_TASK_LINE_RE = /^\uFEFF?\s*[-*+]\s+\[([ xX])\]\s+(.+?)\s*$/;
const PLAN_TASK_KEY_RE = /^([A-Za-z]+[-_]?\d+|P\d+)\s*(?::|：|[-–—]+|\.|．|、|\)|）|\s+)\s*(.*)$/;
const PLAN_TASK_SCOPE_LABEL_RE = '(?:scope|scopes|files?|影响范围|并发键)';
const PLAN_TASK_SCOPE_RE = new RegExp(`${PLAN_TASK_SCOPE_LABEL_RE}\\s*[:=：]\\s*([^>\\]\\n]+)`, 'i');
const PLAN_TASK_SCOPE_COMMENT_RE = new RegExp(`\\s*<!--\\s*${PLAN_TASK_SCOPE_LABEL_RE}\\s*[:=：]\\s*([^>]*?)\\s*-->\\s*`, 'i');
const PLAN_TASK_SCOPE_SPLIT_RE = /[,，、;；]+/;
const PLAN_TASK_PATH_RE = /[\w./\\-]+\.(?:dart|js|jsx|ts|tsx|css|scss|html|md|json|ya?ml)/gi;
const PLAN_GENERATION_FORMAT_GUARD_TITLE = 'AutoPlan 任务拆解格式硬性要求（必须遵守）';

class LoopService extends EventEmitter {
  constructor(db) {
    super();
    this.db = db;
    this.runtimes = new Map();
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
    this.db.run(
      `UPDATE project_states
       SET ${stateUpdates.map(([column]) => `${column} = ?`).join(', ')}
       WHERE project_id = ?`,
      [...stateUpdates.map(([, value]) => value), projectId],
    );
    if (runtime?.running) this.scheduleProject(projectId, nextInterval);
    this.emitUpdate(projectId);
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
    runtime.busy = true;
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
           ORDER BY created_at ASC`,
          [projectId],
        )
        .map((row) => ({ ...row, __type: 'requirement' }));
      const pendingFeedback = this.db
        .all(
          `SELECT * FROM feedback
           WHERE project_id = ? AND linked_plan_id IS NULL
             AND status NOT IN ('completed', 'closed')
           ORDER BY created_at ASC`,
          [projectId],
        )
        .map((row) => ({ ...row, __type: 'feedback' }));
      const pendingIntakes = [...pendingRequirements, ...pendingFeedback];
      this.addEvent(projectId, 'scan.done', `待处理需求/反馈=${pendingIntakes.length}`);

      // 一次只生成一个计划（保持串行，避免 codex 并发），剩余等下一轮 timer
      let generatedPlanId = null;
      if (pendingIntakes.length > 0) {
        generatedPlanId = await this.generatePlanForIntake(projectId, workspace, pendingIntakes[0]);
      }

      // 同步 docs/plan 目录下的 plan 文件（兼容文件式需求）
      const planScan = this.scanDirectory(path.join(workspace, 'docs', 'plan'), workspace, ['.md']);
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
        await this.validatePlan(workspace, executablePlan, { task });
      } else {
        const result = await this.executeTask(workspace, executablePlan, task);
        if (result.exitCode === 0) {
          this.completeTask(workspace, executablePlan, task, result);
        }
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

    const batches = this.validatedParallelTaskBatches(workspace, plan, confirmedBatches);
    const executablePlan = this.activateDraftPlan(plan);
    runtime.busy = true;
    try {
      for (let index = 0; index < batches.length; index += 1) {
        const tasks = batches[index];
        const results = await this.executeTaskBatch(workspace, executablePlan, tasks, {
          batchIndex: index + 1,
          batchCount: batches.length,
        });
        const failedTaskIds = results
          .filter((entry) => Number(entry?.result?.exitCode) !== 0)
          .map((entry) => entry.task.id);
        const continueNext = failedTaskIds.length === 0;
        this.addEvent(projectId, 'tasks.parallel.finished', `并发批次 ${index + 1}/${batches.length} 执行完成`, {
          planId: plan.id,
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
    // 若当前正在执行该 plan 的任务，kill 进程
    const runtime = this.runtime(projectId);
    const activePlanOperations = runtime
      ? findRuntimeOperations(runtime, (operation) => Number(operation?.planId) === Number(planId))
      : [];
    for (const activeEntry of activePlanOperations) {
      const finishedAt = nowIso();
      killChildProcess(activeEntry.child);
      const activeTaskId = activeEntry.operation?.taskId;
      const activeTask = activeTaskId ? this.taskForProject(projectId, activeTaskId) : null;
      const interruptedTask = activeTaskId
        ? this.finishTaskRun(activeTaskId, 'blocked', finishedAt, { onlyIfRunning: true })
        : null;
      const eventTask = interruptedTask || activeTask || (activeTaskId ? { id: activeTaskId, plan_id: planId } : null);
      if (eventTask) {
        this.addTaskLifecycleEvent(projectId, TASK_EVENT_TYPES.INTERRUPTED, eventTask, {
          ...agentCliContextFields(activeEntry.operation, { defaultProvider: true }),
          planId,
          taskId: activeTaskId || undefined,
          status: TASK_EVENT_STATUS.INTERRUPTED,
          finishedAt,
          log: activeEntry.operation?.logFile,
          exitCode: typeof activeEntry.operation?.exitCode === 'number' ? activeEntry.operation.exitCode : undefined,
        });
      }
    }
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
    if (!plan || plan.status !== 'draft') return plan;
    const updatedAt = nowIso();
    this.db.run('UPDATE plans SET status = ?, updated_at = ? WHERE id = ? AND status = ?', [
      'running',
      updatedAt,
      plan.id,
      'draft',
    ]);
    this.addEvent(plan.project_id, 'plan.draft.started', `草稿计划 #${plan.id} 已开始执行`, { planId: plan.id });
    return { ...plan, status: 'running', updated_at: updatedAt };
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
    return syncPlanTasksFromMarkdown(this, planId, planFile);
  }

  /** 把当前 activeOperation 转存为 lastOperation（保留日志），然后清空 active */
  archiveOperation(projectId, operationKey) {
    archiveRuntimeOperation(this.runtime(projectId), operationKey);
  }

  async runCodexWithPlanGuard(workspace, prompt, label, operation, planFile) {
    const before = planFile && fs.existsSync(planFile) ? fs.readFileSync(planFile, 'utf8') : null;
    const result = await this.runCodex(workspace, prompt, label, operation);
    if (before !== null) {
      const changed = !fs.existsSync(planFile) || fs.readFileSync(planFile, 'utf8') !== before;
      if (changed) {
        fs.writeFileSync(planFile, before, 'utf8');
        this.addEvent(operation.projectId, 'plan.guard.restored', `${agentCliProviderDisplayName(result.agentCliProvider)} 修改了 plan，已恢复：${normalizeRelative(workspace, planFile)}`, {
          ...agentCliContextFields(result),
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
      logBuffer: '',
      activity: isCodexProvider ? new CodexActivityPrinter(200) : null,
      startedAt: nowIso(),
    };
    if (!isCodexProvider) clearCodexSessionFields(activeOperation);
    let operationKey = null;
    let capturedSessionId = '';
    let sessionScanBuffer = '';
    const stream = fs.createWriteStream(logFile, { encoding: 'utf8' });
    const appendInternalLog = (message) => {
      const text = `\n[AutoPlan] ${message}\n`;
      stream.write(text);
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
      const codexSessionFields = isCodexProvider
        ? codexSessionContextFields({
            codexSessionId: sessionId,
            codexSessionRequestedId: requestedSessionId,
            codexSessionMode: mode,
            codexSessionFallback: mode === 'new' && Boolean(requestedSessionId),
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
        ...(isCodexProvider
          ? {
              sessionId: sessionId || null,
              codexSessionId: sessionId || null,
              codexSessionMode: mode,
              resumed: mode === 'resume',
            }
          : {}),
        ...codexSessionFields,
      };
    };
    const runAttempt = async (args, mode) => {
      if (isCodexProvider) {
        activeOperation.codexSessionMode = mode;
        activeOperation.codexSessionState = activeOperation.codexSessionFallback ? 'fallback-new' : mode;
        activeOperation.codexSessionId = mode === 'resume' ? requestedSessionId || null : capturedSessionId || null;
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
        env: workspaceToolEnv(workspace),
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
    }, 600);
    try {
      if (!isCodexProvider) {
        const attempt = await runAttempt([], '');
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
      return resultFor(fresh, 'new');
    } finally {
      clearInterval(tailTimer);
      stream.end();
      if (operationKey && runtime.activeOperations.has(operationKey)) {
        this.archiveOperation(projectIdForEmit, operationKey);
      }
    }
  }

  async runShell(workspace, command, label, operation = {}) {
    const projectIdForEmit = operation.projectId;
    const runtime = this.runtime(projectIdForEmit);
    if (!runtime) throw new Error('projectId is required for shell operations');
    const logDir = path.join(workspace, 'docs', 'progress', 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    const logFile = path.join(logDir, `${timestampForPath()}_${safePart(label)}.log`);
    const shellCommand = process.platform === 'win32' ? `chcp 65001>nul && ${command}` : command;
    const child = spawn(shellCommand, {
      shell: true,
      cwd: workspace,
      env: workspaceToolEnv(workspace),
    });
    const activeOperation = {
      ...operation,
      label,
      logBuffer: '',
      activity: new CodexActivityPrinter(200),
      startedAt: nowIso(),
    };
    const operationKey = registerRuntimeOperation(runtime, child, activeOperation);
    let output = '';
    const onChunk = (chunk) => {
      const text = chunk.toString('utf8');
      output += text;
      if (!runtime.activeOperations.has(operationKey)) return;
      activeOperation.logBuffer = (activeOperation.logBuffer || '') + text;
      if (activeOperation.logBuffer.length > 24000) {
        activeOperation.logBuffer = activeOperation.logBuffer.slice(-16000);
      }
      if (activeOperation.activity) activeOperation.activity.offer(text);
    };
    child.stdout.on('data', onChunk);
    child.stderr.on('data', onChunk);
    const tailTimer = setInterval(() => {
      if (projectIdForEmit) this.emitUpdate(projectIdForEmit);
    }, 600);
    try {
      const exitCode = await waitForChild(child, SHELL_COMMAND_TIMEOUT_MS);
      const timedOut = Boolean(child.__autoplanTimedOut);
      const errorMessage = timedOut ? `Shell command timed out after ${validationFlow.formatDurationMs(SHELL_COMMAND_TIMEOUT_MS)}` : '';
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
      return { exitCode, output, logFile, errorMessage, timedOut, timeoutMs: SHELL_COMMAND_TIMEOUT_MS };
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

  emitUpdate(projectId) {
    this.emit('update', this.snapshot(projectId));
  }

  snapshot(projectId = null) {
    return snapshots.snapshot(this, loopFlowHelpers(), projectId);
  }
}

function intakeAttachmentOwnerTypes(intakeType) {
  return intakeType === 'feedback' ? ['feedback'] : ['requirement', 'requirements'];
}

function describeIntakeAttachment(workspace, attachment, index) {
  const name = attachmentField(attachment, ['original_name', 'originalName', 'name', 'filename', 'file_name']) || `附件 ${index + 1}`;
  const mime = attachmentField(attachment, ['mime', 'mime_type', 'mimeType', 'content_type', 'contentType']) || 'unknown';
  const declaredSize = attachmentField(attachment, ['size', 'file_size', 'fileSize']);
  const hash = attachmentField(attachment, ['sha256', 'hash', 'file_hash', 'fileHash']) || 'unknown';
  const storedPath = attachmentField(attachment, [
    'stored_path',
    'storedPath',
    'persistent_path',
    'persistentPath',
    'file_path',
    'filePath',
    'path',
  ]);
  const resolvedPath = resolveAttachmentPath(workspace, storedPath);
  let readable = false;
  let readError = '';
  let actualSize = null;

  if (!resolvedPath) {
    readError = '缺少持久化本地路径';
  } else {
    try {
      fs.accessSync(resolvedPath, fs.constants.R_OK);
      const stat = fs.statSync(resolvedPath);
      readable = stat.isFile();
      actualSize = stat.size;
      if (!readable) readError = '路径不是文件';
    } catch (error) {
      readError = error?.message || String(error);
    }
  }

  return {
    id: attachment.id,
    number: index + 1,
    name,
    mime,
    size: declaredSize ?? actualSize,
    actualSize,
    hash,
    path: resolvedPath || storedPath || '',
    readable,
    readError,
  };
}

function formatIntakeAttachmentEntry(entry) {
  const lines = [
    `- 附件 ${entry.number}: ${entry.name}`,
    `  - MIME: ${entry.mime}`,
    `  - 大小: ${formatAttachmentSize(entry.size)}`,
    `  - SHA256: ${entry.hash}`,
    `  - 持久化本地路径: ${entry.path || '（缺失）'}`,
    `  - 读取方式: 工具可以通过上述本地路径读取附件内容`,
    `  - 可读性: ${entry.readable ? '已确认可读' : `不可读：${entry.readError || '未知错误'}`}`,
  ];
  if (entry.actualSize != null && String(entry.actualSize) !== String(entry.size ?? '')) {
    lines.push(`  - 实际文件大小: ${entry.actualSize} bytes`);
  }
  return lines;
}

function attachmentField(attachment, keys) {
  for (const key of keys) {
    if (attachment?.[key] !== undefined && attachment[key] !== null && attachment[key] !== '') {
      return attachment[key];
    }
  }
  return '';
}

function resolveAttachmentPath(workspace, storedPath) {
  const value = String(storedPath || '').trim();
  if (!value) return '';
  return path.isAbsolute(value) ? value : path.resolve(workspace, value);
}

function formatAttachmentSize(size) {
  return size === undefined || size === null || size === '' ? 'unknown' : `${size} bytes`;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function timestampForPath() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(
    now.getHours(),
  )}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
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

function syncPlanTasksFromMarkdown(service, planId, planFile) {
  if (!fs.existsSync(planFile)) return;
  const text = fs.readFileSync(planFile, 'utf8');
  const tasks = parsePlanTasksFromMarkdown(text);
  if (!tasks.length) recordEmptyPlanTaskParse(service, planId, planFile, text);
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
        [task.title, task.rawLine, task.scope, status, task.sortOrder, nowIso(), existing.id],
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
    for (const stale of matches) service.db.run('DELETE FROM plan_tasks WHERE id = ?', [stale.id]);
  }

  const completed = syncedStatuses.filter((status) => status === TASK_EVENT_STATUS.COMPLETED).length;
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

function recordEmptyPlanTaskParse(service, planId, planFile, markdown) {
  const plan = service.db.get('SELECT id, project_id, file_path FROM plans WHERE id = ?', [planId]);
  if (!plan?.project_id) return;
  const filePath = plan.file_path || planFile;
  const message = `计划未解析到任务拆解：${filePath}`;
  const existing = service.db.get('SELECT id FROM events WHERE project_id = ? AND type = ? AND message = ? LIMIT 1', [
    plan.project_id,
    'plan.tasks.parse.empty',
    message,
  ]);
  if (existing) return;
  service.addEvent(plan.project_id, 'plan.tasks.parse.empty', message, {
    planId,
    filePath,
    taskCount: 0,
    markdownBytes: Buffer.byteLength(String(markdown || ''), 'utf8'),
    reason: 'no_parseable_task_lines',
    hint: '任务拆解必须位于 ## 任务拆解 章节，并使用 - [ ] P001: 任务标题 <!-- scope: ... --> 独占一行；不要写成段落、代码块、表格或嵌套 checkbox。',
  });
}

function parsePlanTasksFromMarkdown(markdown) {
  const tasks = [];
  const lines = String(markdown || '').split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(PLAN_TASK_LINE_RE);
    if (!match) continue;
    const sortOrder = tasks.length + 1;
    const rawTitle = match[2].trim();
    const titleWithoutScope = stripPlanTaskScopeComment(rawTitle);
    const parsedTitle = parsePlanTaskTitle(titleWithoutScope, sortOrder);
    const rawLine = ensurePlanTaskScopeComment(line, parsedTitle.validationLike ? 'validation' : 'unknown');
    tasks.push({
      key: parsedTitle.key,
      title: parsedTitle.title || titleWithoutScope || rawTitle,
      rawLine,
      scope: planTaskScopeText({ raw_line: rawLine, title: rawTitle }, parsedTitle.validationLike ? 'validation' : 'unknown'),
      status: match[1].toLowerCase() === 'x' ? TASK_EVENT_STATUS.COMPLETED : TASK_EVENT_STATUS.PENDING,
      sortOrder,
    });
  }
  return tasks;
}

function parsePlanTaskTitle(title, sortOrder) {
  const text = String(title || '').trim();
  const keyFallback = `P${String(sortOrder).padStart(3, '0')}`;
  const match = text.match(PLAN_TASK_KEY_RE);
  const validationLike = /完整验收|整体验收|总体验收|最终验收|完整验证|最终验证|acceptance|validation/i.test(text);
  if (!match) return { key: keyFallback, title: text, validationLike };
  return {
    key: normalizePlanTaskKey(match[1]) || keyFallback,
    title: cleanPlanTaskTitle(match[2]) || text,
    validationLike,
  };
}

function cleanPlanTaskTitle(value) {
  return String(value || '').replace(/^[-–—:：\s]+/, '').trim();
}

function normalizePlanTaskKey(value) {
  return String(value || '').trim().replace(/^([a-z]+)([-_]?\d+)$/i, (_match, prefix, suffix) => `${prefix.toUpperCase()}${suffix}`);
}

function planTaskScopeText(task, fallbackScope = 'unknown') {
  const explicit = planTaskDeclaredScopes(task, { keepUnknown: true, includePathFallback: false });
  if (explicit.length) return explicit.join(', ');
  const fallback = normalizePlanTaskScope(fallbackScope, { keepUnknown: true });
  if (fallback) return fallback;
  const inferred = planTaskDeclaredScopes(task, { keepUnknown: false });
  return inferred.join(', ') || 'unknown';
}

function planTaskDeclaredScopes(task, options = {}) {
  const { keepUnknown = false, includePathFallback = true } = options;
  const raw = `${task.task_key || ''} ${task.title || ''} ${task.raw_line || ''}`;
  const scopes = new Set();
  addPlanTaskScopeParts(scopes, String(task.scope || '').split(PLAN_TASK_SCOPE_SPLIT_RE), { keepUnknown });
  addPlanTaskScopeParts(scopes, explicitPlanTaskScopeParts(raw), { keepUnknown });
  if (includePathFallback) {
    for (const match of raw.matchAll(PLAN_TASK_PATH_RE)) {
      const scope = normalizePlanTaskScope(match[0], { keepUnknown });
      if (scope && !scope.startsWith('docs/plan/') && !scope.startsWith('docs/progress/')) scopes.add(scope);
    }
  }
  return Array.from(scopes);
}

function explicitPlanTaskScopeParts(raw) {
  const explicit = String(raw || '').match(PLAN_TASK_SCOPE_RE);
  return explicit?.[1] ? explicit[1].split(PLAN_TASK_SCOPE_SPLIT_RE) : [];
}

function addPlanTaskScopeParts(scopes, parts, options = {}) {
  for (const part of parts) {
    const scope = normalizePlanTaskScope(part, options);
    if (scope) scopes.add(scope);
  }
}

function normalizePlanTaskScope(value, options = {}) {
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

function ensurePlanTaskScopeComment(line, fallbackScope = 'unknown') {
  const text = String(line || '').trimEnd();
  return PLAN_TASK_SCOPE_RE.test(text) ? text : `${text} <!-- scope: ${fallbackScope} -->`;
}

function stripPlanTaskScopeComment(value) {
  return String(value || '').replace(PLAN_TASK_SCOPE_COMMENT_RE, ' ').replace(/\s+/g, ' ').trim();
}

function loopFlowHelpers() {
  return {
    describeIntakeAttachment,
    escapeRegExp,
    formatIntakeAttachmentEntry,
    hashFile,
    hashText,
    intakeAttachmentOwnerTypes,
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
