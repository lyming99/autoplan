'use strict';

const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { isInsidePath, realpathSafe } = require('../fileAccess/policy');
const {
  normalizeTerminalCreateInput,
  normalizeTerminalSize,
  normalizeTerminalTitle,
  selectTerminalProfile,
} = require('./terminalConfig');
const {
  TERMINAL_CHANNELS,
  TERMINAL_ERROR_CODES,
  TERMINAL_LIMITS,
  TERMINAL_SESSION_ID_PREFIX,
  TERMINAL_STATUS,
  terminalError,
  terminalPtyUnavailableError,
} = require('./terminalTypes');

class TerminalService extends EventEmitter {
  constructor(options = {}) {
    super();
    this.sessions = new Map();
    this.ptyFactory = normalizePtyFactory(options.ptyFactory);
    this.ptyLoader = options.ptyLoader || loadNodePty;
    this.ptyLoadResult = null;
    this.fs = options.fs || fs;
    this.env = options.env || process.env;
    this.platform = options.platform || process.platform;
    this.now = options.now || (() => new Date().toISOString());
    this.idFactory = options.idFactory || defaultSessionId;
  }

  createSession(project, input = {}) {
    const projectResult = normalizeProject(project, this.fs);
    if (!projectResult.ok) return projectResult.error;

    const cwdResult = resolveTerminalCwd(projectResult.project.workspacePath, input?.cwd, this.fs);
    if (!cwdResult.ok) return cwdResult.error;

    const ptyResult = this.resolvePtyFactory();
    if (!ptyResult.ok) return ptyResult.error;

    const config = normalizeTerminalCreateInput(input);
    const profile = selectTerminalProfile(input, {
      env: this.env,
      fs: this.fs,
      platform: this.platform,
    });

    let pty;
    try {
      pty = ptyResult.ptyFactory.spawn(profile.shellPath, profile.args, {
        name: 'xterm-256color',
        cols: config.cols,
        rows: config.rows,
        cwd: cwdResult.cwd,
        env: { ...this.env, ...profile.env, ...config.env },
      });
    } catch (error) {
      return terminalPtyUnavailableError(error?.message || error);
    }

    if (!pty || typeof pty !== 'object') {
      return terminalPtyUnavailableError('node-pty 未返回有效会话');
    }

    const session = {
      id: this.nextSessionId(),
      projectId: projectResult.project.id,
      title: config.title,
      cwd: cwdResult.cwd,
      shell: profile.shellPath,
      profile,
      status: TERMINAL_STATUS.RUNNING,
      createdAt: this.now(),
      endedAt: null,
      exitCode: null,
      cols: config.cols,
      rows: config.rows,
      retainOnExit: config.retainOnExit,
      scrollbackLimit: config.scrollbackLimit,
      scrollback: [],
      pty,
      disposables: [],
      killRequested: false,
      suppressExitEvents: false,
    };

    this.sessions.set(session.id, session);
    this.attachPtyHandlers(session);
    this.emitStatus(session);
    return { ok: true, session: publicSession(session) };
  }

  listSessions(projectId) {
    const id = normalizeProjectId(projectId);
    return [...this.sessions.values()]
      .filter((session) => !id || session.projectId === id)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map(publicSession);
  }

  write(sessionId, data) {
    const found = this.findSession(sessionId);
    if (!found.ok) return found.error;
    const text = String(data ?? '');
    if (!text) return { ok: true, session: publicSession(found.session) };
    if (Buffer.byteLength(text, 'utf8') > TERMINAL_LIMITS.maxInputBytes) {
      return terminalError(TERMINAL_ERROR_CODES.INVALID_PAYLOAD, '终端输入过长');
    }
    if (found.session.status !== TERMINAL_STATUS.RUNNING || typeof found.session.pty.write !== 'function') {
      return terminalError(TERMINAL_ERROR_CODES.WRITE_FAILED, '终端会话已退出，无法写入');
    }
    try {
      found.session.pty.write(text);
      return { ok: true, session: publicSession(found.session) };
    } catch (error) {
      return terminalError(TERMINAL_ERROR_CODES.WRITE_FAILED, '终端写入失败', error?.message || error);
    }
  }

  resize(sessionId, cols, rows) {
    const found = this.findSession(sessionId);
    if (!found.ok) return found.error;
    const size = normalizeTerminalSize(cols, rows);
    found.session.cols = size.cols;
    found.session.rows = size.rows;
    if (found.session.status !== TERMINAL_STATUS.RUNNING) return { ok: true, session: publicSession(found.session) };
    if (typeof found.session.pty.resize !== 'function') {
      return terminalError(TERMINAL_ERROR_CODES.RESIZE_FAILED, '终端不支持调整尺寸');
    }
    try {
      found.session.pty.resize(size.cols, size.rows);
      this.emitStatus(found.session);
      return { ok: true, session: publicSession(found.session) };
    } catch (error) {
      return terminalError(TERMINAL_ERROR_CODES.RESIZE_FAILED, '终端尺寸调整失败', error?.message || error);
    }
  }

