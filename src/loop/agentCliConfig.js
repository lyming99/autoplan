const {
  DEFAULT_AGENT_CLI_PROVIDER,
  defaultAgentCliCommand,
  normalizeAgentCliCommand,
  normalizeAgentCliProvider,
} = require('../agentCli');
const { PLAN_BACKEND_CONFIG_INPUT_KEYS } = require('./planBackendConfig');

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
const AGENT_CLI_SESSION_COLUMNS = Object.freeze(['agent_cli_session_id', 'codex_session_id', 'opencode_session_id']);
const AGENT_CLI_SESSION_CONTEXT_KEYS = Object.freeze([
  'agentCliSessionId',
  'agent_cli_session_id',
  'sessionId',
  'session_id',
  'codexSessionId',
  'codex_session_id',
  'opencodeSessionId',
  'opencode_session_id',
]);
const AGENT_CLI_SESSION_REQUESTED_ID_CONTEXT_KEYS = Object.freeze([
  'agentCliSessionRequestedId',
  'agent_cli_session_requested_id',
  'requestedSessionId',
  'requested_session_id',
  'codexSessionRequestedId',
  'codex_session_requested_id',
  'opencodeSessionRequestedId',
  'opencode_session_requested_id',
]);
const AGENT_CLI_SESSION_MODE_CONTEXT_KEYS = Object.freeze([
  'agentCliSessionMode',
  'agent_cli_session_mode',
  'codexSessionMode',
  'codex_session_mode',
  'opencodeSessionMode',
  'opencode_session_mode',
]);
const AGENT_CLI_SESSION_STATE_CONTEXT_KEYS = Object.freeze([
  'agentCliSessionState',
  'agent_cli_session_state',
  'codexSessionState',
  'codex_session_state',
  'opencodeSessionState',
  'opencode_session_state',
]);
const AGENT_CLI_SESSION_LABEL_CONTEXT_KEYS = Object.freeze([
  'agentCliSessionLabel',
  'agent_cli_session_label',
  'codexSessionLabel',
  'codex_session_label',
  'opencodeSessionLabel',
  'opencode_session_label',
]);
const AGENT_CLI_SESSION_FALLBACK_CONTEXT_KEYS = Object.freeze([
  'agentCliSessionFallback',
  'agent_cli_session_fallback',
  'codexSessionFallback',
  'codex_session_fallback',
  'opencodeSessionFallback',
  'opencode_session_fallback',
]);
const AGENT_CLI_SESSION_PROVIDERS = new Set([DEFAULT_AGENT_CLI_PROVIDER, 'claude', 'opencode']);
const AGENT_CLI_SESSION_MODES = new Set(['new', 'resume', 'continue']);
const LOOP_CONFIG_INPUT_KEYS = Object.freeze([
  'workspacePath',
  'intervalSeconds',
  'validationCommand',
  'validation_command',
  ...AGENT_CLI_PROVIDER_INPUT_KEYS,
  ...AGENT_CLI_COMMAND_INPUT_KEYS,
  ...CODEX_REASONING_EFFORT_COLUMNS,
  ...PLAN_BACKEND_CONFIG_INPUT_KEYS,
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
  const codexReasoningEffort = provider && provider !== DEFAULT_AGENT_CLI_PROVIDER
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
  const command = overrideConfig.command || defaultConfig.command || defaultAgentCliCommand(provider);
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

function normalizeAgentCliSessionId(value) {
  const text = normalizeOptionalString(value);
  if (!text || text.length > 256) return '';
  return /^[A-Za-z0-9._:-]+$/.test(text) ? text : '';
}

function shortAgentCliSessionId(sessionId) {
  const normalized = normalizeAgentCliSessionId(sessionId);
  return normalized ? normalized.slice(0, 8) : '';
}

function normalizeAgentCliSessionMode(mode) {
  const normalized = normalizeOptionalString(mode);
  return AGENT_CLI_SESSION_MODES.has(normalized) ? normalized : undefined;
}

function agentCliProviderSupportsSession(provider) {
  const normalized = normalizeOptionalString(provider);
  return Boolean(normalized && AGENT_CLI_SESSION_PROVIDERS.has(normalized.toLowerCase()));
}

function normalizeSessionProvider(source = {}, options = {}) {
  const explicitProvider = readFirstOwnValue(source, AGENT_CLI_PROVIDER_CONTEXT_KEYS) ?? options.provider;
  const provider = normalizeOptionalString(explicitProvider);
  if (provider) return provider.toLowerCase();
  if (hasAnyOwnProperty(source, ['codexSessionId', 'codex_session_id'])) return DEFAULT_AGENT_CLI_PROVIDER;
  if (hasAnyOwnProperty(source, ['opencodeSessionId', 'opencode_session_id'])) return 'opencode';
  return undefined;
}

function normalizeAgentCliSessionIdForProvider(provider, value) {
  const normalizedProvider = normalizeOptionalString(provider)?.toLowerCase();
  return normalizedProvider === DEFAULT_AGENT_CLI_PROVIDER
    ? normalizeCodexSessionId(value)
    : normalizeAgentCliSessionId(value);
}

function shortAgentCliSessionIdForProvider(provider, sessionId) {
  const normalizedProvider = normalizeOptionalString(provider)?.toLowerCase();
  return normalizedProvider === DEFAULT_AGENT_CLI_PROVIDER
    ? shortCodexSessionId(sessionId)
    : shortAgentCliSessionId(sessionId);
}

function isAgentCliSessionKeyForProvider(key, provider) {
  const normalizedProvider = normalizeOptionalString(provider)?.toLowerCase();
  if (!normalizedProvider) return true;
  if (key.startsWith('codex') || key.startsWith('codex_')) return normalizedProvider === DEFAULT_AGENT_CLI_PROVIDER;
  if (key.startsWith('opencode') || key.startsWith('opencode_')) return normalizedProvider === 'opencode';
  return true;
}

function readFirstAgentCliSessionValue(source, keys, provider) {
  for (const key of keys) {
    if (!isAgentCliSessionKeyForProvider(key, provider)) continue;
    if (Object.prototype.hasOwnProperty.call(source || {}, key)) return source[key];
  }
  return undefined;
}

function readAgentCliSessionId(source, keys, provider) {
  for (const key of keys) {
    if (!isAgentCliSessionKeyForProvider(key, provider)) continue;
    if (!Object.prototype.hasOwnProperty.call(source || {}, key)) continue;
    const sessionId = normalizeAgentCliSessionIdForProvider(provider, source[key]);
    if (sessionId) return sessionId;
  }
  return '';
}

function normalizeOptionalBoolean(value) {
  if (value === undefined || value === null || value === '') return false;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  return Boolean(value);
}

function agentCliSessionParts(source = {}, options = {}) {
  const provider = normalizeSessionProvider(source, options);
  const sessionId = readAgentCliSessionId(source, AGENT_CLI_SESSION_CONTEXT_KEYS, provider);
  const requestedSessionId = readAgentCliSessionId(source, AGENT_CLI_SESSION_REQUESTED_ID_CONTEXT_KEYS, provider);
  const mode = normalizeAgentCliSessionMode(readFirstAgentCliSessionValue(source, AGENT_CLI_SESSION_MODE_CONTEXT_KEYS, provider));
  const fallback = normalizeOptionalBoolean(readFirstAgentCliSessionValue(source, AGENT_CLI_SESSION_FALLBACK_CONTEXT_KEYS, provider));
  const state = normalizeOptionalString(readFirstAgentCliSessionValue(source, AGENT_CLI_SESSION_STATE_CONTEXT_KEYS, provider)) ||
    (fallback ? 'fallback-new' : mode);
  const label = normalizeOptionalString(readFirstAgentCliSessionValue(source, AGENT_CLI_SESSION_LABEL_CONTEXT_KEYS, provider));
  return { provider, sessionId, requestedSessionId, mode, state, fallback, label };
}

function agentCliSessionReadableLabel(source = {}, options = {}) {
  const { provider, sessionId, requestedSessionId, mode, state, fallback, label } = agentCliSessionParts(source, options);
  if (label) return label;
  const providerPrefix = provider ? `${agentCliProviderDisplayName(provider)} ` : '';
  const sessionShortId = sessionId ? shortAgentCliSessionIdForProvider(provider, sessionId) : '';
  const requestedShortId = requestedSessionId ? shortAgentCliSessionIdForProvider(provider, requestedSessionId) : '';
  const effectiveMode = mode || normalizeAgentCliSessionMode(state);
  if (state === 'fallback-new' || fallback) {
    if (sessionShortId && requestedShortId) return `${providerPrefix}回退新建会话 ${sessionShortId}（原 ${requestedShortId}）`;
    if (sessionShortId) return `${providerPrefix}回退新建会话 ${sessionShortId}`;
    return requestedShortId ? `${providerPrefix}回退新建会话（原 ${requestedShortId}）` : `${providerPrefix}回退新建会话`;
  }
  if (effectiveMode === 'resume') return sessionShortId ? `${providerPrefix}恢复会话 ${sessionShortId}` : `${providerPrefix}恢复会话`;
  if (effectiveMode === 'continue') return sessionShortId ? `${providerPrefix}继续会话 ${sessionShortId}` : `${providerPrefix}继续会话`;
  if (effectiveMode === 'new') return sessionShortId ? `${providerPrefix}新建会话 ${sessionShortId}` : `${providerPrefix}新建会话`;
  return sessionShortId ? `${providerPrefix}会话 ${sessionShortId}` : '';
}

function agentCliSessionContextFields(source = {}, options = {}) {
  const { provider, sessionId, requestedSessionId, mode, state, fallback } = agentCliSessionParts(source, options);
  if (provider && !agentCliProviderSupportsSession(provider)) return compactDefinedFields({ agentCliProvider: provider });
  const sessionShortId = sessionId ? shortAgentCliSessionIdForProvider(provider, sessionId) : '';
  const requestedShortId = requestedSessionId ? shortAgentCliSessionIdForProvider(provider, requestedSessionId) : '';
  const label = agentCliSessionReadableLabel(source, options);
  return compactDefinedFields({
    agentCliProvider: provider,
    agentCliSessionId: sessionId || undefined,
    agentCliSessionShortId: sessionShortId || undefined,
    agentCliSessionRequestedId: requestedSessionId || undefined,
    agentCliSessionRequestedShortId: requestedShortId || undefined,
    agentCliSessionMode: mode || undefined,
    agentCliSessionState: state || undefined,
    agentCliSessionFallback: fallback || undefined,
    agentCliSessionLabel: label || undefined,
  });
}

function operationAgentCliSessionId(operation = {}) {
  const provider = normalizeSessionProvider(operation);
  return readAgentCliSessionId(operation, AGENT_CLI_SESSION_CONTEXT_KEYS, provider);
}

function hasAgentCliSessionOption(operation = {}) {
  return [
    ...AGENT_CLI_SESSION_CONTEXT_KEYS,
    ...AGENT_CLI_SESSION_REQUESTED_ID_CONTEXT_KEYS,
    ...AGENT_CLI_SESSION_MODE_CONTEXT_KEYS,
    ...AGENT_CLI_SESSION_STATE_CONTEXT_KEYS,
    ...AGENT_CLI_SESSION_FALLBACK_CONTEXT_KEYS,
  ].some((key) => Object.prototype.hasOwnProperty.call(operation, key));
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
    ...agentCliSessionContextFields(source, { provider }),
  });
}

