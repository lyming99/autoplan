import { FormEvent, ReactNode, useState } from 'react';
import type { Attachment, Feedback, IntakeType, PendingAttachment, Requirement } from '../types';
import { AttachmentGrid, sourceTypeName } from './shared';
import { Composer, type ComposerSubmitPayload } from './Composer';
import { formatChinaDateTime } from '../utils/time';

type IntakeItem = Requirement | Feedback;
type IntakeUpdate = { title?: string; body?: string; status?: string };

interface IntakePanelProps {
  attachments: Attachment[];
  emptyText: string;
  heading: string;
  items: IntakeItem[];
  pendingAttachments: PendingAttachment[];
  placeholder: string;
  submitLabel: string;
  subtitle: string;
  type: IntakeType;
  onAddFiles: (type: IntakeType, files: FileList | File[] | null) => void;
  onDelete: (id: number) => Promise<boolean>;
  onRemoveAttachment: (type: IntakeType, index: number) => void;
  onSubmit: (body: string | ComposerSubmitPayload) => Promise<boolean>;
  onUpdate: (id: number, input: IntakeUpdate) => Promise<boolean>;
  onInterrupt: (type: IntakeType, id: number) => Promise<void>;
  onResume: (type: IntakeType, id: number) => Promise<void>;
  onAppendTask: (type: IntakeType, id: number, title: string) => Promise<void>;
}

export function IntakePanel({
  attachments,
  emptyText,
  heading,
  items,
  pendingAttachments,
  placeholder,
  submitLabel,
  subtitle,
  type,
  onAddFiles,
  onDelete,
  onRemoveAttachment,
  onSubmit,
  onUpdate,
  onInterrupt,
  onResume,
  onAppendTask,
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
    if (!window.confirm(`确定删除${sourceTypeName(type)} #${item.id} 吗？关联任务会被中断。`)) return;
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

  const planStatus = (item: IntakeItem) => item.plan_status || null;
  const planPct = (item: IntakeItem) => {
    const total = Number(item.plan_total || 0);
    const done = Number(item.plan_completed || 0);
    return total > 0 ? Math.round((done / total) * 100) : 0;
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
              const hasPlan = Boolean(item.linked_plan_id);
              const isInterrupted = ps === 'interrupted';
              const isCompleted = ps === 'completed';
              const showAppend = appendId === item.id;

              return (
                <article className="item intake-item" id={workspaceSearchAnchorId(type, item.id)} data-search-anchor="true" key={item.id}>
                  <div className="item-title">
                    <span>{title}</span>
                    <span className="item-title-right">
                      {hasPlan && ps ? (
                        <span className={`chip ${planChipClass(ps)}`}>
                          {planStatusLabel(ps)} {item.plan_completed ?? 0}/{item.plan_total ?? 0}
                        </span>
                      ) : (
                        <span className={`chip ${statusChip(item.status)}`}>{item.status}</span>
                      )}
                    </span>
                  </div>
                  {item.body ? <div className="item-body plain-text">{item.body}</div> : null}
                  <AttachmentGrid attachments={itemAttachments} />

                  {hasPlan ? (
                    <div className="intake-progress">
                      <div className="progress">
                        <span style={{ width: `${planPct(item)}%` }} />
                      </div>
                    </div>
                  ) : null}

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
        onAddFiles={onAddFiles}
        onRemoveAttachment={onRemoveAttachment}
        onSubmit={onSubmit}
      />
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
