const {
  DEFAULT_AGENT_CLI_PROVIDER,
  normalizeAgentCliCommand,
  normalizeAgentCliProvider,
} = require('../agentCli');

const DEFAULT_PLAN_GENERATION_STRATEGY = 'external-cli-markdown';
const DEFAULT_PLAN_EXECUTION_STRATEGY = 'external-cli';
const PLAN_GENERATION_STRATEGIES = new Set([
  DEFAULT_PLAN_GENERATION_STRATEGY,
  'external-cli-structured',
  'builtin-llm-structured',
]);
const PLAN_EXECUTION_STRATEGIES = new Set([
  DEFAULT_PLAN_EXECUTION_STRATEGY,
  'builtin-llm',
]);
const BUILTIN_LLM_PROVIDERS = new Set(['openai', 'deepseek', 'anthropic']);
const CODEX_REASONING_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh']);
const DEFAULT_CODEX_REASONING_EFFORT = 'medium';

const PLAN_GENERATION_STRATEGY_KEYS = Object.freeze(['planGenerationStrategy', 'plan_generation_strategy']);
const PLAN_GENERATION_PROVIDER_KEYS = Object.freeze(['planGenerationProvider', 'plan_generation_provider']);
const PLAN_GENERATION_COMMAND_KEYS = Object.freeze(['planGenerationCommand', 'plan_generation_command']);
const PLAN_GENERATION_MODEL_KEYS = Object.freeze(['planGenerationModel', 'plan_generation_model']);
const PLAN_GENERATION_CODEX_REASONING_EFFORT_KEYS = Object.freeze([
  'planGenerationCodexReasoningEffort',
  'plan_generation_codex_reasoning_effort',
]);
const PLAN_EXECUTION_STRATEGY_KEYS = Object.freeze(['planExecutionStrategy', 'plan_execution_strategy']);
const PLAN_EXECUTION_PROVIDER_KEYS = Object.freeze(['planExecutionProvider', 'plan_execution_provider']);
const PLAN_EXECUTION_COMMAND_KEYS = Object.freeze(['planExecutionCommand', 'plan_execution_command']);
const PLAN_EXECUTION_MODEL_KEYS = Object.freeze(['planExecutionModel', 'plan_execution_model']);
const PLAN_EXECUTION_CODEX_REASONING_EFFORT_KEYS = Object.freeze([
  'planExecutionCodexReasoningEffort',
  'plan_execution_codex_reasoning_effort',
]);
const LEGACY_AGENT_CLI_PROVIDER_KEYS = Object.freeze([
  'agentCliProvider',
  'agent_cli_provider',
  'cliProvider',
  'cli_provider',
  'cliBackend',
  'cli_backend',
]);
const LEGACY_AGENT_CLI_COMMAND_KEYS = Object.freeze([
  'agentCliCommand',
  'agent_cli_command',
  'cliCommand',
  'cli_command',
  'cliPath',
  'cli_path',
]);
const LEGACY_CODEX_REASONING_EFFORT_KEYS = Object.freeze([
  'codexReasoningEffort',
  'codex_reasoning_effort',
  'codexThinkingDepth',
  'codex_thinking_depth',
  'reasoningEffort',
  'reasoning_effort',
  'thinkingDepth',
  'thinking_depth',
]);
const PLAN_BACKEND_CONFIG_INPUT_KEYS = Object.freeze([
  ...PLAN_GENERATION_STRATEGY_KEYS,
  ...PLAN_GENERATION_PROVIDER_KEYS,
  ...PLAN_GENERATION_COMMAND_KEYS,
  ...PLAN_GENERATION_MODEL_KEYS,
  ...PLAN_GENERATION_CODEX_REASONING_EFFORT_KEYS,
  ...PLAN_EXECUTION_STRATEGY_KEYS,
  ...PLAN_EXECUTION_PROVIDER_KEYS,
  ...PLAN_EXECUTION_COMMAND_KEYS,
  ...PLAN_EXECUTION_MODEL_KEYS,
  ...PLAN_EXECUTION_CODEX_REASONING_EFFORT_KEYS,
]);

function effectivePlanGenerationConfig(defaults = {}, intake = {}) {
  const strategy = normalizePlanGenerationStrategy(
    firstConfigValue([intake, defaults], PLAN_GENERATION_STRATEGY_KEYS),
  );
  const provider = normalizePlanBackendProvider(firstConfigValue(
    [intake, defaults],
    PLAN_GENERATION_PROVIDER_KEYS,
    LEGACY_AGENT_CLI_PROVIDER_KEYS,
  ), strategy);
  const command = normalizeAgentCliCommand(firstConfigValue(
    [intake, defaults],
    PLAN_GENERATION_COMMAND_KEYS,
    LEGACY_AGENT_CLI_COMMAND_KEYS,
  ));
  const model = normalizeOptionalString(firstConfigValue([intake, defaults], PLAN_GENERATION_MODEL_KEYS)) || '';
  const codexReasoningEffort = provider === DEFAULT_AGENT_CLI_PROVIDER
    ? normalizeCodexReasoningEffort(firstConfigValue(
      [intake, defaults],
      PLAN_GENERATION_CODEX_REASONING_EFFORT_KEYS,
      LEGACY_CODEX_REASONING_EFFORT_KEYS,
    ))
    : null;
  return planGenerationConfigFields({ strategy, provider, command, model, codexReasoningEffort });
}

