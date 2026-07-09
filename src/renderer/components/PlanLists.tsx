import { useEffect, useMemo, useRef, useState, type ComponentProps } from 'react';
import type { AppEvent, Plan, PlanTask, WorkspaceSearchResult } from '../types';
import { RecordCard } from './IntakePanel';
import { PlanList as BasePlanList } from './plans/PlanList';
import { formatChinaDateTime } from '../utils/time';
import {
  TASK_STATUS_FILTERS,
  formatTaskDuration,
  formatTaskPlanGroupProgress,
  groupTasksByPlan,
  hasRunningTaskForPlan,
  isTaskPlanGroupCompleted,
  matchesTaskStatusFilter,
  scopeFileLabel,
  scopeFileStatus,
  type TaskPlanGroup,
  type TaskStatusFilter,
  type TimedPlanTask,
} from '../utils/planTasks';
import { formatEvent as formatBaseEvent, getEventSearchText as getBaseEventSearchText } from '../utils/planEvents';
import type { EventDisplay } from '../utils/planEvents';

export type { EventDisplay } from '../utils/planEvents';

const SYSTEM_EVENT_TITLES: Record<string, string> = {
  'scan.done': '扫描完成',
  'feedback.created': '反馈已创建',
  'plan.generated': '计划已生成',
};

export function formatEvent(event: AppEvent): EventDisplay {
  const display = formatBaseEvent(event);
  if (display.tone || display.badge) return display;
  const title = SYSTEM_EVENT_TITLES[event.type] || display.title;
  return title === display.title ? display : { ...display, title };
}

export function getEventSearchText(event: AppEvent) {
  const display = formatEvent(event);
  return [
    getBaseEventSearchText(event),
    event.type,
    display.title,
    display.body,
    display.badge,
    display.meta,
  ]
    .filter(Boolean)
    .join(' ');
}

type PlanStatusTab = 'all' | 'running' | 'completed' | 'draft';
type TaskListPlanFilter = {
  totalTaskCount: number;
};
type PlanListProps = ComponentProps<typeof BasePlanList> & {
  onRunDraft?: (plan: Plan, task: PlanTask) => Promise<void> | void;
  onStopPlan?: (plan: Plan) => Promise<void> | void;
  onDeletePlan?: (plan: Plan) => Promise<void> | void;
  selectedPlanId?: number | null;
  onSelectPlan?: (plan: Plan) => void;
};

const PLAN_STATUS_TABS: Array<{ key: PlanStatusTab; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'running', label: '执行中' },
  { key: 'completed', label: '已完成' },
  { key: 'draft', label: '草稿' },
];

