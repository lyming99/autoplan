export {};

type TestRegistrar = (name: string, fn: () => void) => void;

declare function require(id: string): unknown;
declare const process: { cwd(): string };

const { describe, it } = require('node:test') as { describe: TestRegistrar; it: TestRegistrar };
const { readFileSync } = require('node:fs') as { readFileSync: (path: string, encoding: string) => string };
const { join } = require('node:path') as { join: (...parts: string[]) => string };

function expect(condition: unknown, message: string) {
  if (!condition) throw new Error(message);
}

function workspacePageSource() {
  return readFileSync(join(process.cwd(), 'src', 'renderer', 'pages', 'WorkspacePage.tsx'), 'utf8');
}

describe('WorkspacePage Codex reasoning options', () => {
  it('offers xhigh after the existing three reasoning levels', () => {
    const source = workspacePageSource();
    const lowIndex = source.indexOf("{ value: 'low', label: '低 · 快速' }");
    const mediumIndex = source.indexOf("{ value: 'medium', label: '中 · 默认' }");
    const highIndex = source.indexOf("{ value: 'high', label: '高 · 深入' }");
    const xhighIndex = source.indexOf("{ value: 'xhigh', label: '超高 · 最深入' }");

    expect(lowIndex >= 0, 'low option should exist');
    expect(mediumIndex > lowIndex, 'medium option should follow low');
    expect(highIndex > mediumIndex, 'high option should follow medium');
    expect(xhighIndex > highIndex, 'xhigh option should follow high');
  });

  it('keeps medium as the default and accepts xhigh in local normalization', () => {
    const source = workspacePageSource();

    expect(source.includes("const defaultCodexReasoningEffort: CodexReasoningEffort = 'medium';"), 'default should stay medium');
    expect(source.includes("effort === 'xhigh'"), 'local normalization should accept xhigh');
    expect(source.includes('return defaultCodexReasoningEffort;'), 'invalid local values should still use the default');
  });
});