function agentCliProviderDisplayName(provider) {
  const rawProvider = normalizeOptionalString(provider);
  const normalized = rawProvider ? rawProvider.toLowerCase() : normalizeAgentCliProvider(provider);
  if (normalized === 'claude') return 'Claude';
  if (normalized === 'opencode') return 'OpenCode';
  if (normalized === 'oh-my-pi') return 'Oh My Pi';
  if (normalized === DEFAULT_AGENT_CLI_PROVIDER) return 'Codex';
  return rawProvider || 'Agent';
}

function hasCodexSessionOption(operation = {}) {
  operation = operation || {};
  return Object.prototype.hasOwnProperty.call(operation, 'codexSessionId') ||
    Object.prototype.hasOwnProperty.call(operation, 'agentCliSessionId') ||
    Object.prototype.hasOwnProperty.call(operation, 'sessionId') ||
    Object.prototype.hasOwnProperty.call(operation, 'session_id') ||
    Object.prototype.hasOwnProperty.call(operation, 'agent_cli_session_id') ||
    Object.prototype.hasOwnProperty.call(operation, 'codex_session_id');
}

function operationCodexSessionId(operation = {}) {
  operation = operation || {};
  return normalizeCodexSessionId(
    operation.codexSessionId ??
      operation.agentCliSessionId ??
      operation.sessionId ??
      operation.session_id ??
      operation.codex_session_id ??
      operation.agent_cli_session_id,
  );
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
  const requestedSessionId = normalizeCodexSessionId(
    source.codexSessionRequestedId ?? source.agentCliSessionRequestedId ?? source.requestedSessionId,
  );
  const mode = normalizeCodexSessionMode(source.codexSessionMode ?? source.agentCliSessionMode);
  const fallback = normalizeOptionalBoolean(source.codexSessionFallback ?? source.agentCliSessionFallback);
  const state = normalizeOptionalString(source.codexSessionState ?? source.agentCliSessionState) ||
    (fallback ? 'fallback-new' : mode);
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
    'codexSessionShortId',
    'codex_session_id',
    'codexSessionRequestedId',
    'codexSessionRequestedShortId',
    'codex_session_requested_id',
    'codexSessionMode',
    'codex_session_mode',
    'codexSessionState',
    'codex_session_state',
    'codexSessionFallback',
    'codex_session_fallback',
    'codexSessionLabel',
    'codex_session_label',
  ]) {
    delete operation[key];
  }
}

