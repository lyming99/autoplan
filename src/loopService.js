const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { nowIso } = require('./database');
const { CodexActivityPrinter } = require('./codexActivity');
const {
  DEFAULT_AGENT_CLI_PROVIDER,
  codexNewSessionArgs,
  codexResumeSessionArgs,
  normalizeAgentCliCommand,
  normalizeAgentCliProvider,
  runAgentCliAttempt,
} = require('./agentCli');

const ACTIVE_RUNTIME_PHASES = new Set(['running', 'scan', 'generate-plan', 'execute-task', 'validate']);
const ACTIVE_RUNTIME_PHASE_SQL = "('running','scan','generate-plan','execute-task','validate')";
const MAX_PARALLEL_TASKS = 2;
const SPECIAL_TASK_SCOPES = new Set(['unknown', 'validation']);
const SHELL_COMMAND_TIMEOUT_MS = 10 * 60 * 1000;
const WORKSPACE_RUNTIME_DIR = '.autoplan-runtime';
const ACCEPTANCE_TASK_RE = /(完整验收|整体验收|总体验收|最终验收|完整验证|最终验证|acceptance|validation)/i;
const PARALLEL_BLOCKING_TASK_RE = /(全量|回归|验证|验收|测试|记录|整理|发布|部署|test|validate|regression|release|deploy)/i;
const TASK_SCOPE_LABEL_RE = '(?:scope|scopes|files?|影响范围|并发键)';
const TASK_SCOPE_RE = new RegExp(`${TASK_SCOPE_LABEL_RE}\\s*[:=：]\\s*([^>\\]\\n]+)`, 'i');
const TASK_SCOPE_COMMENT_RE = new RegExp(`\\s*<!--\\s*${TASK_SCOPE_LABEL_RE}\\s*[:=：]\\s*([^>]*?)\\s*-->\\s*`, 'i');
const TASK_SCOPE_SPLIT_RE = /[,，、;；]+/;
const TASK_PATH_RE = /[\w./\\-]+\.(?:dart|js|jsx|ts|tsx|css|scss|html|md|json|ya?ml)/gi;
const TASK_LIFECYCLE_EVENT_RECORDED = Symbol('taskLifecycleEventRecorded');
const CODEX_SESSION_UUID_RE_SOURCE = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const CODEX_SESSION_ID_RES = Object.freeze([
  new RegExp(`\\bsession\\s+id:\\s*(${CODEX_SESSION_UUID_RE_SOURCE})\\b`, 'i'),
  new RegExp(`"(?:session_id|sessionId)"\\s*:\\s*"(${CODEX_SESSION_UUID_RE_SOURCE})"`, 'i'),
  new RegExp(`\\b(?:session_id|sessionId)\\s*[:=]\\s*(${CODEX_SESSION_UUID_RE_SOURCE})\\b`, 'i'),
]);
const CODEX_RESUME_FAILURE_RE = /(?:thread\/resume|resume failed|no rollout found|session\s+(?:not\s+found|missing)|conversation\s+not\s+found|unknown\s+session|invalid\s+session)/i;
const AGENT_CLI_PROVIDER_COLUMNS = Object.freeze(['agent_cli_provider', 'cli_provider', 'cli_backend']);
const AGENT_CLI_COMMAND_COLUMNS = Object.freeze(['agent_cli_command', 'cli_command', 'cli_path']);
const CODEX_REASONING_EFFORT_COLUMNS = Object.freeze([
  'codex_reasoning_effort',
  'codexReasoningEffort',
  'codex_thinking_depth',
  'codexThinkingDepth',
  'reasoning_effort',
  'reasoningEffort',
  'thinking_depth',
  'thinkingDepth',
]);
const CODEX_REASONING_EFFORTS = new Set(['low', 'medium', 'high']);
const DEFAULT_CODEX_REASONING_EFFORT = 'medium';
const AGENT_CLI_PROVIDER_INPUT_KEYS = Object.freeze([
  'agentCliProvider',
  'agent_cli_provider',
  'cliProvider',
  'cli_provider',
  'cliBackend',
  'cli_backend',
]);
const AGENT_CLI_COMMAND_INPUT_KEYS = Object.freeze([
  'agentCliCommand',
  'agent_cli_command',
  'cliCommand',
  'cli_command',
  'cliPath',
  'cli_path',
]);
const AGENT_CLI_PROVIDER_CONTEXT_KEYS = Object.freeze([...AGENT_CLI_PROVIDER_INPUT_KEYS, 'provider']);
const AGENT_CLI_COMMAND_CONTEXT_KEYS = Object.freeze([...AGENT_CLI_COMMAND_INPUT_KEYS, 'command']);
const LOOP_CONFIG_INPUT_KEYS = Object.freeze([
  'workspacePath',
  'intervalSeconds',
  'validationCommand',
  ...AGENT_CLI_PROVIDER_INPUT_KEYS,
  ...AGENT_CLI_COMMAND_INPUT_KEYS,
  ...CODEX_REASONING_EFFORT_COLUMNS,
]);

const TASK_EVENT_TYPES = Object.freeze({
  STARTED: 'task.started',
  SUCCEEDED: 'task.succeeded',
  FAILED: 'task.failed',
  STOP_REQUESTED: 'task.stop.requested',
  STOPPED: 'task.stopped',
  INTERRUPTED: 'task.interrupted',
});

const LEGACY_TASK_EVENT_TYPES = Object.freeze({
  EXECUTED: 'task.executed',
  STOPPING: 'task.stopping',
});

const TASK_EVENT_STATUS = Object.freeze({
  PENDING: 'pending',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  STOPPING: 'stopping',
  STOPPED: 'stopped',
  INTERRUPTED: 'interrupted',
});

const TASK_EVENT_SEMANTICS = Object.freeze({
  [TASK_EVENT_TYPES.STARTED]: Object.freeze({ status: TASK_EVENT_STATUS.RUNNING, label: '开始了任务' }),
  [TASK_EVENT_TYPES.SUCCEEDED]: Object.freeze({ status: TASK_EVENT_STATUS.COMPLETED, label: '结束了任务' }),
  [TASK_EVENT_TYPES.FAILED]: Object.freeze({ status: TASK_EVENT_STATUS.FAILED, label: '任务失败' }),
  [TASK_EVENT_TYPES.STOP_REQUESTED]: Object.freeze({ status: TASK_EVENT_STATUS.STOPPING, label: '请求停止任务' }),
  [TASK_EVENT_TYPES.STOPPED]: Object.freeze({ status: TASK_EVENT_STATUS.STOPPED, label: '已停止任务' }),
  [TASK_EVENT_TYPES.INTERRUPTED]: Object.freeze({ status: TASK_EVENT_STATUS.INTERRUPTED, label: '已中断任务' }),
});

const TASK_EVENT_COMPATIBILITY = Object.freeze({
  [LEGACY_TASK_EVENT_TYPES.EXECUTED]: TASK_EVENT_TYPES.SUCCEEDED,
  [LEGACY_TASK_EVENT_TYPES.STOPPING]: TASK_EVENT_TYPES.STOPPED,
});

class LoopService extends EventEmitter {
  constructor(db) {
    super();
    this.db = db;
    this.runtimes = new Map();
    this.resetRuntimeState();
  }

  runtime(projectId) {
    const id = Number(projectId || 0);
    if (!id) return null;
    let runtime = this.runtimes.get(id);
    if (!runtime) {
      runtime = createProjectRuntime();
      this.runtimes.set(id, runtime);
    }
    return runtime;
  }

  existingRuntime(projectId) {
    return this.runtimes.get(Number(projectId || 0)) || null;
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
    const running = runtime?.running ? 1 : 0;
    let phase = state.phase || 'idle';
    if (!running && !runtime?.busy && ACTIVE_RUNTIME_PHASES.has(String(phase || ''))) {
      phase = 'stopped';
    }
    return {
      ...project,
      running,
      phase,
      interval_seconds: Number(state.interval_seconds || 5),
      validation_command: state.validation_command || '',
      agent_cli_provider: agentCliConfig.provider,
      agent_cli_command: agentCliConfig.command,
    };
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
    const now = nowIso();
    this.db.run(
      `UPDATE project_states
       SET running = 0,
           phase = CASE WHEN phase IN ${ACTIVE_RUNTIME_PHASE_SQL} THEN 'stopped' ELSE phase END,
           updated_at = ?
       WHERE running != 0 OR phase IN ${ACTIVE_RUNTIME_PHASE_SQL}`,
      [now],
    );
    this.db.run(
      `UPDATE loop_state
       SET running = 0,
           phase = CASE WHEN phase IN ${ACTIVE_RUNTIME_PHASE_SQL} THEN 'stopped' ELSE phase END,
           updated_at = ?
       WHERE id = 1 AND (running != 0 OR phase IN ${ACTIVE_RUNTIME_PHASE_SQL})`,
      [now],
    );
    this.db.run('UPDATE plan_tasks SET status = ?, updated_at = ? WHERE status = ?', ['pending', now, 'running']);
  }

  status(projectId = this.defaultProjectId()) {
    if (!projectId) return null;
    this.ensureProjectState(projectId);
    return this.normalizeRuntimeStatus(projectId, this.db.get('SELECT * FROM project_states WHERE project_id = ?', [projectId]));
  }

  normalizeRuntimeStatus(projectId, state) {
    if (!state) return null;
    const runtime = this.existingRuntime(projectId);
    const runtimeRunning = Boolean(runtime?.running);
    const agentCliConfig = normalizeAgentCliConfig(state);
    const normalized = {
      ...state,
      running: runtimeRunning ? 1 : 0,
      validation_command: state.validation_command ?? '',
      agent_cli_provider: agentCliConfig.provider,
      agent_cli_command: agentCliConfig.command,
      codex_reasoning_effort: agentCliConfig.codexReasoningEffort,
    };

    if (!runtimeRunning && !runtime?.busy && ACTIVE_RUNTIME_PHASES.has(String(normalized.phase || ''))) {
      normalized.phase = 'stopped';
    }

    return normalized;
  }

