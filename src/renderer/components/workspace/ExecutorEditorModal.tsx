import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import type {
  AppSnapshot,
  Executor,
  ExecutorActions,
  ExecutorArg,
  ExecutorDependsOrder,
  ExecutorInput,
  ExecutorPresentation,
  ExecutorProblemMatcher,
  ExecutorType,
} from '../../types';
import { getTimestampMs } from '../../utils/time';
import { Icon } from '../icons';

type PresentationReveal = '' | NonNullable<ExecutorPresentation['reveal']>;
type PresentationPanel = '' | NonNullable<ExecutorPresentation['panel']>;
type PresentationRevealProblems = '' | NonNullable<ExecutorPresentation['revealProblems']>;

type PluginReloadMode = 'input' | 'command';

/** plugin 执行器三态动作（start/reload/stop）的表单草稿 */
type PluginActionsDraft = {
  startCommand: string;
  startArgsText: string;
  reloadMode: PluginReloadMode;
  reloadInput: string;
  reloadCommand: string;
  reloadArgsText: string;
  stopCommand: string;
  stopArgsText: string;
};

type ExecutorDraft = {
  id: number | null;
  label: string;
  type: ExecutorType;
  command: string;
  argsText: string;
  cwd: string;
  envText: string;
  groupKind: string;
  groupDefault: boolean;
  dependsOnText: string;
  dependsOrder: ExecutorDependsOrder;
  presentationReveal: PresentationReveal;
  presentationPanel: PresentationPanel;
  presentationRevealProblems: PresentationRevealProblems;
  presentationEcho: boolean;
  presentationFocus: boolean;
  presentationShowReuseMessage: boolean;
  presentationClear: boolean;
  presentationClose: boolean;
  problemMatcherText: string;
  enabled: boolean;
  sortOrder: string;
  actions: PluginActionsDraft;
};

type ArgObject = { value: string; quoting?: 'escape' | 'strong' | 'weak' };
type ArgQuoting = NonNullable<ArgObject['quoting']>;

