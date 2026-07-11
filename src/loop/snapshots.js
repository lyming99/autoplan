const fs = require('node:fs');
const path = require('node:path');
const { nowIso } = require('../database');
const {
  DEFAULT_AGENT_CLI_PROVIDER,
  agentCliContextFields,
  codexSessionContextFields,
  effectiveAgentCliConfig,
  intakeSnapshotRow,
  normalizeOptionalAgentCliProvider,
  normalizeOptionalCodexReasoningEffort,
  normalizeOptionalString,
} = require('./agentCliConfig');
const { TASK_EVENT_STATUS, normalizeDurationMs, taskRunDurationMs } = require('./taskEvents');
const { operationSnapshotRow, runtimeOperationContextByTask } = require('./runtime');
const { emptyConcurrencySuggestion, planConcurrencySuggestion, taskScopeFileInfos } = require('./concurrency');
const { extractMarkdownTitle } = require('./planParser');
const intakePlanLinks = require('./intakePlanLinks');
const planAgentCli = require('./planAgentCli');
const { readSnippet, resolveWorkspaceChildPath } = require('./workspaceFiles');
const { executorFromRow } = require('../executors/executorStore');
const { parseEventMeta } = require('./eventMeta');
const { MCP_TOOL_NAMES: MCP_TOOL_NAME_MAP } = require('../mcpTools');
const { MCP_TOOL_DOCS } = require('../mcpToolDocs');

const MCP_DEFAULT_CONFIG = Object.freeze({ enabled: true, transport: 'http', host: '127.0.0.1', port: 43847, path: '/mcp', authToken: '' });
const MCP_TOOL_NAMES = Object.freeze(Object.values(MCP_TOOL_NAME_MAP));
const LOCAL_MCP_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
const PLAN_BACKEND_SNAPSHOT_COLUMNS = Object.freeze([
  'plan_generation_strategy',
  'plan_generation_provider',
  'plan_generation_command',
  'plan_generation_model',
  'plan_generation_codex_reasoning_effort',
  'plan_generation_claude_base_url',
  'plan_generation_claude_auth_token',
  'plan_generation_claude_model',
  'plan_generation_claude_config_id',
  'plan_execution_strategy',
  'plan_execution_provider',
  'plan_execution_command',
  'plan_execution_model',
  'plan_execution_codex_reasoning_effort',
  'plan_execution_claude_base_url',
  'plan_execution_claude_auth_token',
  'plan_execution_claude_model',
  'plan_execution_claude_config_id',
]);

// Claude authToken 列在 snapshot 中需脱敏（仅保留末 4 位 + 前缀 ····），并附加 *_has_claude_auth_token
// 布尔位让 UI 判断是否已有密钥（输入框 placeholder 显示 ····1234 或「留空不改动」）。原始明文仅留在
// 数据库，供 spawn 时注入 ANTHROPIC_AUTH_TOKEN 环境变量；永不回填到 renderer。
const PLAN_BACKEND_CLAUDE_AUTH_TOKEN_COLUMNS = Object.freeze([
  'plan_generation_claude_auth_token',
  'plan_execution_claude_auth_token',
]);

