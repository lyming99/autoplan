export {};

import { PLAN_STATUS, type PlanStatus } from '../types';

type TestRegistrar = (name: string, fn: () => void) => void;

declare function require(id: string): unknown;

const { describe, it } = require('node:test') as { describe: TestRegistrar; it: TestRegistrar };

function expect(condition: unknown, message: string) {
  if (!condition) throw new Error(message);
}

function expectEqual(actual: unknown, expected: unknown, _message?: string) {
  if (actual !== expected) {
    const a = typeof actual === 'string' ? JSON.stringify(actual) : String(actual);
    const e = typeof expected === 'string' ? JSON.stringify(expected) : String(expected);
    throw new Error(`Expected ${a} to equal ${e}`);
  }
}

function expectDefined(value: unknown, message: string) {
  if (value === undefined || value === null) throw new Error(message);
}

function expectAtLeast(value: unknown, min: number, message: string) {
  if (!Array.isArray(value)) throw new Error(`Expected array, got ${typeof value}: ${message}`);
  if (value.length < min) throw new Error(`${message}: expected >= ${min}, got ${value.length}`);
}

function expectLength(value: unknown, expectedLen: number, message: string) {
  if (!Array.isArray(value)) throw new Error(`Expected array, got ${typeof value}: ${message}`);
  if (value.length !== expectedLen) throw new Error(`${message}: expected ${expectedLen}, got ${value.length}`);
}

// ---------------------------------------------------------------------------
// Fixture builders — construct minimal but valid Plan / PlanTask shapes
// ---------------------------------------------------------------------------

let planNextId = 1;
let taskNextId = 1;

function iso(ts: string) {
  return new Date(ts).toISOString();
}

function makePlan(overrides: Record<string, unknown> = {}) {
  const id = (overrides.id as number) ?? planNextId++;
  const ts = (overrides.created_at as string) ?? iso(`2026-06-${String(id).padStart(2, '0')}T10:00:00Z`);
  return {
    id,
    project_id: (overrides.project_id as number) ?? 1,
    issue_hash: `hash-${id}`,
    file_path: (overrides.file_path as string) ?? `/plans/plan-${id}.md`,
    title: (overrides.title as string | undefined) ?? `Plan ${id}`,
    hash: `sha-${id}`,
    status: (overrides.status as PlanStatus) ?? PLAN_STATUS.COMPLETED,
    sort_order: (overrides.sort_order as number) ?? id,
    is_draft: false,
    plan_generation_duration_ms: (overrides.plan_generation_duration_ms as number) ?? 0,
    total_tasks: (overrides.total_tasks as number) ?? 3,
    completed_tasks: (overrides.completed_tasks as number) ?? 3,
    validation_passed: (overrides.validation_passed as number) ?? 0,
    concurrency_suggestion: { hasSafeParallelBatches: false, parallelTaskCount: 0, batchCount: 0, serialTaskCount: 0, maxParallelTasks: 1, batches: [], serialTasks: [] },
    created_at: ts,
    updated_at: (overrides.updated_at as string) ?? iso(`2026-06-${String(id).padStart(2, '0')}T12:00:00Z`),
    accepted_at: (overrides.accepted_at as string | null | undefined) === undefined ? null : (overrides.accepted_at as string | null),
  };
}

