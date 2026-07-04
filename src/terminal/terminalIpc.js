'use strict';

const {
  TERMINAL_CHANNELS,
  TERMINAL_ERROR_CODES,
  TERMINAL_LIMITS,
  terminalError,
} = require('./terminalTypes');

function registerTerminalIpc({ ipcMain, terminalService, getProject, sendToRenderer }) {
  if (!ipcMain || !terminalService || typeof getProject !== 'function') {
    throw new Error('终端 IPC 注册参数不完整');
  }

  const send = typeof sendToRenderer === 'function' ? sendToRenderer : () => {};

  terminalService.on(TERMINAL_CHANNELS.DATA, (event) => send(TERMINAL_CHANNELS.DATA, safeTerminalEvent(event)));
  terminalService.on(TERMINAL_CHANNELS.EXIT, (event) => send(TERMINAL_CHANNELS.EXIT, safeTerminalEvent(event)));
  terminalService.on(TERMINAL_CHANNELS.STATUS, (event) => send(TERMINAL_CHANNELS.STATUS, safeTerminalEvent(event)));

  ipcMain.handle(TERMINAL_CHANNELS.CREATE, (_event, input = {}) => withTerminalError(() => {
    const payload = createPayload(input);
    if (!payload.ok) return payload.error;
    const project = getProject(payload.value.projectId);
    if (!project) return terminalError(TERMINAL_ERROR_CODES.INVALID_PROJECT, '项目不存在');
    return normalizeTerminalResult(terminalService.createSession(project, payload.value));
  }));

  ipcMain.handle(TERMINAL_CHANNELS.LIST, (_event, input = {}) => withTerminalError(() => {
    const projectId = requiredProjectId(input);
    if (!projectId.ok) return projectId.error;
    if (!getProject(projectId.value)) return terminalError(TERMINAL_ERROR_CODES.INVALID_PROJECT, '项目不存在');
    return { ok: true, sessions: terminalService.listSessions(projectId.value).map(safeTerminalSession) };
  }));

  ipcMain.handle(TERMINAL_CHANNELS.WRITE, (_event, input = {}) => withTerminalError(() => {
    const payload = writePayload(input);
    if (!payload.ok) return payload.error;
    return normalizeTerminalResult(terminalService.write(payload.value.sessionId, payload.value.data));
  }));

  ipcMain.handle(TERMINAL_CHANNELS.RESIZE, (_event, input = {}) => withTerminalError(() => {
    const payload = resizePayload(input);
    if (!payload.ok) return payload.error;
    return normalizeTerminalResult(terminalService.resize(payload.value.sessionId, payload.value.cols, payload.value.rows));
  }));

  ipcMain.handle(TERMINAL_CHANNELS.KILL, (_event, input = {}) => withTerminalError(() => {
    const sessionId = requiredSessionId(input);
    if (!sessionId.ok) return sessionId.error;
    return normalizeTerminalResult(terminalService.kill(sessionId.value));
  }));

  ipcMain.handle(TERMINAL_CHANNELS.CLOSE, (_event, input = {}) => withTerminalError(() => {
    const sessionId = requiredSessionId(input);
    if (!sessionId.ok) return sessionId.error;
    return normalizeTerminalResult(terminalService.close(sessionId.value));
  }));

  ipcMain.handle(TERMINAL_CHANNELS.RENAME, (_event, input = {}) => withTerminalError(() => {
    const payload = renamePayload(input);
    if (!payload.ok) return payload.error;
    return normalizeTerminalResult(terminalService.rename(payload.value.sessionId, payload.value.title));
  }));

  ipcMain.handle(TERMINAL_CHANNELS.REPLAY, (_event, input = {}) => withTerminalError(() => {
    const sessionId = requiredSessionId(input);
    if (!sessionId.ok) return sessionId.error;
    return normalizeTerminalResult(terminalService.replay(sessionId.value));
  }));

  ipcMain.handle(TERMINAL_CHANNELS.CLEAR, (_event, input = {}) => withTerminalError(() => {
    const sessionId = requiredSessionId(input);
    if (!sessionId.ok) return sessionId.error;
    const found = typeof terminalService.findSession === 'function' ? terminalService.findSession(sessionId.value) : null;
    if (!found || !found.ok) return found?.error || terminalError(TERMINAL_ERROR_CODES.SESSION_NOT_FOUND, '终端会话不存在');
    found.session.scrollback = [];
    return { ok: true, session: safeTerminalSession(found.session) };
  }));
}

