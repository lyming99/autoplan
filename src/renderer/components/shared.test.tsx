import {
  codexReasoningEffortLabel,
  planCliSummaryLabel,
  readCodexReasoningEffort,
} from './shared';
import {
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

describe('settings choice metadata', () => {
  it('keeps CLI provider choices ready for segmented controls', () => {
    expectEqual(agentCliOptionDetails.length, 2);
    expectEqual(agentCliOptionDetails[0].value, 'codex');
    expectEqual(agentCliOptionDetails[1].value, 'claude');
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
