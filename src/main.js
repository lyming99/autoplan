const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow, dialog, ipcMain, Menu, net, protocol, shell } = require('electron');
const { saveAttachments } = require('./attachments');
const { AppDatabase, nowIso } = require('./database');
const { createIntakeService, titleFromBody } = require('./intakeService');
const { LoopService, nextIntakeAgentCliConfig } = require('./loopService');
const { parseCron } = require('./loop/scriptHooks');
const { mcpServerConfig, saveMcpSettings } = require('./mcpConfig');
const { createMcpServer } = require('./mcpServer');

if (protocol?.registerSchemesAsPrivileged) {
  protocol.registerSchemesAsPrivileged([
    { scheme: 'autoplan-file', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  ]);
}

let mainWindow;
let db;
let loop;
let mcpServer;
let fileProtocolRegistered = false;

async function createApp() {
  Menu.setApplicationMenu(null);
  db = new AppDatabase(path.join(app.getPath('userData'), 'data', 'autoplan.sqlite'));
  await db.init();
  registerFileProtocol();
  loop = new LoopService(db);
  loop.on('update', (snapshot) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('loop:update', snapshot);
    }
  });
  // 模块级 mcpServer 在启停过程中被重新赋值，故以闭包懒读取其最新状态注入快照。
  loop.setMcpStatusProvider(() => mcpServer?.status?.());

  mainWindow = new BrowserWindow({
    width: 1220,
    height: 820,
    minWidth: 980,
    minHeight: 680,
    icon: path.join(__dirname, '..', 'assets', 'icon.ico'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  await loadRenderer(mainWindow);
  scheduleMcpServerStart();
}

app.whenReady().then(() => createApp().catch((error) => console.error('[app] startup failed', error)));

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (mcpServer) mcpServer.stop().catch((error) => console.error('[mcp] stop failed', error));
  if (loop) loop.stop();
});

ipcMain.handle('snapshot', (_event, input = {}) => loop.snapshot(input.projectId || null));

ipcMain.handle('plans:read', async (_event, input = {}) => readPlan(input));

ipcMain.handle('plans:reorder', (_event, input = {}) => {
  const projectId = requiredProjectId(input);
  const planIds = Array.isArray(input.planIds) ? input.planIds : input.plan_ids;
  return loop.reorderPlans(projectId, planIds);
});

ipcMain.handle('workspace:openFile', async (_event, input = {}) => openWorkspaceFile(input));

ipcMain.handle('projects:create', (_event, input = {}) => {
  return intakeService().createProject(input);
});

ipcMain.handle('projects:update', (_event, input = {}) => {
  const projectId = requiredProjectId(input);
  const current = loop.project(projectId);
  if (loop.hasRuntimeConfigInput(input)) {
    loop.configure(projectId, input);
  }
  db.run(
    `UPDATE projects
     SET name = ?, workspace_path = ?, description = ?, updated_at = ?
     WHERE id = ?`,
    [
      String(input.name || current.name).trim(),
      input.workspacePath ?? current.workspace_path,
      input.description ?? current.description,
      nowIso(),
      projectId,
    ],
  );
  return loop.snapshot(projectId);
});

ipcMain.handle('projects:delete', (_event, input = {}) => {
  const projectId = requiredProjectId(input);
  const state = loop.status(projectId);
  if (state && state.running) throw new Error('请先停止该项目循环再删除');
  loop.stop(projectId);
  const taskIds = db
    .all('SELECT id FROM plans WHERE project_id = ?', [projectId])
    .map((row) => row.id);
  for (const table of ['requirements', 'feedback', 'attachments', 'events', 'scan_files']) {
    db.run(`DELETE FROM ${table} WHERE project_id = ?`, [projectId]);
  }
  if (taskIds.length) {
    const placeholders = taskIds.map(() => '?').join(',');
    db.run(`DELETE FROM plan_tasks WHERE plan_id IN (${placeholders})`, taskIds);
  }
  db.run('DELETE FROM plans WHERE project_id = ?', [projectId]);
  db.run('DELETE FROM project_states WHERE project_id = ?', [projectId]);
  db.run('DELETE FROM projects WHERE id = ?', [projectId]);
  return loop.snapshot(null);
});
ipcMain.handle('projects:pickDirectory', async () => (await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] }))?.filePaths?.[0] || null);
ipcMain.handle('projects:openFolder', (_event, input = {}) => openProjectFolder(input));

