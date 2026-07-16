const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow, dialog, ipcMain, Menu, net, protocol, shell } = require('electron');
const { saveAttachments } = require('./attachments');
const { AppDatabase, nowIso } = require('./database');
const { DATABASE_OWNERS, selectProcessDatabaseOwner } = require('./data/databaseOwnerGuard');
const { GoDataClient, GoDataClientError } = require('./data/goDataClient');
const { migrateLegacyDatabase, isLegacyMigrationCompleted, markLegacyMigrationCompleted } = require('./data/migrateLegacyDatabase');
const { readLegacyProjects, restoreLegacyProjects } = require('./data/legacyProjectRestore');
const { GoDaemonSupervisor } = require('./daemon/supervisor');
const { resolveDaemonBinary } = require('./daemon/binaryPath');
const { packagedGoDataDirectory, packagedLogDirectory } = require('./daemon/dataDirectory');
const { RuntimeFileLogger, safeErrorCode } = require('./logging/runtimeFileLogger');
const { GoRuntimeAdapter } = require('./loop/goRuntimeAdapter');
const { daemonRuntimeFeatureEnvironment, runtimeFeatureFlags } = require('./runtimeFeatures');
const { openProjectFolderFromRuntime } = require('./desktop/projectFolder');
const { openSystemTerminal } = require('./desktop/systemTerminal');
const { createIntakeService, titleFromBody } = require('./intakeService');
const { LoopService, nextIntakeAgentCliConfig, nextIntakePlanGenerationConfig } = require('./loopService');
const intakePlanLinks = require('./loop/intakePlanLinks');
const { parseCron } = require('./loop/scriptHooks');
const { createExecutorStore } = require('./executors/executorStore');
const { saveMcpSettings } = require('./mcpConfig');
const { registerTerminalIpc } = require('./terminal/terminalIpc');
const { TerminalService } = require('./terminal/terminalService');
const { terminalLegacyAdmissionForPlatform } = require('./terminal/terminalTypes');
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

configureDevelopmentSessionData();
configurePackagedGoRuntime();
const runtimeLogger = createRuntimeFileLogger();
installCriticalLogHandlers();
runtimeLogger.log('info', 'electron_process_started', { source: 'electron', pid: process.pid, stage: 'startup' });

const PRIMARY_INSTANCE_DATA = Object.freeze({ version: 1, type: 'autoplan_primary_instance' });
const isPrimaryInstance = app.requestSingleInstanceLock(PRIMARY_INSTANCE_DATA);
if (!isPrimaryInstance) app.quit();

let mainWindow;
let db;
let loop;
let updateChecker;
let chatControllers;
let terminalService;
let databaseOwner;
let goDataClient;
let daemonSupervisor;
let daemonQuitPending = false;
let fileProtocolRegistered = false;
let maintenanceState = Object.freeze({
  operationId: null,
  mode: 'ready',
  stage: 'idle',
  code: '',
  mutationsBlocked: false,
});
const UPDATE_REPO = 'lyming99/autoplan';

function configureDevelopmentSessionData() {
  if (app.isPackaged) return;
  const configured = String(process.env.AUTOPLAN_ELECTRON_SESSION_DATA_DIR || '').trim();
  if (!configured || !path.isAbsolute(configured)) return;
  try {
    fs.mkdirSync(configured, { recursive: true });
    app.setPath('sessionData', configured);
  } catch {
    // Session data is a best-effort development cache isolation. Startup and
    // the persistent Go-owned database must not depend on it.
  }
}

// Packaged launches have no launcher script to inject the Go runtime
// environment that scripts/dev.js sets in development. Default the owner,
// the non-routable ownership marker (the real authority comes from the
// supervisor's readiness handshake), and a persistent userData directory
// before the owner guard and supervisor run.
function configurePackagedGoRuntime() {
  if (!app.isPackaged) return;
  if (process.env.AUTOPLAN_DATABASE_OWNER) return;
  const dataDir = packagedGoDataDirectory(app.getPath('userData'));
  try {
    fs.mkdirSync(dataDir, { recursive: true });
  } catch {
    // The owner guard and supervisor validation surface a precise error if the
    // directory is unusable; nothing else to do here.
  }
  process.env.AUTOPLAN_DATABASE_OWNER = 'go';
  process.env.AUTOPLAN_GO_API_URL = 'http://127.0.0.1:1';
  process.env.AUTOPLAN_GO_DATA_DIR = dataDir;
}

// On the first packaged Go-mode launch, migrate the previous temp-resident Go
// database when present, otherwise migrate the legacy Node database. The new
// database remains below Electron userData. A sentinel prevents re-running.
// not block startup — the Go sidecar still boots with an empty database.
async function migrateLegacyDatabaseIfNeeded() {
  if (!app.isPackaged || process.env.AUTOPLAN_DATABASE_OWNER !== 'go') return;
  const dataDir = process.env.AUTOPLAN_GO_DATA_DIR;
  if (!dataDir || !path.isAbsolute(dataDir)) return;
  if (isLegacyMigrationCompleted(dataDir)) return;
  const targetDbPath = path.join(dataDir, 'autoplan.sqlite');
  if (fs.existsSync(targetDbPath)) return;
  const oldGoDataDir = path.join(os.tmpdir(), 'autoplan-sidecar');
  const oldGoDatabase = path.join(oldGoDataDir, 'autoplan.sqlite');
  const legacyDataDir = path.join(app.getPath('userData'), 'data');
  const sourceDataDir = fs.existsSync(oldGoDatabase) ? oldGoDataDir : legacyDataDir;
  const sourceDbPath = fs.existsSync(oldGoDatabase)
    ? oldGoDatabase
    : path.join(legacyDataDir, 'autoplan.sqlite');
  if (!fs.existsSync(sourceDbPath)) return;
  const sourceAttachmentsDir = path.join(sourceDataDir, 'attachments');
  const targetAttachmentsDir = path.join(dataDir, 'attachments');
  try {
    const result = await migrateLegacyDatabase({
      sourceDbPath,
      targetDbPath,
      sourceAttachmentsDir,
      targetAttachmentsDir,
      initSqlJs: require('sql.js'),
      sqlJsOptions: { locateFile: (file) => path.join(__dirname, '..', 'node_modules', 'sql.js', 'dist', file) },
    });
    markLegacyMigrationCompleted(dataDir);
    runtimeLogger.log('info', 'legacy_database_migrated', { source: 'electron', stage: 'migration' });
    console.log('[autoplan] legacy database migrated:', JSON.stringify(result.tables));
  } catch (error) {
    runtimeLogger.log('error', 'legacy_database_migration_failed', {
      source: 'electron', stage: 'migration', error_code: safeErrorCode(error),
    });
    console.error('[autoplan] legacy database migration failed:', error?.code || error?.message || 'unknown');
  }
}