function snapshot(service, helpers, projectId = null) {
    const projects = service.projects();
    const mcp = mcpStatusSnapshot(service.db, readMcpLiveStatus(service));
    if (!projectId) return emptySnapshot(projects, mcp);

    const activeProject = service.project(projectId);
    if (!activeProject) return emptySnapshot(projects, mcp);

    // 异步批量预取 task timeout 事件，避免每个 task 一次 LIKE 查询
    batchPreloadTaskTimeouts(service, projectId);

    const rawState = service.status(projectId) || {};
    const state = {
      ...rawState,
      ...planBackendSnapshotFields(rawState),
      workspace_path: activeProject.workspace_path || '',
    };
    const runtime = service.existingRuntime(projectId);
    const taskOperationContexts = runtimeOperationContextByTask(runtime, projectId);
    const planRows = service.db.all(
      'SELECT * FROM plans WHERE project_id = ? ORDER BY sort_order ASC, created_at ASC, id ASC',
      [projectId],
    );
    const taskRows = service.db.all(
      `SELECT plan_tasks.*, plans.file_path
       FROM plan_tasks JOIN plans ON plans.id = plan_tasks.plan_id
       WHERE plans.project_id = ?
       ORDER BY plans.sort_order ASC, plans.created_at ASC, plans.id ASC, plan_tasks.sort_order ASC, plan_tasks.id ASC`,
      [projectId],
    );
    const tasksByPlanId = groupPlanTasksByPlanId(taskRows);

    // 批量预取 plan agent CLI 配置（避免每个 plan 单独查 3-4 条 SQL）
    planAgentCli.batchPreloadPlanAgentCliConfigs(service, planRows);

    const concurrencySuggestionByPlanId = new Map(
      planRows.map((plan) => [
        Number(plan.id),
        cachedPlanConcurrencySuggestion(
          service,
          activeProject.workspace_path,
          plan,
          tasksByPlanId.get(Number(plan.id)) || [],
        ),
      ]),
    );
    const planSnapshots = planRows.map((plan) => planSnapshotRow(
      service,
      activeProject.workspace_path,
      plan,
      concurrencySuggestionByPlanId.get(Number(plan.id)),
      service.planSnapshotAgentCliConfig(plan),
    ));
    const planSnapshotById = new Map(planSnapshots.map((plan) => [Number(plan.id), plan]));
    const planTitleById = new Map(planSnapshots.map((plan) => [Number(plan.id), plan.title || '']));
    const linkedPlanSnapshotsByIntake = linkedPlanSnapshotsByIntakeForProject(
      service,
      projectId,
      planSnapshotById,
    );

    return {
      activeProjectId: projectId,
      activeProject,
      projects,
      mcp,
      state,
      requirements: service.db.all(
        `SELECT requirements.*, plans.file_path AS plan_file_path,
                plans.status AS plan_status,
                plans.completed_tasks AS plan_completed, plans.total_tasks AS plan_total
         FROM requirements
         LEFT JOIN plans ON plans.id = requirements.linked_plan_id
          AND plans.project_id = requirements.project_id
         WHERE requirements.project_id = ?
          ORDER BY requirements.updated_at DESC`,
        [projectId],
      ).map((row) => intakeLinkedPlanSnapshotRow(
        row,
        planSnapshotById,
        state,
        linkedPlanSnapshotsForGroupedIntake(linkedPlanSnapshotsByIntake, 'requirement', row.id),
      )),
      feedback: service.db.all(
        `SELECT feedback.*, plans.file_path AS plan_file_path,
                plans.status AS plan_status,
                plans.completed_tasks AS plan_completed, plans.total_tasks AS plan_total
         FROM feedback
         LEFT JOIN plans ON plans.id = feedback.linked_plan_id
          AND plans.project_id = feedback.project_id
         WHERE feedback.project_id = ?
          ORDER BY feedback.updated_at DESC`,
        [projectId],
      ).map((row) => intakeLinkedPlanSnapshotRow(
        row,
        planSnapshotById,
        state,
        linkedPlanSnapshotsForGroupedIntake(linkedPlanSnapshotsByIntake, 'feedback', row.id),
      )),
      attachments: service.db.all(
        'SELECT * FROM attachments WHERE project_id = ? ORDER BY created_at DESC, id DESC',
        [projectId],
      ),
      plans: planSnapshots,
      tasks: taskRows
        .map((task) => taskSnapshotRow(
          service,
          activeProject.workspace_path,
          {
            ...task,
            plan_title: planTitleById.get(Number(task.plan_id)) || '',
          },
          taskOperationContexts.get(Number(task.id)),
        )),
      events: service.db
        .all('SELECT * FROM events WHERE project_id = ? ORDER BY id DESC LIMIT 80', [projectId])
        .map((event) => eventSnapshotRow(event)),
      scans: [],
      scanSummary: scanSummarySnapshot(service.db, projectId),
      scripts: service.db.all(
        'SELECT * FROM scripts WHERE project_id = ? ORDER BY sort_order ASC, id ASC',
        [projectId],
      ),
      executors: service.db.all(
        'SELECT * FROM executors WHERE project_id = ? ORDER BY sort_order ASC, id ASC',
        [projectId],
      ).map((row) => executorSnapshotRow(row, runtime, projectId)),
      terminals: readTerminalMetadata(service, projectId),
      activeOperation:
        runtime?.activeOperation && Number(runtime.activeOperation.projectId) === Number(projectId)
          ? operationSnapshotRowWithPlanExecutionFields(runtime.activeOperation)
          : null,
      activeOperations: runtime?.activeOperations
        ? Array.from(runtime.activeOperations.values())
            .filter((operation) => Number(operation.projectId) === Number(projectId))
            .map((operation) => operationSnapshotRowWithPlanExecutionFields(operation))
        : [],
      lastOperation:
        runtime?.lastOperation && Number(runtime.lastOperation.projectId) === Number(projectId)
          ? runtime.lastOperation
          : null,
    };
  }

function taskSnapshotRow(service, workspace, task, operationContext = null) {
  if (!task) return task;
  const startedAt = normalizeOptionalString(task.started_at) || null;
  const finishedAt = normalizeOptionalString(task.finished_at) || null;
  const isRunning = task.status === TASK_EVENT_STATUS.RUNNING;
  const runDurationMs = isRunning ? taskRunDurationMs(startedAt, nowIso()) : undefined;
  const agentContext = agentCliContextFields(operationContext || {}, { defaultProvider: false });
  const providerForSession = agentContext.agentCliProvider || (task.codex_session_id ? DEFAULT_AGENT_CLI_PROVIDER : undefined);
  const timeoutContext = taskTimeoutSnapshotFields(service, task, operationContext);
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
    scope_files: cachedTaskScopeFileInfos(service, workspace, task),
    started_at: startedAt,
    finished_at: finishedAt,
    duration_ms: normalizeDurationMs(task.duration_ms),
    ...(runDurationMs !== undefined ? { run_duration_ms: normalizeDurationMs(runDurationMs) } : {}),
    ...timeoutContext,
    ...agentContext,
    ...sessionContext,
  };
}

function taskTimeoutSnapshotFields(service, task = {}, operationContext = null) {
  const operationTimeout = taskTimeoutFieldsFromMeta(operationContext, null);
  if (operationTimeout?.timedOut) return operationTimeout;
  // 跳过逐 task 的 LIKE SQL 查询（每个 task 一次，N+1 问题严重）。
  // timeout 事件通过 setImmediate 异步预加载后下一次快照补充。
  if (!service._taskTimeoutCache) return {};
  const taskId = Number(task?.id || 0);
  if (!taskId) return {};
  const cached = service._taskTimeoutCache.get(taskId);
  if (cached === undefined) return {}; // not yet loaded
  if (!cached) return {};
  return taskTimeoutFieldsFromMeta(parseEventMeta(cached.meta), cached) || {};
}