ipcMain.handle('loop:configure', (_event, config = {}) => {
  const projectId = requiredProjectId(config);
  const mcpConfigChanged = saveMcpSettings(db, config);
  loop.configure(projectId, config);
  if (mcpConfigChanged) scheduleMcpServerRestart();
  return loop.snapshot(projectId);
});

ipcMain.handle('loop:start', (_event, input = {}) => {
  requireManualAction(input, '启动循环');
  const projectId = requiredProjectId(input);
  loop.start(projectId);
  return loop.snapshot(projectId);
});

ipcMain.handle('loop:stop', (_event, input = {}) => {
  const projectId = requiredProjectId(input);
  loop.stop(projectId);
  return loop.snapshot(projectId);
});

ipcMain.handle('loop:runOnce', async (_event, input = {}) => {
  requireManualAction(input, '单轮执行');
  const projectId = requiredProjectId(input);
  await loop.runOnce(projectId);
  return loop.snapshot(projectId);
});

ipcMain.handle('mcp:start', async (_event, input = {}) => {
  try {
    await startMcpServer();
  } catch (error) {
    recordMcpStartupError(error);
  }
  return loop.snapshot(input.projectId || null);
});

ipcMain.handle('mcp:stop', async (_event, input = {}) => {
  await stopMcpServer();
  return loop.snapshot(input.projectId || null);
});

ipcMain.handle('mcp:status', (_event, input = {}) => loop.snapshot(input.projectId || null));

ipcMain.handle('mcp:saveConfig', (_event, config = {}) => {
  const projectId = config.projectId || null;
  const mcpConfigChanged = saveMcpSettings(db, config);
  if (mcpConfigChanged) scheduleMcpServerRestart();
  return loop.snapshot(projectId);
});

ipcMain.handle('tasks:run', async (_event, input = {}) => {
  const projectId = requiredProjectId(input);
  await loop.runTask(projectId, requiredRecordId(input, 'taskId'));
  return loop.snapshot(projectId);
});

ipcMain.handle('tasks:runParallel', async (_event, input = {}) => {
  requireManualAction(input, '并发执行');
  const projectId = requiredProjectId(input);
  await loop.runTaskBatches(projectId, requiredRecordId(input, 'planId'), input.batches || []);
  return loop.snapshot(projectId);
});

ipcMain.handle('tasks:stop', (_event, input = {}) => {
  const projectId = requiredProjectId(input);
  loop.stopTask(projectId, requiredRecordId(input, 'taskId'));
  return loop.snapshot(projectId);
});

ipcMain.handle('acceptance:accept', (_event, input = {}) => {
  const projectId = requiredProjectId(input);
  loop.acceptItem(projectId, { targetType: input.targetType, id: requiredRecordId(input) });
  return loop.snapshot(projectId);
});

ipcMain.handle('acceptance:unaccept', (_event, input = {}) => {
  const projectId = requiredProjectId(input);
  loop.unacceptItem(projectId, { targetType: input.targetType, id: requiredRecordId(input) });
  return loop.snapshot(projectId);
});

ipcMain.handle('acceptance:acceptBatch', (_event, input = {}) => {
  const projectId = requiredProjectId(input);
  const targets = normalizeAcceptanceBatchTargets(input.targets, '批量验收目标列表为空');
  loop.acceptItems(projectId, targets);
  return loop.snapshot(projectId);
});

ipcMain.handle('acceptance:unacceptBatch', (_event, input = {}) => {
  const projectId = requiredProjectId(input);
  const targets = normalizeAcceptanceBatchTargets(input.targets, '批量取消验收目标列表为空');
  loop.unacceptItems(projectId, targets);
  return loop.snapshot(projectId);
});

ipcMain.handle('requirements:create', (_event, input = {}) => {
  return intakeService().createRequirement(normalizeDraftIntakeInput(input));
});

ipcMain.handle('requirements:update', (_event, input = {}) => {
  const projectId = requiredProjectId(input);
  const id = requiredRecordId(input);
  const current = db.get('SELECT * FROM requirements WHERE id = ? AND project_id = ?', [id, projectId]);
  if (!current) throw new Error('需求不存在');
  const body = input.body ?? current.body ?? '';
  const agentCliConfig = nextIntakeAgentCliConfig(current, input);
  db.run(
    `UPDATE requirements
     SET title = ?, body = ?, status = ?, agent_cli_provider = ?, agent_cli_command = ?, codex_reasoning_effort = ?, updated_at = ?
     WHERE id = ? AND project_id = ?`,
    [
      input.title ?? titleFromBody(body, '未命名需求'),
      body,
      input.status ?? current.status ?? 'open',
      agentCliConfig.provider,
      agentCliConfig.command,
      agentCliConfig.codexReasoningEffort,
      nowIso(),
      id,
      projectId,
    ],
  );
  saveAttachments(db, attachmentsRoot(), 'requirement', id, input.attachments, projectId);
  return loop.snapshot(projectId);
});