  kill(sessionId) {
    const found = this.findSession(sessionId);
    if (!found.ok) return found.error;
    this.terminateSession(found.session, { remove: false, emit: true });
    return { ok: true, session: publicSession(found.session) };
  }

  close(sessionId) {
    const found = this.findSession(sessionId);
    if (!found.ok) return found.error;
    const session = publicSession(found.session);
    this.terminateSession(found.session, { remove: true, emit: true });
    return { ok: true, session, closed: true };
  }

  rename(sessionId, title) {
    const found = this.findSession(sessionId);
    if (!found.ok) return found.error;
    found.session.title = normalizeTerminalTitle(title);
    this.emitStatus(found.session);
    return { ok: true, session: publicSession(found.session) };
  }

  replay(sessionId) {
    const found = this.findSession(sessionId);
    if (!found.ok) return found.error;
    const chunks = found.session.scrollback.slice();
    return {
      ok: true,
      session: publicSession(found.session),
      chunks,
      data: chunks.join(''),
    };
  }

  disposeProject(projectId) {
    const id = normalizeProjectId(projectId);
    if (!id) return terminalError(TERMINAL_ERROR_CODES.INVALID_PROJECT, '项目 ID 不能为空');
    let count = 0;
    for (const session of [...this.sessions.values()]) {
      if (session.projectId !== id) continue;
      this.terminateSession(session, { remove: true, emit: false });
      count += 1;
    }
    return { ok: true, count };
  }

  disposeAll() {
    let count = 0;
    for (const session of [...this.sessions.values()]) {
      this.terminateSession(session, { remove: true, emit: false });
      count += 1;
    }
    return { ok: true, count };
  }

  resolvePtyFactory() {
    if (this.ptyFactory) return { ok: true, ptyFactory: this.ptyFactory };
    if (this.ptyLoadResult) return this.ptyLoadResult;
    try {
      const loaded = normalizePtyFactory(this.ptyLoader());
      this.ptyLoadResult = loaded
        ? { ok: true, ptyFactory: loaded }
        : { ok: false, error: terminalPtyUnavailableError('node-pty 未暴露 spawn 方法') };
    } catch (error) {
      this.ptyLoadResult = { ok: false, error: terminalPtyUnavailableError(error?.message || error) };
    }
    return this.ptyLoadResult;
  }

  attachPtyHandlers(session) {
    const onData = (data) => this.handleData(session, data);
    const onExit = (eventOrCode, signal) => this.handleExit(session, eventOrCode, signal);
    const dataDisposable = subscribePty(session.pty, 'data', onData);
    const exitDisposable = subscribePty(session.pty, 'exit', onExit);
    if (dataDisposable) session.disposables.push(dataDisposable);
    if (exitDisposable) session.disposables.push(exitDisposable);
  }

  handleData(session, data) {
    if (!this.sessions.has(session.id)) return;
    const text = String(data ?? '');
    if (!text) return;
    appendScrollback(session, text);
    const payload = { sessionId: session.id, projectId: session.projectId, data: text, session: publicSession(session) };
    this.emit(TERMINAL_CHANNELS.DATA, payload);
    this.emit('data', payload);
  }

  handleExit(session, eventOrCode, signal) {
    if (session.endedAt) return;
    const exit = normalizeExitEvent(eventOrCode, signal);
    session.status = session.killRequested ? TERMINAL_STATUS.KILLED : TERMINAL_STATUS.EXITED;
    session.exitCode = exit.exitCode;
    session.endedAt = this.now();
    disposeSubscriptions(session);
    const payload = { sessionId: session.id, projectId: session.projectId, ...exit, session: publicSession(session) };
    if (!session.suppressExitEvents) {
      this.emit(TERMINAL_CHANNELS.EXIT, payload);
      this.emit('exit', payload);
      this.emitStatus(session);
    }
  }

  emitStatus(session) {
    const payload = { sessionId: session.id, projectId: session.projectId, session: publicSession(session) };
    this.emit(TERMINAL_CHANNELS.STATUS, payload);
    this.emit('status', payload);
  }

  terminateSession(session, options = {}) {
    const emit = options.emit !== false;
    session.killRequested = true;
    if (!emit) session.suppressExitEvents = true;
    if (!session.endedAt && session.status === TERMINAL_STATUS.RUNNING) {
      try {
        if (session.pty && typeof session.pty.kill === 'function') session.pty.kill();
      } catch {
        /* 终止失败时仍清理服务侧引用，避免后续误用 */
      }
      if (!session.endedAt) this.handleExit(session, { exitCode: null, signal: 'SIGTERM' });
    }
    disposeSubscriptions(session);
    if (options.remove) this.sessions.delete(session.id);
  }

  findSession(sessionId) {
    const id = String(sessionId || '').trim();
    const session = id ? this.sessions.get(id) : null;
    if (!session) {
      return { ok: false, error: terminalError(TERMINAL_ERROR_CODES.SESSION_NOT_FOUND, '终端会话不存在') };
    }
    return { ok: true, session };
  }

