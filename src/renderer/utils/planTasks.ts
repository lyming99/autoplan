import {
  isTaskAssociatedWithPlan,
  readPlanTaskAssociationFilePath,
  readPlanTaskAssociationPlanId,
} from '../types';
import type { Plan, PlanTask } from '../types';
import { formatDuration, getRunningDurationMs } from './time';


export type TimedPlanTask = Omit<PlanTask, 'file_path' | 'plan_id'> & {
  file_path?: string | null;
  plan_id?: number | null;
  started_at?: string | null;
  finished_at?: string | null;
  duration_ms?: number | null;
};

type TaskPlanGroupSource = 'plan' | 'file' | 'title' | 'unknown';

type TaskPlanGroupIdentity = {
  key: string;
  source: TaskPlanGroupSource;
  sourceId: string | null;
};

type TaskPlanGroupStats = {
  total: number;
  running: number;
  queued: number;
  completed: number;
};

export type TaskPlanGroup = TaskPlanGroupIdentity & {
  title: string;
  tasks: PlanTask[];
  firstIndex: number;
  sortSequence: number | null;
  sortTime: number | null;
  stats: TaskPlanGroupStats;
  hasRunningTask: boolean;
};

export type TaskStatusFilter = 'all' | 'running' | 'queued' | 'completed';

export type ParallelRunRequest = {
  plan: Plan;
  batches: Array<{ taskIds: number[] }>;
};

export const TASK_STATUS_FILTERS: Array<{ id: TaskStatusFilter; label: string; emptyText: string }> = [
  { id: 'all', label: '全部', emptyText: '暂无任务。' },
  { id: 'running', label: '进行中', emptyText: '暂无进行中任务。' },
  { id: 'queued', label: '队列中', emptyText: '暂无队列中任务。' },
  { id: 'completed', label: '已完成', emptyText: '暂无已完成任务。' },
];

function readDurationMs(task: TimedPlanTask) {
  if (task.duration_ms === null || typeof task.duration_ms === 'undefined') return null;
  const duration = Number(task.duration_ms);
  return Number.isFinite(duration) && duration >= 0 ? duration : null;
}

function getTaskDurationMs(task: TimedPlanTask) {
  if (task.status === 'running') return getRunningDurationMs(readDurationMs(task), task.started_at);
  return readDurationMs(task);
}

function readPlanId(task: TimedPlanTask) {
  return readPlanTaskAssociationPlanId(task);
}

export function formatTaskDuration(task: TimedPlanTask) {
  const duration = getTaskDurationMs(task);
  if (task.status === 'running') return `已运行 ${formatDuration(duration, '0秒')}`;
  if (duration === null || (duration === 0 && !task.started_at && !task.finished_at)) return '未开始';
  return `耗时 ${formatDuration(duration, '0秒')}`;
}

function normalizeTaskStatus(status: string | null | undefined) {
  return String(status || '').trim().toLowerCase();
}

export function matchesTaskStatusFilter(task: PlanTask | TimedPlanTask, filter: TaskStatusFilter) {
  const status = normalizeTaskStatus(task.status);
  if (filter === 'all') return true;
  if (filter === 'running') return ['running', 'processing', 'stopping'].includes(status);
  if (filter === 'queued') return ['pending', 'queued', 'waiting'].includes(status);
  if (filter === 'completed') return ['completed', 'done', 'passed', 'accepted'].includes(status);
  return true;
}

export function isTaskRunning(task: PlanTask | TimedPlanTask) {
  return matchesTaskStatusFilter(task, 'running');
}

function readTaskTime(value: string | null | undefined) {
  const time = Date.parse(String(value || ''));
  return Number.isFinite(time) ? time : null;
}

function taskSortTime(task: TimedPlanTask) {
  return readTaskTime(task.finished_at) ?? readTaskTime(task.started_at) ?? readTaskTime(task.updated_at);
}

type TaskSequenceCandidate = {
  task_key?: unknown;
  sort_order?: unknown;
};

function readPositiveTaskSequence(value: unknown) {
  const sequence = Number(value);
  return Number.isFinite(sequence) && sequence > 0 ? sequence : null;
}

function readTaskSortOrderSequence(task: TaskSequenceCandidate) {
  return readPositiveTaskSequence(task.sort_order);
}

function readTaskKeySequence(task: TaskSequenceCandidate) {
  const match = String(task.task_key || '').match(/\d+/);
  return match ? readPositiveTaskSequence(match[0]) : null;
}

