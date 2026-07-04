import { FormEvent, ReactNode, useEffect, useMemo, useState } from 'react';
import type {
  AgentCliOption,
  AgentCliProvider,
  Attachment,
  CodexReasoningEffort,
  Feedback,
  IntakeType,
  LinkedPlanSummary,
  PendingAttachment,
  Plan,
  Requirement,
  RetryIntakePlanGenerationOptions,
} from '../types';
import {
  AttachmentGrid,
  planCliSummaryLabel,
  readAgentCliProvider,
  readCodexReasoningEffort,
  sourceTypeName,
} from './shared';
import { Composer, type ComposerSubmitPayload } from './Composer';
import { formatChinaDateTime } from '../utils/time';
import {
  currentLinkedPlanSummary,
  normalizeLinkedPlanId,
  normalizeLinkedPlans,
  type LinkedPlanIntakeItem,
} from '../utils/linkedPlan';
import {
  agentCliOptions,
  codexReasoningOptions,
  isCodexAgentCliProvider,
  normalizeAgentCliProvider,
  normalizeCodexReasoningEffort,
} from '../utils/workspaceForms';

type IntakeItem = Requirement | Feedback;
type IntakeUpdate = { title?: string; body?: string; status?: string };
type PlanPreviewHandler = (item: IntakeItem, linkedPlan?: LinkedPlanSummary | null) => void;
type IntakeRetryDraft = { agentCliProvider: AgentCliProvider; codexReasoningEffort: CodexReasoningEffort };
type IntakeGenerateFailure = {
  reason: string;
  failedAt: string;
  failCount: number;
  logFile: string;
  failedCliProvider: AgentCliProvider | null;
  failedCodexReasoningEffort: CodexReasoningEffort | null;
};

const INTAKE_INITIAL_VISIBLE_COUNT = 80;
const INTAKE_LOAD_MORE_COUNT = 80;
const EMPTY_ATTACHMENTS: Attachment[] = [];

interface IntakePanelProps {
  attachments: Attachment[];
  composerIdentityKey?: string;
  draftValue: string;
  emptyText: string;
  heading: string;
  items: IntakeItem[];
  locateItemId?: number | null;
  pendingAttachments: PendingAttachment[];
  placeholder: string;
  plans?: Plan[];
  submitLabel: string;
  subtitle: string;
  type: IntakeType;
  onAddFiles: (type: IntakeType, files: FileList | File[] | null) => void;
  onDraftChange: (next: string) => void;
  onDelete: (id: number) => Promise<boolean>;
  onRemoveAttachment: (type: IntakeType, index: number) => void;
  onSubmit: (body: string | ComposerSubmitPayload) => Promise<boolean>;
  onUpdate: (id: number, input: IntakeUpdate) => Promise<boolean>;
  onInterrupt: (type: IntakeType, id: number) => Promise<void>;
  onResume: (type: IntakeType, id: number) => Promise<void>;
  onAppendTask: (type: IntakeType, id: number, title: string) => Promise<void>;
  onPreviewPlan?: PlanPreviewHandler;
  onRetryGeneratePlan?: (type: IntakeType, id: number, options?: RetryIntakePlanGenerationOptions) => Promise<void> | void;
  retryAgentCliOptions?: AgentCliOption[];
  retryCodexReasoningOptions?: AgentCliOption[];
}

