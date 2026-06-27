const {
  DEFAULT_AGENT_CLI_PROVIDER,
  normalizeAgentCliCommand,
  normalizeAgentCliProvider,
} = require('../agentCli');

const AGENT_CLI_PROVIDER_COLUMNS = Object.freeze(['agent_cli_provider', 'cli_provider', 'cli_backend']);
const AGENT_CLI_COMMAND_COLUMNS = Object.freeze(['agent_cli_command', 'cli_command', 'cli_path']);
const CODEX_REASONING_EFFORT_COLUMNS = Object.freeze([
  'codex_reasoning_effort',
  'codexReasoningEffort',
  'codex_thinking_depth',
  'codexThinkingDepth',
  'reasoning_effort',
  'reasoningEffort',
  'thinking_depth',
  'thinkingDepth',
]);
const CODEX_REASONING_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh']);
const DEFAULT_CODEX_REASONING_EFFORT = 'medium';
const AGENT_CLI_PROVIDER_INPUT_KEYS = Object.freeze([
  'agentCliProvider',
  'agent_cli_provider',
  'cliProvider',
  'cli_provider',
  'cliBackend',
  'cli_backend',
]);
const AGENT_CLI_COMMAND_INPUT_KEYS = Object.freeze([
  'agentCliCommand',
  'agent_cli_command',
  'cliCommand',
  'cli_command',
  'cliPath',
  'cli_path',
]);
const AGENT_CLI_PROVIDER_CONTEXT_KEYS = Object.freeze([...AGENT_CLI_PROVIDER_INPUT_KEYS, 'provider']);
const AGENT_CLI_COMMAND_CONTEXT_KEYS = Object.freeze([...AGENT_CLI_COMMAND_INPUT_KEYS, 'command']);
const LOOP_CONFIG_INPUT_KEYS = Object.freeze([
  'workspacePath',
  'intervalSeconds',
  'validationCommand',
  'validation_command',
  ...AGENT_CLI_PROVIDER_INPUT_KEYS,
  ...AGENT_CLI_COMMAND_INPUT_KEYS,
  ...CODEX_REASONING_EFFORT_COLUMNS,
]);
const VALIDATION_COMMAND_INPUT_KEYS = Object.freeze(['validationCommand', 'validation_command']);
const CODEX_SESSION_UUID_RE_SOURCE = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const CODEX_SESSION_ID_RES = Object.freeze([
  new RegExp(`\\bsession\\s+id:\\s*(${CODEX_SESSION_UUID_RE_SOURCE})\\b`, 'i'),
  new RegExp(`"(?:session_id|sessionId)"\\s*:\\s*"(${CODEX_SESSION_UUID_RE_SOURCE})"`, 'i'),
  new RegExp(`\\b(?:session_id|sessionId)\\s*[:=]\\s*(${CODEX_SESSION_UUID_RE_SOURCE})\\b`, 'i'),
]);
const CODEX_RESUME_FAILURE_RE = /(?:thread\/resume|resume failed|no rollout found|session\s+(?:not\s+found|missing)|conversation\s+not\s+found|unknown\s+session|invalid\s+session)/i;

function compactDefinedFields(fields) {
  const result = {};
  for (const [key, value] of Object.entries(fields || {})) {
    if (value !== undefined && value !== null && value !== '') result[key] = value;
  }
  return result;
}

function hasAnyOwnProperty(source, keys) {
  return keys.some((key) => Object.prototype.hasOwnProperty.call(source || {}, key));
}

function readFirstOwnValue(source, keys) {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(source || {}, key)) return source[key];
  }
  return undefined;
}

function normalizeAgentCliConfig(source = {}) {
  const provider = normalizeAgentCliProvider(readFirstOwnValue(source, AGENT_CLI_PROVIDER_COLUMNS));
  return {
    provider,
    command: normalizeAgentCliCommand(readFirstOwnValue(source, AGENT_CLI_COMMAND_COLUMNS)),
    codexReasoningEffort: provider === DEFAULT_AGENT_CLI_PROVIDER
      ? normalizeCodexReasoningEffort(readFirstOwnValue(source, CODEX_REASONING_EFFORT_COLUMNS))
      : null,
  };
}

function normalizeCodexReasoningEffort(value) {
  const effort = String(value || '').trim().toLowerCase();
  return CODEX_REASONING_EFFORTS.has(effort) ? effort : DEFAULT_CODEX_REASONING_EFFORT;
}

function normalizeOptionalCodexReasoningEffort(value) {
  if (value === undefined || value === null || value === '') return null;
  return normalizeCodexReasoningEffort(value);
}