export function readTaskSequence(task: TaskSequenceCandidate) {
  return readTaskSortOrderSequence(task) ?? readTaskKeySequence(task);
}

export function compareTasksBySequence(
  left: TaskSequenceCandidate,
  right: TaskSequenceCandidate,
  leftIndex: number,
  rightIndex: number,
) {
  const leftSequence = readTaskSequence(left);
  const rightSequence = readTaskSequence(right);
  if (leftSequence !== null && rightSequence !== null && leftSequence !== rightSequence) {
    return leftSequence - rightSequence;
  }
  if (leftSequence !== null && rightSequence === null) return -1;
  if (leftSequence === null && rightSequence !== null) return 1;
  return leftIndex - rightIndex;
}

function latestTaskTime(tasks: TimedPlanTask[]) {
  const fieldGroups: Array<Array<keyof TimedPlanTask>> = [['finished_at'], ['started_at'], ['updated_at']];
  for (const fields of fieldGroups) {
    const times = tasks.flatMap((task) => fields.map((field) => readTaskTime(task[field] as string | null | undefined)));
    const validTimes = times.filter((time): time is number => time !== null);
    if (validTimes.length) return Math.max(...validTimes);
  }
  return null;
}

function latestTaskActivityTime(tasks: TimedPlanTask[]) {
  const timeFields: Array<keyof TimedPlanTask> = ['finished_at', 'started_at', 'updated_at'];
  const times = tasks.flatMap((task) =>
    timeFields.map((field) => readTaskTime(task[field] as string | null | undefined)),
  );
  const validTimes = times.filter((time): time is number => time !== null);
  return validTimes.length ? Math.max(...validTimes) : null;
}

export function isTaskPlanGroupCompleted(group: TaskPlanGroup) {
  return group.stats.total > 0 && group.stats.completed >= group.stats.total;
}

export function formatTaskPlanGroupProgress(group: TaskPlanGroup) {
  return `进度：${group.stats.completed}/${group.stats.total}`;
}

function taskPlanGroupTitle(task: TimedPlanTask) {
  return String(task.plan_title || readPlanTaskAssociationFilePath(task) || '未命名计划').trim() || '未命名计划';
}

function taskPlanGroupIdentity(task: TimedPlanTask): TaskPlanGroupIdentity {
  const planId = readPlanId(task);
  if (planId !== null) return { key: `plan:${planId}`, source: 'plan', sourceId: String(planId) };
  const filePath = readPlanTaskAssociationFilePath(task);
  if (filePath) return { key: `file:${filePath}`, source: 'file', sourceId: filePath };
  const title = taskPlanGroupTitle(task);
  if (title !== '未命名计划') return { key: `title:${title}`, source: 'title', sourceId: title };
  return { key: 'unknown-plan', source: 'unknown', sourceId: null };
}

function getTaskPlanGroupStats(tasks: PlanTask[]): TaskPlanGroupStats {
  return tasks.reduce<TaskPlanGroupStats>(
    (stats, task) => ({
      total: stats.total + 1,
      running: stats.running + (matchesTaskStatusFilter(task, 'running') ? 1 : 0),
      queued: stats.queued + (matchesTaskStatusFilter(task, 'queued') ? 1 : 0),
      completed: stats.completed + (matchesTaskStatusFilter(task, 'completed') ? 1 : 0),
    }),
    { total: 0, running: 0, queued: 0, completed: 0 },
  );
}

function taskPlanGroupSortSequence(tasks: PlanTask[]) {
  const sequences = tasks
    .map((task) => readTaskSequence(task))
    .filter((sequence): sequence is number => sequence !== null);
  return sequences.length ? Math.min(...sequences) : null;
}

