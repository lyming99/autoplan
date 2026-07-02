import { useCallback, useEffect, useState, type Dispatch, type FormEvent, type SetStateAction } from 'react';
import { AUTOPLAN_RELEASES_URL, type AiConfig, type McpStatus } from '../../types';
import { useTheme, type ThemeMode } from '../../hooks/useTheme';
import { useUpdateStatus } from '../../hooks/useUpdateStatus';
import { formatChinaDateTime } from '../../utils/time';
import {
  agentCliDefaultCommand,
  aiConfigFormForProviderChange,
  aiConfigInputFromForm,
  agentCliOptionDetails,
  chatConfigFormsEqual,
  codexReasoningOptionDetails,
  createDefaultChatConfigForm,
  getErrorMessage,
  isCodexAgentCliProvider,
  maskApiKeyUtil,
  normalizeCodexReasoningEffort,
  scopeFileOpenModeOptions,
  aiProviderOptions,
  thinkingDepthOptions,
  defaultBaseUrlForProvider,
  defaultModelForProvider,
  providerSupportsThinkingDepth,
  providerSupportsThinkingBudget,
  type ChatConfigFormState,
  type LoopFormState,
  type McpConfigFormState,
  type ScopeFileOpenMode,
  type ScopeFileOpenSettings,
} from '../../utils/workspaceForms';
import { Icon } from '../icons';
import { Modal } from '../Modal';
import { McpControlPanel, mcpStatusText, mcpStatusTone } from './McpControlPanel';

type SettingsPane = 'loop' | 'cli' | 'appearance' | 'scope' | 'mcp' | 'ai' | 'env' | 'about';

