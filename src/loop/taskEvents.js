const {
  DEFAULT_AGENT_CLI_PROVIDER,
  agentCliContextFields,
  agentCliProviderDisplayName,
  codexSessionContextFields,
  codexSessionReadableLabel,
  opencodeSessionContextFields,
  normalizeOptionalCodexReasoningEffort,
  normalizeOptionalNumber,
  normalizeOptionalString,
} = require('./agentCliConfig');

const TASK_LIFECYCLE_EVENT_RECORDED = Symbol('taskLifecycleEventRecorded');

const TASK_EVENT_TYPES = Object.freeze({
  STARTED: 'task.started',
  SUCCEEDED: 'task.succeeded',
  FAILED: 'task.failed',
  STOP_REQUESTED: 'task.stop.requested',
  STOPPED: 'task.stopped',
  INTERRUPTED: 'task.interrupted',
});

const LEGACY_TASK_EVENT_TYPES = Object.freeze({
  EXECUTED: 'task.executed',
  STOPPING: 'task.stopping',
});

const TASK_EVENT_STATUS = Object.freeze({
  PENDING: 'pending',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  STOPPING: 'stopping',
  STOPPED: 'stopped',
  INTERRUPTED: 'interrupted',
});

const TASK_EVENT_SEMANTICS = Object.freeze({
  [TASK_EVENT_TYPES.STARTED]: Object.freeze({ status: TASK_EVENT_STATUS.RUNNING, label: '开始了任务' }),
  [TASK_EVENT_TYPES.SUCCEEDED]: Object.freeze({ status: TASK_EVENT_STATUS.COMPLETED, label: '结束了任务' }),
  [TASK_EVENT_TYPES.FAILED]: Object.freeze({ status: TASK_EVENT_STATUS.FAILED, label: '任务失败' }),
  [TASK_EVENT_TYPES.STOP_REQUESTED]: Object.freeze({ status: TASK_EVENT_STATUS.STOPPING, label: '请求停止任务' }),
  [TASK_EVENT_TYPES.STOPPED]: Object.freeze({ status: TASK_EVENT_STATUS.STOPPED, label: '已停止任务' }),
  [TASK_EVENT_TYPES.INTERRUPTED]: Object.freeze({ status: TASK_EVENT_STATUS.INTERRUPTED, label: '已中断任务' }),
});

const TASK_EVENT_COMPATIBILITY = Object.freeze({
  [LEGACY_TASK_EVENT_TYPES.EXECUTED]: TASK_EVENT_TYPES.SUCCEEDED,
  [LEGACY_TASK_EVENT_TYPES.STOPPING]: TASK_EVENT_TYPES.STOPPED,
});

function taskEventMeta(task, overrides = {}) {
  const meta = {
    ...compactEventMeta({
      taskId: task?.id,
      taskKey: task?.task_key,
      taskTitle: task?.title,
      planId: task?.plan_id,
      status: task?.status,
      startedAt: task?.started_at,
      finishedAt: task?.finished_at,
      durationMs: task?.duration_ms,
      runDurationMs: task?.run_duration_ms,
    }),
    ...compactEventMeta(overrides),
  };
  Object.assign(meta, agentCliContextFields(meta));
  Object.assign(
    meta,
    meta.agentCliProvider === DEFAULT_AGENT_CLI_PROVIDER
      ? codexSessionContextFields({
          codexSessionId: meta.codexSessionId ?? meta.codex_session_id ?? meta.sessionId ?? task?.codex_session_id,
          codexSessionRequestedId: meta.codexSessionRequestedId,
          codexSessionMode: meta.codexSessionMode,
          codexSessionState: meta.codexSessionState,
          codexSessionFallback: meta.codexSessionFallback,
        })
      : meta.agentCliProvider === 'opencode'
        ? opencodeSessionContextFields({
            opencodeSessionId: meta.opencodeSessionId ?? meta.agentCliSessionId ?? meta.agent_cli_session_id,
            opencodeSessionRequestedId: meta.opencodeSessionRequestedId ?? meta.agentCliSessionRequestedId,
            opencodeSessionMode: meta.opencodeSessionMode ?? meta.agentCliSessionMode,
            opencodeSessionState: meta.opencodeSessionState ?? meta.agentCliSessionState,
          })
      : {},
  );
  meta.taskId = normalizeOptionalNumber(meta.taskId);
  meta.planId = normalizeOptionalNumber(meta.planId);
  meta.taskKey = normalizeOptionalString(meta.taskKey);
  meta.taskTitle = normalizeOptionalString(meta.taskTitle);
  meta.status = normalizeOptionalString(meta.status);
  meta.startedAt = normalizeOptionalString(meta.startedAt);
  meta.finishedAt = normalizeOptionalString(meta.finishedAt);
  meta.agentCliProvider = normalizeOptionalString(meta.agentCliProvider);
  meta.agentCliCommand = normalizeOptionalString(meta.agentCliCommand);
  meta.codexReasoningEffort = meta.agentCliProvider === DEFAULT_AGENT_CLI_PROVIDER
    ? normalizeOptionalCodexReasoningEffort(meta.codexReasoningEffort)
    : undefined;
  meta.durationMs = normalizeOptionalNumber(meta.durationMs);
  meta.runDurationMs = normalizeOptionalNumber(meta.runDurationMs);
  meta.timedOut = meta.timedOut === undefined && meta.timed_out === undefined
    ? undefined
    : Boolean(meta.timedOut ?? meta.timed_out);
  meta.timeoutMs = normalizeOptionalNumber(meta.timeoutMs ?? meta.timeout_ms);
  meta.timeoutMinutes = normalizeOptionalNumber(meta.timeoutMinutes ?? meta.timeout_minutes);
  delete meta.timed_out;
  delete meta.timeout_ms;
  delete meta.timeout_minutes;
  const compacted = compactEventMeta(meta);
  return Object.keys(compacted).length ? compacted : null;
}