ipcMain.handle('requirements:delete', (_event, input = {}) => {
  const projectId = requiredProjectId(input);
  const id = requiredRecordId(input);
  return loop.deleteIntake(projectId, 'requirement', id, { attachmentsRoot: attachmentsRoot() });
});

ipcMain.handle('feedback:create', (_event, input = {}) => {
  return intakeService().createFeedback(normalizeDraftIntakeInput(input));
});

ipcMain.handle('feedback:update', (_event, input = {}) => {
  const projectId = requiredProjectId(input);
  const id = requiredRecordId(input);
  const current = db.get('SELECT * FROM feedback WHERE id = ? AND project_id = ?', [id, projectId]);
  if (!current) throw new Error('反馈不存在');
  const body = input.body ?? current.body ?? '';
  const agentCliConfig = nextIntakeAgentCliConfig(current, input);
  db.run(
    `UPDATE feedback
     SET requirement_id = ?, title = ?, body = ?, status = ?, agent_cli_provider = ?, agent_cli_command = ?, codex_reasoning_effort = ?, updated_at = ?
     WHERE id = ? AND project_id = ?`,
    [
      input.requirementId === undefined ? current.requirement_id || null : input.requirementId || null,
      input.title ?? titleFromBody(body, '未命名反馈'),
      body,
      input.status ?? current.status ?? 'open',
      agentCliConfig.provider,
      agentCliConfig.command,
      agentCliConfig.codexReasoningEffort,
      nowIso(),
      id,
      projectId,
    ],
  );
  saveAttachments(db, attachmentsRoot(), 'feedback', id, input.attachments, projectId);
  return loop.snapshot(projectId);
});

ipcMain.handle('feedback:delete', (_event, input = {}) => {
  const projectId = requiredProjectId(input);
  const id = requiredRecordId(input);
  return loop.deleteIntake(projectId, 'feedback', id, { attachmentsRoot: attachmentsRoot() });
});

// 中断需求/反馈关联的计划任务
ipcMain.handle('intake:interrupt', (_event, input = {}) => {
  const projectId = requiredProjectId(input);
  const table = input.type === 'feedback' ? 'feedback' : 'requirements';
  const rec = db.get(`SELECT linked_plan_id FROM ${table} WHERE id = ? AND project_id = ?`, [
    requiredRecordId(input),
    projectId,
  ]);
  if (rec?.linked_plan_id) loop.interruptPlan(projectId, rec.linked_plan_id);
  return loop.snapshot(projectId);
});

// 恢复被中断的计划
ipcMain.handle('intake:resume', (_event, input = {}) => {
  const projectId = requiredProjectId(input);
  const table = input.type === 'feedback' ? 'feedback' : 'requirements';
  const rec = db.get(`SELECT linked_plan_id FROM ${table} WHERE id = ? AND project_id = ?`, [
    requiredRecordId(input),
    projectId,
  ]);
  if (rec?.linked_plan_id) loop.resumePlan(projectId, rec.linked_plan_id);
  return loop.snapshot(projectId);
});

// 追加任务到需求/反馈关联的计划
ipcMain.handle('intake:appendTask', (_event, input = {}) => {
  const projectId = requiredProjectId(input);
  const table = input.type === 'feedback' ? 'feedback' : 'requirements';
  const rec = db.get(`SELECT linked_plan_id FROM ${table} WHERE id = ? AND project_id = ?`, [
    requiredRecordId(input),
    projectId,
  ]);
  if (!rec?.linked_plan_id) throw new Error('该需求/反馈尚未生成计划');
  loop.appendTask(projectId, rec.linked_plan_id, input.title);
  return loop.snapshot(projectId);
});

const SCRIPT_RUNTIMES = new Set(['node', 'bash', 'ps', 'cmd']);
const SCRIPT_TRIGGER_MODES = new Set(['hook', 'manual', 'schedule']);
const SCRIPT_HOOK_STAGES = new Set(['plan:after', 'task:after', 'validation:before', 'loop:end', 'on:fail']);
const SCRIPT_CONTEXT_INJECTS = new Set(['env', 'stdin', 'none']);
const SCRIPT_SOURCE_TYPES = new Set(['inline', 'file']);