  configure(projectId, config = {}) {
    const { workspacePath, intervalSeconds, validationCommand } = config;
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
    const stateUpdates = [
      ['interval_seconds', nextInterval],
      ['validation_command', validationCommand ?? current.validation_command],
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
    if (!runtime) return;
    if (runtime.timer) clearInterval(runtime.timer);
    runtime.timer = setInterval(() => {
      if (!runtime.running) return;
      this.runOnce(projectId).catch((error) => this.recordError(projectId, error));
    }, Math.max(1, Number(intervalSeconds || 5)) * 1000);
  }

  activeProjectForWorkspace(workspace, projectId) {
    const key = workspaceKey(workspace);
    if (!key) return null;
    for (const [id, runtime] of this.runtimes.entries()) {
      if (Number(id) === Number(projectId)) continue;
      if (!runtime.running && !runtime.busy && !runtime.activeChild) continue;
      const project = this.project(id);
      if (workspaceKey(project?.workspace_path) === key) return project;
    }
    return null;
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
        const activeTask = activeTaskId ? this.taskForProject(projectId, activeTaskId) : null;
        const stoppedTask = activeTaskId
          ? this.finishTaskRun(activeTaskId, TASK_EVENT_STATUS.PENDING, finishedAt, { onlyIfRunning: true })
          : null;
        const eventTask = stoppedTask || activeTask || (activeTaskId ? { id: activeTaskId, plan_id: operation?.planId } : null);
        if (eventTask) {
          this.addTaskLifecycleEvent(projectId, TASK_EVENT_TYPES.STOPPED, eventTask, {
            ...agentCliContextFields(operation, { defaultProvider: true }),
            status: TASK_EVENT_STATUS.STOPPED,
            finishedAt,
            log: operation?.logFile,
            exitCode: typeof operation?.exitCode === 'number' ? operation.exitCode : undefined,
          });
        } else {
          this.addEvent(projectId, 'operation.stopping', operation?.label || '');
        }
      }
    }
    this.db.run(
      'UPDATE project_states SET running = 0, phase = ?, updated_at = ? WHERE project_id = ?',
      ['stopped', nowIso(), projectId],
    );
    this.addEvent(projectId, 'loop.stopped', '循环已停止');
    this.emitUpdate(projectId);
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
      const nextPlan = generatedPlanId
        ? this.db.get('SELECT * FROM plans WHERE id = ? AND project_id = ?', [generatedPlanId, projectId])
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