export function TaskList({
  emptyText = '暂无任务。',
  tasks,
  onOpenPlan,
  onOpenScopeFile,
  onRun,
  onStop,
  locateTarget,
  planFilter,
}: {
  emptyText?: string;
  tasks: PlanTask[];
  onOpenPlan?: (task: PlanTask) => void;
  onOpenScopeFile?: (filePath: string) => void;
  onRun?: (task: PlanTask) => void;
  onStop?: (task: PlanTask) => void;
  locateTarget?: WorkspaceSearchResult | null;
  planFilter?: TaskListPlanFilter | null;
}) {
  const [activeFilter, setActiveFilter] = useState<TaskStatusFilter>('all');
  const [expandedOverrides, setExpandedOverrides] = useState<Record<string, boolean>>({});
  const taskGroupsListRef = useRef<HTMLDivElement>(null);
  const visibleTasks = useMemo(
    () => tasks.filter((task) => matchesTaskStatusFilter(task, activeFilter)),
    [activeFilter, tasks],
  );
  const taskGroups = useMemo(() => groupTasksByPlan(visibleTasks), [visibleTasks]);
  const defaultExpandedKeys = useMemo(() => getDefaultExpandedTaskGroupKeys(taskGroups), [taskGroups]);
  const filterCounts = useMemo(
    () =>
      TASK_STATUS_FILTERS.reduce<Record<TaskStatusFilter, number>>(
        (counts, filter) => ({
          ...counts,
          [filter.id]: tasks.filter((task) => matchesTaskStatusFilter(task, filter.id)).length,
        }),
        { all: 0, running: 0, queued: 0, completed: 0 },
      ),
    [tasks],
  );
  const activeFilterConfig =
    TASK_STATUS_FILTERS.find((filter) => filter.id === activeFilter) || TASK_STATUS_FILTERS[0];
  const planFilterEmptyText = planFilter
    ? planFilter.totalTaskCount
      ? '该 Plan 的任务已被当前搜索或任务状态过滤条件排除。'
      : '该 Plan 暂无关联任务。'
    : emptyText;
  const currentEmptyText = tasks.length
    ? planFilter
      ? `该 Plan 暂无${activeFilterConfig.label}任务。`
      : activeFilterConfig.emptyText
    : planFilterEmptyText;

  useEffect(() => {
    if (locateTarget?.targetTab === 'tasks') {
      setActiveFilter('all');
    }
  }, [locateTarget]);

  useEffect(() => {
    if (!locateTarget) return;
    const locatedGroup = findTaskGroupForSearchTarget(taskGroups, locateTarget);
    if (!locatedGroup) return;
    setExpandedOverrides((current) => (current[locatedGroup.key] ? current : { ...current, [locatedGroup.key]: true }));
  }, [locateTarget, taskGroups]);

  function toggleTaskGroup(groupKey: string) {
    const currentlyExpanded = expandedOverrides[groupKey] ?? defaultExpandedKeys.has(groupKey);
    setExpandedOverrides((current) => ({ ...current, [groupKey]: !currentlyExpanded }));
    if (currentlyExpanded) {
      window.requestAnimationFrame(() => {
        taskGroupsListRef.current?.scrollTo({ top: 0, behavior: 'auto' });
      });
    }
  }

  return (
    <div className="task-list-panel">
      <div className="task-filter-tabs" role="tablist" aria-label="任务状态筛选">
        {TASK_STATUS_FILTERS.map((filter) => {
          const active = activeFilter === filter.id;
          return (
            <button
              key={filter.id}
              type="button"
              role="tab"
              aria-selected={active}
              className={`task-filter-tab${active ? ' active' : ''}`}
              onClick={() => setActiveFilter(filter.id)}
            >
              <span>{filter.label}</span>
              <span className="task-filter-count">{filterCounts[filter.id]}</span>
            </button>
          );
        })}
      </div>
      {taskGroups.length ? (
        <div className="list compact task-groups" ref={taskGroupsListRef}>
          {taskGroups.map((group) => {
            const expanded = expandedOverrides[group.key] ?? defaultExpandedKeys.has(group.key);
            const groupItemsId = `task-plan-group-items-${sanitizeTaskGroupKey(group.key)}`;
            return (
              <section
                className={`task-plan-group${expanded ? '' : ' is-collapsed'}`}
                id={taskPlanGroupAnchorId(group)}
                data-search-anchor={taskPlanGroupAnchorId(group) ? 'true' : undefined}
                key={group.key}
                aria-label={`计划分组：${group.title}`}
              >
                <button
                  type="button"
                  className="task-plan-group-head task-plan-group-toggle"
                  aria-expanded={expanded}
                  aria-controls={expanded ? groupItemsId : undefined}
                  onClick={() => toggleTaskGroup(group.key)}
                >
                  <span className="task-plan-group-title-wrap">
                    <span className="task-plan-group-chevron" aria-hidden="true">▾</span>
                    <span className="task-plan-group-title" title={group.title}>{group.title}</span>
                  </span>
                  <span className="task-plan-group-meta">
                    <span className={`task-plan-group-progress${isTaskPlanGroupCompleted(group) ? ' completed' : ' incomplete'}`}>
                      {formatTaskPlanGroupProgress(group)}
                    </span>
                  </span>
                </button>
                {expanded ? (
                  <div id={groupItemsId} className="task-plan-group-items">
                    {group.tasks.map((task) => {
                      const running = task.status === 'running';
                      const completed = task.status === 'completed';
                      const durationLabel = formatTaskDuration(task as TimedPlanTask);
                      return (
                        <RecordCard
                          anchorId={`workspace-task-${task.id}`}
                          actions={
                            <div className="item-actions">
                              <button
                                type="button"
                                className="btn-link"
                                disabled={completed || running}
                                onClick={() => onRun?.(task)}
                              >
                                执行
                              </button>
                              <button
                                type="button"
                                className="btn-link danger-link"
                                disabled={!running}
                                onClick={() => onStop?.(task)}
                              >
                                停止
                              </button>
                            </div>
                          }
                          key={task.id}
                          title={task.title}
                          status={task.status}
                          body={
                            <div className="task-body-stack">
                              {task.file_path ? (
                                <button
                                  type="button"
                                  className="btn-link task-file-link mono"
                                  disabled={!onOpenPlan}
                                  title={task.file_path}
                                  aria-label={`预览 ${task.file_path}`}
                                  onClick={() => onOpenPlan?.(task)}
                                >
                                  {task.file_path}
                                </button>
                              ) : null}
                              {task.scope_files?.length ? (
                                <div className="task-scope-files" aria-label="任务相关文件">
                                  {task.scope_files.map((file) => {
                                    const className = `task-scope-chip${file.canOpen ? ' openable' : ''}${file.isUnknown || file.isValidation ? ' special' : ''}`;
                                    const status = scopeFileStatus(file);
                                    const label = scopeFileLabel(file);
                                    if (file.canOpen && onOpenScopeFile) {
                                      return (
                                        <button
                                          key={`${task.id}-${file.path}`}
                                          type="button"
                                          className={className}
                                          title={status}
                                          aria-label={`打开 ${file.path}`}
                                          onClick={(event) => {
                                            event.stopPropagation();
                                            onOpenScopeFile(file.path);
                                          }}
                                        >
                                          <span className="mono">{label}</span>
                                          <small>{status}</small>
                                        </button>
                                      );
                                    }
                                    return (
                                      <span
                                        key={`${task.id}-${file.path}`}
                                        className={className}
                                        title={status}
                                      >
                                        <span className="mono">{label}</span>
                                        <small>{status}</small>
                                      </span>
                                    );
                                  })}
                                </div>
                              ) : null}
                            </div>
                          }
                          meta={`${task.task_key} · ${durationLabel} · ${formatChinaDateTime(task.updated_at)}`}
                        />
                      );
                    })}
                  </div>
                ) : null}
              </section>
            );
          })}
        </div>
      ) : (
        <div className="empty">{currentEmptyText}</div>
      )}
    </div>
  );
}

