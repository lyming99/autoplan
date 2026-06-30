import type {
  AppSnapshot,
  Script,
  ScriptContextInject,
  ScriptHookStage,
  ScriptRuntime,
} from '../../types';
import { getTimestampMs } from '../../utils/time';

export type RuntimeMeta = { label: string; ext: string; eol: 'LF' | 'CRLF'; dot: string };

export const RUNTIME_META: Record<ScriptRuntime, RuntimeMeta> = {
  node: { label: 'Node.js', ext: '.node', eol: 'LF', dot: 'node' },
  bash: { label: 'Bash', ext: '.sh', eol: 'LF', dot: 'bash' },
  ps: { label: 'PowerShell', ext: '.ps1', eol: 'CRLF', dot: 'ps' },
  cmd: { label: 'CMD', ext: '.bat', eol: 'CRLF', dot: 'cmd' },
};

export const HOOK_STAGE_OPTIONS: { stage: ScriptHookStage; label: string }[] = [
  { stage: 'plan:after', label: '计划生成后' },
  { stage: 'task:after', label: '任务执行后' },
  { stage: 'validation:before', label: '验收前' },
  { stage: 'loop:end', label: '循环结束' },
  { stage: 'on:fail', label: '失败时' },
];

export const CONTEXT_OPTIONS: { value: ScriptContextInject; label: string }[] = [
  { value: 'env', label: '环境变量' },
  { value: 'stdin', label: 'stdin (JSON)' },
  { value: 'none', label: '不注入' },
];

export function formatDurationShort(ms?: number | null) {
  if (ms === null || typeof ms === 'undefined') return '';
  const seconds = ms / 1000;
  if (seconds < 1) return `${Math.max(1, Math.round(ms))}ms`;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 2 : 1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m${Math.round(seconds % 60)}s`;
}

/** 为 cron 表达式生成简短人类可读提示。仅处理常见模式，非标准 pattern 降级为"已填写"。 */
export function cronHint(expr: string): string {
  const trimmed = expr.trim();
  if (!trimmed) return '未填写';
  if (trimmed === '*/5 * * * *') return '每 5 分钟执行一次';
  const stepMatch = /^\*\/(\d+) \* \* \* \*$/.exec(trimmed);
  if (stepMatch) return `每 ${stepMatch[1]} 分钟执行一次`;
  if (/^\d+ \d+ \* \* [\d,-]+$/.test(trimmed)) return '工作日定时执行';
  return '已填写';
}

export function formatRelativeTime(value?: string | null) {
  const ms = getTimestampMs(value);
  if (!ms) return '';
  const diff = Date.now() - ms;
  if (diff < 60_000) return '刚刚';
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

export function classifyLogLine(line: string) {
  if (/\[ok\]|\[done\]|✓|passed|succeed/i.test(line)) return 'lvl-s';
  if (/\[err\]|\[error\]|✗|fail|exception|traceback/i.test(line)) return 'lvl-e';
  if (/\[run\]|\[ctx\]|▶|启动|注入/i.test(line)) return 'lvl-i';
  return '';
}

export function pickNewlyCreatedScript(snapshot: AppSnapshot, projectId: number): Script | null {
  const candidates = (snapshot.scripts || [])
    .filter((item) => Number(item.project_id) === Number(projectId))
    .sort((a, b) => Number(b.id) - Number(a.id));
  return candidates[0] ?? null;
}
