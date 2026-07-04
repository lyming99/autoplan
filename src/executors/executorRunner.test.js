const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');

// plugin 执行器通过 child_process.spawn 启动持久进程；测试用伪 spawn 注入确定性子进程，避免真实进程/时序抖动
const realSpawn = childProcess.spawn;
let fakeSpawnImpl = null;
childProcess.spawn = function injectedSpawn(command, args, options) {
  return fakeSpawnImpl ? fakeSpawnImpl(command, args, options) : realSpawn(command, args, options);
};

const {
  buildExecutorCommand,
  getPluginProcess,
  reloadPluginExecutor,
  runExecutor,
  startPluginExecutor,
  stopExecutor,
  stopPluginExecutor,
} = require('./executorRunner');

describe('buildExecutorCommand', () => {
  it('quotes process commands and args while leaving shell commands as shell text', () => {
    const processCommand = buildExecutorCommand({
      type: 'process',
      command: 'npm',
      args: ['run', { value: 'build app', quoting: 'strong' }],
    });
    const shellCommand = buildExecutorCommand({
      type: 'shell',
      command: 'npm run',
      args: ['test'],
    });

    assert.match(processCommand, /npm/);
    assert.match(processCommand, /run/);
    assert.match(processCommand, /build app/);
    assert.match(shellCommand, /^npm run/);
    assert.match(shellCommand, /test/);
  });

  it('builds a shell command from a plugin action object', () => {
    const cmd = buildExecutorCommand({ type: 'plugin' }, { command: 'flutter', args: ['run'] });
    assert.match(cmd, /flutter/);
    assert.match(cmd, /run/);
  });
});

