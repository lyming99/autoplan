'use strict';

const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn: defaultSpawn } = require('node:child_process');
const {
  DaemonReadinessError,
  ReadinessCollector,
  verifyReadiness,
} = require('./readiness');
const { stopProcessTree } = require('./processTree');
const {
  DaemonSessionError,
  createDaemonSession,
  writeSessionHandoff,
} = require('./session');

const DAEMON_ORIGIN = 'http://127.0.0.1:1';
const RENDERER_ORIGIN_ENVIRONMENT = 'AUTOPLAN_SIDECAR_RENDERER_ORIGIN';
const DATA_DIRECTORY_ENVIRONMENT = 'AUTOPLAN_SIDECAR_DATA_DIR';
const MCP_PORT_ENVIRONMENT = 'AUTOPLAN_MCP_PORT';
const RUNTIME_FEATURE_ENVIRONMENT = Object.freeze([
  'AUTOPLAN_SIDECAR_GO_LOOP_ACTIONS',
  'AUTOPLAN_SIDECAR_GO_PLAN_ACTIONS',
  'AUTOPLAN_SIDECAR_GO_TASK_ACTIONS',
  'AUTOPLAN_SIDECAR_GO_ACCEPTANCE_RETRY_ACTIONS',
  'AUTOPLAN_SIDECAR_GO_SCRIPTS_API',
  'AUTOPLAN_SIDECAR_GO_EXECUTORS_API',
  'AUTOPLAN_SIDECAR_GO_CHAT_API',
  'AUTOPLAN_SIDECAR_GO_MCP_API',
  'AUTOPLAN_SIDECAR_GO_TERMINAL_API',
  'AUTOPLAN_SIDECAR_GO_AGENT_CLI_RUNTIME',
]);

class DaemonSupervisorError extends Error {
  constructor(code) {
    super(code);
    this.name = 'DaemonSupervisorError';
    this.code = code;
  }
}

class GoDaemonSupervisor extends EventEmitter {
  constructor(options = {}) {
    super();
    this.spawn = options.spawn || defaultSpawn;
    this.fetch = options.fetch || globalThis.fetch;
    this.randomBytes = options.randomBytes;
    this.executablePath = validateExecutablePath(options.executablePath);
    this.dataDir = validateDataDirectory(options.dataDir);
    this.runtimeFeatureEnvironment = normalizeRuntimeFeatureEnvironment(options.runtimeFeatureEnvironment);
    this.mcpPort = normalizeMCPPort(options.mcpPort);
    this.rendererOrigin = normalizeRendererOrigin(options.rendererOrigin ?? process.env[RENDERER_ORIGIN_ENVIRONMENT]);
    this.readyTimeoutMs = boundedTimeout(options.readyTimeoutMs, 15000);
    this.shutdownTimeoutMs = boundedTimeout(options.shutdownTimeoutMs, 5000);
    this.logger = normalizeLogger(options.logger);
    this.child = null;
    this.starting = null;
    this.stopping = null;
    this.session = null;
    this.readiness = null;
    this.state = 'stopped';
  }

  status() {
    return Object.freeze({
      state: this.state,
      ready: this.state === 'ready',
      host: this.readiness?.host || null,
      port: this.readiness?.port || null,
      baseUrl: this.readiness ? `http://${this.readiness.host}:${this.readiness.port}` : null,
      origin: this.readiness ? DAEMON_ORIGIN : null,
    });
  }

  clientOptions() {
    if (this.state !== 'ready' || !this.readiness || !this.session) {
      throw new DaemonSupervisorError('daemon_not_ready');
    }
    return {
      baseUrl: `http://${this.readiness.host}:${this.readiness.port}`,
      origin: DAEMON_ORIGIN,
      sessionHeaderName: 'X-Autoplan-Session',
      sessionToken: this.session.credential(),
    };
  }

  async start() {
    if (this.state === 'ready') return this.status();
    if (this.state === 'maintenance') throw new DaemonSupervisorError('daemon_maintenance_mode');
    if (this.starting) return this.starting;
    if (this.stopping) await this.stopping;
    this.starting = this.startInternal();
    try {
      return await this.starting;
    } finally {
      this.starting = null;
    }
  }

