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
  AGENT_CLI_COMMAND_INPUT_KEYS,
  AGENT_CLI_PROVIDER_INPUT_KEYS,
  CODEX_REASONING_EFFORT_COLUMNS,
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
  operationSnapshotRow,
  recordRuntimeError,
  registerRuntimeOperation,
  resetStoredRuntimeState,
  runtimeOperationContextByTask,
  runtimeProjectSummary,
  scheduleProjectRuntime,
  setProjectPhase,
  stopRuntimePlanOperations,
  stopProjectRuntime,
  stopRuntimeTask,
  waitForChild,
} = require('./loop/runtime');
const planGeneration = require('./loop/planGeneration');
const {
  AUTOPLAN_OPENCODE_PLAN_AGENT,
  ensureOpenCodePlanAgent,
} = require('./loop/opencodeAgent');
const planParser = require('./loop/planParser');
const planTaskSync = require('./loop/planTaskSync');
const snapshots = require('./loop/snapshots');
const concurrency = require('./loop/concurrency');
const workspaceFiles = require('./loop/workspaceFiles');
const intakeAttachments = require('./loop/intakeAttachments');
const { isAcceptanceTask } = concurrency;
const {
  hashFile,
  hashText,
  normalizeEnvVarsJson,
  normalizeRelative,
  readSnippet,
  resolveSafePlanMarkdownPath,
  resolveSafePlanManifestPath,
  safePart,
  tailText,
  timestampForPath,
  workspaceKey,
  workspaceToolEnv,
} = workspaceFiles;
const acceptance = require('./loop/acceptance');
const agentCliRunner = require('./loop/agentCliRunner');
const intakeDeletion = require('./loop/intakeDeletion');
const planAgentCli = require('./loop/planAgentCli');
const planBackendConfig = require('./loop/planBackendConfig');
const { resolveDefaultClaudeCliConfig } = require('./chat/claudeCliConfigService');
const planLifecycle = require('./loop/planLifecycle');
const taskExecution = require('./loop/taskExecution');
const validationFlow = require('./loop/validation');
const { classifyExecutionFailure } = validationFlow;
const scriptHooks = require('./loop/scriptHooks');
const executorRunner = require('./executors/executorRunner');
const { getExecutor } = require('./executors/executorStore');
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
const {
  planGenerationGuardedPrompt,
  opencodePlanSessionTitle,
  isOpenCodeSessionMissing,
  requestedAgentCliSessionId,
  agentCliSessionContextFields,
  agentCliSessionStateFor,
  isClaudeSessionMissing,
  agentCliResultSessionContextFields,
  CLAUDE_SESSION_INPUT_KEYS,
} = agentCliRunner;

const INTAKE_RETRY_AGENT_CLI_INPUT_KEYS = Object.freeze([
  ...AGENT_CLI_PROVIDER_INPUT_KEYS,
  ...AGENT_CLI_COMMAND_INPUT_KEYS,
  ...CODEX_REASONING_EFFORT_COLUMNS,
]);
const LEGACY_AGENT_CLI_CONFIG_INPUT_KEYS = Object.freeze([
  ...AGENT_CLI_PROVIDER_INPUT_KEYS,
  ...AGENT_CLI_COMMAND_INPUT_KEYS,
  ...CODEX_REASONING_EFFORT_COLUMNS,
]);
const PLAN_GENERATION_CONFIG_INPUT_KEYS = Object.freeze([
  ...planBackendConfig.PLAN_GENERATION_STRATEGY_KEYS,
  ...planBackendConfig.PLAN_GENERATION_PROVIDER_KEYS,
  ...planBackendConfig.PLAN_GENERATION_COMMAND_KEYS,
  ...planBackendConfig.PLAN_GENERATION_MODEL_KEYS,
  ...planBackendConfig.PLAN_GENERATION_CODEX_REASONING_EFFORT_KEYS,
]);
const PLAN_EXECUTION_CONFIG_INPUT_KEYS = Object.freeze([
  ...planBackendConfig.PLAN_EXECUTION_STRATEGY_KEYS,
  ...planBackendConfig.PLAN_EXECUTION_PROVIDER_KEYS,
  ...planBackendConfig.PLAN_EXECUTION_COMMAND_KEYS,
  ...planBackendConfig.PLAN_EXECUTION_MODEL_KEYS,
  ...planBackendConfig.PLAN_EXECUTION_CODEX_REASONING_EFFORT_KEYS,
]);
const PROJECT_PROMPT_INPUT_KEYS = Object.freeze(['projectPrompt', 'project_prompt']);
// 判定 runCodex 的本次调用是否为「OpenCode 计划生成」操作（区别于任务执行/修复）。
// 仅在计划生成阶段注入 AutoPlan 专用受限 agent（P002），任务执行/修复复用既有 session 行为不变。
// 判据与 src/loop/planGeneration.js 的调用方一致：label 为 generate-plan（issue-scan 走查计划）、
// 或以 gen-requirement- / gen-feedback- 开头（需求/反馈计划），或 operation 携带 intakeType。
function isOpenCodePlanGenerationOperation(label, operation = {}) {
  if (operation && operation.intakeType) return true;
  const text = typeof label === 'string' ? label : '';
  if (!text) return false;
  if (text === 'generate-plan') return true;
  if (text.startsWith('gen-requirement-') || text.startsWith('gen-feedback-')) return true;
  return false;
}