export function groupTasksByPlan(tasks: PlanTask[]): TaskPlanGroup[] {
  const groups = new Map<string, TaskPlanGroup>();
  tasks.forEach((task, index) => {
    const timedTask = task as TimedPlanTask;
    const identity = taskPlanGroupIdentity(timedTask);
    const key = identity.key;
    const existingGroup = groups.get(key);
    if (existingGroup) {
      existingGroup.tasks.push(task);
      if (existingGroup.title === '未命名计划') existingGroup.title = taskPlanGroupTitle(task);
      return;
    }

    groups.set(key, {
      key,
      source: identity.source,
      sourceId: identity.sourceId,
      title: taskPlanGroupTitle(task),
      tasks: [task],
      firstIndex: index,
      sortSequence: null,
      sortTime: null,
      stats: { total: 0, running: 0, queued: 0, completed: 0 },
      hasRunningTask: false,
    });
  });

  return Array.from(groups.values())
    .map((group) => {
      const indexedTasks = group.tasks.map((task, index) => ({ task, index }));
      const sortedTasks = indexedTasks
        .sort((left, right) => compareTasksBySequence(left.task, right.task, left.index, right.index))
        .map(({ task }) => task);
      return {
        ...group,
        tasks: sortedTasks,
        sortSequence: taskPlanGroupSortSequence(sortedTasks),
        sortTime: latestTaskActivityTime(sortedTasks),
        stats: getTaskPlanGroupStats(sortedTasks),
        hasRunningTask: sortedTasks.some(isTaskRunning),
      };
    })
    .sort((left, right) => {
      if (left.hasRunningTask !== right.hasRunningTask) return left.hasRunningTask ? -1 : 1;
      if (left.sortTime !== null && right.sortTime !== null && left.sortTime !== right.sortTime) {
        return right.sortTime - left.sortTime;
      }
      if (left.sortTime !== null && right.sortTime === null) return -1;
      if (left.sortTime === null && right.sortTime !== null) return 1;
      return left.firstIndex - right.firstIndex;
    });
}

export function tasksForPlan(tasks: PlanTask[], plan: Plan, planCount: number) {
  const timedTasks = tasks as TimedPlanTask[];
  const linkedTasks = timedTasks.filter((task) => isTaskAssociatedWithPlan(task, plan));
  const hasTaskAssociations = timedTasks.some(
    (task) => readPlanId(task) !== null || Boolean(readPlanTaskAssociationFilePath(task)),
  );
  if (!linkedTasks.length && !hasTaskAssociations && planCount === 1) return timedTasks;
  return linkedTasks;
}

export function hasRunningTaskForPlan(tasks: PlanTask[], plan: Plan, planCount: number) {
  return tasksForPlan(tasks, plan, planCount).some(isTaskRunning);
}

export function formatPlanDurationSummary(tasks: TimedPlanTask[]) {
  const totalMs = tasks.reduce((sum, task) => sum + (getTaskDurationMs(task) ?? 0), 0);
  const completedMs = tasks.reduce(
    (sum, task) => sum + (task.status === 'completed' ? getTaskDurationMs(task) ?? 0 : 0),
    0,
  );

  return `总耗时 ${formatDuration(totalMs, '0秒')} · 已完成 ${formatDuration(completedMs, '0秒')}`;
}

type PlanGenerationDurationSource = {
  plan_generation_duration_ms?: number | null;
};

function readPlanGenerationDurationMs(plan: PlanGenerationDurationSource) {
  const duration = Number(plan.plan_generation_duration_ms);
  return Number.isFinite(duration) && duration > 0 ? duration : null;
}

export function formatPlanGenerationDuration(plan: PlanGenerationDurationSource) {
  const duration = readPlanGenerationDurationMs(plan);
  return `生成耗时 ${duration === null ? '未记录' : formatDuration(duration, '未记录')}`;
}

export function planTitle(plan: Plan) {
  return String((plan as Plan & { title?: string | null }).title || '').trim();
}

export function scopeFileLabel(file: PlanTask['scope_files'][number]) {
  if (file.isUnknown) return 'unknown';
  if (file.isValidation) return 'validation';
  return file.path;
}

export function scopeFileStatus(file: PlanTask['scope_files'][number]) {
  if (file.isUnknown) return '无法判断影响范围';
  if (file.isValidation) return '完整验收任务';
  if (file.canOpen) return '可打开';
  return file.reason || (file.exists ? '不可打开' : '文件不存在');
}

export function scopeFileClassName(file: PlanTask['scope_files'][number]) {
  if (file.isUnknown) return 'unknown special';
  if (file.isValidation) return 'validation';
  if (file.canOpen) return 'openable';
  return '';
}

// ===== 验收（人工逐项验收）筛选/分组工具 =====
// 验收态与执行态 status 正交：accepted_at 为 NULL=未验收、非空 ISO 时间=已验收、清空即取消。
// 这里复用 matchesTaskStatusFilter 的「已完成」语义（不改其实现），不引入新的执行态取值。

export function isPlanCompleted(plan: Plan) {
  return normalizeTaskStatus(plan.status) === 'completed';
}

