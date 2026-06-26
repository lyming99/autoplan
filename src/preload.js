const { pathToFileURL } = require('node:url');
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('autoplan', {
  snapshot: (projectId) => ipcRenderer.invoke('snapshot', { projectId }),
  createProject: (input) => ipcRenderer.invoke('projects:create', input),
  updateProject: (input) => ipcRenderer.invoke('projects:update', input),
  deleteProject: (input) => ipcRenderer.invoke('projects:delete', input),
  configureLoop: (config) => ipcRenderer.invoke('loop:configure', config),
  startLoop: (input) => ipcRenderer.invoke('loop:start', input),
  stopLoop: (input) => ipcRenderer.invoke('loop:stop', input),
  runOnce: (input) => ipcRenderer.invoke('loop:runOnce', input),
  readPlan: (input) => ipcRenderer.invoke('plans:read', input),
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
  toFileUrl: (filePath) => pathToFileURL(filePath).toString(),
  onLoopUpdate: (handler) => {
    const listener = (_event, snapshot) => handler(snapshot);
    ipcRenderer.on('loop:update', listener);
    return () => ipcRenderer.removeListener('loop:update', listener);
  },
});
