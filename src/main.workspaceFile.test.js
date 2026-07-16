'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { afterEach, describe, it } = require('node:test');
const { resolveFileAccessPolicy } = require('./fileAccess/policy');
const { openWorkspaceFileFromRuntime } = require('./desktop/workspaceFile');

const mainSource = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function extractFunction(source, name) {
  const start = source.indexOf(`async function ${name}(`);
  assert.notEqual(start, -1, `${name} should remain available in main.js`);
  const bodyStart = source.indexOf('{', source.indexOf(') {', start));
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`Unable to extract ${name}`);
}

function loadOpenWorkspaceFile(dependencies) {
  const source = extractFunction(mainSource, 'openWorkspaceFile');
  return vm.runInNewContext(`(() => { ${source}; return openWorkspaceFile; })()`, dependencies);
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autoplan-plan-path-'));
  temporaryDirectories.push(root);
  const workspace = path.join(root, 'workspace');
  const planPath = path.join(workspace, 'docs', 'plan', 'plan.md');
  fs.mkdirSync(path.dirname(planPath), { recursive: true });
  fs.writeFileSync(planPath, '# Plan\n');
  return { root, workspace, planPath };
}

function forbiddenDatabase() {
  const forbidden = () => {
    const error = new Error('DATABASE_NODE_SQL_FORBIDDEN');
    error.code = 'DATABASE_NODE_SQL_FORBIDDEN';
    throw error;
  };
  return { get: forbidden, getSetting: forbidden };
}

describe('plan path click runtime regression', () => {
  it('reveals plan.file_path in Go mode without consulting forbidden Node SQL', async () => {
    const { workspace, planPath } = fixture();
    const sidecarCalls = [];
    const revealed = [];
    const database = forbiddenDatabase();
    const openWorkspaceFile = loadOpenWorkspaceFile({
      isGoRuntimeMode: () => true,
      readSetting: database.getSetting,
      db: database,
      daemonSupervisor: { clientOptions: () => ({ baseUrl: 'http://sidecar.test' }) },
      sidecarProjectRequest: async (_client, route, method) => {
        sidecarCalls.push({ route, method });
        if (route === '/api/v1/projects/41') {
          return { data: { id: 41, workspace_path: workspace } };
        }
        if (route === '/api/v1/file-access-policy') {
          return { data: { scope: 'project', allow_cross_project: false, allowed_roots: [] } };
        }
        throw new Error(`unexpected sidecar route: ${route}`);
      },
      openWorkspaceFileFromRuntime,
      resolveFileAccessPolicy,
      shell: { showItemInFolder: (target) => revealed.push(target) },
    });

    const result = await openWorkspaceFile({
      projectId: 41,
      filePath: 'docs/plan/plan.md',
      mode: 'folder',
    });

    assert.equal(result.ok, true);
    assert.equal(result.mode, 'folder');
    assert.deepEqual(revealed, [await fs.promises.realpath(planPath)]);
    assert.deepEqual(sidecarCalls, [
      { route: '/api/v1/projects/41', method: 'GET' },
      { route: '/api/v1/file-access-policy', method: 'GET' },
    ]);
  });

  it('maps sidecar policy roots and keeps missing and escaping plan paths bounded', async () => {
    const { root, workspace } = fixture();
    const outside = path.join(root, 'outside.md');
    fs.writeFileSync(outside, '# Outside\n');
    const database = forbiddenDatabase();
    const openWorkspaceFile = loadOpenWorkspaceFile({
      isGoRuntimeMode: () => true,
      readSetting: database.getSetting,
      db: database,
      daemonSupervisor: { clientOptions: () => ({}) },
      sidecarProjectRequest: async (_client, route) => ({ data: route.includes('/projects/')
        ? { workspace_path: workspace }
        : { scope: 'project', allow_cross_project: false, allowed_roots: [root] } }),
      openWorkspaceFileFromRuntime,
      resolveFileAccessPolicy,
      shell: { showItemInFolder: () => { throw new Error('must not reveal invalid paths'); } },
    });

    const missing = await openWorkspaceFile({ projectId: 41, filePath: 'docs/plan/missing.md', mode: 'folder' });
    assert.deepEqual(missing, { ok: false, error: '文件不存在' });

    const escaped = await openWorkspaceFile({ projectId: 41, filePath: '../outside.md', mode: 'folder' });
    assert.equal(escaped.ok, false);
    assert.match(escaped.error, /超出允许的访问范围/);
  });

  it('preserves the Node database project, policy, and setting path', async () => {
    const { workspace, planPath } = fixture();
    const queries = [];
    const revealed = [];
    const database = {
      get(sql) {
        queries.push(sql);
        if (sql.includes('FROM settings')) return { value: 'folder' };
        if (sql.includes('FROM projects')) return { workspace_path: workspace };
        return null;
      },
      all() { return []; },
    };
    const openWorkspaceFile = loadOpenWorkspaceFile({
      isGoRuntimeMode: () => false,
      readSetting: (key) => database.get('SELECT value FROM settings WHERE key = ?', [key])?.value || '',
      db: database,
      daemonSupervisor: { clientOptions: () => { throw new Error('sidecar must not run'); } },
      sidecarProjectRequest: async () => { throw new Error('sidecar must not run'); },
      openWorkspaceFileFromRuntime,
      resolveFileAccessPolicy,
      shell: { showItemInFolder: (target) => revealed.push(target) },
    });

    const result = await openWorkspaceFile({ projectId: 41, filePath: 'docs/plan/plan.md' });

    assert.equal(result.ok, true);
    assert.equal(result.mode, 'folder');
    assert.deepEqual(revealed, [await fs.promises.realpath(planPath)]);
    assert.equal(queries.some((sql) => sql.includes('FROM settings')), true);
    assert.equal(queries.some((sql) => sql.includes('FROM projects')), true);
  });
});
