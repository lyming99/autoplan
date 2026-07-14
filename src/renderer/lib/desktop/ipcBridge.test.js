const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { describe, it } = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

const root = process.cwd();

function source(...parts) {
  return readFileSync(join(root, ...parts), 'utf8');
}

function tupleKeys(sourceText, exportName) {
  const pattern = new RegExp(`export const ${exportName} = \\[([\\s\\S]*?)\\] as const`);
  const match = sourceText.match(pattern);
  assert.ok(match, `missing ${exportName}`);
  return [...match[1].matchAll(/'([^']+)'/g)].map((item) => item[1]);
}

const operationKeys = tupleKeys(
  source('src', 'renderer', 'lib', 'desktop', 'bridge.ts'),
  'DESKTOP_BRIDGE_OPERATION_KEYS',
);
const capabilityMatrix = JSON.parse(
  source('docs', 'migration', 'p00', 'capability-matrix.json'),
);

function loadIpcDesktopBridge() {
  const compiled = ts.transpileModule(
    source('src', 'renderer', 'lib', 'desktop', 'ipcBridge.ts'),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
      fileName: 'ipcBridge.ts',
    },
  ).outputText;
  const module = { exports: {} };
  const wrapper = vm.runInThisContext(`(function (require, module, exports) { ${compiled}\n})`);
  wrapper(
    (id) => {
      if (id === './bridge') return { DESKTOP_BRIDGE_OPERATION_KEYS: operationKeys };
      throw new Error(`unexpected runtime import: ${id}`);
    },
    module,
    module.exports,
  );
  return module.exports.IpcDesktopBridge;
}

function createApi(overrides = {}) {
  const calls = [];
  const listeners = [];
  const releaseReaders = [];
  const api = {};

  for (const key of operationKeys) {
    api[key] = (...args) => {
      calls.push({ key, args });
      return Object.prototype.hasOwnProperty.call(overrides, key)
        ? overrides[key](...args)
        : { operation: key };
    };
  }
  api.onUpdateStatus = (handler) => {
    if (overrides.onUpdateStatus) return overrides.onUpdateStatus(handler);
    listeners.push(handler);
    let releases = 0;
    const unsubscribe = () => {
      releases += 1;
      const index = listeners.indexOf(handler);
      if (index >= 0) listeners.splice(index, 1);
    };
    releaseReaders.push(() => releases);
    return unsubscribe;
  };

  Object.assign(api, {
    snapshot: () => 'business',
    startLoop: () => 'business',
    chatSend: () => 'business',
    createTerminal: () => 'business',
  }, overrides.api);

  return {
    api,
    calls,
    emit(status) {
      for (const handler of [...listeners]) handler(status);
    },
    listenerCount() {
      return listeners.length;
    },
    releaseCounts() {
      return releaseReaders.map((read) => read());
    },
  };
}

describe('DesktopBridge controlled capability boundary', () => {
  it('matches current P00 desktop preload operations and excludes planned placeholders', () => {
    const expected = capabilityMatrix.capabilities
      .filter((item) => item.owner === 'desktop-bridge' && item.preload)
      .map((item) => item.preload)
      .sort();
    assert.deepStrictEqual([...operationKeys].sort(), expected);

    const bridgeSource = source('src', 'renderer', 'lib', 'desktop', 'bridge.ts');
    assert.match(bridgeSource, /interface DesktopBridgeExtensions/);
    assert.ok(!operationKeys.includes('getAppVersion'));
    assert.ok(!operationKeys.includes('sidecar'));
  });

  it('keeps one stable default bridge outside React StrictMode rendering', () => {
    const provider = source('src', 'renderer', 'lib', 'api', 'provider.tsx');
    const instanceAt = provider.indexOf('const defaultDesktopBridge: DesktopBridge = getDefaultDesktopBridge();');
    const componentAt = provider.indexOf('export function AutoplanProvider');
    assert.ok(instanceAt >= 0 && instanceAt < componentAt);
    const bridge = source('src', 'renderer', 'lib', 'desktop', 'ipcBridge.ts');
    assert.match(bridge, /defaultDesktopBridge \?\?= new IpcDesktopBridge\(\)/);
    assert.match(provider, /export function useDesktopBridge\(\): DesktopBridge/);
  });
});

