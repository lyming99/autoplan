const { effectiveAgentCliConfig, hasAgentCliOverride } = require('./agentCliConfig');
const planBackendConfig = require('./planBackendConfig');
const { parseEventMeta } = require('./snapshots');

const BUILTIN_LLM_EXECUTION_UNSUPPORTED_ERROR = 'builtin-llm execution is not supported yet';

function planAgentCliConfig(service, plan) {
  const executionConfig = planExecutionConfig(service, plan);
  if (!planBackendConfig.isExternalCliPlanExecutionStrategy(executionConfig.strategy)) {
    return planExecutionDisplayConfig(executionConfig);
  }
  const operationFields = planBackendConfig.planExecutionAgentCliOperationFields(executionConfig);
  return effectiveAgentCliConfig({}, operationFields);
}

function planExecutionConfig(service, plan) {
  const projectDefaults = service.status(plan.project_id) || {};
  const eventSnapshot = planAgentCliEventSnapshot(service, plan.project_id, plan.id);
  const sourceSnapshot = planSourceAgentCliSnapshot(service, plan.project_id, plan.id);
  const snapshotDefaults = eventSnapshot || sourceSnapshot || projectDefaults;
  if (hasPlanExecutionConfigSnapshot(plan) || hasAgentCliOverride(plan)) {
    return planBackendConfig.effectivePlanExecutionConfig(snapshotDefaults, flattenPlanExecutionSource(plan));
  }
  if (eventSnapshot) {
    return planBackendConfig.effectivePlanExecutionConfig(projectDefaults, eventSnapshot);
  }
  if (sourceSnapshot) {
    return planBackendConfig.effectivePlanExecutionConfig(projectDefaults, sourceSnapshot);
  }
  return planBackendConfig.effectivePlanExecutionConfig(projectDefaults);
}

function planSnapshotAgentCliConfig(service, plan) {
  return planAgentCliConfig(service, plan);
}

function planAgentCliEventSnapshot(service, projectId, planId) {
  const rows = service.db.all(
    `SELECT meta FROM events
     WHERE project_id = ? AND type = 'plan.generated' AND meta IS NOT NULL
     ORDER BY id DESC
     LIMIT 40`,
    [projectId],
  );
  for (const row of rows) {
    const meta = parseEventMeta(row.meta);
    if (!meta || typeof meta !== 'object') continue;
    if (!planEventMatches(meta, planId)) continue;
    if (hasPlanExecutionConfigSnapshot(meta) || hasAgentCliOverride(meta)) return flattenPlanExecutionSource(meta);
  }
  return null;
}

function planSourceAgentCliSnapshot(service, projectId, planId) {
  const requirement = service.db.get('SELECT * FROM requirements WHERE project_id = ? AND linked_plan_id = ? LIMIT 1', [
    projectId,
    planId,
  ]);
  if (requirement && hasAgentCliOverride(requirement)) return requirement;
  const feedback = service.db.get('SELECT * FROM feedback WHERE project_id = ? AND linked_plan_id = ? LIMIT 1', [projectId, planId]);
  if (feedback && hasAgentCliOverride(feedback)) return feedback;
  return null;
}

function planExecutionDisplayConfig(config = {}) {
  const normalized = planBackendConfig.planExecutionConfigFields({
    strategy: config.strategy ?? config.planExecutionStrategy,
    provider: config.provider ?? config.planExecutionProvider,
    command: config.command ?? config.planExecutionCommand,
    model: config.model ?? config.planExecutionModel,
    codexReasoningEffort: config.codexReasoningEffort ?? config.planExecutionCodexReasoningEffort,
  });
  return {
    provider: normalized.provider,
    command: normalized.command,
    codexReasoningEffort: normalized.codexReasoningEffort,
    ...normalized,
  };
}

