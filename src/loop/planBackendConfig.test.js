const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  effectivePlanExecutionConfig,
  effectivePlanGenerationConfig,
  planExecutionAgentCliOperationFields,
  planExecutionConfigFields,
  planGenerationAgentCliOperationFields,
  planGenerationConfigFields,
} = require('./planBackendConfig');

describe('planBackendConfig generation/execution normalization', () => {
  it('prefers new generation fields over legacy CLI fields and falls back to legacy when absent', () => {
    const prioritized = effectivePlanGenerationConfig(
      {
        agent_cli_provider: 'codex',
        agent_cli_command: 'codex-default',
        codex_reasoning_effort: 'low',
      },
      {
        plan_generation_strategy: 'external-cli-structured',
        plan_generation_provider: 'claude',
        plan_generation_command: 'claude-plan',
        agent_cli_provider: 'opencode',
        codex_reasoning_effort: 'xhigh',
      },
    );

    assert.equal(prioritized.strategy, 'external-cli-structured');
    assert.equal(prioritized.provider, 'claude');
    assert.equal(prioritized.command, 'claude-plan');
    assert.equal(prioritized.codexReasoningEffort, null);

    const legacyFallback = effectivePlanGenerationConfig(
      {
        agent_cli_provider: 'opencode',
        agent_cli_command: 'opencode-plan',
      },
      {},
    );

    assert.equal(legacyFallback.strategy, 'external-cli-markdown');
    assert.equal(legacyFallback.provider, 'opencode');
    assert.equal(legacyFallback.command, 'opencode-plan');
    assert.equal(legacyFallback.codexReasoningEffort, null);
  });

  it('keeps Codex reasoning effort separate for generation and execution', () => {
    const defaults = {
      plan_generation_strategy: 'external-cli-markdown',
      plan_generation_provider: 'codex',
      plan_generation_command: 'codex-plan',
      plan_generation_codex_reasoning_effort: 'high',
      plan_execution_strategy: 'external-cli',
      plan_execution_provider: 'codex',
      plan_execution_command: 'codex-exec',
      plan_execution_codex_reasoning_effort: 'xhigh',
      codex_reasoning_effort: 'low',
    };

    const generation = effectivePlanGenerationConfig(defaults);
    const execution = effectivePlanExecutionConfig(defaults);

    assert.equal(generation.codexReasoningEffort, 'high');
    assert.equal(execution.codexReasoningEffort, 'xhigh');
    assert.deepEqual(planGenerationAgentCliOperationFields(generation), {
      agentCliProvider: 'codex',
      agentCliCommand: 'codex-plan',
      codexReasoningEffort: 'high',
    });
    assert.deepEqual(planExecutionAgentCliOperationFields(execution), {
      agentCliProvider: 'codex',
      agentCliCommand: 'codex-exec',
      codexReasoningEffort: 'xhigh',
    });
  });

  it('normalizes reasoning to null for non-Codex generation and execution providers', () => {
    const generation = planGenerationConfigFields({
      strategy: 'external-cli-structured',
      provider: 'claude',
      command: 'claude-plan',
      codexReasoningEffort: 'xhigh',
    });
    const execution = planExecutionConfigFields({
      strategy: 'external-cli',
      provider: 'opencode',
      command: 'opencode-run',
      codexReasoningEffort: 'high',
    });

    assert.equal(generation.codexReasoningEffort, null);
    assert.equal(generation.planGenerationCodexReasoningEffort, null);
    assert.equal(execution.codexReasoningEffort, null);
    assert.equal(execution.planExecutionCodexReasoningEffort, null);
  });

  it('does not read generation provider when resolving execution config', () => {
    const execution = effectivePlanExecutionConfig({
      plan_generation_strategy: 'external-cli-structured',
      plan_generation_provider: 'claude',
      plan_generation_command: 'claude-plan',
      plan_execution_strategy: 'external-cli',
    });

    assert.equal(execution.strategy, 'external-cli');
    assert.equal(execution.provider, 'codex');
    assert.equal(execution.command, '');
    assert.equal(execution.codexReasoningEffort, 'medium');
  });

  it('supports builtin generation config while keeping external CLI operation mapping guarded', () => {
    const builtin = effectivePlanGenerationConfig(
      {},
      {
        plan_generation_strategy: 'builtin-llm-structured',
        plan_generation_provider: 'openai',
        plan_generation_model: 'gpt-4o',
        plan_generation_codex_reasoning_effort: 'xhigh',
      },
    );

    assert.equal(builtin.strategy, 'builtin-llm-structured');
    assert.equal(builtin.provider, 'openai');
    assert.equal(builtin.model, 'gpt-4o');
    assert.equal(builtin.command, '');
    assert.equal(builtin.codexReasoningEffort, null);
    assert.throws(
      () => planGenerationAgentCliOperationFields(builtin),
      /does not use an external CLI/,
    );
  });
});