function clearAgentCliSessionFields(operation) {
  for (const key of [
    'agentCliSessionId',
    'agentCliSessionShortId',
    'agent_cli_session_id',
    'sessionId',
    'session_id',
    'agentCliSessionRequestedId',
    'agentCliSessionRequestedShortId',
    'agent_cli_session_requested_id',
    'requestedSessionId',
    'requested_session_id',
    'agentCliSessionMode',
    'agent_cli_session_mode',
    'agentCliSessionState',
    'agent_cli_session_state',
    'agentCliSessionFallback',
    'agent_cli_session_fallback',
    'agentCliSessionLabel',
    'agent_cli_session_label',
    'opencodeSessionId',
    'opencodeSessionShortId',
    'opencode_session_id',
    'opencodeSessionRequestedId',
    'opencodeSessionRequestedShortId',
    'opencode_session_requested_id',
    'opencodeSessionMode',
    'opencode_session_mode',
    'opencodeSessionState',
    'opencode_session_state',
    'opencodeSessionFallback',
    'opencode_session_fallback',
    'opencodeSessionLabel',
    'opencode_session_label',
  ]) {
    delete operation[key];
  }
  clearCodexSessionFields(operation);
}

function clearUnsupportedAgentCliSessionFields(operation, provider) {
  const normalizedProvider = provider || readFirstOwnValue(operation, AGENT_CLI_PROVIDER_CONTEXT_KEYS);
  if (normalizedProvider && !agentCliProviderSupportsSession(normalizedProvider)) clearAgentCliSessionFields(operation);
  return operation;
}

