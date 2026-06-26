import type { Attachment } from '../types';

export function getFilePath(file: File) {
  try {
    return window.autoplan.getDroppedFilePath(file) || (file as File & { path?: string }).path || '';
  } catch {
    return (file as File & { path?: string }).path || '';
  }
}

export function autoGrowTextarea(textarea: HTMLTextAreaElement) {
  textarea.style.height = 'auto';
  textarea.style.height = `${Math.min(textarea.scrollHeight, 220)}px`;
}

export function formatBytes(value: number) {
  const bytes = Number(value || 0);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function sourceTypeName(type: 'requirement' | 'feedback') {
  return type === 'feedback' ? '反馈' : '需求';
}

/** CLI 后端 → 语义化显示名（默认 Codex） */
export function agentCliProviderLabel(provider?: string | null): string {
  const value = String(provider || '').trim().toLowerCase();
  if (value === 'claude') return 'Claude';
  return 'Codex';
}

export function codexReasoningEffortLabel(effort?: string | null): string {
  const value = String(effort || '').trim().toLowerCase();
  if (value === 'low') return '低';
  if (value === 'high') return '高';
  return '中';
}

/** 状态 → 语义化 chip class */
export function statusChipClass(status: string): string {
  const s = status.toLowerCase();
  if (['completed', 'done', 'passed', 'accepted', 'executed'].includes(s)) return 'chip-completed';
  if (['failed', 'error'].includes(s)) return 'chip-failed';
  if (['running', 'processing', 'validate', 'generate-plan', 'execute-task', 'scan'].includes(s)) return 'chip-running';
  if (['waiting', 'pending', 'draft', 'ready_for_validation', 'validation_failed', 'open'].includes(s)) return 'chip-waiting';
  return 'chip-pending';
}

export function AttachmentGrid({ attachments }: { attachments: Attachment[] }) {
  if (!attachments.length) return null;
  return (
    <div className="attachment-grid">
      {attachments.map((attachment) => (
        <AttachmentView attachment={attachment} key={attachment.id} />
      ))}
    </div>
  );
}

function AttachmentView({ attachment }: { attachment: Attachment }) {
  const url = window.autoplan.toFileUrl(attachment.stored_path);
  const name = attachment.original_name || attachment.stored_path;
  if (String(attachment.mime_type || '').startsWith('image/')) {
    return (
      <a className="attachment-thumb" href={url} target="_blank" rel="noreferrer" title={name}>
        <img src={url} alt={name} />
        <span>{name}</span>
      </a>
    );
  }
  return (
    <a className="attachment-file" href={url} target="_blank" rel="noreferrer">
      <span>{name}</span>
      <small>{formatBytes(attachment.size)}</small>
    </a>
  );
}