function trimScriptText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function pickScriptEnum(value, allowed, fallback) {
  const normalized = trimScriptText(value);
  return allowed.has(normalized) ? normalized : fallback;
}

function scriptFlagNumber(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback ? 1 : 0;
  return value === false || value === 0 || value === '0' || value === 'false' ? 0 : 1;
}

function scriptTimeoutSeconds(value, fallback = 60) {
  const num = Number(value);
  if (Number.isFinite(num) && num > 0) return Math.floor(num);
  const fallbackNum = Number(fallback);
  return Number.isFinite(fallbackNum) && fallbackNum > 0 ? Math.floor(fallbackNum) : 60;
}

function normalizeScriptFields(input = {}, current = {}) {
  const name = trimScriptText(input.name ?? current.name);
  if (!name) throw new Error('脚本名称不能为空');
  const triggerMode = pickScriptEnum(input.triggerMode ?? input.trigger_mode ?? current.trigger_mode, SCRIPT_TRIGGER_MODES, 'manual');
  const scheduleCron = resolveScheduleCron(triggerMode, input, current);
  return {
    name,
    path: trimScriptText(input.path ?? current.path),
    runtime: pickScriptEnum(input.runtime ?? current.runtime, SCRIPT_RUNTIMES, 'node'),
    source_type: pickScriptEnum(input.sourceType ?? input.source_type ?? current.source_type, SCRIPT_SOURCE_TYPES, 'inline'),
    body: trimScriptText(input.body ?? current.body),
    description: trimScriptText(input.description ?? current.description),
    trigger_mode: triggerMode,
    hook_stage: pickScriptEnum(input.hookStage ?? input.hook_stage ?? current.hook_stage, SCRIPT_HOOK_STAGES, null),
    schedule_cron: scheduleCron,
    enabled: scriptFlagNumber(input.enabled ?? current.enabled, current.enabled ?? 1),
    work_dir: trimScriptText(input.workDir ?? input.work_dir ?? current.work_dir),
    timeout_seconds: scriptTimeoutSeconds(input.timeoutSeconds ?? input.timeout_seconds, current.timeout_seconds),
    fail_aborts: scriptFlagNumber(input.failAborts ?? input.fail_aborts ?? current.fail_aborts, current.fail_aborts ?? 0),
    context_inject: pickScriptEnum(input.contextInject ?? input.context_inject ?? current.context_inject, SCRIPT_CONTEXT_INJECTS, 'none'),
    sort_order: Math.floor(Number(input.sortOrder ?? input.sort_order ?? current.sort_order)) || 0,
  };
}

/** 解析 schedule_cron：仅 trigger_mode='schedule' 时落库为 cron 串，其它模式为 null（与 hook_stage 在 manual 时为 null 对齐）。
 *  schedule 模式下 cron 为空抛「定时任务需填写 cron 表达式」、非法 cron 复用 scriptHooks.parseCron 抛中文错误，均不写入脏数据。 */
function resolveScheduleCron(triggerMode, input, current) {
  if (triggerMode !== 'schedule') return null;
  const cron = trimScriptText(input.scheduleCron ?? input.schedule_cron ?? current.schedule_cron);
  if (!cron) throw new Error('定时任务需填写 cron 表达式');
  parseCron(cron);
  return cron;
}

const SCRIPT_COLUMN_LIST = 'name, path, runtime, body, description, trigger_mode, hook_stage, schedule_cron, enabled, work_dir, timeout_seconds, fail_aborts, context_inject, sort_order, source_type';
const SCRIPT_SET_ASSIGNMENTS = 'name = ?, path = ?, runtime = ?, body = ?, description = ?, trigger_mode = ?, hook_stage = ?, schedule_cron = ?, enabled = ?, work_dir = ?, timeout_seconds = ?, fail_aborts = ?, context_inject = ?, sort_order = ?, source_type = ?';

ipcMain.handle('scripts:pickFile', async (_event, input = {}) => (await dialog.showOpenDialog(mainWindow, { properties: ['openFile'], filters: [{ name: '脚本文件', extensions: ['js', 'cjs', 'mjs', 'sh', 'ps1', 'bat', 'cmd'] }, { name: '所有文件', extensions: ['*'] }] }))?.filePaths?.[0] || null);