  async startInternal() {
    this.state = 'starting';
    this.record('info', 'daemon_starting', { state: this.state });
    this.session = createDaemonSession(this.randomBytes);
    const collector = new ReadinessCollector();
    let child;
    try {
      child = this.spawn(this.executablePath, ['--data-dir', this.dataDir], {
        cwd: this.dataDir,
        detached: process.platform !== 'win32',
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: controlledEnvironment(process.env, this.runtimeFeatureEnvironment, this.rendererOrigin, process.platform, os.tmpdir(), this.dataDir, this.mcpPort),
      });
      if (!child || !Number.isSafeInteger(child.pid) || child.pid <= 0 || !child.stdin || !child.stdout || !child.stderr) {
        throw new DaemonSupervisorError('daemon_spawn_failed');
      }
      this.child = child;
      this.attachDiagnostics(child);
      this.record('info', 'daemon_spawned', { state: this.state, child_pid: child.pid });
      this.attachUnexpectedExit(child);
      const ready = await awaitReadiness(child, collector, this.session, this.readyTimeoutMs);
      await probeReady(this.fetch, ready, this.session, this.readyTimeoutMs);
      if (child.exitCode !== null || child.signalCode) throw new DaemonSupervisorError('daemon_exited_early');
      this.readiness = ready;
      this.state = 'ready';
      this.record('info', 'daemon_ready', { state: this.state, child_pid: child.pid });
      child.stdout.on('data', () => {
        // A daemon may never emit a second readiness line or ordinary stdout
        // diagnostics after becoming available. Any such output revokes the
        // trusted state and stops the whole child tree.
        this.record('error', 'daemon_stdout_protocol_violation', { state: this.state, child_pid: child.pid });
        this.failClosed().then(() => this.emit('failed', this.status())).catch(() => undefined);
      });
      this.emit('ready', this.status());
      return this.status();
    } catch (error) {
      this.record('error', 'daemon_start_failed', { state: this.state, error_code: supervisorErrorCode(error) });
      await this.failClosed();
      throw normalizeSupervisorError(error);
    }
  }

  attachUnexpectedExit(child) {
    child.once('exit', (exitCode) => {
      if (this.child !== child || this.state === 'stopping' || this.state === 'stopped') return;
      this.readiness = null;
      revokeSession(this);
      this.state = 'failed';
      this.record('error', 'daemon_unexpected_exit', {
        state: this.state, child_pid: child.pid,
        ...(Number.isSafeInteger(exitCode) ? { exit_code: exitCode } : {}),
      });
      this.emit('failed', this.status());
    });
  }

  attachDiagnostics(child) {
    child.stderr.on('data', (chunk) => {
      try { this.logger?.writeExternalChunk?.('go-sidecar', chunk); } catch { /* logging is best effort */ }
    });
    child.stderr.once('end', () => {
      try { this.logger?.flushExternal?.('go-sidecar'); } catch { /* logging is best effort */ }
    });
  }

  record(level, code, fields = {}) {
    try { this.logger?.log?.(level, code, { source: 'electron-supervisor', ...fields }); } catch { /* logging is best effort */ }
  }

  async stop() {
    if (this.stopping) return this.stopping;
    this.stopping = this.stopInternal();
    try {
      await this.stopping;
    } finally {
      this.stopping = null;
    }
  }

  // prepareCutover is a one-way handoff primitive.  It closes the complete Go
  // process tree and revokes its in-memory session before another owner can
  // operate on the database.  start() refuses to revive this supervisor; a
  // fresh, explicitly supervised process is required after cutover.
  async prepareCutover() {
    if (this.state === 'maintenance') return this.status();
    if (this.starting || this.stopping || this.state !== 'ready') {
      throw new DaemonSupervisorError('daemon_not_ready');
    }
    const child = this.child;
    this.state = 'maintenance';
    this.child = null;
    this.readiness = null;
    revokeSession(this);
    try {
      await stopProcessTree(child, {
        gracefulTimeoutMs: this.shutdownTimeoutMs,
        forceTimeoutMs: this.shutdownTimeoutMs,
      });
    } catch {
      // A failed process-tree shutdown is itself maintenance state.  No
      // readiness/session material survives for an accidental retry, and the
      // caller must not mistake the legacy owner for a released one.
      this.emit('maintenance', this.status());
      throw new DaemonSupervisorError('daemon_cutover_stop_failed');
    }
    this.emit('maintenance', this.status());
    return this.status();
  }