  nextSessionId() {
    let id = this.idFactory();
    if (!id || this.sessions.has(id)) id = defaultSessionId();
    while (this.sessions.has(id)) id = defaultSessionId();
    return id;
  }
}

function normalizeProject(project, fileSystem = fs) {
  const id = normalizeProjectId(project);
  const workspacePath = project?.workspace_path || project?.workspacePath || project?.root || '';
  if (!id) {
    return { ok: false, error: terminalError(TERMINAL_ERROR_CODES.INVALID_PROJECT, '项目 ID 不能为空') };
  }
  if (!workspacePath) {
    return { ok: false, error: terminalError(TERMINAL_ERROR_CODES.INVALID_PROJECT, '项目工作区路径不能为空') };
  }
  const resolved = path.resolve(String(workspacePath));
  if (!isDirectory(resolved, fileSystem)) {
    return { ok: false, error: terminalError(TERMINAL_ERROR_CODES.INVALID_PROJECT, '项目工作区不存在或不是目录') };
  }
  return { ok: true, project: { id, workspacePath: realpathSafe(resolved) } };
}

function resolveTerminalCwd(workspacePath, cwdInput, fileSystem = fs) {
  const workspace = realpathSafe(path.resolve(workspacePath));
  const raw = String(cwdInput || '').trim();
  if (raw.length > TERMINAL_LIMITS.maxCwdLength) {
    return { ok: false, error: terminalError(TERMINAL_ERROR_CODES.INVALID_PAYLOAD, '终端工作目录过长') };
  }
  const requested = raw ? (path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(workspace, raw)) : workspace;
  const cwd = realpathSafe(requested);
  if (!isInsidePath(workspace, cwd)) {
    return { ok: false, error: terminalError(TERMINAL_ERROR_CODES.CWD_OUTSIDE_WORKSPACE, '终端工作目录必须位于当前项目工作区内') };
  }
  if (!isDirectory(cwd, fileSystem)) {
    return { ok: false, error: terminalError(TERMINAL_ERROR_CODES.INVALID_PAYLOAD, '终端工作目录不存在或不是目录') };
  }
  return { ok: true, cwd };
}

function publicSession(session) {
  return {
    id: session.id,
    projectId: session.projectId,
    title: session.title,
    cwd: session.cwd,
    shell: session.shell,
    status: session.status,
    createdAt: session.createdAt,
    endedAt: session.endedAt,
    exitCode: session.exitCode,
    cols: session.cols,
    rows: session.rows,
    profile: {
      id: session.profile.id,
      name: session.profile.name,
      kind: session.profile.kind,
      shellPath: session.profile.shellPath,
      args: session.profile.args.slice(),
      env: { ...session.profile.env },
    },
  };
}

function appendScrollback(session, text) {
  session.scrollback.push(text);
  while (session.scrollback.length > session.scrollbackLimit) session.scrollback.shift();
}

function subscribePty(pty, type, handler) {
  if (type === 'data' && typeof pty.onData === 'function') return pty.onData(handler);
  if (type === 'exit' && typeof pty.onExit === 'function') return pty.onExit(handler);
  if (typeof pty.on === 'function') {
    pty.on(type, handler);
    return typeof pty.off === 'function' ? { dispose: () => pty.off(type, handler) } : null;
  }
  return null;
}

function disposeSubscriptions(session) {
  for (const disposable of session.disposables.splice(0)) {
    try {
      if (disposable && typeof disposable.dispose === 'function') disposable.dispose();
    } catch {
      /* ignore */
    }
  }
}

function normalizeExitEvent(eventOrCode, signal) {
  if (eventOrCode && typeof eventOrCode === 'object') {
    return {
      exitCode: normalizeExitCode(eventOrCode.exitCode ?? eventOrCode.code),
      signal: eventOrCode.signal ?? null,
    };
  }
  return { exitCode: normalizeExitCode(eventOrCode), signal: signal ?? null };
}

function normalizeExitCode(value) {
  const number = Number(value);
  return Number.isInteger(number) ? number : null;
}

function normalizeProjectId(input) {
  const value = input && typeof input === 'object' ? (input.projectId ?? input.id) : input;
  return String(value || '').trim();
}

function normalizePtyFactory(value) {
  if (!value) return null;
  if (typeof value === 'function') return { spawn: value };
  return typeof value.spawn === 'function' ? value : null;
}

function loadNodePty() {
  return require('node-pty');
}

function isDirectory(dir, fileSystem = fs) {
  try {
    return fileSystem.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function defaultSessionId() {
  const id = typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID().replace(/-/g, '')
    : crypto.randomBytes(16).toString('hex');
  return `${TERMINAL_SESSION_ID_PREFIX}_${id}`;
}

module.exports = {
  TerminalService,
  normalizeProject,
  resolveTerminalCwd,
};