// All IPC handlers are registered through Electron's one registry.  Install a
// single gate before the registrations below so new writer handlers cannot
// accidentally bypass maintenance mode.  Read-only status/snapshot routes
// remain available for a fail-closed UI.
const MAINTENANCE_READ_ONLY_CHANNELS = new Set([
  'snapshot', 'daemon:status', 'maintenance:status', 'updates:status',
  'plans:read', 'workspace:openFile', 'projects:openFolder', 'mcp:status',
  'mcp:readAuthToken', 'chat:history', 'chat:queueList', 'chat:getConfig',
  'file-access:get', 'ai-config:list', 'ai-config:get', 'claude-cli-config:list',
  'claude-cli-config:get', 'conversation:list', 'scripts:pickFile',
  'executors:pickTasksJson', 'projects:pickDirectory', 'logs:openFolder',
]);
const KEY_IPC_CHANNELS = new Set([
  'projects:create', 'projects:update', 'projects:delete', 'projects:openFolder', 'projects:openTerminal',
  'loop:configure', 'loop:start', 'loop:stop', 'loop:runOnce', 'intake:retryGeneratePlan',
  'plans:reExecute', 'plans:recreate', 'tasks:run', 'tasks:runParallel', 'tasks:stop',
  'terminal:create', 'terminal:kill', 'terminal:close', 'logs:openFolder',
]);
const maintenanceIpcGates = new WeakSet();

function installMaintenanceIpcGate() {
  if (!ipcMain || typeof ipcMain.handle !== 'function' || maintenanceIpcGates.has(ipcMain)) return;
  const register = ipcMain.handle.bind(ipcMain);
  maintenanceIpcGates.add(ipcMain);
  ipcMain.handle = (channel, handler) => register(channel, async (...args) => {
    const startedAt = Date.now();
    const projectId = ipcProjectID(args[1]);
    if (maintenanceState.mutationsBlocked && !MAINTENANCE_READ_ONLY_CHANNELS.has(channel)) {
      runtimeLogger.log('warn', 'ipc_request_rejected', {
        source: 'electron', channel, error_code: 'maintenance_mode', duration_ms: Date.now() - startedAt,
        ...(projectId ? { project_id: projectId } : {}),
      });
      throw new Error('maintenance_mode');
    }
    if (KEY_IPC_CHANNELS.has(channel)) {
      runtimeLogger.log('info', 'ipc_request_started', {
        source: 'electron', channel, ...(projectId ? { project_id: projectId } : {}),
      });
    }
    try {
      const result = await handler(...args);
      const failedResult = result && typeof result === 'object' && result.ok === false;
      if (failedResult) {
        runtimeLogger.log('error', 'ipc_request_failed', {
          source: 'electron', channel, error_code: safeErrorCode({ code: result.error }),
          duration_ms: Date.now() - startedAt, ...(projectId ? { project_id: projectId } : {}),
        });
      } else if (KEY_IPC_CHANNELS.has(channel)) {
        runtimeLogger.log('info', 'ipc_request_finished', {
          source: 'electron', channel, duration_ms: Date.now() - startedAt,
          ...(projectId ? { project_id: projectId } : {}),
        });
      }
      return result;
    } catch (error) {
      runtimeLogger.log('error', 'ipc_request_failed', {
        source: 'electron', channel, error_code: safeErrorCode(error), duration_ms: Date.now() - startedAt,
        ...(projectId ? { project_id: projectId } : {}),
      });
      throw error;
    }
  });
}

function ipcProjectID(input) {
  const value = Number(input?.projectId || input?.id || 0);
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

installMaintenanceIpcGate();

// Preload may request only a bounded, credential-free loopback descriptor.
// Session material stays in Electron main and never enters renderer IPC.
if (typeof ipcMain?.on === 'function') {
  ipcMain.on('runtime:rendererConfig', (event) => {
    event.returnValue = isGoRuntimeMode() ? rendererRuntimeConfig() : null;
  });
}

function updateDownloadsRoot() {
  return path.join(app.getPath('userData'), 'updates', 'downloads');
}

function isPrimaryInstanceNotification(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === 2 && value.version === 1 && value.type === 'autoplan_primary_instance');
}

function focusExistingWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized?.()) mainWindow.restore();
  mainWindow.show?.();
  mainWindow.focus?.();
}

function startupFailureCode(error) {
  const code = String(error?.code || error?.message || 'startup_failed');
  return /^[a-z0-9_]{1,96}$/i.test(code) ? code : 'startup_failed';
}

function rendererEntryURL() {
  const devServerUrl = String(process.env.ELECTRON_RENDERER_URL || '').trim();
  if (devServerUrl) return devServerUrl;
  return pathToFileURL(path.join(__dirname, '..', 'dist', 'index.html')).toString();
}

function assertRendererLaunchConfiguration() {
  const devServerUrl = String(process.env.ELECTRON_RENDERER_URL || '').trim();
  if (app.isPackaged === true) {
    if (devServerUrl) throw startupConfigurationError('renderer_development_url_forbidden');
    return;
  }
  try {
    const parsed = new URL(devServerUrl);
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || !parsed.hostname || parsed.username || parsed.password) {
      throw new Error('invalid');
    }
  } catch {
    throw startupConfigurationError('renderer_development_url_required');
  }
}

function startupConfigurationError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function isTrustedRendererURL(rawUrl) {
  try {
    const expected = new URL(rendererEntryURL());
    const actual = new URL(rawUrl);
    if (expected.protocol === 'file:') return actual.toString() === expected.toString();
    return actual.protocol === expected.protocol && actual.origin === expected.origin;
  } catch {
    return false;
  }
}