ipcMain.handle('scripts:create', (_event, input = {}) => {
  const projectId = requiredProjectId(input);
  const fields = normalizeScriptFields(input);
  const ts = nowIso();
  db.run(
    `INSERT INTO scripts (project_id, ${SCRIPT_COLUMN_LIST}, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [projectId, fields.name, fields.path, fields.runtime, fields.body, fields.description, fields.trigger_mode, fields.hook_stage, fields.schedule_cron, fields.enabled, fields.work_dir, fields.timeout_seconds, fields.fail_aborts, fields.context_inject, fields.sort_order, fields.source_type, ts, ts],
  );
  return loop.snapshot(projectId);
});

ipcMain.handle('scripts:update', (_event, input = {}) => {
  const projectId = requiredProjectId(input);
  const scriptId = requiredRecordId(input, 'scriptId');
  const current = db.get('SELECT * FROM scripts WHERE id = ? AND project_id = ?', [scriptId, projectId]);
  if (!current) throw new Error('脚本不存在');
  const fields = normalizeScriptFields(input, current);
  db.run(
    `UPDATE scripts SET ${SCRIPT_SET_ASSIGNMENTS}, updated_at = ? WHERE id = ? AND project_id = ?`,
    [fields.name, fields.path, fields.runtime, fields.body, fields.description, fields.trigger_mode, fields.hook_stage, fields.schedule_cron, fields.enabled, fields.work_dir, fields.timeout_seconds, fields.fail_aborts, fields.context_inject, fields.sort_order, fields.source_type, nowIso(), scriptId, projectId],
  );
  return loop.snapshot(projectId);
});

ipcMain.handle('scripts:delete', (_event, input = {}) => {
  const projectId = requiredProjectId(input);
  const scriptId = requiredRecordId(input, 'scriptId');
  const rec = db.get('SELECT id FROM scripts WHERE id = ? AND project_id = ?', [scriptId, projectId]);
  if (!rec) throw new Error('脚本不存在');
  db.run('DELETE FROM scripts WHERE id = ? AND project_id = ?', [scriptId, projectId]);
  return loop.snapshot(projectId);
});

ipcMain.handle('scripts:toggle', (_event, input = {}) => {
  const projectId = requiredProjectId(input);
  const scriptId = requiredRecordId(input, 'scriptId');
  const rec = db.get('SELECT enabled FROM scripts WHERE id = ? AND project_id = ?', [scriptId, projectId]);
  if (!rec) throw new Error('脚本不存在');
  db.run('UPDATE scripts SET enabled = ?, updated_at = ? WHERE id = ? AND project_id = ?', [rec.enabled ? 0 : 1, nowIso(), scriptId, projectId]);
  return loop.snapshot(projectId);
});

ipcMain.handle('scripts:run', async (_event, input = {}) => {
  const projectId = requiredProjectId(input);
  const scriptId = requiredRecordId(input, 'scriptId');
  return loop.runScriptManually(projectId, scriptId);
});

ipcMain.handle('scripts:stop', (_event, input = {}) => {
  const projectId = requiredProjectId(input);
  const scriptId = requiredRecordId(input, 'scriptId');
  loop.stopScript(projectId, scriptId);
  return loop.snapshot(projectId);
});

function attachmentsRoot() {
  return path.join(app.getPath('userData'), 'data', 'attachments');
}

function intakeService() {
  return createIntakeService({ db, loop, attachmentsRoot });
}

function scheduleMcpServerStart() { setTimeout(() => startMcpServer().catch((error) => recordMcpStartupError(error)), 0); }

function scheduleMcpServerRestart() { setTimeout(() => restartMcpServer().catch((error) => recordMcpStartupError(error)), 0); }

async function restartMcpServer() { if (mcpServer) await mcpServer.stop().catch((error) => console.error('[mcp] stop before restart failed', error)); return startMcpServer(); }

async function startMcpServer() {
  // 幂等守卫：已运行则直接返回当前状态，避免重建第二个实例导致 EADDRINUSE。
  if (mcpServer?.status?.()?.running) return mcpServer.status();
  mcpServer = createMcpServer({ db, loop, intakeService: intakeService(), config: mcpServerConfig(db), logger: console });
  const state = await mcpServer.start();
  const projectId = loop?.defaultProjectId?.();
  if (projectId && state.enabled && state.running) loop.addEvent(projectId, 'mcp.started', mcpStatusMessage(state), { mcp: state });
  return state;
}

async function stopMcpServer() {
  if (!mcpServer) return null;
  const state = await mcpServer.stop().catch((error) => console.error('[mcp] stop failed', error));
  const projectId = loop?.defaultProjectId?.();
  if (projectId) loop.addEvent(projectId, 'mcp.stopped', 'MCP 服务已停止', { mcp: state || mcpServer?.status?.() || null });
  return state;
}

function recordMcpStartupError(error) {
  const message = error?.message || String(error || '未知错误');
  console.error('[mcp] start failed', error);
  const projectId = loop?.defaultProjectId?.();
  if (projectId) loop.addEvent(projectId, 'mcp.start.failed', `MCP 服务启动失败：${message}`, { mcp: mcpServer?.status?.() || null, error: message });
}

function mcpStatusMessage(state = {}) { return state.transport === 'stdio' ? 'MCP 服务已启动：stdio' : `MCP 服务已启动：${state.url || 'http://127.0.0.1:43847/mcp'}`; }

function registerFileProtocol() {
  if (fileProtocolRegistered || !protocol?.handle || !net?.fetch) return;
  fileProtocolRegistered = true;
  protocol.handle('autoplan-file', async (request) => {
    try {
      const filePath = decodeAttachmentFileUrl(request.url);
      const root = attachmentsRoot();
      if (!isInsidePath(root, filePath)) return new Response('Forbidden', { status: 403 });
      const stat = await fs.promises.stat(filePath);
      if (!stat.isFile()) return new Response('Not found', { status: 404 });
      return net.fetch(pathToFileURL(filePath).toString());
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}

function decodeAttachmentFileUrl(url) {
  const parsed = new URL(url);
  if (parsed.hostname !== 'attachment') throw new Error('Invalid attachment URL');
  return decodeURIComponent(parsed.pathname.slice(1));
}

function loadRenderer(window) {
  const devServerUrl = process.env.ELECTRON_RENDERER_URL;
  if (devServerUrl) return window.loadURL(devServerUrl);

  const builtIndex = path.join(__dirname, '..', 'dist', 'index.html');
  if (!fs.existsSync(builtIndex)) {
    throw new Error('Renderer build not found. Run npm run dev or npm run build first.');
  }
  return window.loadFile(builtIndex);
}

function requiredProjectId(input = {}) {
  const projectId = Number(input.projectId || input.id || 0);
  if (!projectId || !loop.project(projectId)) throw new Error('项目不存在');
  return projectId;
}

/**
 * 规范化批量验收目标的 IPC 入参：非数组/空数组抛中文错误；每项取 targetType/Number(id)；
 * targetType/id 合法性交由 loop.acceptItems/unacceptItems 内部的 acceptanceTargetRow 复用校验。
 */
function normalizeAcceptanceBatchTargets(raw, emptyMessage) {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error(emptyMessage);
  return raw.map((entry, index) => {
    if (!entry || typeof entry !== 'object') throw new Error(`验收目标 #${index + 1} 无效`);
    return { targetType: entry.targetType, id: Number(entry.id) };
  });
}