export function ExecutorEditorModal({
  projectId,
  executor,
  executors,
  onClose,
  onSync,
  onExecutorIdChange,
}: {
  projectId: number;
  executor: Executor | null;
  executors: Executor[];
  onClose: () => void;
  onSync: (snapshot: AppSnapshot) => void;
  onExecutorIdChange: (executorId: number | null) => void;
}) {
  const [draft, setDraft] = useState<ExecutorDraft>(() => createExecutorDraft(executor, executors));
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [logHidden, setLogHidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showOptionalActions, setShowOptionalActions] = useState(false);
  const [showAdvancedSettings, setShowAdvancedSettings] = useState(false);
  const [pluginAction, setPluginAction] = useState<'start' | 'reload' | 'stop' | null>(null);

  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const labelRef = useRef<HTMLInputElement>(null);

  const isNew = draft.id == null;
  const liveStatus = executor?.lastStatus ?? executor?.last_status ?? null;
  const liveExitCode = executor?.lastExitCode ?? executor?.last_exit_code ?? null;
  const liveDuration = executor?.lastDurationMs ?? executor?.last_duration_ms ?? null;
  const liveLog = logHidden ? '' : executor?.lastLog ?? executor?.last_log ?? '';
  const isPluginMode = draft.type === 'plugin';
  const isLegacyExecutor = !isPluginMode;
  const startCommandPreview = draft.actions.startCommand.trim() || draft.command.trim();
  const optionalActionCount = Number(Boolean(draft.actions.reloadInput.trim() || draft.actions.reloadCommand.trim()))
    + Number(Boolean(draft.actions.stopCommand.trim()));
  const liveRunning = Boolean(
    executor?.running
      || executor?.runStatus === 'running'
      || liveStatus === 'running'
      || executor?.pluginState?.running,
  );
  const savedEnabled = executor ? Boolean(executor.enabled) : draft.enabled;
  const cwdPreview = draft.cwd.trim() || '${workspace}';
  const canRun = !isNew && draft.enabled && savedEnabled && !running && !liveRunning;
  const canStop = !isNew && (running || liveRunning) && !stopping;
  const pluginActionBusy = pluginAction !== null;
  const canPluginStart = !isNew && draft.enabled && savedEnabled && !liveRunning && !pluginActionBusy;
  const canPluginReload = !isNew && liveRunning && !pluginActionBusy;
  const canPluginStop = !isNew && liveRunning && !pluginActionBusy;

  useEffect(() => {
    if (isNew) labelRef.current?.focus();
    else dialogRef.current?.focus();
  }, []);

  useEffect(() => {
    setLogHidden(false);
  }, [executor?.id, executor?.lastLog, executor?.last_log]);

  // plugin 运行期间轮询快照，实时刷新输出日志面板（lastLog 由 runner 在退出/状态更新时回写）
  const syncRef = useRef(onSync);
  syncRef.current = onSync;
  useEffect(() => {
    if (executor?.type !== 'plugin' || !liveRunning) return;
    const timer = window.setInterval(() => {
      window.autoplan.snapshot(projectId).then((snapshot) => syncRef.current(snapshot)).catch(() => {});
    }, 2000);
    return () => window.clearInterval(timer);
  }, [executor?.type, liveRunning, projectId]);

  function patchDraft(patch: Partial<ExecutorDraft>) {
    setDraft((current) => ({ ...current, ...patch }));
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onClose();
    }
  }

  async function handleSave() {
    let payload: ExecutorInput;
    try {
      payload = executorInputFromDraft(projectId, draft);
    } catch (e) {
      setError(getErrorMessage(e, '执行器配置无效'));
      return;
    }

    setSaving(true);
    setError(null);
    try {
      if (draft.id == null) {
        const existingIds = new Set(executors.map((item) => item.id));
        const snapshot = await window.autoplan.createExecutor(payload);
        onSync(snapshot);
        const created = pickNewlyCreatedExecutor(snapshot, projectId, existingIds, payload.label);
        if (created) {
          patchDraft({ id: created.id });
          onExecutorIdChange(created.id);
        }
      } else {
        const snapshot = await window.autoplan.updateExecutor({ ...payload, executorId: draft.id });
        onSync(snapshot);
      }
    } catch (e) {
      setError(getErrorMessage(e, '保存执行器失败'));
    } finally {
      setSaving(false);
    }
  }

  async function handleRun() {
    if (draft.id == null) {
      setError('请先保存执行器后再运行');
      return;
    }
    if (!draft.enabled || !savedEnabled) {
      setError('执行器已禁用，启用并保存后才能运行');
      return;
    }
    if (running || liveRunning) return;
    setRunning(true);
    setError(null);
    setLogHidden(false);
    try {
      const result = await window.autoplan.runExecutor({ projectId, executorId: draft.id });
      onSync(result.snapshot);
      if (result.error) setError(result.error);
      else if (result.status === 'bad') setError(`执行失败，退出码 ${result.exitCode ?? 1}`);
    } catch (e) {
      setError(getErrorMessage(e, '运行执行器失败'));
    } finally {
      setRunning(false);
    }
  }

  async function handleStop() {
    if (draft.id == null || stopping) return;
    setStopping(true);
    try {
      const snapshot = await window.autoplan.stopExecutor({ projectId, executorId: draft.id });
      onSync(snapshot);
      setError(null);
    } catch (e) {
      setError(getErrorMessage(e, '停止执行器失败'));
    } finally {
      setStopping(false);
    }
  }

  async function handlePluginAction(action: 'start' | 'reload' | 'stop') {
    if (draft.id == null) {
      setError('请先保存执行器后再操作');
      return;
    }
    if (action === 'start' && (!draft.enabled || !savedEnabled)) {
      setError('执行器已禁用，启用并保存后才能启动');
      return;
    }
    setPluginAction(action);
    setError(null);
    setLogHidden(false);
    try {
      const result = await window.autoplan.runExecutorAction({ projectId, executorId: draft.id, action });
      onSync(result.snapshot);
      if (result.error) setError(result.error);
    } catch (e) {
      setError(getErrorMessage(e, '插件动作执行失败'));
    } finally {
      setPluginAction(null);
    }
  }

  const handlePluginStart = () => handlePluginAction('start');
  const handlePluginReload = () => handlePluginAction('reload');
  const handlePluginStop = () => handlePluginAction('stop');

  async function handleDelete() {
    if (draft.id == null) return;
    if (!window.confirm(`确认删除执行器「${draft.label || '未命名执行器'}」？此操作不可撤销。`)) return;
    try {
      const snapshot = await window.autoplan.deleteExecutor({ projectId, executorId: draft.id });
      onSync(snapshot);
      onClose();
    } catch (e) {
      setError(getErrorMessage(e, '删除执行器失败'));
    }
  }

  const exitTone = liveStatus === 'ok' ? 'rc-ok' : liveStatus === 'bad' ? 'rc-bad' : '';

  return (
    <div className="modal-mask" onClick={onClose}>
      <div
        ref={dialogRef}
        className="modal script-editor-modal executor-editor-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <div className="modal-head script-modal-head">
          <span className="mh-ico">
            <Icon name="executor" size={22} aria-hidden="true" />
          </span>
          <div className="mh-title-wrap">
            <div className="mh-title" id={titleId}>
              <input
                ref={labelRef}
                className="mh-title-input"
                value={draft.label}
                placeholder="请输入执行器标签…"
                maxLength={160}
                aria-label="执行器标签"
                onChange={(event) => patchDraft({ label: event.target.value })}
              />
              <span className={`chip ${draft.enabled ? 'chip-completed' : 'chip-pending'}`}>
                {isNew ? '新建' : draft.enabled ? '已启用' : '已禁用'}
              </span>
            </div>
            <div className="mh-sub">
              <span>{startCommandPreview || '未设置启动命令'}</span>
              <span className="mh-sub-dot">·</span>
              <span>{isLegacyExecutor ? '旧版执行器' : '插件接入'}</span>
              <span className="mh-sub-dot">·</span>
              <span>{cwdPreview}</span>
            </div>
          </div>
          <div className="mh-actions">
            <div className="mh-toggle-group">
              <span>启用</span>
              <button
                type="button"
                className={`toggle sm sc-toggle${draft.enabled ? ' on' : ''}`}
                aria-pressed={draft.enabled}
                aria-label={draft.enabled ? '禁用执行器' : '启用执行器'}
                onClick={() => patchDraft({ enabled: !draft.enabled })}
              />
            </div>
            <button type="button" className="icon-btn danger" title="删除执行器" onClick={handleDelete} disabled={isNew} aria-label="删除执行器">
              <Icon name="trash" size={16} aria-hidden="true" />
            </button>
            <button type="button" className="modal-close" onClick={onClose} aria-label="关闭">
              <Icon name="close" size={18} aria-hidden="true" />
            </button>
          </div>
        </div>

        <div className="modal-body script-modal-body">
          <div className="dlg-layout">
            <div className="dlg-left">
              {isLegacyExecutor ? (
                <section className="cfg-card">
                <div className="cfg-title"><Icon name="executor" size={15} aria-hidden="true" />旧版执行器</div>
                <div className="cfg-body">
                  <div className="field">
                    <label>类型</label>
                    <input value={draft.type} disabled />
                    <span className="field-hint">旧版 shell/process 配置仅保留兼容编辑；新建接入统一使用插件形式。</span>
                  </div>
                  <div className="field">
                    <label>命令</label>
                    <input
                      className="mono"
                      value={draft.command}
                      placeholder={draft.type === 'plugin' ? '由启动命令推导，可留空' : 'npm'}
                      spellCheck={false}
                      onChange={(event) => patchDraft({ command: event.target.value })}
                    />
                    {draft.type === 'plugin' ? (
                      <span className="field-hint">plugin 类型以「启动命令」为准，此处可留空。</span>
                    ) : null}
                  </div>
                  <div className="field">
                    <label>参数</label>
                    <textarea
                      className="mono"
                      rows={5}
                      value={draft.argsText}
                      placeholder={'run\nbuild'}
                      spellCheck={false}
                      onChange={(event) => patchDraft({ argsText: event.target.value })}
                    />
                    <span className="field-hint">每行一个参数；也可填写 JSON 数组以保留 quoting。</span>
                  </div>
                </div>
                </section>
              ) : (
                <section className="cfg-card plugin-actions-config">
                  <div className="cfg-title">
                    <Icon name="plug" size={15} aria-hidden="true" />
                    插件接入
                  </div>
                  <div className="cfg-body">
                    <div className="plugin-action-block">
                      <div className="plugin-action-head">
                        <span className="plugin-action-name">启动命令</span>
                        <span className="plugin-action-hint">必填 · flutter / npm run dev</span>
                      </div>
                      <div className="field">
                        <label>命令</label>
                        <input
                          className="mono"
                          value={draft.actions.startCommand}
                          placeholder="flutter"
                          spellCheck={false}
                          onChange={(event) => patchDraft({ actions: { ...draft.actions, startCommand: event.target.value } })}
                        />
                      </div>
                      <div className="field">
                        <label>参数</label>
                        <textarea
                          className="mono"
                          rows={3}
                          value={draft.actions.startArgsText}
                          placeholder={'run'}
                          spellCheck={false}
                          onChange={(event) => patchDraft({ actions: { ...draft.actions, startArgsText: event.target.value } })}
                        />
                        <span className="field-hint">每行一个参数；也可填 JSON 数组。</span>
                      </div>
                    </div>

                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => setShowOptionalActions((value) => !value)}
                    >
                      <Icon name="sliders" size={14} aria-hidden="true" />
                      {showOptionalActions ? '收起可选动作' : `可选动作${optionalActionCount ? `（${optionalActionCount}）` : ''}`}
                    </button>

                    {showOptionalActions ? (
                      <>
                    <div className="plugin-action-block">
                      <div className="plugin-action-head">
                        <span className="plugin-action-name">热刷新（reload）</span>
                        <span className="plugin-action-hint">可选 · 热刷新时向运行中的进程发送此输入</span>
                      </div>
                      <div className="field">
                        <label>方式</label>
                        <div className="segment">
                          <button
                            type="button"
                            className={draft.actions.reloadMode === 'input' ? 'active' : ''}
                            onClick={() => patchDraft({ actions: { ...draft.actions, reloadMode: 'input' } })}
                          >
                            发送输入文本
                          </button>
                          <button
                            type="button"
                            className={draft.actions.reloadMode === 'command' ? 'active' : ''}
                            onClick={() => patchDraft({ actions: { ...draft.actions, reloadMode: 'command' } })}
                          >
                            执行命令
                          </button>
                        </div>
                      </div>
                      {draft.actions.reloadMode === 'input' ? (
                        <div className="field">
                          <label>输入文本</label>
                          <input
                            className="mono"
                            value={draft.actions.reloadInput}
                            placeholder="r"
                            spellCheck={false}
                            onChange={(event) => patchDraft({ actions: { ...draft.actions, reloadInput: event.target.value } })}
                          />
                          <span className="field-hint">如 Flutter 热刷新发送 r。</span>
                        </div>
                      ) : (
                        <>
                          <div className="field">
                            <label>命令</label>
                            <input
                              className="mono"
                              value={draft.actions.reloadCommand}
                              placeholder="curl"
                              spellCheck={false}
                              onChange={(event) => patchDraft({ actions: { ...draft.actions, reloadCommand: event.target.value } })}
                            />
                          </div>
                          <div className="field">
                            <label>参数</label>
                            <textarea
                              className="mono"
                              rows={3}
                              value={draft.actions.reloadArgsText}
                              placeholder={'-X POST http://localhost:3000/reload'}
                              spellCheck={false}
                              onChange={(event) => patchDraft({ actions: { ...draft.actions, reloadArgsText: event.target.value } })}
                            />
                          </div>
                        </>
                      )}
                    </div>

                    <div className="plugin-action-block">
                      <div className="plugin-action-head">
                        <span className="plugin-action-name">停止命令（stop）</span>
                        <span className="plugin-action-hint">可选 · 留空使用默认信号终止</span>
                      </div>
                      <div className="field">
                        <label>命令</label>
                        <input
                          className="mono"
                          value={draft.actions.stopCommand}
                          placeholder="kill"
                          spellCheck={false}
                          onChange={(event) => patchDraft({ actions: { ...draft.actions, stopCommand: event.target.value } })}
                        />
                      </div>
                      <div className="field">
                        <label>参数</label>
                        <textarea
                          className="mono"
                          rows={3}
                          value={draft.actions.stopArgsText}
                          placeholder={'$PID'}
                          spellCheck={false}
                          onChange={(event) => patchDraft({ actions: { ...draft.actions, stopArgsText: event.target.value } })}
                        />
                      </div>
                    </div>
                      </>
                    ) : null}
                  </div>
                </section>
              )}

              <section className="cfg-card">
                <div className="cfg-title"><Icon name="folder" size={15} aria-hidden="true" />工作区</div>
                <div className="cfg-body">
                  <div className="field">
                    <label>工作目录</label>
                    <input
                      className="mono"
                      value={draft.cwd}
                      placeholder="${workspace}"
                      spellCheck={false}
                      onChange={(event) => patchDraft({ cwd: event.target.value })}
                    />
                    <span className="field-hint">留空使用项目工作区；相对路径会按工作区解析。</span>
                  </div>
                  <div className="field">
                    <label>环境变量</label>
                    <textarea
                      className="mono"
                      rows={5}
                      value={draft.envText}
                      placeholder={'NODE_ENV=production\nCI=1'}
                      spellCheck={false}
                      onChange={(event) => patchDraft({ envText: event.target.value })}
                    />
                    <span className="field-hint">一行一个 <code>KEY=VALUE</code>，空行会被忽略。</span>
                  </div>
                </div>
              </section>

              <section className="log-card">
                <div className="log-head">
                  <div className="lh-title">
                    <Icon name="terminal" size={15} aria-hidden="true" />
                    最近输出
                  </div>
                  <div className="log-head-actions">
                    <button
                      type="button"
                      className="icon-btn"
                      title="清空显示"
                      onClick={() => setLogHidden(true)}
                      disabled={!liveLog}
                      aria-label="清空显示"
                    >
                      <Icon name="close" size={14} aria-hidden="true" />
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
                    <div className="log-empty">暂无运行输出。</div>
                  )}
                </div>
              </section>
            </div>

            <div className="config-panel">
              <section className="cfg-card">
                <div className="cfg-title"><Icon name="sliders" size={15} aria-hidden="true" />分组</div>
                <div className="cfg-body">
                  <div className="field">
                    <label>组</label>
                    <input
                      value={draft.groupKind}
                      placeholder="build / test / custom"
                      onChange={(event) => patchDraft({ groupKind: event.target.value })}
                    />
                  </div>
                  <ToggleField
                    checked={draft.groupDefault}
                    label="作为该组默认任务"
                    onChange={() => patchDraft({ groupDefault: !draft.groupDefault })}
                  />
                  <div className="field">
                    <label>排序值</label>
                    <input
                      className="mono"
                      inputMode="numeric"
                      value={draft.sortOrder}
                      onChange={(event) => patchDraft({ sortOrder: event.target.value })}
                    />
                  </div>
                </div>
              </section>

              <button
                type="button"
                className="btn btn-sm"
                onClick={() => setShowAdvancedSettings((value) => !value)}
              >
                <Icon name="sliders" size={14} aria-hidden="true" />
                {showAdvancedSettings ? '收起高级配置' : '高级配置'}
              </button>

              {showAdvancedSettings ? (
                <>
              <section className="cfg-card">
                <div className="cfg-title"><Icon name="inject" size={15} aria-hidden="true" />依赖</div>
                <div className="cfg-body">
                  <div className="field">
                    <label>dependsOn</label>
                    <textarea
                      className="mono"
                      rows={4}
                      value={draft.dependsOnText}
                      placeholder="build"
                      spellCheck={false}
                      onChange={(event) => patchDraft({ dependsOnText: event.target.value })}
                    />
                    <span className="field-hint">每行一个执行器标签；也可填写 JSON 字符串或数组。</span>
                  </div>
                  <div className="field">
                    <label>dependsOrder</label>
                    <div className="segment">
                      <button
                        type="button"
                        className={draft.dependsOrder === 'parallel' ? 'active' : ''}
                        onClick={() => patchDraft({ dependsOrder: 'parallel' })}
                      >
                        parallel
                      </button>
                      <button
                        type="button"
                        className={draft.dependsOrder === 'sequence' ? 'active' : ''}
                        onClick={() => patchDraft({ dependsOrder: 'sequence' })}
                      >
                        sequence
                      </button>
                    </div>
                  </div>
                </div>
              </section>

              <section className="cfg-card">
                <div className="cfg-title"><Icon name="eye" size={15} aria-hidden="true" />presentation</div>
                <div className="cfg-body">
                  <SelectField
                    label="reveal"
                    value={draft.presentationReveal}
                    options={['', 'always', 'silent', 'never']}
                    onChange={(value) => patchDraft({ presentationReveal: value as PresentationReveal })}
                  />
                  <SelectField
                    label="panel"
                    value={draft.presentationPanel}
                    options={['', 'shared', 'dedicated', 'new']}
                    onChange={(value) => patchDraft({ presentationPanel: value as PresentationPanel })}
                  />
                  <SelectField
                    label="revealProblems"
                    value={draft.presentationRevealProblems}
                    options={['', 'never', 'onProblem', 'always']}
                    onChange={(value) => patchDraft({ presentationRevealProblems: value as PresentationRevealProblems })}
                  />
                  <ToggleField checked={draft.presentationEcho} label="echo" onChange={() => patchDraft({ presentationEcho: !draft.presentationEcho })} />
                  <ToggleField checked={draft.presentationFocus} label="focus" onChange={() => patchDraft({ presentationFocus: !draft.presentationFocus })} />
                  <ToggleField checked={draft.presentationShowReuseMessage} label="showReuseMessage" onChange={() => patchDraft({ presentationShowReuseMessage: !draft.presentationShowReuseMessage })} />
                  <ToggleField checked={draft.presentationClear} label="clear" onChange={() => patchDraft({ presentationClear: !draft.presentationClear })} />
                  <ToggleField checked={draft.presentationClose} label="close" onChange={() => patchDraft({ presentationClose: !draft.presentationClose })} />
                </div>
              </section>

              <section className="cfg-card">
                <div className="cfg-title"><Icon name="warning" size={15} aria-hidden="true" />problemMatcher</div>
                <div className="cfg-body">
                  <div className="field">
                    <label>problemMatcher</label>
                    <textarea
                      className="mono"
                      rows={5}
                      value={draft.problemMatcherText}
                      placeholder="$tsc"
                      spellCheck={false}
                      onChange={(event) => patchDraft({ problemMatcherText: event.target.value })}
                    />
                    <span className="field-hint">可填写字符串、多行字符串列表，或 JSON 对象/数组。</span>
                  </div>
                </div>
              </section>
                </>
              ) : null}
            </div>
          </div>
        </div>

        <div className="modal-foot script-modal-foot">
          <div className="mf-info">
            <span>退出码 <b className={exitTone}>{isNew || liveExitCode === null ? '—' : String(liveExitCode)}</b></span>
            <span>耗时 <b>{formatDurationShort(liveDuration) || '—'}</b></span>
            <span>最近运行 <b>{formatRelativeTime(executor?.lastRunAt ?? executor?.last_run_at) || '未运行'}</b></span>
          </div>
          {error ? <span className="mf-error" role="alert">{error}</span> : null}
          <div className="mf-actions">
            <button type="button" className="btn" onClick={onClose}>关闭</button>
            <button type="button" className="btn btn-primary" onClick={handleSave} disabled={saving}>
              <Icon name="save" size={14} aria-hidden="true" />{saving ? '保存中…' : isNew ? '创建' : '保存'}
            </button>
            {isPluginMode ? (
              <>
                <button type="button" className="btn" onClick={handlePluginStop} disabled={!canPluginStop}>
                  <Icon name="stop" size={14} aria-hidden="true" />{pluginAction === 'stop' ? '停止中…' : '停止'}
                </button>
                <button type="button" className="btn" onClick={handlePluginReload} disabled={!canPluginReload}>
                  <Icon name="refresh" size={14} aria-hidden="true" />{pluginAction === 'reload' ? '刷新中…' : '热刷新'}
                </button>
                <button type="button" className="btn btn-success" onClick={handlePluginStart} disabled={!canPluginStart}>
                  <Icon name="play" size={14} aria-hidden="true" />{liveRunning ? '运行中…' : '启动'}
                </button>
              </>
            ) : (
              <>
                <button type="button" className="btn" onClick={handleStop} disabled={!canStop}>
                  <Icon name="stop" size={14} aria-hidden="true" />{stopping ? '停止中…' : '停止'}
                </button>
                <button type="button" className="btn btn-success" onClick={handleRun} disabled={!canRun}>
                  <Icon name="play" size={14} aria-hidden="true" />{running || liveRunning ? '运行中…' : '运行'}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function ToggleField({ checked, label, onChange }: { checked: boolean; label: string; onChange: () => void }) {
  return (
    <div className="field">
      <div className="fail-control">
        <button
          type="button"
          className={`toggle sm sc-toggle${checked ? ' on' : ''}`}
          aria-pressed={checked}
          aria-label={label}
          onClick={onChange}
        />
        <span className="ft-text">{label}</span>
      </div>
    </div>
  );
}

function SelectField({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (value: string) => void;
}) {
  return (
    <div className="field">
      <label>{label}</label>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map((option) => (
          <option key={option || 'default'} value={option}>
            {option || '默认'}
          </option>
        ))}
      </select>
    </div>
  );
}

function createExecutorDraft(executor: Executor | null, executors: Executor[]): ExecutorDraft {
  const presentation = executor?.presentation || {};
  const groupKind = executor?.group?.kind ?? executor?.group_kind ?? '';
  return {
    id: executor?.id ?? null,
    label: executor?.label ?? '',
    type: executor?.type ?? 'plugin',
    command: executor?.command ?? '',
    argsText: formatArgs(executor?.args ?? []),
    cwd: executor?.options?.cwd ?? '',
    envText: formatEnv(executor?.options?.env ?? {}),
    groupKind: groupKind || '',
    groupDefault: Boolean(executor?.group?.isDefault ?? executor?.group_is_default ?? false),
    dependsOnText: formatDependsOn(executor?.dependsOn ?? []),
    dependsOrder: executor?.dependsOrder ?? executor?.depends_order ?? 'parallel',
    presentationReveal: presentation.reveal ?? '',
    presentationPanel: presentation.panel ?? '',
    presentationRevealProblems: presentation.revealProblems ?? '',
    presentationEcho: Boolean(presentation.echo),
    presentationFocus: Boolean(presentation.focus),
    presentationShowReuseMessage: Boolean(presentation.showReuseMessage),
    presentationClear: Boolean(presentation.clear),
    presentationClose: Boolean(presentation.close),
    problemMatcherText: formatProblemMatcher(executor?.problemMatcher ?? null),
    enabled: executor ? Boolean(executor.enabled) : true,
    sortOrder: String(executor?.sortOrder ?? executor?.sort_order ?? nextSortOrder(executors)),
    actions: pluginActionsFromExecutor(executor),
  };
}

function executorInputFromDraft(projectId: number, draft: ExecutorDraft): ExecutorInput {
  const label = draft.label.trim();
  if (!label) throw new Error('执行器标签不能为空');

  const isPlugin = draft.type === 'plugin';
  const startCommand = isPlugin ? draft.actions.startCommand.trim() : '';
  if (isPlugin && !startCommand) throw new Error('plugin 启动命令不能为空');
  // plugin：顶层 command 由启动命令推导（留空时后端亦会从 actions.start 推导）
  const command = isPlugin ? (draft.command.trim() || startCommand) : draft.command.trim();
  if (!isPlugin && !command) throw new Error('命令不能为空');

  const input: ExecutorInput = {
    projectId,
    label,
    type: draft.type,
    command,
    args: isPlugin ? parseArgsText(draft.actions.startArgsText) : parseArgsText(draft.argsText),
    options: {
      cwd: draft.cwd.trim(),
      env: parseEnvText(draft.envText),
    },
    group: {
      kind: draft.groupKind.trim() || null,
      isDefault: draft.groupDefault,
    },
    dependsOn: parseDependsOnText(draft.dependsOnText),
    dependsOrder: draft.dependsOrder,
    presentation: buildPresentation(draft),
    problemMatcher: parseProblemMatcherText(draft.problemMatcherText),
    enabled: draft.enabled,
    sortOrder: parseInteger(draft.sortOrder, '排序值'),
  };
  if (isPlugin) input.actions = buildActionsFromDraft(draft);
  return input;
}

function buildPresentation(draft: ExecutorDraft): ExecutorPresentation {
  const presentation: ExecutorPresentation = {
    echo: draft.presentationEcho,
    focus: draft.presentationFocus,
    showReuseMessage: draft.presentationShowReuseMessage,
    clear: draft.presentationClear,
    close: draft.presentationClose,
  };
  if (draft.presentationReveal) presentation.reveal = draft.presentationReveal;
  if (draft.presentationPanel) presentation.panel = draft.presentationPanel;
  if (draft.presentationRevealProblems) presentation.revealProblems = draft.presentationRevealProblems;
  return presentation;
}

function emptyPluginActionsDraft(): PluginActionsDraft {
  return {
    startCommand: '',
    startArgsText: '',
    reloadMode: 'input',
    reloadInput: '',
    reloadCommand: '',
    reloadArgsText: '',
    stopCommand: '',
    stopArgsText: '',
  };
}

/** 编辑已有 plugin 执行器时，从 executor.actions 还原表单草稿 */
function pluginActionsFromExecutor(executor: Executor | null): PluginActionsDraft {
  const draft = emptyPluginActionsDraft();
  const actions = executor?.actions;
  if (!actions) {
    draft.startCommand = executor?.command ?? '';
    draft.startArgsText = formatArgs(executor?.args ?? []);
    return draft;
  }
  if (actions.start) {
    draft.startCommand = String(actions.start.command ?? '');
    draft.startArgsText = formatArgs(actions.start.args ?? []);
  }
  if (actions.reload) {
    if (actions.reload.type === 'input') {
      draft.reloadMode = 'input';
      draft.reloadInput = String(actions.reload.input ?? '');
    } else {
      draft.reloadMode = 'command';
      draft.reloadCommand = String(actions.reload.command ?? '');
      draft.reloadArgsText = formatArgs(actions.reload.args ?? []);
    }
  }
  if (actions.stop) {
    draft.stopCommand = String(actions.stop.command ?? '');
    draft.stopArgsText = formatArgs(actions.stop.args ?? []);
  }
  return draft;
}

/** 保存时由草稿构造 plugin actions；start 必填，reload/stop 可选 */
function buildActionsFromDraft(draft: ExecutorDraft): ExecutorActions {
  const actions: ExecutorActions = {};
  const startCommand = draft.actions.startCommand.trim();
  if (!startCommand) throw new Error('plugin 启动命令不能为空');
  actions.start = {
    type: 'command',
    command: startCommand,
    args: parseArgsText(draft.actions.startArgsText),
  };
  if (draft.actions.reloadMode === 'input') {
    const input = draft.actions.reloadInput.trim();
    if (input) actions.reload = { type: 'input', input };
  } else {
    const reloadCommand = draft.actions.reloadCommand.trim();
    if (reloadCommand) {
      actions.reload = {
        type: 'command',
        command: reloadCommand,
        args: parseArgsText(draft.actions.reloadArgsText),
      };
    }
  }
  const stopCommand = draft.actions.stopCommand.trim();
  if (stopCommand) {
    actions.stop = {
      type: 'command',
      command: stopCommand,
      args: parseArgsText(draft.actions.stopArgsText),
    };
  }
  return actions;
}

function parseArgsText(text: string): ExecutorArg[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[')) {
    const parsed = parseJson(trimmed, '参数 JSON');
    if (!Array.isArray(parsed)) throw new Error('参数 JSON 必须是数组');
    return parsed.map((item, index) => normalizeArgItem(item, index));
  }
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function normalizeArgItem(value: unknown, index: number): ExecutorArg {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (isRecord(value) && Object.prototype.hasOwnProperty.call(value, 'value')) {
    const arg: ArgObject = { value: String(value.value ?? '') };
    if (value.quoting !== undefined && value.quoting !== null && value.quoting !== '') {
      const quoting = String(value.quoting);
      if (!isArgQuoting(quoting)) throw new Error(`参数 ${index + 1} 的 quoting 仅支持 escape/strong/weak`);
      arg.quoting = quoting;
    }
    return arg;
  }
  throw new Error(`参数 ${index + 1} 仅支持字符串或 { value, quoting }`);
}

function parseEnvText(text: string) {
  const env: Record<string, string> = {};
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) throw new Error(`环境变量第 ${index + 1} 行必须是 KEY=VALUE`);
    const key = trimmed.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`环境变量名无效：${key}`);
    env[key] = trimmed.slice(eq + 1);
  });
  return env;
}