  async stopInternal() {
    this.state = 'stopping';
    const child = this.child;
    this.record('info', 'daemon_stopping', {
      state: this.state,
      ...(Number.isSafeInteger(child?.pid) ? { child_pid: child.pid } : {}),
    });
    this.child = null;
    this.readiness = null;
    revokeSession(this);
    await stopProcessTree(child, {
      gracefulTimeoutMs: this.shutdownTimeoutMs,
      forceTimeoutMs: this.shutdownTimeoutMs,
    });
    try { this.logger?.flushExternal?.('go-sidecar'); } catch { /* logging is best effort */ }
    this.state = 'stopped';
    this.record('info', 'daemon_stopped', { state: this.state });
    this.emit('stopped', this.status());
  }

  async failClosed() {
    await this.stopInternal();
    this.state = 'failed';
  }
}

function awaitReadiness(child, collector, session, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout.removeListener('data', onData);
      child.stdout.removeListener('end', onEnd);
      child.removeListener('exit', onExit);
      child.removeListener('error', onError);
      child.stdin?.removeListener?.('error', onSessionPipeError);
      if (error) reject(error); else resolve(value);
    };
    const onData = (chunk) => {
      try {
        const parsed = collector.push(chunk);
        if (parsed) finish(null, verifyReadiness(parsed, { pid: child.pid, session: session.credential() }));
      } catch (error) {
        finish(error);
      }
    };
    const onEnd = () => {
      try { finish(null, verifyReadiness(collector.end(), { pid: child.pid, session: session.credential() })); } catch (error) { finish(error); }
    };
    const onExit = () => finish(new DaemonSupervisorError('daemon_exited_early'));
    const onError = () => finish(new DaemonSupervisorError('daemon_spawn_failed'));
    const onSessionPipeError = () => finish(new DaemonSupervisorError('daemon_session_pipe_failed'));
    const timer = setTimeout(() => finish(new DaemonSupervisorError('daemon_readiness_timeout')), timeoutMs);
    timer.unref?.();
    child.stdout.on('data', onData);
    child.stdout.once('end', onEnd);
    child.once('exit', onExit);
    child.once('error', onError);
    child.stdin.once('error', onSessionPipeError);
    writeSessionHandoff(child.stdin, session)
      .catch(() => finish(new DaemonSupervisorError('daemon_session_pipe_failed')));
  });
}

async function probeReady(fetchFn, readiness, session, timeoutMs) {
  if (typeof fetchFn !== 'function') throw new DaemonSupervisorError('daemon_readiness_probe_failed');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetchFn(`http://${readiness.host}:${readiness.port}/readyz`, {
      method: 'GET',
      headers: {
        accept: 'application/json', origin: DAEMON_ORIGIN,
        'X-Autoplan-Session': session.credential(),
      },
      signal: controller.signal,
    });
    if (!response?.ok || response.status !== 200) throw new DaemonSupervisorError('daemon_readiness_probe_failed');
    const body = await response.json().catch(() => null);
    if (body?.status !== 'ready') throw new DaemonSupervisorError('daemon_readiness_probe_failed');
  } catch (error) {
    if (error instanceof DaemonSupervisorError) throw error;
    throw new DaemonSupervisorError('daemon_readiness_probe_failed');
  } finally {
    clearTimeout(timer);
  }
}