function taskEventMessage(type, task, meta = null) {
  const taskLabel = task?.task_key ? `${task.task_key} 任务` : task?.id ? `任务 #${task.id}` : '任务';
  const separator = taskLabel === '任务' ? '' : ' ';
  const taskTitle = normalizeOptionalString(task?.title) || '未命名任务';
  const action =
    {
      [TASK_EVENT_TYPES.STARTED]: '开始了',
      [TASK_EVENT_TYPES.SUCCEEDED]: '结束了',
      [TASK_EVENT_TYPES.FAILED]: '执行失败',
      [TASK_EVENT_TYPES.STOP_REQUESTED]: '请求停止',
      [TASK_EVENT_TYPES.STOPPED]: '停止了',
      [TASK_EVENT_TYPES.INTERRUPTED]: '中断了',
    }[type] || '更新了';
  const providerContext = meta?.agentCliProvider ? agentCliProviderDisplayName(meta.agentCliProvider) : '';
  const codexContext = meta?.agentCliProvider === DEFAULT_AGENT_CLI_PROVIDER ? codexSessionReadableLabel(meta) : '';
  const opencodeContext = meta?.agentCliProvider === 'opencode' ? meta.opencodeSessionLabel || meta.agentCliSessionLabel || '' : '';
  const reasoningContext = meta?.agentCliProvider === DEFAULT_AGENT_CLI_PROVIDER && meta?.codexReasoningEffort
    ? `思考深度 ${meta.codexReasoningEffort}`
    : '';
  const contexts = [providerContext, reasoningContext, codexContext, opencodeContext].filter(Boolean).join(' · ');
  return `${action}${separator}${taskLabel}：${taskTitle}${contexts ? `（${contexts}）` : ''}`;
}

function markTaskLifecycleEventRecorded(error) {
  if (!error || (typeof error !== 'object' && typeof error !== 'function')) return;
  try {
    Object.defineProperty(error, TASK_LIFECYCLE_EVENT_RECORDED, { value: true });
  } catch {
    error[TASK_LIFECYCLE_EVENT_RECORDED] = true;
  }
}

function taskLifecycleEventRecorded(error) {
  return Boolean(error && (typeof error === 'object' || typeof error === 'function') && error[TASK_LIFECYCLE_EVENT_RECORDED]);
}

function syncedTaskStatus(parsedStatus, existingStatus) {
  const next = normalizeOptionalString(parsedStatus) || TASK_EVENT_STATUS.PENDING;
  const current = normalizeOptionalString(existingStatus);
  if (!current) return next;
  if (next === TASK_EVENT_STATUS.COMPLETED || current === TASK_EVENT_STATUS.COMPLETED) return TASK_EVENT_STATUS.COMPLETED;
  if (current === TASK_EVENT_STATUS.RUNNING || current === 'blocked') return current;
  return next;
}

function compactEventMeta(meta) {
  const result = {};
  for (const [key, value] of Object.entries(meta || {})) {
    if (value !== undefined && value !== null && value !== '') result[key] = value;
  }
  return result;
}

function withTaskDurationMeta(task, runDurationMs) {
  if (!task) return null;
  return {
    ...task,
    duration_ms: normalizeDurationMs(task.duration_ms),
    ...(runDurationMs !== undefined ? { run_duration_ms: normalizeDurationMs(runDurationMs) } : {}),
  };
}

function normalizeDurationMs(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return Math.round(number);
}

function taskRunDurationMs(startedAt, finishedAt) {
  const started = Date.parse(startedAt || '');
  const finished = Date.parse(finishedAt || '');
  if (!Number.isFinite(started) || !Number.isFinite(finished) || finished <= started) return 0;
  return Math.round(finished - started);
}

module.exports = {
  LEGACY_TASK_EVENT_TYPES,
  TASK_EVENT_COMPATIBILITY,
  TASK_EVENT_SEMANTICS,
  TASK_EVENT_STATUS,
  TASK_EVENT_TYPES,
  compactEventMeta,
  markTaskLifecycleEventRecorded,
  normalizeDurationMs,
  syncedTaskStatus,
  taskEventMessage,
  taskEventMeta,
  taskLifecycleEventRecorded,
  taskRunDurationMs,
  withTaskDurationMeta,
};
