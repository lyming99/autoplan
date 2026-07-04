import type {
  Executor,
  ExecutorActions,
  ExecutorImportMessage,
  ExecutorImportTasksJsonResult,
  ExecutorLastStatus,
  ExecutorPluginActionName,
  ExecutorPluginState,
} from '../../types';
import { getTimestampMs } from '../../utils/time';
import { resolveExecutorCwdHint } from '../../utils/workspaceForms';

export const EXECUTOR_GROUP_LABELS: Record<string, string> = {
  build: '构建',
  test: '测试',
  custom: '自定义',
};

export const EXECUTOR_TYPE_LABELS = {
  shell: 'shell',
  process: 'process',
  plugin: 'plugin',
} as const;

export type ExecutorStatusInfo = {
  led: 'ok' | 'bad' | 'running' | 'idle';
  text: string;
  tone: 'ok' | 'bad' | 'idle';
};

export function readExecutorProjectId(executor: Executor) {
  return Number(executor.projectId ?? executor.project_id ?? 0);
}

export function readExecutorEnabled(executor: Executor) {
  return Boolean(executor.enabled);
}

export function readExecutorGroupKind(executor: Executor) {
  return (executor.group?.kind ?? executor.group_kind ?? 'custom') || 'custom';
}

export function readExecutorGroupLabel(executor: Executor) {
  const kind = readExecutorGroupKind(executor);
  return EXECUTOR_GROUP_LABELS[kind] ?? kind;
}

export function readExecutorGroupDefault(executor: Executor) {
  return Boolean(executor.group?.isDefault ?? executor.group_is_default);
}

export function readExecutorCwd(executor: Executor) {
  return executor.options?.cwd || '';
}

export function formatExecutorCwdPreview(executor: Executor, workspacePath = '') {
  const hint = resolveExecutorCwdHint(readExecutorCwd(executor), workspacePath);
  return hint.resolved ? `${hint.label} -> ${hint.resolved}` : hint.label;
}

export function readExecutorDependsOn(executor: Executor) {
  return Array.isArray(executor.dependsOn) ? executor.dependsOn : [];
}

export function readExecutorLastStatus(executor: Executor): ExecutorLastStatus | null {
  return executor.lastStatus ?? executor.last_status ?? null;
}

export function readExecutorExitCode(executor: Executor) {
  return executor.lastExitCode ?? executor.last_exit_code ?? null;
}

export function readExecutorDurationMs(executor: Executor) {
  return executor.lastDurationMs ?? executor.last_duration_ms ?? null;
}

export function readExecutorLastRunAt(executor: Executor) {
  return executor.lastRunAt ?? executor.last_run_at ?? null;
}

/** 安全读取 plugin 执行器的 actions 配置；非 plugin 或未配置返回空对象 */
export function readExecutorActions(executor: Executor): ExecutorActions {
  return executor.actions ?? {};
}

/** 读取 plugin 运行时状态；非 plugin 或未持久化返回 null */
export function readExecutorPluginState(executor: Executor): ExecutorPluginState | null {
  return executor.pluginState ?? null;
}

export function isExecutorRunning(executor: Executor) {
  return Boolean(executor.running || executor.runStatus === 'running' || readExecutorLastStatus(executor) === 'running');
}

/** 是否为 plugin 类型执行器 */
export function isPluginExecutor(executor: Executor) {
  return executor.type === 'plugin';
}

/** plugin 执行器是否处于运行中（以 pluginState.running 为准，兼容通用运行信号） */
export function isPluginRunning(executor: Executor) {
  if (!isPluginExecutor(executor)) return false;
  return Boolean(readExecutorPluginState(executor)?.running) || isExecutorRunning(executor);
}

export function formatExecutorStatus(executor: Executor, running = isExecutorRunning(executor)): ExecutorStatusInfo {
  if (running) {
    if (isPluginExecutor(executor)) {
      const pid = readExecutorPluginState(executor)?.pid;
      return { led: 'running', text: pid ? `运行中 · PID ${pid}` : '已启动 · 可热刷新', tone: 'ok' };
    }
    return { led: 'running', text: '运行中', tone: 'ok' };
  }
  if (!readExecutorEnabled(executor)) return { led: 'idle', text: '已禁用', tone: 'idle' };
  const status = readExecutorLastStatus(executor);
  if (status === 'ok') return { led: 'ok', text: '成功', tone: 'ok' };
  if (status === 'bad') return { led: 'bad', text: `失败${formatExitSuffix(readExecutorExitCode(executor))}`, tone: 'bad' };
  if (status === 'stopped') return { led: 'idle', text: '已停止', tone: 'idle' };
  return { led: 'idle', text: '未运行', tone: 'idle' };
}

export function formatExecutorRunStatus(status: ExecutorLastStatus | string) {
  if (status === 'ok') return '成功';
  if (status === 'bad') return '失败';
  if (status === 'stopped') return '已停止';
  if (status === 'running') return '运行中';
  return '未运行';
}

/** 格式化 plugin 生命周期动作标签：start→启动，reload→热刷新，stop→停止 */
export function formatPluginActionLabel(action: ExecutorPluginActionName | string) {
  if (action === 'start') return '启动';
  if (action === 'reload') return '热刷新';
  if (action === 'stop') return '停止';
  return action;
}

export function formatExitSuffix(exitCode: number | null | undefined) {
  return exitCode === null || typeof exitCode === 'undefined' ? '' : ` · 退出码 ${exitCode}`;
}

export function formatExecutorDurationShort(ms?: number | null) {
  if (ms === null || typeof ms === 'undefined') return '';
  const seconds = ms / 1000;
  if (seconds < 1) return `${Math.max(1, Math.round(ms))}ms`;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m${Math.round(seconds % 60)}s`;
}

export function formatExecutorRelativeTime(value?: string | null) {
  const ms = getTimestampMs(value);
  if (!ms) return '';
  const diff = Date.now() - ms;
  if (diff < 60_000) return '刚刚';
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  return `${Math.floor(days / 30)} 个月前`;
}

export function classifyExecutorLogLine(line: string) {
  const lower = line.toLowerCase();
  if (lower.includes('error') || lower.includes('failed') || lower.includes('失败')) return 'lvl-e';
  if (lower.includes('success') || lower.includes('ok') || lower.includes('完成')) return 'lvl-s';
  return 'lvl-i';
}

export function pickNewlyCreatedExecutor(
  executors: Executor[],
  projectId: number,
  existingIds: Set<number>,
  label: string,
) {
  const candidates = executors.filter((item) => readExecutorProjectId(item) === Number(projectId));
  const fresh = candidates.filter((item) => !existingIds.has(item.id));
  if (fresh.length > 0) return fresh.sort((a, b) => b.id - a.id)[0];
  return candidates.find((item) => item.label === label) || null;
}

export function summarizeExecutorImportResult(result: ExecutorImportTasksJsonResult) {
  const tone = result.errorCount > 0 ? 'bad' : 'ok';
  const title = `导入 ${result.importedCount} 个，跳过 ${result.skippedCount} 个，错误 ${result.errorCount} 个`;
  const details = [
    ...formatExecutorImportMessages('错误', result.errors),
    ...formatExecutorImportMessages('跳过', result.skipped),
  ];
  return { tone, title, details };
}

export function formatExecutorImportMessages(prefix: string, messages: ExecutorImportMessage[] = []) {
  return messages.map((item) => {
    const label = item.label ? `「${item.label}」` : item.index === null ? '全局' : `#${item.index + 1}`;
    const field = item.field ? ` ${item.field}` : '';
    return `${prefix} ${label}${field}：${item.message}`;
  });
}
