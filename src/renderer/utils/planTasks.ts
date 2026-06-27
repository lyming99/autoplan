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

export function matchesTaskStatusFilter(task: PlanTask, filter: TaskStatusFilter) {
  const status = normalizeTaskStatus(task.status);
  if (filter === 'all') return true;
  if (filter === 'running') return ['running', 'processing', 'stopping'].includes(status);
  if (filter === 'queued') return ['pending', 'queued', 'waiting'].includes(status);
  if (filter === 'completed') return ['completed', 'done', 'passed', 'accepted'].includes(status);
  return true;
}

function readTaskTime(value: string | null | undefined) {
  const time = Date.parse(String(value || ''));
  return Number.isFinite(time) ? time : null;
}

function taskSortTime(task: TimedPlanTask) {
  return readTaskTime(task.finished_at) ?? readTaskTime(task.started_at) ?? readTaskTime(task.updated_at);
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
      sortTime: null,
      stats: { total: 0, running: 0, queued: 0, completed: 0 },
      hasRunningTask: false,
    });
  });

  return Array.from(groups.values())
    .map((group) => {
      const indexedTasks = group.tasks.map((task, index) => ({ task, index }));
      const sortedTasks = indexedTasks
        .sort((left, right) => {
          const leftTime = taskSortTime(left.task as TimedPlanTask);
          const rightTime = taskSortTime(right.task as TimedPlanTask);
          if (leftTime !== null && rightTime !== null && leftTime !== rightTime) return rightTime - leftTime;
          if (leftTime !== null && rightTime === null) return -1;
          if (leftTime === null && rightTime !== null) return 1;
          return left.index - right.index;
        })
        .map(({ task }) => task);
      return {
        ...group,
        tasks: sortedTasks,
        sortTime: latestTaskTime(group.tasks as TimedPlanTask[]),
        stats: getTaskPlanGroupStats(sortedTasks),
        hasRunningTask: sortedTasks.some((task) => matchesTaskStatusFilter(task, 'running')),
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

export function formatPlanDurationSummary(tasks: TimedPlanTask[]) {
  const totalMs = tasks.reduce((sum, task) => sum + (getTaskDurationMs(task) ?? 0), 0);
  const completedMs = tasks.reduce(
    (sum, task) => sum + (task.status === 'completed' ? getTaskDurationMs(task) ?? 0 : 0),
    0,
  );

  return `总耗时 ${formatDuration(totalMs, '0秒')} · 已完成 ${formatDuration(completedMs, '0秒')}`;
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
