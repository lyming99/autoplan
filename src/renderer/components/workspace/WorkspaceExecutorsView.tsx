import { useMemo, useState, type ReactNode } from 'react';
import type { AppSnapshot, Executor, ExecutorLastStatus } from '../../types';
import { getTimestampMs } from '../../utils/time';
import { Icon, type IconName } from '../icons';
import { ExecutorEditorModal } from './ExecutorEditorModal';

type ExecutorFilter = 'all' | 'build' | 'test' | 'custom' | 'disabled' | 'recent';
type BusyAction = 'run' | 'stop' | 'toggle' | 'delete' | 'import' | 'start' | 'reload';
type PluginAction = 'start' | 'reload' | 'stop';

const GROUP_LABELS: Record<string, string> = {
  build: '构建',
  test: '测试',
  custom: '自定义',
};

const TYPE_LABELS = {
  shell: 'shell',
  process: 'process',
  plugin: '插件',
} as const;

const LOG_PANEL_MAX_LINES = 50;

type Notice = { tone: 'ok' | 'bad'; text: string } | null;
type StatusInfo = { led: string; text: string; tone: 'ok' | 'bad' | 'idle' };

export function WorkspaceExecutorsView({
  executors,
  projectId,
  onSync,
}: {
  executors: Executor[];
  projectId: number;
  onSync: (snapshot: AppSnapshot) => void;
}) {
  const [filter, setFilter] = useState<ExecutorFilter>('all');
  const [query, setQuery] = useState('');
  const [modal, setModal] = useState<{ open: boolean; executorId: number | null }>({ open: false, executorId: null });
  const [busy, setBusy] = useState<{ executorId: number | null; action: BusyAction } | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  const editingExecutor = modal.open && modal.executorId != null
    ? executors.find((executor) => executor.id === modal.executorId) ?? null
    : null;

  const counts = useMemo(() => {
    const next = { all: executors.length, build: 0, test: 0, custom: 0, disabled: 0, recent: 0 };
    for (const executor of executors) {
      const group = readGroupKind(executor);
      if (group === 'build') next.build += 1;
      else if (group === 'test') next.test += 1;
      else next.custom += 1;
      if (!readEnabled(executor)) next.disabled += 1;
      if (readLastStatus(executor) || readLastRunAt(executor)) next.recent += 1;
    }
    return next;
  }, [executors]);

  const visible = useMemo(() => {
    const term = query.trim().toLowerCase();
    return executors.filter((executor) => {
      const group = readGroupKind(executor);
      if (filter === 'build' && group !== 'build') return false;
      if (filter === 'test' && group !== 'test') return false;
      if (filter === 'custom' && (group === 'build' || group === 'test')) return false;
      if (filter === 'disabled' && readEnabled(executor)) return false;
      if (filter === 'recent' && !readLastStatus(executor) && !readLastRunAt(executor)) return false;
      if (!term) return true;
      const haystack = [
        executor.label,
        executor.command,
        TYPE_LABELS[executor.type] ?? executor.type,
        group,
        readCwd(executor),
        ...readDependsOn(executor),
      ].join(' ').toLowerCase();
      return haystack.includes(term);
    });
  }, [executors, filter, query]);

  function toggleExpand(executorId: number) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(executorId)) next.delete(executorId);
      else next.add(executorId);
      return next;
    });
  }

  function openNew() {
    setModal({ open: true, executorId: null });
  }

  function openExisting(executor: Executor) {
    setModal({ open: true, executorId: executor.id });
  }

  function closeModal() {
    setModal({ open: false, executorId: null });
  }

  async function runExecutor(executor: Executor) {
    if (!readEnabled(executor) || isExecutorRunning(executor) || isBusy(executor, busy)) return;
    setBusy({ executorId: executor.id, action: 'run' });
    setNotice(null);
    try {
      const result = await window.autoplan.runExecutor({ projectId, executorId: executor.id });
      onSync(result.snapshot);
      setNotice(result.error
        ? { tone: 'bad', text: result.error }
        : { tone: result.status === 'ok' ? 'ok' : 'bad', text: `执行完成：${statusLabel(result.status)}${formatExitSuffix(result.exitCode)}` });
    } catch (e) {
      setNotice({ tone: 'bad', text: getErrorMessage(e, '运行执行器失败') });
    } finally {
      setBusy(null);
    }
  }

  async function stopExecutor(executor: Executor) {
    if (isBusy(executor, busy)) return;
    setBusy({ executorId: executor.id, action: 'stop' });
    setNotice(null);
    try {
      const snapshot = await window.autoplan.stopExecutor({ projectId, executorId: executor.id });
      onSync(snapshot);
    } catch (e) {
      setNotice({ tone: 'bad', text: getErrorMessage(e, '停止执行器失败') });
    } finally {
      setBusy(null);
    }
  }

  async function toggleExecutor(executor: Executor) {
    if (isBusy(executor, busy)) return;
    setBusy({ executorId: executor.id, action: 'toggle' });
    setNotice(null);
    try {
      const snapshot = await window.autoplan.toggleExecutor({ projectId, executorId: executor.id });
      onSync(snapshot);
    } catch (e) {
      setNotice({ tone: 'bad', text: getErrorMessage(e, '切换执行器状态失败') });
    } finally {
      setBusy(null);
    }
  }

  async function deleteExecutor(executor: Executor) {
    if (!window.confirm(`确认删除执行器「${executor.label || '未命名执行器'}」？此操作不可撤销。`)) return;
    setBusy({ executorId: executor.id, action: 'delete' });
    setNotice(null);
    try {
      const snapshot = await window.autoplan.deleteExecutor({ projectId, executorId: executor.id });
      onSync(snapshot);
      setModal((current) => (current.executorId === executor.id ? { open: false, executorId: null } : current));
    } catch (e) {
      setNotice({ tone: 'bad', text: getErrorMessage(e, '删除执行器失败') });
    } finally {
      setBusy(null);
    }
  }

  async function importTasksJson() {
    setBusy({ executorId: null, action: 'import' });
    setNotice(null);
    try {
      const filePath = await window.autoplan.pickTasksJson();
      if (!filePath) return;
      const result = await window.autoplan.importTasksJson({ projectId, filePath });
      onSync(result.snapshot);
      const summary = `导入 ${result.importedCount} 个，跳过 ${result.skippedCount} 个，错误 ${result.errorCount} 个`;
      setNotice({ tone: result.errorCount > 0 ? 'bad' : 'ok', text: summary });
    } catch (e) {
      setNotice({ tone: 'bad', text: getErrorMessage(e, '导入 tasks.json 失败') });
    } finally {
      setBusy(null);
    }
  }

  async function handlePluginAction(executor: Executor, action: PluginAction) {
    if (isBusy(executor, busy)) return;
    setBusy({ executorId: executor.id, action: action === 'reload' ? 'reload' : action === 'start' ? 'start' : 'stop' });
    setNotice(null);
    try {
      const result = await window.autoplan.runExecutorAction({ projectId, executorId: executor.id, action });
      onSync(result.snapshot);
      if (result.error) {
        setNotice({ tone: 'bad', text: result.error });
      } else if (action === 'start') {
        const pid = readResultPid(result);
        setNotice({ tone: 'ok', text: `${executor.label || '插件'} 已启动${pid ? ` · PID ${pid}` : ''}` });
      } else if (action === 'reload') {
        setNotice({ tone: 'ok', text: `${executor.label || '插件'} 已发送热刷新` });
      } else {
        setNotice({ tone: 'ok', text: `${executor.label || '插件'} 已停止` });
      }
    } catch (e) {
      setNotice({ tone: 'bad', text: getErrorMessage(e, '插件动作执行失败') });
    } finally {
      setBusy(null);
    }
  }

  const importBusy = busy?.action === 'import';

  return (
    <>
      <div className="scripts-view">
        <div className="scripts-toolbar">
          <div className="filter-tabs" role="tablist" aria-label="执行器筛选">
            <FilterTab active={filter === 'all'} count={counts.all} onClick={() => setFilter('all')}>
              全部
            </FilterTab>
            <FilterTab active={filter === 'build'} count={counts.build} icon="executor" onClick={() => setFilter('build')}>
              构建
            </FilterTab>
            <FilterTab active={filter === 'test'} count={counts.test} icon="check" onClick={() => setFilter('test')}>
              测试
            </FilterTab>
            <FilterTab active={filter === 'custom'} count={counts.custom} icon="sliders" onClick={() => setFilter('custom')}>
              自定义
            </FilterTab>
            <FilterTab active={filter === 'disabled'} count={counts.disabled} icon="eye-off" onClick={() => setFilter('disabled')}>
              已禁用
            </FilterTab>
            <FilterTab active={filter === 'recent'} count={counts.recent} icon="history" onClick={() => setFilter('recent')}>
              最近状态
            </FilterTab>
          </div>
          <div className="scripts-toolbar-spacer">
            <label className="scripts-search">
              <Icon name="search" size={16} aria-hidden="true" />
              <input
                type="text"
                placeholder="搜索标签或命令…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            <button type="button" className="btn btn-sm" onClick={importTasksJson} disabled={importBusy}>
              <Icon name="folder" size={14} aria-hidden="true" />
              {importBusy ? '导入中…' : '导入 tasks.json'}
            </button>
            <button type="button" className="btn btn-primary btn-sm" onClick={openNew}>
              <Icon name="plus" size={14} aria-hidden="true" />
              新建插件
            </button>
          </div>
        </div>

        {notice ? (
          <div className={notice.tone === 'bad' ? 'error-banner' : 'search-locate-notice'} role="status">
            <span>{notice.text}</span>
            <button type="button" className="btn-link" onClick={() => setNotice(null)}>关闭</button>
          </div>
        ) : null}

        <div className="executor-list">
          {visible.map((executor) => (
            <ExecutorRow
              key={executor.id}
              executor={executor}
              busy={busy?.executorId === executor.id ? busy.action : null}
              expanded={expanded.has(executor.id)}
              onToggleExpand={() => toggleExpand(executor.id)}
              onDelete={() => deleteExecutor(executor)}
              onOpen={() => openExisting(executor)}
              onRun={() => runExecutor(executor)}
              onStop={() => stopExecutor(executor)}
              onToggle={() => toggleExecutor(executor)}
              onPluginAction={(action) => handlePluginAction(executor, action)}
            />
          ))}

          {visible.length === 0 ? (
            <EmptyState hasExecutors={executors.length > 0} onNew={openNew} />
          ) : null}
        </div>
      </div>

      {modal.open ? (
        <ExecutorEditorModal
          key={modal.executorId ?? 'new'}
          projectId={projectId}
          executor={editingExecutor}
          executors={executors}
          onClose={closeModal}
          onSync={onSync}
          onExecutorIdChange={(executorId) => setModal({ open: true, executorId })}
        />
      ) : null}
    </>
  );
}

