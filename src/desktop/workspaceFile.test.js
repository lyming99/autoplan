'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, describe, it } = require('node:test');
const {
  materializeFileAccessPolicy,
  openWorkspaceFileFromRuntime,
  resolveWorkspaceFilePath,
} = require('./workspaceFile');

const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autoplan-workspace-file-'));
  temporaryDirectories.push(root);
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace);
  const file = path.join(workspace, 'docs', 'plan.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '# Plan');
  return { root, workspace, file };
}

function dependencies(workspace, overrides = {}) {
  return {
    projectId: 7,
    filePath: 'docs/plan.md',
    loadProject: async () => ({ workspace_path: workspace }),
    loadFilePolicy: async () => ({
      scope: 'project', allow_cross_project: false, allowed_roots: [],
    }),
    shell: { openPath: async () => '', showItemInFolder: () => {} },
    ...overrides,
  };
}

describe('runtime workspace file opener', () => {
  it('opens a regular workspace file with the system shell', async () => {
    const { workspace, file } = fixture();
    const opened = [];
    const result = await openWorkspaceFileFromRuntime(dependencies(workspace, {
      shell: { openPath: async (target) => { opened.push(target); return ''; } },
    }));
    assert.equal(result.ok, true);
    assert.equal(result.mode, 'system');
    assert.deepEqual(opened, [await fs.promises.realpath(file)]);
  });

  it('reveals the file in folder mode', async () => {
    const { workspace, file } = fixture();
    const opened = [];
    const result = await openWorkspaceFileFromRuntime(dependencies(workspace, {
      mode: 'folder',
      shell: { showItemInFolder: (target) => opened.push(target) },
    }));
    assert.equal(result.ok, true);
    assert.deepEqual(opened, [await fs.promises.realpath(file)]);
  });

  it('launches vscode and command modes with the resolved file', async () => {
    const { workspace, file } = fixture();
    const calls = [];
    const spawn = (command, args, options) => {
      calls.push({ command, args, options });
      const child = new EventEmitter();
      child.unref = () => {};
      process.nextTick(() => child.emit('spawn'));
      return child;
    };
    assert.equal((await openWorkspaceFileFromRuntime(dependencies(workspace, {
      mode: 'vscode', command: 'cursor', spawn, platform: 'linux',
    }))).ok, true);
    assert.equal((await openWorkspaceFileFromRuntime(dependencies(workspace, {
      mode: 'command', command: 'editor --open {file}', spawn, platform: 'linux',
    }))).ok, true);
    const realFile = await fs.promises.realpath(file);
    assert.deepEqual(calls[0].args, [realFile]);
    assert.equal(calls[1].args.length, 0);
    assert.match(calls[1].command, /editor --open/);
    assert.equal(calls[1].options.shell, true);
  });

  it('rejects lexical escapes, missing files, and directories', async () => {
    const { root, workspace } = fixture();
    const policy = materializeFileAccessPolicy({ scope: 'project' }, workspace);
    await assert.rejects(
      resolveWorkspaceFilePath(workspace, path.join('..', path.basename(root), 'outside.md'), policy),
      /超出允许的访问范围/,
    );
    const missing = await openWorkspaceFileFromRuntime(dependencies(workspace, { filePath: 'missing.md' }));
    assert.deepEqual(missing, { ok: false, error: '文件不存在' });
    const directory = await openWorkspaceFileFromRuntime(dependencies(workspace, { filePath: 'docs' }));
    assert.deepEqual(directory, { ok: false, error: '路径指向目录，不能作为文件打开' });
  });

  it('rejects a symlink that escapes the loaded policy', async (context) => {
    const { root, workspace } = fixture();
    const outside = path.join(root, 'outside.md');
    const link = path.join(workspace, 'escape.md');
    fs.writeFileSync(outside, 'outside');
    try {
      fs.symlinkSync(outside, link, 'file');
    } catch (error) {
      context.skip(`symlinks unavailable: ${error.code}`);
      return;
    }
    const result = await openWorkspaceFileFromRuntime(dependencies(workspace, { filePath: 'escape.md' }));
    assert.equal(result.ok, false);
    assert.match(result.error, /超出允许的访问范围/);
  });

  it('maps sidecar policy fields without consulting another data source', async () => {
    const { root, workspace } = fixture();
    const extra = path.join(root, 'extra');
    fs.mkdirSync(extra);
    const policy = materializeFileAccessPolicy({
      scope: 'custom', allow_cross_project: true, allowed_roots: [extra],
    }, workspace);
    assert.equal(policy.allowCrossProject, true);
    assert.equal(policy.effectiveRoots.length, 2);
    assert.equal(policy.effectiveRoots.some((entry) => path.resolve(entry) === path.resolve(extra)), true);
  });
});
