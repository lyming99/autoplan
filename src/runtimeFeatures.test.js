'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  DEFAULT_RUNTIME_FEATURES,
  RUNTIME_FEATURE_ENV,
  daemonRuntimeFeatureEnvironment,
  runtimeFeatureFlags,
} = require('./runtimeFeatures');

describe('Go desktop runtime feature handoff', () => {
  it('enables every implemented Go business family by default', () => {
    assert.deepEqual(runtimeFeatureFlags({}), DEFAULT_RUNTIME_FEATURES);
    assert.equal(runtimeFeatureFlags({}).go_loop_actions, true);
    assert.equal(runtimeFeatureFlags({}).go_terminal_api, true);
    assert.equal(runtimeFeatureFlags({}).go_agent_cli_runtime, false);
  });

  it('honors explicit recovery overrides without reviving business IPC', () => {
    const flags = runtimeFeatureFlags({
      [RUNTIME_FEATURE_ENV.go_loop_actions]: 'false',
      [RUNTIME_FEATURE_ENV.go_terminal_api]: 'false',
    });
    assert.equal(flags.go_loop_actions, false);
    assert.equal(flags.go_terminal_api, false);
    assert.equal(flags.go_plan_actions, true);
  });

  it('fails the complete handoff closed for malformed launch values', () => {
    const flags = runtimeFeatureFlags({ [RUNTIME_FEATURE_ENV.go_loop_actions]: 'yes' });
    assert.deepEqual(Object.values(flags), Object.values(flags).map(() => false));
  });

  it('passes the same defaults to the renderer and Go daemon', () => {
    const daemon = daemonRuntimeFeatureEnvironment({});
    for (const [feature, environmentName] of Object.entries(RUNTIME_FEATURE_ENV)) {
      assert.equal(daemon[environmentName], DEFAULT_RUNTIME_FEATURES[feature], feature);
    }
    assert.equal(daemon.AUTOPLAN_SIDECAR_GO_MCP_API, true);
  });
});