async function readPlan(input = {}) {
  const projectId = Number(input.projectId || 0);
  const planId = Number(input.planId || input.id || 0);
  if (!projectId) return planReadResult({ project_id: null, id: planId || null }, '', '项目不存在');
  if (!planId) return planReadResult({ project_id: projectId, id: null }, '', '计划不存在');

  const project = db.get('SELECT id, workspace_path FROM projects WHERE id = ?', [projectId]);
  if (!project) return planReadResult({ project_id: projectId, id: planId }, '', '项目不存在');

  const plan = db.get(
    'SELECT id, project_id, file_path, hash, updated_at FROM plans WHERE id = ? AND project_id = ?',
    [planId, projectId],
  );
  if (!plan) return planReadResult({ project_id: projectId, id: planId }, '', '计划不存在');
  if (!String(project.workspace_path || '').trim()) return planReadResult(plan, '', '项目工作区路径为空');
  if (!String(plan.file_path || '').trim()) return planReadResult(plan, '', '计划文件路径为空');

  try {
    const planPath = await resolvePlanPath(project.workspace_path, plan.file_path);
    const markdown = await fs.promises.readFile(planPath, 'utf8');
    return planReadResult(plan, markdown, null);
  } catch (error) {
    return planReadResult(plan, '', planReadErrorMessage(error));
  }
}

