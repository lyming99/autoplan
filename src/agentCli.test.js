const { describe, it } = require('node:test');

const {
  AGENT_CLI_PROVIDERS,
  agentCliSpawnSpec,
  claudeCliArgs,
  claudeSessionArgs,
  codexNewSessionArgs,
  codexResumeSessionArgs,
  normalizeAgentCliProvider,
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

describe('Claude session spec', () => {
  it('starts fresh Claude runs without Codex session or reasoning args', () => {
    const spec = agentCliSpawnSpec('claude', '', 'last.txt', ['resume', 'codex-session-id', '-c', 'model_reasoning_effort="xhigh"']);

    expectEqual(spec.command, 'claude');
    expectEqual(spec.agentCliProvider, 'claude');
    expectEqual(spec.promptSource, 'stdin');
    expectEqual(spec.lastFileSource, 'claude-stream-json');
    expectEqual(spec.agentCliSessionMode, 'new');
    expectEqual(spec.agentCliSessionId, '');
    expectIncludes(spec.args, '--print');
    expectIncludes(spec.args, '--output-format');
    expectIncludes(spec.args, 'stream-json');
    expectIncludes(spec.args, '--verbose');
    expectIncludes(spec.args, '--dangerously-skip-permissions');
    expectNotIncludes(spec.args, 'resume');
    expectNotIncludes(spec.args, 'codex-session-id');
    expectNotIncludes(spec.args, 'model_reasoning_effort="xhigh"');
  });

  it('starts Claude with an explicit session id when requested', () => {
    const spec = agentCliSpawnSpec('claude', 'claude', 'last.txt', [], {
      sessionMode: 'session-id',
      sessionId: 'claude-new-session-1',
    });

    expectIncludes(claudeSessionArgs({ sessionMode: 'session-id', sessionId: 'claude-new-session-1' }), '--session-id');
    expectIncludes(spec.args, '--session-id');
    expectIncludes(spec.args, 'claude-new-session-1');
    expectEqual(spec.agentCliSessionId, 'claude-new-session-1');
    expectEqual(spec.agentCliSessionRequestedId, '');
    expectEqual(spec.agentCliSessionMode, 'session-id');
  });

  it('resumes Claude sessions with the requested session id', () => {
    const spec = agentCliSpawnSpec('claude', 'claude', 'last.txt', [], {
      agentCliSessionRequestedId: 'claude-plan-session-1',
    });

    expectIncludes(claudeCliArgs({ agentCliSessionRequestedId: 'claude-plan-session-1' }), '--resume');
    expectIncludes(spec.args, '--resume');
    expectIncludes(spec.args, 'claude-plan-session-1');
    expectEqual(spec.agentCliSessionId, 'claude-plan-session-1');
    expectEqual(spec.agentCliSessionRequestedId, 'claude-plan-session-1');
    expectEqual(spec.agentCliSessionMode, 'resume');
  });

  it('supports Claude continue mode without leaking stale session ids', () => {
    const spec = agentCliSpawnSpec('claude', 'claude', 'last.txt', [], {
      agentCliSessionMode: 'continue',
      agentCliSessionId: 'claude-stale-session',
    });

    expectIncludes(spec.args, '--continue');
    expectNotIncludes(spec.args, 'claude-stale-session');
    expectEqual(spec.agentCliSessionId, '');
    expectEqual(spec.agentCliSessionRequestedId, '');
    expectEqual(spec.agentCliSessionMode, 'continue');
  });
});

describe('OpenCode backend spec', () => {
  it('normalizes opencode and degrades unknown providers to codex', () => {
    expectIncludes([...AGENT_CLI_PROVIDERS], 'opencode');
    expectEqual(normalizeAgentCliProvider('opencode'), 'opencode');
    expectEqual(normalizeAgentCliProvider('OPENCODE'), 'opencode');
    expectEqual(normalizeAgentCliProvider('unknown-backend'), 'codex');
    expectEqual(normalizeAgentCliProvider(''), 'codex');
    expectEqual(normalizeAgentCliProvider(null), 'codex');
  });

  it('resolves the default opencode command and keeps custom command paths', () => {
    expectEqual(agentCliSpawnSpec('opencode', '', 'last.txt').command, 'opencode');
    expectEqual(agentCliSpawnSpec('opencode', '/usr/local/bin/opencode', 'last.txt').command, '/usr/local/bin/opencode');
  });

  it('produces opencode spawn args with stdout output and positional prompt', () => {
    const spec = agentCliSpawnSpec(
      'opencode',
      'opencode',
      'last.txt',
      ['-c', 'model_reasoning_effort="xhigh"', 'resume', 'session-id'],
    );

    expectEqual(spec.agentCliProvider, 'opencode');
    expectIncludes(spec.args, 'run');
    expectIncludes(spec.args, '--format');
    expectEqual(spec.promptSource, 'argument');
    expectEqual(spec.lastFileSource, 'stdout');
    expectEqual(spec.useShell, false);
  });

  it('keeps opencode specs free of Codex reasoning and session flags', () => {
    const spec = agentCliSpawnSpec(
      'opencode',
      'opencode',
      'last.txt',
      ['-c', 'model_reasoning_effort="xhigh"', 'resume'],
    );

    expectNotIncludes(spec.args, 'model_reasoning_effort');
    expectNotIncludes(spec.args, 'resume');
    expectNotIncludes(spec.args, 'session-id');
  });

  it('passes OpenCode session options as native run flags', () => {
    const spec = agentCliSpawnSpec(
      'opencode',
      'opencode',
      'last.txt',
      [],
      { sessionId: 'ses_12345', title: 'AutoPlan project 1 plan 2' },
    );

    expectIncludes(spec.args, '--session');
    expectIncludes(spec.args, 'ses_12345');
    expectIncludes(spec.args, '--title');
    expectIncludes(spec.args, 'AutoPlan project 1 plan 2');
    expectEqual(spec.agentCliSessionId, 'ses_12345');
    expectEqual(spec.agentCliSessionTitle, 'AutoPlan project 1 plan 2');
  });
});

describe('Oh My Pi backend spec', () => {
  it('normalizes oh-my-pi and degrades unknown providers to codex', () => {
    expectIncludes([...AGENT_CLI_PROVIDERS], 'oh-my-pi');
    expectEqual(normalizeAgentCliProvider('oh-my-pi'), 'oh-my-pi');
    expectEqual(normalizeAgentCliProvider('OH-MY-PI'), 'oh-my-pi');
    expectEqual(normalizeAgentCliProvider('Oh-My-Pi'), 'oh-my-pi');
    expectEqual(normalizeAgentCliProvider('unknown-backend'), 'codex');
    expectEqual(normalizeAgentCliProvider(''), 'codex');
    expectEqual(normalizeAgentCliProvider(null), 'codex');
  });

  it('resolves the default omp command and keeps custom command paths', () => {
    expectEqual(agentCliSpawnSpec('oh-my-pi', '', 'last.txt').command, 'omp');
    expectEqual(agentCliSpawnSpec('oh-my-pi', '/usr/local/bin/omp', 'last.txt').command, '/usr/local/bin/omp');
  });

  it('produces oh-my-pi spawn args with stdin prompt and stdout output', () => {
    const spec = agentCliSpawnSpec(
      'oh-my-pi',
      'omp',
      'last.txt',
      ['-c', 'model_reasoning_effort="xhigh"', 'resume', 'session-id'],
    );

    expectEqual(spec.agentCliProvider, 'oh-my-pi');
    expectIncludes(spec.args, '--print');
    expectEqual(spec.promptSource, 'stdin');
    expectEqual(spec.lastFileSource, 'stdout');
    expectEqual(spec.useShell, false);
  });

  it('keeps oh-my-pi specs stateless and free of other provider flags', () => {
    const spec = agentCliSpawnSpec(
      'oh-my-pi',
      'omp',
      'last.txt',
      ['-c', 'model_reasoning_effort="xhigh"', 'resume', 'session-id'],
      { sessionId: 'ses_12345', title: 'AutoPlan project 1 plan 2' },
    );

    // 无状态后端：不产出任何会话字段。
    expectEqual(spec.agentCliSessionId, undefined);
    expectEqual(spec.agentCliSessionTitle, undefined);
    expectEqual(spec.agentCliSessionMode, undefined);

    // 不含 Codex 思考深度 / 会话标志。
    expectNotIncludes(spec.args, 'model_reasoning_effort');
    expectNotIncludes(spec.args, 'resume');
    expectNotIncludes(spec.args, 'session-id');
    expectNotIncludes(spec.args, 'exec');
    // 不含 Claude stream-json / 会话续接标志（--print 为 omp 自身非交互标志，需保留）。
    expectNotIncludes(spec.args, 'stream-json');
    expectNotIncludes(spec.args, '--output-format');
    expectNotIncludes(spec.args, '--verbose');
    expectNotIncludes(spec.args, '--dangerously-skip-permissions');
    // 不含 OpenCode run/session/title 标志。
    expectNotIncludes(spec.args, 'run');
    expectNotIncludes(spec.args, '--format');
    expectNotIncludes(spec.args, '--session');
    expectNotIncludes(spec.args, '--title');
  });
});
