const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { describe, it } = require('node:test');
const vm = require('node:vm');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const ts = require('typescript');

function loadOverview() {
  const fileName = join(process.cwd(), 'src', 'renderer', 'components', 'workspace', 'WorkspaceOverviewView.tsx');
  const compiled = ts.transpileModule(readFileSync(fileName, 'utf8'), {
    compilerOptions: {
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName,
  }).outputText;
  const module = { exports: {} };
  const wrapper = vm.runInThisContext(`(function (require, module, exports) { ${compiled}\n})`);
  wrapper((id) => {
    if (id === 'react' || id === 'react/jsx-runtime') return require(id);
    if (id === '../CodexLog') return { CodexLog: () => null, agentCliSessionContextLabel: () => '' };
    if (id === '../PlanLists') return { EventList: () => null };
    if (id === '../icons') return { Icon: () => null };
    if (id === '../shared') {
      return {
        agentCliProviderLabel: () => 'Codex',
        codexReasoningEffortLabel: () => '标准',
        readAgentCliProvider: () => 'codex',
        readCodexReasoningEffort: () => 'medium',
      };
    }
    if (id === '../../utils/time') return { formatChinaTime: (value) => value };
    throw new Error(`unexpected runtime import: ${id}`);
  }, module, module.exports);
  return module.exports.WorkspaceOverviewView;
}

function snapshot() {
  const totals = (inputTokens, outputTokens, cachedTokens, reasoningTokens, totalTokens) => ({
    inputTokens, outputTokens, cachedTokens, reasoningTokens, totalTokens,
  });
  return {
    requirements: [], feedback: [], plans: [], tasks: [], events: [],
    activeOperation: null, lastOperation: null,
    modelUsage: {
      cumulative: totals(1200, 300, 400, 50, 1550),
      today: totals(200, 30, 40, 5, 235),
      byProvider: [],
    },
  };
}

describe('WorkspaceOverviewView model usage regression', () => {
  it('renders formatted cumulative, today, input, output, cached, and reasoning counters', () => {
    const WorkspaceOverviewView = loadOverview();
    const html = renderToStaticMarkup(React.createElement(WorkspaceOverviewView, {
      snapshot: snapshot(), state: null, onGoTasks() {},
    }));

    assert.match(html, /aria-label="模型 Token 消耗统计"/);
    for (const text of ['累计', '今日', '输入', '输出', '缓存', '推理', '1,550', '1,200', '300', '400', '50', '235']) {
      assert.ok(html.includes(text), `missing rendered usage value: ${text}`);
    }
  });

  it('keeps desktop and narrow-screen grids bounded inside the overview card', () => {
    const css = readFileSync(join(process.cwd(), 'src', 'renderer', 'styles', 'workspace.css'), 'utf8');
    assert.match(css, /\.model-usage-card \{[^}]*min-width: 0;[^}]*overflow: hidden;/);
    assert.match(css, /\.model-usage-grid \{[^}]*repeat\(4, minmax\(0, 1fr\)\);[^}]*min-width: 0;/);
    assert.match(css, /@media \(max-width: 640px\)[\s\S]*?\.model-usage-grid \{ grid-template-columns: 1fr; \}/);
  });
});