export function isTaskCompleted(task: PlanTask) {
  return matchesTaskStatusFilter(task, 'completed');
}

export function isAcceptancePendingPlan(plan: Plan) {
  return isPlanCompleted(plan) && !plan.accepted_at;
}

export function isAcceptancePendingTask(task: PlanTask) {
  return isTaskCompleted(task) && !task.accepted_at;
}

/** 多选 key 工具：与 recordId / 事件 meta 的 targetType+id 对齐，供视图选择态使用。 */
export function acceptanceSelectionKey(targetType: 'plan' | 'task', id: number): string {
  return `${targetType}:${id}`;
}

export interface AcceptanceGroup {
  plan: Plan;
  /** 该计划内「已完成且未验收」的任务，按待验收视图的时间排序语义排列。 */
  tasks: PlanTask[];
}

// 待验收/已验收列表保留时间降序：finished_at → started_at → updated_at，再回退原序。
function compareTasksBySortTime(left: TimedPlanTask, right: TimedPlanTask, leftIndex: number, rightIndex: number) {
  const leftTime = taskSortTime(left);
  const rightTime = taskSortTime(right);
  if (leftTime !== null && rightTime !== null && leftTime !== rightTime) return rightTime - leftTime;
  if (leftTime !== null && rightTime === null) return -1;
  if (leftTime === null && rightTime !== null) return 1;
  return leftIndex - rightIndex;
}

function planSortTime(plan: Plan): number | null {
  return readTaskTime(plan.updated_at) ?? readTaskTime(plan.created_at);
}

/**
 * 按计划分组的「待验收」结构：每个待验收计划（已完成且 accepted_at 为空）挂其下待验收任务。
 * 保持待验收视图自己的时间排序语义；不含已完成但已验收项，也不含未完成项。
 */
export function buildAcceptanceGroups(plans: Plan[], tasks: PlanTask[]): AcceptanceGroup[] {
  const pendingTasks = tasks.filter(isAcceptancePendingTask);
  return plans
    .filter(isAcceptancePendingPlan)
    .map((plan, planIndex) => {
      const linked = pendingTasks
        .map((task, taskIndex) => ({ task, taskIndex }))
        .filter((entry) => isTaskAssociatedWithPlan(entry.task, plan))
        .sort((left, right) => compareTasksBySortTime(left.task, right.task, left.taskIndex, right.taskIndex))
        .map((entry) => entry.task);
      const tasksTime = linked.length ? latestTaskTime(linked) : null;
      return { plan, tasks: linked, planIndex, sortTime: tasksTime ?? planSortTime(plan) };
    })
    .sort((left, right) => {
      if (left.sortTime !== null && right.sortTime !== null && left.sortTime !== right.sortTime) {
        return right.sortTime - left.sortTime;
      }
      if (left.sortTime !== null && right.sortTime === null) return -1;
      if (left.sortTime === null && right.sortTime !== null) return 1;
      return left.planIndex - right.planIndex;
    })
    .map(({ plan, tasks }) => ({ plan, tasks }));
}

export type AcceptedRecord =
  | { targetType: 'plan'; plan: Plan; acceptedAt: string }
  | { targetType: 'task'; task: PlanTask; acceptedAt: string };

function sortAcceptedByTimeDesc(left: AcceptedRecord, right: AcceptedRecord) {
  const leftTime = readTaskTime(left.acceptedAt);
  const rightTime = readTaskTime(right.acceptedAt);
  if (leftTime !== null && rightTime !== null && leftTime !== rightTime) return rightTime - leftTime;
  if (leftTime !== null && rightTime === null) return -1;
  if (leftTime === null && rightTime !== null) return 1;
  return 0;
}

/**
 * 「已验收（最近）」取数：把已验收的计划与任务合并为按 accepted_at 降序的扁平列表，供视图折叠区展示。
 * 默认不再截断为 50 条，返回全部已验收记录（完整历史）；保留 limit 参数供显式限量调用。
 */
export function buildRecentAccepted(plans: Plan[], tasks: PlanTask[], limit: number = Infinity): AcceptedRecord[] {
  const acceptedPlans = plans
    .filter((plan) => Boolean(plan.accepted_at))
    .map((plan) => ({ targetType: 'plan' as const, plan, acceptedAt: String(plan.accepted_at) }));
  const acceptedTasks = tasks
    .filter((task) => Boolean(task.accepted_at))
    .map((task) => ({ targetType: 'task' as const, task, acceptedAt: String(task.accepted_at) }));
  return [...acceptedPlans, ...acceptedTasks].sort(sortAcceptedByTimeDesc).slice(0, limit);
}

