import { useMemo, useState } from 'react';
import type { PlanTask } from '../../types';
import { formatChinaDateTime } from '../../utils/time';
import {
  TASK_STATUS_FILTERS,
  formatTaskDuration,
  formatTaskPlanGroupProgress,
  groupTasksByPlan,
  isTaskPlanGroupCompleted,
  matchesTaskStatusFilter,
  scopeFileClassName,
  scopeFileLabel,
  scopeFileStatus,
  type TaskPlanGroup,
  type TaskStatusFilter,
  type TimedPlanTask,
} from '../../utils/planTasks';

export function TaskList({
  emptyText = '暂无任务。',
  tasks,
  onOpenPlan,
  onOpenScopeFile,
  onRun,
  onStop,
}: {
  emptyText?: string;
  tasks: PlanTask[];
  onOpenPlan?: (task: PlanTask) => void;
  onOpenScopeFile?: (filePath: string) => void;
  onRun?: (task: PlanTask) => void;
  onStop?: (task: PlanTask) => void;
}) {
  const [activeFilter, setActiveFilter] = useState<TaskStatusFilter>('all');
  const [expandedOverrides, setExpandedOverrides] = useState<Record<string, boolean>>({});
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
  const currentEmptyText = tasks.length ? activeFilterConfig.emptyText : emptyText;

  function toggleTaskGroup(groupKey: string) {
    const currentlyExpanded = expandedOverrides[groupKey] ?? defaultExpandedKeys.has(groupKey);
    setExpandedOverrides((current) => ({ ...current, [groupKey]: !currentlyExpanded }));
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
        <div className="list compact task-groups">
          {taskGroups.map((group) => {
            const expanded = expandedOverrides[group.key] ?? defaultExpandedKeys.has(group.key);
            const groupItemsId = `task-plan-group-items-${sanitizeTaskGroupKey(group.key)}`;
            return (
              <section
                className={`task-plan-group${group.hasRunningTask ? ' has-running' : ''}${expanded ? '' : ' is-collapsed'}`}
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
                    <span className="task-plan-group-dot" aria-hidden="true" />
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
                      const isRunningLike = ['running', 'processing', 'stopping'].includes(task.status);
                      const isCompletedLike = ['completed', 'done', 'passed', 'accepted'].includes(task.status);
                      return (
                        <article className={`task-item${running ? ' running' : ''}`} key={task.id}>
                          <div className="task-top">
                            <span className="task-key">{task.task_key}</span>
                            <span className="task-title" title={task.title}>{task.title}</span>
                            <span className={`chip ${taskStatusChipClass(task.status)}`}>{task.status}</span>
                            <span className={`task-duration${running ? ' running' : ''}`}>{durationLabel}</span>
                          </div>

                          {task.file_path ? (
                            <button
                              type="button"
                              className="btn-link task-file mono"
                              disabled={!onOpenPlan}
                              title={task.file_path}
                              aria-label={`预览 ${task.file_path}`}
                              onClick={() => onOpenPlan?.(task)}
                            >
                              {task.file_path}
                            </button>
                          ) : null}

                          {task.scope_files?.length ? (
                            <div className="task-scope-files scope-files" aria-label="任务相关文件">
                              {task.scope_files.map((file) => {
                                const semanticClass = scopeFileClassName(file);
                                const className = `task-scope-chip scope-chip${semanticClass ? ` ${semanticClass}` : ''}`;
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

                          <div className="task-actions">
                          <button
                            type="button"
                            className="btn btn-sm btn-primary"
                            disabled={isRunningLike}
                            onClick={() => onRun?.(task)}
                          >
                            {isCompletedLike ? '重新执行' : '执行'}
                          </button>
                          <button
                            type="button"
                            className="btn btn-sm"
                            disabled={!running}
                            onClick={() => onStop?.(task)}
                          >
                            停止
                          </button>
                        </div>
                          <div className="task-meta">更新 {formatChinaDateTime(task.updated_at)}</div>
                        </article>
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

function getDefaultExpandedTaskGroupKeys(groups: TaskPlanGroup[]) {
  const runningGroups = groups.filter((group) => group.hasRunningTask);
  const defaultGroups = runningGroups.length ? runningGroups : groups.slice(0, 1);
  return new Set(defaultGroups.map((group) => group.key));
}

function sanitizeTaskGroupKey(key: string) {
  return key.replace(/[^a-zA-Z0-9_-]/g, '-');
}

function taskStatusChipClass(status: string) {
  const normalized = String(status || '').toLowerCase();
  if (['running', 'processing', 'stopping'].includes(normalized)) return 'chip-running';
  if (['completed', 'done', 'passed', 'accepted'].includes(normalized)) return 'chip-completed';
  if (['failed', 'error'].includes(normalized)) return 'chip-failed';
  if (['stopped', 'interrupted'].includes(normalized)) return 'chip-stopped';
  return 'chip-pending';
}
