import { FormEvent, ReactNode, useState } from 'react';
import type { Attachment, Feedback, IntakeType, PendingAttachment, Requirement } from '../types';
import { AttachmentGrid, sourceTypeName } from './shared';
import { Composer, type ComposerSubmitPayload } from './Composer';
import { formatChinaDateTime } from '../utils/time';

type IntakeItem = Requirement | Feedback;
type IntakeUpdate = { title?: string; body?: string; status?: string };
type PlanPreviewHandler = (item: IntakeItem) => void;

interface IntakePanelProps {
  attachments: Attachment[];
  draftValue: string;
  emptyText: string;
  heading: string;
  items: IntakeItem[];
  pendingAttachments: PendingAttachment[];
  placeholder: string;
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
}

export function IntakePanel({
  attachments,
  draftValue,
  emptyText,
  heading,
  items,
  pendingAttachments,
  placeholder,
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
}: IntakePanelProps) {
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState({ title: '', body: '', status: 'open' });
  const [appendId, setAppendId] = useState<number | null>(null);
  const [appendText, setAppendText] = useState('');

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
    const linkedPlanId = linkedPlanIdOf(item);
    const cascadeWarning = linkedPlanId === null
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

  const planStatus = (item: IntakeItem) => readStringField(item, ['plan_status', 'linked_plan_status']) || null;
  const planPct = (item: IntakeItem) => {
    const { completed, total } = planTaskCounts(item);
    return total > 0 ? Math.min(100, Math.max(0, Math.round((completed / total) * 100))) : 0;
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
            items.map((item) => {
              const itemAttachments = attachments.filter(
                (attachment) => attachment.owner_type === type && Number(attachment.owner_id) === Number(item.id),
              );
              const title = `${sourceTypeName(type)} #${item.id} · ${item.title || '未命名'}`;

              if (editingId === item.id) {
                return (
                  <article className="item" id={workspaceSearchAnchorId(type, item.id)} data-search-anchor="true" key={item.id}>
                    <div className="item-title">
                      <span>{title}</span>
                      <span className={`chip ${statusChip(item.status)}`}>{item.status}</span>
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

              const ps = planStatus(item);
              const linkedPlanId = linkedPlanIdOf(item);
              const hasPlan = linkedPlanId !== null;
              const isInterrupted = ps === 'interrupted';
              const isCompleted = ps === 'completed';
              const showAppend = appendId === item.id;

              return (
                <article className="item intake-item" id={workspaceSearchAnchorId(type, item.id)} data-search-anchor="true" key={item.id}>
                  <div className="item-title">
                    <span>{title}</span>
                    <span className="item-title-right">
                      <span className={`chip ${statusChip(item.status)}`}>{item.status}</span>
                    </span>
                  </div>
                  {item.body ? <div className="item-body plain-text">{item.body}</div> : null}
                  <AttachmentGrid attachments={itemAttachments} />

                  <PlanBindingCard item={item} progressPct={planPct(item)} onPreviewPlan={onPreviewPlan} />

                  <div className="item-foot">
                    <div className="item-actions">
                      <button type="button" className="btn-link" onClick={() => startEdit(item)}>
                        编辑
                      </button>
                      {hasPlan && !isCompleted && !isInterrupted ? (
                        <button
                          type="button"
                          className="btn-link"
                          onClick={() => void onInterrupt(type, item.id)}
                        >
                          中断
                        </button>
                      ) : null}
                      {isInterrupted ? (
                        <button
                          type="button"
                          className="btn-link"
                          onClick={() => void onResume(type, item.id)}
                        >
                          恢复
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
                          {showAppend ? '取消追加' : '+ 追加任务'}
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
                        placeholder="输入任务标题，Enter 追加到计划"
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
            })
          ) : (
            <div className="empty">{emptyText}</div>
          )}
        </div>
      </div>

      <Composer
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

function PlanBindingCard({
  item,
  progressPct,
  onPreviewPlan,
}: {
  item: IntakeItem;
  progressPct: number;
  onPreviewPlan?: PlanPreviewHandler;
}) {
  const linkedPlanId = linkedPlanIdOf(item);
  if (linkedPlanId === null) return null;

  const planTitle = readStringField(item, ['plan_title', 'linked_plan_title']);
  const planPath = readStringField(item, ['plan_file_path', 'linked_plan_file_path', 'plan_path', 'linked_plan_path']);
  const planStatus = readStringField(item, ['plan_status', 'linked_plan_status']);
  const { completed, total } = planTaskCounts(item);
  const hasSnapshot = Boolean(planTitle || planPath || planStatus || completed > 0 || total > 0);
  const displayName = hasSnapshot ? planTitle || planPath || `Plan #${linkedPlanId}` : '计划不可用';
  const displayTitle = [planTitle || null, planPath || null].filter(Boolean).join('\n') || displayName;
  const canPreview = hasSnapshot && Boolean(onPreviewPlan);
  const previewTitle = !hasSnapshot
    ? '绑定 Plan 快照缺失，无法预览'
    : canPreview
      ? `预览 Plan #${linkedPlanId}`
      : '预览入口尚未就绪';
  const progressLabel = total > 0 ? `${completed}/${total} · ${progressPct}%` : '暂无任务进度';
  const progressClass = planStatus === 'completed' ? ' success' : planStatus ? ' running' : '';

  return (
    <div className={`intake-plan-card${hasSnapshot ? '' : ' is-unavailable'}`}>
      <div className="intake-plan-head">
        <div className="intake-plan-main">
          <span className="intake-plan-label">绑定 Plan</span>
          <strong className="intake-plan-name" title={displayTitle}>
            {displayName}
          </strong>
          {planTitle && planPath ? (
            <span className="intake-plan-path" title={planPath}>
              {planPath}
            </span>
          ) : null}
        </div>
        <div className="intake-plan-side">
          {hasSnapshot ? (
            <span className={`chip ${planStatus ? planChipClass(planStatus) : 'chip-waiting'}`}>
              {planStatus ? planStatusLabel(planStatus) : '状态未知'}
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
              if (canPreview) onPreviewPlan?.(item);
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
          任务进度 <b>{progressLabel}</b>
        </span>
      </div>

      <div className="intake-plan-progress" aria-label={`Plan 任务完成进度 ${progressLabel}`}>
        <div className={`progress${progressClass}`}>
          <span style={{ width: `${progressPct}%` }} />
        </div>
      </div>

      {hasSnapshot ? null : <p className="intake-plan-unavailable">绑定 Plan 快照缺失，暂不能预览全文。</p>}
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

function linkedPlanIdOf(item: IntakeItem) {
  const value = (item as unknown as Record<string, unknown>).linked_plan_id;
  const numericValue = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numericValue) && numericValue > 0 ? numericValue : null;
}

function planTaskCounts(item: IntakeItem) {
  return {
    completed: readNumberField(item, ['plan_completed', 'linked_plan_completed', 'plan_completed_tasks']),
    total: readNumberField(item, ['plan_total', 'linked_plan_total', 'plan_total_tasks']),
  };
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
