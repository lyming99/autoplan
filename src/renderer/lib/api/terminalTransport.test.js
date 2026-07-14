'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { it } = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

function loadTerminalTransport() {
  const source = readFileSync(join(process.cwd(), 'src', 'renderer', 'lib', 'api', 'terminalTransport.ts'), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: 'terminalTransport.ts',
  }).outputText;
  const module = { exports: {} };
  const wrapper = vm.runInThisContext(`(function (require, module, exports) { ${compiled}\n})`);
  wrapper((id) => {
    if (id === './terminalSocket') return { TerminalSocket: class {} };
    throw new Error(`unexpected import: ${id}`);
  }, module, module.exports);
  return module.exports;
}

function restSession(overrides = {}) {
  return {
    id: 'term_fixture01', project_id: 7, title: 'Terminal', cwd: 'C:\\fixture', shell: 'cmd.exe',
    status: 'running', created_at: '2026-07-14T00:00:00.000Z', ended_at: null, exit_code: null,
    cols: 80, rows: 24, closed: false,
    profile: { id: 'default', name: 'Default', kind: 'default', shell_path: 'cmd.exe', args: [] },
    ...overrides,
  };
}

it('routes every terminal control method through the Go owner after creation', async () => {
  const { TerminalTransport } = loadTerminalTransport();
  const calls = [];
  let session = restSession();
  const control = {};
  for (const method of ['create', 'list', 'write', 'resize', 'kill', 'close', 'rename', 'clear', 'replay']) {
    control[method] = async (...args) => {
      calls.push([method, ...args]);
      if (method === 'list') return [session];
      if (method === 'replay') return { session, entries: [{ seq: 1, data: 'ok' }], last_seq: 1 };
      if (method === 'rename') session = restSession({ title: args[2] });
      if (method === 'close') session = restSession({ status: 'closed', closed: true });
      return session;
    };
  }
  const unexpected = (name) => async () => { throw new Error(`legacy ${name} called`); };
  const legacy = {
    createTerminal: unexpected('create'),
    listTerminals: async () => ({ ok: true, sessions: [] }),
    writeTerminal: unexpected('write'), resizeTerminal: unexpected('resize'),
    killTerminal: unexpected('kill'), closeTerminal: unexpected('close'),
    renameTerminal: unexpected('rename'), replayTerminal: unexpected('replay'), clearTerminal: unexpected('clear'),
  };
  const transport = new TerminalTransport({ enabled: true, legacy, control, baseUrl: 'http://127.0.0.1:43123' });
  const created = await transport.create({ projectId: 7, cwd: 'C:\\fixture', cols: 80, rows: 24 });
  assert.equal(created.ok, true);
  await transport.list({ projectId: 7 });
  await transport.write({ sessionId: session.id, data: 'dir\r' });
  await transport.resize({ sessionId: session.id, cols: 120, rows: 40 });
  await transport.kill({ sessionId: session.id });
  await transport.rename({ sessionId: session.id, title: 'Renamed' });
  await transport.clear({ sessionId: session.id });
  const replay = await transport.replay({ sessionId: session.id });
  assert.equal(replay.data, 'ok');
  await transport.close({ sessionId: session.id });
  assert.deepEqual(calls.map((call) => call[0]), [
    'create', 'list', 'write', 'resize', 'kill', 'rename', 'clear', 'replay', 'close',
  ]);
  assert.deepEqual(calls[2].slice(1), [7, session.id, 'dir\r']);
  assert.deepEqual(calls[3].slice(1), [7, session.id, 120, 40]);
});