describe('IpcDesktopBridge operation mapping', () => {
  it('forwards every native operation without changing arguments or results', () => {
    const IpcDesktopBridge = loadIpcDesktopBridge();
    const fixture = createApi();
    const bridge = new IpcDesktopBridge(fixture.api);

    assert.equal(bridge.api, undefined, 'the complete preload object must remain private');
    for (const businessKey of ['snapshot', 'startLoop', 'chatSend', 'createTerminal']) {
      assert.equal(bridge[businessKey], undefined, `${businessKey} must remain in AutoplanClient`);
    }
    for (const key of operationKeys) {
      const input = { operation: key };
      const expected = fixture.api[key](input);
      fixture.calls.pop();
      assert.deepStrictEqual(bridge[key](input), expected);
      const call = fixture.calls.pop();
      assert.equal(call.key, key);
      assert.strictEqual(call.args[0], input);
    }
  });

  it('preserves selection cancellation, safe failure results, and thrown errors', async () => {
    const IpcDesktopBridge = loadIpcDesktopBridge();
    const syncError = new Error('native sync failure');
    const rejectedError = new Error('native rejection');
    const rejected = Promise.reject(rejectedError);
    rejected.catch(() => {});
    const openFailure = { ok: false, error: 'open failed' };
    const fixture = createApi({
      pickDirectory: () => null,
      openProjectFolder: () => openFailure,
      openExternal: () => { throw syncError; },
      checkForUpdates: () => rejected,
    });
    const bridge = new IpcDesktopBridge(fixture.api);

    assert.strictEqual(bridge.pickDirectory(), null);
    assert.strictEqual(bridge.openProjectFolder({ projectId: 1 }), openFailure);
    assert.throws(() => bridge.openExternal('https://example.test'), (error) => error === syncError);
    const updateResult = bridge.checkForUpdates();
    assert.strictEqual(updateResult, rejected);
    await assert.rejects(updateResult, (error) => error === rejectedError);
  });

  it('fails closed when a required native operation is absent', () => {
    const IpcDesktopBridge = loadIpcDesktopBridge();
    const fixture = createApi();
    delete fixture.api.toFileUrl;
    assert.throws(() => new IpcDesktopBridge(fixture.api), /toFileUrl must be a function/);
  });
});

describe('IpcDesktopBridge update subscription lifecycle', () => {
  it('delivers status identity and deduplicates repeated handlers by ownership', () => {
    const IpcDesktopBridge = loadIpcDesktopBridge();
    const fixture = createApi();
    const bridge = new IpcDesktopBridge(fixture.api);
    const received = [];
    const handler = (status) => received.push(status);
    const first = bridge.onUpdateStatus(handler);
    const second = bridge.onUpdateStatus(handler);
    const status = { currentVersion: '1.0.0' };

    assert.equal(fixture.listenerCount(), 1);
    fixture.emit(status);
    assert.deepStrictEqual(received, [status]);
    assert.strictEqual(received[0], status);
    first();
    first();
    assert.equal(fixture.listenerCount(), 1);
    assert.deepStrictEqual(fixture.releaseCounts(), [0]);
    second();
    assert.equal(fixture.listenerCount(), 0);
    assert.deepStrictEqual(fixture.releaseCounts(), [1]);
  });

  it('supports callback cancellation without removing another listener', () => {
    const IpcDesktopBridge = loadIpcDesktopBridge();
    const fixture = createApi();
    const bridge = new IpcDesktopBridge(fixture.api);
    const received = [];
    let stopFirst;
    stopFirst = bridge.onUpdateStatus(() => {
      received.push('first');
      stopFirst();
    });
    bridge.onUpdateStatus(() => received.push('second'));

    fixture.emit({});
    fixture.emit({});
    assert.deepStrictEqual(received, ['first', 'second', 'second']);
    assert.equal(fixture.listenerCount(), 1);
  });

  it('propagates subscribe failures and rejects invalid unsubscribe contracts', () => {
    const IpcDesktopBridge = loadIpcDesktopBridge();
    const subscribeError = new Error('subscribe failed');
    const failed = createApi({ onUpdateStatus: () => { throw subscribeError; } });
    const invalid = createApi({ onUpdateStatus: () => undefined });

    assert.throws(
      () => new IpcDesktopBridge(failed.api).onUpdateStatus(() => {}),
      (error) => error === subscribeError,
    );
    assert.throws(
      () => new IpcDesktopBridge(invalid.api).onUpdateStatus(() => {}),
      /must return an unsubscribe function/,
    );
  });

  it('destroy releases all listeners once and prevents later subscriptions', () => {
    const IpcDesktopBridge = loadIpcDesktopBridge();
    const fixture = createApi();
    const bridge = new IpcDesktopBridge(fixture.api);
    bridge.onUpdateStatus(() => {});
    bridge.onUpdateStatus(() => {});

    assert.equal(fixture.listenerCount(), 2);
    bridge.destroy();
    bridge.destroy();
    assert.equal(fixture.listenerCount(), 0);
    assert.deepStrictEqual(fixture.releaseCounts(), [1, 1]);
    assert.throws(() => bridge.onUpdateStatus(() => {}), /has been destroyed/);
  });
});
