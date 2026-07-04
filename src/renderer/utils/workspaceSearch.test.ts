export {};

import { WORKSPACE_SEARCH_SOURCE_TYPES, type AppSnapshot, type Plan, type PlanTask, type WorkspaceSearchResult } from '../types';
import { createEmptyWorkspaceSearchState, groupWorkspaceSearchResults } from './search';
import {
  createFilteredWorkspaceItems,
  filterTasksByWorkspaceSearch,
} from './workspaceSearch';

type TestRegistrar = (name: string, fn: () => void) => void;

declare function require(id: string): unknown;

const { describe, it } = require('node:test') as { describe: TestRegistrar; it: TestRegistrar };

function expect(condition: unknown, message: string) {
  if (!condition) throw new Error(message);
}

function expectEqual(actual: unknown, expected: unknown, message: string) {
  if (actual !== expected) throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
}

function makePlan(id: number, filePath: string): Plan {
  return {
    id,
    project_id: 1,
    issue_hash: `issue-${id}`,
    file_path: filePath,
    title: `Plan ${id}`,
    hash: `hash-${id}`,
    status: 'completed',
    sort_order: id,
    is_draft: false,
    total_tasks: 1,
    completed_tasks: 1,
    validation_passed: 1,
    concurrency_suggestion: { hasSafeParallelBatches: false, parallelTaskCount: 0, batchCount: 0, serialTaskCount: 0, maxParallelTasks: 1, batches: [], serialTasks: [] },
    created_at: '2026-07-04T00:00:00.000Z',
    updated_at: '2026-07-04T00:00:00.000Z',
    accepted_at: null,
  };
}

function makeTask(id: number, planId: number | null, filePath: string): PlanTask {
  return {
    id,
    plan_id: planId,
    task_key: `P${String(id).padStart(3, '0')}`,
    title: `Task ${id}`,
    raw_line: `- [ ] Task ${id}`,
    scope: 'src/task.ts',
    scope_files: [],
    status: 'pending',
    sort_order: id,
    started_at: null,
    finished_at: null,
    duration_ms: 0,
    codex_session_id: null,
    updated_at: '2026-07-04T00:00:00.000Z',
    accepted_at: null,
    file_path: filePath,
    plan_title: `Plan ${planId ?? 'file'}`,
  } as unknown as PlanTask;
}

function searchState(results: WorkspaceSearchResult[]) {
  return {
    query: { raw: 'token', normalized: 'token', terms: ['token'], isEmpty: false },
    total: results.length,
    results,
    groups: groupWorkspaceSearchResults(results),
  };
}

function result(source: WorkspaceSearchResult['source'], recordId: number): WorkspaceSearchResult {
  return {
    id: `${source}:${recordId}`,
    source,
    targetTab: source === WORKSPACE_SEARCH_SOURCE_TYPES.EVENT ? 'events' : 'tasks',
    location: {
      targetTab: source === WORKSPACE_SEARCH_SOURCE_TYPES.EVENT ? 'events' : 'tasks',
      targetType: source,
      targetId: recordId,
      anchorId: `workspace-${source}-${recordId}`,
      scrollBehavior: 'smooth',
      highlightMs: 2400,
    },
    targetType: source,
    targetId: recordId,
    anchorId: `workspace-${source}-${recordId}`,
    recordId,
    title: `${source} ${recordId}`,
    summary: '',
    status: null,
    updatedAt: '2026-07-04T00:00:00.000Z',
    matches: [],
  };
}

describe('P009 workspaceSearch derived filtering path', () => {
  it('returns original snapshot collections for empty search without rebuilding candidates', () => {
    const snapshot = {
      requirements: [{ id: 1 }],
      feedback: [{ id: 2 }],
      plans: [makePlan(3, 'docs/plan/3.md')],
      tasks: [makeTask(4, 3, 'docs/plan/3.md')],
      events: [{ id: 5 }],
    } as unknown as AppSnapshot;

    const filtered = createFilteredWorkspaceItems(snapshot, createEmptyWorkspaceSearchState(''));

    expect(filtered.requirements === snapshot.requirements, 'empty search should reuse requirement array');
    expect(filtered.feedback === snapshot.feedback, 'empty search should reuse feedback array');
    expect(filtered.plans === snapshot.plans, 'empty search should reuse plan array');
    expect(filtered.tasks === snapshot.tasks, 'empty search should reuse task array');
    expect(filtered.events === snapshot.events, 'empty search should reuse event array');
  });

  it('includes direct task hits and plan-associated tasks once when a plan result is selected', () => {
    const targetPlan = makePlan(10, 'docs/plan/target.md');
    const directAndPlanTask = makeTask(1, 10, 'docs/plan/target.md');
    const fileAssociatedTask = makeTask(2, null, 'docs/plan/target.md');
    const unrelatedTask = makeTask(3, 99, 'docs/plan/other.md');
    const state = searchState([
      result(WORKSPACE_SEARCH_SOURCE_TYPES.TASK, directAndPlanTask.id),
      result(WORKSPACE_SEARCH_SOURCE_TYPES.PLAN, targetPlan.id),
    ]);

    const tasks = filterTasksByWorkspaceSearch(
      [directAndPlanTask, fileAssociatedTask, unrelatedTask],
      [targetPlan],
      state,
    );

    expectEqual(tasks.map((task) => task.id).join(','), '1,2', 'task filtering should merge direct and plan-associated tasks without duplicates');
  });

  it('keeps task filtering limited to direct task hits when no matching plan remains', () => {
    const directTask = makeTask(1, 10, 'docs/plan/target.md');
    const samePlanTask = makeTask(2, 10, 'docs/plan/target.md');
    const state = searchState([result(WORKSPACE_SEARCH_SOURCE_TYPES.TASK, directTask.id)]);

    const tasks = filterTasksByWorkspaceSearch([directTask, samePlanTask], [], state);

    expectEqual(tasks.map((task) => task.id).join(','), '1', 'without a matched plan only direct task hits should remain');
  });
});
