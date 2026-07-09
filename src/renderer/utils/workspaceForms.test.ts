export {};

import type { ProjectState } from '../types';

type TestRegistrar = (name: string, fn: () => void) => void;

declare function require(id: string): unknown;

const { describe, it } = require('node:test') as { describe: TestRegistrar; it: TestRegistrar };
const {
  composerPlanGenerationSelectionFromProjectState,
  defaultCodexReasoningEffort,
  defaultNewProjectDefaultCliPreferences,
  loadNewProjectDefaultCliPreferences,
  loopConfigurePayloadFromForm,
  loopFormFromProjectState,
  loopFormsEqual,
  newProjectDefaultCliPreferencesForStorage,
  normalizeNewProjectDefaultCliPreferences,
  planGenerationInputFromComposerSelection,
  saveNewProjectDefaultCliPreferences,
} = require('./workspaceForms.ts') as typeof import('./workspaceForms');

function expect(condition: unknown, message: string) {
  if (!condition) throw new Error(message);
}

function expectEqual(actual: unknown, expected: unknown, message: string) {
  if (actual !== expected) throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function expectDeepEqual(actual: unknown, expected: unknown, message: string) {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) throw new Error(`${message}: expected ${expectedJson}, got ${actualJson}`);
}

function projectState(overrides: Partial<ProjectState> = {}): ProjectState {
  return {
    project_id: 1,
    running: 0,
    phase: 'idle',
    interval_seconds: 5,
    validation_command: '',
    project_prompt: '',
    updated_at: '2026-07-09T00:00:00.000Z',
    workspace_path: 'D:\\workspace\\one',
    ...overrides,
  } as ProjectState;
}

type MockLocalStorage = {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
  clear: () => void;
};

function withMockLocalStorage(fn: (store: Map<string, string>) => void) {
  const host = globalThis as unknown as { window?: { localStorage: MockLocalStorage } };
  const hadWindow = Object.prototype.hasOwnProperty.call(host, 'window');
  const originalWindow = host.window;
  const store = new Map<string, string>();
  host.window = {
    localStorage: {
      getItem: (key) => store.get(key) ?? null,
      setItem: (key, value) => store.set(key, String(value)),
      removeItem: (key) => { store.delete(key); },
      clear: () => { store.clear(); },
    },
  };

  try {
    fn(store);
  } finally {
    if (hadWindow) {
      host.window = originalWindow;
    } else {
      delete host.window;
    }
  }
}

