import { useMemo, useState } from 'react';
import type { PlanTask } from '../../types';
import { RecordCard } from '../IntakePanel';
import { formatChinaDateTime } from '../../utils/time';
import {
  TASK_STATUS_FILTERS,
  formatTaskDuration,
  formatTaskPlanGroupSummary,
  groupTasksByPlan,
  matchesTaskStatusFilter,
  scopeFileLabel,
  scopeFileStatus,
  type TaskStatusFilter,
  type TimedPlanTask,
} from '../../utils/planTasks';

export function TaskList({
  emptyText = '暂无任务。',
  tasks,
  onOpenPlan,
  onRun,
  onStop,
}: {
  emptyText?: string;
  tasks: PlanTask[];
  onOpenPlan?: (task: PlanTask) => void;
  onRun?: (task: PlanTask) => void;
  onStop?: (task: PlanTask) => void;
}) {
  const [activeFilter, setActiveFilter] = useState<TaskStatusFilter>('all');
  const visibleTasks = useMemo(
    () => tasks.filter((task) => matchesTaskStatusFilter(task, activeFilter)),
    [activeFilter, tasks],
  );
  const taskGroups = useMemo(() => groupTasksByPlan(visibleTasks), [visibleTasks]);
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
        <div className="list compact">
          {taskGroups.map((group) => {
            return (
              <section className="task-plan-group" key={group.key} aria-label={`计划分组：${group.title}`}>
                <div className="task-plan-group-head">
                  <div className="task-plan-group-title" title={group.title}>{group.title}</div>
                  <div className="task-plan-group-summary">{formatTaskPlanGroupSummary(group)}</div>
                </div>
                {group.tasks.map((task) => {
                  const running = task.status === 'running';
                  const completed = task.status === 'completed';
                  const durationLabel = formatTaskDuration(task as TimedPlanTask);
                  return (
                    <RecordCard
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
                              {task.scope_files.map((file) => (
                                <span
                                  key={`${task.id}-${file.path}`}
                                  className={`task-scope-chip${file.canOpen ? ' openable' : ''}${file.isUnknown || file.isValidation ? ' special' : ''}`}
                                  title={scopeFileStatus(file)}
                                >
                                  <span className="mono">{scopeFileLabel(file)}</span>
                                  <small>{scopeFileStatus(file)}</small>
                                </span>
                              ))}
                            </div>
                          ) : null}
                        </div>
                      }
                      meta={`${task.task_key} · ${durationLabel} · ${formatChinaDateTime(task.updated_at)}`}
                    />
                  );
                })}
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
