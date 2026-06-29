const fs = require('node:fs');
const path = require('node:path');
const { nowIso } = require('../database');
const { DEFAULT_AGENT_CLI_PROVIDER, agentCliContextFields, codexSessionContextFields, effectiveAgentCliConfig, intakeSnapshotRow, normalizeOptionalString } = require('./agentCliConfig');
const { TASK_EVENT_STATUS, normalizeDurationMs, taskRunDurationMs } = require('./taskEvents');
const { operationSnapshotRow, runtimeOperationContextByTask } = require('./runtime');
const { emptyConcurrencySuggestion, planConcurrencySuggestion, taskScopeFileInfos } = require('./concurrency');
const { extractMarkdownTitle } = require('./planParser');
const { readSnippet, resolveWorkspaceChildPath } = require('./workspaceFiles');
const { MCP_TOOL_NAMES: MCP_TOOL_NAME_MAP } = require('../mcpTools');
const { MCP_TOOL_DOCS } = require('../mcpToolDocs');

const MCP_DEFAULT_CONFIG = Object.freeze({ enabled: true, transport: 'http', host: '127.0.0.1', port: 43847, path: '/mcp', authToken: '' });
const MCP_TOOL_NAMES = Object.freeze(Object.values(MCP_TOOL_NAME_MAP));
const LOCAL_MCP_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

function snapshot(service, helpers, projectId = null) {
    const projects = service.projects();
    const mcp = mcpStatusSnapshot(service.db, readMcpLiveStatus(service));
    if (!projectId) return emptySnapshot(projects, mcp);

    const activeProject = service.project(projectId);
    if (!activeProject) return emptySnapshot(projects, mcp);

    const state = {
      ...(service.status(projectId) || {}),
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
      ).map((row) => intakeLinkedPlanSnapshotRow(row, planSnapshotById)),
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
      ).map((row) => intakeLinkedPlanSnapshotRow(row, planSnapshotById)),
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
      scans: service.db.all(
        'SELECT * FROM scan_files WHERE project_id = ? ORDER BY scanned_at DESC, file_path ASC',
        [projectId],
      ),
      scripts: service.db.all(
        'SELECT * FROM scripts WHERE project_id = ? ORDER BY sort_order ASC, id ASC',
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

function taskSnapshotRow(service, workspace, task, operationContext = null) {
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
    scope_files: cachedTaskScopeFileInfos(service, workspace, task),
    started_at: startedAt,
    finished_at: finishedAt,
    duration_ms: normalizeDurationMs(task.duration_ms),
    ...(runDurationMs !== undefined ? { run_duration_ms: normalizeDurationMs(runDurationMs) } : {}),
    ...agentContext,
    ...sessionContext,
  };
}

function intakeLinkedPlanSnapshotRow(row = {}, planSnapshotById = new Map()) {
  const normalized = intakeSnapshotRow(row);
  const linkedPlanId = Number(normalized.linked_plan_id);
  const linkedPlan = Number.isFinite(linkedPlanId) ? planSnapshotById.get(linkedPlanId) : null;
  if (!linkedPlan) return normalized;

  const title = linkedPlan.title || null;
  const filePath = linkedPlan.file_path || normalized.plan_file_path || null;
  const status = linkedPlan.status || normalized.plan_status || null;
  const completed = linkedPlan.completed_tasks ?? normalized.plan_completed ?? null;
  const total = linkedPlan.total_tasks ?? normalized.plan_total ?? null;

  return {
    ...normalized,
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
  const host = live?.host ?? (isHttp ? hostFromDb : null);
  const port = live?.port ?? (isHttp ? portFromDb : null);
  const mcpPath = isHttp ? pathFromDb : null;
  const url = live?.url ?? (isHttp ? `http://${hostFromDb}:${portFromDb}${pathFromDb}` : null);
  const startedAt = live?.startedAt || null;
  const localOnly = transport !== 'http' || LOCAL_MCP_HOSTS.has(String(host).toLowerCase());

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
    note: transport === 'http'
      ? '默认仅监听本机地址，供本机 MCP 客户端连接。'
      : 'stdio 模式由 MCP 客户端启动 AutoPlan MCP 进程。',
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
    scripts: [],
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

function planSnapshotRow(service, workspace, plan, concurrencySuggestion = null, agentCliConfig = null) {
  if (!plan) return plan;
  const planAgentCliConfig = agentCliConfig || effectiveAgentCliConfig({}, plan);
  const status = String(plan.status || 'pending');
  return {
    ...plan,
    status,
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
  if (!service) return readPlanMarkdownTitle(workspace, plan?.file_path);
  if (!service._planTitleCache) service._planTitleCache = new Map();
  const cache = service._planTitleCache;
  const version = plan?.hash || plan?.updated_at || '';
  const key = `${workspace || ''}\0${plan?.file_path || ''}\0${version}`;
  if (cache.has(key)) return cache.get(key);
  const title = readPlanMarkdownTitle(workspace, plan?.file_path);
  cache.set(key, title);
  if (cache.size > 200) cache.delete(cache.keys().next().value);
  return title;
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
      task.updated_at,
    ].join(':'))
    .join('|');
  const key = `${workspace || ''}\0${plan?.id || ''}\0${taskFingerprint}`;
  if (cache.has(key)) return cache.get(key);
  const suggestion = planConcurrencySuggestion(workspace, tasks);
  cache.set(key, suggestion);
  if (cache.size > 200) cache.delete(cache.keys().next().value);
  return suggestion;
}

function cachedTaskScopeFileInfos(service, workspace, task) {
  if (!service) return taskScopeFileInfos(workspace, task);
  if (!service._taskScopeFileInfoCache) service._taskScopeFileInfoCache = new Map();
  const cache = service._taskScopeFileInfoCache;
  const key = [
    workspace || '',
    task?.id || '',
    task?.scope || '',
    task?.raw_line || '',
    task?.title || '',
    task?.updated_at || '',
  ].join('\0');
  if (cache.has(key)) return cache.get(key);
  const infos = taskScopeFileInfos(workspace, task);
  cache.set(key, infos);
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  return infos;
}

module.exports = {
  cachedPlanConcurrencySuggestion,
  cachedPlanMarkdownTitle,
  cachedTaskScopeFileInfos,
  emptySnapshot,
  eventSnapshotRow,
  groupPlanTasksByPlanId,
  mcpStatusSnapshot,
  parseEventMeta,
  planSnapshotRow,
  readPlanMarkdownTitle,
  snapshot,
  taskSnapshotRow,
};
