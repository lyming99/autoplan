import type { Attachment } from '../types';

export function getFilePath(file: File) {
  try {
    return window.autoplan.getDroppedFilePath(file) || (file as File & { path?: string }).path || '';
  } catch {
    return (file as File & { path?: string }).path || '';
  }
}

export function toSafeFileUrl(filePath?: string | null) {
  const path = String(filePath || '').trim();
  if (!path) return '';
  try {
    return window.autoplan.toFileUrl(path);
  } catch {
    return '';
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
  const value = normalizeAgentCliProvider(provider);
  if (value === 'claude') return 'Claude';
  if (value === 'opencode') return 'OpenCode';
  if (value === 'oh-my-pi') return 'Oh My Pi';
  return 'Codex';
}

export function codexReasoningEffortLabel(effort?: string | null): string {
  const value = String(effort || '').trim().toLowerCase();
  if (value === 'low') return 'low';
  if (value === 'high') return 'high';
  if (value === 'xhigh') return '超高';
  return 'medium';
}

export function planCliSummaryLabel(source?: object | null): string {
  const provider = readAgentCliProvider(source);
  const providerLabel = `${agentCliProviderLabel(provider)} CLI`;
  if (provider !== 'codex') return providerLabel;
  const effort = readCodexReasoningEffort(source) || 'medium';
  return `${providerLabel} · 思考深度 ${codexReasoningEffortLabel(effort)}`;
}

export function readAgentCliProvider(source?: object | null): string {
  return normalizeAgentCliProvider(readFirstString(source, [
    'agent_cli_provider',
    'agentCliProvider',
    'cli_provider',
    'cliProvider',
    'cli_backend',
    'cliBackend',
    'provider',
  ]));
}

export function readCodexReasoningEffort(source?: object | null): string | null {
  const provider = readAgentCliProvider(source);
  if (provider !== 'codex') return null;
  return normalizeCodexReasoningEffort(readFirstString(source, [
    'codex_reasoning_effort',
    'codexReasoningEffort',
    'codex_thinking_depth',
    'codexThinkingDepth',
    'reasoning_effort',
    'reasoningEffort',
    'thinking_depth',
    'thinkingDepth',
  ]));
}

function readFirstString(source: object | null | undefined, keys: string[]): string {
  const record = source as Record<string, unknown> | null | undefined;
  for (const key of keys) {
    const value = record?.[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function normalizeAgentCliProvider(provider?: string | null): string {
  const value = String(provider || '').trim().toLowerCase();
  if (value === 'claude') return 'claude';
  if (value === 'opencode') return 'opencode';
  if (value === 'oh-my-pi') return 'oh-my-pi';
  return 'codex';
}

function normalizeCodexReasoningEffort(effort?: string | null): string {
  const value = String(effort || '').trim().toLowerCase();
  if (value === 'low' || value === 'high' || value === 'xhigh') return value;
  return 'medium';
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
  const url = toSafeFileUrl(attachment.stored_path);
  const name = attachment.original_name || attachment.stored_path;
  if (url && String(attachment.mime_type || '').startsWith('image/')) {
    return (
      <a className="attachment-thumb" href={url} target="_blank" rel="noreferrer" title={name}>
        <img src={url} alt={name} />
        <span>{name}</span>
      </a>
    );
  }
  return (
    <a className="attachment-file" href={url || undefined} target="_blank" rel="noreferrer">
      <span>{name}</span>
      <small>{formatBytes(attachment.size)}</small>
    </a>
  );
}
