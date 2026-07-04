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

function aiConfigCreatePayload(payload = {}) {
  const source = payload && typeof payload === 'object' ? payload : {};
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

function aiConfigUpdatePayload(payload = {}) {
  const source = payload && typeof payload === 'object' ? payload : {};
  const next = {
    configId: source.configId ?? source.id,
  };
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
    if (Object.prototype.hasOwnProperty.call(source, key)) next[key] = source[key];
  }
  return next;
}

function aiConfigIdPayload(payload = {}) {
  const source = payload && typeof payload === 'object' ? payload : {};
  return { configId: source.configId ?? source.id };
}

function chatSendPayload(payload = {}) {
  const source = payload && typeof payload === 'object' ? payload : {};
  return {
    projectId: source.projectId,
    conversationId: source.conversationId,
    message: source.message,
  };
}

function chatConversationPayload(payload = {}) {
  const source = payload && typeof payload === 'object' ? payload : {};
  return {
    projectId: source.projectId,
    conversationId: source.conversationId ?? source.id,
  };
}

function chatQueuePayload(payload = {}) {
  const source = payload && typeof payload === 'object' ? payload : {};
  return {
    projectId: source.projectId,
    conversationId: source.conversationId ?? source.id,
    id: source.id,
    message: source.message,
  };
}

function conversationCreatePayload(payload = {}) {
  const source = payload && typeof payload === 'object' ? payload : {};
  return {
    projectId: source.projectId,
    title: source.title,
    aiConfigId: source.aiConfigId ?? source.ai_config_id,
  };
}

function conversationUpdatePayload(payload = {}) {
  const source = payload && typeof payload === 'object' ? payload : {};
  const next = {
    projectId: source.projectId,
    conversationId: source.conversationId ?? source.id,
  };
  for (const key of ['title', 'aiConfigId', 'ai_config_id', 'pinned', 'isPinned', 'pinnedAt', 'pinned_at']) {
    if (Object.prototype.hasOwnProperty.call(source, key)) next[key] = source[key];
  }
  return next;
}

function terminalSessionPayload(payload = {}) {
  const source = payload && typeof payload === 'object' ? payload : {};
  return { sessionId: source.sessionId ?? source.id };
}

function terminalCreatePayload(payload = {}) {
  const source = payload && typeof payload === 'object' ? payload : {};
  return {
    projectId: source.projectId,
    title: source.title,
    cwd: source.cwd,
    profileId: source.profileId,
    profile: source.profile,
    cols: source.cols,
    rows: source.rows,
    env: source.env,
  };
}

function terminalWritePayload(payload = {}) {
  const source = payload && typeof payload === 'object' ? payload : {};
  return {
    sessionId: source.sessionId ?? source.id,
    data: source.data,
  };
}

function terminalResizePayload(payload = {}) {
  const source = payload && typeof payload === 'object' ? payload : {};
  return {
    sessionId: source.sessionId ?? source.id,
    cols: source.cols,
    rows: source.rows,
  };
}