describe('runExecutor', () => {
  it('runs a process executor through runShell with cwd, env, timeout, log, and state updates', async () => {
    const workspace = createTempWorkspace({ web: null });
    try {
      const db = createExecutorDb([
        executorRow({
          id: 1,
          label: 'build',
          type: 'process',
          command: 'npm',
          args_json: JSON.stringify(['run', { value: 'build app', quoting: 'weak' }]),
          options_json: JSON.stringify({ cwd: 'web', env: { NODE_ENV: 'test' }, timeoutMs: 1200 }),
          group_kind: 'build',
        }),
      ]);
      const service = createRunnerService({ db, workspace });

      const result = await runExecutor(service, 1, 1);

      assert.equal(result.executorId, 1);
      assert.equal(result.label, 'build');
      assert.equal(result.status, 'ok');
      assert.equal(result.exitCode, 0);
      assert.equal(result.log, 'done\n');
      assert.equal(result.logFile, 'build.log');
      assert.equal(service.runShellCalls.length, 1);
      assert.equal(service.runShellCalls[0].workspace, workspace);
      assert.match(service.runShellCalls[0].command, /npm/);
      assert.match(service.runShellCalls[0].command, /build app/);
      assert.equal(service.runShellCalls[0].label, 'executor-1-build');
      assert.equal(service.runShellCalls[0].operation.cwd, path.join(workspace, 'web'));
      assert.equal(service.runShellCalls[0].operation.timeoutMs, 1200);
      assert.equal(service.runShellCalls[0].operation.extraEnv.NODE_ENV, 'test');
      assert.equal(service.runShellCalls[0].operation.extraEnv.AUTOPLAN_EXECUTOR_ID, '1');
      assert.equal(service.runShellCalls[0].operation.extraEnv.AUTOPLAN_EXECUTOR_LABEL, 'build');
      assert.equal(service.runShellCalls[0].operation.extraEnv.AUTOPLAN_WORKSPACE, workspace);

      const updated = db._rows.find((row) => row.id === 1);
      assert.equal(updated.last_status, 'ok');
      assert.equal(updated.last_exit_code, 0);
      assert.equal(updated.last_log, 'done\n');
      assert.ok(Number(updated.last_duration_ms) >= 0);
      assert.deepEqual(service.events.map((event) => event.type), ['executor.run.started', 'executor.run.succeeded']);
      assert.equal(service.events[1].meta.executorId, 1);
      assert.equal(service.events[1].meta.logFile, 'build.log');
      assert.ok(service.emitUpdates.length >= 2);
    } finally {
      removeTempDir(workspace);
    }
  });

  it('short-circuits sequence dependencies when an earlier dependency fails', async () => {
    const workspace = createTempWorkspace({});
    try {
      const db = createExecutorDb([
        executorRow({ id: 1, label: 'prepare', command: 'npm run prepare' }),
        executorRow({ id: 2, label: 'test', command: 'npm test' }),
        executorRow({
          id: 3,
          label: 'build',
          command: 'npm run build',
          depends_on_json: JSON.stringify(['prepare', 'test']),
          depends_order: 'sequence',
        }),
      ]);
      const service = createRunnerService({
        db,
        workspace,
        shellResults: {
          1: { exitCode: 1, output: 'prepare failed\n', logFile: 'prepare.log' },
        },
      });

      const result = await runExecutor(service, 1, 3);

      assert.equal(result.status, 'bad');
      assert.equal(result.exitCode, -1);
      assert.match(result.log, /依赖执行器失败：prepare/);
      assert.deepEqual(service.runShellCalls.map((call) => call.operation.executorId), [1]);
      assert.deepEqual(result.dependencyResults.map((item) => [item.executorId, item.label, item.status]), [
        [1, 'prepare', 'bad'],
      ]);
      assert.equal(db._rows.find((row) => row.id === 2).last_status, null, 'second sequence dependency should not run');
      assert.equal(db._rows.find((row) => row.id === 3).last_status, 'bad');
      assert.equal(service.events.at(-1).type, 'executor.run.failed');
      assert.equal(service.events.at(-1).meta.dependency.failure.executorId, 1);
    } finally {
      removeTempDir(workspace);
    }
  });

  it('runs parallel dependencies before the root executor and records dependency metadata', async () => {
    const workspace = createTempWorkspace({});
    try {
      const db = createExecutorDb([
        executorRow({ id: 1, label: 'prepare', command: 'npm run prepare' }),
        executorRow({ id: 2, label: 'assets', command: 'npm run assets' }),
        executorRow({
          id: 3,
          label: 'build',
          command: 'npm run build',
          depends_on_json: JSON.stringify(['prepare', 'assets']),
          depends_order: 'parallel',
        }),
      ]);
      const service = createRunnerService({
        db,
        workspace,
        shellResults: {
          1: { exitCode: 0, output: 'prepare ok\n', logFile: 'prepare.log' },
          2: { exitCode: 0, output: 'assets ok\n', logFile: 'assets.log' },
          3: { exitCode: 0, output: 'build ok\n', logFile: 'build.log' },
        },
      });

      const result = await runExecutor(service, 1, 3);

      assert.equal(result.status, 'ok');
      assert.deepEqual(service.runShellCalls.map((call) => call.operation.executorId), [1, 2, 3]);
      assert.deepEqual(result.dependencyResults.map((item) => [item.executorId, item.label, item.status]), [
        [1, 'prepare', 'ok'],
        [2, 'assets', 'ok'],
      ]);
      const rootSuccess = service.events.find((event) => event.type === 'executor.run.succeeded' && event.meta.executorId === 3);
      assert.ok(rootSuccess, 'root executor success event should be recorded');
      assert.equal(rootSuccess.meta.dependency.results.length, 2);
      assert.deepEqual(rootSuccess.meta.dependency.results.map((item) => item.label), ['prepare', 'assets']);
      assert.equal(db._rows.find((row) => row.id === 3).last_status, 'ok');
    } finally {
      removeTempDir(workspace);
    }
  });

  it('rejects disabled executors before runShell is called', async () => {
    const workspace = createTempWorkspace({});
    try {
      const db = createExecutorDb([
        executorRow({ id: 4, label: 'disabled', command: 'npm test', enabled: 0 }),
      ]);
      const service = createRunnerService({ db, workspace });

      await assert.rejects(() => runExecutor(service, 1, 4), /执行器已禁用/);
      assert.equal(service.runShellCalls.length, 0);
    } finally {
      removeTempDir(workspace);
    }
  });
});

