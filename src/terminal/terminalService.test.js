'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { TerminalService, resolveTerminalCwd } = require('./terminalService');
const {
  DEFAULT_TERMINAL_SETTINGS,
  defaultTerminalProfile,
  normalizeTerminalCreateInput,
  normalizeTerminalProfile,
  normalizeTerminalSettings,
  saveTerminalSettingsToDb,
  terminalCreateInputFromSettings,
  terminalSettingsFromDb,
} = require('./terminalConfig');
const {
  TERMINAL_ERROR_CODES,
  TERMINAL_STATUS,
} = require('./terminalTypes');

function createTempWorkspace(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoplan-terminal-'));
  for (const [name, content] of Object.entries(files)) {
    const filePath = path.join(dir, name);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
  }
  return dir;
}

function removeTempDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore cleanup errors */
  }
}

class FakePty {
  constructor() {
    this.writes = [];
    this.resizes = [];
    this.killed = false;
    this.dataHandlers = new Set();
    this.exitHandlers = new Set();
  }

  onData(handler) {
    this.dataHandlers.add(handler);
    return { dispose: () => this.dataHandlers.delete(handler) };
  }

  onExit(handler) {
    this.exitHandlers.add(handler);
    return { dispose: () => this.exitHandlers.delete(handler) };
  }

  write(data) {
    this.writes.push(data);
  }

  resize(cols, rows) {
    this.resizes.push({ cols, rows });
  }

  kill() {
    this.killed = true;
    this.emitExit({ exitCode: null, signal: 'SIGTERM' });
  }

  emitData(data) {
    for (const handler of [...this.dataHandlers]) handler(data);
  }

  emitExit(event) {
    for (const handler of [...this.exitHandlers]) handler(event);
  }
}

function createPtyFactory() {
  const spawns = [];
  return {
    spawns,
    spawn(shell, args, options) {
      const pty = new FakePty();
      spawns.push({ shell, args, options, pty });
      return pty;
    },
  };
}

function fixedClock() {
  let index = 0;
  return () => `2026-07-03T00:00:0${index++}.000Z`;
}