const SETTINGS_NAV: Array<{ id: SettingsPane; label: string; hint: string; icon: string }> = [
  { id: 'loop', label: '循环控制', hint: '路径、间隔、验收命令', icon: 'loop' },
  { id: 'cli', label: 'CLI 后端', hint: 'Provider 与 Codex 深度', icon: 'cli' },
  { id: 'appearance', label: '外观', hint: '浅色 / 深色', icon: 'theme' },
  { id: 'scope', label: 'scope 文件', hint: '打开方式与编辑器命令', icon: 'scope' },
  { id: 'mcp', label: 'MCP 接入', hint: '服务状态与工具清单', icon: 'mcp' },
  { id: 'ai', label: 'AI 对话', hint: 'LLM 接口与模型配置', icon: 'ai' },
  { id: 'env', label: '环境变量', hint: '注入到脚本与 CLI 执行环境', icon: 'env' },
  { id: 'about', label: '关于/更新', hint: '版本与正式版更新检查', icon: 'about' },
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

function aiProviderLabel(provider: string) {
  if (provider === 'anthropic') return 'Anthropic';
  if (provider === 'deepseek') return 'DeepSeek';
  return 'OpenAI 兼容';
}

function aiProviderTone(provider: string) {
  if (provider === 'anthropic') return 'anthropic';
  if (provider === 'deepseek') return 'deepseek';
  return 'openai';
}

function aiThinkingLabel(config: AiConfig) {
  if (config.thinkingBudgetTokens != null) return `思考 ${config.thinkingBudgetTokens} tokens`;
  if (config.thinkingDepth === 'low') return '低思考';
  if (config.thinkingDepth === 'medium') return '中思考';
  if (config.thinkingDepth === 'high') return '高思考';
  return null;
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
  projectId: number;
}) {
  const [activePane, setActivePane] = useState<SettingsPane>('loop');
  const isCodexProvider = isCodexAgentCliProvider(loopForm.agentCliProvider);
  const mcpStatus = mcpStatusText(mcp);
  const { theme, setTheme } = useTheme();

  const themeModeLabel = theme === 'light' ? '浅色' : '深色';

  // Chat 配置表单（需求 #26）- 保留向后兼容
  const [chatConfigForm, setChatConfigForm] = useState<ChatConfigFormState>(() => createDefaultChatConfigForm());
  const [chatConfigSaved, setChatConfigSaved] = useState<ChatConfigFormState>(() => createDefaultChatConfigForm());
  const [hasExistingApiKey, setHasExistingApiKey] = useState(false);
  const [chatConfigSaving, setChatConfigSaving] = useState(false);

  // AI 配置多配置管理（需求 #28）
  const [aiConfigs, setAiConfigs] = useState<AiConfig[]>([]);
  const [editingConfigId, setEditingConfigId] = useState<number | null>(null);
  const [aiConfigForm, setAiConfigForm] = useState<ChatConfigFormState>(() => createDefaultChatConfigForm());
  const [aiConfigName, setAiConfigName] = useState('');
  const [aiConfigSaving, setAiConfigSaving] = useState(false);
  const [aiConfigError, setAiConfigError] = useState<string | null>(null);
  const loadChatConfig = useCallback(async () => {
    try {
      const cfg = await window.autoplan.chatGetConfig();
      const form = createDefaultChatConfigForm(cfg);
      setChatConfigForm(form);
      setChatConfigSaved(form);
      setHasExistingApiKey(cfg.hasApiKey);
    } catch {
      /* 取配置失败保持默认值 */
    }
  }, []);

  const loadAiConfigs = useCallback(async () => {
    try {
      const list = await window.autoplan.aiConfigList();
      setAiConfigs(list);
    } catch {
      /* 加载失败忽略 */
    }
  }, []);

  useEffect(() => {
    void loadChatConfig();
    void loadAiConfigs();
  }, [loadAiConfigs, loadChatConfig]);

  const chatConfigDirty = !chatConfigFormsEqual(chatConfigForm, chatConfigSaved, hasExistingApiKey);

  const saveChatConfig = useCallback(async () => {
    setChatConfigSaving(true);
    try {
      await window.autoplan.chatSaveConfig({
        provider: chatConfigForm.provider,
        baseUrl: chatConfigForm.baseUrl,
        apiKey: chatConfigForm.apiKey,
        model: chatConfigForm.model,
        temperature: chatConfigForm.temperature,
      });
      const cfg = await window.autoplan.chatGetConfig();
      const form = createDefaultChatConfigForm(cfg);
      setChatConfigForm(form);
      setChatConfigSaved(form);
      setHasExistingApiKey(cfg.hasApiKey);
      await loadAiConfigs();
    } catch {
      /* 保存失败保留草稿 */
    } finally {
      setChatConfigSaving(false);
    }
  }, [chatConfigForm, loadAiConfigs]);

  const startNewAiConfig = useCallback(() => {
    setEditingConfigId(0);
    setAiConfigName('');
    setAiConfigForm(createDefaultChatConfigForm());
    setAiConfigError(null);
  }, []);

  const startEditAiConfig = useCallback((cfg: AiConfig) => {
    setEditingConfigId(cfg.id);
    setAiConfigName(cfg.name);
    setAiConfigForm({
      provider: cfg.provider,
      baseUrl: cfg.baseUrl,
      apiKey: '',
      model: cfg.model,
      temperature: cfg.temperature,
      thinkingDepth: cfg.thinkingDepth || '',
      thinkingBudgetTokens: cfg.thinkingBudgetTokens != null ? String(cfg.thinkingBudgetTokens) : '',
    });
    setAiConfigError(null);
  }, []);

  const cancelEditAiConfig = useCallback(() => {
    setEditingConfigId(null);
    setAiConfigName('');
    setAiConfigForm(createDefaultChatConfigForm());
    setAiConfigError(null);
  }, []);

  const updateAiConfigForm = useCallback((patch: Partial<ChatConfigFormState>) => {
    setAiConfigError(null);
    setAiConfigForm((current) => ({ ...current, ...patch }));
  }, []);

  const saveAiConfig = useCallback(async () => {
    const name = aiConfigName.trim();
    if (!name) {
      setAiConfigError('配置名称不能为空');
      return;
    }
    setAiConfigSaving(true);
    setAiConfigError(null);
    try {
      const preserveEmptyApiKey = Boolean(editingConfigId && editingConfigId > 0);
      const payload = aiConfigInputFromForm(name, aiConfigForm, { preserveEmptyApiKey });
      if (editingConfigId && editingConfigId > 0) {
        await window.autoplan.aiConfigUpdate({
          configId: editingConfigId,
          name: payload.name,
          provider: payload.provider,
          baseUrl: payload.baseUrl,
          model: payload.model,
          temperature: payload.temperature,
          thinkingDepth: payload.thinkingDepth,
          thinkingBudgetTokens: payload.thinkingBudgetTokens,
          ...(payload.apiKey !== undefined ? { apiKey: payload.apiKey } : {}),
        });
      } else {
        await window.autoplan.aiConfigCreate(payload);
      }
      cancelEditAiConfig();
      await loadAiConfigs();
      await loadChatConfig();
    } catch (error) {
      setAiConfigError(getErrorMessage(error, 'AI 配置保存失败'));
    } finally {
      setAiConfigSaving(false);
    }
  }, [aiConfigName, aiConfigForm, editingConfigId, cancelEditAiConfig, loadAiConfigs, loadChatConfig]);

  const deleteAiConfig = useCallback(async (id: number) => {
    try {
      await window.autoplan.aiConfigDelete({ configId: id });
      if (editingConfigId != null && editingConfigId === id) cancelEditAiConfig();
      await loadAiConfigs();
      await loadChatConfig();
    } catch {
      /* 删除失败忽略 */
    }
  }, [editingConfigId, cancelEditAiConfig, loadAiConfigs, loadChatConfig]);

  const isAiConfigEditing = editingConfigId !== null;

  const navMeta: Record<SettingsPane, { label: string; tone?: string }> = {
    loop: { label: running ? '运行中' : '已停止', tone: running ? 'ok' : '' },
    cli: { label: agentCliNavLabel(loopForm.agentCliProvider), tone: isCodexProvider ? 'ok' : '' },
    appearance: { label: themeModeLabel },
    scope: { label: scopeModeLabel(scopeFileOpenSettings.mode) },
    mcp: { label: mcpStatus, tone: mcpStatusTone(mcp) },
    ai: { label: hasExistingApiKey ? '已配置' : '未配置', tone: hasExistingApiKey ? 'ok' : '' },
    env: { label: loopForm.envVars.length ? `${loopForm.envVars.length} 个` : '未配置' },
    about: { label: '关于' },
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
                  <div className="set-card-hint">浅色与深色界面切换</div>
                </div>
                <div className="set-card-body">
                  <label className="field">
                    <span className="field-label">主题</span>
                    <div className="segmented" role="radiogroup" aria-label="主题模式">
                      {([
                        { value: 'light' as ThemeMode, label: '浅色', desc: '始终使用浅色界面' },
                        { value: 'dark' as ThemeMode, label: '深色', desc: '始终使用深色界面' },
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

          {activePane === 'ai' ? (
            <section className="settings-pane active" aria-labelledby="settings-ai-title">
              <div className="pane-head">
                <h2 id="settings-ai-title"><span className="pane-ico" aria-hidden="true" />AI 对话</h2>
                <p>管理所有项目共用的 AI 配置，对话可绑定不同配置。支持 OpenAI 兼容、DeepSeek 和 Anthropic。</p>
              </div>

              {/* AI 配置列表 */}
              <div className="set-card ai-config-card">
                <div className="set-card-head ai-config-card-head">
                  <div className="ai-config-card-title">
                    <h3>AI 配置列表</h3>
                    <div className="set-card-hint">
                      全局配置由所有项目共用，对话可绑定不同配置
                    </div>
                  </div>
                  {!isAiConfigEditing ? (
                    <button
                      type="button"
                      className="btn btn-sm btn-primary ai-config-new-btn"
                      onClick={startNewAiConfig}
                    >
                      <Icon name="plus" size={14} aria-hidden="true" />
                      新建配置
                    </button>
                  ) : null}
                </div>
                <div className="set-card-body ai-config-card-body">
                  {aiConfigs.length === 0 && !isAiConfigEditing ? (
                    <div className="ai-config-empty">
                      <span className="ai-config-empty-icon" aria-hidden="true">
                        <Icon name="chat" size={22} />
                      </span>
                      <span>暂无 AI 配置，点击「新建配置」添加。</span>
                    </div>
                  ) : (
                    <div className="ai-config-list">
                      {aiConfigs.map((cfg) => {
                        const providerTone = aiProviderTone(cfg.provider);
                        const thinkingLabel = aiThinkingLabel(cfg);
                        return (
                          <div
                            key={cfg.id}
                            className={`ai-config-item${editingConfigId === cfg.id ? ' editing' : ''}`}
                          >
                            <span className={`ai-config-provider-mark ${providerTone}`} aria-hidden="true">
                              <Icon name={cfg.provider === 'deepseek' ? 'bolt' : cfg.provider === 'anthropic' ? 'thinking' : 'chat'} size={18} />
                            </span>
                            <div className="ai-config-info">
                              <div className="ai-config-title-row">
                                <span className="ai-config-name" title={cfg.name}>{cfg.name}</span>
                                <span className={`ai-config-provider ${providerTone}`}>
                                  {aiProviderLabel(cfg.provider)}
                                </span>
                              </div>
                              <div className="ai-config-meta">
                                <span className="ai-config-model mono" title={cfg.model || undefined}>
                                  {cfg.model || '未设置模型'}
                                </span>
                                {thinkingLabel ? (
                                  <>
                                    <span className="meta-dot" aria-hidden="true" />
                                    <span>{thinkingLabel}</span>
                                  </>
                                ) : null}
                              </div>
                            </div>
                            <span className={`ai-config-key ${cfg.hasApiKey ? 'ready' : 'missing'}`}>
                              <Icon name="key" size={14} aria-hidden="true" />
                              {cfg.hasApiKey ? '已设置密钥' : '未设置密钥'}
                            </span>
                            <div className="ai-config-actions">
                              <button
                                type="button"
                                className="icon-btn"
                                title="编辑配置"
                                aria-label={`编辑配置 ${cfg.name}`}
                                onClick={() => startEditAiConfig(cfg)}
                              >
                                <Icon name="edit" size={16} aria-hidden="true" />
                              </button>
                              <button
                                type="button"
                                className="icon-btn danger"
                                title="删除配置"
                                aria-label={`删除配置 ${cfg.name}`}
                                onClick={() => { void deleteAiConfig(cfg.id); }}
                              >
                                <Icon name="trash" size={16} aria-hidden="true" />
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>

              {/* 编辑/新建表单 */}
              <Modal
                open={isAiConfigEditing}
                onClose={cancelEditAiConfig}
                title={editingConfigId && editingConfigId > 0 ? '编辑配置' : '新建配置'}
                size="wide"
                className="ai-config-modal"
                bodyClassName="ai-config-modal-body"
                footer={(
                  <>
                    <span className="dirty-note">
                      {aiConfigSaving ? '保存中…' : '填写完成后点击保存。'}
                    </span>
                    <div className="spacer">
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={cancelEditAiConfig}
                      >
                        取消
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm btn-primary"
                        disabled={!aiConfigName.trim() || aiConfigSaving}
                        onClick={() => { void saveAiConfig(); }}
                      >
                        <Icon name="save" size={14} aria-hidden="true" />
                        {aiConfigSaving ? '保存中…' : '保存'}
                      </button>
                    </div>
                  </>
                )}
              >
                    {aiConfigError ? (
                      <div className="ai-config-error" role="alert">
                        {aiConfigError}
                      </div>
                    ) : null}
                    <label className="field">
                      <span className="field-label">配置名称 <span className="req">*</span></span>
                      <input
                        className="field-input"
                        value={aiConfigName}
                        onChange={(e) => {
                          setAiConfigError(null);
                          setAiConfigName(e.target.value);
                        }}
                        placeholder="如 GPT-4o 正式、DeepSeek 测试"
                      />
                    </label>

                    <label className="field">
                      <span className="field-label">Provider</span>
                      <div className="segmented" role="radiogroup" aria-label="AI Provider">
                        {aiProviderOptions.map((option) => {
                          const active = aiConfigForm.provider === option.value;
                          return (
                            <button
                              key={option.value}
                              type="button"
                              className={`seg-opt${active ? ' active' : ''}`}
                              aria-pressed={active}
                              onClick={() => {
                                setAiConfigError(null);
                                setAiConfigForm((current) => aiConfigFormForProviderChange(current, option.value));
                              }}
                            >
                              <span>{option.label}</span>
                              <span className="seg-note">{option.description}</span>
                            </button>
                          );
                        })}
                      </div>
                    </label>

                    <label className="field">
                      <span className="field-label">Base URL</span>
                      <input
                        className="field-input mono"
                        value={aiConfigForm.baseUrl}
                        onChange={(e) => updateAiConfigForm({ baseUrl: e.target.value })}
                        placeholder={defaultBaseUrlForProvider(aiConfigForm.provider)}
                      />
                      <span className="field-hint">API 端点地址，无需包含 /chat/completions 或 /messages 后缀。</span>
                    </label>

                    <label className="field">
                      <span className="field-label">API Key</span>
                      <input
                        className="field-input mono"
                        type="password"
                        value={aiConfigForm.apiKey}
                        onChange={(e) => updateAiConfigForm({ apiKey: e.target.value })}
                        placeholder={
                          editingConfigId && editingConfigId > 0
                            ? '留空保持原密钥'
                            : 'sk-…'
                        }
                      />
                      <span className="field-hint">
                        {editingConfigId && editingConfigId > 0
                          ? '留空则保持原密钥不变。'
                          : '支持 OpenAI / DeepSeek / Anthropic 等服务的 API Key。'}
                      </span>
                    </label>

                    <label className="field">
                      <span className="field-label">模型</span>
                      <input
                        className="field-input mono"
                        value={aiConfigForm.model}
                        onChange={(e) => updateAiConfigForm({ model: e.target.value })}
                        placeholder={defaultModelForProvider(aiConfigForm.provider)}
                      />
                      <span className="field-hint">LLM 模型名称，按 provider 文档填写。</span>
                    </label>

                    <label className="field">
                      <span className="field-label">温度 (Temperature)</span>
                      <input
                        className="field-input"
                        type="number"
                        step="0.1"
                        min="0"
                        max="2"
                        value={aiConfigForm.temperature}
                        onChange={(e) => updateAiConfigForm({ temperature: e.target.value })}
                      />
                      <span className="field-hint">0–2，越高越随机。建议 0.3（精确）到 0.7（创意）。</span>
                    </label>

                    {providerSupportsThinkingDepth(aiConfigForm.provider) ? (
                      <div className="field">
                        <span className="field-label">思考深度</span>
                        <div className="segmented" role="radiogroup" aria-label="思考深度">
                          {thinkingDepthOptions.map((option) => {
                            const active = aiConfigForm.thinkingDepth === option.value;
                            return (
                              <button
                                key={option.value}
                                type="button"
                                className={`seg-opt${active ? ' active' : ''}`}
                                aria-pressed={active}
                                onClick={() =>
                                  updateAiConfigForm({ thinkingDepth: option.value })
                                }
                              >
                                <span>{option.label}</span>
                                <span className="seg-note">{option.description}</span>
                              </button>
                            );
                          })}
                        </div>
                        <span className="field-hint">
                          {aiConfigForm.provider === 'deepseek'
                            ? 'DeepSeek 推理模型思考深度（如 deepseek-reasoner）。'
                            : 'OpenAI o 系列推理模型思考深度（如 o3-mini）。'}
                        </span>
                      </div>
                    ) : null}

                    {providerSupportsThinkingBudget(aiConfigForm.provider) ? (
                      <label className="field">
                        <span className="field-label">思考 Token 预算</span>
                        <input
                          className="field-input"
                          type="number"
                          min="0"
                          step="100"
                          value={aiConfigForm.thinkingBudgetTokens}
                          onChange={(e) =>
                            updateAiConfigForm({ thinkingBudgetTokens: e.target.value })
                          }
                          placeholder="如 4000，留空则不启用扩展思考"
                        />
                        <span className="field-hint">
                          Anthropic 扩展思考的 token 预算，启用后会自动调整 max_tokens。
                        </span>
                      </label>
                    ) : null}
              </Modal>
            </section>
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

          {activePane === 'about' ? <AboutPane /> : null}
        </form>
      </div>
    </div>
  );
}

function AboutPane() {
  const { status, check, checking } = useUpdateStatus();
  const latestLabel = status.latestVersion ? `v${status.latestVersion}` : '';
  const lastCheckedLabel = status.lastCheckedAt ? formatChinaDateTime(status.lastCheckedAt) : '尚未检查';
  const latestDisplay = status.stableUpdate
    ? latestLabel || '有新版本可用'
    : latestLabel
      ? `${latestLabel}（已是最新）`
      : '暂无正式版信息';

  return (
    <section className="settings-pane active" aria-labelledby="settings-about-title">
      <div className="pane-head">
        <h2 id="settings-about-title"><span className="pane-ico" aria-hidden="true" />关于 / 更新</h2>
        <p>查看当前版本与最新正式版本。仅检查与提醒，<b>不会自动下载安装</b>（避免与三端签名/公证冲突）。</p>
      </div>

      <div className="set-card">
        <div className="set-card-head">
          <h3>版本信息</h3>
          <div className="set-card-hint">来源：GitHub releases/latest（仅正式版，不含 beta）</div>
        </div>
        <div className="set-card-body">
          <div className="field readonly-field">
            <span className="field-label">当前版本</span>
            <span>v{status.currentVersion || '—'}</span>
          </div>
          <div className="field readonly-field">
            <span className="field-label">最新正式版</span>
            <span>{latestDisplay}</span>
          </div>
          <div className="field readonly-field">
            <span className="field-label">上次检查时间</span>
            <span>{lastCheckedLabel}</span>
          </div>
          <label className="field">
            <span className="field-label">自动检查</span>
            <button
              type="button"
              className={`btn btn-sm${status.autoCheck ? ' btn-primary' : ''}`}
              aria-pressed={status.autoCheck}
              onClick={() => {
                void window.autoplan.setAutoUpdateCheck(!status.autoCheck);
              }}
            >
              {status.autoCheck ? '已开启' : '已关闭'}
            </button>
            <span className="field-hint">默认每 {status.intervalMinutes || 360} 分钟检查一次，可在下方手动触发。</span>
          </label>
          <div className="settings-footer settings-actions">
            <span className="dirty-note">手动检查或前往 GitHub Releases 下载。</span>
            <div className="spacer">
              <button
                type="button"
                className="btn btn-sm"
                disabled={checking}
                onClick={() => {
                  void check();
                }}
              >
                {checking ? '检查中…' : '立即检查'}
              </button>
              <button
                type="button"
                className="btn btn-sm btn-primary"
                onClick={() => {
                  void window.autoplan.openExternal(AUTOPLAN_RELEASES_URL);
                }}
              >
                打开 GitHub Releases
              </button>
            </div>
          </div>
        </div>
      </div>
    </section>
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