describe('stopExecutor', () => {
  it('stops only matching executor operations in the selected project runtime', async () => {
    const db = createExecutorDb([
      executorRow({ id: 5, label: 'watch', command: 'npm run watch' }),
    ]);
    const childA = fakeChild();
    const childB = fakeChild();
    const childScript = fakeChild();
    const runtime = {
      activeOperations: new Map([
        ['a', { operationType: 'executor', projectId: 1, executorId: 5, rootExecutorId: 5, label: 'executor-5-watch' }],
        ['b', { operationType: 'executor', projectId: 1, executorId: 8, rootExecutorId: 5, label: 'executor-8-child' }],
        ['c', { operationType: 'script', projectId: 1, scriptId: 2, label: 'script' }],
      ]),
      activeChildren: new Map([
        ['a', childA],
        ['b', childB],
        ['c', childScript],
      ]),
    };
    const service = {
      db,
      project: () => ({ id: 1, workspace_path: '' }),
      existingRuntime: () => runtime,
      emitUpdates: [],
      emitUpdate(projectId, options) {
        this.emitUpdates.push({ projectId, options });
      },
    };

    const result = await stopExecutor(service, 1, 5);

    assert.equal(result.stopped, 2);
    assert.equal(result.executorId, 5);
    assert.equal(result.label, 'watch');
    assert.equal(childA.killed, true);
    assert.equal(childB.killed, true);
    assert.equal(childScript.killed, false);
    assert.deepEqual(Array.from(runtime.activeOperations.keys()), ['c']);
    assert.equal(service.emitUpdates.length, 1);
  });
});

describe('plugin executor lifecycle', () => {
  it('starts a plugin executor child process and returns its pid', async () => {
    const workspace = createTempWorkspace({});
    let child;
    fakeSpawnImpl = () => (child = fakePluginChild({ pid: 24001 }));
    try {
      const db = createExecutorDb([
        executorRow({
          id: 20,
          label: 'dev',
          type: 'plugin',
          command: 'node',
          actions_json: JSON.stringify({ start: { type: 'command', command: 'node', args: ['server.js'] } }),
        }),
      ]);
      const service = createRunnerService({ db, workspace });
      const executor = pluginExecutor({ id: 20, actions: { start: { type: 'command', command: 'node', args: ['server.js'] } } });

      const result = await startPluginExecutor(service, pluginContext(workspace, 20), executor);

      assert.equal(result.status, 'running');
      assert.equal(result.pid, 24001);
      assert.equal(result.executorId, 20);
      assert.ok(child, '应通过 spawn 启动子进程');
      assert.equal(db._rows.find((row) => row.id === 20).last_status, 'running');
      assert.ok(service.events.some((event) => event.type === 'executor.plugin.start'));
    } finally {
      fakeSpawnImpl = null;
      removeTempDir(workspace);
    }
  });

  it('writes reload input to the running plugin process stdin', async () => {
    const workspace = createTempWorkspace({});
    let child;
    fakeSpawnImpl = () => (child = fakePluginChild({ pid: 24002 }));
    try {
      const db = createExecutorDb([
        executorRow({
          id: 21,
          label: 'dev',
          type: 'plugin',
          command: 'node',
          actions_json: JSON.stringify({
            start: { type: 'command', command: 'node', args: ['s.js'] },
            reload: { type: 'input', input: 'r' },
          }),
        }),
      ]);
      const service = createRunnerService({ db, workspace });
      const executor = pluginExecutor({
        id: 21,
        actions: {
          start: { type: 'command', command: 'node', args: ['s.js'] },
          reload: { type: 'input', input: 'r' },
        },
      });

      await startPluginExecutor(service, pluginContext(workspace, 21), executor);
      const result = await reloadPluginExecutor(service, pluginContext(workspace, 21), executor);

      assert.equal(result.status, 'running');
      assert.ok(
        child.stdin.writes.join('').includes('r'),
        '应向运行中进程 stdin 写入 reload 输入',
      );
      assert.ok(service.events.some((event) => event.type === 'executor.plugin.reload'));
    } finally {
      fakeSpawnImpl = null;
      removeTempDir(workspace);
    }
  });

  it('stops a plugin executor via the configured stop command then SIGTERM', async () => {
    const workspace = createTempWorkspace({});
    let child;
    fakeSpawnImpl = () => (child = fakePluginChild({ pid: 24003 }));
    try {
      const db = createExecutorDb([
        executorRow({
          id: 22,
          label: 'dev',
          type: 'plugin',
          command: 'node',
          actions_json: JSON.stringify({
            start: { type: 'command', command: 'node', args: ['s.js'] },
            stop: { type: 'command', command: 'curl', args: ['-X', 'POST', 'http://x/stop'] },
          }),
        }),
      ]);
      const service = createRunnerService({ db, workspace });
      const executor = pluginExecutor({
        id: 22,
        actions: {
          start: { type: 'command', command: 'node', args: ['s.js'] },
          stop: { type: 'command', command: 'curl', args: ['-X', 'POST', 'http://x/stop'] },
        },
      });

      await startPluginExecutor(service, pluginContext(workspace, 22), executor);
      const result = await stopPluginExecutor(service, pluginContext(workspace, 22), executor);

      assert.equal(result.status, 'stopped');
      assert.equal(result.stopped, true);
      assert.ok(
        service.runShellCalls.some((call) => /curl/.test(call.command)),
        '应执行配置的 stop 命令',
      );
      assert.ok(child.signals.includes('SIGTERM'), '应发送 SIGTERM 终止进程');
      assert.equal(child.signals.includes('SIGKILL'), false, 'SIGTERM 生效后不应升级到 SIGKILL');
    } finally {
      fakeSpawnImpl = null;
      removeTempDir(workspace);
    }
  });

  it('escalates from SIGTERM to SIGKILL when the plugin process ignores SIGTERM', async () => {
    if (process.platform === 'win32') return; // Windows 强杀走 taskkill，伪子进程不适用
    const workspace = createTempWorkspace({});
    let child;
    fakeSpawnImpl = () => (child = fakePluginChild({ pid: 24004, ignoreSigterm: true, markKilledOnIgnoredSigterm: true }));
    try {
      const db = createExecutorDb([
        executorRow({
          id: 23,
          label: 'dev',
          type: 'plugin',
          command: 'node',
          actions_json: JSON.stringify({ start: { type: 'command', command: 'node', args: ['s.js'] } }),
        }),
      ]);
      const service = createRunnerService({ db, workspace });
      const executor = pluginExecutor({ id: 23, actions: { start: { type: 'command', command: 'node', args: ['s.js'] } } });

      await startPluginExecutor(service, pluginContext(workspace, 23), executor);
      const result = await stopPluginExecutor(service, pluginContext(workspace, 23), executor);

      assert.equal(result.status, 'stopped');
      assert.equal(result.stopped, true);
      assert.ok(child.signals.includes('SIGTERM'), '应先尝试 SIGTERM');
      assert.ok(child.signals.includes('SIGKILL'), '即使 child.killed=true 但未退出，也应升级到 SIGKILL');
    } finally {
      fakeSpawnImpl = null;
      removeTempDir(workspace);
    }
  });
});

