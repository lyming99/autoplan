import { useState, type Dispatch, type FormEvent, type SetStateAction } from 'react';
import type { McpStatus } from '../../types';
import { useTheme, type ThemeMode } from '../../hooks/useTheme';
import {
  agentCliDefaultCommand,
  agentCliOptionDetails,
  codexReasoningOptionDetails,
  isCodexAgentCliProvider,
  normalizeCodexReasoningEffort,
  scopeFileOpenModeOptions,
  type LoopFormState,
  type McpConfigFormState,
  type ScopeFileOpenMode,
  type ScopeFileOpenSettings,
} from '../../utils/workspaceForms';
import { McpControlPanel, mcpStatusText, mcpStatusTone } from './McpControlPanel';

type SettingsPane = 'loop' | 'cli' | 'appearance' | 'scope' | 'mcp' | 'env';

const SETTINGS_NAV: Array<{ id: SettingsPane; label: string; hint: string; icon: string }> = [
  { id: 'loop', label: '循环控制', hint: '路径、间隔、验收命令', icon: 'loop' },
  { id: 'cli', label: 'CLI 后端', hint: 'Provider 与 Codex 深度', icon: 'cli' },
  { id: 'appearance', label: '外观', hint: '浅色 / 深色 / 跟随系统', icon: 'theme' },
  { id: 'scope', label: 'scope 文件', hint: '打开方式与编辑器命令', icon: 'scope' },
  { id: 'mcp', label: 'MCP 接入', hint: '服务状态与工具清单', icon: 'mcp' },
  { id: 'env', label: '环境变量', hint: '注入到脚本与 CLI 执行环境', icon: 'env' },
];

function scopeModeLabel(mode: ScopeFileOpenMode) {
  if (mode === 'folder') return '文件夹定位';
  if (mode === 'vscode') return 'VSCode';
  if (mode === 'command') return '第三方命令';
  return '系统默认';
}

function agentCliNavLabel(provider: string) {
  if (provider === 'claude') return 'Claude';
  if (provider === 'opencode') return 'OpenCode';
  if (provider === 'oh-my-pi') return 'Oh My Pi';
  return 'Codex';
}

function agentCliNonCodexHint(provider: string) {
  if (provider === 'opencode') return 'OpenCode CLI 不使用该配置';
  if (provider === 'oh-my-pi') return 'Oh My Pi CLI 不使用该配置';
  return 'Claude CLI 不使用该配置';
}

