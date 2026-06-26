import type { KeyboardEvent } from 'react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { AppEvent, Plan, PlanTask, WorkspacePlanReadState } from '../types';
import { RecordCard } from './IntakePanel';
import { MarkdownReader } from './MarkdownReader';
import { agentCliProviderLabel, codexReasoningEffortLabel } from './shared';
import { formatChinaDateTime, formatDuration, getRunningDurationMs } from '../utils/time';

type TimedPlanTask = PlanTask & {
  plan_id?: number | null;
  started_at?: string | null;
  finished_at?: string | null;
  duration_ms?: number | null;
};

type EventMetaRecord = Record<string, unknown>;

type TaskEventTone = 'start' | 'success' | 'failed' | 'stopped' | 'stopping' | 'updated';

type TaskEventDisplay = {
  title: string;
  body: string;
  meta: string;
  badge?: string;
  tone?: TaskEventTone;
};

type TaskStatusFilter = 'all' | 'running' | 'queued' | 'completed';

const TASK_STATUS_FILTERS: Array<{ id: TaskStatusFilter; label: string; emptyText: string }> = [
  { id: 'all', label: '全部', emptyText: '暂无任务。' },
  { id: 'running', label: '进行中', emptyText: '暂无进行中任务。' },
  { id: 'queued', label: '队列中', emptyText: '暂无队列中任务。' },
  { id: 'completed', label: '已完成', emptyText: '暂无已完成任务。' },
];

const TASK_EVENT_PRESENTATION: Record<TaskEventTone, { action: string; badge: string }> = {
  start: { action: '开始了', badge: '开始' },
  success: { action: '结束了', badge: '成功' },
  failed: { action: '执行失败', badge: '失败' },
  stopped: { action: '停止了', badge: '停止' },
  stopping: { action: '请求停止', badge: '停止中' },
  updated: { action: '更新了', badge: '任务' },
};

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
  if (task.plan_id === null || typeof task.plan_id === 'undefined') return null;
  const planId = Number(task.plan_id);
  return Number.isFinite(planId) ? planId : null;
}

function formatTaskDuration(task: TimedPlanTask) {
  const duration = getTaskDurationMs(task);
  if (task.status === 'running') return `已运行 ${formatDuration(duration, '0秒')}`;
  if (duration === null || (duration === 0 && !task.started_at && !task.finished_at)) return '未开始';
  return `耗时 ${formatDuration(duration, '0秒')}`;
}

function normalizeTaskStatus(status: string | null | undefined) {
  return String(status || '').trim().toLowerCase();
}

function matchesTaskStatusFilter(task: PlanTask, filter: TaskStatusFilter) {
  const status = normalizeTaskStatus(task.status);
  if (filter === 'all') return true;
  if (filter === 'running') return ['running', 'processing', 'stopping'].includes(status);
  if (filter === 'queued') return ['pending', 'queued', 'waiting'].includes(status);
  if (filter === 'completed') return ['completed', 'done', 'passed', 'accepted'].includes(status);
  return true;
}

function tasksForPlan(tasks: PlanTask[], plan: Plan, planCount: number) {
  const timedTasks = tasks as TimedPlanTask[];
  const hasPlanIds = timedTasks.some((task) => readPlanId(task) !== null);
  if (!hasPlanIds) return planCount === 1 ? timedTasks : [];
  return timedTasks.filter((task) => readPlanId(task) === plan.id);
}

function formatPlanDurationSummary(tasks: TimedPlanTask[]) {
  const totalMs = tasks.reduce((sum, task) => sum + (getTaskDurationMs(task) ?? 0), 0);
  const completedMs = tasks.reduce(
    (sum, task) => sum + (task.status === 'completed' ? getTaskDurationMs(task) ?? 0 : 0),
    0,
  );

  return `总耗时 ${formatDuration(totalMs, '0秒')} · 已完成 ${formatDuration(completedMs, '0秒')}`;
}

function planTitle(plan: Plan) {
  return String((plan as Plan & { title?: string | null }).title || '').trim();
}

