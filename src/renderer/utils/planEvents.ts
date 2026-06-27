import type { AppEvent } from '../types';
import { planCliSummaryLabel } from '../components/shared';
import { formatChinaDateTime, formatDuration } from './time';


type EventMetaRecord = Record<string, unknown>;

export type TaskEventTone = 'start' | 'success' | 'failed' | 'stopped' | 'stopping' | 'updated';

export type EventDisplay = {
  title: string;
  body: string;
  meta: string;
  badge?: string;
  tone?: TaskEventTone;
};

const TASK_EVENT_PRESENTATION: Record<TaskEventTone, { action: string; badge: string }> = {
  start: { action: '开始了', badge: '开始' },
  success: { action: '结束了', badge: '成功' },
  failed: { action: '执行失败', badge: '失败' },
  stopped: { action: '停止了', badge: '停止' },
  stopping: { action: '请求停止', badge: '停止中' },
  updated: { action: '更新了', badge: '任务' },
};

function toEventMetaRecord(value: unknown): EventMetaRecord | null {
  if (!value) return null;
  if (typeof value === 'string') {
    try {
      return toEventMetaRecord(JSON.parse(value));
    } catch {
      return null;
    }
  }
  if (typeof value === 'object' && !Array.isArray(value)) return value as EventMetaRecord;
  return null;
}

function readEventMeta(event: AppEvent) {
  return toEventMetaRecord((event as AppEvent & { meta?: unknown }).meta);
}

function readMetaText(meta: EventMetaRecord | null, keys: string[]) {
  if (!meta) return '';
  for (const key of keys) {
    const value = meta[key];
    if (typeof value === 'string') {
      const text = value.trim();
      if (text) return text;
    }
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return '';
}

function readMetaNumber(meta: EventMetaRecord | null, keys: string[]) {
  const text = readMetaText(meta, keys);
  if (!text) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

function includesAny(text: string, keywords: string[]) {
  return keywords.some((keyword) => text.includes(keyword));
}

function classifyTaskEvent(event: AppEvent, meta: EventMetaRecord | null): TaskEventTone {
  const eventText = `${event.type || ''} ${readMetaText(meta, ['status', 'taskStatus', 'task_status'])}`.toLowerCase();
  if (includesAny(eventText, ['stop_requested', 'stop-requested', 'stop.requested', 'request_stop', 'stopping'])) {
    return 'stopping';
  }
  if (includesAny(eventText, ['fail', 'error', 'errored'])) return 'failed';
  if (includesAny(eventText, ['stop', 'interrupt', 'cancel'])) return 'stopped';
  if (includesAny(eventText, ['start', 'begin', 'running'])) return 'start';
  if (includesAny(eventText, ['complete', 'finish', 'success', 'succeed', 'executed', 'done'])) return 'success';
  return 'updated';
}

function isTaskEventType(type: string) {
  return /^task[.:_-]/i.test(type);
}

function sameEventText(left: string, right: string) {
  return left.replace(/\s+/g, ' ').trim() === right.replace(/\s+/g, ' ').trim();
}

function formatTaskEvent(event: AppEvent, meta: EventMetaRecord): EventDisplay | null {
  const taskKey = readMetaText(meta, ['taskKey', 'task_key']);
  const taskId = readMetaText(meta, ['taskId', 'task_id']);
  const taskTitle = readMetaText(meta, ['taskTitle', 'task_title', 'title']) || '未命名任务';
  const hasTaskIdentity = Boolean(taskKey || taskId || readMetaText(meta, ['taskTitle', 'task_title', 'title']));
  if (!hasTaskIdentity) return null;

  const tone = classifyTaskEvent(event, meta);
  const presentation = TASK_EVENT_PRESENTATION[tone];
  const taskLabel = taskKey ? `${taskKey} 任务` : taskId ? `任务 #${taskId}` : '任务';
  const separator = taskLabel === '任务' ? '' : ' ';
  const title = `${presentation.action}${separator}${taskLabel}：${taskTitle}`;
  const originalMessage = event.message?.trim() || '';
  const planId = readMetaText(meta, ['planId', 'plan_id']);
  const status = readMetaText(meta, ['status', 'taskStatus', 'task_status']);
  const agentCliProvider = readMetaText(meta, ['agentCliProvider', 'agent_cli_provider']);
  const cliSummary = agentCliProvider ? planCliSummaryLabel(meta) : '';
  const durationMs = readMetaNumber(meta, ['durationMs', 'duration_ms']);
  const metaParts = [
    formatChinaDateTime(event.created_at),
    planId ? `Plan #${planId}` : '',
    cliSummary,
    status ? `状态 ${status}` : '',
    durationMs !== null ? `耗时 ${formatDuration(durationMs, '0秒')}` : '',
  ].filter(Boolean);

  return {
    title,
    body: originalMessage && !sameEventText(originalMessage, title) ? originalMessage : '',
    meta: metaParts.join(' · '),
    badge: presentation.badge,
    tone,
  };
}

export function formatEvent(event: AppEvent): EventDisplay {
  const meta = readEventMeta(event);
  const taskDisplay = meta && (isTaskEventType(event.type) || readMetaText(meta, ['taskKey', 'task_key', 'taskId', 'task_id']))
    ? formatTaskEvent(event, meta)
    : null;
  if (taskDisplay) return taskDisplay;

  return {
    title: event.type || '事件',
    body: event.message || '',
    meta: formatChinaDateTime(event.created_at),
  };
}

function toSearchText(value: unknown, depth = 0): string {
  if (value === null || value === undefined || depth > 6) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map((item) => toSearchText(item, depth + 1)).join(' ');
  if (typeof value === 'object') {
    return Object.values(value as Record<string, unknown>)
      .map((item) => toSearchText(item, depth + 1))
      .join(' ');
  }
  return '';
}

export function getEventSearchText(event: AppEvent) {
  const display = formatEvent(event);
  const meta = readEventMeta(event);
  return [
    event.type,
    event.message,
    display.title,
    display.body,
    display.badge,
    display.meta,
    toSearchText(meta),
    toSearchText(event),
  ]
    .filter(Boolean)
    .join(' ');
}