// 事件流增量渲染：初始仅渲染最近一批，点击「加载更多」分批展开更早事件。
const EVENT_BATCH_SIZE = 30;

export function EventList({ emptyText = '暂无事件。', events }: { emptyText?: string; events: AppEvent[] }) {
  const [visibleCount, setVisibleCount] = useState(EVENT_BATCH_SIZE);
  if (!events.length) return <div className="empty">{emptyText}</div>;

  // 可见计数按实际事件数收敛，事件集合变化时不出现计数错乱或空白。
  const safeVisibleCount = Math.min(visibleCount, events.length);
  const visibleEvents = events.slice(0, safeVisibleCount);
  const remaining = events.length - safeVisibleCount;

  return (
    <div className="list compact event-list">
      {visibleEvents.map((event) => {
        const display = formatEvent(event);
        return (
          <article
            className={`item event-item ${display.tone ? `event-item-${display.tone}` : ''}`}
            id={`workspace-event-${event.id}`}
            data-search-anchor="true"
            key={event.id}
          >
            <div className="item-title event-title">
              <span>{display.title}</span>
              {display.badge ? <span className={`event-badge event-badge-${display.tone}`}>{display.badge}</span> : null}
            </div>
            {display.body ? <div className="item-body plain-text">{display.body}</div> : null}
            <div className="meta event-meta">{display.meta}</div>
          </article>
        );
      })}
      {remaining > 0 ? (
        <button
          type="button"
          className="btn-link event-list-more"
          onClick={() => setVisibleCount((current) => current + EVENT_BATCH_SIZE)}
        >
          加载更多（剩余 {remaining} 条）
        </button>
      ) : null}
    </div>
  );
}

function getDefaultExpandedTaskGroupKeys(groups: TaskPlanGroup[]) {
  const runningGroups = groups.filter((group) => group.hasRunningTask);
  const defaultGroups = runningGroups.length ? runningGroups : groups.slice(0, 1);
  return new Set(defaultGroups.map((group) => group.key));
}

function sanitizeTaskGroupKey(key: string) {
  return key.replace(/[^a-zA-Z0-9_-]/g, '-');
}

function findTaskGroupForSearchTarget(groups: TaskPlanGroup[], target: WorkspaceSearchResult) {
  const taskId = target.taskId ?? (target.targetType === 'task' ? target.targetId : null);
  const planId = target.planId ?? (target.targetType === 'plan' ? target.targetId : null);

  return groups.find((group) => {
    if (taskId !== null && group.tasks.some((task) => Number(task.id) === Number(taskId))) return true;
    if (planId !== null && group.source === 'plan' && Number(group.sourceId) === Number(planId)) return true;
    if (target.filePath && group.source === 'file' && group.sourceId === target.filePath) return true;
    return false;
  });
}

