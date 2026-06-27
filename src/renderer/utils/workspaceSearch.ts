import {
  WORKSPACE_SEARCH_SOURCE_TYPES,
  readPlanTaskAssociationFilePath,
  readPlanTaskAssociationPlanId,
} from '../types';
import type {
  AppSnapshot,
  Plan,
  PlanTask,
  WorkspaceSearchGroup,
  WorkspaceSearchSourceType,
  WorkspaceSearchState,
} from '../types';
import { agentCliProviderLabel, readAgentCliProvider } from '../components/shared';

export const searchNoMatchText = '没有匹配结果。';

export type WorkspaceFilterableItems = Pick<AppSnapshot, 'requirements' | 'feedback' | 'plans' | 'tasks' | 'events'>;

export function normalizeSearchQuery(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

export function createFilteredWorkspaceItems(
  snapshot: AppSnapshot | null | undefined,
  searchState: WorkspaceSearchState,
): WorkspaceFilterableItems {
  if (!snapshot) {
    return { requirements: [], feedback: [], plans: [], tasks: [], events: [] };
  }
  if (searchState.query.isEmpty) {
    return {
      requirements: snapshot.requirements,
      feedback: snapshot.feedback,
      plans: snapshot.plans,
      tasks: snapshot.tasks,
      events: snapshot.events,
    };
  }

  const plans = filterItemsBySearchGroup(snapshot.plans, searchState.groups, WORKSPACE_SEARCH_SOURCE_TYPES.PLAN);
  const tasks = filterTasksBySearchGroups(snapshot.tasks, plans, searchState.groups);

  return {
    requirements: filterItemsBySearchGroup(
      snapshot.requirements,
      searchState.groups,
      WORKSPACE_SEARCH_SOURCE_TYPES.REQUIREMENT,
    ),
    feedback: filterItemsBySearchGroup(snapshot.feedback, searchState.groups, WORKSPACE_SEARCH_SOURCE_TYPES.FEEDBACK),
    plans,
    tasks,
    events: filterItemsBySearchGroup(snapshot.events, searchState.groups, WORKSPACE_SEARCH_SOURCE_TYPES.EVENT),
  };
}

export function filterItemsBySearchGroup<T extends { id: number }>(
  items: T[],
  groups: WorkspaceSearchGroup[],
  source: WorkspaceSearchSourceType,
) {
  const group = groups.find((item) => item.source === source);
  if (!group?.results.length) return [];

  const recordIds = new Set(group.results.map((result) => result.recordId));
  return items.filter((item) => recordIds.has(item.id));
}

export function filterTasksBySearchGroups(
  tasks: PlanTask[],
  plans: Plan[],
  groups: WorkspaceSearchGroup[],
) {
  const directTasks = filterItemsBySearchGroup(tasks, groups, WORKSPACE_SEARCH_SOURCE_TYPES.TASK);
  if (!plans.length) return directTasks;

  const taskIds = new Set(directTasks.map((task) => task.id));
  const planIds = new Set(plans.map((plan) => plan.id));
  const planFilePaths = new Set(plans.map((plan) => readPlanTaskAssociationFilePath(plan)).filter(Boolean));
  const planTasks = tasks.filter((task) => {
    const planId = readPlanTaskAssociationPlanId(task);
    if (planId !== null) return planIds.has(planId);
    const filePath = readPlanTaskAssociationFilePath(task);
    return Boolean(filePath && planFilePaths.has(filePath));
  });

  return [...directTasks, ...planTasks.filter((task) => !taskIds.has(task.id))];
}

export function withTaskCliProviderTitle(task: PlanTask, fallbackProvider?: string | null): PlanTask {
  const providerLabel = agentCliProviderLabel(readAgentCliProvider({ agentCliProvider: task.agentCliProvider || fallbackProvider }));
  if (!providerLabel || task.title.startsWith(`[${providerLabel}] `)) return task;
  return { ...task, title: `[${providerLabel}] ${task.title}` };
}