describe('terminalConfig', () => {
  it('按平台归一默认 profile，并允许 custom profile 覆盖 shell/args/env', () => {
    const posix = defaultTerminalProfile({
      platform: 'linux',
      env: { SHELL: '/bin/zsh' },
    });
    assert.equal(posix.shellPath, '/bin/zsh');
    assert.equal(posix.name, 'zsh');

    const custom = normalizeTerminalProfile({
      id: 'Dev Shell',
      kind: 'custom',
      shellPath: '/usr/bin/fish',
      args: ['--login'],
      env: { A: 1, EMPTY: null },
    }, { platform: 'linux', env: { SHELL: '/bin/bash' } });

    assert.equal(custom.id, 'dev-shell');
    assert.equal(custom.kind, 'custom');
    assert.equal(custom.shellPath, '/usr/bin/fish');
    assert.deepEqual(custom.args, ['--login']);
    assert.deepEqual(custom.env, { A: '1', EMPTY: '' });
  });

  it('归一创建参数：尺寸、标题、scrollback 和 env 都有边界', () => {
    const input = normalizeTerminalCreateInput({
      cols: 9999,
      rows: 0,
      title: '  Dev Terminal  ',
      scrollbackLimit: 1,
      env: { NODE_ENV: 'test' },
    });

    assert.equal(input.cols, 500);
    assert.equal(input.rows, 1);
    assert.equal(input.title, 'Dev Terminal');
    assert.equal(input.scrollbackLimit, 100);
    assert.deepEqual(input.env, { NODE_ENV: 'test' });
  });

  it('归一终端设置：默认 profile、初始 cwd、字号、scrollback 与布尔项有稳定边界', () => {
    const settings = normalizeTerminalSettings({
      'terminal.defaultProfile': 'Power Shell!',
      'terminal.initialCwd': '  packages/app  ',
      'terminal.fontSize': 99,
      'terminal.scrollbackLimit': 1,
      'terminal.retainOnExit': 'off',
      'terminal.confirmBeforeKill': 'false',
    });

    assert.equal(settings.defaultProfile, 'power-shell');
    assert.equal(settings.initialCwd, 'packages/app');
    assert.equal(settings.fontSize, 24);
    assert.equal(settings.scrollbackLimit, 100);
    assert.equal(settings.retainOnExit, false);
    assert.equal(settings.confirmBeforeKill, false);
  });

  it('可通过 settings 表读取全局默认并叠加项目级终端设置', () => {
    const values = new Map([
      ['terminal.defaultProfile', 'default'],
      ['terminal.initialCwd', ''],
      ['terminal.fontSize', '13'],
      ['terminal.scrollbackLimit', '10000'],
      ['terminal.retainOnExit', 'true'],
      ['terminal.confirmBeforeKill', 'true'],
      ['terminal.project.7.defaultProfile', 'bash'],
      ['terminal.project.7.initialCwd', 'apps/web'],
      ['terminal.project.7.fontSize', '15'],
    ]);
    const db = {
      getSettings(prefix = '') {
        return Object.fromEntries([...values.entries()].filter(([key]) => key.startsWith(prefix)));
      },
      setSetting(key, value) {
        values.set(key, String(value));
      },
    };

    const globalSettings = terminalSettingsFromDb(db);
    assert.deepEqual(globalSettings, DEFAULT_TERMINAL_SETTINGS);

    const projectSettings = terminalSettingsFromDb(db, { projectId: 7 });
    assert.equal(projectSettings.defaultProfile, 'bash');
    assert.equal(projectSettings.initialCwd, 'apps/web');
    assert.equal(projectSettings.fontSize, 15);
    assert.equal(projectSettings.scrollbackLimit, 10000);
    assert.equal(projectSettings.confirmBeforeKill, true);

    const saved = saveTerminalSettingsToDb(db, {
      defaultProfile: 'cmd',
      initialCwd: 'tools',
      fontSize: 12,
      scrollbackLimit: 500,
      retainOnExit: false,
      confirmBeforeKill: true,
    }, { projectId: 7 });
    assert.equal(saved.defaultProfile, 'cmd');
    assert.equal(values.get('terminal.project.7.defaultProfile'), 'cmd');
    assert.equal(values.get('terminal.project.7.retainOnExit'), 'false');
  });

  it('从终端设置构造 create input 时只合并显式安全字段，不改变可见命令执行语义', () => {
    const payload = terminalCreateInputFromSettings({
      defaultProfile: 'bash',
      initialCwd: 'apps/api',
      scrollbackLimit: 2000,
      retainOnExit: false,
    }, {
      title: 'API shell',
    });

    assert.equal(payload.cwd, 'apps/api');
    assert.equal(payload.profileId, 'bash');
    assert.equal(payload.scrollbackLimit, 2000);
    assert.equal(payload.retainOnExit, false);
    assert.equal(payload.title, 'API shell');

    const explicit = terminalCreateInputFromSettings({ defaultProfile: 'bash', initialCwd: 'apps/api' }, {
      cwd: 'tools',
      profileId: 'cmd',
      retainOnExit: true,
    });
    assert.equal(explicit.cwd, 'tools');
    assert.equal(explicit.profileId, 'cmd');
    assert.equal(explicit.retainOnExit, true);
  });
});

describe('resolveTerminalCwd', () => {
  it('默认 cwd 指向项目工作区，工作区内相对路径被解析为 realpath', () => {
    const ws = createTempWorkspace({});
    const child = path.join(ws, 'packages', 'app');
    fs.mkdirSync(child, { recursive: true });
    try {
      const root = resolveTerminalCwd(ws);
      assert.equal(root.ok, true);
      assert.equal(root.cwd, fs.realpathSync(ws));

      const nested = resolveTerminalCwd(ws, 'packages/app');
      assert.equal(nested.ok, true);
      assert.equal(nested.cwd, fs.realpathSync(child));
    } finally {
      removeTempDir(ws);
    }
  });

  it('拒绝工作区外 cwd，不创建 PTY', () => {
    const ws = createTempWorkspace({});
    const outside = createTempWorkspace({});
    try {
      const result = resolveTerminalCwd(ws, outside);
      assert.equal(result.ok, false);
      assert.equal(result.code, TERMINAL_ERROR_CODES.CWD_OUTSIDE_WORKSPACE);
      assert.match(result.message, /工作区内/);
    } finally {
      removeTempDir(ws);
      removeTempDir(outside);
    }
  });

  it('符号链接指向工作区外时拒绝', (t) => {
    const ws = createTempWorkspace({});
    const outside = createTempWorkspace({});
    const link = path.join(ws, 'outside-link');
    try {
      try {
        fs.symlinkSync(outside, link, 'dir');
      } catch (error) {
        t.skip(`当前环境无法创建符号链接：${error.code || error.message}`);
        return;
      }
      const result = resolveTerminalCwd(ws, link);
      assert.equal(result.ok, false);
      assert.equal(result.code, TERMINAL_ERROR_CODES.CWD_OUTSIDE_WORKSPACE);
    } finally {
      removeTempDir(ws);
      removeTempDir(outside);
    }
  });
});

