import { useLayoutEffect, useRef } from 'react';
import type { ActivityLine, AgentCliSessionInfo, CodexSessionInfo } from '../types';
import { agentCliProviderLabel } from './shared';
import { formatChinaTime } from '../utils/time';

const LOG_BOTTOM_THRESHOLD_PX = 24;

const ROLE_CONFIG: Record<string, { label: string; cls: string }> = {
  codex: { label: 'Codex', cls: 'act-codex' },
  exec: { label: '执行', cls: 'act-exec' },
  thinking: { label: '思考', cls: 'act-thinking' },
  error: { label: '错误', cls: 'act-error' },
  system: { label: '系统', cls: 'act-system' },
  user: { label: '用户', cls: 'act-user' },
  info: { label: '信息', cls: 'act-info' },
};

type AgentCliLogContext = AgentCliSessionInfo &
  CodexSessionInfo & { errorMessage?: string | null; exitCode?: number | null };

function isNearLogBottom(el: HTMLDivElement) {
  const maxScrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
  return maxScrollTop - el.scrollTop <= LOG_BOTTOM_THRESHOLD_PX;
}

/**
 * 以活动时间线显示 Agent CLI 执行过程（Codex 结构化 Activity 优先）。
 * 优先用过滤后的 activity 行；若为空则回退到 logTail 原始尾部。
 */
export function CodexLog({
  log,
  activity,
  context,
  provider,
}: {
  log: string;
  activity?: ActivityLine[];
  context?: AgentCliLogContext | null;
  provider?: string | null;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);
  const lines = activity && activity.length > 0 ? activity : null;
  const displayMode = lines ? 'activity' : 'raw';
  const lastDisplayModeRef = useRef(displayMode);
  const providerLabel = agentCliProviderLabel(provider);
  const rawLogText = log ? log.slice(-4000) : `等待 ${providerLabel} 输出…`;
  const statusText = lines
    ? `${providerLabel} 活动摘要`
    : log
      ? `${providerLabel} 原始日志尾部`
      : `等待 ${providerLabel} 输出`;
  const activityContentKey = lines
    ? lines.map((line) => `${line.at}\u0000${line.role}\u0000${line.text}`).join('\u0001')
    : '';
  const renderedContentKey = lines ? activityContentKey : rawLogText;
  const contextLabel = agentCliSessionContextLabel(context, providerLabel);
  const errorMessage = context?.errorMessage?.trim() || '';

  const updateBottomState = () => {
    const el = scrollRef.current;
    isAtBottomRef.current = el ? isNearLogBottom(el) : true;
  };

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el) {
      const displayModeChanged = lastDisplayModeRef.current !== displayMode;
      if (displayModeChanged || isAtBottomRef.current) {
        el.scrollTop = el.scrollHeight;
      }
      lastDisplayModeRef.current = displayMode;
      updateBottomState();
    }
  }, [displayMode, renderedContentKey, contextLabel, errorMessage, statusText]);

  const statusLine = (
    <div className="act-line act-info">
      <span className="act-time">状态</span>
      <span className="act-tag">CLI</span>
      <span className="act-text">{statusText}</span>
    </div>
  );

  const contextLine = contextLabel ? (
    <div className="act-line act-info">
      <span className="act-time">上下文</span>
      <span className="act-tag">会话</span>
      <span className="act-text">{contextLabel}</span>
    </div>
  ) : null;

  const errorLine = errorMessage ? (
    <div className="act-line act-error">
      <span className="act-time">错误</span>
      <span className="act-tag">{providerLabel}</span>
      <span className="act-text">{errorMessage}</span>
    </div>
  ) : null;

  const content = lines ? (
    lines.map((line, index) => {
      const config = activityRoleConfig(line.role, providerLabel);
      return (
        <div className={`act-line ${config.cls}`} key={index}>
          <span className="act-time">{formatChinaTime(line.at)}</span>
          <span className="act-tag">{config.label}</span>
          <span className="act-text">{line.text}</span>
        </div>
      );
    })
  ) : (
    <pre className="codex-raw">{rawLogText}</pre>
  );

  return (
    <div className="codex-log" ref={scrollRef} onScroll={updateBottomState}>
      {statusLine}
      {contextLine}
      {errorLine}
      {content}
    </div>
  );
}

