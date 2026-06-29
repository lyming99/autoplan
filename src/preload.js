const nodeUrl = require('node:url');
const { contextBridge, ipcRenderer, webUtils } = require('electron');

function toFileUrl(filePath) {
  const value = String(filePath || '').trim();
  if (!value || /^file:\/\//i.test(value)) return value;
  if (isPersistedAttachmentPath(value)) return `autoplan-file://attachment/${encodeURIComponent(value)}`;
  if (typeof nodeUrl.pathToFileURL === 'function') {
    return nodeUrl.pathToFileURL(value).toString();
  }
  return fallbackPathToFileUrl(value);
}

function isPersistedAttachmentPath(filePath) {
  return /[\\/]data[\\/]attachments[\\/]/i.test(filePath);
}

function fallbackPathToFileUrl(filePath) {
  const normalized = filePath.replace(/\\/g, '/');
  if (normalized.startsWith('//')) {
    const [host, ...segments] = normalized.replace(/^\/+/, '').split('/');
    return `file://${encodeURIComponent(host)}/${segments.map(encodeURIComponent).join('/')}`;
  }

  const pathname = normalized.startsWith('/') ? normalized : `/${normalized}`;
  const encodedPath = pathname
    .split('/')
    .map((segment, index) => (index === 1 && /^[A-Za-z]:$/.test(segment) ? segment : encodeURIComponent(segment)))
    .join('/');
  return `file://${encodedPath}`;
}

contextBridge.exposeInMainWorld('autoplan', {
  mcpToolNames: [
    'list_projects',
    'get_project',
    'create_project',
    'list_requirements',
    'create_requirement',
    'list_feedback',
    'create_feedback',
    'list_plans',
    'get_plan',
    'list_tasks',
    'start_loop',
    'stop_loop',
  ],
  snapshot: (projectId) => ipcRenderer.invoke('snapshot', { projectId }),
  createProject: (input) => ipcRenderer.invoke('projects:create', input),
  updateProject: (input) => ipcRenderer.invoke('projects:update', input),
  deleteProject: (input) => ipcRenderer.invoke('projects:delete', input),
  configureLoop: (config) => ipcRenderer.invoke('loop:configure', config),
  startLoop: (input) => ipcRenderer.invoke('loop:start', input),
  stopLoop: (input) => ipcRenderer.invoke('loop:stop', input),
  runOnce: (input) => ipcRenderer.invoke('loop:runOnce', input),
  startMcp: (input) => ipcRenderer.invoke('mcp:start', input),
  stopMcp: (input) => ipcRenderer.invoke('mcp:stop', input),
  mcpStatus: (input) => ipcRenderer.invoke('mcp:status', input),
  saveMcpConfig: (config) => ipcRenderer.invoke('mcp:saveConfig', config),
  readPlan: (input) => ipcRenderer.invoke('plans:read', input),
  reorderPlans: (input) => ipcRenderer.invoke('plans:reorder', input),
  openWorkspaceFile: (input) => ipcRenderer.invoke('workspace:openFile', input),
  pickDirectory: () => ipcRenderer.invoke('projects:pickDirectory'),
  openProjectFolder: (input) => ipcRenderer.invoke('projects:openFolder', input),
  runTask: (input) => ipcRenderer.invoke('tasks:run', input),
  runTaskBatches: (input) => ipcRenderer.invoke('tasks:runParallel', input),
  stopTask: (input) => ipcRenderer.invoke('tasks:stop', input),
  acceptItem: (input) => ipcRenderer.invoke('acceptance:accept', input),
  unacceptItem: (input) => ipcRenderer.invoke('acceptance:unaccept', input),
  createRequirement: (input) => ipcRenderer.invoke('requirements:create', input),
  updateRequirement: (input) => ipcRenderer.invoke('requirements:update', input),
  deleteRequirement: (input) => ipcRenderer.invoke('requirements:delete', input),
  createFeedback: (input) => ipcRenderer.invoke('feedback:create', input),
  updateFeedback: (input) => ipcRenderer.invoke('feedback:update', input),
  deleteFeedback: (input) => ipcRenderer.invoke('feedback:delete', input),
  interruptIntake: (input) => ipcRenderer.invoke('intake:interrupt', input),
  resumeIntake: (input) => ipcRenderer.invoke('intake:resume', input),
  appendIntakeTask: (input) => ipcRenderer.invoke('intake:appendTask', input),
  pickScriptFile: (input) => ipcRenderer.invoke('scripts:pickFile', input),
  createScript: (input) => ipcRenderer.invoke('scripts:create', input),
  updateScript: (input) => ipcRenderer.invoke('scripts:update', input),
  deleteScript: (input) => ipcRenderer.invoke('scripts:delete', input),
  toggleScript: (input) => ipcRenderer.invoke('scripts:toggle', input),
  runScript: (input) => ipcRenderer.invoke('scripts:run', input),
  stopScript: (input) => ipcRenderer.invoke('scripts:stop', input),
  getDroppedFilePath: (file) => webUtils.getPathForFile(file),
  toFileUrl,
  onLoopUpdate: (handler) => {
    const listener = (_event, snapshot) => handler(snapshot);
    ipcRenderer.on('loop:update', listener);
    return () => ipcRenderer.removeListener('loop:update', listener);
  },
});
