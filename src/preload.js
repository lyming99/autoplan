'use strict';

const nodeUrl = require('node:url');
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const HTTP_RUNTIME_CONFIG_KEY = '__AUTOPLAN_HTTP_RUNTIME__';
const RUNTIME_FEATURE_KEYS = new Set([
  'go_loop_actions', 'go_plan_actions', 'go_task_actions', 'go_acceptance_retry_actions',
  'go_scripts_api', 'go_executors_api', 'go_chat_api', 'go_terminal_api', 'go_agent_cli_runtime',
]);

function rendererRuntimeConfig() {
  let value;
  try { value = ipcRenderer.sendSync('runtime:rendererConfig'); }
  catch { throw new Error('runtime_transport_configuration_invalid'); }
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some((key) => !['baseUrl', 'credentialMode', 'runtimeFeatures'].includes(key)) ||
      value.credentialMode !== 'cookie' || !validLoopbackRuntimeUrl(value.baseUrl)) {
    throw new Error('runtime_transport_configuration_invalid');
  }
  return Object.freeze({ baseUrl: value.baseUrl, credentialMode: 'cookie', runtimeFeatures: normalizeRuntimeFeatures(value.runtimeFeatures) });
}

function validLoopbackRuntimeUrl(value) {
  try {
    const parsed = new URL(String(value));
    return parsed.protocol === 'http:' && parsed.hostname === '127.0.0.1' && Boolean(parsed.port) &&
      !parsed.username && !parsed.password && parsed.pathname === '/' && !parsed.search && !parsed.hash;
  } catch { return false; }
}

function normalizeRuntimeFeatures(value) {
  const disabled = Object.fromEntries([...RUNTIME_FEATURE_KEYS].map((key) => [key, false]));
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== RUNTIME_FEATURE_KEYS.size ||
      Object.keys(value).some((key) => !RUNTIME_FEATURE_KEYS.has(key)) ||
      Object.values(value).some((enabled) => typeof enabled !== 'boolean')) return Object.freeze(disabled);
  return Object.freeze({ ...disabled, ...value });
}

function toFileUrl(filePath) {
  const value = String(filePath || '').trim();
  if (!value || /^file:\/\//i.test(value) || /^autoplan-file:\/\//i.test(value)) return value;
  return typeof nodeUrl.pathToFileURL === 'function' ? nodeUrl.pathToFileURL(value).toString() : '';
}

function onUpdateStatus(handler) {
  if (typeof handler !== 'function') throw new TypeError('update handler invalid');
  const listener = (_event, status) => handler(status);
  ipcRenderer.on('updates:status', listener);
  return () => ipcRenderer.removeListener('updates:status', listener);
}

const runtimeConfig = rendererRuntimeConfig();
contextBridge.exposeInMainWorld(HTTP_RUNTIME_CONFIG_KEY, runtimeConfig);
contextBridge.exposeInMainWorld('autoplan', Object.freeze({
  pickDirectory: () => ipcRenderer.invoke('projects:pickDirectory'),
  openProjectFolder: (input) => ipcRenderer.invoke('projects:openFolder', input),
  openProjectTerminal: (input) => ipcRenderer.invoke('projects:openTerminal', input),
  openLogFolder: () => ipcRenderer.invoke('logs:openFolder'),
  openWorkspaceFile: (input) => ipcRenderer.invoke('workspace:openFile', input),
  pickScriptFile: () => ipcRenderer.invoke('scripts:pickFile'),
  pickTasksJson: () => ipcRenderer.invoke('executors:pickTasksJson'),
  getDroppedFilePath: (file) => webUtils.getPathForFile(file),
  toFileUrl,
  updateStatus: () => ipcRenderer.invoke('updates:status'),
  checkForUpdates: () => ipcRenderer.invoke('updates:check'),
  dismissUpdate: (input) => ipcRenderer.invoke('updates:dismiss', input),
  setAutoUpdateCheck: (enabled) => ipcRenderer.invoke('updates:setAutoCheck', { enabled: Boolean(enabled) }),
  openUpdateInstaller: () => ipcRenderer.invoke('updates:openInstaller'),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', { url }),
  onUpdateStatus,
}));
