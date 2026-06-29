import { useMemo, useState, type ReactNode } from 'react';
import type { AppSnapshot, Script, ScriptHookStage, ScriptLastStatus, ScriptRuntime, ScriptSourceType } from '../../types';
import { getTimestampMs } from '../../utils/time';
import { Icon, type IconName } from '../icons';
import { ScriptEditorModal } from './ScriptEditorModal';

type ScriptFilter = 'all' | 'hook' | 'manual';

const RUNTIME_META: Record<ScriptRuntime, { ext: string; tag: string }> = {
  node: { ext: '.node', tag: 'node' },
  bash: { ext: '.sh', tag: 'shell' },
  ps: { ext: '.ps1', tag: 'ps' },
  cmd: { ext: '.bat', tag: 'cmd' },
};

const HOOK_STAGE_LABEL: Record<ScriptHookStage, string> = {
  'plan:after': '计划生成后',
  'task:after': '任务执行后',
  'validation:before': '验收前',
  'loop:end': '循环结束',
  'on:fail': '失败时',
};

// Script 记录同时容忍蛇形（DB 原样）与驼峰字段，统一在读取处归一化。
function readTriggerMode(script: Script) {
  return script.trigger_mode ?? script.triggerMode ?? 'manual';
}
function readHookStage(script: Script): ScriptHookStage | null {
  return script.hook_stage ?? script.hookStage ?? null;
}
function readEnabled(script: Script) {
  return Boolean(script.enabled);
}
function readLastStatus(script: Script): ScriptLastStatus | null {
  return script.last_status ?? script.lastStatus ?? null;
}
function readSourceType(script: Script): ScriptSourceType {
  return script.source_type ?? script.sourceType ?? 'inline';
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

function scriptPath(script: Script) {
  const explicit = (script.path || '').trim();
  // 文件来源且已指定路径时展示真实文件路径；内联来源（含历史脚本）维持既有派生提示。
  if (readSourceType(script) === 'file' && explicit) return explicit;
  const ext = RUNTIME_META[script.runtime]?.ext ?? '.node';
  return `scripts/${script.name || 'untitled'}${ext}`;
}

type StatusInfo = { led: string; text: string; tone: 'ok' | 'bad' | 'idle' };

function scriptStatus(script: Script): StatusInfo {
  if (!readEnabled(script)) return { led: 'idle', text: '已禁用', tone: 'idle' };
  const status = readLastStatus(script);
  if (status === 'ok') {
    const dur = formatDurationShort(script.last_duration_ms ?? script.lastDurationMs);
    return { led: 'ok', text: dur ? `成功 · ${dur}` : '成功', tone: 'ok' };
  }
  if (status === 'bad') {
    const code = script.last_exit_code ?? script.lastExitCode;
    return { led: 'bad', text: `失败 · 退出码 ${code ?? 1}`, tone: 'bad' };
  }
  if (status === 'running') {
    return { led: 'running', text: '运行中', tone: 'ok' };
  }
  return { led: 'idle', text: '未运行', tone: 'idle' };
}

/**
 * 脚本模块卡片列表视图（P004 列表 + P005 详情弹窗）。
 * 列表上的启用开关即时落库；详情弹窗（新建/编辑/运行）由本视图持有打开/新建态。
 * 运行/保存后通过 onSync 把最新 snapshot 回灌控制器，使列表卡片状态与导航徽标数量同步刷新。
 */
export function WorkspaceScriptsView({
  scripts,
  projectId,
  onToggle,
  onSync,
}: {
  scripts: Script[];
  projectId: number;
  onToggle: (script: Script) => void;
  onSync: (snapshot: AppSnapshot) => void;
}) {
  const [filter, setFilter] = useState<ScriptFilter>('all');
  const [query, setQuery] = useState('');
  // 打开/新建态：open=false 关闭；scriptId=null 新建；scriptId=数字 编辑既有。
  const [modal, setModal] = useState<{ open: boolean; scriptId: number | null }>({ open: false, scriptId: null });

  function openExisting(script: Script) {
    setModal({ open: true, scriptId: script.id });
  }
  function openNew() {
    setModal({ open: true, scriptId: null });
  }
  function closeModal() {
    setModal({ open: false, scriptId: null });
  }

  const editingScript = modal.open && modal.scriptId != null
    ? scripts.find((script) => script.id === modal.scriptId) ?? null
    : null;

  const counts = useMemo(() => {
    let hook = 0;
    let manual = 0;
    for (const script of scripts) {
      if (readTriggerMode(script) === 'hook') hook += 1;
      else manual += 1;
    }
    return { all: scripts.length, hook, manual };
  }, [scripts]);

  const visible = useMemo(() => {
    const term = query.trim().toLowerCase();
    return scripts.filter((script) => {
      const mode = readTriggerMode(script);
      if (filter === 'hook' && mode !== 'hook') return false;
      if (filter === 'manual' && mode !== 'manual') return false;
      if (!term) return true;
      const stage = readHookStage(script);
      const haystack = [script.name, stage ?? '', stage ? HOOK_STAGE_LABEL[stage] : '']
        .join(' ')
        .toLowerCase();
      return haystack.includes(term);
    });
  }, [scripts, filter, query]);

  if (scripts.length === 0) {
    return (
      <>
        <div className="scripts-view">
          <EmptyScripts onCreate={openNew} />
        </div>
        {modal.open ? (
          <ScriptEditorModal
            projectId={projectId}
            script={editingScript}
            onClose={closeModal}
            onSync={onSync}
            onToggle={onToggle}
            onScriptIdChange={(scriptId) => setModal({ open: true, scriptId })}
          />
        ) : null}
      </>
    );
  }

  return (
    <>
      <div className="scripts-view">
      <div className="scripts-toolbar">
        <div className="filter-tabs" role="tablist" aria-label="脚本筛选">
          <FilterTab active={filter === 'all'} count={counts.all} onClick={() => setFilter('all')}>
            全部
          </FilterTab>
          <FilterTab
            active={filter === 'hook'}
            count={counts.hook}
            icon="bolt"
            onClick={() => setFilter('hook')}
          >
            触发型
          </FilterTab>
          <FilterTab
            active={filter === 'manual'}
            count={counts.manual}
            icon="power"
            onClick={() => setFilter('manual')}
          >
            手动
          </FilterTab>
        </div>
        <div className="scripts-toolbar-spacer">
          <label className="scripts-search">
            <Icon name="search" size={16} aria-hidden="true" />
            <input
              type="text"
              placeholder="搜索脚本名称或挂载阶段…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
        </div>
      </div>

      <div className="script-grid">
        {visible.map((script) => (
          <ScriptCard
            key={script.id}
            script={script}
            onToggle={() => onToggle(script)}
            onOpen={() => openExisting(script)}
          />
        ))}
        {visible.length === 0 ? (
          <div className="big-empty">
            <span className="be-ico">
              <Icon name="search" size={30} aria-hidden="true" />
            </span>
            <h3>没有匹配的脚本</h3>
            <p>换个关键词，或切换筛选条件。</p>
          </div>
        ) : null}
        <button type="button" className="new-card" onClick={openNew}>
          <span className="nc-ico">
            <Icon name="plus" size={22} aria-hidden="true" />
          </span>
          <span className="nc-text">新建脚本</span>
        </button>
      </div>
      </div>
      {modal.open ? (
        <ScriptEditorModal
          projectId={projectId}
          script={editingScript}
          onClose={closeModal}
          onSync={onSync}
          onToggle={onToggle}
          onScriptIdChange={(scriptId) => setModal({ open: true, scriptId })}
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

function ScriptCard({
  script,
  onToggle,
  onOpen,
}: {
  script: Script;
  onToggle: () => void;
  onOpen: () => void;
}) {
  const mode = readTriggerMode(script);
  const enabled = readEnabled(script);
  const meta = RUNTIME_META[script.runtime] ?? RUNTIME_META.node;
  const status = scriptStatus(script);
  const stage = readHookStage(script);
  const sourceType = readSourceType(script);
  const relative = formatRelativeTime(script.last_run_at ?? script.lastRunAt);

  return (
    <article
      className={`script-card ${mode === 'manual' ? 't-manual' : 't-hook'}${enabled ? '' : ' disabled'}`}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onOpen();
        }
      }}
      role="button"
      tabIndex={0}
    >
      <div className="sc-top">
        <span className="sc-ico">
          <Icon name="code" size={20} aria-hidden="true" />
        </span>
        <div className="sc-info">
          <div className="sc-name">{script.name || '未命名脚本'}</div>
          <div className="sc-path">{scriptPath(script)}</div>
        </div>
        <button
          type="button"
          className={`toggle sm sc-toggle${enabled ? ' on' : ''}`}
          aria-pressed={enabled}
          aria-label={enabled ? '禁用脚本' : '启用脚本'}
          title="启用/禁用"
          onClick={(event) => {
            event.stopPropagation();
            onToggle();
          }}
        />
      </div>
      {script.description ? <p className="sc-desc">{script.description}</p> : null}
      <div className="sc-mid">
        <span className={`sc-lang ${meta.tag}`}>{meta.ext}</span>
        {sourceType === 'file' ? (
          <span className="sc-source sc-lang">
            <Icon name="folder" size={12} aria-hidden="true" />
            文件
          </span>
        ) : null}
        <span className={`sc-trigger${mode === 'manual' ? ' manual' : ''}`}>
          <Icon name={mode === 'manual' ? 'power' : 'bolt'} size={12} aria-hidden="true" />
          {mode === 'manual' ? '手动' : stage ? HOOK_STAGE_LABEL[stage] : '自动钩子'}
        </span>
      </div>
      <div className="sc-foot">
        <span className={`sc-led ${status.led}`} />
        <span className={`sc-status${status.tone === 'idle' ? '' : ` ${status.tone}`}`}>{status.text}</span>
        {relative ? <span className="sc-time">{relative}</span> : null}
      </div>
    </article>
  );
}

function EmptyScripts({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="big-empty">
      <span className="be-ico">
        <Icon name="script" size={30} aria-hidden="true" />
      </span>
      <h3>还没有脚本</h3>
      <p>创建自定义脚本，手动运行或挂到循环各阶段自动触发。</p>
      <button type="button" className="btn btn-primary btn-sm" onClick={onCreate}>
        <Icon name="plus" size={14} aria-hidden="true" />
        新建脚本
      </button>
    </div>
  );
}