function toEventMetaRecord(value: unknown): EventMetaRecord | null {
  if (!value) return null;
  if (typeof value === 'string') {
    try {
      return toEventMetaRecord(JSON.parse(value));
    } catch {
      return null;
    }
  }
  if (typeof value === 'object' && !Array.isArray(value)) return value as EventMetaRecord;
  return null;
}

function readEventMeta(event: AppEvent) {
  return toEventMetaRecord((event as AppEvent & { meta?: unknown }).meta);
}

function readMetaText(meta: EventMetaRecord | null, keys: string[]) {
  if (!meta) return '';
  for (const key of keys) {
    const value = meta[key];
    if (typeof value === 'string') {
      const text = value.trim();
      if (text) return text;
    }
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return '';
}

function readMetaNumber(meta: EventMetaRecord | null, keys: string[]) {
  const text = readMetaText(meta, keys);
  if (!text) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

function includesAny(text: string, keywords: string[]) {
  return keywords.some((keyword) => text.includes(keyword));
}

function classifyTaskEvent(event: AppEvent, meta: EventMetaRecord | null): TaskEventTone {
  const eventText = `${event.type || ''} ${readMetaText(meta, ['status', 'taskStatus', 'task_status'])}`.toLowerCase();
  if (includesAny(eventText, ['stop_requested', 'stop-requested', 'stop.requested', 'request_stop', 'stopping'])) {
    return 'stopping';
  }
  if (includesAny(eventText, ['fail', 'error', 'errored'])) return 'failed';
  if (includesAny(eventText, ['stop', 'interrupt', 'cancel'])) return 'stopped';
  if (includesAny(eventText, ['start', 'begin', 'running'])) return 'start';
  if (includesAny(eventText, ['complete', 'finish', 'success', 'succeed', 'executed', 'done'])) return 'success';
  return 'updated';
}

function isTaskEventType(type: string) {
  return /^task[.:_-]/i.test(type);
}

function sameEventText(left: string, right: string) {
  return left.replace(/\s+/g, ' ').trim() === right.replace(/\s+/g, ' ').trim();
}

function formatTaskEvent(event: AppEvent, meta: EventMetaRecord): TaskEventDisplay | null {
  const taskKey = readMetaText(meta, ['taskKey', 'task_key']);
  const taskId = readMetaText(meta, ['taskId', 'task_id']);
  const taskTitle = readMetaText(meta, ['taskTitle', 'task_title', 'title']) || '未命名任务';
  const hasTaskIdentity = Boolean(taskKey || taskId || readMetaText(meta, ['taskTitle', 'task_title', 'title']));
  if (!hasTaskIdentity) return null;

  const tone = classifyTaskEvent(event, meta);
  const presentation = TASK_EVENT_PRESENTATION[tone];
  const taskLabel = taskKey ? `${taskKey} 任务` : taskId ? `任务 #${taskId}` : '任务';
  const separator = taskLabel === '任务' ? '' : ' ';
  const title = `${presentation.action}${separator}${taskLabel}：${taskTitle}`;
  const originalMessage = event.message?.trim() || '';
  const planId = readMetaText(meta, ['planId', 'plan_id']);
  const status = readMetaText(meta, ['status', 'taskStatus', 'task_status']);
  const agentCliProvider = readMetaText(meta, ['agentCliProvider', 'agent_cli_provider']);
  const codexReasoningEffort = readMetaText(meta, [
    'codexReasoningEffort',
    'codex_reasoning_effort',
    'codexThinkingDepth',
    'codex_thinking_depth',
    'reasoningEffort',
    'reasoning_effort',
    'thinkingDepth',
    'thinking_depth',
  ]);
  const durationMs = readMetaNumber(meta, ['durationMs', 'duration_ms']);
  const metaParts = [
    formatChinaDateTime(event.created_at),
    planId ? `Plan #${planId}` : '',
    agentCliProvider ? agentCliProviderLabel(agentCliProvider) : '',
    agentCliProvider !== 'claude' && codexReasoningEffort ? `思考深度 ${codexReasoningEffortLabel(codexReasoningEffort)}` : '',
    status ? `状态 ${status}` : '',
    durationMs !== null ? `耗时 ${formatDuration(durationMs, '0秒')}` : '',
  ].filter(Boolean);

  return {
    title,
    body: originalMessage && !sameEventText(originalMessage, title) ? originalMessage : '',
    meta: metaParts.join(' · '),
    badge: presentation.badge,
    tone,
  };
}

function formatEvent(event: AppEvent): TaskEventDisplay {
  const meta = readEventMeta(event);
  const taskDisplay = meta && (isTaskEventType(event.type) || readMetaText(meta, ['taskKey', 'task_key', 'taskId', 'task_id']))
    ? formatTaskEvent(event, meta)
    : null;
  if (taskDisplay) return taskDisplay;

  return {
    title: event.type || '事件',
    body: event.message || '',
    meta: formatChinaDateTime(event.created_at),
  };
}

function toSearchText(value: unknown, depth = 0): string {
  if (value === null || value === undefined || depth > 6) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map((item) => toSearchText(item, depth + 1)).join(' ');
  if (typeof value === 'object') {
    return Object.values(value as Record<string, unknown>)
      .map((item) => toSearchText(item, depth + 1))
      .join(' ');
  }
  return '';
}

export function getEventSearchText(event: AppEvent) {
  const display = formatEvent(event);
  const meta = readEventMeta(event);
  return [
    event.type,
    event.message,
    display.title,
    display.body,
    display.badge,
    display.meta,
    toSearchText(meta),
    toSearchText(event),
  ]
    .filter(Boolean)
    .join(' ');
}

function hasPlanReaderUpdate(
  readingPlan: Plan | null,
  latestPlan: Plan | null | undefined,
  result: WorkspacePlanReadState['result'],
) {
  if (!readingPlan || !latestPlan) return false;
  if (readingPlan.id !== latestPlan.id || readingPlan.project_id !== latestPlan.project_id) return false;

  const readFilePath = result?.file_path || readingPlan.file_path || '';
  const readHash = result?.hash || readingPlan.hash || '';
  const readUpdatedAt = result?.updated_at || readingPlan.updated_at || '';
  return (
    (latestPlan.file_path || '') !== readFilePath ||
    (latestPlan.hash || '') !== readHash ||
    (latestPlan.updated_at || '') !== readUpdatedAt ||
    (latestPlan.status || '') !== (readingPlan.status || '')
  );
}

const PLAN_READER_FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function getPlanReaderFocusableElements(container: HTMLElement) {
  return Array.from(container.querySelectorAll<HTMLElement>(PLAN_READER_FOCUSABLE_SELECTOR)).filter(
    (element) => element.getClientRects().length > 0 && element.getAttribute('aria-hidden') !== 'true',
  );
}

export function PlanList({
  emptyText = '暂无 plan。',
  latestReadingPlan,
  onCloseReader,
  onOpenReader,
  onRefreshReader,
  plans,
  readerState,
  tasks = [],
  totalPlanCount = plans.length,
}: {
  emptyText?: string;
  latestReadingPlan?: Plan | null;
  onCloseReader: () => void;
  onOpenReader: (plan: Plan) => void;
  onRefreshReader: () => void;
  plans: Plan[];
  readerState: WorkspacePlanReadState;
  tasks?: PlanTask[];
  totalPlanCount?: number;
}) {
  const readingPlan = readerState.plan;
  const planReadResult = readerState.result;
  const planReadError = readerState.error;
  const planReading = readerState.loading;
  const readerFilePath = planReadResult?.file_path || readingPlan?.file_path || '';
  const readerHash = planReadResult?.hash || readingPlan?.hash || '';
  const readerUpdatedAt = planReadResult?.updated_at || readingPlan?.updated_at || '';
  const latestPlanUpdated = hasPlanReaderUpdate(readingPlan, latestReadingPlan, planReadResult);
  const readerDialogId = useId();
  const readerTitleId = useId();
  const readerDescriptionId = useId();
  const readerContentId = useId();
  const readerDialogRef = useRef<HTMLDivElement>(null);
  const previouslyFocusedElementRef = useRef<HTMLElement | null>(null);
  const readerStatusText = planReadError
    ? `读取失败：${planReadError}`
    : planReading
      ? '正在读取 Plan 全文。'
      : latestPlanUpdated
        ? 'Plan 列表信息已更新，可刷新读取最新正文。'
        : 'Plan 全文已加载，当前为只读阅读模式。';

  useEffect(() => {
    if (!readingPlan) return undefined;

    previouslyFocusedElementRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusFrame = window.requestAnimationFrame(() => {
      readerDialogRef.current?.focus();
    });

    return () => {
      window.cancelAnimationFrame(focusFrame);
      previouslyFocusedElementRef.current?.focus();
    };
  }, [readingPlan?.id, readingPlan?.project_id]);

  function handleReaderKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onCloseReader();
      return;
    }

    if (event.key !== 'Tab') return;

    const dialog = readerDialogRef.current;
    if (!dialog) return;

    const focusableElements = getPlanReaderFocusableElements(dialog);
    if (!focusableElements.length) {
      event.preventDefault();
      dialog.focus();
      return;
    }

    const firstFocusableElement = focusableElements[0];
    const lastFocusableElement = focusableElements[focusableElements.length - 1];

    if (document.activeElement === dialog) {
      event.preventDefault();
      (event.shiftKey ? lastFocusableElement : firstFocusableElement).focus();
      return;
    }

    if (event.shiftKey && document.activeElement === firstFocusableElement) {
      event.preventDefault();
      lastFocusableElement.focus();
      return;
    }

    if (!event.shiftKey && document.activeElement === lastFocusableElement) {
      event.preventDefault();
      firstFocusableElement.focus();
    }
  }

  return (
    <>
      {plans.length ? (
        <div className="list compact">
          {plans.map((plan) => {
            const durationSummary = formatPlanDurationSummary(tasksForPlan(tasks, plan, totalPlanCount));
            const title = planTitle(plan);
            const progressSummary = `${plan.completed_tasks}/${plan.total_tasks} tasks · ${durationSummary} · validation ${
              plan.validation_passed ? 'passed' : 'pending'
            }`;
            const readingThisPlan = Boolean(
              readingPlan && readingPlan.id === plan.id && readingPlan.project_id === plan.project_id,
            );
            const disableRead = planReading && readingThisPlan;
            return (
              <RecordCard
                actions={
                  <div className="item-actions">
                    <button
                      type="button"
                      className="btn-link plan-read-link"
                      aria-haspopup="dialog"
                      aria-controls={readingThisPlan ? readerDialogId : undefined}
                      aria-expanded={readingThisPlan}
                      aria-label={`${disableRead ? '正在读取' : '阅读全文'}：${plan.file_path}`}
                      disabled={disableRead}
                      onClick={() => onOpenReader(plan)}
                    >
                      {disableRead ? '读取中…' : '阅读全文'}
                    </button>
                  </div>
                }
                key={plan.id}
                title={plan.file_path}
                status={plan.status}
                body={
                  <div className="plan-list-body">
                    {title ? <div className="plan-list-title" title={title}>{title}</div> : null}
                    <div className="plan-list-summary">{progressSummary}</div>
                  </div>
                }
                meta={`${plan.hash?.slice(0, 12) || ''} · ${formatChinaDateTime(plan.updated_at)}`}
              />
            );
          })}
        </div>
      ) : (
        <div className="empty">{emptyText}</div>
      )}

      {readingPlan ? (
        <div className="modal-mask" onClick={onCloseReader}>
          <div
            id={readerDialogId}
            ref={readerDialogRef}
            className="modal plan-reader-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby={readerTitleId}
            aria-describedby={readerDescriptionId}
            tabIndex={-1}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={handleReaderKeyDown}
          >
            <div className="modal-head plan-reader-head">
              <div className="plan-reader-title">
                <h3 id={readerTitleId}>Plan 全文（只读）</h3>
                <span className="plan-reader-path mono" title={readerFilePath}>
                  {readerFilePath || '未记录文件路径'}
                </span>
                <p id={readerDescriptionId} className="sr-only" aria-live="polite" aria-atomic="true">
                  {readerStatusText}
                </p>
              </div>
              <div className="item-actions plan-reader-actions">
                <button
                  type="button"
                  className="btn-link"
                  disabled={planReading}
                  onClick={onRefreshReader}
                  aria-label="重新读取 Plan 全文"
                >
                  {planReading ? '读取中…' : '刷新'}
                </button>
                <button type="button" className="modal-close" onClick={onCloseReader} aria-label="关闭 Plan 全文阅读">
                  ×
                </button>
              </div>
            </div>
            <div className="plan-reader-body" tabIndex={0} aria-label="Plan 全文阅读区域">
              <dl className="plan-reader-summary" aria-label="Plan 摘要">
                <div className="plan-reader-summary-item">
                  <dt>状态</dt>
                  <dd>{readingPlan.status}</dd>
                </div>
                <div className="plan-reader-summary-item">
                  <dt>更新时间</dt>
                  <dd>{readerUpdatedAt ? formatChinaDateTime(readerUpdatedAt) : '-'}</dd>
                </div>
                <div className="plan-reader-summary-item">
                  <dt>哈希</dt>
                  <dd className="mono" title={readerHash}>
                    {readerHash?.slice(0, 12) || '-'}
                  </dd>
                </div>
              </dl>

              {latestPlanUpdated ? (
                <div className="hint" role="status" aria-live="polite" aria-atomic="true">
                  Plan 列表信息已更新，可刷新读取最新正文。
                  <button type="button" className="btn-link" disabled={planReading} onClick={onRefreshReader}>
                    刷新读取
                  </button>
                </div>
              ) : null}
              {planReadError ? (
                <div className="plan-reader-error" role="alert" aria-live="assertive" aria-atomic="true">
                  <span>{planReadError}</span>
                  <button type="button" className="btn-link" disabled={planReading} onClick={onRefreshReader}>
                    重试
                  </button>
                </div>
              ) : null}
              {planReading ? (
                <div className="plan-reader-loading" role="status" aria-live="polite" aria-atomic="true">
                  正在读取 Plan 全文…
                </div>
              ) : null}
              {!planReading && !planReadError ? (
                <section id={readerContentId} className="plan-reader-content" aria-label="Plan Markdown 正文">
                  <MarkdownReader
                    markdown={planReadResult?.markdown ?? ''}
                    emptyMessage="暂无计划正文"
                    ariaLabel="Plan Markdown 正文内容"
                  />
                </section>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

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
      {visibleTasks.length ? (
        <div className="list compact">
          {visibleTasks.map((task) => {
            const running = task.status === 'running';
            const completed = task.status === 'completed';
            const durationLabel = formatTaskDuration(task as TimedPlanTask);
            return (
              <RecordCard
                actions={
                  <div className="item-actions">
                    <button type="button" className="btn-link" disabled={completed || running} onClick={() => onRun?.(task)}>
                      执行
                    </button>
                    <button type="button" className="btn-link danger-link" disabled={!running} onClick={() => onStop?.(task)}>
                      停止
                    </button>
                  </div>
                }
                key={task.id}
                title={task.title}
                status={task.status}
                body={
                  task.file_path ? (
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
                  ) : null
                }
                meta={`${task.task_key} · ${durationLabel} · ${formatChinaDateTime(task.updated_at)}`}
              />
            );
          })}
        </div>
      ) : (
        <div className="empty">{currentEmptyText}</div>
      )}
    </div>
  );
}

export function EventList({ emptyText = '暂无事件。', events }: { emptyText?: string; events: AppEvent[] }) {
  if (!events.length) return <div className="empty">{emptyText}</div>;

  return (
    <div className="list compact event-list">
      {events.map((event) => {
        const display = formatEvent(event);
        return (
          <article className={`item event-item ${display.tone ? `event-item-${display.tone}` : ''}`} key={event.id}>
            <div className="item-title event-title">
              <span>{display.title}</span>
              {display.badge ? <span className={`event-badge event-badge-${display.tone}`}>{display.badge}</span> : null}
            </div>
            {display.body ? <div className="item-body plain-text">{display.body}</div> : null}
            <div className="meta event-meta">{display.meta}</div>
          </article>
        );
      })}
    </div>
  );
}