function executorRow(overrides = {}) {
  return {
    id: overrides.id || 1,
    project_id: overrides.project_id || 1,
    label: overrides.label || 'executor',
    type: overrides.type || 'shell',
    command: overrides.command || 'echo ok',
    args_json: overrides.args_json || '[]',
    actions_json: overrides.actions_json ?? null,
    plugin_state_json: overrides.plugin_state_json ?? null,
    options_json: overrides.options_json || '{}',
    group_kind: overrides.group_kind || null,
    group_is_default: overrides.group_is_default || 0,
    presentation_json: overrides.presentation_json || '{}',
    problem_matcher_json: overrides.problem_matcher_json || null,
    depends_on_json: overrides.depends_on_json || '[]',
    depends_order: overrides.depends_order || 'parallel',
    enabled: overrides.enabled ?? 1,
    sort_order: overrides.sort_order || 0,
    last_status: overrides.last_status || null,
    last_exit_code: overrides.last_exit_code ?? null,
    last_duration_ms: overrides.last_duration_ms ?? null,
    last_log: overrides.last_log || null,
    last_run_at: overrides.last_run_at || null,
    created_at: overrides.created_at || '2026-07-03T00:00:00.000Z',
    updated_at: overrides.updated_at || '2026-07-03T00:00:00.000Z',
  };
}