function makeTask(overrides: Record<string, unknown> = {}) {
  const id = (overrides.id as number) ?? taskNextId++;
  const planId = (overrides.plan_id as number) ?? 1;
  const ts = iso(`2026-06-${String(id).padStart(2, '0')}T12:00:00Z`);
  return {
    id,
    plan_id: planId,
    task_key: `T-${id}`,
    title: (overrides.title as string) ?? `Task ${id}`,
    raw_line: `- [ ] Task ${id}`,
    scope: 'src/file.ts',
    scope_files: [],
    status: (overrides.status as string) ?? 'completed',
    sort_order: (overrides.sort_order as number) ?? id,
    started_at: (overrides.started_at as string | null) ?? null,
    finished_at: (overrides.finished_at as string | null) ?? ts,
    duration_ms: (overrides.duration_ms as number) ?? 1000,
    codex_session_id: null,
    updated_at: ts,
    accepted_at: (overrides.accepted_at as string | null | undefined) === undefined ? null : (overrides.accepted_at as string | null),
    file_path: (overrides.file_path as string) ?? `/plans/plan-${planId}.md`,
    plan_title: (overrides.plan_title as string) ?? `Plan Title ${planId}`,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const {
  buildAcceptedGroups,
  buildAcceptanceGroups,
  buildRecentAccepted,
  groupTasksByPlan,
  isAcceptancePendingPlan,
  isAcceptancePendingTask,
  acceptanceSelectionKey,
  formatPlanDurationSummary,
  formatPlanGenerationDuration,
  scopeFileClassName,
  scopeFileLabel,
  scopeFileStatus,
} = require('./planTasks.ts') as typeof import('./planTasks');

function sortedAcceptDates(groups: Array<{ plan: { accepted_at?: string | null } | null; tasks: Array<{ accepted_at?: string | null }> }>) {
  const dates = groups.flatMap((g) => [
    ...(g.plan?.accepted_at ? [g.plan.accepted_at] : []),
    ...g.tasks.map((t) => t.accepted_at).filter(Boolean),
  ]);
  return dates;
}

describe('P006 - plan generation duration formatting', () => {
  it('formats recorded generation duration with the existing duration style', () => {
    expectEqual(formatPlanGenerationDuration(makePlan({ plan_generation_duration_ms: 65000 })), '生成耗时 1分5秒');
  });

  it('uses a clear fallback for missing, zero, or invalid old data', () => {
    expectEqual(formatPlanGenerationDuration({}), '生成耗时 未记录');
    expectEqual(formatPlanGenerationDuration(makePlan({ plan_generation_duration_ms: 0 })), '生成耗时 未记录');
    expectEqual(formatPlanGenerationDuration({ plan_generation_duration_ms: Number.NaN }), '生成耗时 未记录');
  });

  it('keeps generation duration out of task duration summaries', () => {
    const plan = makePlan({ id: 99, plan_generation_duration_ms: 65000 });
    const tasks = [makeTask({ plan_id: plan.id, status: 'completed', duration_ms: 1000 })];

    expectEqual(formatPlanGenerationDuration(plan), '生成耗时 1分5秒');
    expectEqual(formatPlanDurationSummary(tasks), '总耗时 1秒 · 已完成 1秒');
  });
});
describe('Requirement #52 – groupTasksByPlan running/activity sorting', () => {
  it('sorts tasks within a plan group by sort_order before task activity time', () => {
    const tasks = [
      makeTask({
        id: 3,
        plan_id: 1,
        task_key: 'P003',
        sort_order: 3,
        finished_at: iso('2026-07-03T12:00:00Z'),
        updated_at: iso('2026-07-03T12:00:00Z'),
      }),
      makeTask({
        id: 1,
        plan_id: 1,
        task_key: 'P001',
        sort_order: 1,
        finished_at: iso('2026-07-01T12:00:00Z'),
        updated_at: iso('2026-07-01T12:00:00Z'),
      }),
      makeTask({
        id: 2,
        plan_id: 1,
        task_key: 'P002',
        sort_order: 2,
        finished_at: iso('2026-07-02T12:00:00Z'),
        updated_at: iso('2026-07-02T12:00:00Z'),
      }),
    ];

    const groups = groupTasksByPlan(tasks);

    expectLength(groups, 1, 'all tasks should be in one plan group');
    expectEqual(groups[0].tasks.map((task) => task.task_key).join(','), 'P001,P002,P003');
  });

  it('sorts running groups first and then by latest group activity time', () => {
    const completedNewest = makeTask({
      id: 1,
      plan_id: 1,
      plan_title: 'Completed newest plan',
      task_key: 'P001',
      sort_order: 1,
      status: 'completed',
      finished_at: iso('2026-07-05T12:00:00Z'),
      updated_at: iso('2026-07-05T12:00:00Z'),
    });
    const queuedOldest = makeTask({
      id: 2,
      plan_id: 2,
      plan_title: 'Queued oldest plan',
      task_key: 'P002',
      sort_order: 2,
      status: 'pending',
      started_at: null,
      finished_at: null,
      updated_at: iso('2026-07-01T12:00:00Z'),
    });
    const runningOlder = makeTask({
      id: 10,
      plan_id: 10,
      plan_title: 'Running older plan',
      task_key: 'P010',
      sort_order: 10,
      status: 'running',
      started_at: iso('2026-07-02T12:00:00Z'),
      finished_at: null,
      updated_at: iso('2026-07-02T12:00:00Z'),
    });
    const stoppingNewer = makeTask({
      id: 11,
      plan_id: 11,
      plan_title: 'Stopping newer plan',
      task_key: 'P011',
      sort_order: 11,
      status: 'stopping',
      started_at: iso('2026-07-04T12:00:00Z'),
      finished_at: null,
      updated_at: iso('2026-07-04T12:00:00Z'),
    });

    const groups = groupTasksByPlan([completedNewest, runningOlder, queuedOldest, stoppingNewer]);

    expectLength(groups, 4, 'tasks should be split into four plan groups');
    expectEqual(groups.map((group) => group.sourceId).join(','), '11,10,1,2');
    expectEqual(groups.map((group) => String(group.hasRunningTask)).join(','), 'true,true,false,false');
  });

  it('sorts non-running plan groups by latest activity instead of minimum task sequence', () => {
    const newerLateSequence = makeTask({
      id: 10,
      plan_id: 10,
      plan_title: 'Late sequence plan',
      task_key: 'P010',
      sort_order: 10,
      finished_at: iso('2026-07-03T12:00:00Z'),
      updated_at: iso('2026-07-03T12:00:00Z'),
    });
    const olderEarlySequence = makeTask({
      id: 1,
      plan_id: 1,
      plan_title: 'Early sequence plan',
      task_key: 'P001',
      sort_order: 1,
      finished_at: iso('2026-07-01T12:00:00Z'),
      updated_at: iso('2026-07-01T12:00:00Z'),
    });

    const groups = groupTasksByPlan([newerLateSequence, olderEarlySequence]);

    expectLength(groups, 2, 'tasks should be split into two plan groups');
    expectEqual(groups[0].sourceId, '10');
    expectEqual(groups[1].sourceId, '1');
  });

  it('falls back to numeric task_key sequence when sort_order is missing or invalid inside a group', () => {
    const missingSortOrder = makeTask({ id: 1, plan_id: 1, task_key: 'P001' });
    delete (missingSortOrder as { sort_order?: number }).sort_order;

    const tasks = [
      makeTask({ id: 10, plan_id: 1, task_key: 'TASK-10', sort_order: 0 }),
      missingSortOrder,
      makeTask({ id: 2, plan_id: 1, task_key: 'P002', sort_order: Number.NaN }),
    ];

    const groups = groupTasksByPlan(tasks);

    expectLength(groups, 1, 'all fallback tasks should be in one plan group');
    expectEqual(groups[0].tasks.map((task) => task.task_key).join(','), 'P001,P002,TASK-10');
  });

  it('keeps input order stable when neither group activity time nor sequence yields an order', () => {
    const first = makeTask({ id: 21, plan_id: 101, task_key: 'ALPHA', sort_order: 0, started_at: '', finished_at: '', updated_at: '' });
    const second = makeTask({ id: 22, plan_id: 102, task_key: 'BETA', sort_order: Number.NaN, started_at: '', finished_at: '', updated_at: '' });
    const third = makeTask({ id: 23, plan_id: 103, task_key: 'GAMMA', sort_order: -1, started_at: '', finished_at: '', updated_at: '' });

    const groups = groupTasksByPlan([second, first, third]);

    expectLength(groups, 3, 'tasks without ordering signals should remain in separate plan groups');
    expectEqual(groups.map((group) => group.sourceId).join(','), '102,101,103');
  });
});

describe('P001 – buildAcceptedGroups grouped construction', () => {
  it('aggregates accepted plans with their accepted tasks into AcceptedGroup', () => {
    const p1 = makePlan({ id: 1, accepted_at: iso('2026-07-01T10:00:00Z') });
    const t1 = makeTask({ id: 1, plan_id: 1, accepted_at: iso('2026-07-01T10:05:00Z') });
    const t2 = makeTask({ id: 2, plan_id: 1, accepted_at: iso('2026-07-01T10:10:00Z') });

    const groups = buildAcceptedGroups([p1], [t1, t2]);
    expectAtLeast(groups, 1, 'should have at least 1 group for the accepted plan');

    const group = groups[0];
    expectDefined(group.plan, 'group should have a plan');
    expectEqual(group.plan!.id, 1);
    expectLength(group.tasks, 2, 'both accepted tasks should belong to the plan group');
    expectEqual(group.tasks[0].id, 1);
    expectEqual(group.tasks[1].id, 2);
  });

  it('sorts tasks within a group by finished_at descending, then started_at, then updated_at', () => {
    const p1 = makePlan({ id: 1, accepted_at: iso('2026-07-01T10:00:00Z') });
    // t3 finished later → should appear first
    const t3 = makeTask({ id: 3, plan_id: 1, finished_at: iso('2026-07-01T15:00:00Z'), accepted_at: iso('2026-07-01T15:00:00Z') });
    const t1 = makeTask({ id: 1, plan_id: 1, finished_at: iso('2026-07-01T10:00:00Z'), accepted_at: iso('2026-07-01T10:00:00Z') });

    const groups = buildAcceptedGroups([p1], [t3, t1]);
    expectEqual(groups[0].tasks[0].id, 3);
    expectEqual(groups[0].tasks[1].id, 1);
  });

  it('sorts groups by accepted_at descending (plan dimension time)', () => {
    const pEarly = makePlan({ id: 1, accepted_at: iso('2026-07-01T10:00:00Z') });
    const pLate = makePlan({ id: 2, accepted_at: iso('2026-07-02T10:00:00Z') });

    const groups = buildAcceptedGroups([pEarly, pLate], []);
    // pLate accepted later → should appear first
    expectEqual(groups[0].plan!.id, 2);
    expectEqual(groups[1].plan!.id, 1);
  });

  it('includes accepted plans even when they have no accepted tasks', () => {
    const p1 = makePlan({ id: 1, accepted_at: iso('2026-07-01T10:00:00Z') });
    const groups = buildAcceptedGroups([p1], []);
    expectLength(groups, 1, 'accepted plan should appear as a group');
    expectEqual(groups[0].plan!.id, 1);
    expectLength(groups[0].tasks, 0, 'group should have zero tasks');
  });

  it('groups accepted tasks under unaccepted plans by associated plan', () => {
    // Plan is NOT accepted, but its tasks are accepted.
    const p1 = makePlan({ id: 1, accepted_at: null, status: 'completed' });
    const t1 = makeTask({ id: 1, plan_id: 1, accepted_at: iso('2026-07-01T10:00:00Z') });

    const groups = buildAcceptedGroups([p1], [t1]);
    expectAtLeast(groups, 1, 'orphan accepted task should create a group under its unaccepted plan');
    const group = groups[0];
    expectDefined(group.plan, 'group should reference the unaccepted plan');
    expectEqual(group.plan!.id, 1);
    expectLength(group.tasks, 1, 'accepted task should be in the group');
    // Plan is not accepted → plan.accepted_at is null
    expectEqual(group.plan!.accepted_at, null);
  });

  it('places orphan accepted tasks with no associated plan into plan=null ungrouped bucket', () => {
    // Task with plan_id that doesn't match any plan in the list
    const t1 = makeTask({ id: 99, plan_id: 999, accepted_at: iso('2026-07-01T10:00:00Z'), file_path: '/orphan.md' });
    const groups = buildAcceptedGroups([], [t1]);

    expectAtLeast(groups, 1, 'orphan task should appear in a group');
    const ungrouped = groups.find((g: { plan: unknown }) => g.plan === null)!;
    expectDefined(ungrouped, 'ungrouped bucket (plan=null) should exist for orphan tasks');
    expectLength(ungrouped.tasks, 1, 'orphan task should be in ungrouped bucket');
    expectEqual(ungrouped.tasks[0].id, 99);
  });

  it('does not lose any accepted item — >50 items returned without truncation', () => {
    const planCount = 30;
    const taskCount = 50;
    const plans = Array.from({ length: planCount }, (_, i) =>
      makePlan({ id: i + 1, accepted_at: iso(`2026-07-${String(i + 1).padStart(2, '0')}T10:00:00Z`) }),
    );
    const tasks = Array.from({ length: taskCount }, (_, i) =>
      makeTask({ id: i + 1, plan_id: (i % planCount) + 1, accepted_at: iso(`2026-07-${String(i + 1).padStart(2, '0')}T12:00:00Z`) }),
    );

    const groups = buildAcceptedGroups(plans, tasks);
    const totalPlans = groups.filter((g: { plan: { accepted_at: unknown } | null }) => g.plan && g.plan.accepted_at).length;
    const totalTasks = groups.reduce((sum: number, g: { tasks: unknown[] }) => sum + g.tasks.length, 0);

    expectEqual(totalPlans, planCount);
    expectEqual(totalTasks, taskCount);
    expect(totalPlans + totalTasks > 50, `expected ${totalPlans + totalTasks} > 50 items – no truncation`);
  });

  it('AcceptedGroup type is exported and its shape matches { plan: Plan | null, tasks: PlanTask[] }', () => {
    // Structural check: verify the export exists and produces the right shape.
    const p1 = makePlan({ id: 1, accepted_at: iso('2026-07-01') });
    const groups = buildAcceptedGroups([p1], []);
    const group = groups[0];
    expect('plan' in group, 'group should have plan property');
    expect('tasks' in group, 'group should have tasks property');
    expect(Array.isArray(group.tasks), 'tasks should be an array');
  });
});

describe('P001 – buildRecentAccepted unlimited by default', () => {
  it('returns all accepted records by default, not truncated to 50', () => {
    const plans = Array.from({ length: 30 }, (_, i) =>
      makePlan({ id: i + 1, accepted_at: iso(`2026-07-${String(i + 1).padStart(2, '0')}T10:00:00Z`) }),
    );
    const tasks = Array.from({ length: 40 }, (_, i) =>
      makeTask({ id: i + 1, plan_id: (i % 10) + 1, accepted_at: iso(`2026-07-${String(i + 1).padStart(2, '0')}T12:00:00Z`) }),
    );

    const records = buildRecentAccepted(plans, tasks);
    expectEqual(records.length, 70, 'default should return all 70 accepted records (not truncated to 50)');
  });

  it('still respects an explicit limit when passed', () => {
    const plans = Array.from({ length: 10 }, (_, i) =>
      makePlan({ id: i + 1, accepted_at: iso(`2026-07-${String(i + 1).padStart(2, '0')}T10:00:00Z`) }),
    );

    const records = buildRecentAccepted(plans, [], 3);
    expectEqual(records.length, 3, 'explicit limit of 3 should be respected');
  });

  it('sorts by accepted_at descending (same semantics as before)', () => {
    const pEarly = makePlan({ id: 1, accepted_at: iso('2026-07-01T10:00:00Z') });
    const pLate = makePlan({ id: 2, accepted_at: iso('2026-07-02T10:00:00Z') });

    const records = buildRecentAccepted([pEarly, pLate], []);
    expectEqual(records[0].acceptedAt, pLate.accepted_at);
    expectEqual(records[1].acceptedAt, pEarly.accepted_at);
  });
});

describe('Existing acceptance-group exports preserved (no signature break)', () => {
  it('buildAcceptanceGroups still groups pending plans with pending tasks', () => {
    const p1 = makePlan({ id: 1, status: 'completed', accepted_at: null });
    const t1 = makeTask({ id: 1, plan_id: 1, status: 'completed', accepted_at: null });

    const groups = buildAcceptanceGroups([p1], [t1]);
    expectAtLeast(groups, 1, 'pending (accepted_at-null) completed plan should appear');
    expectEqual(groups[0].plan.id, 1);
    expectLength(groups[0].tasks, 1, 'pending task should be under its plan');
  });

  it('buildAcceptanceGroups excludes already-accepted items', () => {
    const p1 = makePlan({ id: 1, status: 'completed', accepted_at: iso('2026-07-01') });
    const t1 = makeTask({ id: 1, plan_id: 1, status: 'completed', accepted_at: iso('2026-07-01') });

    const groups = buildAcceptanceGroups([p1], [t1]);
    expectLength(groups, 0, 'already-accepted plan should not appear in pending groups');
  });

  it('isAcceptancePendingPlan returns true for completed plans with no accepted_at', () => {
    const plan = makePlan({ id: 1, status: 'completed', accepted_at: null });
    expect(isAcceptancePendingPlan(plan), 'completed + null accepted_at → pending');
  });

  it('isAcceptancePendingTask returns true for completed tasks with no accepted_at', () => {
    const task = makeTask({ id: 1, status: 'completed', accepted_at: null });
    expect(isAcceptancePendingTask(task), 'completed + null accepted_at → pending');
  });

  it('acceptanceSelectionKey returns the same key format for both target types', () => {
    expectEqual(acceptanceSelectionKey('plan', 1), 'plan:1');
    expectEqual(acceptanceSelectionKey('task', 42), 'task:42');
  });
});

describe('AcceptedRecord type backwards-compat in buildRecentAccepted', () => {
  it('AcceptedRecord targetType is "plan" for plan records and "task" for task records', () => {
    const p1 = makePlan({ id: 1, accepted_at: iso('2026-07-01') });
    const t1 = makeTask({ id: 1, plan_id: 1, accepted_at: iso('2026-07-01') });

    const records = buildRecentAccepted([p1], [t1]);
    const planRec = records.find((r: { targetType: string }) => r.targetType === 'plan');
    const taskRec = records.find((r: { targetType: string }) => r.targetType === 'task');
    expectDefined(planRec, 'should have a plan-type AcceptedRecord');
    expectDefined(taskRec, 'should have a task-type AcceptedRecord');
  });
});

describe('Task scope file display semantics', () => {
  function scopeFile(overrides: Record<string, unknown> = {}) {
    return {
      path: (overrides.path as string) ?? 'src/renderer/App.tsx',
      exists: (overrides.exists as boolean) ?? true,
      isDirectory: (overrides.isDirectory as boolean) ?? false,
      canOpen: (overrides.canOpen as boolean) ?? false,
      isUnknown: (overrides.isUnknown as boolean) ?? false,
      isValidation: (overrides.isValidation as boolean) ?? false,
      reason: (overrides.reason as string) ?? '',
    };
  }

  it('keeps openable scope files visibly openable without changing their label', () => {
    const file = scopeFile({ canOpen: true, path: 'src/renderer/pages/WorkspacePage.tsx' });

    expectEqual(scopeFileLabel(file), 'src/renderer/pages/WorkspacePage.tsx');
    expectEqual(scopeFileStatus(file), '可打开');
    expectEqual(scopeFileClassName(file), 'openable');
  });

  it('keeps unknown and validation scopes readonly semantic states', () => {
    const unknown = scopeFile({ path: 'unknown', isUnknown: true, reason: '无法判断影响范围' });
    const validation = scopeFile({ path: 'validation', isValidation: true, reason: '完整验收任务' });

    expectEqual(scopeFileLabel(unknown), 'unknown');
    expectEqual(scopeFileStatus(unknown), '无法判断影响范围');
    expectEqual(scopeFileClassName(unknown), 'unknown special');
    expectEqual(scopeFileLabel(validation), 'validation');
    expectEqual(scopeFileStatus(validation), '完整验收任务');
    expectEqual(scopeFileClassName(validation), 'validation');
  });

  it('keeps missing and non-openable scopes out of the openable class', () => {
    const missing = scopeFile({ exists: false, reason: '' });
    const directory = scopeFile({ isDirectory: true, reason: '路径指向目录，不能作为文件打开' });

    expectEqual(scopeFileStatus(missing), '文件不存在');
    expectEqual(scopeFileClassName(missing), '');
    expectEqual(scopeFileStatus(directory), '路径指向目录，不能作为文件打开');
    expectEqual(scopeFileClassName(directory), '');
  });
});
