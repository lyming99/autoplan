export {};

type TestRegistrar = (name: string, fn: () => void) => void;

declare function require(id: string): unknown;
declare const process: { cwd(): string };

const { describe, it } = require('node:test') as { describe: TestRegistrar; it: TestRegistrar };
const { readFileSync } = require('node:fs') as { readFileSync: (path: string, encoding: string) => string };
const { join } = require('node:path') as { join: (...parts: string[]) => string };

function expect(condition: unknown, message: string) {
  if (!condition) throw new Error(message);
}

function source(...parts: string[]) {
  return readFileSync(join(process.cwd(), ...parts), 'utf8');
}

function expectIncludes(sourceText: string, snippet: string, message: string) {
  expect(sourceText.includes(snippet), message);
}

function sliceBetween(sourceText: string, startNeedle: string, endNeedle: string, message: string) {
  const start = sourceText.indexOf(startNeedle);
  expect(start >= 0, message);
  const end = sourceText.indexOf(endNeedle, start);
  expect(end >= 0, message);
  return sourceText.slice(start, end + endNeedle.length);
}

describe('P010 useSnapshot incremental patch merge', () => {
  const hook = source('src', 'renderer', 'hooks', 'useSnapshot.ts');

  it('subscribes to loop patch events and batches patches by project per animation frame', () => {
    expectIncludes(hook, 'const queuedPatches = new Map<string, WorkspaceSnapshotPatch>();', 'patches should be queued by project key');
    expectIncludes(hook, 'queuedPatches.set(patchQueueKey(next), next);', 'newer patches for the same project should replace older queued patches');
    expectIncludes(hook, "typeof window.autoplan.onLoopPatch === 'function'", 'hook should subscribe to the optional patch channel');
    expectIncludes(hook, 'unsubscribePatch();', 'patch subscription should be disposed with the full snapshot subscription');
    expectIncludes(hook, 'window.cancelAnimationFrame(frameId);', 'queued frame should be cancelled on dispose');
  });

  it('applies full snapshots before queued patches and clears stale queued patches on full update', () => {
    const effectBody = sliceBetween(
      hook,
      'const flushQueuedUpdate = () => {',
      'const schedulePatch = (next: WorkspaceSnapshotPatch) => {',
      'should locate queued update scheduling logic',
    );

    expectIncludes(effectBody, 'if (latestSnapshot) next = applySnapshotForProject(latestSnapshot, projectId, current);', 'full loop:update should replace the current project snapshot first');
    expectIncludes(effectBody, 'for (const latestPatch of latestPatches) {', 'queued patches should merge after the latest full snapshot');
    expectIncludes(effectBody, 'next = applySnapshotPatchForProject(next, latestPatch, projectId);', 'patches should use the project-aware merge helper');
    expectIncludes(effectBody, 'queuedPatches.clear();', 'full snapshot scheduling should drop stale queued patches');
  });

  it('merges only lightweight runtime fields and preserves full intake and scan arrays', () => {
    const mergeBody = sliceBetween(
      hook,
      'function applySnapshotPatchForProject(',
      'function applySnapshotForProject(',
      'should locate the patch merge helper',
    );

    expectIncludes(mergeBody, "return projects === current.projects ? current : { ...current, projects };", 'patches for other projects should only update project list state');
    expectIncludes(mergeBody, "...(hasOwn(patch, 'state') ? { state: patch.state ?? null } : {})", 'state should be patch-mergeable');
    expectIncludes(mergeBody, "...(hasOwn(patch, 'tasks') ? { tasks: patch.tasks || [] } : {})", 'tasks should be patch-mergeable');
    expectIncludes(mergeBody, "...(hasOwn(patch, 'events') ? { events: patch.events || [] } : {})", 'events should be patch-mergeable');
    expectIncludes(mergeBody, "...(hasOwn(patch, 'activeOperation') ? { activeOperation: patch.activeOperation ?? null } : {})", 'active operation should be patch-mergeable');
    expectIncludes(mergeBody, "...(hasOwn(patch, 'activeOperations') ? { activeOperations: patch.activeOperations || [] } : {})", 'active operations should be patch-mergeable');
    expectIncludes(mergeBody, "...(hasOwn(patch, 'lastOperation') ? { lastOperation: patch.lastOperation ?? null } : {})", 'last operation should be patch-mergeable');
    expect(!mergeBody.includes('requirements:'), 'patch merge should not replace requirements');
    expect(!mergeBody.includes('feedback:'), 'patch merge should not replace feedback');
    expect(!mergeBody.includes('attachments:'), 'patch merge should not replace attachments');
    expect(!mergeBody.includes('scans:'), 'patch merge should not replace scans');
  });

  it('keeps full loop:update project protection and project-list fallback behavior', () => {
    const fullBody = sliceBetween(
      hook,
      'function applySnapshotForProject(',
      'function isPatchForProject(',
      'should locate the full snapshot merge helper',
    );

    expectIncludes(fullBody, 'if (isSnapshotForProject(next, projectId)) return next;', 'matching full snapshots should replace the active snapshot');
    expectIncludes(fullBody, 'return { ...current, projects: next.projects };', 'other-project full snapshots should only refresh the project list');
    expectIncludes(fullBody, 'return createProjectListSnapshot(current || next, next.projects);', 'non-active full snapshots should fall back to project-list snapshots');
  });
});