/** 「已完成验收」分组：结构对齐 AcceptanceGroup；plan 为 null 表示孤立已验收任务的「未分组」。 */
export interface AcceptedGroup {
  plan: Plan | null;
  tasks: PlanTask[];
}

/** 分组排序的「计划维度时间」：已验收计划取 accepted_at，否则回退到组内任务最新时间。 */
function acceptedGroupSortTime(plan: Plan | null, tasks: PlanTask[]): number | null {
  if (plan) {
    const acceptedAt = readTaskTime(plan.accepted_at);
    if (acceptedAt !== null) return acceptedAt;
  }
  return latestTaskTime(tasks);
}

/**
 * 按计划分组的「已完成验收」结构：每个已验收（accepted_at 非空）计划挂其下已验收任务。
 * 孤立已验收任务（所属计划未验收/不存在）按其关联计划聚合，找不到关联计划的归入 plan=null 的「未分组」，
 * 不丢失任何已验收项。组内任务排序与分组排序复用 buildAcceptanceGroups 的时间降序语义。
 */
export function buildAcceptedGroups(plans: Plan[], tasks: PlanTask[]): AcceptedGroup[] {
  const acceptedTasks = tasks.filter((task) => Boolean(task.accepted_at));
  const drafts = new Map<
    string,
    { plan: Plan | null; planIndex: number; firstTaskIndex: number; tasks: PlanTask[] }
  >();
  const order: string[] = [];
  const UNGROUPED_KEY = 'ungrouped-accepted';

  // 1) 先按输入顺序播种所有「已验收计划」分组（即便其下无已验收任务也要作为已验收项展示）。
  plans.forEach((plan, planIndex) => {
    if (!plan.accepted_at) return;
    const key = `plan:${plan.id}`;
    if (!drafts.has(key)) {
      drafts.set(key, { plan, planIndex, firstTaskIndex: Number.POSITIVE_INFINITY, tasks: [] });
      order.push(key);
    }
  });

  // 2) 归集已验收任务：有关联计划的并入对应计划（无论该计划是否已验收），否则进「未分组」。
  acceptedTasks.forEach((task, taskIndex) => {
    const associatedPlanIndex = plans.findIndex((plan) => isTaskAssociatedWithPlan(task, plan));
    const associatedPlan = associatedPlanIndex >= 0 ? plans[associatedPlanIndex] : null;
    const key = associatedPlan ? `plan:${associatedPlan.id}` : UNGROUPED_KEY;
    let draft = drafts.get(key);
    if (!draft) {
      draft = {
        plan: associatedPlan,
        planIndex: associatedPlan ? associatedPlanIndex : Number.POSITIVE_INFINITY,
        firstTaskIndex: taskIndex,
        tasks: [],
      };
      drafts.set(key, draft);
      order.push(key);
    }
    if (taskIndex < draft.firstTaskIndex) draft.firstTaskIndex = taskIndex;
    draft.tasks.push(task);
  });

  // 3) 组内任务按 finished_at → started_at → updated_at 降序，分组按计划维度时间降序。
  return order
    .map((key) => {
      const draft = drafts.get(key)!;
      const sortedTasks = draft.tasks
        .map((task, index) => ({ task, index }))
        .sort((left, right) =>
          compareTasksBySortTime(left.task, right.task, left.index, right.index),
        )
        .map(({ task }) => task);
      return {
        plan: draft.plan,
        planIndex: draft.planIndex,
        firstTaskIndex: draft.firstTaskIndex,
        sortTime: acceptedGroupSortTime(draft.plan, sortedTasks),
        tasks: sortedTasks,
      };
    })
    .sort((left, right) => {
      if (left.sortTime !== null && right.sortTime !== null && left.sortTime !== right.sortTime) {
        return right.sortTime - left.sortTime;
      }
      if (left.sortTime !== null && right.sortTime === null) return -1;
      if (left.sortTime === null && right.sortTime !== null) return 1;
      if (left.planIndex !== right.planIndex) return left.planIndex - right.planIndex;
      return left.firstTaskIndex - right.firstTaskIndex;
    })
    .map(({ plan, tasks }) => ({ plan, tasks }));
}