function taskPlanGroupAnchorId(group: TaskPlanGroup) {
  if (group.source === 'plan' && group.sourceId) return `workspace-plan-${group.sourceId}`;
  if (group.source === 'file' && group.sourceId) return `workspace-plan-file-${sanitizeTaskGroupKey(group.sourceId)}`;
  return undefined;
}

export function PlanList({
  plans,
  emptyText,
  onRunDraft,
  onRunParallel,
  onStopPlan,
  onDeletePlan,
  selectedPlanId,
  onSelectPlan,
  tasks = [],
  totalPlanCount,
  ...props
}: PlanListProps) {
  const [activeStatus, setActiveStatus] = useState<PlanStatusTab>('all');
  const [draftRunningPlanId, setDraftRunningPlanId] = useState<number | null>(null);
  const [draftRunError, setDraftRunError] = useState('');
  const [localSelectedPlanId, setLocalSelectedPlanId] = useState<number | null>(null);
  const effectiveTotalPlanCount = totalPlanCount ?? plans.length;
  const orderedPlans = useMemo(
    () => orderPlansByRunningTaskPriority(plans, tasks, effectiveTotalPlanCount),
    [effectiveTotalPlanCount, plans, tasks],
  );
  const counts = useMemo(() => planStatusCounts(orderedPlans), [orderedPlans]);
  const visiblePlans = orderedPlans.filter((plan) => planMatchesStatusTab(plan, activeStatus));
  const hasControlledSelection = typeof selectedPlanId !== 'undefined';
  const effectiveSelectedPlanId = hasControlledSelection ? selectedPlanId : localSelectedPlanId;

  useEffect(() => {
    if (typeof selectedPlanId !== 'undefined') return;
    setLocalSelectedPlanId((current) => {
      if (current === null) return current;
      return orderedPlans.some((plan) => plan.id === current) ? current : null;
    });
  }, [orderedPlans, selectedPlanId]);

  function selectPlan(plan: Plan) {
    if (!hasControlledSelection) {
      setLocalSelectedPlanId((current) => (current === plan.id ? null : plan.id));
    }
    onSelectPlan?.(plan);
  }

  async function runDraftPlan(plan: Plan) {
    setDraftRunError('');
    setDraftRunningPlanId(plan.id);
    if (onRunParallel && plan.concurrency_suggestion?.hasSafeParallelBatches) {
      try {
        await onRunParallel({
          plan,
          batches: plan.concurrency_suggestion.batches.map((batch) => ({
            taskIds: batch.tasks.map((task) => task.id),
          })),
        });
      } catch (error) {
        setDraftRunError(error instanceof Error ? error.message : '草稿计划启动失败');
      } finally {
        setDraftRunningPlanId(null);
      }
      return;
    }

    const task = firstPendingTaskForPlan(plan, tasks);
    if (!task) {
      setDraftRunningPlanId(null);
      setDraftRunError('草稿计划暂无可执行任务');
      return;
    }
    if (!onRunDraft) {
      setDraftRunningPlanId(null);
      setDraftRunError('草稿计划执行入口不可用');
      return;
    }

    try {
      await onRunDraft(plan, task);
    } catch (error) {
      setDraftRunError(error instanceof Error ? error.message : '草稿计划启动失败');
    } finally {
      setDraftRunningPlanId(null);
    }
  }

  function renderPlanControls(plan: Plan) {
    const draftRunDisabledReason = isDraftPlan(plan)
      ? draftPlanRunDisabledReason(plan, tasks, Boolean(onRunDraft), Boolean(onRunParallel))
      : '';
    const selected = effectiveSelectedPlanId === plan.id;

    return (
      <>
        <button
          type="button"
          className={`btn-link plan-select-button${selected ? ' active' : ''}`}
          aria-pressed={selected}
          data-testid="plan-select-toggle"
          onClick={() => selectPlan(plan)}
        >
          {selected ? '取消选择' : '查看任务'}
        </button>
        {isDraftPlan(plan) ? (
          <button
            type="button"
            className="btn-link"
            disabled={draftRunningPlanId === plan.id || Boolean(draftRunDisabledReason)}
            title={draftRunDisabledReason || undefined}
            onClick={() => runDraftPlan(plan)}
          >
            {draftRunningPlanId === plan.id ? '启动中…' : '执行草稿'}
          </button>
        ) : null}
      </>
    );
  }

  return (
    <>
      <div className="task-filter-tabs" role="tablist" aria-label="计划状态筛选">
        {PLAN_STATUS_TABS.map((tab) => (
          <button
            key={tab.key}
            type="button"
            className={`task-filter-tab${activeStatus === tab.key ? ' active' : ''}`}
            onClick={() => setActiveStatus(tab.key)}
            role="tab"
            aria-selected={activeStatus === tab.key}
          >
            <span>{tab.label}</span>
            <span className="task-filter-count">{counts[tab.key]}</span>
          </button>
        ))}
      </div>

      {draftRunError ? <div className="error-banner plan-list-error">{draftRunError}</div> : null}

      <BasePlanList
        {...props}
        onRunParallel={onRunParallel}
        onStopPlan={onStopPlan}
        onDeletePlan={onDeletePlan}
        onSelectPlan={selectPlan}
        emptyText={activeStatus === 'all' ? emptyText : '当前分类暂无 Plan。'}
        plans={visiblePlans}
        renderPlanControls={renderPlanControls}
        selectedPlanId={effectiveSelectedPlanId}
        tasks={tasks}
        totalPlanCount={effectiveTotalPlanCount}
      />
    </>
  );
}

