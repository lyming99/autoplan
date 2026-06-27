const fs = require('node:fs');
const path = require('node:path');
const { nowIso } = require('../database');
const { DEFAULT_AGENT_CLI_PROVIDER, agentCliContextFields, codexSessionContextFields, effectiveAgentCliConfig, intakeSnapshotRow, normalizeOptionalString } = require('./agentCliConfig');
const { TASK_EVENT_STATUS, normalizeDurationMs, taskRunDurationMs } = require('./taskEvents');
const { operationSnapshotRow, runtimeOperationContextByTask } = require('./runtime');
const { planConcurrencySuggestion, taskScopeFileInfos } = require('./concurrency');
const { extractMarkdownTitle } = require('./planParser');
const { resolveWorkspaceChildPath } = require('./workspaceFiles');

const MCP_DEFAULT_CONFIG = Object.freeze({ enabled: true, transport: 'http', host: '127.0.0.1', port: 43847, path: '/mcp' });
const MCP_TOOL_NAMES = Object.freeze(['create_project', 'create_requirement', 'create_feedback']);
const LOCAL_MCP_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

function snapshot(service, helpers, projectId = null) {
    const projects = service.projects();
    const mcp = mcpStatusSnapshot(service.db);
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
        planConcurrencySuggestion(activeProject.workspace_path, tasksByPlanId.get(Number(plan.id)) || []),
      ]),
    );
    const planSnapshots = planRows.map((plan) => planSnapshotRow(
      activeProject.workspace_path,
      plan,
      concurrencySuggestionByPlanId.get(Number(plan.id)),
      service.planSnapshotAgentCliConfig(plan),
    ));
    const planTitleById = new Map(planSnapshots.map((plan) => [Number(plan.id), plan.title || '']));

    return {
      activeProjectId: projectId,
      activeProject,
      projects,
      mcp,
      state,
      requirements: service.db.all(
        `SELECT requirements.*, plans.status AS plan_status,
                plans.completed_tasks AS plan_completed, plans.total_tasks AS plan_total
         FROM requirements
         LEFT JOIN plans ON plans.id = requirements.linked_plan_id
         WHERE requirements.project_id = ?
          ORDER BY requirements.updated_at DESC`,
        [projectId],
      ).map((row) => intakeSnapshotRow(row)),
      feedback: service.db.all(
        `SELECT feedback.*, plans.status AS plan_status,
                plans.completed_tasks AS plan_completed, plans.total_tasks AS plan_total
         FROM feedback
         LEFT JOIN plans ON plans.id = feedback.linked_plan_id
         WHERE feedback.project_id = ?
          ORDER BY feedback.updated_at DESC`,
        [projectId],
      ).map((row) => intakeSnapshotRow(row)),
      attachments: service.db.all(
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
      events: service.db
        .all('SELECT * FROM events WHERE project_id = ? ORDER BY id DESC LIMIT 80', [projectId])
        .map((event) => eventSnapshotRow(event)),
      scans: service.db.all(
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

function mcpStatusSnapshot(db) {
  const settings = db?.getSettings ? db.getSettings('mcp.') : {};
  const enabled = normalizeMcpBoolean(process.env.AUTOPLAN_MCP_ENABLED ?? settings['mcp.enabled'], MCP_DEFAULT_CONFIG.enabled);
  const transport = normalizeMcpTransport(process.env.AUTOPLAN_MCP_TRANSPORT ?? settings['mcp.transport']);
  const host = normalizeMcpHost(process.env.AUTOPLAN_MCP_HOST ?? settings['mcp.host']);
  const port = normalizeMcpPort(process.env.AUTOPLAN_MCP_PORT ?? settings['mcp.port']);
  const mcpPath = normalizeMcpPath(process.env.AUTOPLAN_MCP_PATH ?? settings['mcp.path']);
  const latestEvent = db?.get
    ? db.get(
        `SELECT type, message, meta, created_at
         FROM events
         WHERE type IN ('mcp.started', 'mcp.start.failed')
         ORDER BY id DESC LIMIT 1`,
      )
    : null;
  const eventMeta = parseEventMeta(latestEvent?.meta);
  const eventMcp = eventMeta && typeof eventMeta === 'object' ? eventMeta.mcp : null;
  const url = transport === 'http' ? `http://${host}:${port}${mcpPath}` : null;
  const running = Boolean(enabled && latestEvent?.type === 'mcp.started');
  const lastError = latestEvent?.type === 'mcp.start.failed'
    ? eventMeta?.error || latestEvent.message || eventMcp?.lastError || 'MCP 服务启动失败'
    : null;

  return {
    enabled,
    running,
    status: mcpStatusLabel({ enabled, running, lastError }),
    transport,
    host: transport === 'http' ? host : null,
    port: transport === 'http' ? port : null,
    path: transport === 'http' ? mcpPath : null,
    url,
    localOnly: transport !== 'http' || LOCAL_MCP_HOSTS.has(String(host).toLowerCase()),
    tools: MCP_TOOL_NAMES,
    connectionExample: transport === 'http'
      ? `http://${host}:${port}${mcpPath}`
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
  const status = String(plan.status || 'pending');
  return {
    ...plan,
    status,
    sort_order: normalizePlanSortOrder(plan.sort_order),
    is_draft: status === 'draft',
    agent_cli_provider: planAgentCliConfig.provider,
    agent_cli_command: planAgentCliConfig.command,
    codex_reasoning_effort: planAgentCliConfig.codexReasoningEffort,
    title: readPlanMarkdownTitle(workspace, plan.file_path),
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

module.exports = {
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
