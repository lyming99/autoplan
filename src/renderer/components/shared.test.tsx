import {
  codexReasoningEffortLabel,
  planCliSummaryLabel,
  readCodexReasoningEffort,
} from './shared';

type TestRegistrar = (name: string, fn: () => void) => void;

declare function require(id: string): unknown;

const { describe, it } = require('node:test') as { describe: TestRegistrar; it: TestRegistrar };

function expectEqual(actual: unknown, expected: unknown) {
  if (actual !== expected) {
    throw new Error(`Expected ${JSON.stringify(actual)} to equal ${JSON.stringify(expected)}`);
  }
}

describe('shared Codex reasoning helpers', () => {
  it('reads xhigh from shared display sources', () => {
    expectEqual(readCodexReasoningEffort({ codex_reasoning_effort: 'xhigh' }), 'xhigh');
    expectEqual(readCodexReasoningEffort({ reasoningEffort: ' XHIGH ' }), 'xhigh');
  });

  it('falls back to medium for empty and invalid Codex values', () => {
    expectEqual(readCodexReasoningEffort({ codex_reasoning_effort: '' }), 'medium');
    expectEqual(readCodexReasoningEffort({ codex_reasoning_effort: 'invalid' }), 'medium');
  });

  it('keeps Claude summaries free of Codex reasoning depth', () => {
    const source = { agent_cli_provider: 'claude', codex_reasoning_effort: 'xhigh' };

    expectEqual(readCodexReasoningEffort(source), null);
    expectEqual(planCliSummaryLabel(source), 'Claude CLI');
  });

  it('labels xhigh without degrading it to medium', () => {
    expectEqual(codexReasoningEffortLabel('xhigh'), '超高');
  });
});
