const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow, dialog, ipcMain, Menu, net, protocol, shell } = require('electron');
const { saveAttachments } = require('./attachments');
const { AppDatabase, nowIso } = require('./database');
const { createIntakeService, titleFromBody } = require('./intakeService');
const { LoopService, nextIntakeAgentCliConfig, nextIntakePlanGenerationConfig } = require('./loopService');
const intakePlanLinks = require('./loop/intakePlanLinks');
const { parseCron } = require('./loop/scriptHooks');
const { createExecutorStore } = require('./executors/executorStore');
const { mcpServerConfig, saveMcpSettings } = require('./mcpConfig');
const { createMcpServer } = require('./mcpServer');
const { registerTerminalIpc } = require('./terminal/terminalIpc');
const { TerminalService } = require('./terminal/terminalService');
const { createUpdateChecker } = require('./updateChecker');
const { createLlmClient } = require('./chat/llmClient');
const { getChatToolDefinitions } = require('./chat/chatTools');
const {
  createChatController,
  createConversation,
  listConversations,
  updateConversation,
  deleteConversation,
  ensureDefaultConversation,
} = require('./chat/chatController');
const {
  createAiConfig,
  updateAiConfig,
  deleteAiConfig,
  listAiConfigs,
  getAiConfig,
  getLegacyChatConfig,
} = require('./chat/aiConfigService');
const {
  listClaudeCliConfigs,
  getClaudeCliConfig,
  createClaudeCliConfig,
  updateClaudeCliConfig,
  deleteClaudeCliConfig,
  setDefaultClaudeCliConfig,
} = require('./chat/claudeCliConfigService');
const { effectiveAgentCliConfig } = require('./loop/agentCliConfig');
const {
  FILE_ACCESS_SCOPE_KEY,
  ALLOW_CROSS_PROJECT_KEY,
  ALLOWED_ROOTS_KEY,
  FILE_ACCESS_SCOPE_SET,
  resolveFileAccessPolicy,
  isInsidePath,
  assertPathAllowed,
} = require('./fileAccess/policy');

if (protocol?.registerSchemesAsPrivileged) {
  protocol.registerSchemesAsPrivileged([
    { scheme: 'autoplan-file', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  ]);
}

let mainWindow;
let db;
let loop;
let mcpServer;
let updateChecker;
let chatControllers;
let terminalService;
let fileProtocolRegistered = false;
const UPDATE_REPO = 'lyming99/autoplan';

function updateDownloadsRoot() {
  return path.join(app.getPath('userData'), 'updates', 'downloads');
}

async function createApp() {
  Menu.setApplicationMenu(null);
  db = new AppDatabase(path.join(app.getPath('userData'), 'data', 'autoplan.sqlite'));
  await db.init();
  registerFileProtocol();
  loop = new LoopService(db);
  chatControllers = new Map();
  terminalService = new TerminalService();
  registerTerminalIpc({
    ipcMain,
    terminalService,
    getProject: (projectId) => loop.project(projectId),
    sendToRenderer: sendToRendererWindow,
  });
  loop.on('update', (snapshot) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('loop:update', snapshot);
    }
  });
  loop.on('patch', (patch) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('loop:patch', patch);
    }
  });
  // 模块级 mcpServer 在启停过程中被重新赋值，故以闭包懒读取其最新状态注入快照。
  loop.setMcpStatusProvider(() => mcpServer?.status?.());
  loop.startScheduler();
  // 更新检查器：检查完成后经 onCheck 向渲染进程推送 updates:status；安装包只下载到 userData 受控目录。
  updateChecker = createUpdateChecker({
    app,
    net,
    db,
    repo: UPDATE_REPO,
    downloadDir: updateDownloadsRoot(),
    onCheck: broadcastUpdateStatus,
  });

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
  scheduleUpdateCheck();
}

app.whenReady().then(() => createApp().catch((error) => console.error('[app] startup failed', error)));

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (mcpServer) mcpServer.stop().catch((error) => console.error('[mcp] stop failed', error));
  if (terminalService) terminalService.disposeAll();
  if (loop) {
    loop.stopScheduler();
    loop.stop();
  }
  if (updateChecker) updateChecker.stop();
});

ipcMain.handle('updates:status', () => (updateChecker ? updateChecker.status() : defaultUpdateStatus()));

ipcMain.handle('updates:check', async () => {
  if (!updateChecker) return { ok: false, error: 'checker unavailable', ...defaultUpdateStatus() };
  // check() 内部完成 onCheck 推送，此处仅返回结果给调用方。
  return updateChecker.check();
});

ipcMain.handle('updates:dismiss', (_event, input) => {
  if (!updateChecker) return defaultUpdateStatus();
  const next = updateChecker.dismiss(input);
  broadcastUpdateStatus();
  return next;
});

ipcMain.handle('updates:setAutoCheck', (_event, input = {}) => {
  if (!updateChecker) return defaultUpdateStatus();
  const next = updateChecker.setAutoCheck(input && input.enabled);
  broadcastUpdateStatus();
  return next;
});

