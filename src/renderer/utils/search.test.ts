export {};

import { WORKSPACE_SEARCH_SOURCE_TYPES, type AppSnapshot, type WorkspaceSearchSourceType } from '../types';
import { searchWorkspaceSnapshot } from './search';

type TestRegistrar = (name: string, fn: () => void) => void;

declare function require(id: string): unknown;

const { describe, it } = require('node:test') as { describe: TestRegistrar; it: TestRegistrar };

function expect(condition: unknown, message: string) {
  if (!condition) throw new Error(message);
}

function expectEqual(actual: unknown, expected: unknown, message: string) {
  if (actual !== expected) throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
}

const ts = '2026-07-04T00:00:00.000Z';

function makeSearchSnapshot(): AppSnapshot {
  return {
    requirements: [
      {
        id: 1,
        project_id: 1,
        title: 'req-title-token',
        body: 'requirement body',
        status: 'open',
        source_path: 'docs/req-source-token.md',
        created_at: ts,
        updated_at: ts,
      },
      {
        id: 2,
        project_id: 1,
        title: 'requirement without attachments',
        body: 'plain requirement',
        status: 'open',
        created_at: ts,
        updated_at: ts,
      },
    ],
    feedback: [
      {
        id: 20,
        project_id: 1,
        requirement_id: 1,
        title: 'feedback-title-token',
        body: 'feedback body',
        status: 'open',
        created_at: ts,
        updated_at: ts,
      },
    ],
    attachments: [
      {
        id: 100,
        project_id: 1,
        owner_type: 'requirement',
        owner_id: 1,
        original_name: 'req-attachment-alpha',
        stored_path: 'uploads/req-alpha.txt',
        size: 1,
        hash: 'a',
        created_at: ts,
      },
      {
        id: 101,
        project_id: 1,
        owner_type: 'requirement',
        owner_id: 1,
        original_name: 'req-attachment-beta',
        stored_path: 'uploads/req-beta.txt',
        size: 1,
        hash: 'b',
        created_at: ts,
      },
      {
        id: 102,
        project_id: 1,
        owner_type: 'feedback',
        owner_id: 20,
        original_name: 'feedback-attachment-token',
        stored_path: 'uploads/feedback-token.txt',
        size: 1,
        hash: 'c',
        created_at: ts,
      },
      {
        id: 103,
        project_id: 1,
        owner_type: 'feedback',
        owner_id: 999,
        original_name: 'orphan-attachment-token',
        stored_path: 'uploads/orphan-token.txt',
        size: 1,
        hash: 'd',
        created_at: ts,
      },
    ],
    plans: [
      {
        id: 30,
        project_id: 1,
        issue_hash: 'issue',
        file_path: 'docs/plan/plan-file-token.md',
        title: 'plan-title-token',
        hash: 'hash',
        status: 'completed',
        sort_order: 1,
        is_draft: false,
        total_tasks: 1,
        completed_tasks: 1,
        validation_passed: 1,
        concurrency_suggestion: { hasSafeParallelBatches: false, parallelTaskCount: 0, batchCount: 0, serialTaskCount: 0, maxParallelTasks: 1, batches: [], serialTasks: [] },
        created_at: ts,
        updated_at: ts,
        accepted_at: null,
      },
    ],
    tasks: [
      {
        id: 40,
        plan_id: 30,
        task_key: 'P040',
        title: 'task-title-token',
        raw_line: '- [ ] raw-line-token',
        scope: 'src/task-scope-token.ts',
        scope_files: [],
        status: 'pending',
        sort_order: 1,
        started_at: null,
        finished_at: null,
        duration_ms: 0,
        codex_session_id: null,
        updated_at: ts,
        accepted_at: null,
        file_path: 'docs/plan/plan-file-token.md',
        plan_title: 'plan-title-token',
      },
    ],
    events: [
      {
        id: 50,
        project_id: 1,
        type: 'event-type-token',
        message: 'event-message-token',
        meta: { taskKey: 'P040', taskTitle: 'event-meta-token', status: 'completed' },
        created_at: ts,
      },
    ],
  } as unknown as AppSnapshot;
}

function expectSourceMatch(query: string, source: WorkspaceSearchSourceType) {
  const state = searchWorkspaceSnapshot(makeSearchSnapshot(), query);
  expect(
    state.results.some((result) => result.source === source),
    `query "${query}" should match ${source}`,
  );
}

describe('P009 workspace search candidate path', () => {
  it('short-circuits empty query before touching snapshot collections', () => {
    const guardedSnapshot = new Proxy({}, {
      get(_target, property) {
        throw new Error(`empty search should not read snapshot.${String(property)}`);
      },
    }) as unknown as AppSnapshot;

    const state = searchWorkspaceSnapshot(guardedSnapshot, '   ');

    expectEqual(state.total, 0, 'empty search should produce zero results');
    expect(state.query.isEmpty, 'empty search query should stay marked empty');
  });

  it('matches requirements, feedback, attachments, plans, tasks, and events when query exists', () => {
    expectSourceMatch('req-title-token', WORKSPACE_SEARCH_SOURCE_TYPES.REQUIREMENT);
    expectSourceMatch('feedback-title-token', WORKSPACE_SEARCH_SOURCE_TYPES.FEEDBACK);
    expectSourceMatch('req-attachment-alpha', WORKSPACE_SEARCH_SOURCE_TYPES.REQUIREMENT);
    expectSourceMatch('feedback-attachment-token', WORKSPACE_SEARCH_SOURCE_TYPES.FEEDBACK);
    expectSourceMatch('plan-title-token', WORKSPACE_SEARCH_SOURCE_TYPES.PLAN);
    expectSourceMatch('task-title-token', WORKSPACE_SEARCH_SOURCE_TYPES.TASK);
    expectSourceMatch('event-meta-token', WORKSPACE_SEARCH_SOURCE_TYPES.EVENT);
  });

  it('keeps attachment matches owner-scoped across same owner, different owner, and orphan cases', () => {
    const sameOwner = searchWorkspaceSnapshot(makeSearchSnapshot(), 'req-attachment-beta');
    expectEqual(sameOwner.results[0]?.source, WORKSPACE_SEARCH_SOURCE_TYPES.REQUIREMENT, 'same-owner attachment should match its requirement');
    expectEqual(sameOwner.results[0]?.recordId, 1, 'same-owner attachment should keep the owning requirement id');

    const differentOwner = searchWorkspaceSnapshot(makeSearchSnapshot(), 'feedback-attachment-token');
    expectEqual(differentOwner.results[0]?.source, WORKSPACE_SEARCH_SOURCE_TYPES.FEEDBACK, 'feedback attachment should not leak to requirements');
    expectEqual(differentOwner.results[0]?.recordId, 20, 'feedback attachment should keep the owning feedback id');

    const orphan = searchWorkspaceSnapshot(makeSearchSnapshot(), 'orphan-attachment-token');
    expectEqual(orphan.total, 0, 'attachments for missing owners should not create searchable intake hits');
  });
});