export function IntakePanel({
  attachments,
  composerIdentityKey,
  draftValue,
  emptyText,
  heading,
  items,
  locateItemId = null,
  pendingAttachments,
  placeholder,
  plans = [],
  submitLabel,
  subtitle,
  type,
  onAddFiles,
  onDraftChange,
  onDelete,
  onRemoveAttachment,
  onSubmit,
  onUpdate,
  onInterrupt,
  onResume,
  onAppendTask,
  onPreviewPlan,
  onRetryGeneratePlan,
  retryAgentCliOptions = agentCliOptions,
  retryCodexReasoningOptions = codexReasoningOptions,
}: IntakePanelProps) {
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState({ title: '', body: '', status: 'open' });
  const [appendId, setAppendId] = useState<number | null>(null);
  const [appendText, setAppendText] = useState('');
  const [retryingKey, setRetryingKey] = useState<string | null>(null);
  const [retryDrafts, setRetryDrafts] = useState<Record<string, IntakeRetryDraft>>({});
  const [visibleLimit, setVisibleLimit] = useState(INTAKE_INITIAL_VISIBLE_COUNT);

  const attachmentsByOwner = useMemo(() => {
    const grouped = new Map<string, Attachment[]>();
    for (const attachment of attachments) {
      const key = intakeAttachmentKey(attachment.owner_type, attachment.owner_id);
      const group = grouped.get(key);
      if (group) {
        group.push(attachment);
      } else {
        grouped.set(key, [attachment]);
      }
    }
    return grouped;
  }, [attachments]);

  useEffect(() => {
    setVisibleLimit(INTAKE_INITIAL_VISIBLE_COUNT);
  }, [type]);

  useEffect(() => {
    if (!locateItemId) return;
    const targetIndex = items.findIndex((item) => Number(item.id) === Number(locateItemId));
    if (targetIndex < 0) return;
    setVisibleLimit((current) => Math.max(current, targetIndex + 1));
  }, [items, locateItemId]);

  const visibleCount = Math.min(visibleLimit, items.length);
  const visibleItems = useMemo(() => items.slice(0, visibleCount), [items, visibleCount]);
  const hasMoreItems = visibleCount < items.length;

  const startEdit = (item: IntakeItem) => {
    setEditingId(item.id);
    setEditDraft({ title: item.title || '', body: item.body || '', status: item.status || 'open' });
  };

  const submitEdit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editingId) return;
    const ok = await onUpdate(editingId, {
      title: editDraft.title.trim(),
      body: editDraft.body,
      status: editDraft.status,
    });
    if (ok) setEditingId(null);
  };

  const deleteItem = async (item: IntakeItem) => {
    const linkedPlans = linkedPlansOf(item);
    const linkedPlanId = linkedPlanIdOf(item, linkedPlans);
    const cascadeWarning = linkedPlans.length > 1
      ? `关联的 ${linkedPlans.length} 个阶段 Plan、全部任务和运行中执行会一并停止并删除。`
      : linkedPlanId === null
      ? '该记录及其附件会被删除。'
      : `关联 Plan #${linkedPlanId}、全部任务和运行中执行会一并停止并删除。`;
    if (!window.confirm(`确定删除${sourceTypeName(type)} #${item.id} 吗？${cascadeWarning}`)) return;
    const ok = await onDelete(item.id);
    if (ok && editingId === item.id) setEditingId(null);
  };

  const submitAppend = async (item: IntakeItem) => {
    const title = appendText.trim();
    if (!title) {
      setAppendId(null);
      return;
    }
    await onAppendTask(type, item.id, title);
    setAppendText('');
    setAppendId(null);
  };

  const planStatus = (item: IntakeItem, linkedPlans = linkedPlansOf(item)) =>
    linkedPlanStatus(currentLinkedPlanSummary(linkedPlans)) || readStringField(item, ['plan_status', 'linked_plan_status']) || null;

  const retryGeneratePlan = async (item: IntakeItem, draft: IntakeRetryDraft) => {
    if (!onRetryGeneratePlan) return;
    const key = retryDraftKey(type, item.id);
    setRetryingKey(key);
    try {
      await onRetryGeneratePlan(type, item.id, retryOptionsFromDraft(draft));
    } finally {
      setRetryingKey((current) => (current === key ? null : current));
    }
  };

  return (
    <div className="intake-layout">
      <div className="intake-stream">
        <div className="section-heading">
          <h2>{heading}</h2>
          <span>{subtitle}</span>
        </div>
        <div className="list intake-list">
          {items.length ? (
            <>
            {visibleItems.map((item) => {
              const itemAttachments = attachmentsByOwner.get(intakeAttachmentKey(type, item.id)) || EMPTY_ATTACHMENTS;
              const title = `${sourceTypeName(type)} #${item.id} · ${item.title || '未命名'}`;
              const cliSummary = planCliSummaryLabel(item);

              if (editingId === item.id) {
                return (
                  <article className="item" id={workspaceSearchAnchorId(type, item.id)} data-search-anchor="true" key={item.id}>
                    <div className="item-title">
                      <span>{title}</span>
                      <span className="item-title-right">
                        <span className="cli-tag">{cliSummary}</span>
                        <span className={`chip ${statusChip(item.status)}`}>{item.status}</span>
                      </span>
                    </div>
                    <form className="inline-editor" onSubmit={submitEdit}>
                      <label className="field">
                        标题
                        <input
                          value={editDraft.title}
                          onChange={(event) => setEditDraft((current) => ({ ...current, title: event.target.value }))}
                        />
                      </label>
                      <label className="field">
                        状态
                        <select
                          value={editDraft.status}
                          onChange={(event) => setEditDraft((current) => ({ ...current, status: event.target.value }))}
                        >
                          <option value="open">open</option>
                          <option value="active">active</option>
                          <option value="completed">completed</option>
                          <option value="closed">closed</option>
                        </select>
                      </label>
                      <label className="field">
                        内容
                        <textarea
                          value={editDraft.body}
                          onChange={(event) => setEditDraft((current) => ({ ...current, body: event.target.value }))}
                        />
                      </label>
                      <AttachmentGrid attachments={itemAttachments} />
                      <div className="button-row">
                        <button type="submit" className="btn btn-primary btn-sm">
                          保存
                        </button>
                        <button type="button" className="btn btn-sm" onClick={() => setEditingId(null)}>
                          取消
                        </button>
                      </div>
                    </form>
                  </article>
                );
              }

              const linkedPlans = linkedPlansOf(item);
              const ps = planStatus(item, linkedPlans);
              const hasPlan = linkedPlans.length > 0;
              const multiplePlans = linkedPlans.length > 1;
              const canInterrupt = hasInterruptibleLinkedPlan(linkedPlans, ps);
              const canResume = hasInterruptedLinkedPlan(linkedPlans, ps);
              const showAppend = appendId === item.id;
              const failure = hasPlan ? null : intakeGenerationFailure(item);
              const retryKey = retryDraftKey(type, item.id);
              const retryDraft = retryDrafts[retryKey] || retryDraftFromItem(item);

              return (
                <article className="item intake-item" id={workspaceSearchAnchorId(type, item.id)} data-search-anchor="true" key={item.id}>
                  <div className="item-title">
                    <span>{title}</span>
                    <span className="item-title-right">
                      <span className="cli-tag">{cliSummary}</span>
                      <span className={`chip ${statusChip(item.status)}`}>{item.status}</span>
                    </span>
                  </div>
                  {item.body ? <div className="item-body plain-text">{item.body}</div> : null}
                  <AttachmentGrid attachments={itemAttachments} />

                  {hasPlan ? (
                    <PlanBindingCard item={item} plans={plans} onPreviewPlan={onPreviewPlan} />
                  ) : failure ? (
                    <IntakeGenerateFailureCard
                      canRetry={Boolean(onRetryGeneratePlan)}
                      draft={retryDraft}
                      failure={failure}
                      onDraftChange={(next) => {
                        setRetryDrafts((current) => ({ ...current, [retryKey]: next }));
                      }}
                      onRetry={() => void retryGeneratePlan(item, retryDraft)}
                      retryAgentCliOptions={retryAgentCliOptions}
                      retryCodexReasoningOptions={retryCodexReasoningOptions}
                      retrying={retryingKey === retryKey}
                    />
                  ) : null}

                  <div className="item-foot">
                    <div className="item-actions">
                      <button type="button" className="btn-link" onClick={() => startEdit(item)}>
                        编辑
                      </button>
                      {canInterrupt ? (
                        <button
                          type="button"
                          className="btn-link"
                          onClick={() => void onInterrupt(type, item.id)}
                        >
                          {multiplePlans ? '中断阶段计划' : '中断'}
                        </button>
                      ) : null}
                      {canResume ? (
                        <button
                          type="button"
                          className="btn-link"
                          onClick={() => void onResume(type, item.id)}
                        >
                          {multiplePlans ? '恢复阶段计划' : '恢复'}
                        </button>
                      ) : null}
                      {hasPlan ? (
                        <button
                          type="button"
                          className="btn-link"
                          onClick={() => {
                            setAppendId(showAppend ? null : item.id);
                            setAppendText('');
                          }}
                        >
                          {showAppend ? '取消追加' : multiplePlans ? '+ 追加到阶段' : '+ 追加任务'}
                        </button>
                      ) : null}
                      <button type="button" className="btn-link danger-link" onClick={() => void deleteItem(item)}>
                        删除
                      </button>
                    </div>
                    <span className="meta">{formatChinaDateTime(item.updated_at)}</span>
                  </div>

                  {showAppend ? (
                    <div className="append-row">
                      <input
                        className="append-input"
                        value={appendText}
                        onChange={(event) => setAppendText(event.target.value)}
                        placeholder={multiplePlans ? '输入任务标题，Enter 追加到当前阶段计划' : '输入任务标题，Enter 追加到计划'}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            event.preventDefault();
                            void submitAppend(item);
                          }
                          if (event.key === 'Escape') {
                            setAppendId(null);
                            setAppendText('');
                          }
                        }}
                      />
                      <button type="button" className="btn btn-sm btn-primary" onClick={() => void submitAppend(item)}>
                        追加
                      </button>
                    </div>
                  ) : null}
                </article>
              );
            })}
            {hasMoreItems ? (
              <div className="intake-list-more">
                <span>已显示 {visibleCount} / {items.length}</span>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => setVisibleLimit((current) => Math.min(items.length, current + INTAKE_LOAD_MORE_COUNT))}
                >
                  加载更多
                </button>
              </div>
            ) : null}
            </>
          ) : (
            <div className="empty">{emptyText}</div>
          )}
        </div>
      </div>

      <Composer
        key={composerIdentityKey || type}
        identityKey={composerIdentityKey || type}
        pendingAttachments={pendingAttachments}
        placeholder={placeholder}
        submitLabel={submitLabel}
        type={type}
        value={draftValue}
        onValueChange={onDraftChange}
        onAddFiles={onAddFiles}
        onRemoveAttachment={onRemoveAttachment}
        onSubmit={onSubmit}
      />
    </div>
  );
}