function opencodeSessionContextFields(source = {}) {
  const fields = agentCliSessionContextFields(source, { provider: 'opencode' });
  return compactDefinedFields({
    ...fields,
    opencodeSessionId: fields.agentCliSessionId,
    opencodeSessionShortId: fields.agentCliSessionShortId,
    opencodeSessionRequestedId: fields.agentCliSessionRequestedId,
    opencodeSessionRequestedShortId: fields.agentCliSessionRequestedShortId,
    opencodeSessionMode: fields.agentCliSessionMode,
    opencodeSessionState: fields.agentCliSessionState,
    opencodeSessionFallback: fields.agentCliSessionFallback,
    opencodeSessionLabel: fields.agentCliSessionLabel,
  });
}

function normalizeCodexSessionMode(mode) {
  const normalized = normalizeAgentCliSessionMode(mode);
  if (normalized === 'new' || normalized === 'resume') return normalized;
  return undefined;
}

function codexSessionReadableLabel(source = {}) {
  const explicit = normalizeOptionalString(source.codexSessionLabel ?? source.agentCliSessionLabel);
  if (explicit) return explicit;
  const sessionId = operationCodexSessionId(source);
  const requestedSessionId = normalizeCodexSessionId(
    source.codexSessionRequestedId ?? source.agentCliSessionRequestedId ?? source.requestedSessionId,
  );
  const sessionShortId = sessionId ? shortCodexSessionId(sessionId) : '';
  const requestedShortId = requestedSessionId ? shortCodexSessionId(requestedSessionId) : '';
  const mode = normalizeCodexSessionMode(source.codexSessionMode ?? source.agentCliSessionMode);
  const state = normalizeOptionalString(source.codexSessionState ?? source.agentCliSessionState);
  if (state === 'fallback-new' || normalizeOptionalBoolean(source.codexSessionFallback ?? source.agentCliSessionFallback)) {
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
  AGENT_CLI_SESSION_COLUMNS,
  AGENT_CLI_SESSION_CONTEXT_KEYS,
  AGENT_CLI_SESSION_FALLBACK_CONTEXT_KEYS,
  AGENT_CLI_SESSION_LABEL_CONTEXT_KEYS,
  AGENT_CLI_SESSION_MODE_CONTEXT_KEYS,
  AGENT_CLI_SESSION_REQUESTED_ID_CONTEXT_KEYS,
  AGENT_CLI_SESSION_STATE_CONTEXT_KEYS,
  CODEX_REASONING_EFFORT_COLUMNS,
  DEFAULT_AGENT_CLI_PROVIDER,
  DEFAULT_CODEX_REASONING_EFFORT,
  LOOP_CONFIG_INPUT_KEYS,
  PLAN_BACKEND_CONFIG_INPUT_KEYS,
  VALIDATION_COMMAND_INPUT_KEYS,
  agentCliContextFields,
  agentCliOperationFields,
  agentCliProviderSupportsSession,
  agentCliProviderDisplayName,
  agentCliSessionContextFields,
  agentCliSessionReadableLabel,
  agentCliStateUpdates,
  clearAgentCliSessionFields,
  clearCodexSessionFields,
  clearUnsupportedAgentCliSessionFields,
  codexSessionContextFields,
  codexSessionReadableLabel,
  effectiveAgentCliConfig,
  extractCodexSessionId,
  hasAgentCliOverride,
  hasAgentCliSessionOption,
  hasAnyOwnProperty,
  hasCodexSessionOption,
  hasExplicitAgentCliProvider,
  intakeSnapshotRow,
  isCodexResumeFailure,
  nextAgentCliConfig,
  nextIntakeAgentCliConfig,
  normalizeAgentCliConfig,
  normalizeAgentCliSessionId,
  normalizeAgentCliSessionIdForProvider,
  normalizeAgentCliSessionMode,
  normalizeCodexReasoningEffort,
  normalizeCodexSessionId,
  normalizeIntakeAgentCliConfig,
  normalizeOptionalAgentCliProvider,
  normalizeOptionalBoolean,
  normalizeOptionalCodexReasoningEffort,
  normalizeOptionalNumber,
  normalizeOptionalString,
  operationAgentCliSessionId,
  operationCodexSessionId,
  opencodeSessionContextFields,
  planAgentCliColumnValues,
  readFirstOwnValue,
  shortCodexSessionId,
  shortAgentCliSessionId,
  shortAgentCliSessionIdForProvider,
};