function normalizeOptionalAgentCliProvider(value) {
  const provider = String(value ?? '').trim();
  return provider ? normalizeAgentCliProvider(provider) : null;
}

function normalizeIntakeAgentCliConfig(source = {}) {
  const provider = normalizeOptionalAgentCliProvider(
    readFirstOwnValue(source, [...AGENT_CLI_PROVIDER_INPUT_KEYS, ...AGENT_CLI_PROVIDER_COLUMNS]),
  );
  const codexReasoningEffort = provider === 'claude'
    ? null
    : normalizeOptionalCodexReasoningEffort(readFirstOwnValue(source, CODEX_REASONING_EFFORT_COLUMNS));
  return {
    provider,
    command: normalizeAgentCliCommand(readFirstOwnValue(source, [...AGENT_CLI_COMMAND_INPUT_KEYS, ...AGENT_CLI_COMMAND_COLUMNS])),
    codexReasoningEffort,
  };
}

function effectiveAgentCliConfig(defaults = {}, override = {}) {
  const defaultConfig = normalizeAgentCliConfig(defaults || {});
  const overrideConfig = normalizeIntakeAgentCliConfig(override || {});
  const provider = overrideConfig.provider || defaultConfig.provider;
  const command = overrideConfig.command || defaultConfig.command;
  const codexReasoningEffort = provider === DEFAULT_AGENT_CLI_PROVIDER
    ? overrideConfig.codexReasoningEffort || defaultConfig.codexReasoningEffort || DEFAULT_CODEX_REASONING_EFFORT
    : null;
  return { provider, command, codexReasoningEffort };
}

function hasExplicitAgentCliProvider(source = {}) {
  return Boolean(normalizeOptionalAgentCliProvider(readFirstOwnValue(source, AGENT_CLI_PROVIDER_CONTEXT_KEYS)));
}

function hasAgentCliOverride(source = {}) {
  return Boolean(
    hasExplicitAgentCliProvider(source) ||
      normalizeAgentCliCommand(readFirstOwnValue(source, AGENT_CLI_COMMAND_CONTEXT_KEYS)) ||
      normalizeOptionalCodexReasoningEffort(readFirstOwnValue(source, CODEX_REASONING_EFFORT_COLUMNS)),
  );
}

function agentCliOperationFields(config = {}) {
  return compactDefinedFields({
    agentCliProvider: config.provider,
    agentCliCommand: config.command,
    codexReasoningEffort: config.provider === DEFAULT_AGENT_CLI_PROVIDER ? config.codexReasoningEffort : undefined,
  });
}

function nextIntakeAgentCliConfig(current = {}, input = {}) {
  const inputHasProvider = hasAnyOwnProperty(input, AGENT_CLI_PROVIDER_INPUT_KEYS);
  const provider = inputHasProvider
    ? normalizeAgentCliProvider(readFirstOwnValue(input, AGENT_CLI_PROVIDER_INPUT_KEYS))
    : normalizeOptionalAgentCliProvider(readFirstOwnValue(current, AGENT_CLI_PROVIDER_COLUMNS));
  const command = hasAnyOwnProperty(input, AGENT_CLI_COMMAND_INPUT_KEYS)
    ? normalizeAgentCliCommand(readFirstOwnValue(input, AGENT_CLI_COMMAND_INPUT_KEYS))
    : normalizeAgentCliCommand(readFirstOwnValue(current, AGENT_CLI_COMMAND_COLUMNS));
  const codexReasoningEffort = provider === DEFAULT_AGENT_CLI_PROVIDER || (!provider && hasAnyOwnProperty(input, CODEX_REASONING_EFFORT_COLUMNS))
    ? normalizeCodexReasoningEffort(
        hasAnyOwnProperty(input, CODEX_REASONING_EFFORT_COLUMNS)
          ? readFirstOwnValue(input, CODEX_REASONING_EFFORT_COLUMNS)
          : readFirstOwnValue(current, CODEX_REASONING_EFFORT_COLUMNS),
      )
    : null;
  return { provider, command, codexReasoningEffort };
}

function intakeSnapshotRow(row = {}) {
  const config = normalizeIntakeAgentCliConfig(row);
  return {
    ...row,
    agent_cli_provider: config.provider,
    agent_cli_command: config.command,
    codex_reasoning_effort: config.codexReasoningEffort,
  };
}

