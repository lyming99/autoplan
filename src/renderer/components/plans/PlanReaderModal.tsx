import { memo, type KeyboardEvent } from 'react';
import { useEffect, useId, useRef } from 'react';
import type { Plan, WorkspacePlanReadState } from '../../types';
import { formatChinaDateTime } from '../../utils/time';
import { MarkdownReader } from '../MarkdownReader';
import { planCliSummaryLabel } from '../shared';

const PLAN_READER_FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

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

function getPlanReaderFocusableElements(container: HTMLElement) {
  return Array.from(container.querySelectorAll<HTMLElement>(PLAN_READER_FOCUSABLE_SELECTOR)).filter(
    (element) => element.getClientRects().length > 0 && element.getAttribute('aria-hidden') !== 'true',
  );
}

export const PlanReaderModal = memo(function PlanReaderModal({
  dialogId,
  latestPlan,
  onClose,
  onRefresh,
  readerState,
}: {
  dialogId?: string;
  latestPlan?: Plan | null;
  onClose: () => void;
  onRefresh: () => void;
  readerState: WorkspacePlanReadState;
}) {
  const readingPlan = readerState.plan;
  const planReadResult = readerState.result;
  const planReadError = readerState.error;
  const planReading = readerState.loading;
  const generatedDialogId = useId();
  const readerDialogId = dialogId || generatedDialogId;
  const readerTitleId = useId();
  const readerDescriptionId = useId();
  const readerContentId = useId();
  const readerDialogRef = useRef<HTMLDivElement>(null);
  const previouslyFocusedElementRef = useRef<HTMLElement | null>(null);
  const readerFilePath = planReadResult?.file_path || readingPlan?.file_path || '';
  const readerHash = planReadResult?.hash || readingPlan?.hash || '';
  const readerUpdatedAt = planReadResult?.updated_at || readingPlan?.updated_at || '';
  const readerPlanForSummary = latestPlan || readingPlan;
  const readerCliSummary = readerPlanForSummary ? planCliSummaryLabel(readerPlanForSummary) : '';
  const latestPlanUpdated = hasPlanReaderUpdate(readingPlan, latestPlan, planReadResult);
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
      onClose();
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

  if (!readingPlan) return null;

  return (
    <div className="modal-mask" onClick={onClose}>
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
              onClick={onRefresh}
              aria-label="重新读取 Plan 全文"
            >
              {planReading ? '读取中…' : '刷新'}
            </button>
            <button type="button" className="modal-close" onClick={onClose} aria-label="关闭 Plan 全文阅读">
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
              <button type="button" className="btn-link" disabled={planReading} onClick={onRefresh}>
                刷新读取
              </button>
            </div>
          ) : null}
          {planReadError ? (
            <div className="plan-reader-error" role="alert" aria-live="assertive" aria-atomic="true">
              <span>{planReadError}</span>
              <button type="button" className="btn-link" disabled={planReading} onClick={onRefresh}>
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
  );
});
