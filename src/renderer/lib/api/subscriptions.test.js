const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { describe, it } = require('node:test');

function source(...parts) {
  return readFileSync(join(process.cwd(), ...parts), 'utf8');
}

const hookFiles = [
  'useSnapshot.ts',
  'useChat.ts',
  'useChatQueue.ts',
  'useTerminalSessions.ts',
  'useUpdateStatus.ts',
];

describe('renderer injected subscription boundary', () => {
  it('removes direct preload access from migrated hooks', () => {
    for (const file of hookFiles) {
      const hook = source('src', 'renderer', 'hooks', file);
      assert.doesNotMatch(hook, /window\.autoplan/, `${file} must use an injected dependency`);
    }
    for (const file of hookFiles.filter((file) => file !== 'useUpdateStatus.ts')) {
      assert.match(
        source('src', 'renderer', 'hooks', file),
        /useAutoplanClient\(\)/,
        `${file} must use AutoplanClient`,
      );
    }
    assert.match(
      source('src', 'renderer', 'hooks', 'useUpdateStatus.ts'),
      /useDesktopBridge\(\)/,
    );
  });

  it('keeps provider defaults outside render and supports explicit contract injection', () => {
    const provider = source('src', 'renderer', 'lib', 'api', 'provider.tsx');
    const componentAt = provider.indexOf('export function AutoplanProvider');
    assert.ok(provider.indexOf('const defaultClient = getAutoplanClient();') < componentAt);
    assert.ok(provider.indexOf('const defaultDesktopBridge: DesktopBridge = getDefaultDesktopBridge();') < componentAt);
    assert.match(provider, /client\?: AutoplanClient/);
    assert.match(provider, /desktopBridge\?: DesktopBridge/);
  });
});

describe('snapshot and queue lifecycle guards', () => {
  it('cancels snapshot frames and ignores updates after effect disposal', () => {
    const hook = source('src', 'renderer', 'hooks', 'useSnapshot.ts');
    assert.match(hook, /let disposed = false/);
    assert.match(hook, /if \(disposed\) return/);
    assert.match(hook, /disposed = true/);
    assert.match(hook, /window\.cancelAnimationFrame\(frameId\)/);
    assert.match(hook, /unsubscribe\(\)/);
    assert.match(hook, /unsubscribePatch\(\)/);
    assert.match(hook, /queuedPatches\.clear\(\)/);
  });

  it('isolates queue initialization and events by active conversation', () => {
    const hook = source('src', 'renderer', 'hooks', 'useChatQueue.ts');
    assert.match(hook, /let active = true/);
    assert.match(hook, /if \(active\) setItems/);
    assert.match(hook, /if \(!active\) return/);
    assert.match(hook, /snapshot\.conversationId !== cid/);
    assert.match(hook, /active = false/);
    assert.match(hook, /unsubscribe\(\)/);
  });
});

describe('chat, terminal, and update lifecycle guards', () => {
  it('invalidates chat requests and event callbacks on switch or unmount', () => {
    const hook = source('src', 'renderer', 'hooks', 'useChat.ts');
    assert.match(hook, /const mountedRef = useRef\(false\)/);
    assert.match(hook, /conversationsRequestRef\.current \+= 1/);
    assert.match(hook, /loadingProjectId !== projectIdRef\.current/);
    assert.match(hook, /stateRef\.current\.activeConversationId !== cid/);
    assert.match(hook, /let active = true/);
    assert.match(hook, /active = false/);
    assert.match(hook, /unsubChunk\(\)/);
    assert.match(hook, /unsubDone\(\)/);
  });

  it('filters terminal events, clears project handlers, and rejects late responses', () => {
    const hook = source('src', 'renderer', 'hooks', 'useTerminalSessions.ts');
    assert.match(hook, /previousProjectIdRef\.current !== projectId/);
    assert.match(hook, /dataHandlersRef\.current\.clear\(\)/);
    assert.match(hook, /if \(!active\) return/);
    assert.match(hook, /eventBelongsToProject\(event, projectIdRef\.current\)/);
    assert.match(hook, /!mountedRef\.current \|\| projectIdRef\.current !== requestProjectId/);
    for (const release of ['unsubscribeData', 'unsubscribeExit', 'unsubscribeStatus', 'unsubscribeClosed']) {
      assert.match(hook, new RegExp(`${release}\\(\\)`));
    }
  });

  it('uses DesktopBridge and replaces update status only while mounted', () => {
    const hook = source('src', 'renderer', 'hooks', 'useUpdateStatus.ts');
    assert.match(hook, /const desktopBridge = useDesktopBridge\(\)/);
    assert.match(hook, /desktopBridge\s*\.updateStatus\(\)/);
    assert.match(hook, /desktopBridge\.onUpdateStatus/);
    assert.match(hook, /mountedRef\.current = false/);
    assert.match(hook, /unsubscribe\(\)/);
  });
});
