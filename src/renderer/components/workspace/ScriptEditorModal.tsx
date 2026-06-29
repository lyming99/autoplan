import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type {
  AppSnapshot,
  Script,
  ScriptContextInject,
  ScriptHookStage,
  ScriptRuntime,
  ScriptSourceType,
  ScriptTriggerMode,
} from '../../types';
import { getTimestampMs } from '../../utils/time';
import {
  createScriptDraft,
  getErrorMessage,
  scriptCreateInputFromDraft,
  scriptUpdateInputFromDraft,
  validateScriptDraft,
  SCRIPT_RUNTIMES,
  type ScriptDraftState,
} from '../../utils/workspaceForms';
import { Icon } from '../icons';

type RuntimeMeta = { label: string; ext: string; eol: 'LF' | 'CRLF'; dot: string };

const RUNTIME_META: Record<ScriptRuntime, RuntimeMeta> = {
  node: { label: 'Node.js', ext: '.node', eol: 'LF', dot: 'node' },
  bash: { label: 'Bash', ext: '.sh', eol: 'LF', dot: 'bash' },
  ps: { label: 'PowerShell', ext: '.ps1', eol: 'CRLF', dot: 'ps' },
  cmd: { label: 'CMD', ext: '.bat', eol: 'CRLF', dot: 'cmd' },
};

const HOOK_STAGE_OPTIONS: { stage: ScriptHookStage; label: string }[] = [
  { stage: 'plan:after', label: '计划生成后' },
  { stage: 'task:after', label: '任务执行后' },
  { stage: 'validation:before', label: '验收前' },
  { stage: 'loop:end', label: '循环结束' },
  { stage: 'on:fail', label: '失败时' },
];

const CONTEXT_OPTIONS: { value: ScriptContextInject; label: string }[] = [
  { value: 'env', label: '环境变量' },
  { value: 'stdin', label: 'stdin (JSON)' },
  { value: 'none', label: '不注入' },
];

type LogTab = 'merged' | 'stdout' | 'stderr';

