import type { KeyboardEvent, MouseEvent, ReactNode } from 'react';
import { useEffect, useId, useRef, useState } from 'react';
import type { Plan, PlanTask, WorkspacePlanReadState } from '../../types';
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

const PLAN_CARD_INTERACTIVE_SELECTOR = [
  'a[href]',
  'button',
  'input',
  'select',
  'textarea',
  'summary',
  '[role="button"]',
  '[role="link"]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function getPlanReaderFocusableElements(container: HTMLElement) {
  return Array.from(container.querySelectorAll<HTMLElement>(PLAN_READER_FOCUSABLE_SELECTOR)).filter(
    (element) => element.getClientRects().length > 0 && element.getAttribute('aria-hidden') !== 'true',
  );
}

function isPlanCardInteractiveEvent(event: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>) {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return false;
  const interactiveElement = target.closest<HTMLElement>(PLAN_CARD_INTERACTIVE_SELECTOR);
  return Boolean(
    interactiveElement &&
      interactiveElement !== event.currentTarget &&
      event.currentTarget.contains(interactiveElement),
  );
}

function parallelRunDisabledReason(plan: Plan, hasRunningTask: boolean) {
  if (hasRunningTask) return '该计划已有任务执行中';
  if (plan.validation_passed || plan.status === 'completed') return '计划已完成';
  if (!plan.concurrency_suggestion?.hasSafeParallelBatches) return '暂无安全可并发批次';
  return '';
}

function getPlanProgressPercent(plan: Plan) {
  const total = Math.max(0, Number(plan.total_tasks || 0));
  if (!total) return 0;
  return Math.max(0, Math.min(100, Math.round((Number(plan.completed_tasks || 0) / total) * 100)));
}

function planCardState(plan: Plan, hasRunningTask: boolean) {
  if (plan.is_draft || plan.status === 'draft') return 'draft';
  if (plan.validation_passed || plan.status === 'completed') return 'completed';
  if (hasRunningTask || plan.status === 'running') return 'running';
  return 'active';
}

function planCardChipClass(state: string) {
  if (state === 'completed') return 'chip-completed';
  if (state === 'running') return 'chip-running';
  if (state === 'draft') return 'chip-waiting';
  return 'chip-pending';
}

export function PlanList({
  emptyText = '暂无 plan。',
  latestReadingPlan,
  onCloseReader,
  onOpenReader,
  onRunParallel,
  onSelectPlan,
  onRefreshReader,
  plans,
  readerState,
  renderPlanControls,
  selectedPlanId,
  tasks = [],
  totalPlanCount = plans.length,
}: {
  emptyText?: string;
  latestReadingPlan?: Plan | null;
  onCloseReader: () => void;
  onOpenReader: (plan: Plan) => void;
  onRunParallel?: (request: ParallelRunRequest) => void;
  onSelectPlan?: (plan: Plan) => void;
  onRefreshReader: () => void;
  plans: Plan[];
  readerState: WorkspacePlanReadState;
  renderPlanControls?: (plan: Plan) => ReactNode;
  selectedPlanId?: number | null;
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
        <div className="list compact plan-card-list">
          {plans.map((plan) => {
            const planTasks = tasksForPlan(tasks, plan, totalPlanCount);
            const durationSummary = formatPlanDurationSummary(planTasks);
            const title = planTitle(plan);
            const progressPercent = getPlanProgressPercent(plan);
            const cliSummary = planCliSummaryLabel(plan);
            const readingThisPlan = Boolean(
              readingPlan && readingPlan.id === plan.id && readingPlan.project_id === plan.project_id,
            );
            const disableRead = planReading && readingThisPlan;
            const suggestion = plan.concurrency_suggestion;
            const runningInPlan = planTasks.some((task) => task.status === 'running');
            const parallelDisabledReason = parallelRunDisabledReason(plan, runningInPlan);
            const canRunParallel = Boolean(onRunParallel && suggestion?.hasSafeParallelBatches && !parallelDisabledReason);
            const cardState = planCardState(plan, runningInPlan);
            const selected = selectedPlanId === plan.id;
            const progressTone = plan.validation_passed || plan.status === 'completed' ? ' success' : runningInPlan ? ' running' : '';
            return (
              <article
                className={`plan-card ${cardState}${selected ? ' selected' : ''}`}
                key={plan.id}
                aria-selected={onSelectPlan ? selected : undefined}
                data-plan-status={cardState}
                data-selected={selected ? 'true' : undefined}
                tabIndex={onSelectPlan ? 0 : undefined}
                onClick={(event) => {
                  if (isPlanCardInteractiveEvent(event)) return;
                  onSelectPlan?.(plan);
                }}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' && event.key !== ' ') return;
                  if (isPlanCardInteractiveEvent(event)) return;
                  event.preventDefault();
                  onSelectPlan?.(plan);
                }}
              >
                <div className="plan-top">
                  <span className={`chip ${planCardChipClass(cardState)}`}>{plan.status}</span>
                  <span className={`plan-title${cardState === 'draft' ? ' muted' : ''}`} title={title || plan.file_path}>
                    {title || '未命名计划'}
                  </span>
                </div>

                <div className="plan-path" title={plan.file_path}>{plan.file_path}</div>

                <div className="plan-progress">
                  <div className="progress-head">
                    <span className="ph-left">任务进度</span>
                    <span className="ph-right">{plan.completed_tasks} / {plan.total_tasks} · {progressPercent}%</span>
                  </div>
                  <div className={`progress${progressTone}`} aria-hidden="true">
                    <span style={{ width: `${progressPercent}%` }} />
                  </div>
                  <div className="plan-progress-subline">{durationSummary}</div>
                </div>

                <div className="concurrency-row">
                  <span className="conc-item parallel">可并发 <b>{suggestion?.parallelTaskCount || 0}</b></span>
                  <span className="conc-item batch">建议 <b>{suggestion?.batchCount || 0}</b> 批</span>
                  <span className="conc-item serial">串行 <b>{suggestion?.serialTaskCount || 0}</b></span>
                  {parallelDisabledReason ? <span className="conc-item blocked" title={parallelDisabledReason}>原因：{parallelDisabledReason}</span> : null}
                </div>

                <div className="plan-meta">
                  <span className="cli-tag">{cliSummary}</span>
                  <span className="meta-dot" />
                  <span className="mono">{plan.hash?.slice(0, 12) || 'no-hash'}</span>
                  <span className="meta-dot" />
                  <span>{formatChinaDateTime(plan.updated_at)}</span>
                </div>

                <div className="plan-actions">
                  <div className="plan-primary-actions">
                    <button
                      type="button"
                      className="btn btn-sm btn-primary plan-parallel-link"
                      disabled={!canRunParallel}
                      title={parallelDisabledReason || undefined}
                      onClick={() => setConfirmingPlan(plan)}
                    >
                      并发执行
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm plan-read-link"
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
                  {renderPlanControls ? <div className="plan-secondary-actions">{renderPlanControls(plan)}</div> : null}
                  <span className={`plan-validation ${plan.validation_passed ? 'passed' : 'pending'}`}>
                    验收 {plan.validation_passed ? 'passed' : 'pending'}
                  </span>
                </div>
              </article>
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
