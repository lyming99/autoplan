'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, describe, it } = require('node:test');
const { RuntimeFileLogger, safeErrorCode } = require('./runtimeFileLogger');

const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'autoplan-log-'));
  roots.push(directory);
  return new RuntimeFileLogger({ directory, now: () => new Date('2026-07-14T01:02:03Z'), ...options });
}

describe('runtime file logger', () => {
  it('persists only allowlisted structured fields', () => {
    const logger = fixture();
    logger.log('error', 'ipc_request_failed', {
      source: 'electron', channel: 'loop:start', project_id: 7,
      error_code: 'service_unavailable', secret: 'do-not-write', path: 'C:\\private',
    });
    const event = JSON.parse(fs.readFileSync(logger.filePath, 'utf8'));
    assert.deepEqual(event, {
      occurred_at: '2026-07-14T01:02:03.000Z', source: 'electron', level: 'error',
      code: 'ipc_request_failed', error_code: 'service_unavailable', channel: 'loop:start', project_id: 7,
    });
    assert.equal(fs.readFileSync(logger.filePath, 'utf8').includes('do-not-write'), false);
  });

  it('joins sidecar chunks, validates JSON, and redacts malformed diagnostics', () => {
    const logger = fixture();
    logger.writeExternalChunk('go-sidecar', '{"level":"info","code":"daemon_ready","pid":42}\nnot');
    logger.writeExternalChunk('go-sidecar', '-json\n');
    const events = fs.readFileSync(logger.filePath, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(events[0].source, 'go-sidecar');
    assert.equal(events[0].code, 'daemon_ready');
    assert.equal(events[1].code, 'external_diagnostic_redacted');
    assert.equal(JSON.stringify(events).includes('not-json'), false);
  });

  it('rotates bounded log files', () => {
    const logger = fixture({ maxBytes: 256, archives: 2 });
    for (let index = 0; index < 20; index += 1) logger.log('info', `event_${index}`);
    assert.equal(fs.existsSync(logger.filePath), true);
    assert.equal(fs.existsSync(`${logger.filePath}.1`), true);
    assert.equal(fs.existsSync(`${logger.filePath}.3`), false);
  });

  it('reduces unsafe errors to a stable code', () => {
    assert.equal(safeErrorCode({ code: 'service_unavailable' }), 'service_unavailable');
    assert.equal(safeErrorCode(new Error('token=secret C:\\private')), 'unclassified_error');
  });
});
