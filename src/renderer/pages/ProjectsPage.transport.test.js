const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { describe, it } = require('node:test');
const vm = require('node:vm');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const ts = require('typescript');

function source(...parts) {
  return readFileSync(join(process.cwd(), ...parts), 'utf8');
}

function compile(file, imports) {
  const output = ts.transpileModule(source(...file.split('/')), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
    },
    fileName: file,
  }).outputText;
  const module = { exports: {} };
  const wrapper = vm.runInThisContext(`(function (require, module, exports) { ${output}\n})`);
  wrapper((id) => {
    if (Object.prototype.hasOwnProperty.call(imports, id)) return imports[id];
    throw new Error(`unexpected runtime import: ${id}`);
  }, module, module.exports);
  return module.exports;
}

class DesktopBridgeStub {}

const provider = compile('src/renderer/lib/api/provider.tsx', {
  react: React,
  'react/jsx-runtime': require('react/jsx-runtime'),
  './client': {
    getHttpChatOperations: () => null,
    getTerminalConnectionOperations: () => null,
  },
  './transport': { getAutoplanClient: () => ({ transport: 'default-ipc' }) },
  '../desktop/ipcBridge': { IpcDesktopBridge: DesktopBridgeStub, getDefaultDesktopBridge: () => new DesktopBridgeStub() },
});

let snapshotView = { snapshot: null, error: null };

const projectsPageModule = compile('src/renderer/pages/ProjectsPage.tsx', {
  react: React,
  'react/jsx-runtime': require('react/jsx-runtime'),
  'react-router-dom': { useNavigate: () => () => {} },
  '../components/icons': { Icon: () => null },
  '../hooks/useSnapshot': {
    useSnapshot: () => ({
      ...snapshotView,
      setSnapshot: () => {},
      setError: () => {},
    }),
  },
  '../lib/api/provider': provider,
  '../components/shared': {
    planExecutionSummaryLabel: () => 'codex',
    planGenerationSummaryLabel: () => 'codex',
  },
  '../utils/workspaceForms': {
    defaultCodexReasoningEffort: 'medium',
    codexReasoningOptionDetails: [],
    planExecutionStrategyOptions: [],
    planGenerationStrategyOptions: [],
    planBackendProviderOptionsForStrategy: () => [],
    normalizeCodexReasoningEffort: (value) => value || 'medium',
    normalizePlanBackendProvider: (value) => value || 'codex',
    normalizePlanExecutionStrategy: (value) => value || 'external-cli',
    normalizePlanGenerationStrategy: (value) => value || 'external-cli-markdown',
    isBuiltinPlanExecutionStrategy: () => false,
    isBuiltinPlanGenerationStrategy: () => false,
    isCodexPlanBackendProvider: () => true,
    loadNewProjectDefaultCliPreferences: () => ({}),
    saveNewProjectDefaultCliPreferences: (value) => value,
    planBackendDefaultCommand: () => '',
    planBackendDefaultModel: () => '',
  },
  '../utils/time': { formatChinaDateTime: (value) => value },
  '../components/UpdateNotice': { UpdateNotice: () => null },
});

const { ProjectsPage } = projectsPageModule;

function project(id, running = 0) {
  return {
    id, name: `Synthetic ${id}`, workspace_path: `<fixture-workspace>/project-${id}`,
    description: `Description ${id}`, created_at: '2026-01-02T03:04:05.000Z',
    updated_at: '2026-01-02T03:04:06.000Z', running, phase: running ? 'running' : 'idle',
    interval_seconds: 5,
  };
}

function snapshot(projects) {
  return {
    activeProjectId: null, activeProject: null, projects, mcp: {}, state: null,
    requirements: [], feedback: [], attachments: [], plans: [], tasks: [], events: [], scans: [],
    scanSummary: {}, scripts: [], executors: [], terminals: [], activeOperation: null,
    activeOperations: [], lastOperation: null,
  };
}

function renderWithClient(client) {
  let observed;
  function InjectionProbe() {
    observed = provider.useAutoplanClient();
    return null;
  }
  const tree = React.createElement(
    provider.AutoplanProvider,
    { client, desktopBridge: new DesktopBridgeStub() },
    React.createElement(React.Fragment, null,
      React.createElement(InjectionProbe),
      React.createElement(ProjectsPage),
    ),
  );
  const markup = renderToStaticMarkup(tree);
  assert.strictEqual(observed, client);
  return markup;
}

describe('ProjectsPage unchanged IPC/HTTP provider contract', () => {
  const ipcClient = { transport: 'ipc' };
  const httpClient = { transport: 'http' };

  it('renders the identical project list and status summary through either injected transport', () => {
    snapshotView = { snapshot: snapshot([project(2, 1), project(1)]), error: null };
    const ipcMarkup = renderWithClient(ipcClient);
    const httpMarkup = renderWithClient(httpClient);
    assert.equal(httpMarkup, ipcMarkup);
    assert.match(httpMarkup, /Synthetic 2/);
    assert.match(httpMarkup, /&lt;fixture-workspace&gt;\/project-1/);
    assert.match(httpMarkup, />2<\/b><span>项目总数/);
    assert.match(httpMarkup, />1<\/b><span>运行中/);
  });

  it('renders identical loading, empty, and error boundaries without a component HTTP branch', () => {
    for (const view of [
      { snapshot: null, error: null },
      { snapshot: snapshot([]), error: null },
      { snapshot: null, error: 'stable transport failure' },
    ]) {
      snapshotView = view;
      assert.equal(renderWithClient(httpClient), renderWithClient(ipcClient));
    }
    snapshotView = { snapshot: null, error: 'stable transport failure' };
    assert.match(renderWithClient(httpClient), /stable transport failure/);
  });

  it('keeps the production component transport-neutral', () => {
    const pageSource = source('src/renderer/pages/ProjectsPage.tsx');
    assert.match(pageSource, /useSnapshot\(null\)/);
    assert.match(pageSource, /useAutoplanClient\(\)/);
    assert.match(pageSource, /if \(!deleting \|\| deletePending\) return/);
    assert.match(pageSource, /disabled=\{deletePending\}/);
    assert.doesNotMatch(pageSource, /HttpAutoplanClient|IpcAutoplanClient|VITE_AUTOPLAN_TRANSPORT/);
  });
});