async function openWorkspaceFile(input = {}) {
  const projectId = Number(input.projectId || 0);
  const relativePath = String(input.filePath || input.path || '').trim();
  if (!projectId) return openFileResult(false, '项目不存在');
  if (!relativePath) return openFileResult(false, '文件路径为空');

  const project = db.get('SELECT id, workspace_path FROM projects WHERE id = ?', [projectId]);
  if (!project) return openFileResult(false, '项目不存在');
  if (!String(project.workspace_path || '').trim()) return openFileResult(false, '项目工作区路径为空');

  try {
    const filePath = await resolveWorkspaceFilePath(project.workspace_path, relativePath);
    const mode = normalizeOpenFileMode(input.mode || readSetting('scopeFileOpenMode') || 'system');
    const command = String(input.command || readSetting('scopeFileOpenCommand') || '').trim();
    await openResolvedFilePath(filePath, mode, command);
    return openFileResult(true, '', { filePath, mode });
  } catch (error) {
    return openFileResult(false, openFileErrorMessage(error));
  }
}

async function openProjectFolder(input = {}) {
  const folder = String(db.get('SELECT workspace_path FROM projects WHERE id = ?', [Number(input.projectId || input.id || 0)])?.workspace_path || '').trim();
  const openError = folder ? await shell.openPath(folder) : '项目工作区路径为空';
  return { ok: !openError, error: openError || null };
}

async function resolveWorkspaceFilePath(workspacePath, filePath) {
  const workspaceRoot = path.resolve(workspacePath);
  const requestedPath = path.resolve(workspaceRoot, filePath);
  if (!isInsidePath(workspaceRoot, requestedPath)) {
    throw planReadError('FILE_PATH_OUTSIDE_WORKSPACE', '文件路径超出项目工作区');
  }

  let workspaceRealPath;
  try {
    workspaceRealPath = await fs.promises.realpath(workspaceRoot);
  } catch {
    throw planReadError('WORKSPACE_UNAVAILABLE', '项目工作区不存在或无法访问');
  }

  let fileRealPath;
  try {
    fileRealPath = await fs.promises.realpath(requestedPath);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
      throw planReadError('FILE_NOT_FOUND', '文件不存在');
    }
    throw error;
  }
  if (!isInsidePath(workspaceRealPath, fileRealPath)) {
    throw planReadError('FILE_PATH_OUTSIDE_WORKSPACE', '文件路径超出项目工作区');
  }
  const stat = await fs.promises.stat(fileRealPath);
  if (stat.isDirectory()) throw planReadError('FILE_IS_DIRECTORY', '路径指向目录，不能作为文件打开');
  if (!stat.isFile()) throw planReadError('FILE_NOT_REGULAR', '路径不是普通文件');
  return fileRealPath;
}

async function openResolvedFilePath(filePath, mode, command) {
  if (mode === 'folder') {
    shell.showItemInFolder(filePath);
    return;
  }
  if (mode === 'vscode') {
    await runOpenCommand(command || 'code', [filePath]);
    return;
  }
  if (mode === 'command') {
    if (!command) throw planReadError('OPEN_COMMAND_MISSING', '第三方编辑器命令未配置');
    await runOpenCommand(command, [filePath], { template: command.includes('{file}') });
    return;
  }
  const error = await shell.openPath(filePath);
  if (error) throw planReadError('OPEN_FILE_FAILED', error);
}

function runOpenCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const spawnCommand = options.template ? command.replaceAll('{file}', shellQuote(args[0])) : command;
    const spawnArgs = options.template ? [] : args;
    const child = spawn(spawnCommand, spawnArgs, { detached: true, stdio: 'ignore', shell: process.platform === 'win32' || options.template });
    child.once('error', (error) => reject(planReadError('OPEN_COMMAND_FAILED', error?.message || '编辑器命令启动失败')));
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

function shellQuote(value) {
  return `"${String(value || '').replace(/"/g, '\\"')}"`;
}

function normalizeOpenFileMode(value) {
  const mode = String(value || '').trim().toLowerCase();
  if (mode === 'folder' || mode === 'vscode' || mode === 'command') return mode;
  return 'system';
}

function readSetting(key) {
  return db.get('SELECT value FROM settings WHERE key = ?', [key])?.value || '';
}

function openFileResult(ok, error, extra = {}) {
  return { ok, error: error || null, ...extra };
}

async function resolvePlanPath(workspacePath, filePath) {
  const workspaceRoot = path.resolve(workspacePath);
  const requestedPath = path.resolve(workspaceRoot, filePath);
  if (!isInsidePath(workspaceRoot, requestedPath)) {
    throw planReadError('PLAN_PATH_OUTSIDE_WORKSPACE', '计划文件路径超出项目工作区');
  }

  let workspaceRealPath;
  try {
    workspaceRealPath = await fs.promises.realpath(workspaceRoot);
  } catch {
    throw planReadError('WORKSPACE_UNAVAILABLE', '项目工作区不存在或无法访问');
  }

  const fileRealPath = await fs.promises.realpath(requestedPath);
  if (!isInsidePath(workspaceRealPath, fileRealPath)) {
    throw planReadError('PLAN_PATH_OUTSIDE_WORKSPACE', '计划文件路径超出项目工作区');
  }
  return fileRealPath;
}