describe('workspaceForms project prompt config plumbing', () => {
  it('fills loop form projectPrompt from snapshot and defaults missing values to empty string', () => {
    const withPrompt = loopFormFromProjectState(projectState({ project_prompt: '项目规范\n第二行' }));
    expectEqual(withPrompt.projectPrompt, '项目规范\n第二行', 'snapshot project_prompt 应回填到 loopForm.projectPrompt');

    const withoutPrompt = loopFormFromProjectState(projectState({ project_prompt: undefined }));
    expectEqual(withoutPrompt.projectPrompt, '', '缺失 project_prompt 时表单默认空字符串');
  });

  it('submits projectPrompt in loop configure payload including clear string', () => {
    const form = loopFormFromProjectState(projectState({ project_prompt: '旧值' }));
    form.projectPrompt = '新项目 Prompt\n保持小步提交';
    const payload = loopConfigurePayloadFromForm(9, form);
    expectEqual(payload.projectId, 9, 'payload 应包含 projectId');
    expectEqual(payload.projectPrompt, '新项目 Prompt\n保持小步提交', 'payload 应提交 projectPrompt');

    form.projectPrompt = '';
    const cleared = loopConfigurePayloadFromForm(9, form);
    expectEqual(cleared.projectPrompt, '', '空字符串应作为清空 projectPrompt 的显式 payload');
  });

  it('includes projectPrompt in loop form dirty comparison', () => {
    const left = loopFormFromProjectState(projectState({ project_prompt: 'A' }));
    const right = { ...left, projectPrompt: 'B' };
    expect(!loopFormsEqual(left, right), 'projectPrompt 变化应让表单变脏');
    expect(loopFormsEqual(left, { ...left }), '相同 projectPrompt 应保持表单相等');
  });
});
describe('workspaceForms new project default CLI preferences', () => {
  it('falls back to Codex defaults when no stored preference exists', () => {
    const normalized = normalizeNewProjectDefaultCliPreferences(null);

    expectDeepEqual(
      normalized,
      defaultNewProjectDefaultCliPreferences,
      'missing new-project CLI preferences should normalize to the Codex defaults',
    );
    expectEqual(normalized.planGenerationProvider, 'codex', 'default generation provider should be Codex');
    expectEqual(normalized.planExecutionProvider, 'codex', 'default execution provider should be Codex');
    expectEqual(normalized.planGenerationCodexReasoningEffort, defaultCodexReasoningEffort, 'default generation reasoning should be normalized');
    expectEqual(normalized.planExecutionCodexReasoningEffort, defaultCodexReasoningEffort, 'default execution reasoning should be normalized');
  });

  it('persists Claude and OpenCode defaults without leaking Codex reasoning', () => {
    withMockLocalStorage((store) => {
      const saved = saveNewProjectDefaultCliPreferences({
        agentCliProvider: 'opencode',
        agentCliCommand: 'opencode exec',
        codexReasoningEffort: 'xhigh',
        planGenerationProvider: 'claude',
        planGenerationCommand: 'claude plan',
        planGenerationCodexReasoningEffort: 'high',
        planExecutionProvider: 'opencode',
        planExecutionCommand: 'opencode run',
        planExecutionCodexReasoningEffort: 'high',
      });

      expectEqual(saved.agentCliProvider, 'opencode', 'saved execution legacy provider should follow OpenCode');
      expectEqual(saved.codexReasoningEffort, null, 'non-Codex execution default should not keep legacy Codex reasoning');
      expectEqual(saved.planGenerationProvider, 'claude', 'saved generation provider should keep Claude');
      expectEqual(saved.planGenerationCodexReasoningEffort, null, 'Claude generation should not keep Codex reasoning');
      expectEqual(saved.planExecutionProvider, 'opencode', 'saved execution provider should keep OpenCode');
      expectEqual(saved.planExecutionCodexReasoningEffort, null, 'OpenCode execution should not keep Codex reasoning');

      const raw = JSON.parse(store.get('autoplan.newProjectDefaultCliPreferences') || '{}') as Record<string, unknown>;
      expect(!Object.prototype.hasOwnProperty.call(raw, 'codexReasoningEffort'), 'stored OpenCode default should omit legacy Codex reasoning');
      expect(!Object.prototype.hasOwnProperty.call(raw, 'planGenerationCodexReasoningEffort'), 'stored Claude generation default should omit Codex reasoning');
      expect(!Object.prototype.hasOwnProperty.call(raw, 'planExecutionCodexReasoningEffort'), 'stored OpenCode execution default should omit Codex reasoning');

      const reloaded = loadNewProjectDefaultCliPreferences();
      expectEqual(reloaded.planGenerationProvider, 'claude', 'reloaded generation provider should keep Claude');
      expectEqual(reloaded.planExecutionProvider, 'opencode', 'reloaded execution provider should keep OpenCode');
      expectEqual(reloaded.planGenerationCommand, 'claude plan', 'reloaded generation command should keep custom CLI command');
      expectEqual(reloaded.planExecutionCommand, 'opencode run', 'reloaded execution command should keep custom CLI command');
    });
  });

  it('supports Oh My Pi as a custom new-project default without Codex reasoning', () => {
    const normalized = normalizeNewProjectDefaultCliPreferences({
      agentCliProvider: 'oh-my-pi',
      planGenerationProvider: 'oh-my-pi',
      planGenerationCommand: 'omp plan',
      planExecutionProvider: 'oh-my-pi',
      planExecutionCommand: 'omp exec',
      codexReasoningEffort: 'high',
      planGenerationCodexReasoningEffort: 'xhigh',
      planExecutionCodexReasoningEffort: 'xhigh',
    });

    expectEqual(normalized.agentCliProvider, 'oh-my-pi', 'legacy execution provider should accept Oh My Pi');
    expectEqual(normalized.codexReasoningEffort, null, 'Oh My Pi legacy provider should not keep Codex reasoning');
    expectEqual(normalized.planGenerationProvider, 'oh-my-pi', 'generation provider should accept Oh My Pi');
    expectEqual(normalized.planGenerationCommand, 'omp plan', 'generation command should keep Oh My Pi command');
    expectEqual(normalized.planGenerationCodexReasoningEffort, null, 'Oh My Pi generation should not keep Codex reasoning');
    expectEqual(normalized.planExecutionProvider, 'oh-my-pi', 'execution provider should accept Oh My Pi');
    expectEqual(normalized.planExecutionCommand, 'omp exec', 'execution command should keep Oh My Pi command');
    expectEqual(normalized.planExecutionCodexReasoningEffort, null, 'Oh My Pi execution should not keep Codex reasoning');
  });

  it('keeps normalized Codex reasoning only for Codex defaults', () => {
    const normalized = normalizeNewProjectDefaultCliPreferences({
      agentCliProvider: 'codex',
      codexReasoningEffort: 'low',
      planGenerationProvider: 'codex',
      planGenerationCodexReasoningEffort: 'invalid',
      planExecutionProvider: 'codex',
      planExecutionCodexReasoningEffort: 'xhigh',
    });
    const stored = newProjectDefaultCliPreferencesForStorage(normalized);

    expectEqual(normalized.codexReasoningEffort, 'low', 'Codex legacy reasoning should keep the selected value');
    expectEqual(normalized.planGenerationCodexReasoningEffort, defaultCodexReasoningEffort, 'invalid Codex generation reasoning should fall back');
    expectEqual(normalized.planExecutionCodexReasoningEffort, 'xhigh', 'Codex execution reasoning should keep xhigh');
    expectEqual(stored.codexReasoningEffort, 'low', 'stored Codex default should include legacy reasoning');
    expectEqual(stored.planGenerationCodexReasoningEffort, defaultCodexReasoningEffort, 'stored Codex generation default should include reasoning');
    expectEqual(stored.planExecutionCodexReasoningEffort, 'xhigh', 'stored Codex execution default should include reasoning');
  });

  it('uses project plan-generation defaults for workspace composer submissions', () => {
    const claudeSelection = composerPlanGenerationSelectionFromProjectState(projectState({
      agent_cli_provider: 'codex',
      codex_reasoning_effort: 'xhigh',
      plan_generation_provider: 'claude',
      plan_generation_command: 'claude plan',
      plan_generation_codex_reasoning_effort: 'high',
    }));
    const claudeInput = planGenerationInputFromComposerSelection(claudeSelection);

    expectEqual(claudeSelection.provider, 'claude', 'composer default should read the project generation provider');
    expectEqual(claudeSelection.command, 'claude plan', 'composer default should read the project generation command');
    expectEqual(claudeInput.planGenerationProvider, 'claude', 'composer create payload should submit the project generation provider');
    expectEqual(claudeInput.planGenerationCommand, 'claude plan', 'composer create payload should submit the project generation command');
    expectEqual(claudeInput.planGenerationCodexReasoningEffort, null, 'composer create payload should omit Codex reasoning for Claude');

    const codexInput = planGenerationInputFromComposerSelection(composerPlanGenerationSelectionFromProjectState(projectState({
      plan_generation_provider: 'codex',
      plan_generation_codex_reasoning_effort: 'xhigh',
    })));
    expectEqual(codexInput.planGenerationProvider, 'codex', 'Codex composer default should keep Codex provider');
    expectEqual(codexInput.planGenerationCodexReasoningEffort, 'xhigh', 'Codex composer default should keep normalized reasoning');
  });
});