function planExecutionEventMeta(config = {}) {
  const normalized = planBackendConfig.planExecutionConfigFields({
    strategy: config.strategy ?? config.planExecutionStrategy,
    provider: config.provider ?? config.planExecutionProvider,
    command: config.command ?? config.planExecutionCommand,
    model: config.model ?? config.planExecutionModel,
    codexReasoningEffort: config.codexReasoningEffort ?? config.planExecutionCodexReasoningEffort,
  });
  return {
    planExecutionConfig: {
      strategy: normalized.strategy,
      provider: normalized.provider,
      command: normalized.command,
      model: normalized.model,
      codexReasoningEffort: normalized.codexReasoningEffort,
    },
    planExecutionStrategy: normalized.strategy,
    planExecutionProvider: normalized.provider,
    planExecutionCommand: normalized.command,
    planExecutionModel: normalized.model,
    planExecutionCodexReasoningEffort: normalized.codexReasoningEffort,
  };
}

function isBuiltinLlmPlanExecution(config = {}) {
  return planBackendConfig.normalizePlanExecutionStrategy(config.strategy ?? config.planExecutionStrategy) === 'builtin-llm';
}

function hasPlanExecutionConfigSnapshot(source = {}) {
  if (!source || typeof source !== 'object') return false;
  if (source.planExecutionConfig && typeof source.planExecutionConfig === 'object') return true;
  return [
    ...planBackendConfig.PLAN_EXECUTION_STRATEGY_KEYS,
    ...planBackendConfig.PLAN_EXECUTION_PROVIDER_KEYS,
    ...planBackendConfig.PLAN_EXECUTION_COMMAND_KEYS,
    ...planBackendConfig.PLAN_EXECUTION_MODEL_KEYS,
    ...planBackendConfig.PLAN_EXECUTION_CODEX_REASONING_EFFORT_KEYS,
  ].some((key) => Object.prototype.hasOwnProperty.call(source, key));
}

function flattenPlanExecutionSource(source = {}) {
  const nested = source.planExecutionConfig && typeof source.planExecutionConfig === 'object'
    ? source.planExecutionConfig
    : {};
  return {
    ...source,
    planExecutionStrategy: readFirstPlanExecutionValue(source, nested, ['planExecutionStrategy', 'plan_execution_strategy', 'strategy']),
    planExecutionProvider: readFirstPlanExecutionValue(source, nested, ['planExecutionProvider', 'plan_execution_provider', 'provider']),
    planExecutionCommand: readFirstPlanExecutionValue(source, nested, ['planExecutionCommand', 'plan_execution_command', 'command']),
    planExecutionModel: readFirstPlanExecutionValue(source, nested, ['planExecutionModel', 'plan_execution_model', 'model']),
    planExecutionCodexReasoningEffort: readFirstPlanExecutionValue(source, nested, [
      'planExecutionCodexReasoningEffort',
      'plan_execution_codex_reasoning_effort',
      'codexReasoningEffort',
      'codex_reasoning_effort',
    ]),
  };
}

function readFirstPlanExecutionValue(source, nested, keys) {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(source || {}, key)) return source[key];
  }
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(nested || {}, key)) return nested[key];
  }
  return undefined;
}

function planEventMatches(meta, planId) {
  const target = Number(planId);
  if (!Number.isInteger(target) || target <= 0) return false;
  if (Number(meta.planId ?? meta.plan_id) === target) return true;
  return [meta.planIds, meta.plan_ids, meta.generatedPlanIds, meta.generated_plan_ids]
    .some((ids) => Array.isArray(ids) && ids.some((id) => Number(id) === target));
}

module.exports = {
  BUILTIN_LLM_EXECUTION_UNSUPPORTED_ERROR,
  isBuiltinLlmPlanExecution,
  planExecutionConfig,
  planExecutionEventMeta,
  planAgentCliConfig,
  planSnapshotAgentCliConfig,
  planAgentCliEventSnapshot,
  planSourceAgentCliSnapshot,
};
