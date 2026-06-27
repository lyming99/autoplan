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
  mcpToolNames: ['create_project', 'create_requirement', 'create_feedback'],
  snapshot: (projectId) => ipcRenderer.invoke('snapshot', { projectId }),
  createProject: (input) => ipcRenderer.invoke('projects:create', input),
  updateProject: (input) => ipcRenderer.invoke('projects:update', input),
  deleteProject: (input) => ipcRenderer.invoke('projects:delete', input),
  configureLoop: (config) => ipcRenderer.invoke('loop:configure', config),
  startLoop: (input) => ipcRenderer.invoke('loop:start', input),
  stopLoop: (input) => ipcRenderer.invoke('loop:stop', input),
  runOnce: (input) => ipcRenderer.invoke('loop:runOnce', input),
  readPlan: (input) => ipcRenderer.invoke('plans:read', input),
  reorderPlans: (input) => ipcRenderer.invoke('plans:reorder', input),
  openWorkspaceFile: (input) => ipcRenderer.invoke('workspace:openFile', input),
  runTask: (input) => ipcRenderer.invoke('tasks:run', input),
  runTaskBatches: (input) => ipcRenderer.invoke('tasks:runParallel', input),
  stopTask: (input) => ipcRenderer.invoke('tasks:stop', input),
  createRequirement: (input) => ipcRenderer.invoke('requirements:create', input),
  updateRequirement: (input) => ipcRenderer.invoke('requirements:update', input),
  deleteRequirement: (input) => ipcRenderer.invoke('requirements:delete', input),
  createFeedback: (input) => ipcRenderer.invoke('feedback:create', input),
  updateFeedback: (input) => ipcRenderer.invoke('feedback:update', input),
  deleteFeedback: (input) => ipcRenderer.invoke('feedback:delete', input),
  interruptIntake: (input) => ipcRenderer.invoke('intake:interrupt', input),
  resumeIntake: (input) => ipcRenderer.invoke('intake:resume', input),
  appendIntakeTask: (input) => ipcRenderer.invoke('intake:appendTask', input),
  getDroppedFilePath: (file) => webUtils.getPathForFile(file),
  toFileUrl,
  onLoopUpdate: (handler) => {
    const listener = (_event, snapshot) => handler(snapshot);
    ipcRenderer.on('loop:update', listener);
    return () => ipcRenderer.removeListener('loop:update', listener);
  },
});