/** 批量预取 task timeout 事件，由快照构造函数在 plan 循环前调用一次。 */
function batchPreloadTaskTimeouts(service, projectId) {
  if (!service || !projectId) return;
  if (!service._taskTimeoutCache) service._taskTimeoutCache = new Map();
  // 已加载则跳过
  if (service._taskTimeoutCache.has('__loaded__')) return;
  service._taskTimeoutCache.set('__loaded__', true);

  setImmediate(() => {
    try {
      const rows = service.db.all(
        `SELECT type, message, meta, created_at FROM events
         WHERE project_id = ? AND type = 'task.timeout'
         ORDER BY id DESC LIMIT 200`,
        [projectId],
      ) || [];
      for (const row of rows) {
        const meta = parseEventMeta(row?.meta);
        if (!meta || typeof meta !== 'object') continue;
        const taskId = Number(meta.taskId || 0);
        if (taskId && !service._taskTimeoutCache.has(taskId)) {
          service._taskTimeoutCache.set(taskId, row);
        }
      }
    } catch {
      // 预加载失败静默跳过
    }
  });
}

function latestTaskTimeoutEvent(service, task = {}) {
  const taskId = Number(task?.id || 0);
  if (!taskId || !service?.db?.all) return null;
  const needle = `%\"taskId\":${taskId}%`;
  const rows = service.db.all(
    `SELECT type, message, meta, created_at
       FROM events
      WHERE meta LIKE ?
      ORDER BY id DESC
      LIMIT 40`,
    [needle],
  );
  return (rows || []).find((event) => {
    const meta = parseEventMeta(event?.meta);
    return event?.type === 'task.timeout' || Boolean(meta?.timedOut);
  }) || null;
}

function taskTimeoutFieldsFromMeta(meta = null, event = null) {
  if (!meta || typeof meta !== 'object') return null;
  const timedOut = Boolean(meta.timedOut || meta.timed_out || event?.type === 'task.timeout');
  const resetReason = normalizeOptionalString(meta.taskSessionResetReason ?? meta.task_session_reset_reason) || null;
  if (!timedOut && resetReason !== 'timedOut') return null;
  const timeoutMs = normalizeNullableNumber(meta.timeoutMs ?? meta.timeout_ms);
  const timeoutMinutes = normalizeNullableNumber(meta.timeoutMinutes ?? meta.timeout_minutes)
    ?? (timeoutMs ? Math.round((timeoutMs / 60000) * 100) / 100 : null);
  return {
    timedOut,
    timeoutMs,
    timeoutMinutes,
    taskSessionMode: normalizeOptionalString(meta.taskSessionMode ?? meta.task_session_mode) || null,
    taskSessionState: normalizeOptionalString(meta.taskSessionState ?? meta.task_session_state) || null,
    taskSessionResetReason: resetReason,
    willRetryWithNewSession: Boolean(meta.willRetryWithNewSession || meta.reopenContextOnRetry),
    reopenContextOnRetry: Boolean(meta.reopenContextOnRetry || meta.willRetryWithNewSession),
    last_timeout_at: normalizeOptionalString(event?.created_at) || null,
    last_timeout_message: normalizeOptionalString(event?.message) || null,
    last_timeout_ms: timeoutMs,
    last_timeout_minutes: timeoutMinutes,
    last_timeout_agent_cli_provider: normalizeOptionalString(meta.agentCliProvider ?? meta.agent_cli_provider) || null,
    last_timeout_log: normalizeOptionalString(meta.log ?? meta.logFile ?? meta.log_file) || null,
  };
}
function intakeLinkedPlanSnapshotRow(row = {}, planSnapshotById = new Map(), state = {}, linkedPlans = []) {
  const normalized = intakeSnapshotRow(row);
  // 生效 CLI：记录覆盖优先，否则回退项目默认（state）；写入快照行让渲染层只管显示。
  const effective = effectiveAgentCliConfig(state || {}, normalized);
  const base = {
    ...normalized,
    accepted_at: normalizeOptionalString(normalized.accepted_at) || null,
    ...planBackendSnapshotFields(normalized),
    ...intakeGenerateFailureSnapshotFields(normalized),
    agent_cli_provider: effective.provider,
    agent_cli_command: effective.command,
    codex_reasoning_effort: effective.codexReasoningEffort,
  };
  let normalizedLinkedPlans = Array.isArray(linkedPlans) ? linkedPlans : [];
  if (normalizedLinkedPlans.length === 0) {
    const legacyLinkedPlan = legacyLinkedPlanSnapshot(base, planSnapshotById);
    normalizedLinkedPlans = legacyLinkedPlan ? [legacyLinkedPlan] : [];
  }
  normalizedLinkedPlans = markCurrentLinkedPlanSnapshot(normalizedLinkedPlans);
  const linkedPlan = currentLinkedPlanSnapshot(normalizedLinkedPlans);
  if (!linkedPlan) {
    return {
      ...base,
      linked_plans: [],
    };
  }

  const title = linkedPlan.title || null;
  const filePath = linkedPlan.file_path || base.plan_file_path || null;
  const status = linkedPlan.status || base.plan_status || null;
  const completed = linkedPlan.completed_tasks ?? base.plan_completed ?? null;
  const total = linkedPlan.total_tasks ?? base.plan_total ?? null;

  return {
    ...base,
    linked_plans: normalizedLinkedPlans,
    plan_title: title,
    plan_file_path: filePath,
    plan_status: status,
    plan_completed: completed,
    plan_total: total,
    linked_plan_title: title,
    linked_plan_file_path: filePath,
    linked_plan_status: status,
    linked_plan_completed_tasks: completed,
    linked_plan_total_tasks: total,
  };
}