function effectivePlanExecutionConfig(defaults = {}, plan = {}) {
  const strategy = normalizePlanExecutionStrategy(
    firstConfigValue([plan, defaults], PLAN_EXECUTION_STRATEGY_KEYS),
  );
  const provider = normalizePlanBackendProvider(firstConfigValue(
    [plan, defaults],
    PLAN_EXECUTION_PROVIDER_KEYS,
    LEGACY_AGENT_CLI_PROVIDER_KEYS,
  ), strategy);
  const command = normalizeAgentCliCommand(firstConfigValue(
    [plan, defaults],
    PLAN_EXECUTION_COMMAND_KEYS,
    LEGACY_AGENT_CLI_COMMAND_KEYS,
  ));
  const model = normalizeOptionalString(firstConfigValue([plan, defaults], PLAN_EXECUTION_MODEL_KEYS)) || '';
  const codexReasoningEffort = provider === DEFAULT_AGENT_CLI_PROVIDER
    ? normalizeCodexReasoningEffort(firstConfigValue(
      [plan, defaults],
      PLAN_EXECUTION_CODEX_REASONING_EFFORT_KEYS,
      LEGACY_CODEX_REASONING_EFFORT_KEYS,
    ))
    : null;
  return planExecutionConfigFields({ strategy, provider, command, model, codexReasoningEffort });
}

function planGenerationAgentCliOperationFields(config = {}) {
  const normalized = planGenerationConfigFields({
    strategy: normalizePlanGenerationStrategy(config.strategy ?? config.planGenerationStrategy),
    provider: normalizePlanBackendProvider(config.provider ?? config.planGenerationProvider),
    command: normalizeAgentCliCommand(config.command ?? config.planGenerationCommand),
    model: normalizeOptionalString(config.model ?? config.planGenerationModel) || '',
    codexReasoningEffort: normalizeOptionalCodexReasoningEffort(
      config.codexReasoningEffort ?? config.planGenerationCodexReasoningEffort,
    ),
  });
  if (!isExternalCliPlanGenerationStrategy(normalized.strategy)) {
    throw new Error(`plan generation strategy ${normalized.strategy} does not use an external CLI`);
  }
  return agentCliOperationFieldsForPlanBackend(normalized);
}

function planExecutionAgentCliOperationFields(config = {}) {
  const normalized = planExecutionConfigFields({
    strategy: normalizePlanExecutionStrategy(config.strategy ?? config.planExecutionStrategy),
    provider: normalizePlanBackendProvider(config.provider ?? config.planExecutionProvider),
    command: normalizeAgentCliCommand(config.command ?? config.planExecutionCommand),
    model: normalizeOptionalString(config.model ?? config.planExecutionModel) || '',
    codexReasoningEffort: normalizeOptionalCodexReasoningEffort(
      config.codexReasoningEffort ?? config.planExecutionCodexReasoningEffort,
    ),
  });
  if (!isExternalCliPlanExecutionStrategy(normalized.strategy)) {
    throw new Error(`plan execution strategy ${normalized.strategy} does not use an external CLI`);
  }
  return agentCliOperationFieldsForPlanBackend(normalized);
}

function agentCliOperationFieldsForPlanBackend(config = {}) {
  const provider = normalizeAgentCliProvider(config.provider);
  const command = normalizeAgentCliCommand(config.command);
  const codexReasoningEffort = provider === DEFAULT_AGENT_CLI_PROVIDER
    ? normalizeCodexReasoningEffort(config.codexReasoningEffort)
    : null;
  return compactDefinedFields({
    agentCliProvider: provider,
    agentCliCommand: command,
    codexReasoningEffort: provider === DEFAULT_AGENT_CLI_PROVIDER ? codexReasoningEffort : undefined,
  });
}

function planGenerationConfigFields(config = {}) {
  const strategy = normalizePlanGenerationStrategy(config.strategy);
  const provider = normalizePlanBackendProvider(config.provider, strategy);
  const codexReasoningEffort = provider === DEFAULT_AGENT_CLI_PROVIDER
    ? normalizeCodexReasoningEffort(config.codexReasoningEffort)
    : null;
  const command = normalizeAgentCliCommand(config.command);
  const model = normalizeOptionalString(config.model) || '';
  return {
    strategy,
    provider,
    command,
    model,
    codexReasoningEffort,
    planGenerationStrategy: strategy,
    planGenerationProvider: provider,
    planGenerationCommand: command,
    planGenerationModel: model,
    planGenerationCodexReasoningEffort: codexReasoningEffort,
  };
}

