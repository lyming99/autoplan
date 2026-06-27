import { useState, type Dispatch, type FormEvent, type ReactNode, type SetStateAction } from 'react';
import type { McpStatus } from '../../types';
import MarkdownReader from '../MarkdownReader';
import {
  agentCliOptionDetails,
  codexReasoningOptionDetails,
  normalizeCodexReasoningEffort,
  scopeFileOpenModeOptions,
  type LoopFormState,
  type ScopeFileOpenMode,
  type ScopeFileOpenSettings,
} from '../../utils/workspaceForms';

type SettingsPane = 'loop' | 'cli' | 'scope' | 'mcp';

const SETTINGS_NAV: Array<{ id: SettingsPane; label: string; hint: string; icon: string }> = [
  { id: 'loop', label: '循环控制', hint: '路径、间隔、验收命令', icon: 'loop' },
  { id: 'cli', label: 'CLI 后端', hint: 'Provider 与 Codex 深度', icon: 'cli' },
  { id: 'scope', label: 'scope 文件', hint: '打开方式与编辑器命令', icon: 'scope' },
  { id: 'mcp', label: 'MCP 接入', hint: '服务状态与工具清单', icon: 'mcp' },
];

function mcpStatusText(mcp?: McpStatus | null) {
  if (!mcp?.enabled) return '已禁用';
  if (mcp.lastError || mcp.status === 'error') return '启动失败';
  if (mcp.running) return '运行中';
  return '已配置，等待启动事件';
}

function mcpStatusTone(mcp?: McpStatus | null) {
  if (!mcp?.enabled || mcp.lastError || mcp.status === 'error') return 'warn';
  if (mcp.running) return 'ok';
  return '';
}

function scopeModeLabel(mode: ScopeFileOpenMode) {
  if (mode === 'folder') return '文件夹定位';
  if (mode === 'vscode') return 'VSCode';
  if (mode === 'command') return '第三方命令';
  return '系统默认';
}