    runtime.busy = true;
    try {
      if (this.isFinalAcceptanceTask(plan.id, task)) {
        await this.validatePlan(workspace, plan, { task });
      } else {
        const result = await this.executeTask(workspace, plan, task);
        if (result.exitCode === 0) {
          this.completeTask(workspace, plan, task, result);
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
    runtime.busy = true;
    try {
      for (let index = 0; index < batches.length; index += 1) {
        const tasks = batches[index];
        const results = await this.executeTaskBatch(workspace, plan, tasks, {
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
    const batches = normalizeConfirmedTaskBatches(confirmedBatches);
    if (!batches.length) throw new Error('未选择并发任务批次');
    const seenTaskIds = new Set();
    return batches.map((batchTaskIds, batchIndex) => {
      if (batchTaskIds.length < 2) throw new Error(`第 ${batchIndex + 1} 批至少需要 2 个任务`);
      if (batchTaskIds.length > MAX_PARALLEL_TASKS) {
        throw new Error(`第 ${batchIndex + 1} 批超过最大并发数 ${MAX_PARALLEL_TASKS}`);
      }
      const usedScopes = new Set();
      return batchTaskIds.map((taskId) => {
        if (seenTaskIds.has(taskId)) throw new Error('同一任务不能重复出现在并发批次中');
        seenTaskIds.add(taskId);
        const task = this.db.get(
          'SELECT * FROM plan_tasks WHERE id = ? AND plan_id = ?',
          [taskId, plan.id],
        );
        if (!task) throw new Error('任务不存在或不属于当前计划');
        if (task.status !== TASK_EVENT_STATUS.PENDING) {
          throw new Error(`${task.task_key} 当前状态不是 pending，不能并发执行`);
        }
        const analysis = taskConcurrencyAnalysis(workspace, task);
        if (!analysis.canRunInParallel) {
          throw new Error(`${task.task_key} 不可并发：${analysis.reason}`);
        }
        const conflictScope = analysis.scopes.find((scope) => usedScopes.has(scope));
        if (conflictScope) {
          throw new Error(`第 ${batchIndex + 1} 批存在 scope 冲突：${conflictScope}`);
        }
        for (const scope of analysis.scopes) usedScopes.add(scope);
        return task;
      });
    });
  }

  stopTask(projectId, taskId) {
    const task = this.taskForProject(projectId, taskId);
    if (!task) throw new Error('任务不存在');
    const runtime = this.runtime(projectId);

    const activeEntry = findRuntimeOperation(runtime, (operation) => Number(operation?.taskId) === Number(taskId));
    if (activeEntry) {
      killChildProcess(activeEntry.child);
      const finishedAt = nowIso();
      const stoppedTask = runtime?.running
        ? task
        : this.finishTaskRun(taskId, TASK_EVENT_STATUS.PENDING, finishedAt, { onlyIfRunning: true }) || task;
      if (!runtime.running) {
        this.addTaskLifecycleEvent(projectId, TASK_EVENT_TYPES.STOPPED, stoppedTask, {
          ...agentCliContextFields(activeEntry.operation, { defaultProvider: true }),
          status: TASK_EVENT_STATUS.STOPPED,
          finishedAt,
          log: activeEntry.operation?.logFile,
          exitCode: typeof activeEntry.operation?.exitCode === 'number' ? activeEntry.operation.exitCode : undefined,
        });
      }
    } else {
      const finishedAt = nowIso();
      const stoppedTask = this.finishTaskRun(taskId, TASK_EVENT_STATUS.PENDING, finishedAt, { onlyIfRunning: true }) || task;
      const taskPlan = this.db.get('SELECT * FROM plans WHERE id = ? AND project_id = ?', [task.plan_id, projectId]);
      this.addTaskLifecycleEvent(projectId, TASK_EVENT_TYPES.STOP_REQUESTED, stoppedTask, {
        ...agentCliContextFields(taskPlan ? this.planAgentCliConfig(taskPlan) : this.status(projectId), { defaultProvider: true }),
        status: TASK_EVENT_STATUS.STOPPING,
        finishedAt,
      });
    }

    if (runtime?.running) this.stop(projectId);
    else this.setPhase(projectId, 'stopped');
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
    const project = this.project(projectId);
    const workspace = project?.workspace_path;
    const plan = this.db.get('SELECT * FROM plans WHERE id = ? AND project_id = ?', [planId, projectId]);
    if (!plan) throw new Error('计划不存在');
    if (!workspace) throw new Error('请先设置项目工作区路径');

    const planFile = path.join(workspace, plan.file_path);
    if (!fs.existsSync(planFile)) throw new Error('plan 文件不存在，无法追加任务');

    const cleanTitle = String(title || '').trim();
    if (!cleanTitle) throw new Error('任务标题不能为空');

    // 计算下一个 task_key
    const existing = this.db.all('SELECT task_key FROM plan_tasks WHERE plan_id = ? ORDER BY sort_order', [planId]);
    const maxNum = existing.reduce((max, row) => {
      const m = String(row.task_key || '').match(/P0*(\d+)/i);
      return m ? Math.max(max, Number(m[1])) : max;
    }, 0);
    const taskKey = `P${String(maxNum + 1).padStart(3, '0')}`;

    // 追加到 plan 文件的"## 任务计划"段末尾
    let content = fs.readFileSync(planFile, 'utf8');
    const line = ensureTaskScopeComment(`- [ ] ${taskKey}: ${cleanTitle}`);
    const taskSectionIdx = content.search(/##\s*任务计划/);
    const lastTask = this.db.get(
      'SELECT * FROM plan_tasks WHERE plan_id = ? ORDER BY sort_order DESC, id DESC LIMIT 1',
      [planId],
    );
    if (taskSectionIdx === -1) {
      content = `${content.trim()}\n\n## 任务计划\n${line}\n`;
    } else if (isAcceptanceTask(lastTask)) {
      content = insertTaskLineBeforeTask(content, lastTask, line);
    } else {
      content = `${content.trimEnd()}\n${line}\n`;
    }
    fs.writeFileSync(planFile, content, 'utf8');

    // 若 plan 被中断过，恢复为 pending 让新任务可执行
    if (plan.status === 'interrupted') {
      this.db.run('UPDATE plans SET status = ?, updated_at = ? WHERE id = ?', ['pending', nowIso(), planId]);
    }
    // 重新解析任务入库
    this.syncPlanTasks(planId, planFile);
    const task = this.db.get('SELECT * FROM plan_tasks WHERE plan_id = ? AND task_key = ?', [planId, taskKey]);
    this.addEvent(
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
    this.emitUpdate(projectId);

    // 循环在运行则立即拾取
    if (this.status(projectId)?.running) {
      this.runOnce(projectId).catch((error) => this.recordError(projectId, error));
    }
    return taskKey;
  }

  ensureWorkspaceDirs(workspace) {
    for (const dir of ['docs/issues', 'docs/plan', 'docs/progress', 'docs/progress/logs']) {
      fs.mkdirSync(path.join(workspace, dir), { recursive: true });
    }
  }

  scanDirectory(root, workspace, extensions) {
    if (!fs.existsSync(root)) return { root, aggregateHash: hashText(''), files: [] };
    const files = [];
    const visit = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          visit(full);
        } else if (entry.isFile() && extensions.includes(path.extname(entry.name).toLowerCase())) {
          const stat = fs.statSync(full);
          files.push({
            path: normalizeRelative(workspace, full),
            hash: hashFile(full),
            size: stat.size,
            modifiedAt: stat.mtime.toISOString(),
          });
        }
      }
    };
    visit(root);
    files.sort((a, b) => a.path.localeCompare(b.path));
    return {
      root,
      aggregateHash: hashText(files.map((file) => `${file.path}|${file.hash}|${file.size}`).join('\n')),
      files,
    };
  }

  saveScan(projectId, type, scan) {
    const scannedAt = nowIso();
    this.db.run('DELETE FROM scan_files WHERE project_id = ? AND scan_type = ?', [projectId, type]);
    for (const file of scan.files) {
      this.db.run(
        `INSERT OR REPLACE INTO scan_files
         (project_id, scan_type, file_path, hash, size, modified_at, scanned_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [projectId, type, file.path, file.hash, file.size, file.modifiedAt, scannedAt],
      );
    }
  }

  hasPlanForIssueHash(projectId, issueHash) {
    return Boolean(
      this.db.get('SELECT id FROM plans WHERE project_id = ? AND issue_hash = ? LIMIT 1', [projectId, issueHash]),
    );
  }

  nextRunnablePlan(projectId) {
    return this.db.get(
      `SELECT * FROM plans
       WHERE project_id = ? AND status NOT IN ('completed', 'interrupted')
       ORDER BY created_at ASC
       LIMIT 1`,
      [projectId],
    );
  }

  insertPlan({ projectId, issueHash, filePath, hash, status, agentCliConfig }) {
    const createdAt = nowIso();
    const columns = [
      'project_id',
      'issue_hash',
      'file_path',
      'hash',
      'status',
      'total_tasks',
      'completed_tasks',
      'validation_passed',
      'created_at',
      'updated_at',
    ];
    const values = [projectId, issueHash, filePath, hash, status, 0, 0, 0, createdAt, createdAt];
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
    const eventSnapshot = this.planAgentCliEventSnapshot(plan.project_id, plan.id);
    const sourceSnapshot = this.planSourceAgentCliSnapshot(plan.project_id, plan.id);
    if (hasAgentCliOverride(plan)) return effectiveAgentCliConfig({}, plan);
    if (eventSnapshot) return effectiveAgentCliConfig({}, eventSnapshot);
    if (sourceSnapshot) return effectiveAgentCliConfig({}, sourceSnapshot);
    return effectiveAgentCliConfig({});
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
    this.setPhase(projectId, 'generate-plan');
    const planAgentCliConfig = effectiveAgentCliConfig(this.status(projectId));
    const planFile = path.join(
      workspace,
      'docs',
      'plan',
      `plan_${timestampForPath()}_${issueScan.aggregateHash.slice(0, 8)}.md`,
    );
    const issueBundle = issueScan.files
      .map((file) => {
        const full = path.join(workspace, file.path);
        return ['---', `path: ${file.path}`, `hash: ${file.hash}`, 'content:', readSnippet(full, 20000)].join('\n');
      })
      .join('\n');

    const prompt = [
      '你是需求整理与开发计划生成者。',
      '请根据 docs/issues 收集到的反馈和需求，生成一个开发计划和验收标准。',
      '',
      `输出文件：${planFile}`,
      '',
      '格式要求：',
      '- 每个任务必须严格使用固定格式：- [ ] P001: 任务标题 <!-- scope: lib/foo.dart,test/foo_test.dart -->',
      '- scope 必填，表示该任务预计修改的文件或模块；多个 scope 用英文逗号分隔；无法判断时写 <!-- scope: unknown -->，unknown 任务不会并发执行',
      '- 每个任务要有验收要点',
      '- 不要把“运行测试/回归/验收/构建”拆成普通开发任务；每个 plan 的最后一个任务必须是“完整验收”节点，负责对整个 plan 做最终验收',
      '- 最后一个任务必须严格放在任务列表最后，标题建议“完整验收”，scope 写 validation；总体验收标准写明最终验收命令、范围和通过标准',
      '- 如果需求明确要求新增或更新测试文件，可以生成“补充测试代码”的开发任务，但任务验收要点只描述应覆盖的场景，不要求在该任务内运行测试',
      '- 必须包含总体验收标准和进度区',
      '- 只写 plan 文件，不要改业务代码',
      '',
      '需求快照：',
      issueBundle,
    ].join('\n');

    const result = await this.runCodex(workspace, prompt, 'generate-plan', {
      projectId,
      ...agentCliOperationFields(planAgentCliConfig),
    });
    const agentContext = agentCliContextFields(result, { defaultProvider: true });
    const planAgentCliSnapshot = effectiveAgentCliConfig(planAgentCliConfig, agentContext);
    const agentLabel = agentCliProviderDisplayName(agentContext.agentCliProvider);
    if (result.exitCode !== 0 || !fs.existsSync(planFile)) {
      this.addEvent(projectId, 'plan.generate.failed', `${agentLabel} 计划生成失败：${result.logFile}`, agentContext);
      return;
    }

    const id = this.insertPlan({
      projectId,
      issueHash: issueScan.aggregateHash,
      filePath: normalizeRelative(workspace, planFile),
      hash: hashFile(planFile),
      status: 'pending',
      agentCliConfig: planAgentCliSnapshot,
    });
    this.syncPlanTasks(id, planFile);
    this.db.run('UPDATE project_states SET last_issue_hash = ?, updated_at = ? WHERE project_id = ?', [
      issueScan.aggregateHash,
      nowIso(),
      projectId,
    ]);
    this.addEvent(projectId, 'plan.generated', `${agentLabel} 生成计划：${normalizeRelative(workspace, planFile)}`, {
      ...agentContext,
      planId: id,
    });
  }

  /** 为单条需求/反馈生成计划（调 codex），并回写 linked_plan_id。失败返回 null，下轮重试。 */
  async generatePlanForIntake(projectId, workspace, intake) {
    const table = intake.__type === 'feedback' ? 'feedback' : 'requirements';
    const sourceName = intake.__type === 'feedback' ? '反馈' : '需求';
    this.setPhase(projectId, 'generate-plan');
    const planAgentCliConfig = effectiveAgentCliConfig(this.status(projectId), intake);
    const safeId = String(intake.id).replace(/[^0-9a-zA-Z_-]/g, '');
    const planFile = path.join(
      workspace,
      'docs',
      'plan',
      `plan_${intake.__type}_${safeId}_${timestampForPath()}.md`,
    );
    const attachmentPrompt = this.intakeAttachmentPrompt(projectId, workspace, intake, sourceName);
    const promptParts = [
      '你是需求整理与开发计划生成者。',
      `请根据以下${sourceName}，生成一个开发计划和验收标准。`,
      '',
      `输出文件：${planFile}`,
      '',
      '格式要求：',
      '- 每个任务必须严格使用固定格式：- [ ] P001: 任务标题 <!-- scope: lib/foo.dart,test/foo_test.dart -->',
      '- scope 必填，表示该任务预计修改的文件或模块；多个 scope 用英文逗号分隔；无法判断时写 <!-- scope: unknown -->，unknown 任务不会并发执行',
      '- 每个任务要有验收要点',
      '- 不要把“运行测试/回归/验收/构建”拆成普通开发任务；每个 plan 的最后一个任务必须是“完整验收”节点，负责对整个 plan 做最终验收',
      '- 最后一个任务必须严格放在任务列表最后，标题建议“完整验收”，scope 写 validation；总体验收标准写明最终验收命令、范围和通过标准',
      '- 如果需求明确要求新增或更新测试文件，可以生成“补充测试代码”的开发任务，但任务验收要点只描述应覆盖的场景，不要求在该任务内运行测试',
      '- 必须包含总体验收标准和进度区',
      '- 只写 plan 文件，不要改业务代码',
      '',
      `${sourceName} #${intake.id} 内容：`,
      String(intake.body || '').trim() || '（正文为空）',
    ];
    if (attachmentPrompt) promptParts.push('', attachmentPrompt);
    const prompt = promptParts.join('\n');

    const result = await this.runCodex(workspace, prompt, `gen-${intake.__type}-${intake.id}`, {
      projectId,
      intakeType: intake.__type,
      intakeId: intake.id,
      ...agentCliOperationFields(planAgentCliConfig),
    });
    const agentContext = agentCliContextFields(result, { defaultProvider: true });
    const planAgentCliSnapshot = effectiveAgentCliConfig(planAgentCliConfig, agentContext);
    const agentLabel = agentCliProviderDisplayName(agentContext.agentCliProvider);
    if (result.exitCode !== 0 || !fs.existsSync(planFile)) {
      this.addEvent(projectId, 'plan.generate.failed', `${agentLabel} 生成${sourceName} #${intake.id} 计划失败：${result.logFile}`, agentContext);
      return null;
    }

    const issueHash = `${intake.__type}-${intake.id}-${hashText(String(intake.body || '')).slice(0, 16)}`;
    const id = this.insertPlan({
      projectId,
      issueHash,
      filePath: normalizeRelative(workspace, planFile),
      hash: hashFile(planFile),
      status: 'pending',
      agentCliConfig: planAgentCliSnapshot,
    });
    this.syncPlanTasks(id, planFile);
    // 回写关联
    this.db.run(`UPDATE ${table} SET linked_plan_id = ?, updated_at = ? WHERE id = ?`, [id, nowIso(), intake.id]);
    this.addEvent(projectId, 'plan.generated', `${agentLabel} 为${sourceName} #${intake.id} 生成计划：${normalizeRelative(workspace, planFile)}`, {
      ...agentContext,
      planId: id,
      intakeType: intake.__type,
      intakeId: intake.id,
    });
    return id;
  }

  intakeAttachmentPrompt(projectId, workspace, intake, sourceName) {
    const ownerTypes = intakeAttachmentOwnerTypes(intake.__type);
    const placeholders = ownerTypes.map(() => '?').join(', ');
    const attachments = this.db.all(
      `SELECT * FROM attachments
       WHERE project_id = ? AND owner_id = ? AND owner_type IN (${placeholders})
       ORDER BY created_at ASC, id ASC`,
      [projectId, intake.id, ...ownerTypes],
    );
    if (!attachments.length) return '';

    const entries = attachments.map((attachment, index) => describeIntakeAttachment(workspace, attachment, index));
    const failed = entries.filter((entry) => !entry.readable);
    if (failed.length) {
      this.addEvent(
        projectId,
        'attachment.read.failed',
        `${sourceName} #${intake.id} 存在不可读附件：${failed.map((entry) => `${entry.name}（${entry.readError}）`).join('；')}`,
        {
          intakeType: intake.__type,
          intakeId: intake.id,
          attachments: failed.map((entry) => ({
            id: entry.id,
            name: entry.name,
            path: entry.path,
            error: entry.readError,
          })),
        },
      );
    }

    return [
      '附件清单：',
      '以下附件已持久化到本地文件系统；不要将图片二进制内联进 plan，工具可以通过“持久化本地路径”读取附件内容。',
      '生成 plan 时，如任务理解或后续执行依赖附件内容，请在计划、验收要点或任务说明中保留必要的附件路径或引用。',
      ...entries.flatMap((entry) => formatIntakeAttachmentEntry(entry)),
    ].join('\n');
  }

  async processPlan(workspace, plan) {
    const planFile = path.join(workspace, plan.file_path);
    this.syncPlanTasks(plan.id, planFile);
    const pendingTasks = this.db.all(
      `SELECT * FROM plan_tasks WHERE plan_id = ? AND status = 'pending'
       ORDER BY sort_order ASC`,
      [plan.id],
    );
    if (pendingTasks.length) {
      const firstPendingTask = pendingTasks[0];
      if (this.isFinalAcceptanceTask(plan.id, firstPendingTask)) {
        await this.validatePlan(workspace, plan, { task: firstPendingTask });
        return;
      }
      const result = await this.executeTask(workspace, plan, firstPendingTask);
      if (result.exitCode === 0) {
        this.completeTask(workspace, plan, firstPendingTask, result);
      }
      return;
    }
    if (this.hasFinalAcceptanceTask(plan.id)) {
      const currentPlan = this.db.get('SELECT status, validation_passed FROM plans WHERE id = ?', [plan.id]);
      if (currentPlan?.validation_passed || currentPlan?.status === 'completed') return;
    }
    await this.validatePlan(workspace, plan);
  }

  isFinalAcceptanceTask(planId, task) {
    if (!task) return false;
    const lastTask = this.db.get(
      'SELECT * FROM plan_tasks WHERE plan_id = ? ORDER BY sort_order DESC, id DESC LIMIT 1',
      [planId],
    );
    return Number(lastTask?.id) === Number(task.id) && isAcceptanceTask(task);
  }

  hasFinalAcceptanceTask(planId) {
    const lastTask = this.db.get(
      'SELECT * FROM plan_tasks WHERE plan_id = ? ORDER BY sort_order DESC, id DESC LIMIT 1',
      [planId],
    );
    return isAcceptanceTask(lastTask);
  }

  previousPlanCodexSessionId(planId, task) {
    if (!task) return '';
    const previousTask = this.db.get(
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

  parallelTaskBatch(tasks) {
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

  async executeTaskBatch(workspace, plan, tasks, options = {}) {
    this.setPhase(plan.project_id, 'execute-task');
    const agentContext = agentCliContextFields(this.planAgentCliConfig(plan), { defaultProvider: true });
    this.addEvent(
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
          result = await this.executeTask(workspace, plan, task, { parallel: true });
        } catch (error) {
          const finishedAt = nowIso();
          if (!taskLifecycleEventRecorded(error)) {
            this.recordTaskFailure(plan.project_id, plan, task, finishedAt, {
              error: error?.message || String(error),
            });
          }
          return { task, result: { exitCode: -1, finishedAt } };
        }
        if (result.exitCode === 0) {
          this.completeTask(workspace, plan, task, result);
        }
        return { task, result };
      }),
    );
    return results;
  }

  async executeTask(workspace, plan, task, options = {}) {
    this.setPhase(plan.project_id, 'execute-task');
    const startedAt = nowIso();
    const startedTask = this.startTaskRun(task.id, startedAt) || task;
    const taskAgentCliContext = agentCliContextFields(this.planAgentCliConfig(plan), { defaultProvider: true });
    const isTaskCodexProvider = taskAgentCliContext.agentCliProvider === DEFAULT_AGENT_CLI_PROVIDER;
    const taskSessionId = isTaskCodexProvider ? operationCodexSessionId(startedTask) : '';
    const planSessionId = isTaskCodexProvider && !options.parallel
      ? this.previousPlanCodexSessionId(plan.id, startedTask)
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
    this.addTaskLifecycleEvent(plan.project_id, TASK_EVENT_TYPES.STARTED, startedTask, {
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
      result = await this.runCodexWithPlanGuard(workspace, prompt, `execute-${task.task_key}`, {
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
      const failedTask = this.recordTaskFailure(plan.project_id, plan, task, finishedAt, {
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
    if (capturedSessionId) this.updateTaskCodexSession(task.id, capturedSessionId, finishedAt);
    const succeeded = result.exitCode === 0;
    if (!succeeded) {
      const failure = classifyExecutionFailure(result);
      this.recordTaskFailure(plan.project_id, plan, task, finishedAt, {
        ...agentCliContextFields(result, { defaultProvider: true }),
        exitCode: result.exitCode,
        log: result.logFile,
        ...failure,
        ...(result.agentCliProvider === DEFAULT_AGENT_CLI_PROVIDER ? codexSessionContextFields(result) : {}),
      });
    }
    return result;
  }

  completeTask(workspace, plan, task, result) {
    const planFile = path.join(workspace, plan.file_path);
    const finishedAt = result?.finishedAt || nowIso();
    this.markTaskCompletedInPlan(workspace, planFile, task, result);
    const completedTask = this.finishTaskRun(task.id, TASK_EVENT_STATUS.COMPLETED, finishedAt) || task;
    this.addTaskLifecycleEvent(plan.project_id, TASK_EVENT_TYPES.SUCCEEDED, completedTask, {
      ...agentCliContextFields(result, { defaultProvider: true }),
      planId: plan.id,
      status: TASK_EVENT_STATUS.COMPLETED,
      finishedAt,
      exitCode: result?.exitCode,
      log: result?.logFile,
      ...(result?.agentCliProvider === DEFAULT_AGENT_CLI_PROVIDER ? codexSessionContextFields(result) : {}),
    });
    this.refreshPlanProgress(plan.id, planFile);
    this.emitUpdate(plan.project_id);
  }

  completeAcceptanceTask(workspace, plan, task, result) {
    const planFile = path.join(workspace, plan.file_path);
    const finishedAt = result?.finishedAt || nowIso();
    this.markTaskCompletedInPlan(workspace, planFile, task, result);
    const completedTask = this.finishTaskRun(task.id, TASK_EVENT_STATUS.COMPLETED, finishedAt) || task;
    const totals = this.db.get(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed
       FROM plan_tasks
       WHERE plan_id = ?`,
      [plan.id],
    ) || { total: 0, completed: 0 };
    const hash = fs.existsSync(planFile) ? hashFile(planFile) : '';
    this.db.run(
      'UPDATE plans SET hash = ?, status = ?, total_tasks = ?, completed_tasks = ?, validation_passed = 1, updated_at = ? WHERE id = ?',
      [hash, 'completed', Number(totals.total || 0), Number(totals.completed || 0), nowIso(), plan.id],
    );
    this.addTaskLifecycleEvent(plan.project_id, TASK_EVENT_TYPES.SUCCEEDED, completedTask, {
      ...agentCliContextFields(this.planAgentCliConfig(plan), { defaultProvider: true }),
      planId: plan.id,
      status: TASK_EVENT_STATUS.COMPLETED,
      finishedAt,
      exitCode: result?.exitCode,
      log: result?.logFile,
      acceptanceTask: true,
    });
    this.emitUpdate(plan.project_id);
  }

  refreshPlanProgress(planId, planFile) {
    const totals = this.db.get(
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
    this.db.run(
      'UPDATE plans SET hash = ?, status = ?, total_tasks = ?, completed_tasks = ?, updated_at = ? WHERE id = ?',
      [hash, status, total, completed, nowIso(), planId],
    );
  }

  markTaskCompletedInPlan(workspace, planFile, task, result) {
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

  async validatePlan(workspace, plan, options = {}) {
    this.setPhase(plan.project_id, 'validate');
    const planFile = path.join(workspace, plan.file_path);
    const planAgentCliContext = agentCliContextFields(this.planAgentCliConfig(plan), { defaultProvider: true });
    const acceptanceTask = options.task || null;
    let startedAcceptanceTask = acceptanceTask;
    if (acceptanceTask) {
      const startedAt = nowIso();
      startedAcceptanceTask = this.startTaskRun(acceptanceTask.id, startedAt) || acceptanceTask;
      this.addTaskLifecycleEvent(plan.project_id, TASK_EVENT_TYPES.STARTED, startedAcceptanceTask, {
        ...planAgentCliContext,
        planId: plan.id,
        status: TASK_EVENT_STATUS.RUNNING,
        startedAt,
        acceptanceTask: true,
      });
    }
    const command = String(this.status(plan.project_id)?.validation_command || '').trim();
    if (!command) {
      // 验收命令为空：跳过校验，直接标记完成。
      const validation = { exitCode: 0, output: '', logFile: null, finishedAt: nowIso() };
      this.db.run(
        'UPDATE plans SET status = ?, validation_passed = 1, updated_at = ? WHERE id = ?',
        ['completed', validation.finishedAt, plan.id],
      );
      this.addEvent(plan.project_id, 'plan.completed', '任务全部完成（验收命令为空，已跳过校验）', {
        ...planAgentCliContext,
        planId: plan.id,
      });
      if (startedAcceptanceTask) this.completeAcceptanceTask(workspace, plan, startedAcceptanceTask, validation);
      return validation;
    }
    let validation = await this.runShell(workspace, command, `validate-${plan.id}`, { projectId: plan.project_id });
    let validationFailure = classifyExecutionFailure(validation);
    for (
      let attempt = 1;
      validation.exitCode !== 0 && attempt <= 2 && !isEnvironmentBlockingFailure(validationFailure);
      attempt += 1
    ) {
      this.db.run('UPDATE plans SET status = ?, updated_at = ? WHERE id = ?', [
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
      await this.runCodexWithPlanGuard(workspace, prompt, `repair-${plan.id}-${attempt}`, {
        projectId: plan.project_id,
        planId: plan.id,
        ...planAgentCliContext,
      }, planFile);
      validation = await this.runShell(workspace, command, `validate-${plan.id}-repair-${attempt}`, {
        projectId: plan.project_id,
      });
      validationFailure = classifyExecutionFailure(validation);
    }

    if (validation.exitCode === 0) {
      validation.finishedAt = nowIso();
      this.db.run(
        'UPDATE plans SET status = ?, validation_passed = 1, updated_at = ? WHERE id = ?',
        ['completed', validation.finishedAt, plan.id],
      );
      this.addEvent(plan.project_id, 'plan.completed', plan.file_path, { ...planAgentCliContext, planId: plan.id });
      if (startedAcceptanceTask) this.completeAcceptanceTask(workspace, plan, startedAcceptanceTask, validation);
    } else {
      validation.finishedAt = nowIso();
      this.db.run('UPDATE plans SET status = ?, updated_at = ? WHERE id = ?', [
        'validation_failed',
        validation.finishedAt,
        plan.id,
      ]);
      const eventType = isEnvironmentBlockingFailure(validationFailure) ? 'validation.blocked' : 'validation.failed';
      this.addEvent(plan.project_id, eventType, validation.logFile || validationFailure.failureSummary || command, {
        ...planAgentCliContext,
        planId: plan.id,
        exitCode: validation.exitCode,
        log: validation.logFile,
        ...validationFailure,
      });
      if (startedAcceptanceTask) {
        this.recordTaskFailure(plan.project_id, plan, startedAcceptanceTask, validation.finishedAt, {
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

  syncPlanTasks(planId, planFile) {
    if (!fs.existsSync(planFile)) return;
    normalizePlanTaskScopes(planFile);
    const text = fs.readFileSync(planFile, 'utf8');
    const regex = /^\s*[-*]\s+\[([ xX])\]\s+(.+)$/gm;
    const tasks = [];
    let match;
    let index = 0;
    while ((match = regex.exec(text))) {
      index += 1;
      const rawTitle = match[2].trim();
      const titleWithoutScope = stripTaskScopeComment(rawTitle);
      const idMatch = titleWithoutScope.match(/^([A-Za-z]+[-_]?\d+|P\d+)[:：\s-]+(.+)$/);
      tasks.push({
        key: idMatch?.[1] || `P${String(index).padStart(3, '0')}`,
        title: idMatch?.[2]?.trim() || titleWithoutScope || rawTitle,
        rawLine: ensureTaskScopeComment(match[0]),
        scope: taskScopeText({ raw_line: match[0], title: rawTitle }),
        status: match[1].toLowerCase() === 'x' ? 'completed' : 'pending',
        sortOrder: index,
      });
    }

    const existingTasks = this.db.all('SELECT * FROM plan_tasks WHERE plan_id = ? ORDER BY sort_order ASC, id ASC', [planId]);
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
        this.db.run(
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
        this.db.run(
          `INSERT INTO plan_tasks (plan_id, task_key, title, raw_line, scope, status, sort_order, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [planId, task.key, task.title, task.rawLine, task.scope, status, task.sortOrder, nowIso()],
        );
      }
    }

    for (const matches of existingByKey.values()) {
      for (const stale of matches) {
        this.db.run('DELETE FROM plan_tasks WHERE id = ?', [stale.id]);
      }
    }

    const completed = syncedStatuses.filter((status) => status === 'completed').length;
    const currentPlan = this.db.get('SELECT status, validation_passed FROM plans WHERE id = ?', [planId]);
    const status = currentPlan?.validation_passed || currentPlan?.status === 'completed'
      ? 'completed'
      : tasks.length > 0 && completed === tasks.length
        ? 'ready_for_validation'
        : 'running';
    this.db.run(
      'UPDATE plans SET hash = ?, status = ?, total_tasks = ?, completed_tasks = ?, updated_at = ? WHERE id = ?',
      [hashFile(planFile), status, tasks.length, completed, nowIso(), planId],
    );
  }

  /** 把当前 activeOperation 转存为 lastOperation（保留日志），然后清空 active */
  archiveOperation(projectId, operationKey) {
    const runtime = this.runtime(projectId);
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
        prompt,
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
      const errorMessage = timedOut ? `Shell command timed out after ${formatDurationMs(SHELL_COMMAND_TIMEOUT_MS)}` : '';
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
    this.db.run('UPDATE project_states SET phase = ?, updated_at = ? WHERE project_id = ?', [
      phase,
      nowIso(),
      projectId,
    ]);
    this.emitUpdate(projectId);
  }

  recordError(projectId, error) {
    const message = error?.stack || error?.message || String(error);
    this.db.run(
      'UPDATE project_states SET phase = ?, last_error = ?, updated_at = ? WHERE project_id = ?',
      ['error', message, nowIso(), projectId],
    );
    this.addEvent(projectId, 'loop.error', message);
    this.emitUpdate(projectId);
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
    const projects = this.projects();
    if (!projectId) return emptySnapshot(projects);

    const activeProject = this.project(projectId);
    if (!activeProject) return emptySnapshot(projects);

    const state = {
      ...(this.status(projectId) || {}),
      workspace_path: activeProject.workspace_path || '',
    };
    const runtime = this.existingRuntime(projectId);
    const taskOperationContexts = runtimeOperationContextByTask(runtime, projectId);
    const planRows = this.db.all('SELECT * FROM plans WHERE project_id = ? ORDER BY created_at DESC', [projectId]);
    const taskRows = this.db.all(
      `SELECT plan_tasks.*, plans.file_path
       FROM plan_tasks JOIN plans ON plans.id = plan_tasks.plan_id
       WHERE plans.project_id = ?
       ORDER BY plans.created_at DESC, plan_tasks.sort_order ASC`,
      [projectId],
    );
    const tasksByPlanId = groupPlanTasksByPlanId(taskRows);
    const concurrencySuggestionByPlanId = new Map(
      planRows.map((plan) => [
        Number(plan.id),
        planConcurrencySuggestion(activeProject.workspace_path, tasksByPlanId.get(Number(plan.id)) || []),
      ]),
    );
    const planSnapshots = planRows.map((plan) => planSnapshotRow(
      activeProject.workspace_path,
      plan,
      concurrencySuggestionByPlanId.get(Number(plan.id)),
      this.planSnapshotAgentCliConfig(plan),
    ));
    const planTitleById = new Map(planSnapshots.map((plan) => [Number(plan.id), plan.title || '']));

    return {
      activeProjectId: projectId,
      activeProject,
      projects,
      state,
      requirements: this.db.all(
        `SELECT requirements.*, plans.status AS plan_status,
                plans.completed_tasks AS plan_completed, plans.total_tasks AS plan_total
         FROM requirements
         LEFT JOIN plans ON plans.id = requirements.linked_plan_id
         WHERE requirements.project_id = ?
          ORDER BY requirements.updated_at DESC`,
        [projectId],
      ).map((row) => intakeSnapshotRow(row)),
      feedback: this.db.all(
        `SELECT feedback.*, plans.status AS plan_status,
                plans.completed_tasks AS plan_completed, plans.total_tasks AS plan_total
         FROM feedback
         LEFT JOIN plans ON plans.id = feedback.linked_plan_id
         WHERE feedback.project_id = ?
          ORDER BY feedback.updated_at DESC`,
        [projectId],
      ).map((row) => intakeSnapshotRow(row)),
      attachments: this.db.all(
        'SELECT * FROM attachments WHERE project_id = ? ORDER BY created_at DESC, id DESC',
        [projectId],
      ),
      plans: planSnapshots,
      tasks: taskRows
        .map((task) => taskSnapshotRow(
          activeProject.workspace_path,
          {
            ...task,
            plan_title: planTitleById.get(Number(task.plan_id)) || '',
          },
          taskOperationContexts.get(Number(task.id)),
        )),
      events: this.db
        .all('SELECT * FROM events WHERE project_id = ? ORDER BY id DESC LIMIT 80', [projectId])
        .map((event) => eventSnapshotRow(event)),
      scans: this.db.all(
        'SELECT * FROM scan_files WHERE project_id = ? ORDER BY scanned_at DESC, file_path ASC',
        [projectId],
      ),
      activeOperation:
        runtime?.activeOperation && Number(runtime.activeOperation.projectId) === Number(projectId)
          ? operationSnapshotRow(runtime.activeOperation)
          : null,
      activeOperations: runtime?.activeOperations
        ? Array.from(runtime.activeOperations.values())
            .filter((operation) => Number(operation.projectId) === Number(projectId))
            .map((operation) => operationSnapshotRow(operation))
        : [],
      lastOperation:
        runtime?.lastOperation && Number(runtime.lastOperation.projectId) === Number(projectId)
          ? runtime.lastOperation
          : null,
    };
  }
}

function taskEventMeta(task, overrides = {}) {
  const meta = {
    ...compactEventMeta({
      taskId: task?.id,
      taskKey: task?.task_key,
      taskTitle: task?.title,
      planId: task?.plan_id,
      status: task?.status,
      startedAt: task?.started_at,
      finishedAt: task?.finished_at,
      durationMs: task?.duration_ms,
      runDurationMs: task?.run_duration_ms,
    }),
    ...compactEventMeta(overrides),
  };
  Object.assign(meta, agentCliContextFields(meta));
  Object.assign(
    meta,
    meta.agentCliProvider === DEFAULT_AGENT_CLI_PROVIDER
      ? codexSessionContextFields({
          codexSessionId: meta.codexSessionId ?? meta.codex_session_id ?? meta.sessionId ?? task?.codex_session_id,
          codexSessionRequestedId: meta.codexSessionRequestedId,
          codexSessionMode: meta.codexSessionMode,
          codexSessionState: meta.codexSessionState,
          codexSessionFallback: meta.codexSessionFallback,
        })
      : {},
  );
  meta.taskId = normalizeOptionalNumber(meta.taskId);
  meta.planId = normalizeOptionalNumber(meta.planId);
  meta.taskKey = normalizeOptionalString(meta.taskKey);
  meta.taskTitle = normalizeOptionalString(meta.taskTitle);
  meta.status = normalizeOptionalString(meta.status);
  meta.startedAt = normalizeOptionalString(meta.startedAt);
  meta.finishedAt = normalizeOptionalString(meta.finishedAt);
  meta.agentCliProvider = normalizeOptionalString(meta.agentCliProvider);
  meta.agentCliCommand = normalizeOptionalString(meta.agentCliCommand);
  meta.codexReasoningEffort = meta.agentCliProvider === DEFAULT_AGENT_CLI_PROVIDER
    ? normalizeOptionalCodexReasoningEffort(meta.codexReasoningEffort)
    : undefined;
  meta.durationMs = normalizeOptionalNumber(meta.durationMs);
  meta.runDurationMs = normalizeOptionalNumber(meta.runDurationMs);
  const compacted = compactEventMeta(meta);
  return Object.keys(compacted).length ? compacted : null;
}

function taskEventMessage(type, task, meta = null) {
  const taskLabel = task?.task_key ? `${task.task_key} 任务` : task?.id ? `任务 #${task.id}` : '任务';
  const separator = taskLabel === '任务' ? '' : ' ';
  const taskTitle = normalizeOptionalString(task?.title) || '未命名任务';
  const action =
    {
      [TASK_EVENT_TYPES.STARTED]: '开始了',
      [TASK_EVENT_TYPES.SUCCEEDED]: '结束了',
      [TASK_EVENT_TYPES.FAILED]: '执行失败',
      [TASK_EVENT_TYPES.STOP_REQUESTED]: '请求停止',
      [TASK_EVENT_TYPES.STOPPED]: '停止了',
      [TASK_EVENT_TYPES.INTERRUPTED]: '中断了',
    }[type] || '更新了';
  const providerContext = meta?.agentCliProvider ? agentCliProviderDisplayName(meta.agentCliProvider) : '';
  const codexContext = meta?.agentCliProvider === DEFAULT_AGENT_CLI_PROVIDER ? codexSessionReadableLabel(meta) : '';
  const reasoningContext = meta?.agentCliProvider === DEFAULT_AGENT_CLI_PROVIDER && meta?.codexReasoningEffort
    ? `思考深度 ${meta.codexReasoningEffort}`
    : '';
  const contexts = [providerContext, reasoningContext, codexContext].filter(Boolean).join(' · ');
  return `${action}${separator}${taskLabel}：${taskTitle}${contexts ? `（${contexts}）` : ''}`;
}

function markTaskLifecycleEventRecorded(error) {
  if (!error || (typeof error !== 'object' && typeof error !== 'function')) return;
  try {
    Object.defineProperty(error, TASK_LIFECYCLE_EVENT_RECORDED, { value: true });
  } catch {
    error[TASK_LIFECYCLE_EVENT_RECORDED] = true;
  }
}

function taskLifecycleEventRecorded(error) {
  return Boolean(error && (typeof error === 'object' || typeof error === 'function') && error[TASK_LIFECYCLE_EVENT_RECORDED]);
}

function syncedTaskStatus(parsedStatus, existingStatus) {
  const next = normalizeOptionalString(parsedStatus) || TASK_EVENT_STATUS.PENDING;
  const current = normalizeOptionalString(existingStatus);
  if (!current) return next;
  if (next === TASK_EVENT_STATUS.COMPLETED || current === TASK_EVENT_STATUS.COMPLETED) return TASK_EVENT_STATUS.COMPLETED;
  if (current === TASK_EVENT_STATUS.RUNNING || current === 'blocked') return current;
  return next;
}

function compactEventMeta(meta) {
  const result = {};
  for (const [key, value] of Object.entries(meta || {})) {
    if (value !== undefined && value !== null && value !== '') result[key] = value;
  }
  return result;
}

function hasAnyOwnProperty(source, keys) {
  return keys.some((key) => Object.prototype.hasOwnProperty.call(source || {}, key));
}

function readFirstOwnValue(source, keys) {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(source || {}, key)) return source[key];
  }
  return undefined;
}

function normalizeAgentCliConfig(source = {}) {
  const provider = normalizeAgentCliProvider(readFirstOwnValue(source, AGENT_CLI_PROVIDER_COLUMNS));
  return {
    provider,
    command: normalizeAgentCliCommand(readFirstOwnValue(source, AGENT_CLI_COMMAND_COLUMNS)),
    codexReasoningEffort: provider === DEFAULT_AGENT_CLI_PROVIDER
      ? normalizeCodexReasoningEffort(readFirstOwnValue(source, CODEX_REASONING_EFFORT_COLUMNS))
      : null,
  };
}

function normalizeCodexReasoningEffort(value) {
  const effort = String(value || '').trim().toLowerCase();
  return CODEX_REASONING_EFFORTS.has(effort) ? effort : DEFAULT_CODEX_REASONING_EFFORT;
}

function normalizeOptionalCodexReasoningEffort(value) {
  if (value === undefined || value === null || value === '') return null;
  return normalizeCodexReasoningEffort(value);
}

function normalizeOptionalAgentCliProvider(value) {
  const provider = String(value ?? '').trim();
  return provider ? normalizeAgentCliProvider(provider) : null;
}

function normalizeIntakeAgentCliConfig(source = {}) {
  const provider = normalizeOptionalAgentCliProvider(
    readFirstOwnValue(source, [...AGENT_CLI_PROVIDER_INPUT_KEYS, ...AGENT_CLI_PROVIDER_COLUMNS]),
  );
  const codexReasoningEffort = provider === 'claude'
    ? null
    : normalizeOptionalCodexReasoningEffort(readFirstOwnValue(source, CODEX_REASONING_EFFORT_COLUMNS));
  return {
    provider,
    command: normalizeAgentCliCommand(readFirstOwnValue(source, [...AGENT_CLI_COMMAND_INPUT_KEYS, ...AGENT_CLI_COMMAND_COLUMNS])),
    codexReasoningEffort,
  };
}

function effectiveAgentCliConfig(defaults = {}, override = {}) {
  const defaultConfig = normalizeAgentCliConfig(defaults || {});
  const overrideConfig = normalizeIntakeAgentCliConfig(override || {});
  const provider = overrideConfig.provider || defaultConfig.provider;
  const command = overrideConfig.command || defaultConfig.command;
  const codexReasoningEffort = provider === DEFAULT_AGENT_CLI_PROVIDER
    ? overrideConfig.codexReasoningEffort || defaultConfig.codexReasoningEffort || DEFAULT_CODEX_REASONING_EFFORT
    : null;
  return { provider, command, codexReasoningEffort };
}

function hasExplicitAgentCliProvider(source = {}) {
  return Boolean(normalizeOptionalAgentCliProvider(readFirstOwnValue(source, AGENT_CLI_PROVIDER_CONTEXT_KEYS)));
}

function hasAgentCliOverride(source = {}) {
  return Boolean(
    hasExplicitAgentCliProvider(source) ||
      normalizeAgentCliCommand(readFirstOwnValue(source, AGENT_CLI_COMMAND_CONTEXT_KEYS)) ||
      normalizeOptionalCodexReasoningEffort(readFirstOwnValue(source, CODEX_REASONING_EFFORT_COLUMNS)),
  );
}

function agentCliOperationFields(config = {}) {
  return compactEventMeta({
    agentCliProvider: config.provider,
    agentCliCommand: config.command,
    codexReasoningEffort: config.provider === DEFAULT_AGENT_CLI_PROVIDER ? config.codexReasoningEffort : undefined,
  });
}

function nextIntakeAgentCliConfig(current = {}, input = {}) {
  const inputHasProvider = hasAnyOwnProperty(input, AGENT_CLI_PROVIDER_INPUT_KEYS);
  const provider = inputHasProvider
    ? normalizeAgentCliProvider(readFirstOwnValue(input, AGENT_CLI_PROVIDER_INPUT_KEYS))
    : normalizeOptionalAgentCliProvider(readFirstOwnValue(current, AGENT_CLI_PROVIDER_COLUMNS));
  const command = hasAnyOwnProperty(input, AGENT_CLI_COMMAND_INPUT_KEYS)
    ? normalizeAgentCliCommand(readFirstOwnValue(input, AGENT_CLI_COMMAND_INPUT_KEYS))
    : normalizeAgentCliCommand(readFirstOwnValue(current, AGENT_CLI_COMMAND_COLUMNS));
  const codexReasoningEffort = provider === DEFAULT_AGENT_CLI_PROVIDER || (!provider && hasAnyOwnProperty(input, CODEX_REASONING_EFFORT_COLUMNS))
    ? normalizeCodexReasoningEffort(
        hasAnyOwnProperty(input, CODEX_REASONING_EFFORT_COLUMNS)
          ? readFirstOwnValue(input, CODEX_REASONING_EFFORT_COLUMNS)
          : readFirstOwnValue(current, CODEX_REASONING_EFFORT_COLUMNS),
      )
    : null;
  return { provider, command, codexReasoningEffort };
}

function intakeSnapshotRow(row = {}) {
  const config = normalizeIntakeAgentCliConfig(row);
  return {
    ...row,
    agent_cli_provider: config.provider,
    agent_cli_command: config.command,
    codex_reasoning_effort: config.codexReasoningEffort,
  };
}

function nextAgentCliConfig(current = {}, input = {}) {
  const currentConfig = normalizeAgentCliConfig(current);
  const provider = hasAnyOwnProperty(input, AGENT_CLI_PROVIDER_INPUT_KEYS)
    ? normalizeAgentCliProvider(readFirstOwnValue(input, AGENT_CLI_PROVIDER_INPUT_KEYS))
    : currentConfig.provider;
  const command = hasAnyOwnProperty(input, AGENT_CLI_COMMAND_INPUT_KEYS)
    ? normalizeAgentCliCommand(readFirstOwnValue(input, AGENT_CLI_COMMAND_INPUT_KEYS))
    : currentConfig.command;
  const codexReasoningEffort = provider === DEFAULT_AGENT_CLI_PROVIDER
    ? normalizeCodexReasoningEffort(
        hasAnyOwnProperty(input, CODEX_REASONING_EFFORT_COLUMNS)
          ? readFirstOwnValue(input, CODEX_REASONING_EFFORT_COLUMNS)
          : currentConfig.codexReasoningEffort,
      )
    : null;
  return { provider, command, codexReasoningEffort };
}

function agentCliStateUpdates(columns, config) {
  const updates = [];
  for (const column of AGENT_CLI_PROVIDER_COLUMNS) {
    if (columns.has(column)) updates.push([column, config.provider]);
  }
  for (const column of AGENT_CLI_COMMAND_COLUMNS) {
    if (columns.has(column)) updates.push([column, config.command]);
  }
  for (const column of CODEX_REASONING_EFFORT_COLUMNS) {
    if (columns.has(column)) updates.push([column, config.codexReasoningEffort]);
  }
  return updates;
}

function planAgentCliColumnValues(columns, config) {
  const values = [];
  const fields = agentCliOperationFields(config);
  for (const column of AGENT_CLI_PROVIDER_COLUMNS) {
    if (columns.has(column)) values.push([column, fields.agentCliProvider]);
  }
  for (const column of AGENT_CLI_COMMAND_COLUMNS) {
    if (columns.has(column)) values.push([column, fields.agentCliCommand || '']);
  }
  for (const column of CODEX_REASONING_EFFORT_COLUMNS) {
    if (columns.has(column)) values.push([column, fields.codexReasoningEffort || null]);
  }
  return values;
}

function normalizeOptionalNumber(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function normalizeOptionalString(value) {
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  return text || undefined;
}

function agentCliContextFields(source = {}, options = {}) {
  const hasProvider = hasAnyOwnProperty(source, AGENT_CLI_PROVIDER_CONTEXT_KEYS);
  const rawProvider = readFirstOwnValue(source, AGENT_CLI_PROVIDER_CONTEXT_KEYS);
  const provider = hasProvider || options.defaultProvider ? normalizeAgentCliProvider(rawProvider) : undefined;
  const command = normalizeAgentCliCommand(readFirstOwnValue(source, AGENT_CLI_COMMAND_CONTEXT_KEYS));
  return compactEventMeta({
    agentCliProvider: provider,
    agentCliCommand: command,
    codexReasoningEffort: provider === DEFAULT_AGENT_CLI_PROVIDER
      ? normalizeOptionalCodexReasoningEffort(readFirstOwnValue(source, CODEX_REASONING_EFFORT_COLUMNS))
      : undefined,
  });
}

function agentCliProviderDisplayName(provider) {
  return normalizeAgentCliProvider(provider) === 'claude' ? 'Claude' : 'Codex';
}

function withTaskDurationMeta(task, runDurationMs) {
  if (!task) return null;
  return {
    ...task,
    duration_ms: normalizeDurationMs(task.duration_ms),
    ...(runDurationMs !== undefined ? { run_duration_ms: normalizeDurationMs(runDurationMs) } : {}),
  };
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

function codexSessionContextFields(source = {}) {
  const sessionId = operationCodexSessionId(source);
  const requestedSessionId = normalizeCodexSessionId(source.codexSessionRequestedId ?? source.requestedSessionId);
  const mode = normalizeCodexSessionMode(source.codexSessionMode);
  const fallback = Boolean(source.codexSessionFallback);
  const state = normalizeOptionalString(source.codexSessionState) || (fallback ? 'fallback-new' : mode);
  const label = codexSessionReadableLabel({
    codexSessionId: sessionId,
    codexSessionRequestedId: requestedSessionId,
    codexSessionMode: mode,
    codexSessionState: state,
    codexSessionFallback: fallback,
  });
  return compactEventMeta({
    codexSessionId: sessionId || undefined,
    codexSessionShortId: sessionId ? shortCodexSessionId(sessionId) : undefined,
    codexSessionMode: mode || undefined,
    codexSessionState: state || undefined,
    codexSessionLabel: label || undefined,
    codexSessionRequestedId: requestedSessionId || undefined,
    codexSessionRequestedShortId: requestedSessionId ? shortCodexSessionId(requestedSessionId) : undefined,
    codexSessionFallback: fallback || undefined,
  });
}

function clearCodexSessionFields(operation) {
  for (const key of [
    'codexSessionId',
    'sessionId',
    'codex_session_id',
    'codexSessionRequestedId',
    'requestedSessionId',
    'codexSessionMode',
    'codexSessionState',
    'codexSessionFallback',
  ]) {
    delete operation[key];
  }
}

function normalizeCodexSessionMode(mode) {
  const normalized = normalizeOptionalString(mode);
  if (normalized === 'new' || normalized === 'resume') return normalized;
  return undefined;
}

function codexSessionReadableLabel(source = {}) {
  const explicit = normalizeOptionalString(source.codexSessionLabel);
  if (explicit) return explicit;
  const sessionId = operationCodexSessionId(source);
  const requestedSessionId = normalizeCodexSessionId(source.codexSessionRequestedId ?? source.requestedSessionId);
  const sessionShortId = sessionId ? shortCodexSessionId(sessionId) : '';
  const requestedShortId = requestedSessionId ? shortCodexSessionId(requestedSessionId) : '';
  const mode = normalizeCodexSessionMode(source.codexSessionMode);
  const state = normalizeOptionalString(source.codexSessionState);
  if (state === 'fallback-new' || source.codexSessionFallback) {
    if (sessionShortId && requestedShortId) return `回退新建会话 ${sessionShortId}（原 ${requestedShortId}）`;
    if (sessionShortId) return `回退新建会话 ${sessionShortId}`;
    return requestedShortId ? `回退新建会话（原 ${requestedShortId}）` : '回退新建会话';
  }
  if (mode === 'resume') return sessionShortId ? `恢复会话 ${sessionShortId}` : '恢复会话';
  if (mode === 'new') return sessionShortId ? `新建会话 ${sessionShortId}` : '新建会话';
  return sessionShortId ? `会话 ${sessionShortId}` : '';
}

function taskSnapshotRow(workspace, task, operationContext = null) {
  if (!task) return task;
  const startedAt = normalizeOptionalString(task.started_at) || null;
  const finishedAt = normalizeOptionalString(task.finished_at) || null;
  const isRunning = task.status === TASK_EVENT_STATUS.RUNNING;
  const runDurationMs = isRunning ? taskRunDurationMs(startedAt, nowIso()) : undefined;
  const agentContext = agentCliContextFields(operationContext || {}, { defaultProvider: false });
  const providerForSession = agentContext.agentCliProvider || (task.codex_session_id ? DEFAULT_AGENT_CLI_PROVIDER : undefined);
  const sessionContext = providerForSession !== DEFAULT_AGENT_CLI_PROVIDER
    ? {}
    : codexSessionContextFields({
        codexSessionId: operationContext?.codexSessionId ?? task.codex_session_id,
        codexSessionRequestedId: operationContext?.codexSessionRequestedId,
        codexSessionMode: operationContext?.codexSessionMode,
        codexSessionState: operationContext?.codexSessionState,
        codexSessionFallback: operationContext?.codexSessionFallback,
      });
  return {
    ...task,
    scope_files: taskScopeFileInfos(workspace, task),
    started_at: startedAt,
    finished_at: finishedAt,
    duration_ms: normalizeDurationMs(task.duration_ms),
    ...(runDurationMs !== undefined ? { run_duration_ms: normalizeDurationMs(runDurationMs) } : {}),
    ...agentContext,
    ...sessionContext,
  };
}

function normalizeDurationMs(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return Math.round(number);
}

function taskRunDurationMs(startedAt, finishedAt) {
  const started = Date.parse(startedAt || '');
  const finished = Date.parse(finishedAt || '');
  if (!Number.isFinite(started) || !Number.isFinite(finished) || finished <= started) return 0;
  return Math.round(finished - started);
}

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

function emptySnapshot(projects) {
  return {
    activeProjectId: null,
    activeProject: null,
    projects,
    state: null,
    requirements: [],
    feedback: [],
    attachments: [],
    plans: [],
    tasks: [],
    events: [],
    scans: [],
    activeOperation: null,
    activeOperations: [],
    lastOperation: null,
  };
}

function eventSnapshotRow(event) {
  if (!event) return event;
  return {
    ...event,
    meta: parseEventMeta(event.meta),
  };
}

function parseEventMeta(meta) {
  if (!meta) return null;
  if (typeof meta !== 'string') return meta;
  try {
    const parsed = JSON.parse(meta);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    if (typeof parsed === 'string') return parsed;
  } catch {
    return meta;
  }
  return meta;
}

function planSnapshotRow(workspace, plan, concurrencySuggestion = null, agentCliConfig = null) {
  if (!plan) return plan;
  const planAgentCliConfig = agentCliConfig || effectiveAgentCliConfig({}, plan);
  return {
    ...plan,
    agent_cli_provider: planAgentCliConfig.provider,
    agent_cli_command: planAgentCliConfig.command,
    codex_reasoning_effort: planAgentCliConfig.codexReasoningEffort,
    title: readPlanMarkdownTitle(workspace, plan.file_path),
    concurrency_suggestion: concurrencySuggestion || emptyConcurrencySuggestion(),
  };
}

function groupPlanTasksByPlanId(tasks) {
  const grouped = new Map();
  for (const task of tasks) {
    const planId = Number(task?.plan_id);
    if (!Number.isFinite(planId)) continue;
    const planTasks = grouped.get(planId) || [];
    planTasks.push(task);
    grouped.set(planId, planTasks);
  }
  return grouped;
}

function readPlanMarkdownTitle(workspace, filePath) {
  const planPath = resolveWorkspaceChildPath(workspace, filePath);
  if (!planPath) return '';

  try {
    const markdown = readSnippet(planPath, 64 * 1024);
    return extractMarkdownTitle(markdown);
  } catch {
    return '';
  }
}

function resolveWorkspaceChildPath(workspace, filePath) {
  const workspaceValue = String(workspace || '').trim();
  const filePathValue = String(filePath || '').trim();
  if (!workspaceValue || !filePathValue) return '';

  const workspaceRoot = path.resolve(workspaceValue);
  const requestedPath = path.resolve(workspaceRoot, filePathValue);
  const relativePath = path.relative(workspaceRoot, requestedPath);
  if (relativePath === '' || (!!relativePath && !relativePath.startsWith('..') && !path.isAbsolute(relativePath))) {
    return requestedPath;
  }
  return '';
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

function workspaceToolEnv(workspace, baseEnv = process.env) {
  const root = path.join(path.resolve(workspace), WORKSPACE_RUNTIME_DIR);
  const dirs = {
    pubCache: path.join(root, 'pub-cache'),
    gradleHome: path.join(root, 'gradle'),
    xdgCache: path.join(root, 'xdg-cache'),
    xdgConfig: path.join(root, 'xdg-config'),
    appData: path.join(root, 'appdata'),
    localAppData: path.join(root, 'localappdata'),
  };
  for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true });

  const env = {
    ...baseEnv,
    AUTOPLAN_RUNTIME_ROOT: root,
    PUB_CACHE: dirs.pubCache,
    FLUTTER_SUPPRESS_ANALYTICS: 'true',
    CI: baseEnv.CI || 'true',
    GRADLE_USER_HOME: baseEnv.GRADLE_USER_HOME || dirs.gradleHome,
    XDG_CACHE_HOME: baseEnv.XDG_CACHE_HOME || dirs.xdgCache,
    XDG_CONFIG_HOME: baseEnv.XDG_CONFIG_HOME || dirs.xdgConfig,
  };
  if (!env.APPDATA) env.APPDATA = dirs.appData;
  if (!env.LOCALAPPDATA) env.LOCALAPPDATA = dirs.localAppData;
  return env;
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

function hasCodexSessionOption(operation = {}) {
  return ['codexSessionId', 'sessionId', 'codex_session_id'].some((key) => Object.prototype.hasOwnProperty.call(operation, key));
}

function operationCodexSessionId(operation = {}) {
  return normalizeCodexSessionId(operation.codexSessionId ?? operation.sessionId ?? operation.codex_session_id);
}

function normalizeCodexSessionId(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function extractCodexSessionId(text) {
  if (!text) return '';
  const source = String(text);
  for (const re of CODEX_SESSION_ID_RES) {
    const match = source.match(re);
    if (match?.[1]) return match[1];
  }
  return '';
}

function isCodexResumeFailure(output) {
  return CODEX_RESUME_FAILURE_RE.test(String(output || ''));
}

function shortCodexSessionId(sessionId) {
  const normalized = normalizeCodexSessionId(sessionId);
  if (normalized.length <= 13) return normalized || 'unknown';
  return `${normalized.slice(0, 8)}…${normalized.slice(-4)}`;
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

function hashFile(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function hashText(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
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

function isAcceptanceTask(task) {
  if (!task) return false;
  const text = `${task.task_key || task.key || ''} ${task.title || ''} ${task.raw_line || task.rawLine || ''}`;
  return ACCEPTANCE_TASK_RE.test(text);
}

function taskScopeFileInfos(workspace, task) {
  const scopes = taskDeclaredScopes(task, { keepUnknown: true, includePathFallback: false });
  if (!scopes.length) return [taskScopeFileInfo(workspace, 'unknown')];
  return scopes.map((scope) => taskScopeFileInfo(workspace, scope));
}

function taskScopeFileInfo(workspace, scope) {
  const normalizedPath = normalizeTaskScope(scope, { keepUnknown: true });
  const special = SPECIAL_TASK_SCOPES.has(normalizedPath) ? normalizedPath : '';
  const result = {
    path: normalizedPath || 'unknown',
    exists: false,
    isDirectory: false,
    canOpen: false,
    isUnknown: special === 'unknown' || !normalizedPath,
    isValidation: special === 'validation',
    reason: '',
  };
  if (result.isUnknown) {
    result.reason = 'scope unknown，无法安全判断影响范围';
    return result;
  }
  if (result.isValidation) {
    result.reason = 'validation 任务需串行验收，不建议并发';
    return result;
  }
  const fullPath = resolveWorkspaceChildPath(workspace, normalizedPath);
  if (!fullPath) {
    result.reason = '路径不在工作区内，不能打开';
    return result;
  }
  try {
    const stat = fs.existsSync(fullPath) ? fs.statSync(fullPath) : null;
    result.exists = Boolean(stat);
    result.isDirectory = Boolean(stat?.isDirectory());
    result.canOpen = Boolean(stat?.isFile());
    result.reason = result.canOpen
      ? ''
      : result.isDirectory
        ? 'scope 指向目录，不能作为文件打开'
        : '文件不存在，后续任务可能会创建';
  } catch (error) {
    result.reason = error?.message || '无法读取文件状态';
  }
  return result;
}

function planConcurrencySuggestion(workspace, tasks) {
  const candidates = [];
  const serialTasks = [];
  for (const task of tasks) {
    if (task.status !== TASK_EVENT_STATUS.PENDING) continue;
    const analysis = taskConcurrencyAnalysis(workspace, task);
    if (analysis.canRunInParallel) {
      candidates.push({ task, analysis });
    } else {
      serialTasks.push(concurrencyTaskSummary(task, analysis.reason, analysis.scopes));
    }
  }

  const batches = [];
  for (const entry of candidates) {
    let placed = false;
    for (const batch of batches) {
      if (batch.tasks.length >= MAX_PARALLEL_TASKS) continue;
      if (entry.analysis.scopes.some((scope) => batch.scopeSet.has(scope))) continue;
      batch.tasks.push(concurrencyTaskSummary(entry.task, 'scope 无交集，可与本批任务并发', entry.analysis.scopes));
      for (const scope of entry.analysis.scopes) batch.scopeSet.add(scope);
      placed = true;
      break;
    }
    if (!placed) {
      batches.push({
        reason: '批次内任务 scope 互不重叠，可安全并发',
        scopeSet: new Set(entry.analysis.scopes),
        tasks: [concurrencyTaskSummary(entry.task, 'scope 无交集，可与本批任务并发', entry.analysis.scopes)],
      });
    }
  }

  const safeBatches = batches
    .filter((batch) => batch.tasks.length > 1)
    .map((batch, index) => ({
      batch: index + 1,
      reason: batch.reason,
      tasks: batch.tasks,
    }));
  const singleCandidateTasks = batches
    .filter((batch) => batch.tasks.length <= 1)
    .flatMap((batch) => batch.tasks)
    .map((task) => ({ ...task, reason: '没有可配对的无冲突任务，建议串行执行' }));

  return {
    hasSafeParallelBatches: safeBatches.length > 0,
    parallelTaskCount: safeBatches.reduce((sum, batch) => sum + batch.tasks.length, 0),
    batchCount: safeBatches.length,
    serialTaskCount: serialTasks.length + singleCandidateTasks.length,
    maxParallelTasks: MAX_PARALLEL_TASKS,
    batches: safeBatches,
    serialTasks: [...serialTasks, ...singleCandidateTasks],
  };
}

function taskConcurrencyAnalysis(workspace, task) {
  const scopeFiles = taskScopeFileInfos(workspace, task);
  const scopes = scopeFiles
    .filter((file) => !file.isUnknown && !file.isValidation)
    .map((file) => file.path);
  if (isAcceptanceTask(task) || scopeFiles.some((file) => file.isValidation)) {
    return { canRunInParallel: false, scopes, reason: 'validation/验收任务必须串行执行' };
  }
  if (scopeFiles.some((file) => file.isUnknown)) {
    return { canRunInParallel: false, scopes, reason: 'scope unknown，无法判断冲突' };
  }
  if (!scopes.length) {
    return { canRunInParallel: false, scopes, reason: 'scope 为空或无法解析，无法判断冲突' };
  }
  if (PARALLEL_BLOCKING_TASK_RE.test(`${task.task_key || ''} ${task.title || ''} ${task.raw_line || ''}`)) {
    return { canRunInParallel: false, scopes, reason: '任务标题包含测试/验收/发布等串行关键词' };
  }
  return { canRunInParallel: true, scopes, reason: 'scope 明确且可用于冲突检测' };
}

function concurrencyTaskSummary(task, reason, scopes = []) {
  return {
    id: task.id,
    task_key: task.task_key,
    title: task.title,
    status: task.status,
    scopes: Array.from(new Set(scopes)),
    reason,
  };
}

function emptyConcurrencySuggestion() {
  return {
    hasSafeParallelBatches: false,
    parallelTaskCount: 0,
    batchCount: 0,
    serialTaskCount: 0,
    maxParallelTasks: MAX_PARALLEL_TASKS,
    batches: [],
    serialTasks: [],
  };
}

function normalizeConfirmedTaskBatches(value) {
  if (!Array.isArray(value)) return [];
  const batches = [];
  for (const batch of value) {
    const rawTaskIds = Array.isArray(batch)
      ? batch
      : Array.isArray(batch?.taskIds)
        ? batch.taskIds
        : Array.isArray(batch?.tasks)
          ? batch.tasks.map((task) => task?.id ?? task)
          : [];
    const taskIds = Array.from(new Set(rawTaskIds.map((taskId) => Number(taskId)).filter(Boolean)));
    if (taskIds.length) batches.push(taskIds);
  }
  return batches;
}

function taskParallelScopes(task) {
  const raw = `${task.task_key || ''} ${task.title || ''} ${task.raw_line || ''}`;
  if (PARALLEL_BLOCKING_TASK_RE.test(raw)) return [];
  return taskDeclaredScopes(task, { keepUnknown: false });
}

function taskScopeText(task) {
  const explicit = taskDeclaredScopes(task, { keepUnknown: true, includePathFallback: false });
  if (explicit.length) return explicit.join(', ');
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
  const next = content.replace(/^(\s*[-*]\s+\[[ xX]\]\s+.+)$/gm, (line) => {
    if (TASK_SCOPE_RE.test(line)) return line;
    changed = true;
    return ensureTaskScopeComment(line);
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

function normalizeRelative(root, fullPath) {
  return path.relative(root, fullPath).replaceAll(path.sep, '/');
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function workspaceKey(workspace) {
  const value = String(workspace || '').trim();
  if (!value) return '';
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function timestampForPath() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(
    now.getHours(),
  )}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function readSnippet(filePath, maxChars) {
  const text = fs.readFileSync(filePath, 'utf8');
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n...[truncated]` : text;
}

function tailText(text, maxChars) {
  return text.length > maxChars ? text.slice(text.length - maxChars) : text;
}

function safePart(value) {
  return String(value).replace(/[^A-Za-z0-9_.-]+/g, '_');
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