function terminalRenamePayload(payload = {}) {
  const source = payload && typeof payload === 'object' ? payload : {};
  return {
    sessionId: source.sessionId ?? source.id,
    title: source.title,
  };
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
    'list_executors',
    'run_executor',
    'stop_executor',
    'run_executor_action',
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
  stopPlan: (input) => ipcRenderer.invoke('plans:stop', input),
  deletePlan: (input) => ipcRenderer.invoke('plans:delete', input),
  openWorkspaceFile: (input) => ipcRenderer.invoke('workspace:openFile', input),
  pickDirectory: () => ipcRenderer.invoke('projects:pickDirectory'),
  openProjectFolder: (input) => ipcRenderer.invoke('projects:openFolder', input),
  runTask: (input) => ipcRenderer.invoke('tasks:run', input),
  runTaskBatches: (input) => ipcRenderer.invoke('tasks:runParallel', input),
  stopTask: (input) => ipcRenderer.invoke('tasks:stop', input),
  acceptItem: (input) => ipcRenderer.invoke('acceptance:accept', input),
  unacceptItem: (input) => ipcRenderer.invoke('acceptance:unaccept', input),
  acceptItems: (input) => ipcRenderer.invoke('acceptance:acceptBatch', input),
  unacceptItems: (input) => ipcRenderer.invoke('acceptance:unacceptBatch', input),
  createRequirement: (input) => ipcRenderer.invoke('requirements:create', input),
  updateRequirement: (input) => ipcRenderer.invoke('requirements:update', input),
  deleteRequirement: (input) => ipcRenderer.invoke('requirements:delete', input),
  createFeedback: (input) => ipcRenderer.invoke('feedback:create', input),
  updateFeedback: (input) => ipcRenderer.invoke('feedback:update', input),
  deleteFeedback: (input) => ipcRenderer.invoke('feedback:delete', input),
  interruptIntake: (input) => ipcRenderer.invoke('intake:interrupt', input),
  resumeIntake: (input) => ipcRenderer.invoke('intake:resume', input),
  appendIntakeTask: (input) => ipcRenderer.invoke('intake:appendTask', input),
  retryIntakePlanGeneration: (input) => ipcRenderer.invoke('intake:retryGeneratePlan', input),
  pickScriptFile: (input) => ipcRenderer.invoke('scripts:pickFile', input),
  createScript: (input) => ipcRenderer.invoke('scripts:create', input),
  updateScript: (input) => ipcRenderer.invoke('scripts:update', input),
  deleteScript: (input) => ipcRenderer.invoke('scripts:delete', input),
  toggleScript: (input) => ipcRenderer.invoke('scripts:toggle', input),
  runScript: (input) => ipcRenderer.invoke('scripts:run', input),
  stopScript: (input) => ipcRenderer.invoke('scripts:stop', input),
  pickTasksJson: () => ipcRenderer.invoke('executors:pickTasksJson'),
  createExecutor: (input) => ipcRenderer.invoke('executors:create', input),
  updateExecutor: (input) => ipcRenderer.invoke('executors:update', input),
  deleteExecutor: (input) => ipcRenderer.invoke('executors:delete', input),
  toggleExecutor: (input) => ipcRenderer.invoke('executors:toggle', input),
  runExecutor: (input) => ipcRenderer.invoke('executors:run', input),
  stopExecutor: (input) => ipcRenderer.invoke('executors:stop', input),
  runExecutorAction: (input) => ipcRenderer.invoke('executors:runAction', input),
  importTasksJson: (input) => ipcRenderer.invoke('executors:importTasksJson', input),
  createTerminal: (input) => ipcRenderer.invoke('terminal:create', terminalCreatePayload(input)),
  listTerminals: (input) => ipcRenderer.invoke('terminal:list', input),
  writeTerminal: (input) => ipcRenderer.invoke('terminal:write', terminalWritePayload(input)),
  resizeTerminal: (input) => ipcRenderer.invoke('terminal:resize', terminalResizePayload(input)),
  killTerminal: (input) => ipcRenderer.invoke('terminal:kill', terminalSessionPayload(input)),
  closeTerminal: (input) => ipcRenderer.invoke('terminal:close', terminalSessionPayload(input)),
  renameTerminal: (input) => ipcRenderer.invoke('terminal:rename', terminalRenamePayload(input)),
  replayTerminal: (input) => ipcRenderer.invoke('terminal:replay', terminalSessionPayload(input)),
  clearTerminal: (input) => ipcRenderer.invoke('terminal:clear', terminalSessionPayload(input)),
  getDroppedFilePath: (file) => webUtils.getPathForFile(file),
  toFileUrl,
  updateStatus: () => ipcRenderer.invoke('updates:status'),
  checkForUpdates: () => ipcRenderer.invoke('updates:check'),
  dismissUpdate: (input) => ipcRenderer.invoke('updates:dismiss', input),
  setAutoUpdateCheck: (enabled) => ipcRenderer.invoke('updates:setAutoCheck', { enabled }),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', { url }),
  onLoopUpdate: (handler) => {
    const listener = (_event, snapshot) => handler(snapshot);
    ipcRenderer.on('loop:update', listener);
    return () => ipcRenderer.removeListener('loop:update', listener);
  },
  onLoopPatch: (handler) => {
    const listener = (_event, patch) => handler(patch);
    ipcRenderer.on('loop:patch', listener);
    return () => ipcRenderer.removeListener('loop:patch', listener);
  },
  onUpdateStatus: (handler) => {
    const listener = (_event, status) => handler(status);
    ipcRenderer.on('updates:status', listener);
    return () => ipcRenderer.removeListener('updates:status', listener);
  },
  onTerminalData: (handler) => {
    const listener = (_event, data) => handler(data);
    ipcRenderer.on('terminal:data', listener);
    return () => ipcRenderer.removeListener('terminal:data', listener);
  },
  onTerminalExit: (handler) => {
    const listener = (_event, data) => handler(data);
    ipcRenderer.on('terminal:exit', listener);
    return () => ipcRenderer.removeListener('terminal:exit', listener);
  },
  onTerminalStatus: (handler) => {
    const listener = (_event, data) => handler(data);
    ipcRenderer.on('terminal:status', listener);
    return () => ipcRenderer.removeListener('terminal:status', listener);
  },
  // Chat 对话模块（需求 #26 / #28）
  chatSend: (payload) => ipcRenderer.invoke('chat:send', chatSendPayload(payload)),
  chatStop: (payload) => ipcRenderer.invoke('chat:stop', chatConversationPayload(payload)),
  chatClear: (payload) => ipcRenderer.invoke('chat:clear', chatConversationPayload(payload)),
  chatHistory: (payload) => ipcRenderer.invoke('chat:history', chatConversationPayload(payload)),
  chatSaveConfig: (config) => ipcRenderer.invoke('chat:saveConfig', config),
  chatGetConfig: () => ipcRenderer.invoke('chat:getConfig'),
  onChatChunk: (handler) => {
    const listener = (_event, data) => handler(data);
    ipcRenderer.on('chat:chunk', listener);
    return () => ipcRenderer.removeListener('chat:chunk', listener);
  },
  onChatDone: (handler) => {
    const listener = (_event, data) => handler(data);
    ipcRenderer.on('chat:done', listener);
    return () => ipcRenderer.removeListener('chat:done', listener);
  },
  // 队列发送（需求 #37）
  chatQueueList: (payload) => ipcRenderer.invoke('chat:queueList', chatConversationPayload(payload)),
  chatQueueCancel: (payload) => ipcRenderer.invoke('chat:queueCancel', chatQueuePayload(payload)),
  chatQueueEdit: (payload) => ipcRenderer.invoke('chat:queueEdit', chatQueuePayload(payload)),
  chatQueueClear: (payload) => ipcRenderer.invoke('chat:queueClear', chatConversationPayload(payload)),
  onChatQueue: (handler) => {
    const listener = (_event, data) => handler(data);
    ipcRenderer.on('chat:queue', listener);
    return () => ipcRenderer.removeListener('chat:queue', listener);
  },
  // AI 配置（需求 #28）
  aiConfigList: () => ipcRenderer.invoke('ai-config:list'),
  aiConfigCreate: (payload) => ipcRenderer.invoke('ai-config:create', aiConfigCreatePayload(payload)),
  aiConfigUpdate: (payload) => ipcRenderer.invoke('ai-config:update', aiConfigUpdatePayload(payload)),
  aiConfigDelete: (payload) => ipcRenderer.invoke('ai-config:delete', aiConfigIdPayload(payload)),
  aiConfigGet: (payload) => ipcRenderer.invoke('ai-config:get', aiConfigIdPayload(payload)),
  onAiConfigChanged: (handler) => {
    const listener = (_event, data) => handler(data);
    ipcRenderer.on('ai-config:changed', listener);
    return () => ipcRenderer.removeListener('ai-config:changed', listener);
  },
  // 对话管理（需求 #28）
  conversationList: (payload) => ipcRenderer.invoke('conversation:list', { projectId: payload?.projectId }),
  conversationCreate: (payload) => ipcRenderer.invoke('conversation:create', conversationCreatePayload(payload)),
  conversationUpdate: (payload) => ipcRenderer.invoke('conversation:update', conversationUpdatePayload(payload)),
  conversationDelete: (payload) => ipcRenderer.invoke('conversation:delete', chatConversationPayload(payload)),
  // 文件访问范围（需求 #35）：读取/保存访问策略配置
  fileAccess: {
    get: () => ipcRenderer.invoke('file-access:get'),
    save: (config) => ipcRenderer.invoke('file-access:save', config),
  },
});