ipcMain.handle('updates:openInstaller', async () => openDownloadedUpdateInstaller());

// 外链统一经主进程 shell.openExternal 打开（需求 #24 更新提醒等），仅放行 http/https，避免渲染进程直接跳转。
ipcMain.handle('shell:openExternal', async (_event, input = {}) => {
  const url = typeof input === 'string' ? input : input && input.url;
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return { ok: false, error: 'invalid url' };
  try {
    await shell.openExternal(url);
    return { ok: true, error: null };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
});

function defaultUpdateStatus() {
  return {
    currentVersion: typeof app?.getVersion === 'function' ? String(app.getVersion() || '0.0.0') : '0.0.0',
    latestVersion: '',
    latestName: '',
    htmlUrl: '',
    publishedAt: '',
    lastCheckedAt: '',
    dismissedVersion: '',
    hasUpdate: false,
    stableUpdate: false,
    installerAsset: null,
    installerAssetAvailable: false,
    installerAssetStatus: '',
    installerAssetReason: '',
    downloadPhase: 'idle',
    downloadProgress: 0,
    downloadError: '',
    downloadReason: '',
    localInstallerPath: '',
    downloadedInstallerPath: '',
    downloadStartedAt: '',
    downloadCompletedAt: '',
    downloadBytesReceived: 0,
    downloadTotalBytes: 0,
    downloadAssetKey: '',
    downloadVersion: '',
    autoCheck: true,
    intervalMinutes: 360,
  };
}

function broadcastUpdateStatus() {
  sendToRendererWindow('updates:status', updateChecker ? updateChecker.status() : defaultUpdateStatus());
}

function sendToRendererWindow(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

async function openDownloadedUpdateInstaller() {
  if (!updateChecker) return updateInstallerOpenResult(false, 'checker unavailable');
  const state = updateChecker.status();
  if (state.downloadPhase !== 'downloaded') return updateInstallerOpenResult(false, 'installer not downloaded');
  const recordedPath = String(state.localInstallerPath || state.downloadedInstallerPath || '').trim();
  if (!recordedPath) return updateInstallerOpenResult(false, 'installer path unavailable');

  try {
    const filePath = await resolveRecordedUpdateInstallerPath(recordedPath);
    const openError = await shell.openPath(filePath);
    if (!openError) return updateInstallerOpenResult(true, null, { filePath, mode: 'open' });
    shell.showItemInFolder(filePath);
    return updateInstallerOpenResult(true, null, { filePath, mode: 'showItemInFolder', openError });
  } catch (error) {
    return updateInstallerOpenResult(false, updateInstallerOpenErrorMessage(error));
  }
}

async function resolveRecordedUpdateInstallerPath(recordedPath) {
  const root = updateDownloadsRoot();
  const resolvedPath = path.resolve(recordedPath);
  if (!isInsidePath(root, resolvedPath)) throw installerOpenError('OUTSIDE_DOWNLOAD_DIR', 'installer path outside update download directory');

  let rootRealPath;
  try {
    rootRealPath = await fs.promises.realpath(root);
  } catch {
    throw installerOpenError('DOWNLOAD_DIR_MISSING', 'update download directory unavailable');
  }

  let fileRealPath;
  try {
    fileRealPath = await fs.promises.realpath(resolvedPath);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
      throw installerOpenError('INSTALLER_MISSING', 'installer file missing');
    }
    throw error;
  }

  if (!isInsidePath(rootRealPath, fileRealPath)) {
    throw installerOpenError('OUTSIDE_DOWNLOAD_DIR', 'installer path outside update download directory');
  }
  const stat = await fs.promises.stat(fileRealPath);
  if (!stat.isFile()) throw installerOpenError('INSTALLER_NOT_FILE', 'installer path is not a file');
  return fileRealPath;
}

function installerOpenError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function updateInstallerOpenErrorMessage(error) {
  if (error?.code === 'DOWNLOAD_DIR_MISSING') return '更新下载目录不存在';
  if (error?.code === 'INSTALLER_MISSING') return '安装包文件不存在';
  if (error?.code === 'INSTALLER_NOT_FILE') return '安装包路径不是文件';
  if (error?.code === 'OUTSIDE_DOWNLOAD_DIR') return '安装包路径不在受控下载目录内';
  if (error?.code === 'EACCES' || error?.code === 'EPERM') return '安装包无法访问，请检查权限';
  return error?.message || String(error || '打开安装包失败');
}

function updateInstallerOpenResult(ok, error, extra = {}) {
  return { ok, error: error || null, ...extra };
}

function scheduleUpdateCheck() {
  if (!updateChecker) return;
  // start() 内部按 update.autoCheck 决定是否挂载周期定时器；autoCheck 关闭时不启动。
  updateChecker.start();
  if (db.getSetting('update.autoCheck', 'true') === 'false') return;
  // autoCheck 开启：延迟触发首次检查，避免与启动期 MCP/渲染加载争抢资源。
  const firstCheck = setTimeout(() => {
    updateChecker.check().catch(() => {
      /* 检查失败已在结果中结构化，不影响其它功能 */
    });
  }, 5000);
  if (typeof firstCheck.unref === 'function') firstCheck.unref();
}

ipcMain.handle('snapshot', (_event, input = {}) => loop.snapshot(input.projectId || null));

ipcMain.handle('plans:read', async (_event, input = {}) => readPlan(input));

ipcMain.handle('plans:reorder', (_event, input = {}) => {
  const projectId = requiredProjectId(input);
  const planIds = Array.isArray(input.planIds) ? input.planIds : input.plan_ids;
  return loop.reorderPlans(projectId, planIds);
});

ipcMain.handle('plans:stop', (_event, input = {}) => {
  const projectId = requiredProjectId(input);
  return loop.stopPlan(projectId, requiredRecordId(input, 'planId'));
});

ipcMain.handle('plans:resume', (_event, input = {}) => {
  const projectId = requiredProjectId(input);
  return loop.resumePlan(projectId, requiredRecordId(input, 'planId'));
});

ipcMain.handle('plans:updateExecutionConfig', (_event, input = {}) => {
  const projectId = requiredProjectId(input);
  const planId = requiredRecordId(input, 'planId');
  return loop.updatePlanExecutionConfig(projectId, planId, {
    provider: input.provider,
    command: input.command,
  });
});

ipcMain.handle('plans:reExecute', (_event, input = {}) => {
  const projectId = requiredProjectId(input);
  return loop.reExecutePlan(projectId, requiredRecordId(input, 'planId'));
});

ipcMain.handle('plans:recreate', async (_event, input = {}) => {
  const projectId = requiredProjectId(input);
  const planId = requiredRecordId(input, 'planId');
  return loop.recreatePlanFromIntake(projectId, planId);
});

ipcMain.handle('plans:appendTask', (_event, input = {}) => {
  const projectId = requiredProjectId(input);
  const planId = requiredRecordId(input, 'planId');
  const intake = intakePlanLinks.getIntakeForPlan(loop, projectId, planId, {
    includeLegacyFallback: true,
  });
  if (!intake || !intake.intakeId) throw new Error('计划未关联需求/反馈，无法追加任务');
  return loop.appendTaskToIntakePlan(
    projectId,
    intake.intakeType,
    intake.intakeId,
    input.title || '',
  );
});

ipcMain.handle('plans:delete', (_event, input = {}) => {
  const projectId = requiredProjectId(input);
  return loop.deletePlan(projectId, requiredRecordId(input, 'planId'), input.options || {});
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
  if (terminalService) terminalService.disposeProject(projectId);
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

ipcMain.handle('mcp:stop', async (_event, input = {}) => { await stopMcpServer(); return loop.snapshot(input.projectId || null); });

ipcMain.handle('mcp:status', (_event, input = {}) => loop.snapshot(input.projectId || null));

ipcMain.handle('mcp:readAuthToken', () => readSavedMcpAuthToken());

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
  loop.stopTask(projectId, requiredRecordId(input, 'taskId')); return loop.snapshot(projectId);
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

ipcMain.handle('acceptance:redo', (_event, input = {}) => {
  const projectId = requiredProjectId(input);
  loop.redoAcceptanceItem(projectId, {
    targetType: normalizeAcceptanceTargetType(input.targetType),
    id: requiredRecordId(input),
    supplement: input.supplement == null ? '' : String(input.supplement),
  });
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
  const planGenerationConfig = nextIntakePlanGenerationConfig(current, input);
  db.run(
    `UPDATE requirements
     SET title = ?,
         body = ?,
         status = ?,
         agent_cli_provider = ?,
         agent_cli_command = ?,
         codex_reasoning_effort = ?,
         plan_generation_strategy = ?,
         plan_generation_provider = ?,
         plan_generation_command = ?,
         plan_generation_model = ?,
         plan_generation_codex_reasoning_effort = ?,
         updated_at = ?
     WHERE id = ? AND project_id = ?`,
    [
      input.title ?? titleFromBody(body, '未命名需求'),
      body,
      input.status ?? current.status ?? 'open',
      agentCliConfig.provider,
      agentCliConfig.command,
      agentCliConfig.codexReasoningEffort,
      planGenerationConfig.strategy,
      planGenerationConfig.provider,
      planGenerationConfig.command,
      planGenerationConfig.model,
      planGenerationConfig.codexReasoningEffort,
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
  const planGenerationConfig = nextIntakePlanGenerationConfig(current, input);
  db.run(
    `UPDATE feedback
     SET requirement_id = ?,
         title = ?,
         body = ?,
         status = ?,
         agent_cli_provider = ?,
         agent_cli_command = ?,
         codex_reasoning_effort = ?,
         plan_generation_strategy = ?,
         plan_generation_provider = ?,
         plan_generation_command = ?,
         plan_generation_model = ?,
         plan_generation_codex_reasoning_effort = ?,
         updated_at = ?
     WHERE id = ? AND project_id = ?`,
    [
      input.requirementId === undefined ? current.requirement_id || null : input.requirementId || null,
      input.title ?? titleFromBody(body, '未命名反馈'),
      body,
      input.status ?? current.status ?? 'open',
      agentCliConfig.provider,
      agentCliConfig.command,
      agentCliConfig.codexReasoningEffort,
      planGenerationConfig.strategy,
      planGenerationConfig.provider,
      planGenerationConfig.command,
      planGenerationConfig.model,
      planGenerationConfig.codexReasoningEffort,
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
  loop.interruptIntakePlans(projectId, normalizeIntakeType(input.type), requiredRecordId(input));
  return loop.snapshot(projectId);
});

// 恢复被中断的计划
ipcMain.handle('intake:resume', (_event, input = {}) => {
  const projectId = requiredProjectId(input);
  loop.resumeIntakePlans(projectId, normalizeIntakeType(input.type), requiredRecordId(input));
  return loop.snapshot(projectId);
});

// 追加任务到需求/反馈关联的计划
ipcMain.handle('intake:appendTask', (_event, input = {}) => {
  const projectId = requiredProjectId(input);
  loop.appendTaskToIntakePlan(projectId, normalizeIntakeType(input.type), requiredRecordId(input), input.title);
  return loop.snapshot(projectId);
});

ipcMain.handle('intake:retryGeneratePlan', async (_event, input = {}) => {
  const projectId = requiredProjectId(input);
  await loop.retryIntakePlanGeneration(projectId, normalizeIntakeType(input.type), requiredRecordId(input), input);
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

ipcMain.handle('executors:pickTasksJson', async () => (await dialog.showOpenDialog(mainWindow, {
  properties: ['openFile'],
  filters: [{ name: 'VS Code Tasks JSON', extensions: ['json'] }, { name: '所有文件', extensions: ['*'] }],
}))?.filePaths?.[0] || null);

ipcMain.handle('executors:create', (_event, input = {}) => {
  const projectId = requiredProjectId(input);
  executorStore().create(projectId, input);
  return loop.snapshot(projectId);
});

ipcMain.handle('executors:update', (_event, input = {}) => {
  const projectId = requiredProjectId(input);
  const executorId = requiredRecordId(input, 'executorId');
  executorStore().update(projectId, executorId, input);
  return loop.snapshot(projectId);
});

ipcMain.handle('executors:delete', (_event, input = {}) => {
  const projectId = requiredProjectId(input);
  const executorId = requiredRecordId(input, 'executorId');
  executorStore().delete(projectId, executorId);
  return loop.snapshot(projectId);
});

ipcMain.handle('executors:toggle', (_event, input = {}) => {
  const projectId = requiredProjectId(input);
  const executorId = requiredRecordId(input, 'executorId');
  executorStore().toggle(projectId, executorId);
  return loop.snapshot(projectId);
});

ipcMain.handle('executors:run', async (_event, input = {}) => {
  const projectId = requiredProjectId(input);
  return loop.runExecutor(projectId, requiredRecordId(input, 'executorId'));
});

ipcMain.handle('executors:stop', async (_event, input = {}) => {
  const projectId = requiredProjectId(input);
  await loop.stopExecutor(projectId, requiredRecordId(input, 'executorId'));
  return loop.snapshot(projectId);
});

ipcMain.handle('executors:runAction', async (_event, input = {}) => {
  const projectId = requiredProjectId(input);
  return loop.runExecutorAction(projectId, requiredRecordId(input, 'executorId'), input && input.action);
});

ipcMain.handle('executors:importTasksJson', async (_event, input = {}) => {
  const projectId = requiredProjectId(input);
  const tasksJson = await readExecutorTasksJsonInput(input);
  const result = executorStore().importTasksJson(projectId, tasksJson);
  return { ...result, snapshot: loop.snapshot(projectId) };
});

// ------------------------------------------------------- chat:* IPC（需求 #26）----------------------------------------------

ipcMain.handle('chat:send', (_event, input = {}) => {
  const projectId = requiredProjectId(input);
  const message = String(input.message || '').trim();
  if (!message) return { accepted: false, error: '消息不能为空' };

  let conversationId = Number(input.conversationId || 0);
  if (!conversationId) {
    // 向后兼容：未传 conversationId 时自动使用/创建项目的默认对话
    conversationId = ensureDefaultConversation(db, projectId);
  } else if (!conversationInProject(conversationId, projectId)) {
    return { accepted: false, error: '对话不存在或不属于当前项目' };
  }

  const enqueued = getOrCreateChatController(conversationId, projectId).send(message);
  return { accepted: true, conversationId, enqueuedId: enqueued.id };
});

ipcMain.handle('chat:stop', (_event, input = {}) => {
  const projectId = requiredProjectId(input);
  const conversationId = Number(input.conversationId || 0);
  if (!conversationId) return { stopped: false, error: 'conversationId 不能为空' };
  if (!conversationInProject(conversationId, projectId)) {
    return { stopped: false, error: '对话不存在或不属于当前项目' };
  }
  const controller = chatControllers?.get(conversationId);
  if (controller) controller.stop();
  return { stopped: true };
});

ipcMain.handle('chat:clear', (_event, input = {}) => {
  const projectId = requiredProjectId(input);
  const conversationId = Number(input.conversationId || 0);
  if (!conversationId) return { cleared: false, error: 'conversationId 不能为空' };
  if (!conversationInProject(conversationId, projectId)) {
    return { cleared: false, error: '对话不存在或不属于当前项目' };
  }
  const controller = chatControllers?.get(conversationId);
  if (controller) controller.clearHistory();
  // 即使当前无活跃 controller 也清理 DB
  db.run('DELETE FROM chat_messages WHERE conversation_id = ? AND project_id = ?', [conversationId, projectId]);
  return { cleared: true };
});

ipcMain.handle('chat:history', (_event, input = {}) => {
  const projectId = requiredProjectId(input);
  const conversationId = Number(input.conversationId || 0);
  if (!conversationId) return [];
  if (!conversationInProject(conversationId, projectId)) return [];
  const controller = chatControllers?.get(conversationId);
  if (controller) return controller.getHistory();
  return db.all(
    `SELECT * FROM chat_messages
     WHERE conversation_id = ? AND project_id = ?
     ORDER BY created_at ASC, id ASC`,
    [conversationId, projectId],
  );
});

// 队列管理 IPC（需求 #37）：会话/控制器不存在时返回空/{ok:false}，不抛错
function getQueueController(input = {}) {
  const cid = Number(input.conversationId || 0);
  if (!cid || !conversationInProject(cid, requiredProjectId(input))) return null;
  return chatControllers?.get(cid) || null;
}
ipcMain.handle('chat:queueList', (_event, input) => { const c = getQueueController(input); return c ? c.getQueue() : []; });
ipcMain.handle('chat:queueCancel', (_event, input) => ({ ok: Boolean(getQueueController(input)?.cancelQueueItem(Number(input.id || 0))) }));
ipcMain.handle('chat:queueEdit', (_event, input) => {
  const c = getQueueController(input);
  const message = String(input.message || '').trim();
  return { ok: Boolean(c && message && c.editQueueItem(Number(input.id || 0), message)) };
});
ipcMain.handle('chat:queueClear', (_event, input) => { const c = getQueueController(input); if (c) c.clearQueue(); return { ok: !!c }; });

ipcMain.handle('chat:saveConfig', (_event, config = {}) => {
  const savedConfig = saveChatConfigAsGlobalDefault(config);
  broadcastAiConfigChanged('chat:saveConfig', savedConfig?.id ?? null);
  return { saved: true };
});

ipcMain.handle('chat:getConfig', () => getGlobalDefaultChatConfig());

// ------------------------------------------------------- file-access:* IPC（需求 #35）------------------------------------------------

ipcMain.handle('file-access:get', () => {
  // workspacePath 仅影响 effectiveRoots，get 仅返回三个配置项，传 null 即可
  const policy = resolveFileAccessPolicy({ db, workspacePath: null });
  return {
    scope: policy.scope,
    allowCrossProject: policy.allowCrossProject,
    allowedRoots: policy.allowedRoots,
  };
});

ipcMain.handle('file-access:save', (_event, config = {}) => {
  const source = config && typeof config === 'object' ? config : {};
  // 未提供的字段沿用当前持久化值（idempotent），不静默回退默认值
  const current = resolveFileAccessPolicy({ db, workspacePath: null });

  let scope = current.scope;
  if (source.scope !== undefined) {
    const normalized = String(source.scope).trim().toLowerCase();
    if (!FILE_ACCESS_SCOPE_SET.has(normalized)) {
      throw new Error(`非法的文件访问范围：${source.scope}`);
    }
    scope = normalized;
  }

  let allowCrossProject = current.allowCrossProject;
  if (source.allowCrossProject !== undefined) {
    if (typeof source.allowCrossProject !== 'boolean') {
      throw new Error('allowCrossProject 必须为布尔值');
    }
    allowCrossProject = source.allowCrossProject;
  }

  let allowedRoots = current.allowedRoots;
  if (source.allowedRoots !== undefined) {
    if (!Array.isArray(source.allowedRoots) || source.allowedRoots.some((r) => typeof r !== 'string')) {
      throw new Error('allowedRoots 必须为字符串数组');
    }
    allowedRoots = source.allowedRoots.filter((r) => r.trim() !== '');
  }

  db.setSetting(FILE_ACCESS_SCOPE_KEY, scope);
  db.setSetting(ALLOW_CROSS_PROJECT_KEY, String(allowCrossProject));
  db.setSetting(ALLOWED_ROOTS_KEY, JSON.stringify(allowedRoots));

  // all 范围不阻塞保存，但记录可观测信息并回传 warned，供 UI 提示风险
  const warned = scope === 'all';
  if (warned) {
    console.warn('[file-access] 已保存为 all 范围：文件读取将不受应用层限制，仅受 OS 权限约束，请谨慎使用');
  }
  return { saved: true, ...(warned ? { warned: true } : {}) };
});

// ------------------------------------------------------- ai-config:* IPC（需求 #28）------------------------------------------------

ipcMain.handle('ai-config:list', () => listAiConfigs(db));

ipcMain.handle('ai-config:get', (_event, input = {}) => {
  const id = requiredRecordId(input, 'configId');
  const config = getAiConfig(db, id);
  if (!config) throw new Error('AI 配置不存在');
  return config;
});

ipcMain.handle('ai-config:create', (_event, input = {}) => {
  const config = createAiConfig(db, aiConfigCreateInput(input));
  broadcastAiConfigChanged('ai-config:create', config.id);
  return config;
});

ipcMain.handle('ai-config:update', (_event, input = {}) => {
  const id = requiredRecordId(input, 'configId');
  const config = updateAiConfig(db, id, aiConfigUpdateInput(input));
  broadcastAiConfigChanged('ai-config:update', id);
  return config;
});

ipcMain.handle('ai-config:delete', (_event, input = {}) => {
  const id = requiredRecordId(input, 'configId');
  const result = deleteAiConfig(db, id);
  broadcastAiConfigChanged('ai-config:delete', id);
  return result;
});

// ------------------------------------------------------- claude-cli-config:* IPC（需求 #93）------------------------------------------------

ipcMain.handle('claude-cli-config:list', () => listClaudeCliConfigs(db));

ipcMain.handle('claude-cli-config:get', (_event, input = {}) => {
  const id = requiredRecordId(input, 'configId');
  const config = getClaudeCliConfig(db, id);
  if (!config) throw new Error('Claude CLI 配置不存在');
  return config;
});

ipcMain.handle('claude-cli-config:create', (_event, input = {}) => {
  const config = createClaudeCliConfig(db, claudeCliConfigCreateInput(input));
  broadcastClaudeCliConfigChanged('claude-cli-config:create', config.id);
  return config;
});

ipcMain.handle('claude-cli-config:update', (_event, input = {}) => {
  const id = requiredRecordId(input, 'configId');
  const config = updateClaudeCliConfig(db, id, claudeCliConfigUpdateInput(input));
  broadcastClaudeCliConfigChanged('claude-cli-config:update', id);
  return config;
});

ipcMain.handle('claude-cli-config:delete', (_event, input = {}) => {
  const id = requiredRecordId(input, 'configId');
  const result = deleteClaudeCliConfig(db, id);
  broadcastClaudeCliConfigChanged('claude-cli-config:delete', id);
  return result;
});

ipcMain.handle('claude-cli-config:set-default', (_event, input = {}) => {
  const id = requiredRecordId(input, 'configId');
  const config = setDefaultClaudeCliConfig(db, id);
  broadcastClaudeCliConfigChanged('claude-cli-config:set-default', id);
  return config;
});

// ------------------------------------------------------- conversation:* IPC（需求 #28）-----------------------------------------

ipcMain.handle('conversation:list', (_event, input = {}) => {
  const projectId = requiredProjectId(input);
  return listConversations(db, projectId);
});

ipcMain.handle('conversation:create', (_event, input = {}) => {
  const projectId = requiredProjectId(input);
  return createConversation(db, conversationCreateInput(input, projectId));
});

ipcMain.handle('conversation:update', (_event, input = {}) => {
  const projectId = requiredProjectId(input);
  const id = requiredRecordId(input, 'conversationId');
  requireConversationInProject(id, projectId);
  return updateConversation(db, id, conversationUpdateInput(input, projectId));
});

ipcMain.handle('conversation:delete', (_event, input = {}) => {
  const projectId = requiredProjectId(input);
  const id = requiredRecordId(input, 'conversationId');
  requireConversationInProject(id, projectId);
  const controller = chatControllers?.get(id);
  if (controller) { controller.clearQueue(); controller.stop(); } // 清空排队+停止，避免删除后续跑产生孤儿消息
  chatControllers.delete(id);
  return deleteConversation(db, id, { projectId });
});

// ------------------------------------------------------- chat:* (continued) -------------------------------------------------------

function getOrCreateChatController(conversationId, projectId) {
  requireConversationInProject(conversationId, projectId);
  const existing = chatControllers.get(conversationId);
  if (existing && (existing.isActive() || existing.hasQueued())) return existing; // 复用续跑中实例
  chatControllers.delete(conversationId); // 清理已结束且无排队实例
  const project = db.get('SELECT id, workspace_path FROM projects WHERE id = ?', [projectId]);
  if (!project) throw new Error('项目不存在');
  const workspacePath = String(project.workspace_path || '').trim();
  if (!workspacePath) throw new Error('项目工作区路径为空');

  // 解析 codex 后端启动参数（需求 #96）：优先项目 loop 配置，回退 effectiveAgentCliConfig({})
  const state = db.get('SELECT agent_cli_command, codex_reasoning_effort FROM project_states WHERE project_id = ?', [projectId]);
  const codexCommand = String(state?.agent_cli_command || '').trim();
  const codexReasoningEffort = String(state?.codex_reasoning_effort || '').trim();
  const fallback = effectiveAgentCliConfig({});
  const codexBackendConfig = {
    command: codexCommand || fallback.command || 'codex',
    defaultReasoningEffort: codexReasoningEffort || fallback.codexReasoningEffort || 'medium',
  };

  const tools = getChatToolDefinitions({
    db,
    projectId,
    workspacePath,
    intakeService: intakeService(),
    loopService: loop,
    conversationId,
  });
  // 局部广播闭包：复用 onEvent/onQueue/onDone，消除重复 mainWindow 守卫
  const send = (channel, data) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, data); };
  const controller = createChatController({
    db, llmClient: createLlmClient, chatTools: tools, conversationId, projectId, workspacePath,
    codexBackendConfig,
    onEvent: ({ type, data }) => send('chat:chunk', { type, data }),
    onQueue: (items) => send('chat:queue', { conversationId, items, count: Array.isArray(items) ? items.length : 0 }),
    onDone: ({ status, error, conversationId: doneCid, title } = {}) => {
      const ctrl = chatControllers.get(conversationId);
      if (ctrl && !ctrl.isActive() && !ctrl.hasQueued()) chatControllers.delete(conversationId); // 有排队则保留续跑
      send('chat:done', { status, error, conversationId: doneCid, title });
    },
  });
  chatControllers.set(conversationId, controller);
  controller.resumeQueue(); // 恢复库内历史排队并派发（刷新/重启后）
  return controller;
}

function saveChatConfigAsGlobalDefault(config = {}) {
  persistLegacyChatSettings(config);

  const existing = db.get('SELECT id FROM ai_configs WHERE project_id IS NULL ORDER BY id ASC LIMIT 1');
  const fields = chatConfigToAiConfigFields(config);
  if (existing) {
    return updateAiConfig(db, existing.id, fields);
  }

  return createAiConfig(db, {
    name: normalizeOptionalText(config?.name) || '默认配置',
    provider: fields.provider,
    baseUrl: fields.baseUrl,
    apiKey: fields.apiKey,
    model: fields.model,
    temperature: fields.temperature,
    thinkingDepth: fields.thinkingDepth,
    thinkingBudgetTokens: fields.thinkingBudgetTokens,
  });
}

function persistLegacyChatSettings(config = {}) {
  const source = config && typeof config === 'object' ? config : {};
  for (const key of ['provider', 'baseUrl', 'apiKey', 'model', 'temperature']) {
    if (Object.prototype.hasOwnProperty.call(source, key) && source[key] !== undefined) {
      db.setSetting(`chat.${key}`, String(source[key] ?? ''));
    }
  }
}

function chatConfigToAiConfigFields(config = {}) {
  const source = config && typeof config === 'object' ? config : {};
  const fields = {};
  for (const key of [
    'name',
    'provider',
    'baseUrl',
    'apiKey',
    'model',
    'temperature',
    'thinkingDepth',
    'thinkingBudgetTokens',
  ]) {
    if (Object.prototype.hasOwnProperty.call(source, key)) fields[key] = source[key];
  }
  return fields;
}

function getGlobalDefaultChatConfig() {
  const config = listAiConfigs(db)[0];
  if (!config) return getLegacyChatConfig(db);

  return {
    source: 'ai-config',
    aiConfigId: config.id,
    name: config.name,
    provider: config.provider,
    baseUrl: config.baseUrl,
    hasApiKey: config.hasApiKey,
    maskedKey: config.maskedKey,
    model: config.model,
    temperature: config.temperature,
    thinkingDepth: config.thinkingDepth,
    thinkingBudgetTokens: config.thinkingBudgetTokens,
  };
}

function broadcastAiConfigChanged(source, configId = null) {
  invalidateChatConfigCaches();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('ai-config:changed', {
      source,
      configId,
      configs: listAiConfigs(db),
    });
  }
}

function broadcastClaudeCliConfigChanged(source, configId = null) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('claude-cli-config:changed', {
      source,
      configId,
      configs: listClaudeCliConfigs(db),
    });
  }
}

function invalidateChatConfigCaches() {
  if (!chatControllers) return;
  for (const [conversationId, controller] of chatControllers.entries()) {
    if (controller?.isActive?.()) {
      controller.invalidateConfig?.();
    } else {
      chatControllers.delete(conversationId);
    }
  }
}

function normalizeOptionalText(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function attachmentsRoot() {
  return path.join(app.getPath('userData'), 'data', 'attachments');
}

function intakeService() {
  return createIntakeService({ db, loop, attachmentsRoot });
}

function executorStore() {
  return createExecutorStore(db);
}

async function readExecutorTasksJsonInput(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  if (typeof source.content === 'string') return source.content;
  if (typeof source.tasksJson === 'string') return source.tasksJson;
  if (typeof source.json === 'string') return source.json;
  if (Array.isArray(source.tasks)) return { version: source.version || '', tasks: source.tasks };

  const filePath = String(source.filePath || source.path || '').trim();
  if (!filePath) throw new Error('请选择 .vscode/tasks.json 文件或提供 tasks.json 内容');
  const fileName = path.basename(filePath).toLowerCase();
  if (fileName === 'launch.json') throw new Error('不支持导入 launch.json');
  if (fileName !== 'tasks.json') throw new Error('仅支持导入 .vscode/tasks.json');
  return fs.promises.readFile(filePath, 'utf8');
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

function readSavedMcpAuthToken() {
  const authToken = String(db?.getSetting?.('mcp.authToken', '') || '');
  return {
    hasAuthToken: authToken.length > 0,
    authToken,
  };
}

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

function aiConfigCreateInput(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  return {
    name: source.name,
    provider: source.provider,
    baseUrl: source.baseUrl,
    apiKey: source.apiKey,
    model: source.model,
    temperature: source.temperature,
    thinkingDepth: source.thinkingDepth,
    thinkingBudgetTokens: source.thinkingBudgetTokens,
  };
}

function aiConfigUpdateInput(input = {}) {
  return chatConfigToAiConfigFields(input);
}

function claudeCliConfigCreateInput(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  return {
    name: source.name,
    baseUrl: source.baseUrl,
    authToken: source.authToken,
    model: source.model,
  };
}

function claudeCliConfigUpdateInput(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const fields = {};
  if (Object.prototype.hasOwnProperty.call(source, 'name')) fields.name = source.name;
  if (Object.prototype.hasOwnProperty.call(source, 'baseUrl')) fields.baseUrl = source.baseUrl;
  if (Object.prototype.hasOwnProperty.call(source, 'authToken')) fields.authToken = source.authToken;
  if (Object.prototype.hasOwnProperty.call(source, 'model')) fields.model = source.model;
  return fields;
}

function conversationCreateInput(input = {}, projectId) {
  const source = input && typeof input === 'object' ? input : {};
  return {
    projectId,
    title: source.title,
    aiConfigId: source.aiConfigId ?? source.ai_config_id ?? null,
  };
}

function conversationUpdateInput(input = {}, projectId) {
  const source = input && typeof input === 'object' ? input : {};
  const fields = { projectId };
  if (Object.prototype.hasOwnProperty.call(source, 'title')) fields.title = source.title;
  if (
    Object.prototype.hasOwnProperty.call(source, 'aiConfigId') ||
    Object.prototype.hasOwnProperty.call(source, 'ai_config_id')
  ) {
    fields.aiConfigId = source.aiConfigId ?? source.ai_config_id ?? null;
  }
  if (
    Object.prototype.hasOwnProperty.call(source, 'pinnedAt') ||
    Object.prototype.hasOwnProperty.call(source, 'pinned_at')
  ) {
    fields.pinnedAt = source.pinnedAt ?? source.pinned_at ?? null;
  }
  if (
    Object.prototype.hasOwnProperty.call(source, 'pinned') ||
    Object.prototype.hasOwnProperty.call(source, 'isPinned')
  ) {
    fields.pinned = source.pinned ?? source.isPinned;
  }
  return fields;
}

function conversationInProject(conversationId, projectId) {
  return Boolean(db.get('SELECT id FROM conversations WHERE id = ? AND project_id = ?', [
    Number(conversationId || 0),
    Number(projectId || 0),
  ]));
}

function requireConversationInProject(conversationId, projectId) {
  const conversation = db.get('SELECT * FROM conversations WHERE id = ? AND project_id = ?', [
    Number(conversationId || 0),
    Number(projectId || 0),
  ]);
  if (!conversation) throw new Error('对话不存在或不属于当前项目');
  return conversation;
}

/**
 * 规范化批量验收目标的 IPC 入参：非数组/空数组抛中文错误；每项取 targetType/Number(id)；
 * targetType/id 合法性交由 loop.acceptItems/unacceptItems 内部的 acceptanceTargetRow 复用校验。
 */
function normalizeAcceptanceTargetType(value) {
  if (value === 'plan' || value === 'task') return value;
  throw new Error('验收目标类型无效');
}

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
  const policy = resolveFileAccessPolicy({ db, workspacePath });
  const workspaceRoot = path.resolve(workspacePath);
  const requestedPath = path.resolve(workspaceRoot, filePath);
  // 词法预校验：默认范围仅允许工作区内部，尽早拦截越界路径
  assertPathAllowed(requestedPath, policy);

  try {
    await fs.promises.realpath(workspaceRoot);
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
  // realpath 二次校验：拦截指向允许范围外部的符号链接逃逸
  assertPathAllowed(fileRealPath, policy);
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
  const policy = resolveFileAccessPolicy({ db, workspacePath });
  const workspaceRoot = path.resolve(workspacePath);
  const requestedPath = path.resolve(workspaceRoot, filePath);
  // 词法预校验：默认范围仅允许工作区内部，尽早拦截越界路径
  assertPathAllowed(requestedPath, policy);

  try {
    await fs.promises.realpath(workspaceRoot);
  } catch {
    throw planReadError('WORKSPACE_UNAVAILABLE', '项目工作区不存在或无法访问');
  }

  const fileRealPath = await fs.promises.realpath(requestedPath);
  // realpath 二次校验：拦截指向允许范围外部的符号链接逃逸
  assertPathAllowed(fileRealPath, policy);
  return fileRealPath;
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

function normalizeIntakeType(value) {
  return value === 'feedback' ? 'feedback' : 'requirement';
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
