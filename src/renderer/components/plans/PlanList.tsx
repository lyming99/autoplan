import type { KeyboardEvent, MouseEvent, ReactNode } from 'react';
import { useEffect, useId, useState } from 'react';
import type { Plan, PlanTask, WorkspacePlanReadState } from '../../types';
import { planCliSummaryLabel } from '../shared';
import { formatChinaDateTime } from '../../utils/time';
import { Icon } from '../icons';
import {
  formatPlanDurationSummary,
  planTitle,
  tasksForPlan,
  type ParallelRunRequest,
} from '../../utils/planTasks';
import { PlanReaderModal } from './PlanReaderModal';

const PLAN_CARD_INTERACTIVE_SELECTOR = [
  'a[href]',
  'button',
  'input',
  'select',
  'textarea',
  'summary',
  '[role="button"]',
  '[role="menu"]',
  '[role="menuitem"]',
  '[role="link"]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

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

function canStopPlan(plan: Plan, hasRunningTask: boolean) {
  return hasRunningTask || plan.status === 'running';
}

export function PlanList({
  emptyText = '暂无 plan。',
  latestReadingPlan,
  onCloseReader,
  onDeletePlan,
  onOpenReader,
  onRunParallel,
  onSelectPlan,
  onRefreshReader,
  onStopPlan,
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
  onDeletePlan?: (plan: Plan) => Promise<void> | void;
  onOpenReader: (plan: Plan) => void;
  onRunParallel?: (request: ParallelRunRequest) => void;
  onSelectPlan?: (plan: Plan) => void;
  onRefreshReader: () => void;
  onStopPlan?: (plan: Plan) => Promise<void> | void;
  plans: Plan[];
  readerState: WorkspacePlanReadState;
  renderPlanControls?: (plan: Plan) => ReactNode;
  selectedPlanId?: number | null;
  tasks?: PlanTask[];
  totalPlanCount?: number;
}) {
  const readingPlan = readerState.plan;
  const planReading = readerState.loading;
  const readerDialogId = useId();
  const menuBaseId = useId();
  const [confirmingPlan, setConfirmingPlan] = useState<Plan | null>(null);
  const [deletingPlan, setDeletingPlan] = useState<Plan | null>(null);
  const [openMenuPlanId, setOpenMenuPlanId] = useState<number | null>(null);

  useEffect(() => {
    if (openMenuPlanId === null) return undefined;

    function handlePointerDown(event: globalThis.PointerEvent) {
      const target = event.target;
      if (target instanceof Element && target.closest('[data-plan-action-menu="true"]')) return;
      setOpenMenuPlanId(null);
    }

    function handleKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key === 'Escape') setOpenMenuPlanId(null);
    }

    document.addEventListener('pointerdown', handlePointerDown, true);
    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
      document.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [openMenuPlanId]);

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
            const menuOpen = openMenuPlanId === plan.id;
            const menuId = `${menuBaseId}-plan-menu-${plan.id}`;
            const selected = selectedPlanId === plan.id;
            const progressTone = plan.validation_passed || plan.status === 'completed' ? ' success' : runningInPlan ? ' running' : '';
            const stopDisabledReason = !onStopPlan
              ? '计划停止入口不可用'
              : canStopPlan(plan, runningInPlan)
                ? ''
                : '仅运行中的计划可停止';
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
                  <div
                    className="plan-action-menu-wrap"
                    data-plan-action-menu="true"
                    onBlur={(event) => {
                      const nextFocus = event.relatedTarget;
                      if (!(nextFocus instanceof Node) || !event.currentTarget.contains(nextFocus)) {
                        setOpenMenuPlanId(null);
                      }
                    }}
                  >
                    <button
                      type="button"
                      className="plan-action-menu-button"
                      aria-haspopup="menu"
                      aria-expanded={menuOpen}
                      aria-controls={menuOpen ? menuId : undefined}
                      aria-label={`更多操作：${title || plan.file_path || `Plan #${plan.id}`}`}
                      title="更多操作"
                      onClick={(event) => {
                        event.stopPropagation();
                        setOpenMenuPlanId((current) => (current === plan.id ? null : plan.id));
                      }}
                    >
                      <Icon name="more-horizontal" size={16} aria-hidden />
                    </button>
                    {menuOpen ? (
                      <div className="plan-action-menu ctx-menu" id={menuId} role="menu">
                        <button
                          type="button"
                          className="plan-action-menu-item"
                          role="menuitem"
                          disabled={Boolean(stopDisabledReason)}
                          title={stopDisabledReason || '停止该计划'}
                          onClick={(event) => {
                            event.stopPropagation();
                            if (stopDisabledReason) return;
                            setOpenMenuPlanId(null);
                            void onStopPlan?.(plan);
                          }}
                        >
                          <Icon name="stop" size={15} aria-hidden />
                          <span>停止</span>
                        </button>
                        <button
                          type="button"
                          className="plan-action-menu-item danger"
                          role="menuitem"
                          title="删除该计划"
                          onClick={(event) => {
                            event.stopPropagation();
                            setOpenMenuPlanId(null);
                            setDeletingPlan(plan);
                          }}
                        >
                          <Icon name="trash" size={15} aria-hidden />
                          <span>删除</span>
                        </button>
                      </div>
                    ) : null}
                  </div>
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

      {deletingPlan ? (
        <div className="modal-mask" onClick={() => setDeletingPlan(null)}>
          <div className="modal plan-delete-confirm-modal" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
            <div className="modal-head">
              <h3>删除计划</h3>
              <button type="button" className="modal-close" onClick={() => setDeletingPlan(null)} aria-label="关闭删除计划确认">
                ×
              </button>
            </div>
            <div className="plan-delete-confirm-body">
              <p>删除后会先停止该计划运行，并删除计划文件和任务记录。</p>
              <p>关联的需求和反馈记录会保留，不会被删除。</p>
              <div className="plan-delete-target" title={deletingPlan.file_path}>
                {planTitle(deletingPlan) || deletingPlan.file_path || `Plan #${deletingPlan.id}`}
              </div>
            </div>
            <div className="modal-foot">
              <button type="button" className="btn" onClick={() => setDeletingPlan(null)}>取消</button>
              <button
                type="button"
                className="btn btn-danger"
                onClick={() => {
                  const plan = deletingPlan;
                  setDeletingPlan(null);
                  void onDeletePlan?.(plan);
                }}
              >
                删除计划
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <PlanReaderModal
        dialogId={readerDialogId}
        latestPlan={latestReadingPlan}
        onClose={onCloseReader}
        onRefresh={onRefreshReader}
        readerState={readerState}
      />
    </>
  );
}
