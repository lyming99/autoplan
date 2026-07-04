const TERMINAL_CHANNELS = Object.freeze({
  CREATE: 'terminal:create',
  LIST: 'terminal:list',
  WRITE: 'terminal:write',
  RESIZE: 'terminal:resize',
  KILL: 'terminal:kill',
  CLOSE: 'terminal:close',
  RENAME: 'terminal:rename',
  REPLAY: 'terminal:replay',
  CLEAR: 'terminal:clear',
  DATA: 'terminal:data',
  EXIT: 'terminal:exit',
  STATUS: 'terminal:status',
});

const TERMINAL_SESSION_ID_PREFIX = 'term';
const TERMINAL_SESSION_ID_PATTERN_SOURCE = '^term_[a-z0-9][a-z0-9_-]{5,}$';

const TERMINAL_STATUS = Object.freeze({
  STARTING: 'starting',
  RUNNING: 'running',
  EXITED: 'exited',
  KILLED: 'killed',
  ERROR: 'error',
});

const TERMINAL_PROFILE_KIND = Object.freeze({
  DEFAULT: 'default',
  CUSTOM: 'custom',
});

const TERMINAL_SESSION_FIELDS = Object.freeze([
  'id',
  'projectId',
  'title',
  'cwd',
  'shell',
  'status',
  'createdAt',
  'endedAt',
  'exitCode',
]);

const TERMINAL_PROFILE_FIELDS = Object.freeze(['id', 'name', 'kind', 'shellPath', 'args', 'env']);

const TERMINAL_DEFAULTS = Object.freeze({
  cols: 80,
  rows: 24,
  scrollbackLimit: 10000,
  title: 'Terminal',
  retainOnExit: true,
});

const TERMINAL_LIMITS = Object.freeze({
  minCols: 2,
  maxCols: 500,
  minRows: 1,
  maxRows: 200,
  maxInputBytes: 65536,
  maxTitleLength: 80,
  maxCwdLength: 2048,
  maxProfileNameLength: 80,
  maxShellPathLength: 2048,
  maxProfileArgs: 32,
  maxProfileArgLength: 512,
  minScrollbackLimit: 100,
  maxScrollbackLimit: 50000,
});

const TERMINAL_PAYLOAD_KEYS = Object.freeze({
  create: Object.freeze(['projectId', 'cwd', 'profileId', 'profile', 'title', 'cols', 'rows', 'env']),
  list: Object.freeze(['projectId']),
  write: Object.freeze(['sessionId', 'data']),
  resize: Object.freeze(['sessionId', 'cols', 'rows']),
  kill: Object.freeze(['sessionId']),
  close: Object.freeze(['sessionId']),
  rename: Object.freeze(['sessionId', 'title']),
  replay: Object.freeze(['sessionId']),
  clear: Object.freeze(['sessionId']),
});

const TERMINAL_EVENT_TYPES = Object.freeze({
  DATA: 'data',
  EXIT: 'exit',
  STATUS: 'status',
});

const TERMINAL_ERROR_CODES = Object.freeze({
  PTY_UNAVAILABLE: 'PTY_UNAVAILABLE',
  INVALID_PROJECT: 'INVALID_PROJECT',
  INVALID_SESSION: 'INVALID_SESSION',
  INVALID_PAYLOAD: 'INVALID_PAYLOAD',
  CWD_OUTSIDE_WORKSPACE: 'CWD_OUTSIDE_WORKSPACE',
  SESSION_NOT_FOUND: 'SESSION_NOT_FOUND',
  WRITE_FAILED: 'WRITE_FAILED',
  RESIZE_FAILED: 'RESIZE_FAILED',
  KILL_FAILED: 'KILL_FAILED',
});

const TERMINAL_PTY_UNAVAILABLE_MESSAGE = '终端能力不可用';

function terminalError(code, message, details) {
  const error = {
    ok: false,
    code: String(code || TERMINAL_ERROR_CODES.INVALID_PAYLOAD),
    message: String(message || '终端请求无效'),
  };
  if (details !== undefined && details !== null && details !== '') {
    error.details = String(details);
  }
  return error;
}

function terminalPtyUnavailableError(details) {
  return terminalError(
    TERMINAL_ERROR_CODES.PTY_UNAVAILABLE,
    TERMINAL_PTY_UNAVAILABLE_MESSAGE,
    details,
  );
}

module.exports = {
  TERMINAL_CHANNELS,
  TERMINAL_SESSION_ID_PREFIX,
  TERMINAL_SESSION_ID_PATTERN_SOURCE,
  TERMINAL_STATUS,
  TERMINAL_PROFILE_KIND,
  TERMINAL_SESSION_FIELDS,
  TERMINAL_PROFILE_FIELDS,
  TERMINAL_DEFAULTS,
  TERMINAL_LIMITS,
  TERMINAL_PAYLOAD_KEYS,
  TERMINAL_EVENT_TYPES,
  TERMINAL_ERROR_CODES,
  TERMINAL_PTY_UNAVAILABLE_MESSAGE,
  terminalError,
  terminalPtyUnavailableError,
};
