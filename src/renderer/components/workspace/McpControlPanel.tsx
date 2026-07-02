import { useState, type ReactNode } from 'react';
import type { McpStatus } from '../../types';
import { Icon } from '../icons';
import MarkdownReader from '../MarkdownReader';
import {
  generateMcpAuthToken,
  validateMcpConfigForm,
  type McpConfigFormState,
} from '../../utils/workspaceForms';

export function mcpStatusText(mcp?: McpStatus | null) {
  if (mcp?.lastError || mcp?.status === 'error') return '启动失败';
  if (mcp?.running) return '运行中';
  return '已停止';
}

export function mcpStatusTone(mcp?: McpStatus | null) {
  if (mcp?.lastError || mcp?.status === 'error') return 'warn';
  if (mcp?.running) return 'ok';
  return '';
}

type McpAction = 'start' | 'stop' | 'save';

function InfoRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="info-row">
      <span className="info-key">{label}</span>
      <span className="info-val">{children}</span>
    </div>
  );
}

export function McpControlPanel({
  mcp,
  mcpForm,
  setMcpForm,
  startMcp,
  stopMcp,
  saveMcpConfig,
}: {
  mcp?: McpStatus | null;
  mcpForm: McpConfigFormState;
  setMcpForm: (patch: Partial<McpConfigFormState>) => void;
  startMcp: () => void | Promise<void>;
  stopMcp: () => void | Promise<void>;
  saveMcpConfig: () => void | Promise<void>;
}) {
  const [openMcpToolName, setOpenMcpToolName] = useState('');
  const [showAuthToken, setShowAuthToken] = useState(false);
  const [busy, setBusy] = useState<McpAction | null>(null);

  const status = mcpStatusText(mcp);
  const tone = mcpStatusTone(mcp);
  const running = Boolean(mcp?.running);
  const failed = Boolean(mcp?.lastError || mcp?.status === 'error');
  const connectionAddress = mcp?.url || mcp?.connectionExample || 'http://127.0.0.1:43847/mcp';
  const mcpTools = mcp?.tools?.length ? mcp.tools : window.autoplan.mcpToolNames;
  const mcpToolDocs = mcp?.toolDocs?.length
    ? mcp.toolDocs
    : mcpTools.map((name) => ({ name, title: name, description: '', markdown: `## ${name}\n\n**功能**：暂无工具说明。` }));
  const openMcpTool = mcpToolDocs.find((tool) => tool.name === openMcpToolName);
  const authTokenPlaceholder = mcp?.hasAuthToken
    ? `已设置密钥（${mcp.authTokenMasked || '····'}）`
    : '未设置密钥，留空即不启用鉴权';

  const runWithBusy = async (key: McpAction, action: () => void | Promise<void>) => {
    if (busy) return;
    setBusy(key);
    try {
      await action();
    } finally {
      setBusy(null);
    }
  };

  const handleSave = () => {
    const error = validateMcpConfigForm(mcpForm);
    if (error) {
      window.alert(error);
      return;
    }
    if (mcpForm.authToken.trim() && !window.confirm('确认用新密钥覆盖当前 MCP 访问密钥？保存后服务将按新配置重启。')) {
      return;
    }
    void runWithBusy('save', saveMcpConfig);
  };

  return (
    <section className="settings-pane active" aria-labelledby="settings-mcp-title">
      <div className="pane-head">
        <h2 id="settings-mcp-title"><span className="pane-ico" aria-hidden="true" />MCP 外部接入 <span className={`mcp-status ${tone}`}>{status}</span></h2>
        <p>本机客户端可通过 MCP 工具创建项目、提交需求和反馈；可在此手动启停、配置监听地址与访问密钥。</p>
      </div>

      <div className="set-card mcp-run-card">
        <div className="set-card-head">
          <h3>运行控制</h3>
          <div className="set-card-hint">手动启动 / 停止，无需重启应用</div>
        </div>
        <div className="set-card-body">
          <div className="mcp-run-status">
            <span className={`mcp-status ${tone}`}>{status}</span>
            <span className="mcp-run-meta">
              {failed && mcp?.lastError
                ? <span className="danger-text">{mcp.lastError}</span>
                : <span className="dim">{running ? '服务运行中，可被外部客户端连接' : '服务未运行，点击启动以供连接'}</span>}
            </span>
          </div>
          <div className="mcp-run-actions">
            <button type="button" className="btn btn-sm btn-primary" disabled={running || busy !== null} onClick={() => void runWithBusy('start', startMcp)}>
              <Icon name="play" size={14} aria-hidden />{busy === 'start' ? '启动中…' : '启动'}
            </button>
            <button type="button" className="btn btn-sm btn-danger" disabled={!running || busy !== null} onClick={() => void runWithBusy('stop', stopMcp)}>
              <Icon name="stop" size={14} aria-hidden />{busy === 'stop' ? '停止中…' : '停止'}
            </button>
          </div>
        </div>
      </div>

      <div className="set-card">
        <div className="set-card-head">
          <h3>服务信息</h3>
          <div className="set-card-hint">传输、访问范围、连接地址、鉴权状态与工具清单</div>
        </div>
        <div className="set-card-body">
          <InfoRow label="传输方式">HTTP Streamable</InfoRow>
          <InfoRow label="访问范围">{mcp?.localOnly === false ? '已显式允许非本机绑定' : '默认仅本机访问'}</InfoRow>
          <InfoRow label="连接地址"><span className="mono">{connectionAddress}</span></InfoRow>
          <InfoRow label="鉴权状态">
            {mcp?.hasAuthToken
              ? <>已设置密钥（<span className="mono">{mcp.authTokenMasked || '····'}</span>）</>
              : <span className="dim">未启用鉴权</span>}
          </InfoRow>
          <InfoRow label="请求头"><span className="mono">{mcp?.authHeader || 'Authorization: Bearer <token>'}</span></InfoRow>
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
            <span>{mcp?.note || '默认仅监听本机地址，供本机 MCP 客户端连接。'} 可用环境变量 <code>AUTOPLAN_MCP_ENABLED=0</code> 禁用自动启动。</span>
          </div>
        </div>
      </div>

      <div className="set-card">
        <div className="set-card-head">
          <h3>配置</h3>
          <div className="set-card-hint">监听地址、端口、路径与访问密钥；保存后服务按新配置重启</div>
        </div>
        <div className="set-card-body">
          <div className="field mcp-enabled-field">
            <span className="field-label">应用启动时自动拉起</span>
            <button
              type="button"
              className={`toggle${mcpForm.enabled ? ' on' : ''}`}
              aria-pressed={mcpForm.enabled}
              aria-label="切换应用启动时是否自动拉起 MCP"
              onClick={() => setMcpForm({ enabled: !mcpForm.enabled })}
            />
            <span className="field-hint">关闭后仅在点击「启动」时运行，不影响手动启停。</span>
          </div>

          <label className="field">
            <span className="field-label">监听地址 <span className="tag">可选</span></span>
            <input
              className="field-input mono"
              value={mcpForm.host}
              onChange={(event) => setMcpForm({ host: event.target.value })}
              placeholder="127.0.0.1"
            />
            <span className="field-hint">留空默认 <code>127.0.0.1</code>；非本机地址需 <code>AUTOPLAN_MCP_ALLOW_REMOTE=1</code> 授权。</span>
          </label>
          <label className="field">
            <span className="field-label">端口</span>
            <input
              className="field-input"
              type="number"
              min="1"
              max="65535"
              value={mcpForm.port}
              onChange={(event) => setMcpForm({ port: event.target.value })}
              placeholder="43847"
            />
            <span className="field-hint">1–65535 的整数。</span>
          </label>
          <label className="field">
            <span className="field-label">路径</span>
            <input
              className="field-input mono"
              value={mcpForm.path}
              onChange={(event) => setMcpForm({ path: event.target.value })}
              placeholder="/mcp"
            />
            <span className="field-hint">需以 <code>/</code> 开头。</span>
          </label>

          <div className="field mcp-token-field">
            <span className="field-label">访问密钥</span>
            <div className="mcp-token-control">
              <input
                className="field-input mono"
                type={showAuthToken ? 'text' : 'password'}
                value={mcpForm.authToken}
                onChange={(event) => setMcpForm({ authToken: event.target.value })}
                placeholder={authTokenPlaceholder}
                autoComplete="off"
                spellCheck={false}
              />
              <button
                type="button"
                className="icon-btn"
                title={showAuthToken ? '隐藏密钥' : '显示密钥'}
                aria-pressed={showAuthToken}
                aria-label={showAuthToken ? '隐藏密钥' : '显示密钥'}
                onClick={() => setShowAuthToken((current) => !current)}
              >
                <Icon name={showAuthToken ? 'eye-off' : 'eye'} size={16} aria-hidden />
              </button>
              <button type="button" className="btn btn-sm" title="生成随机密钥" onClick={() => setMcpForm({ authToken: generateMcpAuthToken() })}>
                <Icon name="refresh" size={14} aria-hidden />生成
              </button>
              <button type="button" className="btn btn-sm" title="清空密钥" disabled={!mcpForm.authToken} onClick={() => setMcpForm({ authToken: '' })}>
                <Icon name="close" size={14} aria-hidden />清空
              </button>
            </div>
            <span className="field-hint">默认留空表示不改动；输入或生成新值会覆盖，点「清空」并保存将关闭鉴权。完整密钥不会在界面回显。</span>
          </div>
        </div>
        <div className="settings-footer settings-actions mcp-save-footer">
          <span className="dirty-note">MCP 配置独立保存，保存后服务按新配置重启。</span>
          <div className="spacer">
            <button type="button" className="btn btn-sm btn-primary" disabled={busy !== null} onClick={handleSave}>
              <Icon name="save" size={14} aria-hidden />{busy === 'save' ? '保存中…' : '保存 MCP 配置'}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