function withTerminalError(fn) {
  try {
    const result = fn();
    return result && typeof result === 'object' ? result : terminalError(TERMINAL_ERROR_CODES.INVALID_PAYLOAD, '终端请求无效');
  } catch (error) {
    return terminalError(TERMINAL_ERROR_CODES.INVALID_PAYLOAD, error?.message || '终端请求处理失败');
  }
}

function createPayload(input) {
  const source = objectInput(input);
  const projectId = requiredProjectId(source);
  if (!projectId.ok) return projectId;
  const cols = optionalInteger(source.cols, TERMINAL_LIMITS.minCols, TERMINAL_LIMITS.maxCols, 'cols');
  if (!cols.ok) return cols;
  const rows = optionalInteger(source.rows, TERMINAL_LIMITS.minRows, TERMINAL_LIMITS.maxRows, 'rows');
  if (!rows.ok) return rows;
  const title = optionalText(source.title, TERMINAL_LIMITS.maxTitleLength, '终端标题过长');
  if (!title.ok) return title;
  const cwd = optionalText(source.cwd, TERMINAL_LIMITS.maxCwdLength, '终端工作目录过长');
  if (!cwd.ok) return cwd;

  const value = {
    projectId: projectId.value,
    title: title.value,
    cwd: cwd.value,
    profileId: optionalString(source.profileId),
    profile: normalizeProfileInput(source.profile ?? source.profileId),
    env: normalizeEnvInput(source.env),
  };
  if (cols.value !== undefined) value.cols = cols.value;
  if (rows.value !== undefined) value.rows = rows.value;
  return { ok: true, value };
}

function writePayload(input) {
  const source = objectInput(input);
  const sessionId = requiredSessionId(source);
  if (!sessionId.ok) return sessionId;
  const data = String(source.data ?? '');
  if (Buffer.byteLength(data, 'utf8') > TERMINAL_LIMITS.maxInputBytes) {
    return { ok: false, error: terminalError(TERMINAL_ERROR_CODES.INVALID_PAYLOAD, '终端输入过长') };
  }
  return { ok: true, value: { sessionId: sessionId.value, data } };
}

function resizePayload(input) {
  const source = objectInput(input);
  const sessionId = requiredSessionId(source);
  if (!sessionId.ok) return sessionId;
  const cols = requiredInteger(source.cols, TERMINAL_LIMITS.minCols, TERMINAL_LIMITS.maxCols, 'cols');
  if (!cols.ok) return cols;
  const rows = requiredInteger(source.rows, TERMINAL_LIMITS.minRows, TERMINAL_LIMITS.maxRows, 'rows');
  if (!rows.ok) return rows;
  return { ok: true, value: { sessionId: sessionId.value, cols: cols.value, rows: rows.value } };
}

function renamePayload(input) {
  const source = objectInput(input);
  const sessionId = requiredSessionId(source);
  if (!sessionId.ok) return sessionId;
  const title = optionalText(source.title, TERMINAL_LIMITS.maxTitleLength, '终端标题过长');
  if (!title.ok) return title;
  if (!String(title.value || '').trim()) {
    return { ok: false, error: terminalError(TERMINAL_ERROR_CODES.INVALID_PAYLOAD, '终端标题不能为空') };
  }
  return { ok: true, value: { sessionId: sessionId.value, title: title.value } };
}

function requiredProjectId(input) {
  const value = Number(objectInput(input).projectId || objectInput(input).id || 0);
  if (!Number.isInteger(value) || value <= 0) {
    return { ok: false, error: terminalError(TERMINAL_ERROR_CODES.INVALID_PROJECT, '项目不存在') };
  }
  return { ok: true, value };
}

function requiredSessionId(input) {
  const value = String(objectInput(input).sessionId || objectInput(input).id || '').trim();
  if (!value) {
    return { ok: false, error: terminalError(TERMINAL_ERROR_CODES.INVALID_SESSION, '终端会话 ID 不能为空') };
  }
  return { ok: true, value };
}

