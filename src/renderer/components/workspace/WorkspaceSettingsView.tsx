import type { Dispatch, FormEvent, SetStateAction } from 'react';
import type { McpStatus } from '../../types';
import {
  codexReasoningOptions,
  normalizeCodexReasoningEffort,
  type LoopFormState,
  type ScopeFileOpenMode,
  type ScopeFileOpenSettings,
} from '../../utils/workspaceForms';

function mcpStatusText(mcp?: McpStatus | null) {
  if (!mcp?.enabled) return '已禁用';
  if (mcp.lastError || mcp.status === 'error') return '启动失败';
  if (mcp.running) return '运行中';
  return '已配置，等待启动事件';
}

export function WorkspaceSettingsView({
  loopForm,
  scopeFileOpenSettings,
  setLoopForm,
  setScopeFileOpenSettings,
  mcp,
  onSubmit,
  onToggleRun,
  running,
}: {
  loopForm: LoopFormState;
  scopeFileOpenSettings: ScopeFileOpenSettings;
  setLoopForm: Dispatch<SetStateAction<LoopFormState>>;
  setScopeFileOpenSettings: Dispatch<SetStateAction<ScopeFileOpenSettings>>;
  mcp?: McpStatus | null;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onToggleRun: () => void;
  running: boolean;
}) {
  const isCodexProvider = loopForm.agentCliProvider !== 'claude';
  const mcpTools = mcp?.tools?.length ? mcp.tools : window.autoplan.mcpToolNames;

  return (
    <div className="settings-layout">
      <form className="editor card settings-card" onSubmit={onSubmit}>
        <div className="card-head">
          <h2>循环控制</h2>
          <span className="hint">工作区路径、循环间隔、验收命令与 CLI 后端</span>
        </div>
        <label className="field">
          工作区路径
          <input
            value={loopForm.workspacePath}
            onChange={(event) => setLoopForm((current) => ({ ...current, workspacePath: event.target.value }))}
            placeholder="D:\project\GitHub\my-app"
          />
        </label>
        <label className="field">
          间隔秒数
          <input
            min="1"
            type="number"
            value={loopForm.intervalSeconds}
            onChange={(event) => setLoopForm((current) => ({ ...current, intervalSeconds: event.target.value }))}
          />
        </label>
        <label className="field">
          验收命令（留空则不校验）
          <input
            value={loopForm.validationCommand}
            onChange={(event) => setLoopForm((current) => ({ ...current, validationCommand: event.target.value }))}
            placeholder="留空则跳过外部验收命令"
          />
        </label>
        <label className="field">
          CLI 后端
          <select
            value={loopForm.agentCliProvider}
            onChange={(event) => setLoopForm((current) => ({ ...current, agentCliProvider: event.target.value }))}
          >
            <option value="codex">Codex CLI</option>
            <option value="claude">Claude CLI</option>
          </select>
          {loopForm.agentCliProvider === 'claude' ? (
            <small className="field-hint">需本机已安装 claude CLI 并完成认证</small>
          ) : null}
        </label>
        {isCodexProvider ? (
          <label className="field">
            Codex 思考深度
            <select
              value={loopForm.codexReasoningEffort}
              onChange={(event) =>
                setLoopForm((current) => ({
                  ...current,
                  codexReasoningEffort: normalizeCodexReasoningEffort(event.target.value),
                }))
              }
            >
              {codexReasoningOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <small className="field-hint">仅 Codex CLI 生效，保存后执行参数会使用该深度</small>
          </label>
        ) : (
          <div className="field readonly-field">
            Codex 思考深度
            <span>Claude CLI 不使用该配置</span>
          </div>
        )}
        <label className="field">
          CLI 命令路径（留空用默认）
          <input
            className="mono"
            value={loopForm.agentCliCommand}
            onChange={(event) => setLoopForm((current) => ({ ...current, agentCliCommand: event.target.value }))}
            placeholder={loopForm.agentCliProvider === 'claude' ? 'claude' : 'codex'}
          />
        </label>
        <label className="field">
          scope 文件打开方式
          <select
            value={scopeFileOpenSettings.mode}
            onChange={(event) =>
              setScopeFileOpenSettings((current) => ({
                ...current,
                mode: event.target.value as ScopeFileOpenMode,
              }))
            }
          >
            <option value="system">系统默认方式</option>
            <option value="folder">系统文件夹定位</option>
            <option value="vscode">VSCode</option>
            <option value="command">第三方编辑器命令</option>
          </select>
          <small className="field-hint">用于 Plan 全文中 scope 文件链接，路径会限制在当前工作区内</small>
        </label>
        {scopeFileOpenSettings.mode === 'vscode' || scopeFileOpenSettings.mode === 'command' ? (
          <label className="field">
            编辑器命令
            <input
              className="mono"
              value={scopeFileOpenSettings.command}
              onChange={(event) => setScopeFileOpenSettings((current) => ({ ...current, command: event.target.value }))}
              placeholder={scopeFileOpenSettings.mode === 'vscode' ? 'code' : '编辑器命令，例如 cursor'}
            />
            <small className="field-hint">留空选择 VSCode 时默认使用 code；第三方命令可用 {'{file}'} 占位</small>
          </label>
        ) : null}
        <div className="button-row">
          <button type="submit">保存配置</button>
          <button type="button" onClick={onToggleRun}>
            {running ? '停止' : '启动'}
          </button>
        </div>
      </form>
      <div className="card settings-card">
        <div className="card-head">
          <h2>MCP 外部接入</h2>
          <span className="hint">本机客户端可通过 MCP 工具创建项目、提交需求和反馈</span>
        </div>
        <div className="field readonly-field">
          服务状态
          <span>{mcpStatusText(mcp)}</span>
        </div>
        <div className="field readonly-field">
          传输方式
          <span>{mcp?.transport === 'stdio' ? 'stdio' : 'HTTP Streamable'}</span>
        </div>
        <div className="field readonly-field">
          连接地址
          <span className="mono">{mcp?.connectionExample || 'http://127.0.0.1:43847/mcp'}</span>
        </div>
        <div className="field readonly-field">
          访问范围
          <span>{mcp?.localOnly === false ? '已显式允许非本机绑定' : '默认仅本机访问'}</span>
        </div>
        <div className="field readonly-field">
          工具清单
          <span className="mono">{mcpTools.join(', ')}</span>
        </div>
        {mcp?.lastError ? (
          <div className="field readonly-field">
            最近错误
            <span>{mcp.lastError}</span>
          </div>
        ) : null}
        <small className="field-hint">
          {mcp?.note || '默认仅监听本机地址，供本机 MCP 客户端连接。'} 可用环境变量 AUTOPLAN_MCP_ENABLED=0 禁用服务。
        </small>
      </div>
    </div>
  );
}