function FilterTab({
  active,
  count,
  icon,
  onClick,
  children,
}: {
  active: boolean;
  count: number;
  icon?: IconName;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={`filter-tab${active ? ' active' : ''}`}
      role="tab"
      aria-selected={active}
      onClick={onClick}
    >
      {icon ? <Icon name={icon} size={12} aria-hidden="true" /> : null}
      {children}
      <span className="count">{count}</span>
    </button>
  );
}

function ExecutorRow({
  executor,
  busy,
  expanded,
  onToggleExpand,
  onDelete,
  onOpen,
  onRun,
  onStop,
  onToggle,
  onPluginAction,
}: {
  executor: Executor;
  busy: BusyAction | null;
  expanded: boolean;
  onToggleExpand: () => void;
  onDelete: () => void;
  onOpen: () => void;
  onRun: () => void;
  onStop: () => void;
  onToggle: () => void;
  onPluginAction: (action: PluginAction) => void;
}) {
  const enabled = readEnabled(executor);
  const isPlugin = isPluginExecutor(executor);
  const pluginState = readPluginState(executor);
  const running = isExecutorRunning(executor) || busy === 'run' || busy === 'start';
  const pluginRunning = isPlugin && (running || Boolean(pluginState?.running));
  const status = executorStatus(executor, running);
  const groupKind = readGroupKind(executor);
  const groupLabel = GROUP_LABELS[groupKind] ?? groupKind;
  const typeLabel = TYPE_LABELS[executor.type] ?? executor.type;
  const cwd = readCwd(executor);
  const dependsOn = readDependsOn(executor);
  const lastRun = formatRelativeTime(readLastRunAt(executor));
  const exitCode = readExitCode(executor);
  const duration = formatDurationShort(readDuration(executor));
  const logLines = readLogLines(executor);
  const stopBusy = busy === 'stop';

  const rowClassName = [
    'executor-row',
    expanded ? 'expanded' : '',
    pluginRunning ? 'running' : '',
    enabled ? '' : 'disabled',
  ].filter(Boolean).join(' ');

  return (
    <div className={rowClassName}>
      <div
        className="executor-row-header"
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onClick={onToggleExpand}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onToggleExpand();
          }
        }}
      >
        <Icon
          name="chevron-down"
          size={14}
          aria-hidden="true"
          className="executor-row-caret"
        />
        <span className={`sc-led ${status.led}`} aria-hidden="true" />
        <span className="executor-row-icon">
          <Icon name={isPlugin ? 'plug' : 'executor'} size={16} aria-hidden="true" />
        </span>
        <div className="executor-row-main">
          <div className="executor-row-name">
            <span className="executor-row-label" title={executor.label}>{executor.label || '未命名执行器'}</span>
            {pluginRunning ? <span className="executor-pulse" aria-hidden="true" /> : null}
            <span className="sc-lang">{typeLabel}</span>
          </div>
          <div className="executor-row-cmd" title={executor.command}>
            {executor.command || '未设置命令'}
          </div>
        </div>
        <span className="executor-row-group">{groupLabel || '未分组'}</span>

        <div className="executor-actions" onClick={(event) => event.stopPropagation()}>
          {isPlugin ? (
            <>
              <button
                type="button"
                className="executor-action-btn start"
                title="启动"
                aria-label="启动插件执行器"
                disabled={!enabled || pluginRunning || busy === 'start' || busy === 'stop'}
                onClick={() => onPluginAction('start')}
              >
                <Icon name="play" size={13} aria-hidden="true" />
                <span>启动</span>
              </button>
              <button
                type="button"
                className="executor-action-btn reload"
                title="热刷新"
                aria-label="热刷新插件执行器"
                disabled={!pluginRunning || busy === 'reload'}
                onClick={() => onPluginAction('reload')}
              >
                <Icon name="refresh" size={13} aria-hidden="true" />
                <span>热刷新</span>
              </button>
              <button
                type="button"
                className="executor-action-btn stop"
                title="停止"
                aria-label="停止插件执行器"
                disabled={!pluginRunning || stopBusy}
                onClick={() => onPluginAction('stop')}
              >
                <Icon name="stop" size={13} aria-hidden="true" />
                <span>停止</span>
              </button>
            </>
          ) : (
            <button
              type="button"
              className={`executor-action-btn${running ? ' stop' : ' start'}`}
              title={running ? '停止执行器' : enabled ? '运行执行器' : '执行器已禁用'}
              aria-label={running ? '停止执行器' : '运行执行器'}
              disabled={running ? stopBusy : !enabled || Boolean(busy)}
              onClick={() => (running ? onStop() : onRun())}
            >
              <Icon name={running ? 'stop' : 'play'} size={13} aria-hidden="true" />
              <span>{running ? '停止' : '运行'}</span>
            </button>
          )}

          <button
            type="button"
            className={`toggle sm${enabled ? ' on' : ''}`}
            aria-pressed={enabled}
            aria-label={enabled ? '禁用执行器' : '启用执行器'}
            title="启用/禁用"
            disabled={busy === 'toggle'}
            onClick={onToggle}
          />
          <button
            type="button"
            className="icon-btn"
            title="编辑执行器"
            aria-label="编辑执行器"
            onClick={onOpen}
          >
            <Icon name="edit" size={15} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="icon-btn danger"
            title="删除执行器"
            aria-label="删除执行器"
            disabled={busy === 'delete'}
            onClick={onDelete}
          >
            <Icon name="trash" size={15} aria-hidden="true" />
          </button>
        </div>
      </div>

      {expanded ? (
        <div className="executor-row-body">
          <div className="executor-log-panel" aria-label="执行器输出日志">
            {logLines.length > 0 ? (
              <pre>{logLines.join('\n')}</pre>
            ) : (
              <span className="executor-log-empty">
                {pluginRunning ? '等待输出…（运行中日志将随快照更新）' : '暂无输出日志'}
              </span>
            )}
          </div>
          <div className="executor-meta">
            <span className="sc-lang">{groupLabel || '未分组'}</span>
            {readGroupDefault(executor) ? <span className="sc-trigger">默认组任务</span> : null}
            <span className="sc-trigger" title={cwd || '${workspace}'}>
              <Icon name="folder" size={12} aria-hidden="true" />
              {cwd || '${workspace}'}
            </span>
            <span className="sc-trigger" title={dependsOn.join(', ') || '无依赖'}>
              <Icon name="inject" size={12} aria-hidden="true" />
              {dependsOn.length > 0 ? `依赖 ${dependsOn.length}` : '无依赖'}
            </span>
            {duration ? (
              <span className="sc-time">
                <Icon name="clock" size={12} aria-hidden="true" /> {duration}
              </span>
            ) : null}
            <span className="sc-time">退出码 {exitCode === null ? '-' : exitCode}</span>
            {lastRun ? <span className="sc-time">{lastRun}</span> : null}
            {pluginState?.pid ? <span className="sc-time">PID {pluginState.pid}</span> : null}
            <span className={`sc-status${status.tone === 'idle' ? '' : ` ${status.tone}`}`}>
              <span className={`sc-led ${status.led}`} aria-hidden="true" />
              {status.text}
            </span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function EmptyState({ hasExecutors, onNew }: { hasExecutors: boolean; onNew: () => void }) {
  if (hasExecutors) {
    return (
      <div className="big-empty">
        <span className="be-ico">
          <Icon name="executor" size={30} aria-hidden="true" />
        </span>
        <h3>没有匹配的执行器</h3>
        <p>换个关键词，或切换筛选条件。</p>
      </div>
    );
  }
  return (
    <div className="big-empty">
      <span className="be-ico">
        <Icon name="executor" size={30} aria-hidden="true" />
      </span>
        <h3>还没有插件</h3>
        <p>创建插件接入长期运行的开发工具（如 flutter run / npm run dev），支持启动 / 热刷新 / 停止。</p>
      <button type="button" className="btn btn-primary btn-sm" onClick={onNew}>
        <Icon name="plus" size={14} aria-hidden="true" />
        新建执行器
      </button>
    </div>
  );
}

function readEnabled(executor: Executor) {
  return Boolean(executor.enabled);
}

function readGroupKind(executor: Executor) {
  return (executor.group?.kind ?? executor.group_kind ?? 'custom') || 'custom';
}

function readGroupDefault(executor: Executor) {
  return Boolean(executor.group?.isDefault ?? executor.group_is_default);
}

function readCwd(executor: Executor) {
  return executor.options?.cwd || '';
}

function readDependsOn(executor: Executor) {
  return Array.isArray(executor.dependsOn) ? executor.dependsOn : [];
}

function readLastStatus(executor: Executor): ExecutorLastStatus | null {
  return executor.lastStatus ?? executor.last_status ?? null;
}

function readExitCode(executor: Executor) {
  return executor.lastExitCode ?? executor.last_exit_code ?? null;
}

function readDuration(executor: Executor) {
  return executor.lastDurationMs ?? executor.last_duration_ms ?? null;
}

function readLastRunAt(executor: Executor) {
  return executor.lastRunAt ?? executor.last_run_at ?? null;
}

function readPluginState(executor: Executor) {
  return executor.pluginState ?? null;
}

function readLogLines(executor: Executor): string[] {
  const log = String(executor.lastLog ?? executor.last_log ?? '');
  if (!log) return [];
  const lines = log.replace(/\r\n/g, '\n').split('\n');
  return lines.slice(-LOG_PANEL_MAX_LINES);
}

/** ExecutorRunResult 类型未声明 pid（plugin 启动结果携带），这里安全读取 */
function readResultPid(result: unknown): number | null {
  if (!result || typeof result !== 'object' || !('pid' in result)) return null;
  const value = (result as { pid?: unknown }).pid;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function isPluginExecutor(executor: Executor) {
  return executor.type === 'plugin';
}

function isExecutorRunning(executor: Executor) {
  return Boolean(
    executor.running
      || executor.runStatus === 'running'
      || readLastStatus(executor) === 'running'
      || executor.pluginState?.running,
  );
}

function isBusy(executor: Executor, busy: { executorId: number | null; action: BusyAction } | null) {
  return busy?.executorId === executor.id;
}

function executorStatus(executor: Executor, running: boolean): StatusInfo {
  if (running) return { led: 'running', text: '运行中', tone: 'ok' };
  if (!readEnabled(executor)) return { led: 'idle', text: '已禁用', tone: 'idle' };
  const status = readLastStatus(executor);
  if (status === 'ok') return { led: 'ok', text: '成功', tone: 'ok' };
  if (status === 'bad') return { led: 'bad', text: `失败${formatExitSuffix(readExitCode(executor))}`, tone: 'bad' };
  if (status === 'stopped') return { led: 'idle', text: '已停止', tone: 'idle' };
  return { led: 'idle', text: '未运行', tone: 'idle' };
}

function formatExitSuffix(exitCode: number | null) {
  return exitCode === null ? '' : ` · 退出码 ${exitCode}`;
}

function statusLabel(status: ExecutorLastStatus | string) {
  if (status === 'ok') return '成功';
  if (status === 'bad') return '失败';
  if (status === 'stopped') return '已停止';
  if (status === 'running') return '运行中';
  return '未运行';
}

function formatRelativeTime(value?: string | null) {
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

function formatDurationShort(ms?: number | null) {
  if (ms === null || typeof ms === 'undefined') return '';
  const seconds = ms / 1000;
  if (seconds < 1) return `${Math.max(1, Math.round(ms))}ms`;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m${Math.round(seconds % 60)}s`;
}

function getErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : String(error || fallback);
}
