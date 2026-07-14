'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { GoDataClient, GoDataClientError, RUNTIME_COMMANDS } = require('./goDataClient');

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => String(name).toLowerCase() === 'x-request-id' ? body?.request_id || null : null },
    async json() { return body; },
  };
}

function accepted(command, requestId) {
  return {
    data: {
      operation: {
        operation_id: `p11-${command.replaceAll('.', '-')}`,
        type: command,
        status: 'accepted',
        request_id: requestId,
        accepted_at: '2026-07-12T09:00:00Z',
      },
      snapshot: { activeProjectId: 7, activeOperations: [], lastOperation: null },
    },
    request_id: requestId,
  };
}

describe('P11 GoDataClient runtime owner contract', () => {
  it('keeps a Go owner for an accepted fallback operation and sends no SQL-shaped payload', async () => {
    const calls = [];
    const client = new GoDataClient({
      baseUrl: 'http://127.0.0.1:43123',
      fetch: async (_url, init) => {
        const body = JSON.parse(init.body);
        calls.push({ body, headers: init.headers });
        return response(202, accepted(body.command, init.headers['x-request-id']));
      },
    });
    const result = await client.acceptItem(7, 'plan', 11, {
      requestId: 'p11-runtime-request', idempotencyKey: 'p11-runtime-intent',
    });
    assert.equal(result.operation.type, RUNTIME_COMMANDS.ACCEPTANCE_ACCEPT);
    assert.equal(client.operationOwner(result.operation.operation_id), 'go');
    assert.deepEqual(calls[0].body, {
	  version: 'v1', command: 'acceptance.accept', project_id: 7,
	  acceptance: { targets: [{ target_type: 'plan', id: 11 }] },
    });
    assert.equal(Object.hasOwn(calls[0].body, 'sql'), false);
    assert.equal(typeof client.query, 'undefined');
    assert.equal(typeof client.executeSql, 'undefined');
  });

  it('keeps unknown submission outcomes fail-closed instead of invoking a local fallback', async () => {
    let calls = 0;
    const client = new GoDataClient({
      baseUrl: 'http://127.0.0.1:43123',
      retryAttempts: 0,
      fetch: async () => {
        calls += 1;
        return response(503, { error: { code: 'service_unavailable', retryable: true, request_id: 'p11-unavailable' } });
      },
    });
    await assert.rejects(
      client.runLoopOnce(7, { requestId: 'p11-runtime-request', idempotencyKey: 'p11-runtime-intent' }),
      (error) => error instanceof GoDataClientError && error.code === 'service_unavailable',
    );
    assert.equal(calls, 1);
    assert.equal(client.operationOwner('p11-loop-run-once'), null);
  });
});
