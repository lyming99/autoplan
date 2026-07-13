'use strict';

const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createSessionProof, parseReadinessLine, verifyReadiness } = require('./readiness');
const { controlledEnvironment, GoDaemonSupervisor, temporaryRootForPlatform } = require('./supervisor');

function fakeChild(pid = 4321) {
  const child = new EventEmitter();
  child.pid = pid;
  child.exitCode = null;
  child.signalCode = null;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {
    if (child.exitCode !== null) return false;
    child.exitCode = 0;
    child.emit('exit', 0, null);
    return true;
  };
  return child;
}

describe('Go daemon readiness supervisor', () => {
  it('pins the child temp root to the directory selected by Node', () => {
    const darwin = controlledEnvironment(
      { PATH: '/usr/bin', HOME: '/private/home' }, {}, '', 'darwin', '/Users/runner/work/_temp/',
    );
    assert.equal(darwin.TMPDIR, '/Users/runner/work/_temp');
    assert.equal(darwin.HOME, undefined);
    assert.equal(darwin.TEMP, undefined);

    const windows = controlledEnvironment(
      { Path: 'C:\\Windows\\System32', USERPROFILE: 'C:\\Users\\runner' }, {}, '', 'win32', 'D:\\a\\_temp\\',
    );
    assert.equal(windows.TEMP, 'D:\\a\\_temp');
    assert.equal(windows.TMP, 'D:\\a\\_temp');
    assert.equal(windows.USERPROFILE, undefined);
    assert.equal(temporaryRootForPlatform('relative-temp', 'darwin'), '');
  });

  it('requires exact ready protocol, child identity, and session binding', () => {
    const session = 'a'.repeat(43);
    const line = JSON.stringify({
      version: 1, type: 'autoplan_daemon_ready', pid: 73, host: '127.0.0.1', port: 43123,
      ready: true, lock: 'held', session_proof: createSessionProof(session, 73, 43123),
    });
    const parsed = parseReadinessLine(line);
    assert.equal(verifyReadiness(parsed, { pid: 73, session }).port, 43123);
    assert.throws(() => verifyReadiness(parsed, { pid: 74, session }), /daemon_identity_mismatch/);
    assert.throws(() => parseReadinessLine(`${line}\n${line}`), /daemon_readiness_invalid/);
  });

  it('passes the secret only through stdin and returns a credential-free status', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autoplan-daemon-'));
    const executable = path.join(root, process.platform === 'win32' ? 'autoplan-server.exe' : 'autoplan-server');
    fs.writeFileSync(executable, 'fixture');
    const dataDir = path.join(root, 'data');
    fs.mkdirSync(dataDir);
    let spawned;
    try {
      const supervisor = new GoDaemonSupervisor({
        executablePath: executable,
        dataDir,
        spawn: (_file, args, options) => {
          assert.deepEqual(args, ['--data-dir', dataDir]);
          assert.equal(Object.keys(options.env).some((key) => /(?:SESSION|TOKEN|SECRET|DATA_DIR)/.test(key)), false);
          assert.equal(Object.values(options.env).some((value) => typeof value === 'string' && value.length === 43), false);
          spawned = fakeChild();
          let handshake = '';
          let readinessSent = false;
          spawned.stdin.on('data', (part) => { handshake += part.toString('utf8'); });
          spawned.stdin.on('data', () => {
            if (readinessSent || !handshake.includes('\n')) return;
            readinessSent = true;
            const session = JSON.parse(handshake).session;
            spawned.stdout.write(`${JSON.stringify({
              version: 1, type: 'autoplan_daemon_ready', pid: spawned.pid, host: '127.0.0.1', port: 43123,
              ready: true, lock: 'held', session_proof: createSessionProof(session, spawned.pid, 43123),
            })}\n`);
          });
          return spawned;
        },
        fetch: async () => ({ ok: true, status: 200, json: async () => ({ status: 'ready' }) }),
      });

      const status = await supervisor.start();
      assert.deepEqual(status, {
        state: 'ready', ready: true, host: '127.0.0.1', port: 43123,
        baseUrl: 'http://127.0.0.1:43123', origin: 'http://127.0.0.1:1',
      });
      assert.equal(JSON.stringify(status).includes('session'), false);
      assert.equal(supervisor.clientOptions().sessionHeaderName, 'X-Autoplan-Session');
      await supervisor.stop();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
