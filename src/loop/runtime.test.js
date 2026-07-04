const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  archiveRuntimeOperation,
  createProjectRuntime,
  createThrottledUpdateEmitter,
  operationSnapshotRow,
  registerRuntimeOperation,
} = require('./runtime');

describe('P010 runtime lightweight update helpers', () => {
  it('routes immediate lightweight refreshes through patch payloads only', () => {
    const calls = [];
    const emitter = createThrottledUpdateEmitter({
      throttleMs: 1000,
      snapshot: (projectId) => ({ projectId, scans: ['heavy'], requirements: ['heavy'] }),
      patch: (projectId) => ({ projectId, tasks: [{ id: 1 }], events: [] }),
      emit: (snapshot) => calls.push({ type: 'snapshot', payload: snapshot }),
      emitPatch: (patch) => calls.push({ type: 'patch', payload: patch }),
    });

    emitter.emit(7, { lightweight: true, immediate: true });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].type, 'patch');
    assert.deepEqual(Object.keys(calls[0].payload).sort(), ['events', 'projectId', 'tasks']);
  });

  it('keeps full snapshot refresh available when lightweight mode is not requested', () => {
    const calls = [];
    const emitter = createThrottledUpdateEmitter({
      throttleMs: 1000,
      snapshot: (projectId) => ({ projectId, scans: ['full-scan-array'] }),
      patch: (projectId) => ({ projectId, tasks: [] }),
      emit: (snapshot) => calls.push({ type: 'snapshot', payload: snapshot }),
      emitPatch: (patch) => calls.push({ type: 'patch', payload: patch }),
    });

    emitter.emit(7, { immediate: true });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].type, 'snapshot');
    assert.deepEqual(calls[0].payload.scans, ['full-scan-array']);
  });

  it('snapshots operation log tails and archives finished operations for patch consumers', () => {
    const runtime = createProjectRuntime();
    const longTail = `${'x'.repeat(9000)}tail`;
    const operation = {
      label: 'run task',
      projectId: 7,
      planId: 3,
      taskId: 11,
      logBuffer: longTail,
      startedAt: '2026-07-04T00:00:00.000Z',
      activity: { flush() {}, getLines: () => [{ role: 'assistant', text: 'working', at: 'now' }] },
    };

    const operationKey = registerRuntimeOperation(runtime, { kill() {} }, operation);
    const snapshot = operationSnapshotRow(runtime.activeOperation);

    assert.equal(snapshot.projectId, 7);
    assert.equal(snapshot.taskId, 11);
    assert.equal(snapshot.logTail.length, 8000);
    assert.ok(snapshot.logTail.endsWith('tail'));
    assert.deepEqual(snapshot.activity, [{ role: 'assistant', text: 'working', at: 'now' }]);

    archiveRuntimeOperation(runtime, operationKey);

    assert.equal(runtime.activeOperation, null);
    assert.equal(runtime.activeOperations.size, 0);
    assert.equal(runtime.lastOperation.projectId, 7);
    assert.equal(runtime.lastOperation.taskId, 11);
    assert.ok(runtime.lastOperation.logTail.endsWith('tail'));
  });
});