function requiredInteger(value, min, max, field) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    return { ok: false, error: terminalError(TERMINAL_ERROR_CODES.INVALID_PAYLOAD, `终端尺寸 ${field} 无效`) };
  }
  return { ok: true, value: number };
}

function optionalInteger(value, min, max, field) {
  if (value === undefined || value === null || value === '') return { ok: true, value: undefined };
  return requiredInteger(value, min, max, field);
}

function optionalText(value, maxLength, message) {
  if (value === undefined || value === null) return { ok: true, value: undefined };
  const text = String(value);
  if (text.length > maxLength) {
    return { ok: false, error: terminalError(TERMINAL_ERROR_CODES.INVALID_PAYLOAD, message) };
  }
  return { ok: true, value: text };
}

function normalizeProfileInput(profile) {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) return profile;
  return {
    id: optionalString(profile.id ?? profile.profileId),
    name: optionalString(profile.name ?? profile.label),
    kind: optionalString(profile.kind),
    shellPath: optionalString(profile.shellPath ?? profile.shell ?? profile.path),
    args: Array.isArray(profile.args) ? profile.args.map((arg) => String(arg ?? '')) : undefined,
    env: normalizeEnvInput(profile.env),
  };
}

function normalizeEnvInput(env) {
  if (!env || typeof env !== 'object' || Array.isArray(env)) return undefined;
  const result = {};
  for (const [key, value] of Object.entries(env)) {
    const name = String(key || '').trim();
    if (name) result[name] = value === undefined || value === null ? '' : String(value);
  }
  return result;
}

function normalizeTerminalResult(result) {
  if (!result || typeof result !== 'object') {
    return terminalError(TERMINAL_ERROR_CODES.INVALID_PAYLOAD, '终端请求处理失败');
  }
  if (result.ok === false) return result;
  const next = { ...result };
  if (next.session) next.session = safeTerminalSession(next.session);
  if (Array.isArray(next.sessions)) next.sessions = next.sessions.map(safeTerminalSession);
  if (Array.isArray(next.chunks)) next.chunks = next.chunks.map((chunk) => String(chunk ?? ''));
  if (next.data !== undefined) next.data = String(next.data ?? '');
  return next;
}

function safeTerminalEvent(event = {}) {
  const payload = {
    sessionId: String(event.sessionId || event.session?.id || ''),
    projectId: normalizePublicProjectId(event.projectId ?? event.session?.projectId),
    session: safeTerminalSession(event.session),
  };
  if (event.data !== undefined) payload.data = String(event.data ?? '');
  if (Object.prototype.hasOwnProperty.call(event, 'exitCode')) payload.exitCode = event.exitCode ?? null;
  if (Object.prototype.hasOwnProperty.call(event, 'signal')) payload.signal = event.signal ?? null;
  return payload;
}

function safeTerminalSession(session = {}) {
  const source = session && typeof session === 'object' ? session : {};
  return {
    id: String(source.id || ''),
    projectId: normalizePublicProjectId(source.projectId),
    title: String(source.title || ''),
    cwd: String(source.cwd || ''),
    shell: String(source.shell || ''),
    status: String(source.status || ''),
    createdAt: String(source.createdAt || ''),
    endedAt: source.endedAt ? String(source.endedAt) : null,
    exitCode: Number.isInteger(source.exitCode) ? source.exitCode : null,
    cols: Number.isInteger(source.cols) ? source.cols : null,
    rows: Number.isInteger(source.rows) ? source.rows : null,
    profile: safeTerminalProfile(source.profile),
  };
}

function safeTerminalProfile(profile = {}) {
  const source = profile && typeof profile === 'object' ? profile : {};
  return {
    id: String(source.id || ''),
    name: String(source.name || ''),
    kind: String(source.kind || ''),
    shellPath: String(source.shellPath || ''),
    args: Array.isArray(source.args) ? source.args.map((arg) => String(arg ?? '')) : [],
    env: normalizeEnvInput(source.env) || {},
  };
}

function normalizePublicProjectId(value) {
  const number = Number(value);
  return Number.isInteger(number) && String(value).trim() !== '' ? number : String(value || '');
}

function optionalString(value) {
  return value === undefined || value === null ? undefined : String(value);
}

function objectInput(input) {
  return input && typeof input === 'object' && !Array.isArray(input) ? input : {};
}

module.exports = { registerTerminalIpc };