function activityRoleConfig(role: string, providerLabel: string) {
  if (role === 'codex' || role === 'assistant') {
    return { ...ROLE_CONFIG.codex, label: providerLabel };
  }
  return ROLE_CONFIG[role] || { label: role || '信息', cls: 'act-info' };
}

export function agentCliSessionContextLabel(
  context?: (AgentCliSessionInfo & CodexSessionInfo) | null,
  providerLabel = 'Agent',
  options: { includeProvider?: boolean } = {},
) {
  if (!context) return '';
  const includeProvider = options.includeProvider ?? true;
  const explicit = firstText(
    context.agentCliSessionLabel,
    context.agent_cli_session_label,
    context.codexSessionLabel,
    context.codex_session_label,
  );
  if (explicit) return maybePrefixProvider(explicit, providerLabel, includeProvider);
  const requested = firstText(
    context.agentCliSessionRequestedShortId,
    context.agent_cli_session_requested_short_id,
    shortSessionId(context.agentCliSessionRequestedId),
    shortSessionId(context.agent_cli_session_requested_id),
    context.codexSessionRequestedShortId,
    context.codex_session_requested_short_id,
    shortSessionId(context.codexSessionRequestedId),
    shortSessionId(context.codex_session_requested_id),
  );
  const current = firstText(
    context.agentCliSessionShortId,
    context.agent_cli_session_short_id,
    shortSessionId(context.agentCliSessionId),
    shortSessionId(context.agent_cli_session_id),
    context.codexSessionShortId,
    context.codex_session_short_id,
    shortSessionId(context.codexSessionId),
    shortSessionId(context.codex_session_id),
  );
  const mode = firstText(
    context.agentCliSessionMode,
    context.agent_cli_session_mode,
    context.codexSessionMode,
    context.codex_session_mode,
  );
  const state = firstText(
    context.agentCliSessionState,
    context.agent_cli_session_state,
    context.codexSessionState,
    context.codex_session_state,
  );
  const fallback = Boolean(
    context.agentCliSessionFallback ??
      context.agent_cli_session_fallback ??
      context.codexSessionFallback ??
      context.codex_session_fallback,
  );
  if (fallback || state === 'fallback-new') {
    if (current && requested) return sessionLabel(`回退新建会话 ${current}（原 ${requested}）`, providerLabel, includeProvider);
    if (current) return sessionLabel(`回退新建会话 ${current}`, providerLabel, includeProvider);
    return sessionLabel(requested ? `回退新建会话（原 ${requested}）` : '回退新建会话', providerLabel, includeProvider);
  }
  if (mode === 'resume') return sessionLabel(current ? `恢复会话 ${current}` : '恢复会话', providerLabel, includeProvider);
  if (mode === 'continue') return sessionLabel(current ? `继续会话 ${current}` : '继续会话', providerLabel, includeProvider);
  if (mode === 'new') return sessionLabel(current ? `新建会话 ${current}` : '新建会话', providerLabel, includeProvider);
  return current ? sessionLabel(`会话 ${current}`, providerLabel, includeProvider) : '';
}

function sessionLabel(text: string, providerLabel: string, includeProvider: boolean) {
  return includeProvider ? `${providerLabel} ${text}` : text;
}

function maybePrefixProvider(text: string, providerLabel: string, includeProvider: boolean) {
  if (!includeProvider || !providerLabel || hasProviderLabel(text, providerLabel)) return text;
  return `${providerLabel} ${text}`;
}

function hasProviderLabel(text: string, providerLabel: string) {
  return text.includes(providerLabel) || /\b(?:Agent|Codex|Claude|OpenCode|Oh My Pi|omp)\b/i.test(text);
}

function firstText(...values: Array<string | null | undefined>) {
  for (const value of values) {
    const text = value?.trim();
    if (text) return text;
  }
  return '';
}

function shortSessionId(sessionId?: string | null) {
  const text = sessionId?.trim();
  if (!text) return '';
  if (text.length <= 13) return text;
  return `${text.slice(0, 8)}…${text.slice(-4)}`;
}