type OrderedPlan = {
  plan: Plan;
  index: number;
  hasRunningTask: boolean;
};

function orderPlansByRunningTaskPriority(plans: Plan[], tasks: PlanTask[], planCount: number) {
  return plans
    .map<OrderedPlan>((plan, index) => ({
      plan,
      index,
      hasRunningTask: hasRunningTaskForPlan(tasks, plan, planCount),
    }))
    .sort(compareOrderedPlan)
    .map(({ plan }) => plan);
}

function compareOrderedPlan(left: OrderedPlan, right: OrderedPlan) {
  if (left.hasRunningTask !== right.hasRunningTask) return left.hasRunningTask ? -1 : 1;
  return comparePlanOrder(left.plan, right.plan) || left.index - right.index;
}

function comparePlanOrder(left: Plan, right: Plan) {
  // 同一优先级内按创建时间 created_at 倒序（最新在前）；id 倒序保证确定性。
  return (
    String(right.created_at || '').localeCompare(String(left.created_at || '')) ||
    Number(right.id || 0) - Number(left.id || 0)
  );
}

function planStatusCounts(plans: Plan[]): Record<PlanStatusTab, number> {
  return plans.reduce(
    (counts, plan) => {
      counts.all += 1;
      if (isDraftPlan(plan)) counts.draft += 1;
      else if (isCompletedPlan(plan)) counts.completed += 1;
      else counts.running += 1;
      return counts;
    },
    { all: 0, running: 0, completed: 0, draft: 0 },
  );
}

function planMatchesStatusTab(plan: Plan, status: PlanStatusTab) {
  if (status === 'all') return true;
  if (status === 'draft') return isDraftPlan(plan);
  if (status === 'completed') return isCompletedPlan(plan);
  return !isDraftPlan(plan) && !isCompletedPlan(plan);
}

function isDraftPlan(plan: Plan) {
  return plan.is_draft || plan.status === 'draft';
}

function isCompletedPlan(plan: Plan) {
  return Boolean(plan.validation_passed) || plan.status === 'completed';
}

function draftPlanRunDisabledReason(plan: Plan, tasks: PlanTask[], canRunDraft: boolean, canRunParallel: boolean) {
  if (!isDraftPlan(plan)) return '';
  if (canRunParallel && plan.concurrency_suggestion?.hasSafeParallelBatches) return '';
  if (!canRunDraft) return '草稿计划执行入口不可用';
  return firstPendingTaskForPlan(plan, tasks) ? '' : '草稿计划暂无可执行任务';
}

function firstPendingTaskForPlan(plan: Plan, tasks: PlanTask[]) {
  return tasks
    .filter((task) => Number(task.plan_id) === Number(plan.id) && task.status === 'pending')
    .sort((left, right) => Number(left.sort_order || 0) - Number(right.sort_order || 0) || Number(left.id || 0) - Number(right.id || 0))[0] || null;
}