function controlledEnvironment(
  env = {},
  runtimeFeatureEnvironment = {},
  rendererOrigin = '',
  platform = process.platform,
  temporaryRoot = os.tmpdir(),
  dataDirectory = '',
  mcpPort = 0,
) {
  const result = Object.create(null);
  const inheritedPaths = platform === 'win32'
    ? ['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'Path', 'PATH', 'PATHEXT', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'CODEX_HOME']
    : ['PATH', 'HOME', 'XDG_CONFIG_HOME', 'CODEX_HOME'];
  for (const key of inheritedPaths) {
    if (typeof env[key] === 'string' && env[key]) result[key] = env[key];
  }
  const absoluteTemporaryRoot = temporaryRootForPlatform(temporaryRoot, platform);
  if (absoluteTemporaryRoot) {
    if (platform === 'win32') {
      result.TEMP = absoluteTemporaryRoot;
      result.TMP = absoluteTemporaryRoot;
    } else {
      result.TMPDIR = absoluteTemporaryRoot;
    }
  }
  for (const name of RUNTIME_FEATURE_ENVIRONMENT) {
    const value = runtimeFeatureEnvironment[name];
    if (value === 'true' || value === 'false') result[name] = value;
  }
  if (rendererOrigin) result[RENDERER_ORIGIN_ENVIRONMENT] = rendererOrigin;
  if (dataDirectory && path.isAbsolute(dataDirectory)) result[DATA_DIRECTORY_ENVIRONMENT] = path.resolve(dataDirectory);
  if (Number.isSafeInteger(mcpPort) && mcpPort > 0 && mcpPort <= 65535) {
    result[MCP_PORT_ENVIRONMENT] = String(mcpPort);
  }
  return result;
}

function normalizeMCPPort(value) {
  if (value === undefined || value === null || value === '') return 0;
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65535) {
    throw new DaemonSupervisorError('daemon_mcp_port_invalid');
  }
  return port;
}

function temporaryRootForPlatform(value, platform) {
  const candidate = String(value || '').trim();
  const paths = platform === 'win32' ? path.win32 : path.posix;
  return candidate && paths.isAbsolute(candidate) ? paths.resolve(candidate) : '';
}

function normalizeRendererOrigin(value) {
  try {
    const origin = new URL(String(value || '')).origin;
    const parsed = new URL(origin);
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
        parsed.hostname !== '127.0.0.1' || !parsed.port || parsed.username || parsed.password) return '';
    return origin;
  } catch {
    return '';
  }
}

function normalizeRuntimeFeatureEnvironment(value) {
  const source = value && typeof value === 'object' ? value : {};
  const result = Object.create(null);
  for (const name of RUNTIME_FEATURE_ENVIRONMENT) {
    const enabled = source[name];
    result[name] = enabled === true || enabled === 'true' ? 'true' : 'false';
  }
  return Object.freeze(result);
}

function revokeSession(supervisor) {
  const session = supervisor.session;
  supervisor.session = null;
  try { session?.revoke?.(); } catch { /* process-tree shutdown remains mandatory */ }
}

function validateExecutablePath(value) {
  const candidate = String(value || '').trim();
  if (!candidate || !path.isAbsolute(candidate)) throw new DaemonSupervisorError('daemon_executable_invalid');
  const info = fs.lstatSync(candidate, { throwIfNoEntry: false });
  if (!info || !info.isFile() || info.isSymbolicLink()) throw new DaemonSupervisorError('daemon_executable_invalid');
  return path.resolve(candidate);
}

function validateDataDirectory(value) {
  const candidate = String(value || '').trim();
  if (!candidate || !path.isAbsolute(candidate)) throw new DaemonSupervisorError('daemon_data_dir_invalid');
  const info = fs.lstatSync(candidate, { throwIfNoEntry: false });
  if (!info || !info.isDirectory() || info.isSymbolicLink()) throw new DaemonSupervisorError('daemon_data_dir_invalid');
  return path.resolve(candidate);
}

function boundedTimeout(value, fallback) {
  const timeout = value === undefined ? fallback : Number(value);
  return Number.isInteger(timeout) && timeout >= 250 && timeout <= 120000 ? timeout : fallback;
}

function normalizeSupervisorError(error) {
  if (error instanceof DaemonSupervisorError || error instanceof DaemonReadinessError || error instanceof DaemonSessionError) return error;
  return new DaemonSupervisorError('daemon_start_failed');
}

function supervisorErrorCode(error) {
  const code = String(error?.code || error?.message || 'daemon_start_failed');
  return /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(code) ? code : 'daemon_start_failed';
}

function normalizeLogger(value) {
  return value && typeof value === 'object' ? value : null;
}

module.exports = {
  DAEMON_ORIGIN,
  MCP_PORT_ENVIRONMENT,
  RUNTIME_FEATURE_ENVIRONMENT,
  DaemonSupervisorError,
  GoDaemonSupervisor,
  controlledEnvironment,
  normalizeRuntimeFeatureEnvironment,
  probeReady,
  temporaryRootForPlatform,
};