function planExecutionConfigFields(config = {}) {
  const strategy = normalizePlanExecutionStrategy(config.strategy);
  const provider = normalizePlanBackendProvider(config.provider, strategy);
  const codexReasoningEffort = provider === DEFAULT_AGENT_CLI_PROVIDER
    ? normalizeCodexReasoningEffort(config.codexReasoningEffort)
    : null;
  const command = normalizeAgentCliCommand(config.command);
  const model = normalizeOptionalString(config.model) || '';
  return {
    strategy,
    provider,
    command,
    model,
    codexReasoningEffort,
    planExecutionStrategy: strategy,
    planExecutionProvider: provider,
    planExecutionCommand: command,
    planExecutionModel: model,
    planExecutionCodexReasoningEffort: codexReasoningEffort,
  };
}

function normalizePlanGenerationStrategy(value) {
  const strategy = normalizeOptionalLowerString(value);
  return PLAN_GENERATION_STRATEGIES.has(strategy) ? strategy : DEFAULT_PLAN_GENERATION_STRATEGY;
}

function normalizePlanExecutionStrategy(value) {
  const strategy = normalizeOptionalLowerString(value);
  return PLAN_EXECUTION_STRATEGIES.has(strategy) ? strategy : DEFAULT_PLAN_EXECUTION_STRATEGY;
}

function normalizePlanBackendProvider(value, strategy = null) {
  const normalized = normalizeOptionalLowerString(value);
  if (!normalized) return DEFAULT_AGENT_CLI_PROVIDER;
  if (isBuiltinPlanBackendStrategy(strategy)) {
    return BUILTIN_LLM_PROVIDERS.has(normalized) ? normalized : DEFAULT_AGENT_CLI_PROVIDER;
  }
  return normalizeAgentCliProvider(normalized);
}

function normalizeCodexReasoningEffort(value) {
  const effort = normalizeOptionalLowerString(value);
  return CODEX_REASONING_EFFORTS.has(effort) ? effort : DEFAULT_CODEX_REASONING_EFFORT;
}

function normalizeOptionalCodexReasoningEffort(value) {
  if (value === undefined || value === null || value === '') return null;
  return normalizeCodexReasoningEffort(value);
}

function normalizeOptionalString(value) {
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  return text || undefined;
}

function normalizeOptionalLowerString(value) {
  const text = normalizeOptionalString(value);
  return text ? text.toLowerCase() : undefined;
}

function firstConfigValue(sources, primaryKeys, fallbackKeys = []) {
  for (const source of sources) {
    const value = readFirstOwnValue(source, primaryKeys);
    if (value !== undefined && value !== null && value !== '') return value;
    const fallbackValue = readFirstOwnValue(source, fallbackKeys);
    if (fallbackValue !== undefined && fallbackValue !== null && fallbackValue !== '') return fallbackValue;
  }
  return undefined;
}

function readFirstOwnValue(source, keys = []) {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(source || {}, key)) return source[key];
  }
  return undefined;
}

function compactDefinedFields(fields) {
  const result = {};
  for (const [key, value] of Object.entries(fields || {})) {
    if (value !== undefined && value !== null && value !== '') result[key] = value;
  }
  return result;
}

function isExternalCliPlanGenerationStrategy(strategy) {
  const normalized = normalizePlanGenerationStrategy(strategy);
  return normalized === 'external-cli-markdown' || normalized === 'external-cli-structured';
}

function isExternalCliPlanExecutionStrategy(strategy) {
  return normalizePlanExecutionStrategy(strategy) === 'external-cli';
}

function isBuiltinPlanBackendStrategy(strategy) {
  const normalized = normalizeOptionalLowerString(strategy);
  return normalized === 'builtin-llm-structured' || normalized === 'builtin-llm';
}

module.exports = {
  DEFAULT_PLAN_EXECUTION_STRATEGY,
  DEFAULT_PLAN_GENERATION_STRATEGY,
  BUILTIN_LLM_PROVIDERS,
  PLAN_BACKEND_CONFIG_INPUT_KEYS,
  PLAN_EXECUTION_CODEX_REASONING_EFFORT_KEYS,
  PLAN_EXECUTION_COMMAND_KEYS,
  PLAN_EXECUTION_MODEL_KEYS,
  PLAN_EXECUTION_PROVIDER_KEYS,
  PLAN_EXECUTION_STRATEGIES,
  PLAN_EXECUTION_STRATEGY_KEYS,
  PLAN_GENERATION_CODEX_REASONING_EFFORT_KEYS,
  PLAN_GENERATION_COMMAND_KEYS,
  PLAN_GENERATION_MODEL_KEYS,
  PLAN_GENERATION_PROVIDER_KEYS,
  PLAN_GENERATION_STRATEGIES,
  PLAN_GENERATION_STRATEGY_KEYS,
  agentCliOperationFieldsForPlanBackend,
  effectivePlanExecutionConfig,
  effectivePlanGenerationConfig,
  isExternalCliPlanExecutionStrategy,
  isExternalCliPlanGenerationStrategy,
  isBuiltinPlanBackendStrategy,
  normalizePlanBackendProvider,
  normalizePlanExecutionStrategy,
  normalizePlanGenerationStrategy,
  planExecutionAgentCliOperationFields,
  planExecutionConfigFields,
  planGenerationAgentCliOperationFields,
  planGenerationConfigFields,
};