function IntakeGenerateFailureCard({
  canRetry,
  draft,
  failure,
  onDraftChange,
  onRetry,
  retryAgentCliOptions,
  retryCodexReasoningOptions,
  retrying,
}: {
  canRetry: boolean;
  draft: IntakeRetryDraft;
  failure: IntakeGenerateFailure;
  onDraftChange: (next: IntakeRetryDraft) => void;
  onRetry: () => void;
  retryAgentCliOptions: AgentCliOption[];
  retryCodexReasoningOptions: AgentCliOption[];
  retrying: boolean;
}) {
  const agentCliProvider = normalizeAgentCliProvider(draft.agentCliProvider);
  const showCodexReasoning = isCodexAgentCliProvider(agentCliProvider);
  const providerOptions = retryAgentCliOptions.length ? retryAgentCliOptions : agentCliOptions;
  const reasoningOptions = retryCodexReasoningOptions.length ? retryCodexReasoningOptions : codexReasoningOptions;
  const failedCliSummary = failure.failedCliProvider
    ? planCliSummaryLabel({
      agent_cli_provider: failure.failedCliProvider,
      codex_reasoning_effort: failure.failedCodexReasoningEffort,
    })
    : '';

  return (
    <div className="intake-failure-card">
      <div className="intake-failure-head">
        <div className="intake-failure-title">
          <strong>计划生成失败</strong>
          <span>失败状态</span>
        </div>
        <span className="chip chip-failed">失败</span>
      </div>

      <div className="intake-failure-body">
        <p className="intake-failure-reason">{failure.reason}</p>
        <div className="intake-failure-meta">
          <span>
            失败时间 <b>{failure.failedAt ? formatChinaDateTime(failure.failedAt) : '未记录'}</b>
          </span>
          <span>
            失败次数 <b>{failure.failCount > 0 ? `${failure.failCount} 次` : '未记录'}</b>
          </span>
          {failedCliSummary ? (
            <span>
              失败时 CLI <b>{failedCliSummary}</b>
            </span>
          ) : null}
        </div>
        <div className="intake-failure-log">
          <span>日志路径</span>
          <code title={failure.logFile || undefined}>{failure.logFile || '未记录'}</code>
        </div>
      </div>

      <div className="intake-retry-controls">
        <label className="intake-retry-field">
          <span>CLI</span>
          <select
            className="field-select"
            disabled={retrying}
            value={agentCliProvider}
            onChange={(event) => {
              onDraftChange({
                ...draft,
                agentCliProvider: normalizeAgentCliProvider(event.target.value),
              });
            }}
          >
            {providerOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        {showCodexReasoning ? (
          <label className="intake-retry-field">
            <span>思考深度</span>
            <select
              className="field-select"
              disabled={retrying}
              value={normalizeCodexReasoningEffort(draft.codexReasoningEffort)}
              onChange={(event) => {
                onDraftChange({
                  ...draft,
                  codexReasoningEffort: normalizeCodexReasoningEffort(event.target.value),
                });
              }}
            >
              {reasoningOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        <div className="intake-retry-actions">
          <button
            type="button"
            className="btn btn-sm btn-primary"
            disabled={!canRetry || retrying}
            onClick={onRetry}
          >
            {retrying ? '正在重试...' : '重试生成计划'}
          </button>
        </div>
      </div>
    </div>
  );
}

function PlanBindingCard({
  item,
  plans,
  onPreviewPlan,
}: {
  item: IntakeItem;
  plans: Plan[];
  onPreviewPlan?: PlanPreviewHandler;
}) {
  const linkedPlans = linkedPlansOf(item);
  if (linkedPlans.length === 0) return null;
  const currentPlan = currentLinkedPlanSummary(linkedPlans) || linkedPlans[0];
  const currentStatus = linkedPlanStatus(currentPlan);
  const multiplePlans = linkedPlans.length > 1;

  if (!multiplePlans) {
    const linkedPlan = linkedPlans[0];
    const linkedPlanId = linkedPlanIdFromSummary(linkedPlan);
    const phase = linkedPlanDisplay(linkedPlan, item, plans, 1, true);
    const canPreview = linkedPlanId !== null && Boolean(onPreviewPlan);
    const previewTitle = canPreview ? `预览 Plan #${linkedPlanId}` : '绑定 Plan ID 无效，暂无法预览';
    const progressClass = phase.status === 'completed' ? ' success' : phase.status ? ' running' : '';

    return (
      <div className={`intake-plan-card${phase.available ? '' : ' is-unavailable'}`}>
        <div className="intake-plan-head">
          <div className="intake-plan-main">
            <span className="intake-plan-label">绑定 Plan</span>
            <strong className="intake-plan-name" title={phase.displayTitle}>
              {phase.displayName}
            </strong>
            {phase.title && phase.filePath ? (
              <span className="intake-plan-path" title={phase.filePath}>
                {phase.filePath}
              </span>
            ) : null}
          </div>
          <div className="intake-plan-side">
            {phase.available ? (
              <span className={`chip ${phase.status ? planChipClass(phase.status) : 'chip-waiting'}`}>
                {phase.status ? planStatusLabel(phase.status) : '状态未知'}
              </span>
            ) : (
              <span className="chip chip-waiting">计划不可用</span>
            )}
            <button
              type="button"
              className="btn btn-sm"
              disabled={!canPreview}
              title={previewTitle}
              onClick={() => {
                if (canPreview) onPreviewPlan?.(item, linkedPlan);
              }}
            >
              预览 Plan
            </button>
          </div>
        </div>

        <div className="intake-plan-details">
          <span>
            Plan ID <b>#{linkedPlanId}</b>
          </span>
          <span>
            任务进度 <b>{phase.progressLabel}</b>
          </span>
        </div>

        <div className="intake-plan-progress" aria-label={`Plan 任务完成进度 ${phase.progressLabel}`}>
          <div className={`progress${progressClass}`}>
            <span style={{ width: `${phase.progressPct}%` }} />
          </div>
        </div>

        {phase.available ? null : <p className="intake-plan-unavailable">绑定 Plan 当前不可用，点击预览可查看占位详情。</p>}
      </div>
    );
  }

  const totalCompleted = linkedPlans.reduce((sum, linkedPlan) => sum + linkedPlanTaskCounts(linkedPlan).completed, 0);
  const totalTasks = linkedPlans.reduce((sum, linkedPlan) => sum + linkedPlanTaskCounts(linkedPlan).total, 0);
  const overallPct = totalTasks > 0 ? progressPct(totalCompleted, totalTasks) : 0;
  const currentPhaseIndex = linkedPlanPhaseIndex(currentPlan, 1);
  const progressClass = currentStatus === 'completed' ? ' success' : currentStatus ? ' running' : '';

  return (
    <div className="intake-plan-card intake-plan-card--multi">
      <div className="intake-plan-head">
        <div className="intake-plan-main">
          <span className="intake-plan-label">阶段计划</span>
          <strong className="intake-plan-name">
            {linkedPlans.length} 个阶段 Plan
          </strong>
          <span className="intake-plan-path">
            当前阶段：阶段 {currentPhaseIndex}
          </span>
        </div>
        <div className="intake-plan-side">
          <span className={`chip ${currentStatus ? planChipClass(currentStatus) : 'chip-waiting'}`}>
            {currentStatus ? planStatusLabel(currentStatus) : '状态未知'}
          </span>
        </div>
      </div>

      <div className="intake-plan-details">
        <span>
          阶段数 <b>{linkedPlans.length}</b>
        </span>
        <span>
          总进度 <b>{totalTasks > 0 ? `${totalCompleted}/${totalTasks} · ${overallPct}%` : '暂无任务进度'}</b>
        </span>
      </div>

      <div className="intake-plan-progress" aria-label={`阶段计划总进度 ${totalTasks > 0 ? `${overallPct}%` : '暂无任务进度'}`}>
        <div className={`progress${progressClass}`}>
          <span style={{ width: `${overallPct}%` }} />
        </div>
      </div>

      <div className="intake-plan-phase-list">
        {linkedPlans.map((linkedPlan, index) => (
          <PlanPhaseRow
            currentPlan={currentPlan}
            item={item}
            key={`${linkedPlanIdFromSummary(linkedPlan) || 'missing'}-${linkedPlanPhaseIndex(linkedPlan, index + 1)}`}
            linkedPlan={linkedPlan}
            onPreviewPlan={onPreviewPlan}
            phaseFallback={index + 1}
            plans={plans}
          />
        ))}
      </div>
    </div>
  );
}

function PlanPhaseRow({
  currentPlan,
  item,
  linkedPlan,
  onPreviewPlan,
  phaseFallback,
  plans,
}: {
  currentPlan: LinkedPlanSummary;
  item: IntakeItem;
  linkedPlan: LinkedPlanSummary;
  onPreviewPlan?: PlanPreviewHandler;
  phaseFallback: number;
  plans: Plan[];
}) {
  const planId = linkedPlanIdFromSummary(linkedPlan);
  const phase = linkedPlanDisplay(linkedPlan, item, plans, phaseFallback);
  const isCurrent = isCurrentLinkedPlan(linkedPlan, currentPlan);
  const canPreview = planId !== null && Boolean(onPreviewPlan);
  const progressClass = phase.status === 'completed' ? ' success' : phase.status ? ' running' : '';

  return (
    <div className={`intake-plan-phase${isCurrent ? ' is-current' : ''}${phase.available ? '' : ' is-unavailable'}`}>
      <div className="intake-plan-phase-head">
        <div className="intake-plan-phase-main">
          <span className="intake-plan-phase-kicker">
            阶段 {phase.phaseIndex}
            {phase.phaseTitle ? ` · ${phase.phaseTitle}` : ''}
          </span>
          <strong className="intake-plan-phase-title" title={phase.displayTitle}>
            {phase.displayName}
          </strong>
          {phase.filePath ? (
            <span className="intake-plan-phase-path" title={phase.filePath}>
              {phase.filePath}
            </span>
          ) : null}
        </div>
        <div className="intake-plan-phase-side">
          {isCurrent ? <span className="intake-plan-current">当前阶段</span> : null}
          <span className={`chip ${phase.status ? planChipClass(phase.status) : 'chip-waiting'}`}>
            {phase.available ? (phase.status ? planStatusLabel(phase.status) : '状态未知') : '计划不可用'}
          </span>
          <button
            type="button"
            className="btn btn-sm"
            disabled={!canPreview}
            title={canPreview ? `预览 Plan #${planId}` : '绑定 Plan ID 无效，暂无法预览'}
            onClick={() => {
              if (canPreview) onPreviewPlan?.(item, linkedPlan);
            }}
          >
            预览
          </button>
        </div>
      </div>
      <div className="intake-plan-phase-progress">
        <div className={`progress${progressClass}`} aria-label={`阶段 ${phase.phaseIndex} 任务进度 ${phase.progressLabel}`}>
          <span style={{ width: `${phase.progressPct}%` }} />
        </div>
        <span>{phase.progressLabel}</span>
      </div>
      {phase.available ? null : <p className="intake-plan-unavailable">该阶段 Plan 当前缺失或已删除。</p>}
    </div>
  );
}

export function RecordCard({
  anchorId,
  actions,
  attachments = [],
  body,
  meta,
  status,
  title,
}: {
  anchorId?: string;
  actions?: ReactNode;
  attachments?: Attachment[];
  body?: ReactNode;
  meta?: string;
  status?: string;
  title: string;
}) {
  const hasBody = typeof body === 'string' ? Boolean(body) : Boolean(body);

  return (
    <article className="item" id={anchorId} data-search-anchor={anchorId ? 'true' : undefined}>
      <div className="item-title">
        <span>{title}</span>
        <span className="item-title-right">
          {status ? <span className={`chip ${statusChip(status)}`}>{status}</span> : null}
          {actions}
        </span>
      </div>
      {hasBody ? (
        <div className={`item-body${typeof body === 'string' ? ' plain-text' : ''}`}>{body}</div>
      ) : null}
      <AttachmentGrid attachments={attachments} />
      {meta ? <div className="meta">{meta}</div> : null}
    </article>
  );
}

function workspaceSearchAnchorId(type: IntakeType, id: number) {
  return `workspace-${type}-${id}`;
}

function intakeAttachmentKey(type: IntakeType | string, id: number | string) {
  return `${type}:${Number(id)}`;
}

function retryDraftKey(type: IntakeType, id: number) {
  return `${type}:${id}`;
}

function retryDraftFromItem(item: IntakeItem): IntakeRetryDraft {
  return {
    agentCliProvider: normalizeAgentCliProvider(readAgentCliProvider(item)),
    codexReasoningEffort: normalizeCodexReasoningEffort(
      readCodexReasoningEffort(item)
        || readStringField(item, ['codex_reasoning_effort', 'codexReasoningEffort', 'last_generate_codex_reasoning_effort']),
    ),
  };
}

function retryOptionsFromDraft(draft: IntakeRetryDraft): RetryIntakePlanGenerationOptions {
  const agentCliProvider = normalizeAgentCliProvider(draft.agentCliProvider);
  return {
    agentCliProvider,
    codexReasoningEffort: isCodexAgentCliProvider(agentCliProvider)
      ? normalizeCodexReasoningEffort(draft.codexReasoningEffort)
      : null,
  };
}

function intakeGenerationFailure(item: IntakeItem): IntakeGenerateFailure | null {
  const reason = readStringField(item, ['last_generate_error']);
  const failCount = readNumberField(item, ['generate_fail_count']);
  if (!reason && failCount <= 0) return null;

  const failedCliProviderText = readStringField(item, ['last_generate_agent_cli_provider']);
  const failedCliProvider = failedCliProviderText ? normalizeAgentCliProvider(failedCliProviderText) : null;
  const failedCodexReasoningText = readStringField(item, ['last_generate_codex_reasoning_effort']);

  return {
    reason: reason || '计划生成失败，未记录具体原因。',
    failedAt: readStringField(item, ['last_generate_fail_at']),
    failCount,
    logFile: readStringField(item, ['last_generate_log_file']),
    failedCliProvider,
    failedCodexReasoningEffort: failedCliProvider === 'codex' && failedCodexReasoningText
      ? normalizeCodexReasoningEffort(failedCodexReasoningText)
      : null,
  };
}

function linkedPlansOf(item: IntakeItem) {
  return normalizeLinkedPlans(item as unknown as LinkedPlanIntakeItem);
}

function linkedPlanIdOf(item: IntakeItem, linkedPlans = linkedPlansOf(item)) {
  return linkedPlanIdFromSummary(currentLinkedPlanSummary(linkedPlans) || linkedPlans[0]) || normalizeLinkedPlanId(item.linked_plan_id);
}

function linkedPlanIdFromSummary(linkedPlan: LinkedPlanSummary | null | undefined) {
  return normalizeLinkedPlanId(linkedPlan?.plan_id ?? linkedPlan?.planId ?? linkedPlan?.id);
}

function linkedPlanPhaseIndex(linkedPlan: LinkedPlanSummary | null | undefined, fallback: number) {
  const phaseIndex = Number(linkedPlan?.phase_index ?? linkedPlan?.phaseIndex);
  return Number.isInteger(phaseIndex) && phaseIndex > 0 ? phaseIndex : fallback;
}

function linkedPlanTitle(linkedPlan: LinkedPlanSummary | null | undefined) {
  return readLinkedPlanString(linkedPlan?.title);
}

function linkedPlanPhaseTitle(linkedPlan: LinkedPlanSummary | null | undefined) {
  return readLinkedPlanString(linkedPlan?.phase_title ?? linkedPlan?.phaseTitle);
}

function linkedPlanPath(linkedPlan: LinkedPlanSummary | null | undefined) {
  return readLinkedPlanString(linkedPlan?.file_path ?? linkedPlan?.filePath);
}

function linkedPlanStatus(linkedPlan: LinkedPlanSummary | null | undefined) {
  return readLinkedPlanString(linkedPlan?.status);
}

function linkedPlanTaskCounts(linkedPlan: LinkedPlanSummary | null | undefined) {
  return {
    completed: readLinkedPlanNumber(linkedPlan?.completed_tasks ?? linkedPlan?.completedTasks ?? linkedPlan?.completed),
    total: readLinkedPlanNumber(linkedPlan?.total_tasks ?? linkedPlan?.totalTasks ?? linkedPlan?.total),
  };
}

function linkedPlanDisplay(linkedPlan: LinkedPlanSummary, item: IntakeItem, plans: Plan[], phaseFallback = 1, useItemFallback = false) {
  const planId = linkedPlanIdFromSummary(linkedPlan);
  const phaseIndex = linkedPlanPhaseIndex(linkedPlan, phaseFallback);
  const phaseTitle = linkedPlanPhaseTitle(linkedPlan);
  const title = linkedPlanTitle(linkedPlan)
    || (!phaseTitle && useItemFallback ? readStringField(item, ['plan_title', 'linked_plan_title']) : '');
  const filePath = linkedPlanPath(linkedPlan)
    || (useItemFallback ? readStringField(item, ['plan_file_path', 'linked_plan_file_path', 'plan_path', 'linked_plan_path']) : '');
  const status = linkedPlanStatus(linkedPlan)
    || (useItemFallback ? readStringField(item, ['plan_status', 'linked_plan_status']) : '');
  const counts = linkedPlanTaskCounts(linkedPlan);
  const fallbackCounts = planTaskCounts(item);
  const completed = counts.completed || (useItemFallback ? fallbackCounts.completed : 0);
  const total = counts.total || (useItemFallback ? fallbackCounts.total : 0);
  const available = linkedPlanAvailableInSnapshot(linkedPlan, item, plans) && Boolean(filePath || status || total > 0 || completed > 0 || title);
  const displayName = title || filePath || (planId ? `Plan #${planId}` : '计划不可用');
  const displayTitle = [title || null, filePath || null].filter(Boolean).join('\n') || displayName;
  const pct = total > 0 ? progressPct(completed, total) : 0;
  return {
    available,
    completed,
    displayName: available ? displayName : displayName || '计划不可用',
    displayTitle,
    filePath,
    phaseIndex,
    phaseTitle,
    progressLabel: total > 0 ? `${completed}/${total} · ${pct}%` : '暂无任务进度',
    progressPct: pct,
    status,
    title,
    total,
  };
}

function linkedPlanAvailableInSnapshot(linkedPlan: LinkedPlanSummary, item: IntakeItem, plans: Plan[]) {
  const planId = linkedPlanIdFromSummary(linkedPlan);
  if (planId === null || plans.length === 0) return planId !== null;
  return plans.some((plan) => Number(plan.id) === planId && Number(plan.project_id) === Number(item.project_id));
}

function isCurrentLinkedPlan(linkedPlan: LinkedPlanSummary, currentPlan: LinkedPlanSummary) {
  if (linkedPlan.is_current || linkedPlan.current) return true;
  const planId = linkedPlanIdFromSummary(linkedPlan);
  const currentPlanId = linkedPlanIdFromSummary(currentPlan);
  return planId !== null && planId === currentPlanId && linkedPlanPhaseIndex(linkedPlan, 1) === linkedPlanPhaseIndex(currentPlan, 1);
}

function hasInterruptedLinkedPlan(linkedPlans: LinkedPlanSummary[], fallbackStatus: string | null) {
  return linkedPlans.some((linkedPlan) => linkedPlanStatus(linkedPlan) === 'interrupted') || fallbackStatus === 'interrupted';
}

function hasInterruptibleLinkedPlan(linkedPlans: LinkedPlanSummary[], fallbackStatus: string | null) {
  if (linkedPlans.length === 0) return false;
  return linkedPlans.some((linkedPlan) => {
    const status = linkedPlanStatus(linkedPlan);
    return status !== 'completed' && status !== 'interrupted';
  }) || (!fallbackStatus || (fallbackStatus !== 'completed' && fallbackStatus !== 'interrupted'));
}

function progressPct(completed: number, total: number) {
  return total > 0 ? Math.min(100, Math.max(0, Math.round((completed / total) * 100))) : 0;
}

function planTaskCounts(item: IntakeItem) {
  return {
    completed: readNumberField(item, ['plan_completed', 'linked_plan_completed', 'linked_plan_completed_tasks', 'plan_completed_tasks']),
    total: readNumberField(item, ['plan_total', 'linked_plan_total', 'linked_plan_total_tasks', 'plan_total_tasks']),
  };
}

function readLinkedPlanString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function readLinkedPlanNumber(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const numericValue = Number(value);
    if (Number.isFinite(numericValue)) return numericValue;
  }
  return 0;
}

function readStringField(item: IntakeItem, fieldNames: string[]) {
  const record = item as unknown as Record<string, unknown>;
  for (const fieldName of fieldNames) {
    const value = record[fieldName];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function readNumberField(item: IntakeItem, fieldNames: string[]) {
  const record = item as unknown as Record<string, unknown>;
  for (const fieldName of fieldNames) {
    const value = record[fieldName];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim()) {
      const numericValue = Number(value);
      if (Number.isFinite(numericValue)) return numericValue;
    }
  }
  return 0;
}

function statusChip(status: string) {
  const s = status.toLowerCase();
  if (['completed', 'done', 'passed', 'accepted'].includes(s)) return 'chip-completed';
  if (['failed', 'error'].includes(s)) return 'chip-failed';
  if (['running', 'processing'].includes(s)) return 'chip-running';
  return 'chip-waiting';
}

function planChipClass(planStatus: string) {
  const s = String(planStatus || '').toLowerCase();
  if (s === 'completed') return 'chip-completed';
  if (s === 'interrupted') return 'chip-failed';
  if (s === 'validation_failed') return 'chip-failed';
  if (['pending', 'running', 'generate-plan', 'execute-task', 'validate', 'scan'].includes(s)) return 'chip-running';
  return 'chip-waiting';
}

function planStatusLabel(planStatus: string) {
  const s = String(planStatus || '').toLowerCase();
  const map: Record<string, string> = {
    pending: '执行中',
    running: '执行中',
    completed: '已完成',
    interrupted: '已中断',
    validation_failed: '验收失败',
  };
  return map[s] || planStatus;
}
