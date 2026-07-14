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
    assert.equal(darwin.HOME, '/private/home');
    assert.equal(darwin.TEMP, undefined);

    const windows = controlledEnvironment(
      { Path: 'C:\\Windows\\System32', PATHEXT: '.COM;.EXE;.BAT;.CMD', USERPROFILE: 'C:\\Users\\runner' }, {}, '', 'win32', 'D:\\a\\_temp\\',
    );
    assert.equal(windows.TEMP, 'D:\\a\\_temp');
    assert.equal(windows.TMP, 'D:\\a\\_temp');
    assert.equal(windows.USERPROFILE, 'C:\\Users\\runner');
    assert.equal(windows.PATHEXT, '.COM;.EXE;.BAT;.CMD');
    assert.equal(temporaryRootForPlatform('relative-temp', 'darwin'), '');
  });

  it('passes the exact persistent data directory selected by Electron', () => {
    const dataDir = path.resolve('C:\\Users\\runner\\AppData\\Roaming\\AutoPlan\\data\\go');
    const windows = controlledEnvironment({}, {}, '', 'win32', 'C:\\Temp', dataDir, 43901);
    assert.equal(windows.AUTOPLAN_SIDECAR_DATA_DIR, dataDir);
    assert.equal(windows.AUTOPLAN_MCP_PORT, '43901');
    assert.throws(() => new GoDaemonSupervisor({ executablePath: __filename, dataDir: __dirname, mcpPort: 70000 }), /daemon_mcp_port_invalid/);
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
          assert.equal(options.env.AUTOPLAN_SIDECAR_DATA_DIR, dataDir);
          assert.equal(Object.keys(options.env).some((key) => /(?:SESSION|TOKEN|SECRET)/.test(key)), false);
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
      assert.equal(spawned.exitCode, 0, 'stop must reap the Go child before resolving');
      assert.equal(supervisor.status().state, 'stopped');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('drains sidecar stderr into the structured file logger', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autoplan-daemon-log-'));
    const executable = path.join(root, process.platform === 'win32' ? 'autoplan-server.exe' : 'autoplan-server');
    const dataDir = path.join(root, 'data');
    fs.writeFileSync(executable, 'fixture');
    fs.mkdirSync(dataDir);
    const chunks = [];
    const events = [];
    let spawned;
    try {
      const supervisor = new GoDaemonSupervisor({
        executablePath: executable,
        dataDir,
        logger: {
          log: (level, code, fields) => events.push({ level, code, fields }),
          writeExternalChunk: (source, chunk) => chunks.push({ source, text: chunk.toString('utf8') }),
          flushExternal: () => undefined,
        },
        spawn: () => {
          spawned = fakeChild();
          let handshake = '';
          spawned.stdin.on('data', (part) => { handshake += part.toString('utf8'); });
          spawned.stdin.on('data', () => {
            if (!handshake.includes('\n')) return;
            const session = JSON.parse(handshake).session;
            spawned.stderr.write('{"level":"info","code":"database_ready"}\n');
            spawned.stdout.write(`${JSON.stringify({
              version: 1, type: 'autoplan_daemon_ready', pid: spawned.pid, host: '127.0.0.1', port: 43123,
              ready: true, lock: 'held', session_proof: createSessionProof(session, spawned.pid, 43123),
            })}\n`);
          });
          return spawned;
        },
        fetch: async () => ({ ok: true, status: 200, json: async () => ({ status: 'ready' }) }),
      });
      await supervisor.start();
      assert.deepEqual(chunks, [{ source: 'go-sidecar', text: '{"level":"info","code":"database_ready"}\n' }]);
      assert.equal(events.some((event) => event.code === 'daemon_ready'), true);
      await supervisor.stop();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
