const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, ipcMain, Menu } = require('electron');
const { saveAttachments } = require('./attachments');
const { AppDatabase, nowIso } = require('./database');
const { LoopService, nextIntakeAgentCliConfig } = require('./loopService');

let mainWindow;
let db;
let loop;

async function createApp() {
  Menu.setApplicationMenu(null);
  db = new AppDatabase(path.join(app.getPath('userData'), 'data', 'autoplan.sqlite'));
  await db.init();
  loop = new LoopService(db);
  loop.on('update', (snapshot) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('loop:update', snapshot);
    }
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
}

app.whenReady().then(createApp);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (loop) loop.stop();
});

ipcMain.handle('snapshot', (_event, input = {}) => loop.snapshot(input.projectId || null));

ipcMain.handle('plans:read', async (_event, input = {}) => readPlan(input));

ipcMain.handle('projects:create', (_event, input = {}) => {
  const now = nowIso();
  const name = String(input.name || '').trim() || titleFromBody(input.workspacePath, '未命名项目');
  const id = db.insert(
    `INSERT INTO projects (name, workspace_path, description, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
    [name, input.workspacePath || '', input.description || '', now, now],
  );
  loop.ensureProjectState(id);
  if (loop.hasRuntimeConfigInput(input)) {
    loop.configure(id, input);
  }
  return loop.snapshot(id);
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

ipcMain.handle('loop:configure', (_event, config = {}) => {
  const projectId = requiredProjectId(config);
  loop.configure(projectId, config);
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

ipcMain.handle('tasks:run', async (_event, input = {}) => {
  const projectId = requiredProjectId(input);
  await loop.runTask(projectId, requiredRecordId(input, 'taskId'));
  return loop.snapshot(projectId);
});

ipcMain.handle('tasks:stop', (_event, input = {}) => {
  const projectId = requiredProjectId(input);
  loop.stopTask(projectId, requiredRecordId(input, 'taskId'));
  return loop.snapshot(projectId);
});

ipcMain.handle('requirements:create', (_event, input = {}) => {
  const projectId = requiredProjectId(input);
  const now = nowIso();
  const agentCliConfig = nextIntakeAgentCliConfig({}, input);
  const id = db.insert(
    `INSERT INTO requirements (
       project_id, title, body, status, agent_cli_provider, agent_cli_command, codex_reasoning_effort, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      projectId,
      titleFromBody(input.body, '未命名需求'),
      input.body || '',
      input.status || 'open',
      agentCliConfig.provider,
      agentCliConfig.command,
      agentCliConfig.codexReasoningEffort,
      now,
      now,
    ],
  );
  saveAttachments(db, attachmentsRoot(), 'requirement', id, input.attachments, projectId);
  loop.addEvent(projectId, 'requirement.created', `需求 #${id} 已创建，等待循环扫描生成计划`);
  return loop.snapshot(projectId);
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
  const rec = db.get('SELECT linked_plan_id FROM requirements WHERE id = ? AND project_id = ?', [id, projectId]);
  if (rec?.linked_plan_id) loop.interruptPlan(projectId, rec.linked_plan_id);
  deleteIntakeRecord('requirements', 'requirement', projectId, id);
  return loop.snapshot(projectId);
});

ipcMain.handle('feedback:create', (_event, input = {}) => {
  const projectId = requiredProjectId(input);
  const now = nowIso();
  const agentCliConfig = nextIntakeAgentCliConfig({}, input);
  const id = db.insert(
    `INSERT INTO feedback (
       project_id, requirement_id, title, body, status, agent_cli_provider, agent_cli_command, codex_reasoning_effort, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      projectId,
      input.requirementId || null,
      titleFromBody(input.body, '未命名反馈'),
      input.body || '',
      input.status || 'open',
      agentCliConfig.provider,
      agentCliConfig.command,
      agentCliConfig.codexReasoningEffort,
      now,
      now,
    ],
  );
  saveAttachments(db, attachmentsRoot(), 'feedback', id, input.attachments, projectId);
  loop.addEvent(projectId, 'feedback.created', `反馈 #${id} 已创建，等待循环扫描生成计划`);
  return loop.snapshot(projectId);
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
  const rec = db.get('SELECT linked_plan_id FROM feedback WHERE id = ? AND project_id = ?', [id, projectId]);
  if (rec?.linked_plan_id) loop.interruptPlan(projectId, rec.linked_plan_id);
  deleteIntakeRecord('feedback', 'feedback', projectId, id);
  return loop.snapshot(projectId);
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

function attachmentsRoot() {
  return path.join(app.getPath('userData'), 'data', 'attachments');
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
  return {
    ok: !error,
    id: plan?.id ?? null,
    project_id: plan?.project_id ?? null,
    file_path: plan?.file_path || '',
    markdown,
    hash: plan?.hash || '',
    updated_at: plan?.updated_at || '',
    error,
  };
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

function requireManualAction(input = {}, label = '操作') {
  if (input.manual !== true) throw new Error(`${label}需要用户显式触发`);
}

function requiredRecordId(input = {}, key = 'id') {
  const id = Number(input[key] || input.id || 0);
  if (!id) throw new Error('记录不存在');
  return id;
}

function deleteIntakeRecord(table, ownerType, projectId, id) {
  const current = db.get(`SELECT id FROM ${table} WHERE id = ? AND project_id = ?`, [id, projectId]);
  if (!current) throw new Error('记录不存在');

  if (ownerType === 'requirement') {
    db.run('UPDATE feedback SET requirement_id = NULL, updated_at = ? WHERE project_id = ? AND requirement_id = ?', [
      nowIso(),
      projectId,
      id,
    ]);
  }

  db.run('DELETE FROM attachments WHERE project_id = ? AND owner_type = ? AND owner_id = ?', [projectId, ownerType, id]);
  db.run(`DELETE FROM ${table} WHERE id = ? AND project_id = ?`, [id, projectId]);
}

function titleFromBody(body, fallback) {
  const firstLine = String(body || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  return firstLine ? firstLine.slice(0, 80) : fallback;
}
