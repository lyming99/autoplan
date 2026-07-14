'use strict';

const assert = require('node:assert/strict');
const { it } = require('node:test');
const { openProjectFolderFromRuntime } = require('./projectFolder');

it('opens a Go-owned project without touching the blocked Node database', async () => {
  const opened = [];
  const result = await openProjectFolderFromRuntime({
    projectId: 7,
    goRuntime: true,
    database: { get: () => { throw new Error('NODE_SQL_FORBIDDEN'); } },
    loadGoProject: async (projectId) => ({ id: projectId, workspace_path: 'D:\\fixture' }),
    shell: { openPath: async (path) => { opened.push(path); return ''; } },
  });
  assert.deepEqual(result, { ok: true, error: null });
  assert.deepEqual(opened, ['D:\\fixture']);
});

it('preserves the legacy read path and returns bounded errors', async () => {
  const missing = await openProjectFolderFromRuntime({
    projectId: 8,
    goRuntime: false,
    database: { get: () => null },
    loadGoProject: async () => { throw new Error('must not run'); },
    shell: { openPath: async () => { throw new Error('must not run'); } },
  });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /工作区路径为空/);
});