export function WorkspaceSettingsView({
  loopForm,
  mcpAuthToken,
  scopeFileOpenSettings,
  setLoopForm,
  setMcpAuthToken,
  setScopeFileOpenSettings,
  mcp,
  onSubmit,
  onToggleRun,
  running,
}: {
  loopForm: LoopFormState;
  mcpAuthToken: string;
  scopeFileOpenSettings: ScopeFileOpenSettings;
  setLoopForm: Dispatch<SetStateAction<LoopFormState>>;
  setMcpAuthToken: Dispatch<SetStateAction<string>>;
  setScopeFileOpenSettings: Dispatch<SetStateAction<ScopeFileOpenSettings>>;
  mcp?: McpStatus | null;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onToggleRun: () => void;
  running: boolean;
}) {
  const [activePane, setActivePane] = useState<SettingsPane>('loop');
  const [openMcpToolName, setOpenMcpToolName] = useState<string>('');
  const isCodexProvider = loopForm.agentCliProvider !== 'claude';
  const mcpTools = mcp?.tools?.length ? mcp.tools : window.autoplan.mcpToolNames;
  const mcpToolDocs = mcp?.toolDocs?.length
    ? mcp.toolDocs
    : mcpTools.map((name) => ({
      name,
      title: name,
      description: '',
      markdown: `## ${name}\n\n**功能**：暂无工具说明。`,
    }));
  const openMcpTool = mcpToolDocs.find((tool) => tool.name === openMcpToolName);
  const mcpStatus = mcpStatusText(mcp);

  const navMeta: Record<SettingsPane, { label: string; tone?: string }> = {
    loop: { label: running ? '运行中' : '已停止', tone: running ? 'ok' : '' },
    cli: { label: loopForm.agentCliProvider === 'claude' ? 'Claude' : 'Codex', tone: isCodexProvider ? 'ok' : '' },
    scope: { label: scopeModeLabel(scopeFileOpenSettings.mode) },
    mcp: { label: mcpStatus, tone: mcpStatusTone(mcp) },
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
                  <div className="set-card-hint">Codex / Claude Provider、思考深度与可执行命令</div>
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
                      <span>Claude CLI 不使用该配置</span>
                    </div>
                  )}
                  <label className="field">
                    <span className="field-label">CLI 命令路径 <span className="tag">可选</span></span>
                    <input
                      className="field-input mono"
                      value={loopForm.agentCliCommand}
                      onChange={(event) => setLoopForm((current) => ({ ...current, agentCliCommand: event.target.value }))}
                      placeholder={loopForm.agentCliProvider === 'claude' ? 'claude' : 'codex'}
                    />
                    <span className="field-hint">后端在 PATH 中时留空即可，否则填写可执行文件完整路径。</span>
                  </label>
                </div>
              </div>

              <SettingsActions running={running} onToggleRun={onToggleRun} />
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
            <section className="settings-pane active" aria-labelledby="settings-mcp-title">
              <div className="pane-head">
                <h2 id="settings-mcp-title"><span className="pane-ico" aria-hidden="true" />MCP 外部接入 <span className={`mcp-status ${mcpStatusTone(mcp)}`}>{mcpStatus}</span></h2>
                <p>本机客户端可通过 MCP 工具创建项目、提交需求和反馈，可在此查看并修改访问密钥。</p>
              </div>

              <div className="set-card">
                <div className="set-card-head">
                  <h3>服务信息</h3>
                  <div className="set-card-hint">传输、访问范围、连接地址、工具清单与最近错误</div>
                </div>
                <div className="set-card-body">
                  <InfoRow label="服务状态"><span className={`mcp-status ${mcpStatusTone(mcp)}`}>{mcpStatus}</span></InfoRow>
                  <InfoRow label="传输方式">{mcp?.transport === 'stdio' ? 'stdio' : 'HTTP Streamable'}</InfoRow>
                  <InfoRow label="访问范围">{mcp?.localOnly === false ? '已显式允许非本机绑定' : '默认仅本机访问'}</InfoRow>
                  <InfoRow label="连接地址"><span className="mono">{mcp?.connectionExample || 'http://127.0.0.1:43847/mcp'}</span></InfoRow>
                  <label className="field">
                    <span className="field-label">访问密钥</span>
                    <input
                      className="field-input mono"
                      value={mcpAuthToken}
                      onChange={(event) => setMcpAuthToken(event.target.value)}
                      placeholder="MCP Bearer token"
                    />
                    <span className="field-hint">保存后 MCP 会在后台重启并使用新密钥。</span>
                  </label>
                  <InfoRow label="请求头"><span className="mono">{mcp?.authHeader || `Authorization: Bearer ${mcpAuthToken}`}</span></InfoRow>
                  <InfoRow label="工具清单">
                    <span className="tool-tags">
                      {mcpToolDocs.map((tool) => {
                        const active = openMcpToolName === tool.name;
                        return (
                          <button
                            key={tool.name}
                            type="button"
                            className={`tool-tag${active ? ' active' : ''}`}
                            aria-expanded={active}
                            aria-controls="mcp-tool-doc-panel"
                            title={tool.title || tool.description || tool.name}
                            onClick={() => setOpenMcpToolName((current) => (current === tool.name ? '' : tool.name))}
                          >
                            {tool.name}
                          </button>
                        );
                      })}
                    </span>
                  </InfoRow>
                  {openMcpTool ? (
                    <div id="mcp-tool-doc-panel" className="mcp-tool-doc">
                      <MarkdownReader
                        markdown={openMcpTool.markdown}
                        className="mcp-tool-markdown"
                        emptyMessage="暂无工具说明"
                        ariaLabel="MCP 工具说明"
                      />
                    </div>
                  ) : null}
                  <InfoRow label="最近错误"><span className={mcp?.lastError ? 'danger-text' : 'dim'}>{mcp?.lastError || '无'}</span></InfoRow>
                  <div className="inline-banner">
                    <span>{mcp?.note || '默认仅监听本机地址，供本机 MCP 客户端连接。'} 可用环境变量 <code>AUTOPLAN_MCP_ENABLED=0</code> 禁用服务，或用 <code>AUTOPLAN_MCP_AUTH_TOKEN</code> 覆盖密钥。</span>
                  </div>
                </div>
              </div>
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

function InfoRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="info-row">
      <span className="info-key">{label}</span>
      <span className="info-val">{children}</span>
    </div>
  );
}