function nextAgentCliConfig(current = {}, input = {}) {
  const currentConfig = normalizeAgentCliConfig(current);
  const provider = hasAnyOwnProperty(input, AGENT_CLI_PROVIDER_INPUT_KEYS)
    ? normalizeAgentCliProvider(readFirstOwnValue(input, AGENT_CLI_PROVIDER_INPUT_KEYS))
    : currentConfig.provider;
  const command = hasAnyOwnProperty(input, AGENT_CLI_COMMAND_INPUT_KEYS)
    ? normalizeAgentCliCommand(readFirstOwnValue(input, AGENT_CLI_COMMAND_INPUT_KEYS))
    : currentConfig.command;
  const codexReasoningEffort = provider === DEFAULT_AGENT_CLI_PROVIDER
    ? normalizeCodexReasoningEffort(
        hasAnyOwnProperty(input, CODEX_REASONING_EFFORT_COLUMNS)
          ? readFirstOwnValue(input, CODEX_REASONING_EFFORT_COLUMNS)
          : currentConfig.codexReasoningEffort,
      )
    : null;
  return { provider, command, codexReasoningEffort };
}

function agentCliStateUpdates(columns, config) {
  const updates = [];
  for (const column of AGENT_CLI_PROVIDER_COLUMNS) {
    if (columns.has(column)) updates.push([column, config.provider]);
  }
  for (const column of AGENT_CLI_COMMAND_COLUMNS) {
    if (columns.has(column)) updates.push([column, config.command]);
  }
  for (const column of CODEX_REASONING_EFFORT_COLUMNS) {
    if (columns.has(column)) updates.push([column, config.codexReasoningEffort]);
  }
  return updates;
}

function planAgentCliColumnValues(columns, config) {
  const values = [];
  const fields = agentCliOperationFields(config);
  for (const column of AGENT_CLI_PROVIDER_COLUMNS) {
    if (columns.has(column)) values.push([column, fields.agentCliProvider]);
  }
  for (const column of AGENT_CLI_COMMAND_COLUMNS) {
    if (columns.has(column)) values.push([column, fields.agentCliCommand || '']);
  }
  for (const column of CODEX_REASONING_EFFORT_COLUMNS) {
    if (columns.has(column)) values.push([column, fields.codexReasoningEffort || null]);
  }
  return values;
}

