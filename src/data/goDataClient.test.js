'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { GoDataClient, GoDataClientError } = require('./goDataClient');

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => body?.request_id || null },
    async json() { return body; },
  };
}

describe('GoDataClient runtime bridge', () => {
  it('sends a closed snake_case command and retains the committed snapshot', async () => {
    let request;
    const client = new GoDataClient({
      baseUrl: 'http://127.0.0.1:43123',
      fetch: async (url, init) => {
        request = { url, init };
        const command = JSON.parse(init.body);
        return response(202, {
          data: {
            operation: {
              operation_id: 'op-1', type: command.command, status: 'accepted',
              request_id: init.headers['x-request-id'], accepted_at: '2026-07-12T00:00:00Z',
            },
            snapshot: { activeProjectId: 9, projects: [{ id: 9, name: 'safe' }] },
          },
          request_id: init.headers['x-request-id'],
        });
      },
    });

    const result = await client.sendChat(9, 3, 'private message', {
      requestId: 'req-client-1', idempotencyKey: 'intent-client-1', callerScope: 'node-runtime',
    });

    assert.equal(request.url, 'http://127.0.0.1:43123/api/v1/runtime/commands');
    assert.deepEqual(JSON.parse(request.init.body), {
      version: 'v1', command: 'chat.send', project_id: 9, conversation_id: 3,
      chat: { content: 'private message' },
    });
    assert.equal(request.init.headers['idempotency-key'], 'intent-client-1');
    assert.equal(result.operation.operation_id, 'op-1');
    assert.deepEqual(client.snapshot(9), result.snapshot);
    assert.equal(typeof client.run, 'undefined');
    assert.equal(typeof client.query, 'undefined');
    assert.equal(typeof client.request, 'undefined');
  });

  it('rejects arbitrary SQL-shaped input before transport', async () => {
    let called = false;
    const client = new GoDataClient({
      baseUrl: 'http://127.0.0.1:43123',
      fetch: async () => { called = true; return response(500, {}); },
    });

    await assert.rejects(
      client.executeRuntimeCommand('loop.start', { projectId: 1, sql: 'DELETE FROM projects' }),
      (error) => error instanceof GoDataClientError && error.code === 'invalid_runtime_command',
    );
    assert.equal(called, false);
  });

  it('exposes only a stable error code and never logs response text', async () => {
    const warnings = [];
    const client = new GoDataClient({
      baseUrl: 'http://127.0.0.1:43123',
      retryAttempts: 0,
      logger: { warn: (...args) => warnings.push(args) },
      fetch: async () => response(503, {
        error: { code: 'service_unavailable', message: 'token=not-for-log', retryable: true, request_id: 'req-server-1' },
      }),
    });

    await assert.rejects(client.startLoop(1), (error) => (
      error instanceof GoDataClientError && error.code === 'service_unavailable' && error.requestId === 'req-server-1'
    ));
    assert.deepEqual(warnings, []);
  });

  it('retries intake generation through the fixed mutation route and immediately admits one loop cycle', async () => {
    const calls = [];
    const snapshot = { activeProjectId: 7, requirements: [{ id: 11, generate_fail_count: 0 }] };
    const client = new GoDataClient({
      baseUrl: 'http://127.0.0.1:43123',
      fetch: async (url, init) => {
        calls.push({ url, init });
        const requestId = init.headers['x-request-id'];
        if (url.endsWith('/actions/retry-plan-generation')) {
          return response(200, { data: { snapshot }, request_id: requestId });
        }
        const command = JSON.parse(init.body);
        return response(202, {
          data: {
            operation: {
              operation_id: 'op-loop-retry', type: command.command, status: 'accepted',
              request_id: requestId, accepted_at: '2026-07-14T00:00:00Z',
            },
          },
          request_id: requestId,
        });
      },
    });

    const result = await client.retryIntakePlanGeneration(7, 'requirement', 11, {
      requestId: 'req-retry', idempotencyKey: 'intent-retry', callerScope: 'node-runtime',
    });

    assert.equal(calls.length, 2);
    assert.equal(calls[0].url, 'http://127.0.0.1:43123/api/v1/projects/7/intake/requirement/11/actions/retry-plan-generation');
    assert.equal(calls[0].init.body, '{}');
    assert.equal(JSON.parse(calls[1].init.body).command, 'loop.run_once');
    assert.deepEqual(result.snapshot, snapshot);
    assert.equal(result.operation.operation_id, 'op-loop-retry');
  });
});
