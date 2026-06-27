import type { KeyboardEvent } from 'react';
import { useEffect, useId, useRef, useState } from 'react';
import type { Plan, PlanTask, ReadPlanTask, WorkspacePlanReadState } from '../../types';
import { RecordCard } from '../IntakePanel';
import { MarkdownReader } from '../MarkdownReader';
import { planCliSummaryLabel } from '../shared';
import { formatChinaDateTime } from '../../utils/time';
import {
  formatPlanDurationSummary,
  planTitle,
  tasksForPlan,
  type ParallelRunRequest,
} from '../../utils/planTasks';

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

function parallelRunDisabledReason(plan: Plan, hasRunningTask: boolean) {
  if (hasRunningTask) return '该计划已有任务执行中';
  if (plan.validation_passed || plan.status === 'completed') return '计划已完成';
  if (!plan.concurrency_suggestion?.hasSafeParallelBatches) return '暂无安全可并发批次';
  return '';
}

function readPlanTaskStatusLabel(status: string) {
  if (status === 'completed') return '已完成';
  if (status === 'running') return '执行中';
  if (status === 'blocked') return '已阻塞';
  if (status === 'failed') return '失败';
  return '待执行';
}

function readPlanTaskScopeLabel(task: ReadPlanTask) {
  return task.scopes?.length ? task.scopes.join(', ') : task.scope || 'unknown';
}

function hasReaderTaskParseWarning(result: WorkspacePlanReadState['result']) {
  if (!result) return false;
  return result.task_parse_status === 'parse_empty' || (result.task_parse_has_task_section && !result.task_total);
}