function linkedPlanSnapshotsByIntakeForProject(service, projectId, planSnapshotById = new Map()) {
  let linksByIntake = new Map();
  try {
    linksByIntake = intakePlanLinks.getPlansByIntakeForProject(service, projectId, {
      includeMissingPlans: true,
    });
  } catch {
    linksByIntake = new Map();
  }

  const snapshotsByIntake = new Map();
  for (const [key, links] of linksByIntake.entries()) {
    const linkedPlans = markCurrentLinkedPlanSnapshot(
      links
        .map((link) => linkedPlanSnapshotFromLink(link, planSnapshotById))
        .filter(Boolean),
    );
    if (linkedPlans.length > 0) snapshotsByIntake.set(key, linkedPlans);
  }
  return snapshotsByIntake;
}

function linkedPlanSnapshotsForGroupedIntake(linksByIntake, intakeType, intakeId) {
  const key = linkedPlanSnapshotGroupKey(intakeType, intakeId);
  if (!key || !linksByIntake?.has(key)) return [];
  return linksByIntake.get(key) || [];
}

function linkedPlanSnapshotGroupKey(intakeType, intakeId) {
  const normalizedIntakeId = normalizePositiveInteger(intakeId);
  if (!normalizedIntakeId) return null;
  return `${intakePlanLinks.normalizeIntakeType(intakeType)}:${normalizedIntakeId}`;
}

function linkedPlanSnapshotFromLink(link = {}, planSnapshotById = new Map()) {
  const planId = normalizePositiveInteger(link.planId ?? link.plan_id ?? link.id);
  if (!planId) return null;
  const plan = link.plan || {};
  const snapshotPlan = planSnapshotById.get(planId) || null;
  const phaseTitle = normalizeOptionalString(link.phaseTitle ?? link.phase_title) || null;
  return {
    link_id: normalizePositiveInteger(link.linkId ?? link.link_id),
    intake_type: link.intakeType || link.intake_type || null,
    intake_id: normalizePositiveInteger(link.intakeId ?? link.intake_id),
    plan_id: planId,
    phase_index: normalizePositiveInteger(link.phaseIndex ?? link.phase_index) || 1,
    phase_title: phaseTitle,
    title: snapshotPlan?.title || phaseTitle || plan.file_path || `Plan #${planId}`,
    file_path: snapshotPlan?.file_path || plan.file_path || null,
    status: snapshotPlan?.status || plan.status || null,
    completed_tasks: normalizeNullableNumber(snapshotPlan?.completed_tasks ?? plan.completed_tasks),
    total_tasks: normalizeNullableNumber(snapshotPlan?.total_tasks ?? plan.total_tasks),
    validation_passed: snapshotPlan?.validation_passed ?? plan.validation_passed ?? null,
    is_current: false,
  };
}

function legacyLinkedPlanSnapshot(row = {}, planSnapshotById = new Map()) {
  const planId = normalizePositiveInteger(row.linked_plan_id);
  if (!planId) return null;
  const linkedPlan = planSnapshotById.get(planId) || null;
  return {
    link_id: null,
    intake_type: null,
    intake_id: normalizePositiveInteger(row.id),
    plan_id: planId,
    phase_index: 1,
    phase_title: null,
    title: linkedPlan?.title || row.plan_title || row.plan_file_path || `Plan #${planId}`,
    file_path: linkedPlan?.file_path || row.plan_file_path || null,
    status: linkedPlan?.status || row.plan_status || null,
    completed_tasks: normalizeNullableNumber(linkedPlan?.completed_tasks ?? row.plan_completed),
    total_tasks: normalizeNullableNumber(linkedPlan?.total_tasks ?? row.plan_total),
    validation_passed: linkedPlan?.validation_passed ?? null,
    is_current: false,
  };
}

function markCurrentLinkedPlanSnapshot(linkedPlans = []) {
  const current = currentLinkedPlanSnapshot(linkedPlans);
  return linkedPlans.map((linkedPlan) => ({
    ...linkedPlan,
    is_current: Boolean(
      current
      && Number(linkedPlan.plan_id) === Number(current.plan_id)
      && Number(linkedPlan.phase_index || 0) === Number(current.phase_index || 0),
    ),
  }));
}

function currentLinkedPlanSnapshot(linkedPlans = []) {
  if (!Array.isArray(linkedPlans) || linkedPlans.length === 0) return null;
  return linkedPlans.find((linkedPlan) => {
    const status = String(linkedPlan.status || '').toLowerCase();
    return status && !['completed', 'interrupted', 'draft'].includes(status);
  }) || linkedPlans.find((linkedPlan) => String(linkedPlan.status || '').toLowerCase() !== 'completed') || linkedPlans[0];
}

function normalizePositiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function normalizeNullableNumber(value) {
  if (value === null || typeof value === 'undefined' || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function intakeGenerateFailureSnapshotFields(row = {}) {
  const failCount = Number(row.generate_fail_count ?? 0);
  const failureProvider = normalizeOptionalAgentCliProvider(row.last_generate_agent_cli_provider);
  return {
    generate_fail_count: Number.isFinite(failCount) ? failCount : 0,
    last_generate_fail_at: normalizeOptionalString(row.last_generate_fail_at) || null,
    last_generate_error: normalizeOptionalString(row.last_generate_error) || null,
    last_generate_log_file: normalizeOptionalString(row.last_generate_log_file) || null,
    last_generate_agent_cli_provider: failureProvider,
    last_generate_codex_reasoning_effort: failureProvider === DEFAULT_AGENT_CLI_PROVIDER
      ? normalizeOptionalCodexReasoningEffort(row.last_generate_codex_reasoning_effort)
      : null,
  };
}

function mcpStatusSnapshot(db, liveStatus = null) {
  const settings = db?.getSettings ? db.getSettings('mcp.') : {};
  const enabledFromDb = normalizeMcpBoolean(process.env.AUTOPLAN_MCP_ENABLED ?? settings['mcp.enabled'], MCP_DEFAULT_CONFIG.enabled);
  const transportFromDb = normalizeMcpTransport(process.env.AUTOPLAN_MCP_TRANSPORT ?? settings['mcp.transport']);
  const hostFromDb = normalizeMcpHost(process.env.AUTOPLAN_MCP_HOST ?? settings['mcp.host']);
  const portFromDb = normalizeMcpPort(process.env.AUTOPLAN_MCP_PORT ?? settings['mcp.port']);
  const pathFromDb = normalizeMcpPath(process.env.AUTOPLAN_MCP_PATH ?? settings['mcp.path']);
  const authToken = normalizeMcpAuthToken(process.env.AUTOPLAN_MCP_AUTH_TOKEN ?? settings['mcp.authToken']);
  const latestEvent = db?.get
    ? db.get(
        `SELECT type, message, meta, created_at
         FROM events
         WHERE type IN ('mcp.started', 'mcp.start.failed', 'mcp.stopped')
         ORDER BY id DESC LIMIT 1`,
      )
    : null;
  const eventMeta = parseEventMeta(latestEvent?.meta);
  const eventMcp = eventMeta && typeof eventMeta === 'object' ? eventMeta.mcp : null;

  // 实时运行态优先于事件推导：注入 mcpStatusProvider 时以进程真实状态为准，
  // 未注入时退化为 db 配置 + 最近事件推导（保持原有行为，不抛错）。
  const live = liveStatus && typeof liveStatus === 'object' ? liveStatus : null;
  const enabled = live ? Boolean(live.enabled) : enabledFromDb;
  const running = live ? Boolean(live.running) : Boolean(enabledFromDb && latestEvent?.type === 'mcp.started');
  const lastError = live
    ? (live.lastError || null)
    : (latestEvent?.type === 'mcp.start.failed'
      ? eventMeta?.error || latestEvent.message || eventMcp?.lastError || 'MCP 服务启动失败'
      : null);

  const transport = live?.transport || transportFromDb;
  const isHttp = transport !== 'stdio';
  const eventHost = eventMcp && latestEvent?.type === 'mcp.started' ? eventMcp.host : null;
  const eventPort = eventMcp && latestEvent?.type === 'mcp.started' ? eventMcp.port : null;
  const eventPath = eventMcp && latestEvent?.type === 'mcp.started' ? eventMcp.path : null;
  const eventUrl = eventMcp && latestEvent?.type === 'mcp.started' ? eventMcp.url : null;
  const host = live?.host ?? (isHttp ? (eventHost ?? hostFromDb) : null);
  const port = live?.port ?? (isHttp ? (eventPort ?? portFromDb) : null);
  const mcpPath = live?.path ?? (isHttp ? (eventPath ?? pathFromDb) : null);
  const url = live?.url ?? (isHttp ? (eventUrl || `http://${host}:${port}${mcpPath}`) : null);
  const startedAt = live?.startedAt || (latestEvent?.type === 'mcp.started' ? eventMcp?.startedAt : null) || null;
  const localOnly = transport !== 'http' || LOCAL_MCP_HOSTS.has(String(host).toLowerCase());
  const fallbackPortInUse = isHttp
    && running
    && Number(port) !== Number(portFromDb)
    && Number(portFromDb) === MCP_DEFAULT_CONFIG.port;

  const hasAuthToken = Boolean(authToken);
  const authTokenMasked = maskAuthToken(authToken);

  return {
    enabled,
    running,
    status: mcpStatusLabel({ enabled, running, lastError }),
    transport,
    host,
    port,
    path: mcpPath,
    url,
    hasAuthToken,
    authTokenMasked,
    authHeader: 'Authorization: Bearer <token>',
    localOnly,
    tools: MCP_TOOL_NAMES,
    toolDocs: MCP_TOOL_DOCS,
    connectionExample: transport === 'http'
      ? (url || `http://${hostFromDb}:${portFromDb}${pathFromDb}`)
      : 'npm run mcp:stdio',
    note: mcpStatusNote({ transport, fallbackPortInUse, configuredPort: portFromDb, port }),
    lastEvent: latestEvent ? {
      type: latestEvent.type,
      message: latestEvent.message,
      createdAt: latestEvent.created_at,
    } : null,
    lastError,
    startedAt,
  };
}

function mcpStatusLabel({ enabled, running, lastError }) {
  if (!enabled) return 'disabled';
  if (lastError) return 'error';
  return running ? 'running' : 'configured';
}

function mcpStatusNote({ transport, fallbackPortInUse, configuredPort, port }) {
  if (transport !== 'http') return 'stdio 模式由 MCP 客户端启动 AutoPlan MCP 进程。';
  if (fallbackPortInUse) return `默认端口 ${configuredPort} 被占用，已自动使用可用端口 ${port}。`;
  return '默认仅监听本机地址，供本机 MCP 客户端连接。';
}

function normalizeMcpBoolean(value, fallback) {
  if (value === undefined || value === null || value === '') return Boolean(fallback);
  const normalized = String(value).trim().toLowerCase();
  if (['0', 'false', 'off', 'disabled'].includes(normalized)) return false;
  if (['1', 'true', 'on', 'enabled'].includes(normalized)) return true;
  return Boolean(fallback);
}

function normalizeMcpTransport(value) {
  return String(value || MCP_DEFAULT_CONFIG.transport).trim().toLowerCase() === 'stdio' ? 'stdio' : 'http';
}

function normalizeMcpHost(value) {
  return String(value || MCP_DEFAULT_CONFIG.host).trim() || MCP_DEFAULT_CONFIG.host;
}

function normalizeMcpPort(value) {
  const port = Number(value || MCP_DEFAULT_CONFIG.port);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : MCP_DEFAULT_CONFIG.port;
}

function normalizeMcpPath(value) {
  const trimmed = String(value || MCP_DEFAULT_CONFIG.path).trim();
  if (!trimmed || trimmed === '/') return MCP_DEFAULT_CONFIG.path;
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

function normalizeMcpAuthToken(value) {
  return String(value || MCP_DEFAULT_CONFIG.authToken).trim();
}

/** 脱敏 authToken：仅保留末 4 位（前缀 ····），无密钥时为空串，过短密钥完全遮蔽避免泄露。 */
function maskAuthToken(value) {
  const token = String(value || '').trim();
  if (!token) return '';
  if (token.length <= 4) return '····';
  return `····${token.slice(-4)}`;
}

/** 读取注入的实时 MCP 状态（mcpStatusProvider 返回 mcpServer.status()）；未注入或异常时退化为 null。 */
function readMcpLiveStatus(service) {
  if (!service || typeof service.mcpStatusProvider !== 'function') return null;
  try {
    const status = service.mcpStatusProvider();
    return status && typeof status === 'object' ? status : null;
  } catch {
    return null;
  }
}

function readTerminalMetadata(service, projectId) {
  if (!service || typeof service.terminalMetadataProvider !== 'function') return [];
  const projectKey = terminalProjectKey(projectId);
  try {
    const result = service.terminalMetadataProvider(projectId);
    const sessions = Array.isArray(result) ? result : (Array.isArray(result?.sessions) ? result.sessions : []);
    if (!Array.isArray(sessions)) return [];
    return sessions
      .map((session) => terminalSessionSnapshot(session))
      .filter((session) => session && (!projectKey || terminalProjectKey(session.projectId) === projectKey));
  } catch {
    return [];
  }
}

function terminalSessionSnapshot(session = {}) {
  if (!session || typeof session !== 'object') return null;
  const id = normalizeOptionalString(session.id);
  if (!id) return null;
  return {
    id,
    projectId: normalizeTerminalProjectId(session.projectId ?? session.project_id),
    title: normalizeOptionalString(session.title) || '',
    cwd: normalizeOptionalString(session.cwd) || '',
    shell: normalizeOptionalString(session.shell) || '',
    status: normalizeOptionalString(session.status) || '',
    createdAt: normalizeOptionalString(session.createdAt ?? session.created_at) || '',
    endedAt: normalizeOptionalString(session.endedAt ?? session.ended_at) || null,
    exitCode: normalizeNullableInteger(session.exitCode ?? session.exit_code),
    cols: normalizeNullableInteger(session.cols),
    rows: normalizeNullableInteger(session.rows),
    profile: terminalProfileSnapshot(session.profile),
  };
}

function terminalProfileSnapshot(profile = {}) {
  const source = profile && typeof profile === 'object' ? profile : {};
  return {
    id: normalizeOptionalString(source.id) || '',
    name: normalizeOptionalString(source.name) || '',
    kind: normalizeOptionalString(source.kind) || '',
    shellPath: normalizeOptionalString(source.shellPath ?? source.shell_path) || '',
    args: Array.isArray(source.args) ? source.args.map((arg) => String(arg ?? '')) : [],
    env: {},
  };
}

function normalizeTerminalProjectId(value) {
  const text = String(value ?? '').trim();
  const number = Number(text);
  return text && Number.isInteger(number) ? number : text;
}

function terminalProjectKey(value) {
  return String(value ?? '').trim();
}

function normalizeNullableInteger(value) {
  if (value === null || typeof value === 'undefined' || value === '') return null;
  const number = Number(value);
  return Number.isInteger(number) ? number : null;
}

function emptySnapshot(projects, mcp = null) {
  return {
    activeProjectId: null,
    activeProject: null,
    projects,
    mcp: mcp || mcpStatusSnapshot(null),
    state: null,
    requirements: [],
    feedback: [],
    attachments: [],
    plans: [],
    tasks: [],
    events: [],
    scans: [],
    scanSummary: emptyScanSummary(),
    scripts: [],
    executors: [],
    terminals: [],
    activeOperation: null,
    activeOperations: [],
    lastOperation: null,
  };
}

function emptyScanSummary() {
  return {
    count: 0,
    total_size: 0,
    latest_scanned_at: null,
    latest_modified_at: null,
  };
}

function scanSummarySnapshot(db, projectId) {
  if (!db || typeof db.get !== 'function') return emptyScanSummary();
  const summary = db.get(
    `SELECT
        COUNT(*) AS count,
        COALESCE(SUM(size), 0) AS total_size,
        MAX(scanned_at) AS latest_scanned_at,
        MAX(modified_at) AS latest_modified_at
       FROM scan_files
      WHERE project_id = ?`,
    [projectId],
  );
  return {
    count: normalizeNonNegativeInteger(summary?.count),
    total_size: normalizeNonNegativeInteger(summary?.total_size),
    latest_scanned_at: normalizeOptionalString(summary?.latest_scanned_at) || null,
    latest_modified_at: normalizeOptionalString(summary?.latest_modified_at) || null,
  };
}

function normalizeNonNegativeInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0;
}

function eventSnapshotRow(event) {
  if (!event) return event;
  return {
    ...event,
    meta: parseEventMeta(event.meta),
  };
}

function executorSnapshotRow(row = {}, runtime = null, projectId = null) {
  const executor = executorFromRow(row);
  const activeOperation = findExecutorOperation(runtime, projectId, executor.id);
  const activeSnapshot = activeOperation ? operationSnapshotRowWithPlanExecutionFields(activeOperation) : null;
  const runStatus = activeSnapshot ? 'running' : (executor.lastStatus || 'idle');
  return {
    ...executor,
    project_id: executor.projectId,
    sort_order: executor.sortOrder,
    group_kind: executor.group?.kind || null,
    group_is_default: executor.group?.isDefault ? 1 : 0,
    depends_order: executor.dependsOrder,
    last_status: executor.lastStatus,
    last_exit_code: executor.lastExitCode,
    last_duration_ms: executor.lastDurationMs,
    last_log: executor.lastLog,
    last_run_at: executor.lastRunAt,
    created_at: executor.createdAt,
    updated_at: executor.updatedAt,
    running: Boolean(activeSnapshot),
    runStatus,
    activeOperation: activeSnapshot,
  };
}

function operationSnapshotRowWithPlanExecutionFields(operation) {
  const row = operationSnapshotRow(operation);
  if (!row || !operation) return row;
  const executionProvider = normalizeOptionalPlanExecutionAgentCliProvider(
    operation.planExecutionProvider ?? operation.plan_execution_provider,
  );
  if (!row.agentCliProvider && executionProvider) row.agentCliProvider = executionProvider;
  const provider = row.agentCliProvider || executionProvider;
  const executionReasoningEffort = operation.planExecutionCodexReasoningEffort
    ?? operation.plan_execution_codex_reasoning_effort;
  if (provider === DEFAULT_AGENT_CLI_PROVIDER && !row.codexReasoningEffort && executionReasoningEffort) {
    row.codexReasoningEffort = normalizeOptionalCodexReasoningEffort(executionReasoningEffort);
  }
  return row;
}

function normalizeOptionalPlanExecutionAgentCliProvider(value) {
  const provider = String(value ?? '').trim().toLowerCase();
  return provider === DEFAULT_AGENT_CLI_PROVIDER || provider === 'claude' || provider === 'opencode' || provider === 'oh-my-pi'
    ? provider
    : null;
}

function findExecutorOperation(runtime, projectId, executorId) {
  if (!runtime?.activeOperations) return null;
  for (const operation of runtime.activeOperations.values()) {
    if (
      Number(operation?.projectId) === Number(projectId) &&
      operation?.operationType === 'executor' &&
      Number(operation?.executorId) === Number(executorId)
    ) {
      return operation;
    }
  }
  return null;
}

function planSnapshotRow(service, workspace, plan, concurrencySuggestion = null, agentCliConfig = null) {
  if (!plan) return plan;
  const planAgentCliConfig = agentCliConfig || effectiveAgentCliConfig({}, plan);
  const status = String(plan.status || 'pending');
  return {
    ...plan,
    ...planBackendSnapshotFields(plan),
    status,
    plan_generation_duration_ms: normalizeNonNegativeInteger(plan.plan_generation_duration_ms),
    sort_order: normalizePlanSortOrder(plan.sort_order),
    is_draft: status === 'draft',
    agent_cli_provider: planAgentCliConfig.provider,
    agent_cli_command: planAgentCliConfig.command,
    codex_reasoning_effort: planAgentCliConfig.codexReasoningEffort,
    agent_cli_session_id: planAgentCliConfig.provider === 'opencode'
      ? normalizeOptionalString(plan.agent_cli_session_id) || null
      : null,
    title: cachedPlanMarkdownTitle(service, workspace, plan),
    concurrency_suggestion: concurrencySuggestion || emptyConcurrencySuggestion(),
  };
}

function planBackendSnapshotFields(row = {}) {
  const fields = {};
  for (const column of PLAN_BACKEND_SNAPSHOT_COLUMNS) {
    if (!Object.prototype.hasOwnProperty.call(row || {}, column)) continue;
    // authToken 列脱敏：用 mask 串替换明文，并新增 *_has_claude_auth_token 布尔位供 UI 判断。
    if (PLAN_BACKEND_CLAUDE_AUTH_TOKEN_COLUMNS.includes(column)) {
      const rawToken = String(row[column] || '');
      fields[column] = maskAuthToken(rawToken);
      fields[`${column.replace('_claude_auth_token', '_has_claude_auth_token')}`] = Boolean(rawToken);
    } else {
      fields[column] = row[column];
    }
  }
  return fields;
}

function normalizePlanSortOrder(value) {
  const order = Number(value);
  return Number.isFinite(order) ? order : 0;
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

function cachedPlanMarkdownTitle(service, workspace, plan) {
  if (!service) return '';
  if (!service._planTitleCache) service._planTitleCache = new Map();
  const cache = service._planTitleCache;
  const version = plan?.hash || plan?.updated_at || '';
  const key = `${workspace || ''}\0${plan?.file_path || ''}\0${version}`;
  if (cache.has(key)) return touchCacheEntry(cache, key);
  // 不再在快照构造热路径中同步读盘提取标题。
  // 首次返回空字符串，UI 会优雅回退到 file_path；标题通过异步预加载填充缓存。
  schedulePlanTitlePreload(service, workspace, plan, key);
  return '';
}

function schedulePlanTitlePreload(service, workspace, plan, key) {
  if (!service._planTitlePending) service._planTitlePending = new Set();
  if (service._planTitlePending.has(key)) return;
  service._planTitlePending.add(key);
  // 使用 setImmediate 将磁盘 I/O 推迟到当前事件循环之后，不阻塞快照返回
  setImmediate(() => {
    try {
      const title = readPlanMarkdownTitle(workspace, plan?.file_path);
      if (service._planTitleCache) {
        setBoundedCacheEntry(service._planTitleCache, key, title, 200);
      }
    } catch {
      // 读盘失败静默跳过，UI 使用 file_path 回退
    } finally {
      if (service._planTitlePending) service._planTitlePending.delete(key);
    }
  });
}

function cachedPlanConcurrencySuggestion(service, workspace, plan, tasks) {
  if (!service) return planConcurrencySuggestion(workspace, tasks);
  if (!service._planConcurrencyCache) service._planConcurrencyCache = new Map();
  const cache = service._planConcurrencyCache;
  const taskFingerprint = tasks
    .map((task) => [
      task.id,
      task.status,
      task.scope,
      task.raw_line,
      task.title,
    ].join(':'))
    .join('|');
  const key = `${workspace || ''}\0${plan?.id || ''}\0${taskFingerprint}`;
  if (cache.has(key)) return touchCacheEntry(cache, key);
  const suggestion = planConcurrencySuggestion(workspace, tasks);
  setBoundedCacheEntry(cache, key, suggestion, 200);
  return suggestion;
}

function cachedTaskScopeFileInfos(service, workspace, task) {
  if (!service) return [{ path: 'unknown', exists: false, isDirectory: false, canOpen: false, isUnknown: true, isValidation: false, reason: '' }];
  if (!service._taskScopeFileInfoCache) service._taskScopeFileInfoCache = new Map();
  const cache = service._taskScopeFileInfoCache;
  const key = [
    workspace || '',
    task?.id || '',
    task?.scope || '',
    task?.raw_line || '',
    task?.title || '',
  ].join('\0');
  if (cache.has(key)) return touchCacheEntry(cache, key);
  // 首次访问返回占位信息，避免同步磁盘 stat 阻塞快照构造。
  // scope 文件状态通过异步预加载后，下一次快照即包含完整信息。
  scheduleTaskScopePreload(service, workspace, task, key);
  return [{ path: task?.scope || 'unknown', exists: false, isDirectory: false, canOpen: false, isUnknown: true, isValidation: false, reason: '' }];
}

function scheduleTaskScopePreload(service, workspace, task, key) {
  if (!service._taskScopePreloadPending) service._taskScopePreloadPending = new Set();
  if (service._taskScopePreloadPending.has(key)) return;
  service._taskScopePreloadPending.add(key);
  setImmediate(() => {
    try {
      const infos = taskScopeFileInfos(workspace, task);
      if (service._taskScopeFileInfoCache) {
        setBoundedCacheEntry(service._taskScopeFileInfoCache, key, infos, 500);
      }
    } catch {
      // 读盘失败静默跳过
    } finally {
      if (service._taskScopePreloadPending) service._taskScopePreloadPending.delete(key);
    }
  });
}

function touchCacheEntry(cache, key) {
  const value = cache.get(key);
  cache.delete(key);
  cache.set(key, value);
  return value;
}

function setBoundedCacheEntry(cache, key, value, limit) {
  cache.set(key, value);
  while (cache.size > limit) cache.delete(cache.keys().next().value);
}

module.exports = {
  cachedPlanConcurrencySuggestion,
  cachedPlanMarkdownTitle,
  cachedTaskScopeFileInfos,
  emptySnapshot,
  eventSnapshotRow,
  groupPlanTasksByPlanId,
  mcpStatusSnapshot,
  planBackendSnapshotFields,
  planSnapshotRow,
  readPlanMarkdownTitle,
  snapshot,
  taskSnapshotRow,
};