function createExecutorDb(rows) {
  const db = {
    _rows: rows.map((row) => ({ ...row })),
    all(sql, params = []) {
      if (sql.includes('FROM executors')) {
        const projectId = Number(params[0]);
        return db._rows
          .filter((row) => Number(row.project_id) === projectId)
          .sort((left, right) => Number(left.sort_order || 0) - Number(right.sort_order || 0) || Number(left.id) - Number(right.id))
          .map((row) => ({ ...row }));
      }
      return [];
    },
    get(sql, params = []) {
      if (sql.includes('FROM executors')) {
        const [executorId, projectId] = params;
        const row = db._rows.find((item) => Number(item.id) === Number(executorId) && Number(item.project_id) === Number(projectId));
        return row ? { ...row } : null;
      }
      return null;
    },
    run(sql, params = []) {
      if (!sql.includes('UPDATE executors SET')) return;
      const id = Number(params.at(-2));
      const projectId = Number(params.at(-1));
      const row = db._rows.find((item) => Number(item.id) === id && Number(item.project_id) === projectId);
      if (!row) return;
      const assignmentText = sql.slice(sql.indexOf('SET') + 3, sql.indexOf('WHERE')).trim();
      const columns = assignmentText.split(',').map((part) => part.trim().split(/\s*=\s*/)[0]);
      columns.forEach((column, index) => {
        row[column] = params[index];
      });
    },
  };
  return db;
}

function createRunnerService({ db, workspace, shellResults = {} }) {
  return {
    db,
    runShellCalls: [],
    events: [],
    emitUpdates: [],
    project(projectId) {
      return Number(projectId) === 1 ? { id: 1, workspace_path: workspace } : null;
    },
    activeProjectForWorkspace() {
      return null;
    },
    ensureWorkspaceDirs(value) {
      fs.mkdirSync(path.join(value, 'docs', 'progress', 'logs'), { recursive: true });
    },
    async runShell(workspaceArg, command, label, operation) {
      this.runShellCalls.push({ workspace: workspaceArg, command, label, operation });
      const result = shellResults[operation.executorId] || { exitCode: 0, output: 'done\n', logFile: 'build.log' };
      return { ...result };
    },
    addEvent(projectId, type, message, meta) {
      this.events.push({ projectId, type, message, meta });
    },
    emitUpdate(projectId, options = {}) {
      this.emitUpdates.push({ projectId, options });
    },
    snapshot(projectId) {
      return { activeProjectId: projectId, executors: db._rows.map((row) => ({ ...row })) };
    },
  };
}

function fakeChild() {
  return {
    killed: false,
    exitCode: null,
    signalCode: null,
    kill() {
      this.killed = true;
    },
  };
}

/** 伪 plugin 子进程：记录 kill 信号/stdin 写入；SIGTERM/SIGKILL 后异步 emit exit */
function fakePluginChild({ pid = 24001, ignoreSigterm = false, markKilledOnIgnoredSigterm = false } = {}) {
  const child = new EventEmitter();
  child.pid = pid;
  child.killed = false;
  child.exitCode = null;
  child.signalCode = null;
  child.signals = [];
  child.stdin = {
    destroyed: false,
    writes: [],
    write(chunk) {
      this.writes.push(String(chunk));
      return true;
    },
    end() {
      this.destroyed = true;
    },
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = (signal) => {
    child.signals.push(signal);
    if (signal === 'SIGKILL') {
      child.killed = true;
      setImmediate(() => child.emit('exit', null, 'SIGKILL'));
    } else if (signal === 'SIGTERM' && !ignoreSigterm) {
      child.killed = true;
      setImmediate(() => child.emit('exit', 0, 'SIGTERM'));
    } else if (signal === 'SIGTERM' && markKilledOnIgnoredSigterm) {
      child.killed = true;
    }
    return true;
  };
  return child;
}

function pluginContext(workspace, executorId) {
  return {
    projectId: 1,
    workspace,
    rootExecutorId: executorId,
    rootExecutorLabel: 'dev',
    executorRunId: `plugin-test-${executorId}`,
  };
}

function pluginExecutor({ id = 20, label = 'dev', actions = {}, command = 'node' } = {}) {
  return {
    id,
    projectId: 1,
    label,
    type: 'plugin',
    command,
    args: [],
    options: { cwd: '', env: {} },
    actions,
    enabled: true,
    group: { kind: null, isDefault: false },
    dependsOn: [],
    dependsOrder: 'parallel',
    presentation: {},
    problemMatcher: null,
    running: false,
    runStatus: 'idle',
  };
}

function createTempWorkspace(entries) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoplan-executor-runner-'));
  for (const [name, content] of Object.entries(entries)) {
    const target = path.join(dir, name);
    if (content === null) {
      fs.mkdirSync(target, { recursive: true });
    } else {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content, 'utf8');
    }
  }
  return dir;
}

function removeTempDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
}