function formatDurationShort(ms?: number | null) {
  if (ms === null || typeof ms === 'undefined') return '';
  const seconds = ms / 1000;
  if (seconds < 1) return `${Math.max(1, Math.round(ms))}ms`;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 2 : 1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m${Math.round(seconds % 60)}s`;
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
  return `${Math.floor(hours / 24)} 天前`;
}

function classifyLogLine(line: string) {
  if (/\[ok\]|\[done\]|✓|passed|succeed/i.test(line)) return 'lvl-s';
  if (/\[err\]|\[error\]|✗|fail|exception|traceback/i.test(line)) return 'lvl-e';
  if (/\[run\]|\[ctx\]|▶|启动|注入/i.test(line)) return 'lvl-i';
  return '';
}

function pickNewlyCreatedScript(snapshot: AppSnapshot, projectId: number): Script | null {
  const candidates = (snapshot.scripts || [])
    .filter((item) => Number(item.project_id) === Number(projectId))
    .sort((a, b) => Number(b.id) - Number(a.id));
  return candidates[0] ?? null;
}

/**
 * 脚本详情弹窗（P005）：代码编辑器 + 运行日志 + 右侧配置面板。
 * 新建与编辑共用：script 为 null 表示新建态。父视图按 id 从最新 snapshot
 * 查询后传入 script，保证 last_status/last_log 等只读展示字段在运行/保存后实时刷新。
 */
export function ScriptEditorModal({
  projectId,
  script,
  onClose,
  onSync,
  onToggle,
  onScriptIdChange,
}: {
  projectId: number;
  script: Script | null;
  onClose: () => void;
  onSync: (snapshot: AppSnapshot) => void;
  onToggle: (script: Script) => void;
  /** 切换当前编辑目标：null=新建态，number=切换到既有脚本（新建保存/复制时用） */
  onScriptIdChange: (scriptId: number | null) => void;
}) {
  // draft 仅在挂载时按初始 script 初始化一次，避免运行/保存后的 prop 刷新覆盖用户编辑。
  const [draft, setDraft] = useState<ScriptDraftState>(() => createScriptDraft(script));
  const [logTab, setLogTab] = useState<LogTab>('merged');
  const [running, setRunning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [logHidden, setLogHidden] = useState(false);

  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);
  const codeRef = useRef<HTMLTextAreaElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  const isNew = draft.id == null;
  const enabled = Boolean(script?.enabled);
  const liveStatus = script?.last_status ?? script?.lastStatus ?? null;
  const liveExitCode = script?.last_exit_code ?? script?.lastExitCode ?? null;
  const liveDuration = script?.last_duration_ms ?? script?.lastDurationMs ?? null;
  const liveLog = logHidden ? '' : script?.last_log ?? '';
  const runtimeMeta = RUNTIME_META[draft.runtime] ?? RUNTIME_META.node;
  const draftPath = draft.path.trim();
  // 文件来源且已指定路径时展示真实文件路径，否则维持既有派生提示（内联来源不变）。
  const derivedPath =
    draft.sourceType === 'file' && draftPath
      ? draftPath
      : (script?.path || '').trim() ||
        `scripts/${(draft.name || 'untitled').trim() || 'untitled'}${runtimeMeta.ext}`;

  const lineCount = useMemo(() => Math.max(draft.body.split('\n').length, 1), [draft.body]);

  // 挂载时聚焦：新建态聚焦脚本名称输入框以强化可发现性，其余态聚焦弹窗容器。
  useEffect(() => {
    if (isNew) nameRef.current?.focus();
    else dialogRef.current?.focus();
  }, []);

  // last_log 内容变化（运行/保存后经 onSync 刷新）时取消"已清空"态，展示最新日志。
  useEffect(() => {
    setLogHidden(false);
  }, [script?.id, script?.last_log]);

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onClose();
    }
  }

  function syncCodeScroll() {
    if (gutterRef.current && codeRef.current) {
      gutterRef.current.scrollTop = codeRef.current.scrollTop;
    }
  }

  function patchDraft(patch: Partial<ScriptDraftState>) {
    setDraft((current) => ({ ...current, ...patch }));
  }

  async function handleSave() {
    const validationError = validateScriptDraft(draft);
    if (validationError) {
      setError(validationError);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (draft.id == null) {
        const snapshot = await window.autoplan.createScript(scriptCreateInputFromDraft(projectId, draft));
        onSync(snapshot);
        const created = pickNewlyCreatedScript(snapshot, projectId);
        if (created) {
          patchDraft({ id: created.id });
          onScriptIdChange(created.id);
        }
      } else {
        const snapshot = await window.autoplan.updateScript(scriptUpdateInputFromDraft(projectId, draft));
        onSync(snapshot);
      }
    } catch (e) {
      setError(getErrorMessage(e, '保存脚本失败'));
    } finally {
      setSaving(false);
    }
  }

  async function handleRun() {
    if (draft.id == null) {
      setError('请先保存脚本后再运行');
      return;
    }
    setRunning(true);
    setError(null);
    setLogHidden(false);
    try {
      const result = await window.autoplan.runScript({ projectId, scriptId: draft.id });
      onSync(result.snapshot);
    } catch (e) {
      setError(getErrorMessage(e, '运行脚本失败'));
    } finally {
      setRunning(false);
    }
  }

  async function handleStop() {
    if (draft.id == null) return;
    try {
      const snapshot = await window.autoplan.stopScript({ projectId, scriptId: draft.id });
      onSync(snapshot);
      setError(null);
    } catch (e) {
      setError(getErrorMessage(e, '停止脚本失败'));
    }
  }

  async function handleDelete() {
    if (draft.id == null) return;
    if (!window.confirm(`确认删除脚本「${draft.name || '未命名脚本'}」？此操作不可撤销。`)) return;
    try {
      const snapshot = await window.autoplan.deleteScript({ projectId, scriptId: draft.id });
      onSync(snapshot);
      onClose();
    } catch (e) {
      setError(getErrorMessage(e, '删除脚本失败'));
    }
  }

  function handleCopy() {
    // 以当前配置创建副本草稿（切换到新建态，保留字段，名称加" 副本"）
    patchDraft({ id: null, name: `${(draft.name || '未命名脚本').trim()} 副本`, enabled: true });
    onScriptIdChange(null);
    setError(null);
  }

  function downloadLog() {
    const text = script?.last_log ?? '';
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${(draft.name || 'script').trim() || 'script'}.log`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }

  async function handlePickFile() {
    try {
      const picked = await window.autoplan.pickScriptFile({ runtime: draft.runtime });
      // 用户取消（返回 null）不报错、不清空已选 path；成功时回填并清空错误态。
      if (picked) {
        patchDraft({ path: picked });
        setError(null);
      }
    } catch (e) {
      setError(getErrorMessage(e, '选择文件失败'));
    }
  }

  const exitTone = liveStatus === 'ok' ? 'rc-ok' : liveStatus === 'bad' ? 'rc-bad' : '';
  const canRun = !isNew && !running;
  const canStop = !isNew && running;

  return (
    <div className="modal-mask" onClick={onClose}>
      <div
        ref={dialogRef}
        className="modal script-editor-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <div className="modal-head script-modal-head">
          <span className="mh-ico">
            <Icon name="code" size={22} aria-hidden="true" />
          </span>
          <div className="mh-title-wrap">
            <div className="mh-title" id={titleId}>
              <input
                ref={nameRef}
                className="mh-title-input"
                value={draft.name}
                placeholder="请输入脚本名称…"
                maxLength={120}
                aria-label="脚本名称"
                onChange={(event) => patchDraft({ name: event.target.value })}
              />
              {!isNew ? (
                <span className={`chip ${enabled ? 'chip-completed' : 'chip-pending'}`}>
                  {enabled ? '已启用' : '已禁用'}
                </span>
              ) : (
                <span className="chip chip-pending">新建</span>
              )}
            </div>
            <div className="mh-sub">
              <span>{derivedPath}</span>
              <span className="mh-sub-dot">·</span>
              <span className="sc-trigger">
                <Icon name={draft.triggerMode === 'manual' ? 'power' : 'bolt'} size={12} aria-hidden="true" />
                {draft.triggerMode === 'manual' ? '仅手动' : draft.hookStage}
              </span>
            </div>
          </div>
          <div className="mh-actions">
            {!isNew ? (
              <div className="mh-toggle-group">
                <span>启用</span>
                <button
                  type="button"
                  className={`toggle sm sc-toggle${enabled ? ' on' : ''}`}
                  aria-pressed={enabled}
                  aria-label={enabled ? '禁用脚本' : '启用脚本'}
                  title="启用/禁用"
                  onClick={() => script && onToggle(script)}
                />
              </div>
            ) : null}
            <button type="button" className="icon-btn" title="复制脚本" onClick={handleCopy} aria-label="复制脚本">
              <Icon name="copy" size={16} aria-hidden="true" />
            </button>
            <button type="button" className="icon-btn danger" title="删除脚本" onClick={handleDelete} disabled={isNew} aria-label="删除脚本">
              <Icon name="trash" size={16} aria-hidden="true" />
            </button>
            <button type="button" className="modal-close" onClick={onClose} aria-label="关闭">
              <Icon name="close" size={18} aria-hidden="true" />
            </button>
          </div>
        </div>

        <div className="modal-body script-modal-body">
          <div className="dlg-layout">
            {/* 左：代码编辑器 + 运行日志 */}
            <div className="dlg-left">
              <div className="editor-card">
                <div className="editor-tabs">
                  {SCRIPT_RUNTIMES.map((runtime) => (
                    <button
                      key={runtime}
                      type="button"
                      className={`etab lang-tab${draft.runtime === runtime ? ' active' : ''}`}
                      onClick={() => patchDraft({ runtime })}
                    >
                      <span className={`lang-dot ${RUNTIME_META[runtime].dot}`} />
                      {RUNTIME_META[runtime].label}
                    </button>
                  ))}
                  <div className="editor-spacer">
                    <span className="editor-lang">
                      {runtimeMeta.label} · {runtimeMeta.ext} · UTF-8 · {runtimeMeta.eol}
                    </span>
                  </div>
                </div>
                <div className="editor-source">
                  <span className="es-label">
                    <Icon name="file" size={13} aria-hidden="true" />
                    来源
                  </span>
                  <div className="segment es-segment">
                    <button
                      type="button"
                      className={draft.sourceType === 'inline' ? 'active' : ''}
                      onClick={() => patchDraft({ sourceType: 'inline' as ScriptSourceType })}
                    >
                      <Icon name="code" size={13} aria-hidden="true" />
                      内联代码
                    </button>
                    <button
                      type="button"
                      className={draft.sourceType === 'file' ? 'active' : ''}
                      onClick={() => patchDraft({ sourceType: 'file' as ScriptSourceType })}
                    >
                      <Icon name="folder" size={13} aria-hidden="true" />
                      选择文件
                    </button>
                  </div>
                </div>
                {draft.sourceType === 'file' ? (
                  <div className="source-file-wrap">
                    <div className="source-file-row">
                      <input
                        className="mono source-file-input"
                        value={draft.path}
                        placeholder="${workspace}/scripts/my-script.sh"
                        aria-label="脚本文件路径"
                        onChange={(event) => patchDraft({ path: event.target.value })}
                      />
                      <button type="button" className="btn source-file-btn" onClick={handlePickFile}>
                        <Icon name="folder" size={14} aria-hidden="true" />
                        选择文件
                      </button>
                    </div>
                    <span className="source-file-hint">
                      将用 <b>{runtimeMeta.label}</b> 解释器直接运行该文件，文件改动即时生效。
                    </span>
                    {draftPath ? (
                      <span className="source-file-path">
                        当前：<code>{draftPath}</code>
                      </span>
                    ) : null}
                  </div>
                ) : (
                  <div className="code-wrap">
                    <div className="code-editor">
                      <div className="code-gutter" ref={gutterRef} aria-hidden="true">
                        {Array.from({ length: lineCount }, (_, index) => (
                          <span className="ln" key={index}>
                            {index + 1}
                          </span>
                        ))}
                      </div>
                      <textarea
                        ref={codeRef}
                        className="code-input"
                        value={draft.body}
                        spellCheck={false}
                        wrap="off"
                        placeholder={`// 在此编写 ${runtimeMeta.label} 代码…`}
                        onChange={(event) => patchDraft({ body: event.target.value })}
                        onScroll={syncCodeScroll}
                      />
                    </div>
                  </div>
                )}
              </div>

              {/* 运行日志 */}
              <div className="log-card">
                <div className="log-head">
                  <div className="lh-title">
                    <Icon name="terminal" size={15} aria-hidden="true" />
                    运行日志
                  </div>
                  <div className="log-head-actions">
                    <div className="log-tabs">
                      {(['merged', 'stdout', 'stderr'] as LogTab[]).map((tab) => (
                        <button
                          key={tab}
                          type="button"
                          className={`log-tab${logTab === tab ? ' active' : ''}`}
                          onClick={() => setLogTab(tab)}
                        >
                          {tab === 'merged' ? '合并' : tab}
                        </button>
                      ))}
                    </div>
                    <button
                      type="button"
                      className="icon-btn"
                      title="清空"
                      onClick={() => setLogHidden(true)}
                      disabled={!liveLog}
                      aria-label="清空日志"
                    >
                      <Icon name="close" size={14} aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      className="icon-btn"
                      title="下载日志"
                      onClick={downloadLog}
                      disabled={!liveLog}
                      aria-label="下载日志"
                    >
                      <Icon name="folder" size={14} aria-hidden="true" />
                    </button>
                  </div>
                </div>
                <div className="log-body">
                  {liveLog ? (
                    liveLog.split('\n').map((line, index) => (
                      <div key={index} className={`log-line ${classifyLogLine(line)}`}>
                        {line || ' '}
                      </div>
                    ))
                  ) : (
                    <div className="log-empty">暂无运行日志，点击「运行」手动执行脚本。</div>
                  )}
                </div>
              </div>
            </div>

            {/* 右：配置面板 */}
            <div className="config-panel">
              <section className="cfg-card">
                <div className="cfg-title"><Icon name="script" size={15} aria-hidden="true" />基本信息</div>
                <div className="cfg-body">
                  <div className="field">
                    <label>描述（可选）</label>
                    <textarea rows={2} value={draft.description} placeholder="简要说明脚本用途…" onChange={(event) => patchDraft({ description: event.target.value })} />
                  </div>
                </div>
              </section>

              <section className="cfg-card">
                <div className="cfg-title"><Icon name="bolt" size={15} aria-hidden="true" />触发方式</div>
                <div className="cfg-body">
                  <div className="field">
                    <label>运行模式</label>
                    <div className="segment">
                      <button
                        type="button"
                        className={draft.triggerMode === 'hook' ? 'active' : ''}
                        onClick={() => patchDraft({ triggerMode: 'hook' as ScriptTriggerMode })}
                      >
                        <Icon name="bolt" size={13} aria-hidden="true" />
                        自动钩子
                      </button>
                      <button
                        type="button"
                        className={draft.triggerMode === 'manual' ? 'active' : ''}
                        onClick={() => patchDraft({ triggerMode: 'manual' as ScriptTriggerMode })}
                      >
                        <Icon name="power" size={13} aria-hidden="true" />
                        仅手动
                      </button>
                    </div>
                  </div>
                  <div className="field">
                    <label>挂载阶段（循环钩子）</label>
                    <div className="hook-grid">
                      {HOOK_STAGE_OPTIONS.map((option) => {
                        const active = draft.triggerMode === 'hook' && draft.hookStage === option.stage;
                        const disabled = draft.triggerMode !== 'hook';
                        return (
                          <button
                            key={option.stage}
                            type="button"
                            className={`hook-opt${active ? ' active' : ''}${disabled ? ' disabled' : ''}`}
                            disabled={disabled}
                            onClick={() => patchDraft({ hookStage: option.stage })}
                          >
                            <span className="hook-radio" />
                            <span className="ho-label">{option.label}</span>
                            <span className="ho-code">{option.stage}</span>
                          </button>
                        );
                      })}
                    </div>
                    {draft.triggerMode === 'manual' ? (
                      <span className="field-hint">仅手动模式下脚本不会挂到循环阶段。</span>
                    ) : null}
                  </div>
                </div>
              </section>

              <section className="cfg-card">
                <div className="cfg-title"><Icon name="sliders" size={15} aria-hidden="true" />执行设置</div>
                <div className="cfg-body">
                  <div className="field">
                    <label>
                      <Icon name="folder" size={12} aria-hidden="true" />
                      工作目录
                    </label>
                    <input
                      className="mono"
                      value={draft.workDir}
                      placeholder="${workspace}"
                      onChange={(event) => patchDraft({ workDir: event.target.value })}
                    />
                    <span className="field-hint">
                      留空使用项目工作区，支持 <code>{'${workspace}'}</code> <code>{'${planDir}'}</code> 占位。
                    </span>
                  </div>
                  <div className="field">
                    <label>
                      <Icon name="clock" size={12} aria-hidden="true" />
                      超时（秒）
                    </label>
                    <input
                      className="mono"
                      inputMode="numeric"
                      value={draft.timeoutSeconds}
                      onChange={(event) => patchDraft({ timeoutSeconds: event.target.value })}
                    />
                  </div>
                  <div className="field">
                    <label>失败处理</label>
                    <div className="fail-control">
                      <button
                        type="button"
                        className={`toggle sm sc-toggle${draft.failAborts ? ' on' : ''}`}
                        aria-pressed={draft.failAborts}
                        onClick={() => patchDraft({ failAborts: !draft.failAborts })}
                        aria-label="切换失败中断"
                      />
                      <span className="ft-text">
                        非零退出码<b> 中断当前阶段</b>（仅前置阶段如「验收前」有效）
                      </span>
                    </div>
                  </div>
                </div>
              </section>

              <section className="cfg-card">
                <div className="cfg-title"><Icon name="inject" size={15} aria-hidden="true" />上下文注入</div>
                <div className="cfg-body">
                  <div className="field">
                    <label>注入方式</label>
                    <div className="segment">
                      {CONTEXT_OPTIONS.map((option) => (
                        <button
                          key={option.value}
                          type="button"
                          className={draft.contextInject === option.value ? 'active' : ''}
                          onClick={() => patchDraft({ contextInject: option.value })}
                        >
                          {option.label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="field">
                    <label>可读取的循环上下文</label>
                    <span className="field-hint">
                      勾选后以 <code>AUTOPLAN_*</code> 传入：当前 plan、任务 key、scope 文件、工作区路径与事件 meta。
                    </span>
                  </div>
                </div>
              </section>
            </div>
          </div>
        </div>

        <div className="modal-foot script-modal-foot">
          <div className="mf-info">
            <span>退出码 <b className={exitTone}>{isNew || liveExitCode === null ? '—' : String(liveExitCode)}</b></span>
            <span>耗时 <b>{formatDurationShort(liveDuration) || '—'}</b></span>
            <span>最近触发 <b>{formatRelativeTime(script?.last_run_at ?? script?.lastRunAt) || '未运行'}</b></span>
          </div>
          {error ? <span className="mf-error" role="alert">{error}</span> : null}
          <div className="mf-actions">
            <button type="button" className="btn" onClick={onClose}>关闭</button>
            <button type="button" className="btn" onClick={handleStop} disabled={!canStop}>
              <Icon name="stop" size={14} aria-hidden="true" />停止
            </button>
            <button type="button" className="btn btn-primary" onClick={handleSave} disabled={saving}>
              <Icon name="save" size={14} aria-hidden="true" />{saving ? '保存中…' : isNew ? '创建' : '保存'}
            </button>
            <button type="button" className="btn btn-success" onClick={handleRun} disabled={!canRun} title={isNew ? '请先保存脚本' : undefined}>
              <Icon name="play" size={14} aria-hidden="true" />{running ? '运行中…' : '运行'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