function parseDependsOnText(text: string) {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[') || trimmed.startsWith('"')) {
    const parsed = parseJson(trimmed, 'dependsOn JSON');
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return uniqueStrings(list.map((item) => String(item ?? '').trim()).filter(Boolean));
  }
  return uniqueStrings(text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
}

function parseProblemMatcherText(text: string): ExecutorProblemMatcher {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const parsed = parseJson(trimmed, 'problemMatcher JSON');
    if (typeof parsed === 'string' || Array.isArray(parsed) || isRecord(parsed)) {
      return parsed as ExecutorProblemMatcher;
    }
    throw new Error('problemMatcher JSON 必须是字符串、对象或数组');
  }
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.length <= 1 ? lines[0] : lines;
}

function parseInteger(value: string, label: string) {
  if (!value.trim()) return 0;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${label} 必须是数字`);
  return Math.floor(number);
}

function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${label} 格式无效`);
  }
}

function formatArgs(args: ExecutorArg[]) {
  if (!Array.isArray(args) || args.length === 0) return '';
  if (args.every((arg) => typeof arg === 'string')) return args.join('\n');
  return JSON.stringify(args, null, 2);
}

function formatEnv(env: Record<string, string>) {
  return Object.entries(env || {}).map(([key, value]) => `${key}=${String(value ?? '')}`).join('\n');
}