function isInsidePath(rootPath, targetPath) {
  const resolvedRoot = normalizePathForCompare(path.resolve(rootPath));
  const resolvedTarget = normalizePathForCompare(path.resolve(targetPath));
  const relativePath = path.relative(resolvedRoot, resolvedTarget);
  return relativePath === '' || (!!relativePath && !relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

function normalizePathForCompare(value) {
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

function planReadResult(plan, markdown, error) {
  const tasks = readPlanTasksForReader(plan);
  const completedTasks = tasks.filter((task) => task.status === 'completed').length;
  const parseStatus = planReadTaskParseStatus(markdown, error, tasks);
  return {
    ok: !error,
    id: plan?.id ?? null,
    project_id: plan?.project_id ?? null,
    file_path: plan?.file_path || '',
    markdown,
    tasks,
    task_total: tasks.length,
    task_completed: completedTasks,
    task_parse_status: parseStatus.status,
    task_parse_message: parseStatus.message,
    task_parse_has_task_section: parseStatus.hasTaskSection,
    hash: plan?.hash || '',
    updated_at: plan?.updated_at || '',
    error,
  };
}

function readPlanTasksForReader(plan) {
  const planId = Number(plan?.id || 0);
  if (!planId) return [];
  return db
    .all(
      `SELECT id, plan_id, task_key, title, raw_line, scope, status, sort_order, updated_at
       FROM plan_tasks
       WHERE plan_id = ?
       ORDER BY sort_order ASC, id ASC`,
      [planId],
    )
    .map((task) => ({
      ...task,
      scopes: readPlanTaskScopes(task.scope),
    }));
}

function readPlanTaskScopes(scope) {
  return Array.from(
    new Set(
      String(scope || '')
        .split(/[,，、;；]+/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  );
}

function planReadTaskParseStatus(markdown, error, tasks) {
  if (error) return { status: 'read_failed', message: error, hasTaskSection: false };
  const content = String(markdown || '');
  const hasTaskSection = /(?:^|\n)\s*#{1,6}\s*(?:任务拆解|任务计划|任务列表|开发任务|实施计划)(?:\s|$)/i.test(content);
  const hasCheckboxLine = /^\s*[-*+]\s+\[[ xX]\]\s+/m.test(content);
  if (tasks.length) {
    return { status: 'parsed', message: `已解析 ${tasks.length} 个任务。`, hasTaskSection };
  }
  if (!content.trim()) return { status: 'empty_markdown', message: 'Plan Markdown 正文为空。', hasTaskSection: false };
  if (hasTaskSection || hasCheckboxLine) {
    return {
      status: 'parse_empty',
      message: 'Markdown 疑似包含任务拆解，但当前没有解析到任务；请检查任务行是否为固定 checkbox 格式并包含 scope。',
      hasTaskSection: true,
    };
  }
  return { status: 'no_tasks', message: '当前 Plan 尚未解析到任务拆解。', hasTaskSection: false };
}

function planReadError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function planReadErrorMessage(error) {
  if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return '计划文件不存在';
  if (error?.code === 'EACCES' || error?.code === 'EPERM') return '计划文件无法读取，请检查权限';
  return error?.message || '计划文件读取失败';
}

function openFileErrorMessage(error) {
  if (error?.code === 'EACCES' || error?.code === 'EPERM') return '文件无法打开，请检查权限';
  return error?.message || '文件打开失败';
}

function requireManualAction(input = {}, label = '操作') {
  if (input.manual !== true) throw new Error(`${label}需要用户显式触发`);
}

function requiredRecordId(input = {}, key = 'id') {
  const id = Number(input[key] || input.id || 0);
  if (!id) throw new Error('记录不存在');
  return id;
}

function normalizeDraftIntakeInput(input = {}) {
  const bodyPayload = input.body;
  const payload = bodyPayload && typeof bodyPayload === 'object' && !Array.isArray(bodyPayload) ? bodyPayload : null;
  const mergedInput = payload ? { ...input, ...payload } : input;
  const createAsDraft = Boolean(mergedInput.createAsDraft || mergedInput.draft);
  return {
    ...mergedInput,
    body: payload ? payload.body || '' : input.body,
    createAsDraft,
    status: createAsDraft ? 'draft' : mergedInput.status,
  };
}