function normalizeOptionalNumber(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function normalizeOptionalString(value) {
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  return text || undefined;
}

function agentCliContextFields(source = {}, options = {}) {
  const hasProvider = hasAnyOwnProperty(source, AGENT_CLI_PROVIDER_CONTEXT_KEYS);
  const rawProvider = readFirstOwnValue(source, AGENT_CLI_PROVIDER_CONTEXT_KEYS);
  const provider = hasProvider || options.defaultProvider ? normalizeAgentCliProvider(rawProvider) : undefined;
  const command = normalizeAgentCliCommand(readFirstOwnValue(source, AGENT_CLI_COMMAND_CONTEXT_KEYS));
  return compactDefinedFields({
    agentCliProvider: provider,
    agentCliCommand: command,
    codexReasoningEffort: provider === DEFAULT_AGENT_CLI_PROVIDER
      ? normalizeOptionalCodexReasoningEffort(readFirstOwnValue(source, CODEX_REASONING_EFFORT_COLUMNS))
      : undefined,
  });
}

function agentCliProviderDisplayName(provider) {
  return normalizeAgentCliProvider(provider) === 'claude' ? 'Claude' : 'Codex';
}

function hasCodexSessionOption(operation = {}) {
  return Object.prototype.hasOwnProperty.call(operation, 'codexSessionId') ||
    Object.prototype.hasOwnProperty.call(operation, 'sessionId') ||
    Object.prototype.hasOwnProperty.call(operation, 'codex_session_id');
}

function operationCodexSessionId(operation = {}) {
  return normalizeCodexSessionId(operation.codexSessionId ?? operation.sessionId ?? operation.codex_session_id);
}

function normalizeCodexSessionId(value) {
  const text = normalizeOptionalString(value);
  return text && new RegExp(`^${CODEX_SESSION_UUID_RE_SOURCE}$`, 'i').test(text) ? text.toLowerCase() : '';
}

function extractCodexSessionId(text) {
  const source = String(text || '');
  for (const pattern of CODEX_SESSION_ID_RES) {
    const match = source.match(pattern);
    const sessionId = normalizeCodexSessionId(match?.[1]);
    if (sessionId) return sessionId;
  }
  return '';
}

function isCodexResumeFailure(output) {
  return CODEX_RESUME_FAILURE_RE.test(String(output || ''));
}

function shortCodexSessionId(sessionId) {
  const normalized = normalizeCodexSessionId(sessionId);
  return normalized ? normalized.slice(0, 8) : '';
}

function codexSessionContextFields(source = {}) {
  const sessionId = operationCodexSessionId(source);
  const requestedSessionId = normalizeCodexSessionId(source.codexSessionRequestedId ?? source.requestedSessionId);
  const mode = normalizeCodexSessionMode(source.codexSessionMode);
  const fallback = Boolean(source.codexSessionFallback);
  const state = normalizeOptionalString(source.codexSessionState) || (fallback ? 'fallback-new' : mode);
  const label = codexSessionReadableLabel({
    codexSessionId: sessionId,
    codexSessionRequestedId: requestedSessionId,
    codexSessionMode: mode,
    codexSessionState: state,
    codexSessionFallback: fallback,
  });
  return compactDefinedFields({
    codexSessionId: sessionId || undefined,
    codexSessionShortId: sessionId ? shortCodexSessionId(sessionId) : undefined,
    codexSessionMode: mode || undefined,
    codexSessionState: state || undefined,
    codexSessionLabel: label || undefined,
    codexSessionRequestedId: requestedSessionId || undefined,
    codexSessionRequestedShortId: requestedSessionId ? shortCodexSessionId(requestedSessionId) : undefined,
    codexSessionFallback: fallback || undefined,
  });
}

function clearCodexSessionFields(operation) {
  for (const key of [
    'codexSessionId',
    'sessionId',
    'codex_session_id',
    'codexSessionRequestedId',
    'requestedSessionId',
    'codexSessionMode',
    'codexSessionState',
    'codexSessionFallback',
  ]) {
    delete operation[key];
  }
}

function normalizeCodexSessionMode(mode) {
  const normalized = normalizeOptionalString(mode);
  if (normalized === 'new' || normalized === 'resume') return normalized;
  return undefined;
}

function codexSessionReadableLabel(source = {}) {
  const explicit = normalizeOptionalString(source.codexSessionLabel);
  if (explicit) return explicit;
  const sessionId = operationCodexSessionId(source);
  const requestedSessionId = normalizeCodexSessionId(source.codexSessionRequestedId ?? source.requestedSessionId);
  const sessionShortId = sessionId ? shortCodexSessionId(sessionId) : '';
  const requestedShortId = requestedSessionId ? shortCodexSessionId(requestedSessionId) : '';
  const mode = normalizeCodexSessionMode(source.codexSessionMode);
  const state = normalizeOptionalString(source.codexSessionState);
  if (state === 'fallback-new' || source.codexSessionFallback) {
    if (sessionShortId && requestedShortId) return `回退新建会话 ${sessionShortId}（原 ${requestedShortId}）`;
    if (sessionShortId) return `回退新建会话 ${sessionShortId}`;
    return requestedShortId ? `回退新建会话（原 ${requestedShortId}）` : '回退新建会话';
  }
  if (mode === 'resume') return sessionShortId ? `恢复会话 ${sessionShortId}` : '恢复会话';
  if (mode === 'new') return sessionShortId ? `新建会话 ${sessionShortId}` : '新建会话';
  return sessionShortId ? `会话 ${sessionShortId}` : '';
}

module.exports = {
  AGENT_CLI_COMMAND_COLUMNS,
  AGENT_CLI_COMMAND_INPUT_KEYS,
  AGENT_CLI_PROVIDER_COLUMNS,
  AGENT_CLI_PROVIDER_INPUT_KEYS,
  CODEX_REASONING_EFFORT_COLUMNS,
  DEFAULT_AGENT_CLI_PROVIDER,
  DEFAULT_CODEX_REASONING_EFFORT,
  LOOP_CONFIG_INPUT_KEYS,
  VALIDATION_COMMAND_INPUT_KEYS,
  agentCliContextFields,
  agentCliOperationFields,
  agentCliProviderDisplayName,
  agentCliStateUpdates,
  clearCodexSessionFields,
  codexSessionContextFields,
  codexSessionReadableLabel,
  effectiveAgentCliConfig,
  extractCodexSessionId,
  hasAgentCliOverride,
  hasAnyOwnProperty,
  hasCodexSessionOption,
  hasExplicitAgentCliProvider,
  intakeSnapshotRow,
  isCodexResumeFailure,
  nextAgentCliConfig,
  nextIntakeAgentCliConfig,
  normalizeAgentCliConfig,
  normalizeCodexReasoningEffort,
  normalizeCodexSessionId,
  normalizeIntakeAgentCliConfig,
  normalizeOptionalAgentCliProvider,
  normalizeOptionalCodexReasoningEffort,
  normalizeOptionalNumber,
  normalizeOptionalString,
  operationCodexSessionId,
  planAgentCliColumnValues,
  readFirstOwnValue,
  shortCodexSessionId,
};