function formatDependsOn(dependsOn: string[]) {
  return Array.isArray(dependsOn) ? dependsOn.join('\n') : '';
}

function formatProblemMatcher(value: ExecutorProblemMatcher) {
  if (value === null || typeof value === 'undefined') return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) return value.join('\n');
  return JSON.stringify(value, null, 2);
}

function nextSortOrder(executors: Executor[]) {
  return executors.reduce((max, executor) => Math.max(max, executor.sortOrder ?? executor.sort_order ?? 0), 0) + 1;
}

function pickNewlyCreatedExecutor(snapshot: AppSnapshot, projectId: number, existingIds: Set<number>, label: string) {
  const candidates = (snapshot.executors || []).filter((item) => Number(item.projectId ?? item.project_id) === Number(projectId));
  const fresh = candidates.filter((item) => !existingIds.has(item.id));
  if (fresh.length > 0) return fresh.sort((a, b) => b.id - a.id)[0];
  return candidates.find((item) => item.label === label) || null;
}

function uniqueStrings(values: string[]) {
  return Array.from(new Set(values));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isArgQuoting(value: string): value is ArgQuoting {
  return value === 'escape' || value === 'strong' || value === 'weak';
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

function classifyLogLine(line: string) {
  const lower = line.toLowerCase();
  if (lower.includes('error') || lower.includes('failed') || lower.includes('失败')) return 'lvl-e';
  if (lower.includes('success') || lower.includes('ok') || lower.includes('完成')) return 'lvl-s';
  return 'lvl-i';
}

function getErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : String(error || fallback);
}
