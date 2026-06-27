const { describe, it } = require('node:test');

const {
  agentCliSpawnSpec,
  codexNewSessionArgs,
  codexResumeSessionArgs,
  normalizeCodexReasoningEffort,
} = require('./agentCli');

function expectEqual(actual, expected) {
  if (actual !== expected) {
    throw new Error(`Expected ${JSON.stringify(actual)} to equal ${JSON.stringify(expected)}`);
  }
}

function expectIncludes(items, expected) {
  if (!items.includes(expected)) {
    throw new Error(`Expected ${JSON.stringify(items)} to include ${JSON.stringify(expected)}`);
  }
}

function expectNotIncludes(items, expected) {
  if (items.includes(expected)) {
    throw new Error(`Expected ${JSON.stringify(items)} not to include ${JSON.stringify(expected)}`);
  }
}

describe('Codex reasoning effort', () => {
  it('normalizes xhigh while preserving legacy fallbacks', () => {
    expectEqual(normalizeCodexReasoningEffort('xhigh'), 'xhigh');
    expectEqual(normalizeCodexReasoningEffort(' XHIGH '), 'xhigh');
    expectEqual(normalizeCodexReasoningEffort(''), 'medium');
    expectEqual(normalizeCodexReasoningEffort('invalid'), 'medium');
  });

  it('passes xhigh to new and resumed Codex sessions', () => {
    const expectedArg = 'model_reasoning_effort="xhigh"';

    expectIncludes(codexNewSessionArgs('D:/workspace', 'last.txt', { reasoningEffort: 'xhigh' }), expectedArg);
    expectIncludes(codexResumeSessionArgs('session-id', 'last.txt', { reasoningEffort: 'xhigh' }), expectedArg);
  });

  it('does not add Codex reasoning args to Claude CLI specs', () => {
    const spec = agentCliSpawnSpec('claude', 'claude', 'last.txt', ['-c', 'model_reasoning_effort="xhigh"']);

    expectEqual(spec.agentCliProvider, 'claude');
    expectNotIncludes(spec.args, 'model_reasoning_effort="xhigh"');
  });
});