class LoopService extends EventEmitter {
  constructor(db) {
    super();
    this.db = db;
    this.runtimes = new Map();
    // 由 main.js 在持有 mcpServer 句柄后注入：返回 mcpServer?.status?.()，供快照叠加实时运行态。
    this.mcpStatusProvider = null;
    // 由终端模块注入轻量会话元数据读取函数；未注入时快照降级为空列表。
    this.terminalMetadataProvider = null;
    this.hookOperationContext = new AsyncLocalStorage();
    // 全局定时调度器句柄（setInterval，60s，unref 不阻塞进程退出）：由 main.js 创建 loop 后调
    // startScheduler、will-quit 调 stopScheduler 启停；独立于循环运行态。
    this.scheduleTimer = null;
    this.updateEmitter = createThrottledUpdateEmitter({
      snapshot: (projectId) => this.snapshot(projectId),
      patch: (projectId) => this.snapshotPatch(projectId),
      emit: (snapshot) => this.emit('update', snapshot),
      emitPatch: (patch) => this.emit('patch', patch),
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
    return hasAnyOwnProperty(input, LOOP_CONFIG_INPUT_KEYS) || hasProjectPromptInput(input);
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
    const projectStateColumns = this.projectStateColumns();
    const planExecutionConfig = nextPlanExecutionConfig(current, config);
    const stateUpdates = [
      ['interval_seconds', nextInterval],
      ['validation_command', nextValidationCommand],
      ...agentCliStateUpdates(projectStateColumns, agentCliConfig),
      ...planGenerationStateUpdates(projectStateColumns, current, config),
      ...(planExecutionConfig ? planBackendStateUpdates(projectStateColumns, 'plan_execution', planExecutionConfig) : []),
      ['updated_at', nowIso()],
    ];
    if (hasProjectPromptInput(config) && projectStateColumns.has('project_prompt')) {
      stateUpdates.splice(stateUpdates.length - 1, 0, [
        'project_prompt',
        String(readFirstOwnValue(config, PROJECT_PROMPT_INPUT_KEYS) ?? ''),
      ]);
    }
    if (Array.isArray(config.envVars) && projectStateColumns.has('env_vars')) {
      stateUpdates.splice(stateUpdates.length - 1, 0, ['env_vars', normalizeEnvVarsJson(config.envVars)]);
    }
    this.db.run(
      `UPDATE project_states
       SET ${stateUpdates.map(([column]) => `${column} = ?`).join(', ')}
       WHERE project_id = ?`,
      [...stateUpdates.map(([, value]) => value), projectId],
    );
    if (planExecutionConfig) {
      planLifecycle.syncUnfinishedPlanExecutionCodexReasoningEffort(this, projectId, planExecutionConfig);
    }
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
    const cycleSummary = { stage: 'loop:end', pendingIntakes: 0, generatedPlanId: null, generatedPlanIds: [] };
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
             AND NOT EXISTS (
               SELECT 1 FROM intake_plan_links links
               WHERE links.project_id = requirements.project_id
                 AND links.intake_type = 'requirement'
                 AND links.intake_id = requirements.id
             )
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
             AND NOT EXISTS (
               SELECT 1 FROM intake_plan_links links
               WHERE links.project_id = feedback.project_id
                 AND links.intake_type = 'feedback'
                 AND links.intake_id = feedback.id
             )
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
      let generatedPlanIds = [];
      if (pendingIntakes.length > 0) {
        const generatedPlanResult = await this.generatePlanForIntake(projectId, workspace, pendingIntakes[0]);
        generatedPlanIds = normalizeGeneratedPlanIds(generatedPlanResult);
        const linkedPlanIds = this.linkedPlansForIntake(
          projectId,
          pendingIntakes[0].__type,
          pendingIntakes[0].id,
        ).map((link) => Number(link.planId));
        if (
          linkedPlanIds.length > generatedPlanIds.length ||
          (generatedPlanIds.length > 0 && linkedPlanIds.includes(generatedPlanIds[0]))
        ) {
          generatedPlanIds = linkedPlanIds;
        }
        generatedPlanId = generatedPlanIds[0] || null;
      }
      cycleSummary.generatedPlanId = generatedPlanId;
      cycleSummary.generatedPlanIds = generatedPlanIds;

      // 同步 docs/plan 目录下的 plan 文件（兼容文件式需求）
      const planScan = await this.scanDirectoryInWorker(path.join(workspace, 'docs', 'plan'), workspace, ['.md']);
      if (startedFromRunningLoop && !runtime.running) return;
      this.saveScan(projectId, 'plan', planScan);

      // 执行队列里可运行的 plan：新生成的计划只入队，不抢占更早的未完成计划。
      const nextPlan = this.nextRunnablePlan(projectId);
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
    const executorId = Number(operation.executorId || 0);
    if (executorId && !this.db.get('SELECT id FROM executors WHERE id = ? AND project_id = ?', [executorId, projectId])) {
      return false;
    }
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

  clearTaskAgentCliSessions(taskId, updatedAt = nowIso()) {
    if (!taskId) return null;
    this.db.run(
      `UPDATE plan_tasks
       SET codex_session_id = NULL,
           agent_cli_session_id = NULL,
           updated_at = ?
       WHERE id = ?`,
      [updatedAt, taskId],
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
    this.addEvent(projectId, type, taskEventMessage(type, task, meta), meta, { lightweight: true });
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
    return planLifecycle.interruptPlan(this, projectId, planId);
  }

  stopPlan(projectId, planId) {
    return planLifecycle.stopPlan(this, projectId, planId);
  }

  deleteIntake(projectId, intakeType, intakeId, options) {
    return intakeDeletion.deleteIntake(this, projectId, intakeType, intakeId, options);
  }

  deletePlan(projectId, planId, options) {
    return intakeDeletion.deletePlan(this, projectId, planId, options);
  }

  deleteAttachmentFiles(attachments, attachmentsRoot) {
    return intakeDeletion.deleteAttachmentFiles(attachments, attachmentsRoot);
  }

  safeAutoPlanIntakePlanFileDeleteTarget(project, plan, intakeType, intakeId) {
    return intakeDeletion.safeAutoPlanIntakePlanFileDeleteTarget(project, plan, intakeType, intakeId);
  }

  safePlanFileDeleteTarget(project, plan) {
    return intakeDeletion.safePlanFileDeleteTarget(project, plan);
  }

  recordPlanFileDeleteSkipped(plan, result) {
    return intakeDeletion.recordPlanFileDeleteSkipped(this, plan, result);
  }

  deleteResolvedPlanFile(plan, result) {
    return intakeDeletion.deleteResolvedPlanFile(this, plan, result);
  }

  /** 恢复被中断的 plan：blocked → pending，plan → pending，循环运行时自动继续执行 */
  resumePlan(projectId, planId) {
    return planLifecycle.resumePlan(this, projectId, planId);
  }

  /** 更新中断/停止状态下的计划执行配置（provider/command 等），用于 CLI 工具切换。 */
  updatePlanExecutionConfig(projectId, planId, input) {
    return planLifecycle.updatePlanExecutionConfig(this, projectId, planId, input);
  }

  /** 重新激活已完成的计划：重置所有 completed 任务为 pending，清空 validation_passed，重新加入执行队列。 */
  reExecutePlan(projectId, planId) {
    return planLifecycle.reExecutePlan(this, projectId, planId);
  }

  /** 基于已完成计划的关联需求/反馈重新生成计划：旧计划保持不变，新计划作为独立条目入库。 */
  async recreatePlanFromIntake(projectId, planId) {
    return planLifecycle.recreatePlanFromIntake(this, projectId, planId);
  }

  linkedPlansForIntake(projectId, intakeType, intakeId) {
    return planLifecycle.linkedPlansForIntake(this, projectId, intakeType, intakeId);
  }

  interruptIntakePlans(projectId, intakeType, intakeId) {
    return planLifecycle.interruptPlansForIntake(this, projectId, intakeType, intakeId);
  }

  resumeIntakePlans(projectId, intakeType, intakeId) {
    return planLifecycle.resumePlansForIntake(this, projectId, intakeType, intakeId);
  }

  appendTaskToIntakePlan(projectId, intakeType, intakeId, title) {
    return planLifecycle.appendTaskToIntakePlan(this, projectId, intakeType, intakeId, title);
  }

  async retryIntakePlanGeneration(projectId, intakeType, intakeId, input = {}) {
    const normalizedProjectId = Number(projectId || 0);
    const normalizedIntakeId = Number(intakeId || 0);
    if (!normalizedProjectId || !this.project(normalizedProjectId)) throw new Error('项目不存在');
    if (!normalizedIntakeId) throw new Error('记录不存在');

    const normalizedType = normalizeLoopIntakeType(intakeType);
    const table = intakeTableForLoopType(normalizedType);
    const sourceName = normalizedType === 'feedback' ? '反馈' : '需求';
    const intake = this.db.get(`SELECT * FROM ${table} WHERE id = ? AND project_id = ?`, [
      normalizedIntakeId,
      normalizedProjectId,
    ]);
    if (!intake) throw new Error(`${sourceName}不存在`);

    const status = String(intake.status || 'open').trim().toLowerCase();
    if (status === 'closed' || status === 'completed') {
      throw new Error(`${sourceName}已关闭或已完成，不能重试生成计划`);
    }
    if (normalizePositiveInteger(intake.linked_plan_id)) {
      throw new Error(`${sourceName}已绑定 Plan，不能重复生成`);
    }
    const linkedPlans = this.linkedPlansForIntake(normalizedProjectId, normalizedType, normalizedIntakeId);
    if (linkedPlans.length > 0) throw new Error(`${sourceName}已绑定 Plan，不能重复生成`);

    const hasCliInput = hasAnyOwnProperty(input, INTAKE_RETRY_AGENT_CLI_INPUT_KEYS);
    const projectStatus = this.status(normalizedProjectId) || {};
    const planGenerationConfig = nextIntakePlanGenerationConfig(projectStatus, { ...intake, ...input });
    const agentCliConfig = hasCliInput
      ? nextIntakeAgentCliConfig(intake, input)
      : normalizeIntakeAgentCliConfig(intake);
    const updatedAt = nowIso();
    this.db.run(
      `UPDATE ${table}
          SET agent_cli_provider = ?,
              agent_cli_command = ?,
              codex_reasoning_effort = ?,
              plan_generation_strategy = ?,
              plan_generation_provider = ?,
              plan_generation_command = ?,
              plan_generation_model = ?,
              plan_generation_codex_reasoning_effort = ?,
              generate_fail_count = 0,
              last_generate_fail_at = NULL,
              last_generate_error = NULL,
              last_generate_log_file = NULL,
              last_generate_agent_cli_provider = NULL,
              last_generate_codex_reasoning_effort = NULL,
              updated_at = ?
        WHERE id = ? AND project_id = ?`,
      [
        agentCliConfig.provider,
        agentCliConfig.command,
        agentCliConfig.codexReasoningEffort,
        planGenerationConfig.strategy,
        planGenerationConfig.provider,
        planGenerationConfig.command,
        planGenerationConfig.model,
        planGenerationConfig.codexReasoningEffort,
        updatedAt,
        normalizedIntakeId,
        normalizedProjectId,
      ],
    );

    const runtime = this.runtime(normalizedProjectId);
    this.addEvent(
      normalizedProjectId,
      'plan.generate.retry.requested',
      `已请求重试生成${sourceName} #${normalizedIntakeId} 计划`,
      {
        intakeType: normalizedType,
        intakeId: normalizedIntakeId,
        agentCliProvider: agentCliConfig.provider,
        agentCliCommand: agentCliConfig.command,
        codexReasoningEffort: agentCliConfig.codexReasoningEffort,
        planGenerationStrategy: planGenerationConfig.strategy,
        planGenerationProvider: planGenerationConfig.provider,
        planGenerationCommand: planGenerationConfig.command,
        planGenerationModel: planGenerationConfig.model,
        planGenerationCodexReasoningEffort: planGenerationConfig.codexReasoningEffort,
        runtimeBusy: Boolean(runtime?.busy),
        running: Boolean(runtime?.running),
      },
    );
    await this.runOnce(normalizedProjectId);
    return this.snapshot(normalizedProjectId);
  }

  /** 人工验收：对已完成的计划/任务置 accepted_at（不改变执行态 status），并记事件；重复验收刷新时间不报错。 */
  acceptItem(projectId, target) {
    return acceptance.acceptItem(this, projectId, target);
  }

  /** 取消人工验收：清空 accepted_at（NULL），不改变执行态 status，并记事件；重复取消保持 NULL 不报错。 */
  unacceptItem(projectId, target) {
    return acceptance.unacceptItem(this, projectId, target);
  }

  /** 验收重做：清空人工验收态，将已完成/已验收目标退回 pending，并记录 redo 事件。 */
  redoAcceptanceItem(projectId, target) {
    return acceptance.redoAcceptanceItem(this, projectId, target);
  }

  /** 校验收目标：按 targetType 路由 plan/task、校验归属当前项目与「已完成」态；不存在或不可验收时抛中文错误。 */
  acceptanceTargetRow(projectId, targetType, id, options) {
    return acceptance.acceptanceTargetRow(this, projectId, targetType, id, options);
  }

  /**
   * 写入单条验收态的私有 helper（acceptItem/unacceptItem 与 acceptItems/unacceptItems 共用）。
   * 只置/清 accepted_at 并记事件，绝不执行脚本或任务——验收模块是纯人工确认，与
   * 「完整验收」任务经 runTask→validatePlan 执行 validation_command 的链路完全解耦。
   */
  writeAcceptance(targetType, row, acceptedAt, projectId, updatedAt) {
    return acceptance.writeAcceptance(this, targetType, row, acceptedAt, projectId, updatedAt);
  }

  /**
   * 批量人工验收：对一组已完成的计划/任务一次性置 accepted_at（不改变执行态 status）。
   * 纯人工确认：绝不调用 validatePlan/runShell/runCodex/executeTask/runOnce，不读/不执行 validation_command。
   */
  acceptItems(projectId, targets) {
    return acceptance.acceptItems(this, projectId, targets);
  }

  /**
   * 批量取消人工验收：对一组计划/任务一次性清空 accepted_at（NULL），不改变执行态 status。
   * 纯人工确认：绝不调用 validatePlan/runShell/runCodex/executeTask/runOnce，不读/不执行 validation_command。
   */
  unacceptItems(projectId, targets) {
    return acceptance.unacceptItems(this, projectId, targets);
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
    return planLifecycle.hasPlanForIssueHash(this, projectId, issueHash);
  }

  nextRunnablePlan(projectId) {
    return planLifecycle.nextRunnablePlan(this, projectId);
  }

  nextPlanSortOrder(projectId) {
    return planLifecycle.nextPlanSortOrder(this, projectId);
  }

  activateDraftPlan(plan) {
    return planLifecycle.activateDraftPlan(this, plan);
  }

  reorderPlans(projectId, planIds) {
    return planLifecycle.reorderPlans(this, projectId, planIds);
  }

  insertPlan(input) {
    return planLifecycle.insertPlan(this, input);
  }

  planAgentCliConfig(plan) {
    return planAgentCli.planAgentCliConfig(this, plan);
  }

  planSnapshotAgentCliConfig(plan) {
    return planAgentCli.planSnapshotAgentCliConfig(this, plan);
  }

  planGenerationConfig(defaults = {}, intake = {}) {
    return planBackendConfig.effectivePlanGenerationConfig(defaults, intake);
  }

  planExecutionConfig(defaults = {}, plan = {}) {
    return planBackendConfig.effectivePlanExecutionConfig(defaults, plan);
  }

  planGenerationAgentCliOperationFields(config = {}) {
    return planBackendConfig.planGenerationAgentCliOperationFields(config);
  }

  planExecutionAgentCliOperationFields(config = {}) {
    return planBackendConfig.planExecutionAgentCliOperationFields(config);
  }

  planAgentCliEventSnapshot(projectId, planId) {
    return planAgentCli.planAgentCliEventSnapshot(this, projectId, planId);
  }

  planSourceAgentCliSnapshot(projectId, planId) {
    return planAgentCli.planSourceAgentCliSnapshot(this, projectId, planId);
  }

  completeLinkedIntakesForPlan(plan) {
    return planLifecycle.completeLinkedIntakesForPlan(this, plan);
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
    this.emitRuntimePatch(projectId, { immediate: true });
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
    const isOpenCodePlanGeneration = isOpenCodeProvider && isOpenCodePlanGenerationOperation(label, operation);
    // 计划生成阶段（provider 为 opencode）才赋值为 AutoPlan 专用受限 agent 名；spawn 前落盘并注入。
    let opencodeAgentName = '';
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
        // Claude 连接解析（需求 #93）：优先级「所选 claude_config_id 命中 → 默认配置 → 既有内联 claude 字段」。
        //  1) 计划生成：planGenerationAgentCliOperationFields → operation → activeOperation（claudeBaseUrl 等驼峰键）
        //  2) 任务执行：planExecutionEventMeta 平铺 planExecutionClaude* → operation → activeOperation
        // 命中/默认配置覆盖内联字段；未选配置且无默认时回退内联字段，空则沿用本机 settings.json（与现状一致）。
        const claudeConfigId = Number(
          activeOperation.claudeConfigId || activeOperation.planExecutionClaudeConfigId || 0,
        );
        const resolved = resolveClaudeConnection(this.db, claudeConfigId);
        const claudeBaseUrl = resolved?.baseUrl
          || activeOperation.claudeBaseUrl
          || activeOperation.planExecutionClaudeBaseUrl
          || '';
        const claudeAuthToken = resolved?.authToken
          || activeOperation.claudeAuthToken
          || activeOperation.planExecutionClaudeAuthToken
          || '';
        const claudeModel = resolved?.model
          || activeOperation.claudeModel
          || activeOperation.planExecutionClaudeModel
          || '';
        const claudeEnv = (claudeBaseUrl || claudeAuthToken || claudeModel)
          ? { baseUrl: claudeBaseUrl, authToken: claudeAuthToken, model: claudeModel }
          : null;
        agentCliOptions = {
          ...activeOperation,
          sessionId: activeOperation.agentCliSessionId || activeOperation.claudeSessionId || '',
          ...(claudeEnv ? { claudeEnv } : {}),
        };
      } else if (isOpenCodeProvider) {
        agentCliOptions = {
          sessionId: mode === 'resume' ? capturedOpenCodeSessionId || requestedOpenCodeSessionId : '',
          title: opencodeSessionTitle,
          ...(opencodeAgentName ? { agent: opencodeAgentName } : {}),
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
    // 计划生成阶段（且 provider 为 opencode）：spawn 前确保 AutoPlan 专用受限 agent 已落盘
    // （<workspace>/.opencode/agents/autoplan-plan.md，见 P001），并在 agentCliOptions 中带上 agent 名，
    // 由 opencodeCliArgs 注入 `--agent autoplan-plan`。任务执行/修复不注入，沿用既有 session 复用。
    // 写盘失败时不阻断：记录日志并回退默认 agent，使计划生成仍可进行（仅失去工具限制）。
    if (isOpenCodePlanGeneration) {
      try {
        ensureOpenCodePlanAgent(workspace);
        opencodeAgentName = AUTOPLAN_OPENCODE_PLAN_AGENT;
      } catch (error) {
        appendInternalLog(`OpenCode 计划生成专用 agent 文件写入失败（${error?.message || error}），本次回退默认 agent，不注入 --agent`);
      }
    }
    const tailTimer = setInterval(() => {
      if (projectIdForEmit) this.emitRuntimePatch(projectIdForEmit);
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
            if (result.timedOut && opencodePlanId) {
              this.updatePlanAgentCliSession(opencodePlanId, '');
            } else if (result.opencodeSessionId && opencodePlanId) {
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
        if (result.timedOut && opencodePlanId) {
          this.updatePlanAgentCliSession(opencodePlanId, '');
        } else if (result.opencodeSessionId && opencodePlanId) {
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

      const fresh = await runAttempt(codexNewSessionArgs(lastFile, { reasoningEffort: codexReasoningEffort }), 'new');
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
      logFile,
      logBuffer: '',
      activity: new CodexActivityPrinter(200),
      startedAt: nowIso(),
    };
    const operationKey = registerRuntimeOperation(runtime, child, activeOperation);
    this.emitRuntimePatch(projectIdForEmit, { immediate: true });
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
      if (projectIdForEmit) this.emitRuntimePatch(projectIdForEmit);
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
        const targetExists = this.operationTargetExists(operation);
        const errorText = activeOperation.errorMessage || (targetExists ? '操作已停止' : '操作目标已删除');
        return {
          exitCode: -1,
          output,
          logFile,
          errorMessage: errorText,
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
    this.emitRuntimePatch(projectId);
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

  /** 运行工作区执行器，依赖调度与状态回写由 executorRunner 处理。 */
  async runExecutor(projectId, executorId) {
    return executorRunner.runExecutor(this, projectId, executorId);
  }

  /** 停止指定执行器及其依赖链上仍在运行的子进程。 */
  stopExecutor(projectId, executorId) {
    return executorRunner.stopExecutor(this, projectId, executorId);
  }

  /** 触发 plugin 执行器生命周期动作（start/reload/stop）。 */
  async runExecutorAction(projectId, executorId, action) {
    const id = Number(projectId);
    const executorIdNum = Number(executorId);
    if (!Number.isInteger(id) || id <= 0) throw new Error('项目不存在');
    if (!Number.isInteger(executorIdNum) || executorIdNum <= 0) throw new Error('executorId 无效');
    if (action !== 'start' && action !== 'reload' && action !== 'stop') {
      throw new Error('action 仅支持 start/reload/stop');
    }

    const project = this.project(id);
    if (!project) throw new Error('项目不存在');
    const executor = getExecutor(this.db, id, executorIdNum);
    if (!executor) throw new Error('执行器不存在');
    if (executor.type !== 'plugin') throw new Error('仅 plugin 执行器支持生命周期动作');

    const workspacePath = String(project.workspace_path || '').trim();
    const context = {
      projectId: id,
      workspace: workspacePath ? path.resolve(workspacePath) : '',
      rootExecutorId: executorIdNum,
      rootExecutorLabel: executor.label,
      executorRunId: `plugin-${action}-${executorIdNum}-${Date.now()}`,
    };

    if (action === 'start') return executorRunner.startPluginExecutor(this, context, executor);
    if (action === 'reload') return executorRunner.reloadPluginExecutor(this, context, executor);
    return executorRunner.stopPluginExecutor(this, context, executor);
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
      // 空/非法 cron：记一条失败事件并置 last_status='bad'，同分钟去重避免刷屏；绝不抛错、不影响同 tick 其它脚本与后续 tick
      for (const script of scripts) {
        const cronExpr = String(script.schedule_cron || '').trim();
        try {
          scriptHooks.parseCron(cronExpr);
        } catch (error) {
          if (scriptHooks.isRunThisMinute(script.last_run_at, now)) continue;
          const finishedAt = nowIso();
          const errorMessage = error?.message || String(error);
          try {
            this.db.run(
              `UPDATE scripts
               SET last_status = 'bad',
                   last_exit_code = -1,
                   last_duration_ms = 0,
                   last_log = ?,
                   last_run_at = ?,
                   updated_at = ?
               WHERE id = ?`,
              [errorMessage, finishedAt, finishedAt, script.id],
            );
            this.addEvent(
              projectId,
              'script.schedule.error',
              `${script.name} 定时表达式无效：${errorMessage}`,
              {
                scriptId: script.id,
                scriptName: script.name,
                stage: 'schedule',
                trigger: 'schedule',
                cron: cronExpr,
                errorMessage,
              },
            );
          } catch {
            // 调度器兜底：单条错误状态/事件写入失败不能阻断其它脚本。
          }
        }
      }
      let due = [];
      try {
        due = scriptHooks.dueScheduledScripts(scripts, now);
      } catch {
        due = []; // 筛选异常兜底，本 tick 跳过该项目
      }
      for (const script of due) {
        const stage = 'schedule';
        try {
          await scriptHooks.runScriptOnce(this, script, stage, { trigger: 'schedule', workspace });
        } catch (error) {
          try {
            scriptHooks.recordRunFailure(this, script, stage, { trigger: 'schedule', workspace }, error);
          } catch {
            // 失败回写本身异常时继续处理后续脚本，避免单条脚本阻断整个 tick。
          }
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

  addEvent(projectId, type, message, meta = null, options = {}) {
    this.db.run('INSERT INTO events (project_id, type, message, meta, created_at) VALUES (?, ?, ?, ?, ?)', [
      projectId,
      type,
      message,
      meta ? JSON.stringify(meta) : null,
      nowIso(),
    ]);
    if (options.lightweight) this.emitRuntimePatch(projectId);
    else this.emitUpdate(projectId);
  }

  emitUpdate(projectId, options = {}) {
    this.updateEmitter.emit(projectId, options);
  }

  emitRuntimePatch(projectId, options = {}) {
    this.updateEmitter.emit(projectId, { ...options, lightweight: true });
  }

  flushPendingUpdates() {
    this.updateEmitter.flush();
  }

  /** 注入实时 MCP 状态提供者（main.js 持有 mcpServer 句柄后调用），使快照反映进程真实运行态而非仅靠事件推导。 */
  setMcpStatusProvider(provider) {
    this.mcpStatusProvider = typeof provider === 'function' ? provider : null;
  }

  setTerminalMetadataProvider(provider) {
    this.terminalMetadataProvider = typeof provider === 'function' ? provider : null;
  }

  snapshot(projectId = null) {
    return snapshots.snapshot(this, loopFlowHelpers(), projectId);
  }

  snapshotPatch(projectId = null) {
    const id = Number(projectId || 0);
    if (!id) return runtimePatchEmpty(null);

    const activeProject = this.project(id);
    if (!activeProject) return runtimePatchEmpty(id);

    const runtime = this.existingRuntime(id);
    const state = {
      ...(this.status(id) || {}),
      workspace_path: activeProject.workspace_path || '',
    };

    return {
      projectId: id,
      activeProjectId: id,
      state,
      tasks: this.runtimeTaskSnapshots(id, activeProject.workspace_path || '', runtime),
      events: this.runtimeEventSnapshots(id),
      ...this.runtimeOperationSnapshots(id, runtime),
    };
  }

  runtimeTaskSnapshots(projectId, workspace, runtime = null) {
    const taskOperationContexts = runtimeOperationContextByTask(runtime, projectId);
    return this.db
      .all(
        `SELECT plan_tasks.*, plans.file_path,
                plans.hash AS __plan_hash,
                plans.updated_at AS __plan_updated_at
         FROM plan_tasks JOIN plans ON plans.id = plan_tasks.plan_id
         WHERE plans.project_id = ?
         ORDER BY plans.sort_order ASC, plans.created_at ASC, plans.id ASC, plan_tasks.sort_order ASC, plan_tasks.id ASC`,
        [projectId],
      )
      .map((row) => {
        const { __plan_hash: planHash, __plan_updated_at: planUpdatedAt, ...task } = row;
        const planTitle = snapshots.cachedPlanMarkdownTitle(this, workspace, {
          id: task.plan_id,
          file_path: task.file_path,
          hash: planHash,
          updated_at: planUpdatedAt,
        });
        return snapshots.taskSnapshotRow(
          this,
          workspace,
          { ...task, plan_title: planTitle || '' },
          taskOperationContexts.get(Number(task.id)),
        );
      });
  }

  runtimeEventSnapshots(projectId) {
    return this.db
      .all('SELECT * FROM events WHERE project_id = ? ORDER BY id DESC LIMIT 80', [projectId])
      .map((event) => snapshots.eventSnapshotRow(event));
  }

  runtimeOperationSnapshots(projectId, runtime = null) {
    return {
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
    resolveSafePlanMarkdownPath,
    resolveSafePlanManifestPath,
    tailText,
    timestampForPath,
  };
}

function runtimePatchEmpty(projectId = null) {
  return {
    projectId,
    activeProjectId: null,
    state: null,
    tasks: [],
    events: [],
    activeOperation: null,
    activeOperations: [],
    lastOperation: null,
  };
}

function normalizeGeneratedPlanIds(result) {
  if (Array.isArray(result)) return uniquePositiveIds(result);
  if (result && typeof result === 'object') {
    if (Array.isArray(result.generatedPlanIds)) return uniquePositiveIds(result.generatedPlanIds);
    if (Array.isArray(result.planIds)) return uniquePositiveIds(result.planIds);
    return uniquePositiveIds([result.generatedPlanId, result.planId, result.id]);
  }
  return uniquePositiveIds([result]);
}

function uniquePositiveIds(values = []) {
  const ids = [];
  const seen = new Set();
  for (const value of values) {
    const id = Number(value || 0);
    if (!Number.isInteger(id) || id <= 0 || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function normalizePositiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function normalizeLoopIntakeType(value) {
  return value === 'feedback' ? 'feedback' : 'requirement';
}

function intakeTableForLoopType(value) {
  return normalizeLoopIntakeType(value) === 'feedback' ? 'feedback' : 'requirements';
}

function hasLegacyAgentCliConfigInput(input = {}) {
  return hasAnyOwnProperty(input, LEGACY_AGENT_CLI_CONFIG_INPUT_KEYS);
}

function hasPlanGenerationConfigInput(input = {}) {
  return hasAnyOwnProperty(input, PLAN_GENERATION_CONFIG_INPUT_KEYS);
}

function hasPlanExecutionConfigInput(input = {}) {
  return hasAnyOwnProperty(input, PLAN_EXECUTION_CONFIG_INPUT_KEYS);
}

function hasProjectPromptInput(input = {}) {
  return hasAnyOwnProperty(input, PROJECT_PROMPT_INPUT_KEYS);
}

function planGenerationStateUpdates(columns, current = {}, input = {}) {
  if (!hasPlanGenerationConfigInput(input) && !hasLegacyAgentCliConfigInput(input)) return [];
  const config = planBackendConfig.effectivePlanGenerationConfig(
    current,
    planGenerationInputWithLegacyStrategyDefault(input),
  );
  return planBackendStateUpdates(columns, 'plan_generation', config);
}

function planExecutionStateUpdates(columns, current = {}, input = {}) {
  const config = nextPlanExecutionConfig(current, input);
  return config ? planBackendStateUpdates(columns, 'plan_execution', config) : [];
}

function nextPlanExecutionConfig(current = {}, input = {}) {
  if (!hasPlanExecutionConfigInput(input) && !hasLegacyAgentCliConfigInput(input)) return null;
  return planBackendConfig.effectivePlanExecutionConfig(
    current,
    planExecutionInputWithLegacyStrategyDefault(input),
  );
}

function planBackendStateUpdates(columns, prefix, config = {}) {
  const updates = [];
  addColumnUpdate(updates, columns, `${prefix}_strategy`, config.strategy);
  addColumnUpdate(updates, columns, `${prefix}_provider`, config.provider);
  addColumnUpdate(updates, columns, `${prefix}_command`, config.command || '');
  addColumnUpdate(updates, columns, `${prefix}_model`, config.model || '');
  addColumnUpdate(updates, columns, `${prefix}_codex_reasoning_effort`, config.codexReasoningEffort || null);
  // Claude 自定义连接字段（baseUrl/authToken/model）：仅 project_states / plans 有对应列，
  // requirements / feedback 的 ensureColumn 已加生成阶段 3 列，addColumnUpdate 会按 columns 守卫跳过不存在的列。
  addColumnUpdate(updates, columns, `${prefix}_claude_base_url`, config.claudeBaseUrl || '');
  addColumnUpdate(updates, columns, `${prefix}_claude_auth_token`, config.claudeAuthToken || '');
  addColumnUpdate(updates, columns, `${prefix}_claude_model`, config.claudeModel || '');
  // Claude 多配置 id（需求 #93）：整数列，0 表示未选；按 columns 守卫跳过不存在该列的表。
  addColumnUpdate(updates, columns, `${prefix}_claude_config_id`, config.claudeConfigId || 0);
  return updates;
}

function addColumnUpdate(updates, columns, column, value) {
  if (columns.has(column)) updates.push([column, value]);
}

function nextIntakePlanGenerationConfig(current = {}, input = {}) {
  if (hasPlanGenerationConfigInput(input) || hasLegacyAgentCliConfigInput(input)) {
    return planBackendConfig.effectivePlanGenerationConfig(
      current,
      planGenerationInputWithLegacyStrategyDefault(input),
    );
  }
  return storedIntakePlanGenerationConfig(current);
}

function planGenerationInputWithLegacyStrategyDefault(input = {}) {
  if (hasPlanGenerationConfigInput(input) || !hasLegacyAgentCliConfigInput(input)) return input;
  return { ...input, planGenerationStrategy: planBackendConfig.DEFAULT_PLAN_GENERATION_STRATEGY };
}

function planExecutionInputWithLegacyStrategyDefault(input = {}) {
  if (hasPlanExecutionConfigInput(input) || !hasLegacyAgentCliConfigInput(input)) return input;
  return { ...input, planExecutionStrategy: planBackendConfig.DEFAULT_PLAN_EXECUTION_STRATEGY };
}

function storedIntakePlanGenerationConfig(source = {}) {
  const strategy = normalizeNullablePlanGenerationStrategy(source.plan_generation_strategy);
  const provider = normalizeNullablePlanBackendProvider(source.plan_generation_provider, strategy);
  const command = normalizeNullableText(source.plan_generation_command) || '';
  const model = normalizeNullableText(source.plan_generation_model) || '';
  const codexReasoningEffort = provider === DEFAULT_AGENT_CLI_PROVIDER
    ? normalizeNullableCodexReasoningEffort(source.plan_generation_codex_reasoning_effort)
    : null;
  const claudeBaseUrl = normalizeNullableText(source.plan_generation_claude_base_url) || '';
  const claudeAuthToken = normalizeNullableText(source.plan_generation_claude_auth_token) || '';
  const claudeModel = normalizeNullableText(source.plan_generation_claude_model) || '';
  const claudeConfigId = Number(source.plan_generation_claude_config_id) || 0;
  return { strategy, provider, command, model, codexReasoningEffort, claudeBaseUrl, claudeAuthToken, claudeModel, claudeConfigId };
}

function normalizeNullablePlanGenerationStrategy(value) {
  const text = normalizeNullableText(value);
  return text ? planBackendConfig.normalizePlanGenerationStrategy(text) : null;
}

function normalizeNullablePlanBackendProvider(value, strategy = null) {
  const text = normalizeNullableText(value);
  return text ? planBackendConfig.normalizePlanBackendProvider(text, strategy) : null;
}

function normalizeNullableCodexReasoningEffort(value) {
  const text = normalizeNullableText(value)?.toLowerCase();
  return text && ['low', 'medium', 'high', 'xhigh'].includes(text) ? text : null;
}

function normalizeNullableText(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

/**
 * 解析 Claude 连接（需求 #93）：按「所选 claude_config_id 命中 → 默认配置」优先级返回
 * { baseUrl, authToken, model }（authToken 为明文，仅供 spawn 注入 ANTHROPIC_*）；两者都无则返回 null，
 * 由调用方回退到既有内联 claude 字段。
 */
function resolveClaudeConnection(db, configId) {
  const id = Number(configId) || 0;
  if (id > 0) {
    const row = db.get(
      'SELECT base_url, auth_token, model FROM claude_cli_configs WHERE id = ? AND project_id IS NULL',
      [id],
    );
    if (row) {
      return {
        baseUrl: row.base_url || '',
        authToken: row.auth_token || '',
        model: row.model || '',
      };
    }
  }
  const defaultConfig = resolveDefaultClaudeCliConfig(db);
  if (defaultConfig) {
    return {
      baseUrl: defaultConfig.baseUrl || '',
      authToken: defaultConfig.authToken || '',
      model: defaultConfig.model || '',
    };
  }
  return null;
}

module.exports = {
  LoopService,
  LEGACY_TASK_EVENT_TYPES,
  ...planBackendConfig,
  hasPlanExecutionConfigInput,
  hasPlanGenerationConfigInput,
  normalizeIntakeAgentCliConfig,
  nextIntakePlanGenerationConfig,
  nextIntakeAgentCliConfig,
  TASK_EVENT_COMPATIBILITY,
  TASK_EVENT_SEMANTICS,
  TASK_EVENT_STATUS,
  TASK_EVENT_TYPES,
};