describe('TerminalService', () => {
  it('创建、列出、写入、resize、重命名、replay 和退出状态都不暴露 PTY 对象', () => {
    const ws = createTempWorkspace({});
    const factory = createPtyFactory();
    const service = new TerminalService({
      ptyFactory: factory,
      env: { SHELL: '/bin/bash', TERM_PROGRAM: 'autoplan-test' },
      platform: 'linux',
      now: fixedClock(),
      idFactory: () => 'term_fixed123',
    });
    const events = { status: [], data: [], exit: [] };
    service.on('status', (event) => events.status.push(event));
    service.on('data', (event) => events.data.push(event));
    service.on('exit', (event) => events.exit.push(event));

    try {
      const created = service.createSession({ id: 'p1', workspace_path: ws }, {
        title: 'Main',
        cols: 100,
        rows: 30,
        profile: { shellPath: '/bin/bash', args: ['-l'] },
        env: { EXTRA: '1' },
      });

      assert.equal(created.ok, true);
      assert.equal(created.session.id, 'term_fixed123');
      assert.equal(created.session.status, TERMINAL_STATUS.RUNNING);
      assert.equal(created.session.pty, undefined);
      assert.equal(events.status[0].sessionId, 'term_fixed123');
      assert.equal(factory.spawns[0].shell, '/bin/bash');
      assert.deepEqual(factory.spawns[0].args, ['-l']);
      assert.equal(factory.spawns[0].options.cwd, fs.realpathSync(ws));
      assert.equal(factory.spawns[0].options.cols, 100);
      assert.equal(factory.spawns[0].options.env.EXTRA, '1');

      assert.equal(service.listSessions('p1').length, 1);

      const written = service.write('term_fixed123', 'echo ok\r');
      assert.equal(written.ok, true);
      assert.deepEqual(factory.spawns[0].pty.writes, ['echo ok\r']);

      const resized = service.resize('term_fixed123', 120, 40);
      assert.equal(resized.ok, true);
      assert.deepEqual(factory.spawns[0].pty.resizes, [{ cols: 120, rows: 40 }]);

      const renamed = service.rename('term_fixed123', 'Renamed');
      assert.equal(renamed.session.title, 'Renamed');

      factory.spawns[0].pty.emitData('hello');
      assert.deepEqual(service.replay('term_fixed123').chunks, ['hello']);
      assert.equal(events.data[0].data, 'hello');

      factory.spawns[0].pty.emitExit({ exitCode: 7, signal: null });
      const exited = service.listSessions('p1')[0];
      assert.equal(exited.status, TERMINAL_STATUS.EXITED);
      assert.equal(exited.exitCode, 7);
      assert.ok(exited.endedAt);
      assert.equal(events.exit[0].exitCode, 7);
    } finally {
      service.disposeAll();
      removeTempDir(ws);
    }
  });

  it('拒绝越界 cwd 时不调用 pty.spawn', () => {
    const ws = createTempWorkspace({});
    const outside = createTempWorkspace({});
    const factory = createPtyFactory();
    const service = new TerminalService({ ptyFactory: factory });
    try {
      const result = service.createSession({ id: 'p1', workspace_path: ws }, { cwd: outside });
      assert.equal(result.ok, false);
      assert.equal(result.code, TERMINAL_ERROR_CODES.CWD_OUTSIDE_WORKSPACE);
      assert.equal(factory.spawns.length, 0);
    } finally {
      removeTempDir(ws);
      removeTempDir(outside);
    }
  });

  it('scrollback 有上限，长时间输出不会无限增长', () => {
    const ws = createTempWorkspace({});
    const factory = createPtyFactory();
    const service = new TerminalService({
      ptyFactory: factory,
      env: { SHELL: '/bin/sh' },
      platform: 'linux',
      idFactory: () => 'term_scroll',
    });
    try {
      const created = service.createSession({ id: 'p1', workspace_path: ws }, { scrollbackLimit: 100 });
      assert.equal(created.ok, true);
      for (let index = 0; index < 105; index += 1) factory.spawns[0].pty.emitData(`line-${index}\n`);
      const replay = service.replay('term_scroll');
      assert.equal(replay.chunks.length, 100);
      assert.equal(replay.chunks[0], 'line-5\n');
      assert.equal(replay.chunks[99], 'line-104\n');
    } finally {
      service.disposeAll();
      removeTempDir(ws);
    }
  });

  it('kill、disposeProject、disposeAll 会终止对应 PTY 并清理服务侧会话', () => {
    const ws1 = createTempWorkspace({});
    const ws2 = createTempWorkspace({});
    const factory = createPtyFactory();
    const service = new TerminalService({
      ptyFactory: factory,
      idFactory: (() => {
        const ids = ['term_one', 'term_two', 'term_three'];
        return () => ids.shift();
      })(),
    });

    try {
      service.createSession({ id: 'p1', workspace_path: ws1 });
      service.createSession({ id: 'p1', workspace_path: ws1 });
      service.createSession({ id: 'p2', workspace_path: ws2 });

      const killed = service.kill('term_one');
      assert.equal(killed.ok, true);
      assert.equal(killed.session.status, TERMINAL_STATUS.KILLED);
      assert.equal(factory.spawns[0].pty.killed, true);

      const closed = service.close('term_two');
      assert.equal(closed.ok, true);
      assert.equal(closed.closed, true);
      assert.equal(factory.spawns[1].pty.killed, true);
      assert.equal(service.listSessions('p1').some((session) => session.id === 'term_two'), false);

      const disposedProject = service.disposeProject('p1');
      assert.equal(disposedProject.count, 1);
      assert.deepEqual(service.listSessions('p1'), []);
      assert.equal(service.listSessions('p2').length, 1);

      const disposedAll = service.disposeAll();
      assert.equal(disposedAll.count, 1);
      assert.deepEqual(service.listSessions('p2'), []);
      assert.equal(factory.spawns[2].pty.killed, true);
    } finally {
      removeTempDir(ws1);
      removeTempDir(ws2);
    }
  });

  it('node-pty 加载或启动失败时返回结构化错误，不抛出导致应用崩溃', () => {
    const ws = createTempWorkspace({});
    const unavailable = new TerminalService({
      ptyLoader() {
        throw new Error('native binding missing');
      },
    });
    const spawnFailure = new TerminalService({
      ptyFactory: {
        spawn() {
          throw new Error('spawn failed');
        },
      },
    });

    try {
      const loadResult = unavailable.createSession({ id: 'p1', workspace_path: ws });
      assert.equal(loadResult.ok, false);
      assert.equal(loadResult.code, TERMINAL_ERROR_CODES.PTY_UNAVAILABLE);
      assert.match(loadResult.message, /终端能力不可用/);
      assert.match(loadResult.details, /native binding missing/);

      const spawnResult = spawnFailure.createSession({ id: 'p1', workspace_path: ws });
      assert.equal(spawnResult.ok, false);
      assert.equal(spawnResult.code, TERMINAL_ERROR_CODES.PTY_UNAVAILABLE);
      assert.match(spawnResult.details, /spawn failed/);
    } finally {
      removeTempDir(ws);
    }
  });

  it('无效项目、未知 session、超长输入返回结构化错误', () => {
    const factory = createPtyFactory();
    const service = new TerminalService({ ptyFactory: factory });
    const missingWorkspace = path.join(os.tmpdir(), `missing-terminal-ws-${Date.now()}-${Math.random()}`);
    fs.rmSync(missingWorkspace, { recursive: true, force: true });
    const invalidProject = service.createSession({ id: 'p1', workspace_path: missingWorkspace });
    assert.equal(invalidProject.ok, false);
    assert.equal(invalidProject.code, TERMINAL_ERROR_CODES.INVALID_PROJECT);

    const missing = service.write('missing', 'x');
    assert.equal(missing.ok, false);
    assert.equal(missing.code, TERMINAL_ERROR_CODES.SESSION_NOT_FOUND);
    const badDispose = service.disposeProject('');
    assert.equal(badDispose.ok, false);
    assert.equal(badDispose.code, TERMINAL_ERROR_CODES.INVALID_PROJECT);

    const ws = createTempWorkspace({});
    try {
      const created = service.createSession({ id: 'p1', workspace_path: ws });
      assert.equal(created.ok, true);
      const tooLarge = service.write(created.session.id, 'x'.repeat(70000));
      assert.equal(tooLarge.ok, false);
      assert.equal(tooLarge.code, TERMINAL_ERROR_CODES.INVALID_PAYLOAD);
    } finally {
      service.disposeAll();
      removeTempDir(ws);
    }
  });
});
