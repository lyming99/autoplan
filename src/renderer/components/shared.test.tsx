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
  createDefaultPlanGenerationSelection,
  isBuiltinPlanExecutionStrategy,
  isBuiltinPlanGenerationStrategy,
  planBackendDefaultCommand,
  planBackendDefaultModel,
  planBackendProviderOptionsForStrategy,
  planExecutionStrategyOptions,
  planGenerationInputFromComposerSelection,
  planGenerationStrategyOptions,
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

function expectDeepEqual(actual: unknown, expected: unknown) {
  const actualText = JSON.stringify(actual);
  const expectedText = JSON.stringify(expected);
  if (actualText !== expectedText) {
    throw new Error(`Expected ${actualText} to deep equal ${expectedText}`);
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

describe('shared planCliSummaryLabel with intake-shaped fields', () => {
  it('labels Codex with low reasoning effort from intake fields', () => {
    expectEqual(
      planCliSummaryLabel({ agent_cli_provider: 'codex', codex_reasoning_effort: 'low' }),
      'Codex CLI · 思考深度 low',
    );
  });

  it('labels Codex with high reasoning effort from intake fields', () => {
    expectEqual(
      planCliSummaryLabel({ agent_cli_provider: 'codex', codex_reasoning_effort: 'high' }),
      'Codex CLI · 思考深度 high',
    );
  });

  it('labels Codex with xhigh reasoning effort from intake fields', () => {
    expectEqual(
      planCliSummaryLabel({ agent_cli_provider: 'codex', codex_reasoning_effort: 'xhigh' }),
      'Codex CLI · 思考深度 超高',
    );
  });

  it('labels Claude from intake fields without reasoning depth suffix', () => {
    expectEqual(
      planCliSummaryLabel({ agent_cli_provider: 'claude' }),
      'Claude CLI',
    );
  });

  it('labels OpenCode from intake fields', () => {
    expectEqual(
      planCliSummaryLabel({ agent_cli_provider: 'opencode' }),
      'OpenCode CLI',
    );
  });

  it('labels Oh My Pi from intake fields', () => {
    expectEqual(
      planCliSummaryLabel({ agent_cli_provider: 'oh-my-pi' }),
      'Oh My Pi CLI',
    );
  });

  it('defaults to Codex medium when provider is missing from intake', () => {
    expectEqual(
      planCliSummaryLabel({}),
      'Codex CLI · 思考深度 medium',
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

describe('plan backend settings metadata', () => {
  it('keeps generation and execution strategy choices separate', () => {
    expectDeepEqual(
      planGenerationStrategyOptions.map((option) => option.value),
      ['external-cli-markdown', 'external-cli-structured', 'builtin-llm-structured'],
    );
    expectDeepEqual(
      planExecutionStrategyOptions.map((option) => option.value),
      ['external-cli', 'builtin-llm'],
    );
    expectEqual(isBuiltinPlanGenerationStrategy('builtin-llm-structured'), true);
    expectEqual(isBuiltinPlanGenerationStrategy('external-cli-structured'), false);
    expectEqual(isBuiltinPlanExecutionStrategy('builtin-llm'), true);
    expectEqual(isBuiltinPlanExecutionStrategy('external-cli'), false);
  });

  it('maps backend providers to the right command or model defaults', () => {
    expectDeepEqual(
      planBackendProviderOptionsForStrategy('external-cli-structured').map((option) => option.value),
      ['codex', 'claude', 'opencode', 'oh-my-pi'],
    );
    expectDeepEqual(
      planBackendProviderOptionsForStrategy('builtin-llm-structured').map((option) => option.value),
      ['openai', 'deepseek', 'anthropic'],
    );
    expectEqual(planBackendDefaultCommand('oh-my-pi'), 'omp');
    expectEqual(planBackendDefaultCommand('claude'), 'claude');
    expectEqual(planBackendDefaultModel('openai'), 'gpt-4o');
    expectEqual(planBackendDefaultModel('deepseek'), 'deepseek-chat');
    expectEqual(planBackendDefaultModel('anthropic'), 'claude-sonnet-4-6');
  });

  it('normalizes Composer overrides to generation fields only', () => {
    const projectDefault = planGenerationInputFromComposerSelection(createDefaultPlanGenerationSelection());
    const external = planGenerationInputFromComposerSelection(createDefaultPlanGenerationSelection({
      useProjectDefault: false,
      strategy: 'external-cli-structured',
      provider: 'codex',
      command: ' codex plan ',
      codexReasoningEffort: 'xhigh',
    }));
    const builtin = planGenerationInputFromComposerSelection(createDefaultPlanGenerationSelection({
      useProjectDefault: false,
      strategy: 'builtin-llm-structured',
      provider: 'deepseek',
      model: '',
      command: 'should-not-cross',
      codexReasoningEffort: 'high',
    }));

    expectDeepEqual(projectDefault, {});
    expectDeepEqual(external, {
      planGenerationStrategy: 'external-cli-structured',
      planGenerationProvider: 'codex',
      planGenerationCommand: 'codex plan',
      planGenerationModel: '',
      planGenerationCodexReasoningEffort: 'xhigh',
    });
    expectDeepEqual(builtin, {
      planGenerationStrategy: 'builtin-llm-structured',
      planGenerationProvider: 'deepseek',
      planGenerationCommand: '',
      planGenerationModel: 'deepseek-chat',
      planGenerationCodexReasoningEffort: null,
    });
    expect(
      Object.keys({ ...external, ...builtin }).every((key) => !key.startsWith('planExecution')),
      'Composer 归一化输出不应包含执行覆盖字段',
    );
  });
});