function isTrustedRendererContents(webContents) {
  try { return isTrustedRendererURL(webContents?.getURL?.() || ''); } catch { return false; }
}

function installTrustedRendererNavigation(webContents) {
  if (!webContents) return;
  webContents.setWindowOpenHandler?.(() => ({ action: 'deny' }));
  webContents.on?.('will-navigate', (event, rawUrl) => {
    if (!isTrustedRendererURL(rawUrl)) event.preventDefault();
  });
}

async function createApp() {
  runtimeLogger.log('info', 'electron_app_initializing', { source: 'electron', stage: 'startup' });
  assertRendererLaunchConfiguration();
  Menu.setApplicationMenu(null);
  await migrateLegacyDatabaseIfNeeded();
  // Writer ownership is selected once, before any sql.js construction,
  // schema work, or persisted snapshot read. Missing/conflicting launch
  // configuration is rejected by the owner guard rather than guessed.
  databaseOwner = selectProcessDatabaseOwner({ env: process.env });
  if (databaseOwner.owner === DATABASE_OWNERS.GO) {
    daemonSupervisor = new GoDaemonSupervisor(goDaemonLaunchOptions());
    await daemonSupervisor.start();
    databaseOwner.assertGoDataClientFallbackAllowed();
    goDataClient = new GoDataClient(daemonSupervisor.clientOptions());
    await restoreDevelopmentLegacyProjects();
    db = createGoModeDatabaseBlocker();
    loop = new GoRuntimeAdapter(goDataClient);
    daemonSupervisor.on('failed', broadcastDaemonStatus);
    daemonSupervisor.on('stopped', broadcastDaemonStatus);
    daemonSupervisor.on('maintenance', () => {
      enterMaintenanceMode({ stage: 'daemon_release', code: 'daemon_released' }).catch(() => undefined);
      broadcastDaemonStatus();
    });
  } else {
    db = new AppDatabase(path.join(app.getPath('userData'), 'data', 'autoplan.sqlite'), { ownerGuard: databaseOwner });
    await db.init();
    loop = new LoopService(db);
  }
  registerFileProtocol();
  chatControllers = new Map();
  // P008 freezes legacy Node PTY admission at packaged-app startup. The
  // decision comes from hash-bound release evidence in source, never a
  // renderer request or mutable process environment.
  const terminalLegacyAdmission = terminalLegacyAdmissionForPlatform(process.platform);
  terminalService = new TerminalService({ legacyAdmission: terminalLegacyAdmission });
  registerTerminalIpc({
    ipcMain,
    terminalService,
    getProject: (projectId) => loop.project(projectId),
    sendToRenderer: sendToRendererWindow,
    legacyAdmission: terminalLegacyAdmission,
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
  // Go owns the MCP runtime. Legacy snapshots must not probe or start a
  // second Node listener.
  loop.setMcpStatusProvider(() => undefined);
  if (!isGoRuntimeMode()) loop.startScheduler();
  // 更新检查器：检查完成后经 onCheck 向渲染进程推送 updates:status；安装包只下载到 userData 受控目录。
  if (!isGoRuntimeMode()) {
    updateChecker = createUpdateChecker({
      app,
      net,
      db,
      repo: UPDATE_REPO,
      downloadDir: updateDownloadsRoot(),
      onCheck: broadcastUpdateStatus,
    });
  }

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
  mainWindow.on('close', (event) => {
    // Keep the window alive until the supervised Go process has closed its
    // listener, database and child process tree.
    if (beginGoDaemonShutdown()) event.preventDefault();
  });
  installTrustedRendererNavigation(mainWindow.webContents);
  installSidecarRequestAuthentication(mainWindow.webContents);
  if (!app.isPackaged) {
    mainWindow.webContents.on('console-message', (_event, _level, message) => {
      if (typeof message === 'string' && message.startsWith('[autoplan]')) console.error(message);
    });
  }
  await loadRenderer(mainWindow);
  if (!isGoRuntimeMode()) {
    scheduleUpdateCheck();
  }
  runtimeLogger.log('info', 'electron_app_ready', { source: 'electron', stage: 'startup' });
}

if (isPrimaryInstance) {
  app.on('second-instance', (_event, _commandLine, _workingDirectory, additionalData) => {
    if (!isPrimaryInstanceNotification(additionalData)) return;
    focusExistingWindow();
  });
  app.whenReady().then(async () => {
    try {
      await createApp();
    } catch (error) {
      const code = startupFailureCode(error);
      runtimeLogger.log('error', 'electron_startup_failed', {
        source: 'electron', stage: 'startup', error_code: code,
      });
      console.error('[app] startup failed', code);
      try {
        dialog.showErrorBox(
          'AutoPlan failed to start',
          `The background service could not start (${code}). Reinstall the app or check the release notes.`,
        );
      } finally {
        app.quit();
      }
    }
  });
}

function createRuntimeFileLogger() {
  const directory = packagedLogDirectory(app.getPath('userData'));
  try {
    return new RuntimeFileLogger({ directory });
  } catch {
    return {
      directory,
      filePath: '',
      log: () => false,
      writeExternalChunk: () => undefined,
      flushExternal: () => undefined,
    };
  }
}

function installCriticalLogHandlers() {
  process.on('uncaughtExceptionMonitor', (error) => {
    runtimeLogger.log('error', 'electron_uncaught_exception', {
      source: 'electron', stage: 'process', error_code: safeErrorCode(error),
    });
  });
  process.on('unhandledRejection', (error) => {
    runtimeLogger.log('error', 'electron_unhandled_rejection', {
      source: 'electron', stage: 'process', error_code: safeErrorCode(error),
    });
  });
  app.on('render-process-gone', (_event, _webContents, details = {}) => {
    runtimeLogger.log('error', 'electron_renderer_gone', {
      source: 'electron', stage: 'renderer', error_code: safeErrorCode({ code: details.reason }, 'renderer_gone'),
      exit_code: Number.isSafeInteger(details.exitCode) ? details.exitCode : 0,
    });
  });
  app.on('child-process-gone', (_event, details = {}) => {
    runtimeLogger.log('error', 'electron_child_process_gone', {
      source: 'electron', stage: safeErrorCode({ code: details.type }, 'child'),
      error_code: safeErrorCode({ code: details.reason }, 'child_process_gone'),
      exit_code: Number.isSafeInteger(details.exitCode) ? details.exitCode : 0,
    });
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', (event) => {
  runtimeLogger.log('info', 'electron_app_stopping', { source: 'electron', stage: 'shutdown' });
  if (beginGoDaemonShutdown()) {
    event.preventDefault();
    return;
  }
  if (terminalService) terminalService.disposeAll();
  if (loop) {
    loop.stopScheduler();
    loop.stop();
  }
  if (updateChecker) updateChecker.stop();
});

function beginGoDaemonShutdown() {
  if (!daemonSupervisor || daemonQuitPending) return false;
  daemonQuitPending = true;
  daemonSupervisor.stop()
    .catch((error) => {
      runtimeLogger.log('error', 'daemon_stop_failed', {
        source: 'electron-supervisor', stage: 'shutdown', error_code: safeErrorCode(error, 'daemon_stop_failed'),
      });
    })
    .finally(() => app.quit());
  return true;
}

function isGoRuntimeMode() {
  return databaseOwner?.owner === DATABASE_OWNERS.GO;
}

function goDaemonLaunchOptions() {
  const binary = resolveDaemonBinary({
    isPackaged: app.isPackaged === true,
    resourcesPath: process.resourcesPath,
    developmentPath: process.env.AUTOPLAN_GO_DAEMON_PATH,
    platform: process.platform,
    arch: process.arch,
  });
  return {
    executablePath: binary.path,
    dataDir: process.env.AUTOPLAN_GO_DATA_DIR,
    runtimeFeatureEnvironment: daemonRuntimeFeatureEnvironment(process.env),
    logger: runtimeLogger,
  };
}

function rendererRuntimeConfig() {
  if (!isGoRuntimeMode()) return null;
  const client = daemonSupervisor?.clientOptions?.();
  if (!client?.baseUrl || !client?.sessionToken) throw new GoDataClientError('service_unavailable');
  return Object.freeze({
    baseUrl: client.baseUrl,
    credentialMode: 'cookie',
    runtimeFeatures: runtimeFeatureFlags(process.env),
  });
}

async function restoreDevelopmentLegacyProjects() {
  if (app.isPackaged || !daemonSupervisor) return;
  const databasePath = path.join(app.getPath('userData'), 'data', 'autoplan.sqlite');
  const legacyProjects = await readLegacyProjects(databasePath, require('sql.js'), {
    locateFile: (file) => path.join(__dirname, '..', 'node_modules', 'sql.js', 'dist', file),
  });
  if (!legacyProjects.length) return;
  const client = daemonSupervisor.clientOptions();
  const existingProjects = await sidecarProjectRequest(client, '/api/v1/projects?page=1&page_size=200&sort=updated_at_desc', 'GET');
  await restoreLegacyProjects({
    legacyProjects,
    existingProjects: Array.isArray(existingProjects?.data) ? existingProjects.data : [],
    createProject: (project) => sidecarProjectRequest(client, '/api/v1/projects', 'POST', {
      name: project.name, workspace_path: project.workspace_path, description: project.description,
    }, `legacy-project-${project.id}`),
  });
}

async function sidecarProjectRequest(client, route, method, body, idempotencyKey) {
  const headers = {
    Accept: 'application/json', Origin: client.origin,
    'X-Autoplan-Session': client.sessionToken,
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  const response = await globalThis.fetch(`${client.baseUrl}${route}`, {
    method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value = await response.json().catch(() => null);
  if (!response.ok || !value || typeof value !== 'object') throw new GoDataClientError('service_unavailable');
  return value;
}

function isGoChatHTTPEnabled() {
  return isGoRuntimeMode() && runtimeFeatureFlags(process.env).go_chat_api === true;
}

// Session material never reaches renderer JavaScript. This privileged request
// hook attaches it only to the ready daemon's exact random loopback authority
// for REST, SSE and Terminal WebSocket traffic; all other URLs retain their
// original headers. Development keeps the browser's Vite Origin so CORS
// preflight and the subsequent request have one identity; packaged file
// renderers retain the synthetic loopback origin.
function installSidecarRequestAuthentication(webContents) {
  const request = webContents?.session?.webRequest;
  if (!request || typeof request.onBeforeSendHeaders !== 'function') return;
  request.onBeforeSendHeaders({ urls: ['http://127.0.0.1/*', 'ws://127.0.0.1/*'] }, (details, callback) => {
    const client = currentDaemonClient();
    const rejection = sidecarRequestRejection(details, webContents, client, { requireSession: true });
    if (rejection) {
      callback({ cancel: false, requestHeaders: details.requestHeaders });
      return;
    }
    const requestHeaders = { ...(details.requestHeaders || {}) };
    for (const name of Object.keys(requestHeaders)) {
      if (name.toLowerCase() === 'x-autoplan-session') delete requestHeaders[name];
      if (app.isPackaged && name.toLowerCase() === 'origin') delete requestHeaders[name];
    }
    requestHeaders['X-Autoplan-Session'] = client.sessionToken;
    if (app.isPackaged) requestHeaders.Origin = client.origin;
    callback({ cancel: false, requestHeaders });
  });
  request.onHeadersReceived({ urls: ['http://127.0.0.1/*'] }, (details, callback) => {
    const client = currentDaemonClient();
    const rejection = sidecarRequestRejection(details, webContents, client, { requireSession: false });
    if (rejection) {
      callback({ cancel: false, responseHeaders: details.responseHeaders });
      return;
    }
    let rendererOrigin;
    try { rendererOrigin = new URL(rendererEntryURL()).origin; } catch { rendererOrigin = ''; }
    if (!rendererOrigin || rendererOrigin === 'null') {
      callback({ cancel: false, responseHeaders: details.responseHeaders });
      return;
    }
    const responseHeaders = { ...(details.responseHeaders || {}) };
    responseHeaders['Access-Control-Allow-Origin'] = [rendererOrigin];
    responseHeaders['Access-Control-Allow-Credentials'] = ['true'];
    // The renderer validates that the response envelope and transport header
    // carry the same request id. CORS hides non-safelisted headers unless this
    // explicit exposure is present, even though the HTTP request succeeded.
    responseHeaders['Access-Control-Expose-Headers'] = ['X-Request-ID'];
    callback({ cancel: false, responseHeaders });
  });
  if (typeof request.onErrorOccurred === 'function') {
    request.onErrorOccurred({ urls: ['http://127.0.0.1/*'] }, (details) => {
      if (details?.webContentsId !== webContents.id || !isLoopbackAPIPath(details?.url)) return;
      // React refreshes and explicit AbortControllers intentionally cancel a
      // stale request; Chromium reports that as ERR_ABORTED.
      if (details.error === 'net::ERR_ABORTED') return;
      runtimeLogger.log('error', 'sidecar_network_request_failed', {
        source: 'electron-network', method: details.method,
        error_code: safeErrorCode({ code: details.error }, 'network_error'), retryable: true,
      });
      if (!app.isPackaged) console.error(`[autoplan] sidecar request failed: ${String(details.error || 'unknown_error')}`);
    });
  }
  if (typeof request.onCompleted === 'function') {
    request.onCompleted({ urls: ['http://127.0.0.1/*'] }, (details) => {
      if (details?.webContentsId !== webContents.id || !isLoopbackAPIPath(details?.url) || details.statusCode < 400) return;
      let route = '';
      try { route = new URL(details.url).pathname; } catch { route = ''; }
      runtimeLogger.log('error', 'sidecar_http_request_failed', {
        source: 'electron-network', method: details.method, route, status: details.statusCode,
        error_code: `http_${details.statusCode}`, retryable: details.statusCode >= 500,
      });
    });
  }
}

function currentDaemonClient() {
  try { return daemonSupervisor?.clientOptions?.() || null; }
  catch { return null; }
}

function sidecarRequestRejection(details, webContents, client, { requireSession }) {
  if (!client?.baseUrl) return 'client_unavailable';
  if (requireSession && !client.sessionToken) return 'session_unavailable';
  if (details?.webContentsId !== webContents?.id) return 'webcontents_mismatch';
  // installTrustedRendererNavigation already prevents this window from
  // leaving the configured renderer origin. Re-evaluating getURL() in the
  // network callback is racy around CORS preflights and can drop the private
  // session header for an otherwise valid POST.
  if (!isSidecarRequest(details?.url, client.baseUrl)) return 'authority_or_route_mismatch';
  return '';
}

function isLoopbackAPIPath(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    return parsed.hostname === '127.0.0.1' &&
      (parsed.pathname === '/api/v1' || parsed.pathname.startsWith('/api/v1/'));
  } catch {
    return false;
  }
}

// Retain the P14 helper name as a narrow predicate for source-level terminal
// contracts. The P002 interceptor also covers the matching REST/SSE routes.
function isTerminalWebSocketRequest(rawUrl, baseUrl) {
  try {
    const requestUrl = new URL(rawUrl);
    const daemonUrl = new URL(baseUrl);
    return requestUrl.protocol === 'ws:' && daemonUrl.protocol === 'http:' &&
      requestUrl.hostname === '127.0.0.1' && requestUrl.host === daemonUrl.host &&
      /^\/api\/v1\/terminals\/term_[a-z0-9][a-z0-9_-]{5,}\/ws$/.test(requestUrl.pathname);
  } catch {
    return false;
  }
}

function isSidecarRequest(rawUrl, baseUrl) {
  try {
    const requestUrl = new URL(rawUrl);
    const daemonUrl = new URL(baseUrl);
    if ((requestUrl.protocol !== 'http:' && requestUrl.protocol !== 'ws:') || daemonUrl.protocol !== 'http:' ||
        requestUrl.hostname !== '127.0.0.1' || requestUrl.host !== daemonUrl.host) return false;
    return requestUrl.pathname === '/healthz' || requestUrl.pathname === '/readyz' ||
      requestUrl.pathname === '/api/v1' || requestUrl.pathname.startsWith('/api/v1/');
  } catch {
    return false;
  }
}

function isGoMcpTransportEnabled() {
  // P13B has no renderer business route. Keep its listener gate out of the
  // renderer runtime document so an MCP rollout cannot alter Chat transport.
  return isGoRuntimeMode() && process.env.AUTOPLAN_SIDECAR_GO_MCP_API === 'true';
}

function assertLegacyChatAdapterEnabled() {
  if (isGoChatHTTPEnabled()) throw new GoDataClientError('legacy_adapter_disabled');
}

function daemonStatus() {
  return daemonSupervisor?.status?.() || { state: 'unavailable', ready: false, host: null, port: null, baseUrl: null, origin: null };
}

function maintenanceStatus() {
  return { ...maintenanceState };
}

function updateMaintenanceState({ operationId = maintenanceState.operationId, mode = maintenanceState.mode, stage = maintenanceState.stage, code = maintenanceState.code, mutationsBlocked = maintenanceState.mutationsBlocked } = {}) {
  const normalizedOperationId = operationId == null ? null : normalizeMaintenanceLabel(operationId, 'electron-cutover');
  maintenanceState = Object.freeze({
    operationId: normalizedOperationId,
    mode: normalizeMaintenanceLabel(mode, 'maintenance'),
    stage: normalizeMaintenanceLabel(stage, 'failed'),
    code: code ? normalizeMaintenanceLabel(code, 'maintenance_failed') : '',
    mutationsBlocked: Boolean(mutationsBlocked),
  });
  sendToRendererWindow('maintenance:status', maintenanceStatus());
  return maintenanceStatus();
}

function normalizeMaintenanceLabel(value, fallback) {
  const label = String(value || '').trim().toLowerCase();
  return /^[a-z0-9_-]{1,128}$/.test(label) ? label : fallback;
}

// This trusted main-process primitive is the Node half of maintenance
// handoff.  It freezes all renderer mutations first, drains local workers,
// performs a final sql.js persist, and only then releases the legacy owner.
// Any error leaves maintenanceState locked; callers must never reopen writes
// as a recovery shortcut.
async function enterMaintenanceMode({ operationId = 'electron-cutover', stage = 'freeze', code = 'maintenance_active' } = {}) {
  if (maintenanceState.mutationsBlocked) return maintenanceStatus();
  updateMaintenanceState({ operationId, mode: 'maintenance', stage, code, mutationsBlocked: true });
  try {
    if (updateChecker) updateChecker.stop();
    if (loop) {
      loop.stopScheduler?.();
      await loop.stop?.();
    }
    for (const controller of chatControllers?.values?.() || []) {
      controller.clearQueue?.();
      controller.stop?.();
    }
    terminalService?.disposeAll?.();
    if (isGoRuntimeMode()) {
      await daemonSupervisor?.prepareCutover?.();
    } else if (db) {
      db.persist?.();
      if (db.lastPersistError) throw new Error('node_persist_failed');
      db.close?.();
    }
    return updateMaintenanceState({ mode: 'maintenance', stage: 'node_release', code: 'node_released', mutationsBlocked: true });
  } catch {
    return updateMaintenanceState({ mode: 'maintenance', stage: 'failed', code: 'node_release_failed', mutationsBlocked: true });
  }
}

function broadcastDaemonStatus() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('daemon:status', daemonStatus());
  }
}

function createGoModeDatabaseBlocker() {
  const fail = () => {
    // Keep the database-owner error at this boundary. A missed legacy IPC
    // port must never look like a transient Go runtime failure and therefore
    // must not tempt a caller to recreate sql.js or retry a mutation locally.
    databaseOwner?.assertNodeMutationAllowed?.();
    throw new GoDataClientError('service_unavailable');
  };
  // This sentinel is never a database adapter. It exists solely to turn an
  // unported legacy call into a stable, side-effect-free failure before SQL,
  // persistence, export, mirror, or backup code can execute.
  return new Proxy(Object.freeze({}), {
    get(_target, key) {
      if (key === 'then') return undefined;
      return fail;
    },
  });
}

async function goDataSnapshot(projectId, command) {
  const result = await command();
  return result?.snapshot || loop.snapshot(projectId);
}

// IPC compatibility callers retain their historical completed-result shape
// while Go owns data and process admission. These adapters derive only bounded
// persisted snapshot fields; command text, PID, environment and raw output are
// never reconstructed in Electron.
function processScriptRunResult(result, scriptId) {
  const snapshot = result?.snapshot;
  const script = Array.isArray(snapshot?.scripts)
    ? snapshot.scripts.find((item) => Number(item?.id) === Number(scriptId))
    : null;
  return {
    snapshot,
    status: script?.last_status ?? script?.lastStatus ?? 'running',
    exitCode: script?.last_exit_code ?? script?.lastExitCode ?? null,
    durationMs: script?.last_duration_ms ?? script?.lastDurationMs ?? null,
    log: script?.last_log ?? script?.lastLog ?? null,
    ...(result?.operation ? { operation: result.operation } : {}),
  };
}

function processExecutorRunResult(result, executorId) {
  const snapshot = result?.snapshot;
  const executor = Array.isArray(snapshot?.executors)
    ? snapshot.executors.find((item) => Number(item?.id) === Number(executorId))
    : null;
  return {
    snapshot,
    executorId,
    label: executor?.label || '',
    status: executor?.last_status ?? executor?.lastStatus ?? 'running',
    exitCode: executor?.last_exit_code ?? executor?.lastExitCode ?? null,
    durationMs: executor?.last_duration_ms ?? executor?.lastDurationMs ?? null,
    log: executor?.last_log ?? executor?.lastLog ?? null,
    ...(result?.operation ? { operation: result.operation } : {}),
  };
}

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

ipcMain.handle('logs:openFolder', async () => {
  try {
    fs.mkdirSync(runtimeLogger.directory, { recursive: true });
    const error = await shell.openPath(runtimeLogger.directory);
    return error ? { ok: false, error: 'log_folder_open_failed' } : { ok: true, error: null };
  } catch (error) {
    runtimeLogger.log('error', 'log_folder_open_failed', {
      source: 'electron', error_code: safeErrorCode(error),
    });
    return { ok: false, error: 'log_folder_open_failed' };
  }
});

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
ipcMain.handle('daemon:status', () => daemonStatus());
ipcMain.handle('maintenance:status', () => maintenanceStatus());

ipcMain.handle('plans:read', async (_event, input = {}) => readPlan(input));

ipcMain.handle('plans:reorder', (_event, input = {}) => {
  const projectId = requiredProjectId(input);
  const planIds = Array.isArray(input.planIds) ? input.planIds : input.plan_ids;
  return loop.reorderPlans(projectId, planIds);
});

ipcMain.handle('plans:stop', async (_event, input = {}) => {
  const projectId = requiredProjectId(input);
  return loop.stopPlan(projectId, requiredRecordId(input, 'planId'));
});

ipcMain.handle('plans:resume', async (_event, input = {}) => {
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

ipcMain.handle('plans:reExecute', async (_event, input = {}) => {
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
ipcMain.handle('projects:openTerminal', async (_event, input = {}) => {
  try {
    return openSystemTerminal(await loadProjectWorkspacePath(input));
  } catch {
    return { ok: false, error: '无法读取项目工作区路径' };
  }
});

ipcMain.handle('loop:configure', (_event, config = {}) => {
  if (isGoRuntimeMode()) throw new GoDataClientError('service_unavailable');
  const projectId = requiredProjectId(config);
  const mcpConfigChanged = saveMcpSettings(db, config);
  loop.configure(projectId, config);
  if (mcpConfigChanged) scheduleMcpServerRestart();
  return loop.snapshot(projectId);
});

ipcMain.handle('loop:start', async (_event, input = {}) => {
  requireManualAction(input, '启动循环');
  const projectId = requiredProjectId(input);
  const snapshot = await loop.start(projectId);
  return snapshot || loop.snapshot(projectId);
});

ipcMain.handle('loop:stop', async (_event, input = {}) => {
  const projectId = requiredProjectId(input);
  const snapshot = await loop.stop(projectId);
  return snapshot || loop.snapshot(projectId);
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
  if (isGoRuntimeMode()) throw new GoDataClientError('service_unavailable');
  const projectId = config.projectId || null;
  const mcpConfigChanged = saveMcpSettings(db, config);
  if (mcpConfigChanged) scheduleMcpServerRestart();
  return loop.snapshot(projectId);
});

ipcMain.handle('tasks:run', async (_event, input = {}) => {
  const projectId = requiredProjectId(input);
  await loop.runTask(projectId, requiredRecordId(input, 'taskId'), {
    planId: input.planId ?? input.plan_id,
  });
  return loop.snapshot(projectId);
});

ipcMain.handle('tasks:runParallel', async (_event, input = {}) => {
  requireManualAction(input, '并发执行');
  const projectId = requiredProjectId(input);
  await loop.runTaskBatches(projectId, requiredRecordId(input, 'planId'), input.batches || []);
  return loop.snapshot(projectId);
});

ipcMain.handle('tasks:stop', async (_event, input = {}) => {
  const projectId = requiredProjectId(input);
  const snapshot = await loop.stopTask(projectId, requiredRecordId(input, 'taskId'), {
    planId: input.planId ?? input.plan_id,
  });
  return snapshot || loop.snapshot(projectId);
});

ipcMain.handle('acceptance:accept', async (_event, input = {}) => {
  const projectId = requiredProjectId(input);
  if (isGoRuntimeMode()) {
    return goDataSnapshot(projectId, () => goDataClient.acceptItem(
      projectId, normalizeAcceptanceTargetType(input.targetType), requiredRecordId(input),
    ));
  }
  loop.acceptItem(projectId, { targetType: input.targetType, id: requiredRecordId(input) });
  return loop.snapshot(projectId);
});

ipcMain.handle('acceptance:unaccept', async (_event, input = {}) => {
  const projectId = requiredProjectId(input);
  if (isGoRuntimeMode()) {
    return goDataSnapshot(projectId, () => goDataClient.unacceptItem(
      projectId, normalizeAcceptanceTargetType(input.targetType), requiredRecordId(input),
    ));
  }
  loop.unacceptItem(projectId, { targetType: input.targetType, id: requiredRecordId(input) });
  return loop.snapshot(projectId);
});

ipcMain.handle('acceptance:redo', async (_event, input = {}) => {
  const projectId = requiredProjectId(input);
  if (isGoRuntimeMode()) {
    return goDataSnapshot(projectId, () => goDataClient.redoAcceptanceItem(
      projectId, normalizeAcceptanceTargetType(input.targetType), requiredRecordId(input), {
        supplement: input.supplement == null ? '' : String(input.supplement),
      },
    ));
  }
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
  if (isGoRuntimeMode()) return goDataSnapshot(projectId, () => goDataClient.acceptItems(projectId, targets));
  loop.acceptItems(projectId, targets);
  return loop.snapshot(projectId);
});

ipcMain.handle('acceptance:unacceptBatch', (_event, input = {}) => {
  const projectId = requiredProjectId(input);
  const targets = normalizeAcceptanceBatchTargets(input.targets, '批量取消验收目标列表为空');
  if (isGoRuntimeMode()) return goDataSnapshot(projectId, () => goDataClient.unacceptItems(projectId, targets));
  loop.unacceptItems(projectId, targets);
  return loop.snapshot(projectId);
});

ipcMain.handle('intake:accept', (_event, input = {}) => {
  const projectId = requiredProjectId(input);
  loop.acceptIntakeItem(projectId, {
    intakeType: normalizeStrictIntakeType(input.intakeType ?? input.type),
    id: requiredRecordId(input),
  });
  return loop.snapshot(projectId);
});

ipcMain.handle('intake:unaccept', (_event, input = {}) => {
  const projectId = requiredProjectId(input);
  loop.unacceptIntakeItem(projectId, {
    intakeType: normalizeStrictIntakeType(input.intakeType ?? input.type),
    id: requiredRecordId(input),
  });
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
  if (isGoRuntimeMode()) {
    return goDataSnapshot(projectId, () => goDataClient.retryIntakePlanGeneration(
      projectId, normalizeIntakeType(input.type), requiredRecordId(input),
    ));
  }
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
  if (isGoRuntimeMode()) {
    const result = await goDataClient.runScript(projectId, scriptId);
    return processScriptRunResult(result, scriptId);
  }
  return loop.runScriptManually(projectId, scriptId);
});

ipcMain.handle('scripts:stop', async (_event, input = {}) => {
  const projectId = requiredProjectId(input);
  const scriptId = requiredRecordId(input, 'scriptId');
  if (isGoRuntimeMode()) {
    const result = await goDataClient.stopScript(projectId, scriptId);
    return result.snapshot;
  }
  const snapshot = await loop.stopScript(projectId, scriptId);
  return snapshot || loop.snapshot(projectId);
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
  const executorId = requiredRecordId(input, 'executorId');
  if (isGoRuntimeMode()) {
    return processExecutorRunResult(await goDataClient.runExecutor(projectId, executorId), executorId);
  }
  return loop.runExecutor(projectId, executorId);
});

ipcMain.handle('executors:stop', async (_event, input = {}) => {
  const projectId = requiredProjectId(input);
  const executorId = requiredRecordId(input, 'executorId');
  if (isGoRuntimeMode()) {
    return (await goDataClient.stopExecutor(projectId, executorId)).snapshot;
  }
  await loop.stopExecutor(projectId, executorId);
  return loop.snapshot(projectId);
});

ipcMain.handle('executors:runAction', async (_event, input = {}) => {
  const projectId = requiredProjectId(input);
  const executorId = requiredRecordId(input, 'executorId');
  if (isGoRuntimeMode()) {
    return processExecutorRunResult(await goDataClient.runExecutorAction(projectId, executorId, input && input.action), executorId);
  }
  return loop.runExecutorAction(projectId, executorId, input && input.action);
});

ipcMain.handle('executors:importTasksJson', async (_event, input = {}) => {
  const projectId = requiredProjectId(input);
  const tasksJson = await readExecutorTasksJsonInput(input);
  const result = executorStore().importTasksJson(projectId, tasksJson);
  return { ...result, snapshot: loop.snapshot(projectId) };
});

// ------------------------------------------------------- chat:* IPC（需求 #26）----------------------------------------------

ipcMain.handle('chat:send', async (_event, input = {}) => {
  assertLegacyChatAdapterEnabled();
  const projectId = requiredProjectId(input);
  const message = String(input.message || '').trim();
  if (!message) return { accepted: false, error: '消息不能为空' };

  if (isGoRuntimeMode()) {
    const conversationId = requiredRecordId(input, 'conversationId');
    const result = await goDataClient.sendChat(projectId, conversationId, message);
    return { accepted: true, conversationId, operation: result.operation, snapshot: result.snapshot || loop.snapshot(projectId) };
  }

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

ipcMain.handle('chat:stop', async (_event, input = {}) => {
  assertLegacyChatAdapterEnabled();
  const projectId = requiredProjectId(input);
  const conversationId = Number(input.conversationId || 0);
  if (!conversationId) return { stopped: false, error: 'conversationId 不能为空' };
  if (isGoRuntimeMode()) {
    const result = await goDataClient.stopChat(projectId, conversationId);
    return { stopped: true, operation: result.operation, snapshot: result.snapshot || loop.snapshot(projectId) };
  }
  if (!conversationInProject(conversationId, projectId)) {
    return { stopped: false, error: '对话不存在或不属于当前项目' };
  }
  const controller = chatControllers?.get(conversationId);
  if (controller) controller.stop();
  return { stopped: true };
});

ipcMain.handle('chat:clear', async (_event, input = {}) => {
  assertLegacyChatAdapterEnabled();
  const projectId = requiredProjectId(input);
  const conversationId = Number(input.conversationId || 0);
  if (!conversationId) return { cleared: false, error: 'conversationId 不能为空' };
  if (isGoRuntimeMode()) {
    const result = await goDataClient.clearChat(projectId, conversationId);
    return { cleared: true, operation: result.operation, snapshot: result.snapshot || loop.snapshot(projectId) };
  }
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
  assertLegacyChatAdapterEnabled();
  const projectId = requiredProjectId(input);
  const conversationId = Number(input.conversationId || 0);
  if (!conversationId) return [];
  if (isGoRuntimeMode()) {
    const messages = loop.snapshot(projectId).chat_messages || loop.snapshot(projectId).messages || [];
    return messages.filter((message) => Number(message?.conversation_id || message?.conversationId) === conversationId);
  }
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
  assertLegacyChatAdapterEnabled();
  if (isGoRuntimeMode()) return null;
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
  assertLegacyChatAdapterEnabled();
  const projectId = requiredProjectId(input);
  return listConversations(db, projectId);
});

ipcMain.handle('conversation:create', (_event, input = {}) => {
  assertLegacyChatAdapterEnabled();
  const projectId = requiredProjectId(input);
  return createConversation(db, conversationCreateInput(input, projectId));
});

ipcMain.handle('conversation:update', (_event, input = {}) => {
  assertLegacyChatAdapterEnabled();
  const projectId = requiredProjectId(input);
  const id = requiredRecordId(input, 'conversationId');
  requireConversationInProject(id, projectId);
  return updateConversation(db, id, conversationUpdateInput(input, projectId));
});

ipcMain.handle('conversation:delete', (_event, input = {}) => {
  assertLegacyChatAdapterEnabled();
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
    codexBackendConfig, legacyAdapterDisabled: isGoChatHTTPEnabled(),
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

function scheduleMcpServerStart() {
  // MCP is started by the Go daemon lifecycle. Electron never owns a
  // listener, including in compatibility mode.
}

function scheduleMcpServerRestart() {
  // Persisted configuration is consumed by the next Go daemon lifecycle.
}

async function startMcpServer() {
  if (!isGoRuntimeMode()) throw new GoDataClientError('go_mcp_transport_required');
  const result = await goDataClient.startMcp();
  return { enabled: true, running: true, owner: 'go', operation: result.operation, gate: 'go_mcp_api' };
}

async function stopMcpServer() {
  if (!isGoRuntimeMode()) throw new GoDataClientError('go_mcp_transport_required');
  const result = await goDataClient.stopMcp();
  return { enabled: true, running: false, owner: 'go', operation: result.operation, gate: 'go_mcp_api' };
}

function recordMcpStartupError(error) {
  const message = error?.message || String(error || '未知错误');
  console.error('[mcp] start failed', error);
  const projectId = loop?.defaultProjectId?.();
  if (projectId) loop.addEvent(projectId, 'mcp.start.failed', `MCP 服务启动失败：${message}`, { error: message });
}

function readSavedMcpAuthToken() {
  if (isGoRuntimeMode()) return { hasAuthToken: false, authToken: '' };
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
  if (!projectId || (!isGoRuntimeMode() && !loop.project(projectId))) throw new Error('项目不存在');
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

  try {
    // Resolve the workspace through the active runtime owner. Go mode has no
    // readable Node database and must never fall back to one for file access.
    const workspacePath = await loadProjectWorkspacePath({ projectId });
    const filePath = await resolveWorkspaceFilePath(workspacePath, relativePath);
    const mode = normalizeOpenFileMode(input.mode || readSetting('scopeFileOpenMode') || 'system');
    const command = String(input.command || readSetting('scopeFileOpenCommand') || '').trim();
    await openResolvedFilePath(filePath, mode, command);
    return openFileResult(true, '', { filePath, mode });
  } catch (error) {
    return openFileResult(false, openFileErrorMessage(error));
  }
}

async function openProjectFolder(input = {}) {
  return openProjectFolderFromRuntime({
    projectId: Number(input.projectId || input.id || 0),
    goRuntime: isGoRuntimeMode(),
    database: db,
    shell,
    loadGoProject: async (projectId) => {
      const response = await sidecarProjectRequest(
        daemonSupervisor.clientOptions(),
        `/api/v1/projects/${projectId}`,
        'GET',
      );
      return response?.data;
    },
  });
}

async function loadProjectWorkspacePath(input = {}) {
  const projectId = Number(input.projectId || input.id || 0);
  if (!Number.isSafeInteger(projectId) || projectId <= 0) throw new Error('project_not_found');
  const project = isGoRuntimeMode()
    ? (await sidecarProjectRequest(
      daemonSupervisor.clientOptions(),
      `/api/v1/projects/${projectId}`,
      'GET',
    ))?.data
    : db.get('SELECT workspace_path FROM projects WHERE id = ?', [projectId]);
  const workspacePath = String(project?.workspace_path || '').trim();
  if (!workspacePath) throw new Error('project_workspace_empty');
  return workspacePath;
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

function normalizeStrictIntakeType(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === 'requirement' || normalized === 'feedback') return normalized;
  throw new Error('需求/反馈类型无效');
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
