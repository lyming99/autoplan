import {
  agentCliProviderLabel,
  codexReasoningEffortLabel,
  planCliSummaryLabel,
  readCodexReasoningEffort,
} from './shared';
import {
  agentCliDefaultCommand,
  agentCliOptionDetails,
  codexReasoningOptionDetails,
  scopeFileOpenModeOptions,
} from '../utils/workspaceForms';

type TestRegistrar = (name: string, fn: () => void) => void;

declare function require(id: string): unknown;

const { describe, it } = require('node:test') as { describe: TestRegistrar; it: TestRegistrar };

function expectEqual(actual: unknown, expected: unknown) {
  if (actual !== expected) {
    throw new Error(`Expected ${JSON.stringify(actual)} to equal ${JSON.stringify(expected)}`);
  }
}

function expect(condition: unknown, message: string) {
  if (!condition) throw new Error(message);
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

describe('shared OpenCode display helpers', () => {
  it('labels the opencode provider without Codex reasoning depth', () => {
    expectEqual(agentCliProviderLabel('opencode'), 'OpenCode');
    expectEqual(agentCliProviderLabel('OPENCODE'), 'OpenCode');
    expectEqual(agentCliDefaultCommand('opencode'), 'opencode');
  });

  it('keeps OpenCode plan summaries free of Codex reasoning depth', () => {
    expectEqual(planCliSummaryLabel({ agentCliProvider: 'opencode' }), 'OpenCode CLI');
    expectEqual(
      planCliSummaryLabel({ agent_cli_provider: 'opencode', codex_reasoning_effort: 'xhigh' }),
      'OpenCode CLI',
    );
  });
});

describe('shared Oh My Pi display helpers', () => {
  it('labels the oh-my-pi provider and resolves the omp command', () => {
    expectEqual(agentCliProviderLabel('oh-my-pi'), 'Oh My Pi');
    expectEqual(agentCliProviderLabel('OH-MY-PI'), 'Oh My Pi');
    expectEqual(agentCliDefaultCommand('oh-my-pi'), 'omp');
  });

  it('keeps Oh My Pi plan summaries free of Codex reasoning depth', () => {
    expectEqual(planCliSummaryLabel({ agentCliProvider: 'oh-my-pi' }), 'Oh My Pi CLI');
    expectEqual(
      planCliSummaryLabel({ agent_cli_provider: 'oh-my-pi', codex_reasoning_effort: 'xhigh' }),
      'Oh My Pi CLI',
    );
  });
});

describe('settings choice metadata', () => {
  it('keeps CLI provider choices ready for segmented controls', () => {
    expectEqual(agentCliOptionDetails.length, 4);
    expectEqual(agentCliOptionDetails[0].value, 'codex');
    expectEqual(agentCliOptionDetails[1].value, 'claude');
    expectEqual(agentCliOptionDetails[2].value, 'opencode');
    expectEqual(agentCliOptionDetails[3].value, 'oh-my-pi');
    expect(agentCliOptionDetails.every((option) => option.description), 'CLI options should include descriptions');
  });

  it('keeps Codex effort card choices aligned with labels', () => {
    const effortValues = codexReasoningOptionDetails.map((option) => option.value).join(',');

    expectEqual(effortValues, 'low,medium,high,xhigh');
    expectEqual(codexReasoningOptionDetails.find((option) => option.value === 'xhigh')?.label, '超高');
    expect(codexReasoningOptionDetails.every((option) => option.description), 'Codex effort options should include descriptions');
  });

  it('keeps scope open modes complete for the segmented control', () => {
    const scopeModes = scopeFileOpenModeOptions.map((option) => option.value).join(',');

    expectEqual(scopeModes, 'system,folder,vscode,command');
    expect(scopeFileOpenModeOptions.some((option) => option.description.includes('{file}')), 'command mode should document the {file} placeholder');
  });
});