export function PlanList({
  emptyText = '暂无 plan。',
  latestReadingPlan,
  onCloseReader,
  onOpenReader,
  onRunParallel,
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
  onRunParallel?: (request: ParallelRunRequest) => void;
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
  const readerPlanForSummary = latestReadingPlan || readingPlan;
  const readerCliSummary = readerPlanForSummary ? planCliSummaryLabel(readerPlanForSummary) : '';
  const latestPlanUpdated = hasPlanReaderUpdate(readingPlan, latestReadingPlan, planReadResult);
  const readerTasks = planReadResult?.tasks || [];
  const readerTaskTotal = planReadResult?.task_total ?? readerTasks.length;
  const readerTaskCompleted = planReadResult?.task_completed ?? readerTasks.filter((task) => task.status === 'completed').length;
  const readerTaskParseMessage = planReadResult?.task_parse_message || '尚未读取任务拆解解析结果。';
  const readerTaskParseWarning = hasReaderTaskParseWarning(planReadResult);
  const readerDialogId = useId();
  const readerTitleId = useId();
  const readerDescriptionId = useId();
  const readerContentId = useId();
  const readerDialogRef = useRef<HTMLDivElement>(null);
  const previouslyFocusedElementRef = useRef<HTMLElement | null>(null);
  const [confirmingPlan, setConfirmingPlan] = useState<Plan | null>(null);
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
            const planTasks = tasksForPlan(tasks, plan, totalPlanCount);
            const durationSummary = formatPlanDurationSummary(planTasks);
            const title = planTitle(plan);
            const progressSummary = `${plan.completed_tasks}/${plan.total_tasks} tasks · ${durationSummary} · validation ${
              plan.validation_passed ? 'passed' : 'pending'
            }`;
            const cliSummary = planCliSummaryLabel(plan);
            const readingThisPlan = Boolean(
              readingPlan && readingPlan.id === plan.id && readingPlan.project_id === plan.project_id,
            );
            const disableRead = planReading && readingThisPlan;
            const suggestion = plan.concurrency_suggestion;
            const runningInPlan = planTasks.some((task) => task.status === 'running');
            const parallelDisabledReason = parallelRunDisabledReason(plan, runningInPlan);
            const canRunParallel = Boolean(onRunParallel && suggestion?.hasSafeParallelBatches && !parallelDisabledReason);
            return (
              <RecordCard
                actions={
                  <div className="item-actions">
                    <button
                      type="button"
                      className="btn-link plan-parallel-link"
                      disabled={!canRunParallel}
                      title={parallelDisabledReason || undefined}
                      onClick={() => setConfirmingPlan(plan)}
                    >
                      并发执行
                    </button>
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
                    <div className="plan-parallel-summary">
                      <span>可并发 {suggestion?.parallelTaskCount || 0} 个</span>
                      <span>建议 {suggestion?.batchCount || 0} 批</span>
                      <span>串行 {suggestion?.serialTaskCount || 0} 个</span>
                      {parallelDisabledReason ? <span title={parallelDisabledReason}>原因：{parallelDisabledReason}</span> : null}
                    </div>
                  </div>
                }
                meta={`${cliSummary} · ${plan.hash?.slice(0, 12) || ''} · ${formatChinaDateTime(plan.updated_at)}`}
              />
            );
          })}
        </div>
      ) : (
        <div className="empty">{emptyText}</div>
      )}

      {confirmingPlan ? (
        <div className="modal-mask" onClick={() => setConfirmingPlan(null)}>
          <div className="modal parallel-confirm-modal" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
            <div className="modal-head">
              <h3>确认并发执行</h3>
              <button type="button" className="modal-close" onClick={() => setConfirmingPlan(null)} aria-label="关闭并发执行确认">
                ×
              </button>
            </div>
            <div className="parallel-confirm-body">
              <p>确认后将按以下安全批次启动；取消不会改变任务状态。</p>
              {confirmingPlan.concurrency_suggestion.batches.map((batch) => (
                <section className="parallel-batch-card" key={batch.batch}>
                  <div className="parallel-batch-head">
                    <strong>批次 {batch.batch}</strong>
                    <span>{batch.reason}</span>
                  </div>
                  <ul>
                    {batch.tasks.map((task) => (
                      <li key={task.id}>
                        <span>{task.task_key} · {task.title}</span>
                        <small className="mono">{task.scopes.join(', ')}</small>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
              {confirmingPlan.concurrency_suggestion.serialTasks.length ? (
                <details className="parallel-serial-reasons">
                  <summary>查看不建议并发原因</summary>
                  <ul>
                    {confirmingPlan.concurrency_suggestion.serialTasks.map((task) => (
                      <li key={task.id}>{task.task_key}：{task.reason}</li>
                    ))}
                  </ul>
                </details>
              ) : null}
            </div>
            <div className="modal-foot">
              <button type="button" className="btn" onClick={() => setConfirmingPlan(null)}>取消</button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  const plan = confirmingPlan;
                  setConfirmingPlan(null);
                  onRunParallel?.({
                    plan,
                    batches: plan.concurrency_suggestion.batches.map((batch) => ({
                      taskIds: batch.tasks.map((task) => task.id),
                    })),
                  });
                }}
              >
                确认并发执行
              </button>
            </div>
          </div>
        </div>
      ) : null}

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
                  <dt>CLI</dt>
                  <dd>{readerCliSummary || '-'}</dd>
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
                <div className="plan-reader-summary-item">
                  <dt>任务拆解</dt>
                  <dd>{readerTaskTotal ? `${readerTaskCompleted}/${readerTaskTotal}` : '0'}</dd>
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
              {!planReading && !planReadError && planReadResult ? (
                <section className="plan-reader-task-summary" aria-label="任务拆解解析结果">
                  <div className={readerTaskParseWarning ? 'plan-reader-error' : 'hint'} role={readerTaskParseWarning ? 'alert' : 'status'}>
                    {readerTaskParseMessage}
                  </div>
                  {readerTasks.length ? (
                    <ul className="list compact" aria-label="已解析任务列表">
                      {readerTasks.map((task) => (
                        <li key={task.id} className="task-scope-chip">
                          <span className="mono">{task.task_key}</span>
                          <span>{task.title}</span>
                          <small>{readPlanTaskStatusLabel(task.status)}</small>
                          <small className="mono">{readPlanTaskScopeLabel(task)}</small>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </section>
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