export function WorkspaceSettingsView({
  loopForm,
  mcpForm,
  scopeFileOpenSettings,
  setLoopForm,
  setMcpForm,
  setScopeFileOpenSettings,
  mcp,
  startMcp,
  stopMcp,
  saveMcpConfig,
  onSubmit,
  onToggleRun,
  running,
}: {
  loopForm: LoopFormState;
  mcpForm: McpConfigFormState;
  scopeFileOpenSettings: ScopeFileOpenSettings;
  setLoopForm: Dispatch<SetStateAction<LoopFormState>>;
  setMcpForm: (patch: Partial<McpConfigFormState>) => void;
  setScopeFileOpenSettings: Dispatch<SetStateAction<ScopeFileOpenSettings>>;
  mcp?: McpStatus | null;
  startMcp: () => void | Promise<void>;
  stopMcp: () => void | Promise<void>;
  saveMcpConfig: () => void | Promise<void>;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onToggleRun: () => void;
  running: boolean;
}) {
  const [activePane, setActivePane] = useState<SettingsPane>('loop');
  const isCodexProvider = isCodexAgentCliProvider(loopForm.agentCliProvider);
  const mcpStatus = mcpStatusText(mcp);
  const { theme, setTheme } = useTheme();

  const themeModeLabel = theme === 'light' ? '浅色' : theme === 'dark' ? '深色' : '跟随系统';

  const navMeta: Record<SettingsPane, { label: string; tone?: string }> = {
    loop: { label: running ? '运行中' : '已停止', tone: running ? 'ok' : '' },
    cli: { label: agentCliNavLabel(loopForm.agentCliProvider), tone: isCodexProvider ? 'ok' : '' },
    appearance: { label: themeModeLabel },
    scope: { label: scopeModeLabel(scopeFileOpenSettings.mode) },
    mcp: { label: mcpStatus, tone: mcpStatusTone(mcp) },
    env: { label: loopForm.envVars.length ? `${loopForm.envVars.length} 个` : '未配置' },
  };

  return (
    <div className="settings-layout settings-view">
      <nav className="settings-nav" aria-label="设置分组导航">
        <div className="settings-nav-label">Settings</div>
        {SETTINGS_NAV.map((item) => {
          const active = activePane === item.id;
          const meta = navMeta[item.id];
          return (
            <button
              key={item.id}
              type="button"
              className={`settings-nav-item${active ? ' active' : ''}`}
              aria-current={active ? 'page' : undefined}
              onClick={() => setActivePane(item.id)}
            >
              <span className={`snav-ico snav-ico-${item.icon}`} aria-hidden="true" />
              <span className="snav-text">
                <span>{item.label}</span>
                <small>{item.hint}</small>
              </span>
              <span className={`snav-meta${meta.tone ? ` ${meta.tone}` : ''}`}>{meta.label}</span>
            </button>
          );
        })}
      </nav>

      <div className="settings-content">
        <form className="settings-form" onSubmit={onSubmit}>
          {activePane === 'loop' ? (
            <section className="settings-pane active" aria-labelledby="settings-loop-title">
              <div className="pane-head">
                <h2 id="settings-loop-title"><span className="pane-ico" aria-hidden="true" />循环控制</h2>
                <p>配置工作区路径、轮询间隔和可选验收命令。启动状态不会影响保存配置。</p>
              </div>

              <div className="set-card">
                <div className="set-card-head">
                  <h3>基础配置</h3>
                  <div className="set-card-hint">工作区路径、轮询节奏与验收命令</div>
                </div>
                <div className="set-card-body">
                  <label className="field">
                    <span className="field-label">工作区路径 <span className="req">*</span></span>
                    <input
                      className="field-input mono"
                      value={loopForm.workspacePath}
                      onChange={(event) => setLoopForm((current) => ({ ...current, workspacePath: event.target.value }))}
                      placeholder="D:\project\GitHub\my-app"
                    />
                  </label>
                  <label className="field">
                    <span className="field-label">间隔秒数</span>
                    <div className="input-affix">
                      <input
                        className="field-input"
                        min="1"
                        type="number"
                        value={loopForm.intervalSeconds}
                        onChange={(event) => setLoopForm((current) => ({ ...current, intervalSeconds: event.target.value }))}
                      />
                      <span className="affix">秒</span>
                    </div>
                  </label>
                  <label className="field">
                    <span className="field-label">验收命令 <span className="tag">可选</span></span>
                    <input
                      className="field-input mono"
                      value={loopForm.validationCommand}
                      onChange={(event) => setLoopForm((current) => ({ ...current, validationCommand: event.target.value }))}
                      placeholder="留空则跳过外部验收命令"
                    />
                    <span className="field-hint">留空不会阻止需求、反馈、Plan 和任务流程继续运行。</span>
                  </label>
                </div>
              </div>

              <SettingsActions running={running} onToggleRun={onToggleRun} />
            </section>
          ) : null}

          {activePane === 'cli' ? (
            <section className="settings-pane active" aria-labelledby="settings-cli-title">
              <div className="pane-head">
                <h2 id="settings-cli-title"><span className="pane-ico" aria-hidden="true" />CLI 后端</h2>
                <p>选择执行任务时使用的 CLI 后端，并为 Codex 配置思考深度和命令路径。</p>
              </div>

              <div className="set-card">
                <div className="set-card-head">
                  <h3>后端与命令</h3>
                  <div className="set-card-hint">Codex / Claude / OpenCode / Oh My Pi Provider、思考深度与可执行命令</div>
                </div>
                <div className="set-card-body">
                  <label className="field">
                    <span className="field-label">CLI 后端</span>
                    <div className="segmented" role="radiogroup" aria-label="CLI 后端">
                      {agentCliOptionDetails.map((option) => {
                        const active = loopForm.agentCliProvider === option.value;
                        return (
                          <button
                            key={option.value}
                            type="button"
                            className={`seg-opt${active ? ' active' : ''}`}
                            aria-pressed={active}
                            onClick={() => setLoopForm((current) => ({ ...current, agentCliProvider: option.value }))}
                          >
                            <span>{option.label}</span>
                            <span className="seg-note">{option.description}</span>
                          </button>
                        );
                      })}
                    </div>
                    {loopForm.agentCliProvider === 'claude' ? (
                      <span className="field-hint">需本机已安装 claude CLI 并完成认证。</span>
                    ) : null}
                    {loopForm.agentCliProvider === 'opencode' ? (
                      <span className="field-hint">需本机已安装 opencode CLI 并完成认证，默认命令为 opencode。</span>
                    ) : null}
                    {loopForm.agentCliProvider === 'oh-my-pi' ? (
                      <span className="field-hint">需本机已安装 omp CLI 并完成认证，默认命令为 omp。</span>
                    ) : null}
                  </label>
                  {isCodexProvider ? (
                    <div className="field">
                      <span className="field-label">Codex 思考深度</span>
                      <div className="effort-grid" role="radiogroup" aria-label="Codex 思考深度">
                        {codexReasoningOptionDetails.map((option) => {
                          const active = loopForm.codexReasoningEffort === option.value;
                          return (
                            <button
                              key={option.value}
                              type="button"
                              className={`effort-opt${active ? ' active' : ''}`}
                              aria-pressed={active}
                              onClick={() =>
                                setLoopForm((current) => ({
                                  ...current,
                                  codexReasoningEffort: normalizeCodexReasoningEffort(option.value),
                                }))
                              }
                            >
                              <span className="eff-name"><span className="eff-dot" aria-hidden="true" />{option.label}</span>
                              <span className="eff-desc">{option.description}</span>
                            </button>
                          );
                        })}
                      </div>
                      <span className="field-hint">仅 Codex CLI 生效，保存后执行参数会使用该深度。</span>
                    </div>
                  ) : (
                    <div className="field readonly-field">
                      <span className="field-label">Codex 思考深度</span>
                      <span>{agentCliNonCodexHint(loopForm.agentCliProvider)}</span>
                    </div>
                  )}
                  <label className="field">
                    <span className="field-label">CLI 命令路径 <span className="tag">可选</span></span>
                    <input
                      className="field-input mono"
                      value={loopForm.agentCliCommand}
                      onChange={(event) => setLoopForm((current) => ({ ...current, agentCliCommand: event.target.value }))}
                      placeholder={agentCliDefaultCommand(loopForm.agentCliProvider)}
                    />
                    <span className="field-hint">后端在 PATH 中时留空即可，否则填写可执行文件完整路径。</span>
                  </label>
                </div>
              </div>

              <SettingsActions running={running} onToggleRun={onToggleRun} />
            </section>
          ) : null}

          {activePane === 'appearance' ? (
            <section className="settings-pane active" aria-labelledby="settings-appearance-title">
              <div className="pane-head">
                <h2 id="settings-appearance-title"><span className="pane-ico" aria-hidden="true" />外观</h2>
                <p>选择界面主题，切换即时生效并自动保存偏好。</p>
              </div>

              <div className="set-card">
                <div className="set-card-head">
                  <h3>主题模式</h3>
                  <div className="set-card-hint">浅色、深色或跟随操作系统设置</div>
                </div>
                <div className="set-card-body">
                  <label className="field">
                    <span className="field-label">主题</span>
                    <div className="segmented" role="radiogroup" aria-label="主题模式">
                      {([
                        { value: 'light' as ThemeMode, label: '浅色', desc: '始终使用浅色界面' },
                        { value: 'dark' as ThemeMode, label: '深色', desc: '始终使用深色界面' },
                        { value: 'auto' as ThemeMode, label: '跟随系统', desc: '根据操作系统设置自动切换' },
                      ] as const).map((option) => {
                        const active = theme === option.value;
                        return (
                          <button
                            key={option.value}
                            type="button"
                            className={`seg-opt${active ? ' active' : ''}`}
                            aria-pressed={active}
                            onClick={() => setTheme(option.value)}
                          >
                            <span>{option.label}</span>
                            <span className="seg-note">{option.desc}</span>
                          </button>
                        );
                      })}
                    </div>
                    <span className="field-hint">切换后即时生效，偏好自动保存到本地浏览器存储。</span>
                  </label>
                </div>
              </div>
            </section>
          ) : null}

          {activePane === 'scope' ? (
            <section className="settings-pane active" aria-labelledby="settings-scope-title">
              <div className="pane-head">
                <h2 id="settings-scope-title"><span className="pane-ico" aria-hidden="true" />scope 文件</h2>
                <p>Plan 全文中 scope 文件链接以该方式打开，路径会限制在当前工作区内。</p>
              </div>

              <div className="set-card">
                <div className="set-card-head">
                  <h3>打开方式</h3>
                  <div className="set-card-hint">系统默认、文件夹定位、VSCode 或第三方编辑器命令</div>
                </div>
                <div className="set-card-body">
                  <label className="field">
                    <span className="field-label">scope 文件打开方式</span>
                    <div className="segmented scope-segmented" role="radiogroup" aria-label="scope 文件打开方式">
                      {scopeFileOpenModeOptions.map((option) => {
                        const active = scopeFileOpenSettings.mode === option.value;
                        return (
                          <button
                            key={option.value}
                            type="button"
                            className={`seg-opt${active ? ' active' : ''}`}
                            aria-pressed={active}
                            onClick={() =>
                              setScopeFileOpenSettings((current) => ({
                                ...current,
                                mode: option.value as ScopeFileOpenMode,
                              }))
                            }
                          >
                            <span>{option.label}</span>
                            <span className="seg-note">{option.description}</span>
                          </button>
                        );
                      })}
                    </div>
                    <span className="field-hint">用于 Plan 全文中 scope 文件链接，路径会限制在当前工作区内。</span>
                  </label>
                  {scopeFileOpenSettings.mode === 'vscode' || scopeFileOpenSettings.mode === 'command' ? (
                    <label className="field">
                      <span className="field-label">编辑器命令 <span className="tag">可选</span></span>
                      <input
                        className="field-input mono"
                        value={scopeFileOpenSettings.command}
                        onChange={(event) => setScopeFileOpenSettings((current) => ({ ...current, command: event.target.value }))}
                        placeholder={scopeFileOpenSettings.mode === 'vscode' ? 'code' : '编辑器命令，例如 cursor'}
                      />
                      <span className="field-hint">留空选择 VSCode 时默认使用 <code>code</code>；第三方命令可用 <code>{'{file}'}</code> 占位。</span>
                    </label>
                  ) : null}
                  <div className="inline-banner info">
                    <span>无法判断影响范围时使用 <b>unknown</b>，完整验收任务使用 <b>validation</b>；打开前会校验目标路径位于当前工作区内。</span>
                  </div>
                </div>
              </div>

              <SettingsActions running={running} onToggleRun={onToggleRun} />
            </section>
          ) : null}

          {activePane === 'mcp' ? (
            <McpControlPanel
              mcp={mcp}
              mcpForm={mcpForm}
              setMcpForm={setMcpForm}
              startMcp={startMcp}
              stopMcp={stopMcp}
              saveMcpConfig={saveMcpConfig}
            />
          ) : null}

          {activePane === 'env' ? (
            <section className="settings-pane active" aria-labelledby="settings-env-title">
              <div className="pane-head">
                <h2 id="settings-env-title"><span className="pane-ico" aria-hidden="true" />环境变量</h2>
                <p>自定义键值对，注入到脚本（<code>runShell</code>）与 CLI 任务（<code>runCodex</code>）执行环境，优先于工作区派生变量但低于脚本 <code>AUTOPLAN_*</code> 内置变量。</p>
              </div>
              <div className="set-card">
                <div className="set-card-head">
                  <h3>键值对</h3>
                  <div className="set-card-hint">变量名仅允许字母/数字/下划线；重复名仅保留第一个。本地明文存储于 SQLite。</div>
                </div>
                <div className="set-card-body">
                  {loopForm.envVars.length === 0 ? (
                    <div className="empty-hint">尚未配置环境变量，点击下方「新增变量」添加。</div>
                  ) : (
                    loopForm.envVars.map((entry, i) => (
                      <div className="env-var-row" key={i}>
                        <input
                          className="field-input mono env-name"
                          type="text"
                          value={entry.name}
                          placeholder="MY_TOKEN"
                          spellCheck={false}
                          onChange={(event) =>
                            setLoopForm((current) => ({
                              ...current,
                              envVars: current.envVars.map((item, idx) =>
                                idx === i ? { ...item, name: event.target.value } : item,
                              ),
                            }))
                          }
                        />
                        <input
                          className="field-input mono env-value"
                          type="text"
                          value={entry.value}
                          placeholder="变量值"
                          spellCheck={false}
                          onChange={(event) =>
                            setLoopForm((current) => ({
                              ...current,
                              envVars: current.envVars.map((item, idx) =>
                                idx === i ? { ...item, value: event.target.value } : item,
                              ),
                            }))
                          }
                        />
                        <button
                          type="button"
                          className="btn-icon env-var-delete"
                          title="删除变量"
                          aria-label="删除变量"
                          onClick={() =>
                            setLoopForm((current) => ({
                              ...current,
                              envVars: current.envVars.filter((_, idx) => idx !== i),
                            }))
                          }
                        >
                          ×
                        </button>
                      </div>
                    ))
                  )}
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() =>
                      setLoopForm((current) => ({
                        ...current,
                        envVars: [...current.envVars, { name: '', value: '' }],
                      }))
                    }
                  >
                    新增变量
                  </button>
                  {loopForm.envVars.some((e) => !e.name.trim()) ? (
                    <span className="field-hint" style={{ color: 'var(--danger)' }}>⚠ 存在空变量名，保存时将被过滤。</span>
                  ) : null}
                </div>
              </div>
              <SettingsActions running={running} onToggleRun={onToggleRun} />
            </section>
          ) : null}
        </form>
      </div>
    </div>
  );
}

function SettingsActions({ running, onToggleRun }: { running: boolean; onToggleRun: () => void }) {
  return (
    <div className="settings-footer settings-actions">
      <span className="dirty-note">配置修改后请保存；运行状态可独立切换。</span>
      <div className="spacer">
        <button type="button" className="btn btn-sm" onClick={onToggleRun}>{running ? '停止' : '启动'}</button>
        <button type="submit" className="btn btn-sm btn-primary">保存配置</button>
      </div>
    </div>
  );
}
