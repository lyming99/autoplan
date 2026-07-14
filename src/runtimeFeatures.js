'use strict';

const RUNTIME_FEATURE_ENV = Object.freeze({
  go_loop_actions: 'AUTOPLAN_SIDECAR_GO_LOOP_ACTIONS',
  go_plan_actions: 'AUTOPLAN_SIDECAR_GO_PLAN_ACTIONS',
  go_task_actions: 'AUTOPLAN_SIDECAR_GO_TASK_ACTIONS',
  go_acceptance_retry_actions: 'AUTOPLAN_SIDECAR_GO_ACCEPTANCE_RETRY_ACTIONS',
  go_scripts_api: 'AUTOPLAN_SIDECAR_GO_SCRIPTS_API',
  go_executors_api: 'AUTOPLAN_SIDECAR_GO_EXECUTORS_API',
  go_chat_api: 'AUTOPLAN_SIDECAR_GO_CHAT_API',
  go_terminal_api: 'AUTOPLAN_SIDECAR_GO_TERMINAL_API',
  go_agent_cli_runtime: 'AUTOPLAN_SIDECAR_GO_AGENT_CLI_RUNTIME',
});

// The desktop runtime is Go-only. A missing rollout variable must select the
// available Go implementation instead of the removed business IPC delegate.
const DEFAULT_RUNTIME_FEATURES = Object.freeze({
  go_loop_actions: true,
  go_plan_actions: true,
  go_task_actions: true,
  go_acceptance_retry_actions: true,
  go_scripts_api: true,
  go_executors_api: true,
  go_chat_api: true,
  go_terminal_api: true,
  // Retained only for parsing old launch environments. Script and Executor
  // use their independent Go feature keys.
  go_agent_cli_runtime: false,
});

function runtimeFeatureFlags(env = {}) {
  const result = {};
  for (const [feature, name] of Object.entries(RUNTIME_FEATURE_ENV)) {
    const value = env?.[name];
    if (value === undefined) result[feature] = DEFAULT_RUNTIME_FEATURES[feature];
    else if (value === 'true') result[feature] = true;
    else if (value === 'false') result[feature] = false;
    else return disabledRuntimeFeatures();
  }
  return Object.freeze(result);
}

function daemonRuntimeFeatureEnvironment(env = {}) {
  const features = runtimeFeatureFlags(env);
  const result = Object.fromEntries(Object.entries(RUNTIME_FEATURE_ENV)
    .map(([feature, name]) => [name, features[feature] === true]));
  result.AUTOPLAN_SIDECAR_GO_MCP_API = env?.AUTOPLAN_SIDECAR_GO_MCP_API !== 'false';
  return Object.freeze(result);
}

function disabledRuntimeFeatures() {
  return Object.freeze(Object.fromEntries(Object.keys(RUNTIME_FEATURE_ENV).map((key) => [key, false])));
}

module.exports = {
  DEFAULT_RUNTIME_FEATURES,
  RUNTIME_FEATURE_ENV,
  daemonRuntimeFeatureEnvironment,
  runtimeFeatureFlags,
};
