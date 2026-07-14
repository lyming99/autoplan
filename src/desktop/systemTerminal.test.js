const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { openSystemTerminal, terminalCandidates } = require('./systemTerminal');

test('Windows terminal prefers Windows Terminal and keeps the project cwd', async () => {
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.unref = () => {};
    process.nextTick(() => child.emit('spawn'));
    return child;
  };
  const result = await openSystemTerminal(__dirname, { platform: 'win32', spawn, env: {} });
  assert.deepEqual(result, { ok: true, error: null });
  assert.equal(calls[0].command, 'wt.exe');
  assert.equal(calls[0].options.cwd, await require('node:fs').promises.realpath(__dirname));
  assert.equal(calls[0].options.windowsHide, false);
});

test('Windows terminal has a cmd fallback', () => {
  const candidates = terminalCandidates('win32', 'C:\\workspace', { ComSpec: 'cmd-custom.exe' });
  assert.deepEqual(candidates.map((item) => item.command), ['wt.exe', 'cmd-custom.exe']);
  assert.deepEqual(candidates[1].args, ['/K']);
});
