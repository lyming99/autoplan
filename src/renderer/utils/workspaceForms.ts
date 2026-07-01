import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import {
  DEFAULT_WORKSPACE_TAB,
  PENDING_ATTACHMENT_SOURCES,
} from '../types';
import type {
  AgentCliOption,
  AgentCliProvider,
  ChatConfig,
  CodexReasoningEffort,
  CreateScriptInput,
  EnvVarEntry,
  IntakeType,
  LoopConfigInput,
  McpConfigInput,
  McpStatus,
  McpTransport,
  PendingAttachment,
  ProjectState,
  Script,
  ScriptContextInject,
  ScriptHookStage,
  ScriptRuntime,
  ScriptSourceType,
  ScriptTriggerMode,
  UpdateScriptInput,
  WorkspacePlanReadState,
  WorkspaceTab,
} from '../types';
import { getFilePath, toSafeFileUrl } from '../components/shared';

const workspaceTabIds: WorkspaceTab[] = ['overview', 'requirement', 'feedback', 'tasks', 'events', 'settings'];

export const emptyPendingAttachments: Record<IntakeType, PendingAttachment[]> = {
  requirement: [],
  feedback: [],
};

export const agentCliOptions: AgentCliOption[] = [
  { value: 'codex', label: 'Codex CLI' },
  { value: 'claude', label: 'Claude CLI' },
  { value: 'opencode', label: 'OpenCode CLI' },
  { value: 'oh-my-pi', label: 'Oh My Pi CLI' },
];

export const codexReasoningOptions: AgentCliOption[] = [
  { value: 'low', label: '低 · 快速' },
  { value: 'medium', label: '中 · 默认' },
  { value: 'high', label: '高 · 深入' },
  { value: 'xhigh', label: '超高 · 最深入' },
];

export type SettingsChoiceOption<T extends string = string> = {
  value: T;
  label: string;
  description: string;
};

export const agentCliOptionDetails: Array<SettingsChoiceOption<AgentCliProvider>> = [
  { value: 'codex', label: 'Codex CLI', description: '默认后端，支持思考深度参数。' },
  { value: 'claude', label: 'Claude CLI', description: '使用本机 claude 命令，需提前认证。' },
  { value: 'opencode', label: 'OpenCode CLI', description: '使用本机 opencode 命令，需提前安装并认证。' },
  { value: 'oh-my-pi', label: 'Oh My Pi CLI', description: '使用本机 omp 命令，需提前安装并认证。' },
];

export const codexReasoningOptionDetails: Array<SettingsChoiceOption<CodexReasoningEffort>> = [
  { value: 'low', label: '低', description: '快速响应，适合小范围改动。' },
  { value: 'medium', label: '中', description: '默认平衡速度与质量。' },
  { value: 'high', label: '高', description: '更深入分析复杂代码。' },
  { value: 'xhigh', label: '超高', description: '最充分推理，适合高风险任务。' },
];

export const defaultCodexReasoningEffort: CodexReasoningEffort = 'medium';

export const defaultComposerCliProviders: Record<IntakeType, AgentCliProvider> = { requirement: 'codex', feedback: 'codex' };

export const defaultComposerCodexReasoning: Record<IntakeType, CodexReasoningEffort> = { requirement: defaultCodexReasoningEffort, feedback: defaultCodexReasoningEffort };

export type LoopFormState = {
  workspacePath: string;
  intervalSeconds: string;
  validationCommand: string;
  agentCliProvider: string;
  agentCliCommand: string;
  codexReasoningEffort: CodexReasoningEffort;
  envVars: EnvVarEntry[];
};

export type ScopeFileOpenMode = 'system' | 'folder' | 'vscode' | 'command';

export type ScopeFileOpenSettings = {
  mode: ScopeFileOpenMode;
  command: string;
};

export const defaultScopeFileOpenSettings: ScopeFileOpenSettings = { mode: 'system', command: '' };

export const scopeFileOpenModeOptions: Array<SettingsChoiceOption<ScopeFileOpenMode>> = [
  { value: 'system', label: '系统默认', description: '交给系统默认应用打开。' },
  { value: 'folder', label: '文件夹定位', description: '打开所在目录并定位文件。' },
  { value: 'vscode', label: 'VSCode', description: '使用 code 命令打开文件。' },
  { value: 'command', label: '第三方命令', description: '自定义编辑器命令，支持 {file}。' },
];

export function createEmptyPlanReadState(): WorkspacePlanReadState {
  return { plan: null, result: null, loading: false, error: null };
}

export function getErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error.trim()) return error.trim();
  return fallback;
}

export function createPendingPathAttachment(file: File): PendingAttachment | null {
  const path = getFilePath(file);
  if (!path) return null;
  const name = file.name || path.split(/[\\/]/).pop() || '附件';
  const type = file.type || 'application/octet-stream';
  return {
    id: `${PENDING_ATTACHMENT_SOURCES.PATH}:${path}:${file.size}`,
    source: PENDING_ATTACHMENT_SOURCES.PATH,
    path,
    name,
    size: file.size,
    type,
    previewUrl: toSafeFileUrl(path),
  };
}

export function getImageExtension(type: string) {
  if (type === 'image/jpeg') return 'jpg';
  const subtype = type.startsWith('image/') ? type.slice('image/'.length) : 'png';
  return subtype.replace(/[^a-z0-9]+/gi, '').toLowerCase() || 'png';
}

export function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('读取剪贴板图片失败'));
    reader.readAsDataURL(file);
  });
}

export async function createPendingClipboardImageAttachment(file: File, index: number): Promise<PendingAttachment | null> {
  if (!file.type.startsWith('image/')) return null;
  const type = file.type || 'image/png';
  const extension = getImageExtension(type);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const fallbackName = `pasted-image-${timestamp}-${index + 1}.${extension}`;
  const name = file.name || fallbackName;
  const dataUrl = await readFileAsDataUrl(file);
  if (!dataUrl) return null;
  const idSuffix = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${index}-${Math.random().toString(36).slice(2)}`;
  return {
    id: `${PENDING_ATTACHMENT_SOURCES.CLIPBOARD_IMAGE}:${idSuffix}`,
    source: PENDING_ATTACHMENT_SOURCES.CLIPBOARD_IMAGE,
    dataUrl,
    name,
    size: file.size,
    type,
    previewUrl: dataUrl,
  };
}

export function appendPendingAttachments(
  setPendingAttachments: Dispatch<SetStateAction<Record<IntakeType, PendingAttachment[]>>>,
  type: IntakeType,
  attachments: PendingAttachment[],
) {
  if (!attachments.length) return;
  setPendingAttachments((current) => {
    const nextItems = [...current[type]];
    for (const attachment of attachments) {
      if (!nextItems.some((item) => isSamePendingAttachment(item, attachment))) nextItems.push(attachment);
    }
    return nextItems.length === current[type].length ? current : { ...current, [type]: nextItems };
  });
}

export function isSamePendingAttachment(current: PendingAttachment, next: PendingAttachment) {
  if (current.source !== next.source) return false;
  if (current.source === PENDING_ATTACHMENT_SOURCES.PATH && next.source === PENDING_ATTACHMENT_SOURCES.PATH) {
    return current.path === next.path && current.size === next.size;
  }
  if (
    current.source === PENDING_ATTACHMENT_SOURCES.CLIPBOARD_IMAGE &&
    next.source === PENDING_ATTACHMENT_SOURCES.CLIPBOARD_IMAGE
  ) {
    return current.dataUrl === next.dataUrl && current.size === next.size;
  }
  return current.id === next.id;
}

export function resolveWorkspaceTab(tab: string | null): WorkspaceTab {
  return workspaceTabIds.some((item) => item === tab) ? (tab as WorkspaceTab) : DEFAULT_WORKSPACE_TAB;
}

export function normalizeCodexReasoningEffort(value?: string | null): CodexReasoningEffort {
  const effort = String(value || '').trim().toLowerCase();
  if (effort === 'low' || effort === 'high' || effort === 'xhigh') return effort;
  return defaultCodexReasoningEffort;
}

export function isCodexAgentCliProvider(provider?: string | null) {
  const normalized = String(provider || '').trim().toLowerCase();
  return normalized === 'codex';
}

export function agentCliDefaultCommand(provider?: string | null) {
  const normalized = String(provider || '').trim().toLowerCase();
  if (normalized === 'claude') return 'claude';
  if (normalized === 'opencode') return 'opencode';
  if (normalized === 'oh-my-pi') return 'omp';
  return 'codex';
}

export function loopFormFromProjectState(state: ProjectState): LoopFormState {
  let envVars: EnvVarEntry[] = [];
  if (state.env_vars) {
    try {
      const parsed = JSON.parse(state.env_vars);
      if (Array.isArray(parsed)) {
        envVars = parsed
          .filter((entry) => entry != null && typeof entry === 'object')
          .map((entry) => ({ name: String((entry as Record<string, unknown>).name ?? ''), value: String((entry as Record<string, unknown>).value ?? '') }));
      }
    } catch { /* JSON 解析失败降级为 [] */ }
  }
  return {
    workspacePath: state.workspace_path || '',
    intervalSeconds: String(state.interval_seconds || 5),
    validationCommand: state.validation_command ?? '',
    agentCliProvider: state.agent_cli_provider || 'codex',
    agentCliCommand: state.agent_cli_command || '',
    codexReasoningEffort: normalizeCodexReasoningEffort(state.codex_reasoning_effort),
    envVars,
  };
}

export function loopConfigurePayloadFromForm(projectId: number, form: LoopFormState): LoopConfigInput {
  const payload: LoopConfigInput = {
    projectId,
    workspacePath: form.workspacePath,
    intervalSeconds: Number(form.intervalSeconds || 5),
    validationCommand: form.validationCommand,
    agentCliProvider: form.agentCliProvider || 'codex',
    agentCliCommand: form.agentCliCommand.trim(),
  };
  if (isCodexAgentCliProvider(form.agentCliProvider)) {
    payload.codexReasoningEffort = form.codexReasoningEffort;
  }
  const envVars = normalizeEnvVarEntries(form.envVars);
  if (envVars.length > 0) {
    payload.envVars = envVars;
  }
  return payload;
}

export function loopFormsEqual(left: LoopFormState, right: LoopFormState) {
  return left.workspacePath === right.workspacePath
    && left.intervalSeconds === right.intervalSeconds
    && left.validationCommand === right.validationCommand
    && left.agentCliProvider === right.agentCliProvider
    && left.agentCliCommand === right.agentCliCommand
    && left.codexReasoningEffort === right.codexReasoningEffort
    && envVarsEqual(left.envVars, right.envVars);
}

function envVarsEqual(a: EnvVarEntry[] = [], b: EnvVarEntry[] = []) {
  if (a.length !== b.length) return false;
  return a.every((entry, i) => entry.name === b[i].name && entry.value === b[i].value);
}

function normalizeEnvVarEntries(entries: EnvVarEntry[]): EnvVarEntry[] {
  if (!Array.isArray(entries)) return [];
  const seen = new Set<string>();
  const result: EnvVarEntry[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const name = String(entry.name ?? '').trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    result.push({ name, value: String(entry.value ?? '') });
  }
  return result;
}

/* ===================== MCP 配置 draft 表单（设置面板） ===================== */

export type McpConfigFormState = {
  enabled: boolean;
  transport: McpTransport;
  host: string;
  /** 文本输入值，提交时再解析为 1–65535 整数 */
  port: number | string;
  path: string;
  /** 始终留空，不从快照明文回填；承载用户输入/生成/清空 */
  authToken: string;
};

/** 从快照构造表单：transport/host/port/path 取自快照，authToken 永不回填明文 */
export function mcpConfigFormFromSnapshot(mcp: McpStatus | null | undefined): McpConfigFormState {
  if (!mcp) return { enabled: true, transport: 'http', host: '', port: '', path: '', authToken: '' };
  return {
    enabled: Boolean(mcp.enabled),
    transport: mcp.transport === 'stdio' ? 'stdio' : 'http',
    host: mcp.host ?? '',
    port: mcp.port ?? '',
    path: mcp.path ?? '',
    authToken: '',
  };
}

export function mcpConfigFormsEqual(left: McpConfigFormState, right: McpConfigFormState) {
  return left.enabled === right.enabled
    && left.transport === right.transport
    && left.host === right.host
    && String(left.port) === String(right.port)
    && left.path === right.path
    && left.authToken === right.authToken;
}

/** 将端口解析为 1–65535 整数；非法返回 null */
export function parseMcpPort(value: number | string): number | null {
  const parsed = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 1 || parsed > 65535) return null;
  return parsed;
}

/** 返回校验错误文案；通过校验返回 null（仅 http 传输校验地址/端口/路径） */
export function validateMcpConfigForm(form: McpConfigFormState): string | null {
  if (form.transport !== 'http') return null;
  if (!form.host.trim()) return 'MCP 监听地址不能为空';
  if (parseMcpPort(form.port) === null) return 'MCP 端口需为 1–65535 的整数';
  if (!form.path.trim().startsWith('/')) return 'MCP 路径需以 / 开头';
  return null;
}

/**
 * 序列化为 saveMcpConfig 载荷。authToken 仅在显式改动（authTokenTouched）时下发：
 * 未改动 → 不下发（保留既有密钥）；显式清空 → 下发空串（关闭鉴权）；填新值 → 下发新值。
 */
export function mcpConfigFormToPayload(
  projectId: number,
  form: McpConfigFormState,
  authTokenTouched: boolean,
): McpConfigInput {
  const payload: McpConfigInput = {
    projectId,
    enabled: form.enabled,
    transport: form.transport,
    host: form.host.trim(),
    port: form.port,
    path: form.path.trim(),
  };
  if (authTokenTouched) {
    payload.authToken = form.authToken.trim();
  }
  return payload;
}

/** 用 Web Crypto 生成 32 字节高熵随机密钥（base64url，无填充） */
export function generateMcpAuthToken(): string {
  const bytes = new Uint8Array(32);
  window.crypto.getRandomValues(bytes);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * MCP 配置表单状态钩子：管理 transport/host/port/path/enabled/authToken 的 draft。
 * authToken 默认留空且不从快照回填；setMcpForm 的 patch 中一旦包含 authToken
 * （含清空）即标记 touched，供 saveMcpConfig 区分「未改动 / 清空 / 设置」。
 */
export function useMcpConfigForm(mcp: McpStatus | null | undefined, projectId: number) {
  const [mcpForm, setMcpFormState] = useState<McpConfigFormState>(() => mcpConfigFormFromSnapshot(mcp));
  const formRef = useRef(mcpForm);
  const [mcpFormDirty, setMcpFormDirty] = useState(false);
  const [mcpAuthTokenTouched, setMcpAuthTokenTouched] = useState(false);

  const applyForm = useCallback((next: McpConfigFormState) => {
    formRef.current = next;
    setMcpFormState(next);
  }, []);

  const setMcpForm = useCallback((patch: Partial<McpConfigFormState>) => {
    if ('authToken' in patch) setMcpAuthTokenTouched(true);
    setMcpFormDirty(true);
    applyForm({ ...formRef.current, ...patch });
  }, [applyForm]);

  // 从快照同步配置（authToken 不回填），dirty 时不覆盖；projectId 变化触发重新计算。
  useEffect(() => {
    if (mcpFormDirty) return;
    const nextForm = mcpConfigFormFromSnapshot(mcp);
    if (mcpConfigFormsEqual(formRef.current, nextForm)) return;
    applyForm(nextForm);
  }, [applyForm, mcp, mcpFormDirty, projectId]);

  useEffect(() => {
    setMcpFormDirty(false);
    setMcpAuthTokenTouched(false);
  }, [projectId]);

  // 保存成功后用最新快照重置表单（authToken 回到空、dirty/touched 清零）。
  const resetMcpForm = useCallback((nextMcp: McpStatus | null | undefined) => {
    setMcpFormDirty(false);
    setMcpAuthTokenTouched(false);
    applyForm(mcpConfigFormFromSnapshot(nextMcp));
  }, [applyForm]);

  return { mcpForm, mcpAuthTokenTouched, setMcpForm, resetMcpForm };
}

/* ===================== Chat 配置 draft 表单（设置 AI 面板） ===================== */

export type ChatConfigFormState = {
  provider: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: string;
  /** 思考深度（需求 #28）：'' | 'low' | 'medium' | 'high' */
  thinkingDepth: string;
  /** Anthropic 思考 token 预算（需求 #28），字符串数字，空串表示未设置 */
  thinkingBudgetTokens: string;
};

/**
 * 从 ChatConfig 快照初始化表单：
 * - provider/baseUrl/model/temperature 取快照值（缺省回退）
 * - apiKey 永远不预填明文，初始为空字符串
 */
export function createDefaultChatConfigForm(config?: ChatConfig | null): ChatConfigFormState {
  if (!config) {
    return {
      provider: 'openai',
      baseUrl: 'https://api.openai.com',
      apiKey: '',
      model: 'gpt-4o',
      temperature: '0.3',
      thinkingDepth: '',
      thinkingBudgetTokens: '',
    };
  }
  return {
    provider: config.provider || 'openai',
    baseUrl: config.baseUrl || 'https://api.openai.com',
    apiKey: '',
    model: config.model || 'gpt-4o',
    temperature: config.temperature || '0.3',
    thinkingDepth: config.thinkingDepth || '',
    thinkingBudgetTokens: config.thinkingBudgetTokens != null ? String(config.thinkingBudgetTokens) : '',
  };
}

/**
 * 比较两个 ChatConfigFormState。
 * apiKey 始终以空串初始化；非空 → 用户已修改需保存；
 * 为空且 hasExistingApiKey 为 true → 用户清除了密钥需保存。
 * @param hasExistingApiKey 原始配置是否已有 apiKey（来自 chatGetConfig 的 hasApiKey）
 */
export function chatConfigFormsEqual(
  a: ChatConfigFormState,
  b: ChatConfigFormState,
  hasExistingApiKey?: boolean,
): boolean {
  if (
    a.provider !== b.provider ||
    a.baseUrl !== b.baseUrl ||
    a.model !== b.model ||
    a.temperature !== b.temperature ||
    a.apiKey !== b.apiKey ||
    a.thinkingDepth !== b.thinkingDepth ||
    a.thinkingBudgetTokens !== b.thinkingBudgetTokens
  ) {
    return false;
  }
  // apiKey 为空但原配置有密钥 → 视为「清除」，表单不相等
  if (!a.apiKey && hasExistingApiKey) return false;
  return true;
}

/**
 * API Key 脱敏：非空显示 ···· + 末 4 位，空返回 ''，过短完全遮蔽。
 * 与 maskAuthToken（snapshots.js）同逻辑。
 */
export function maskApiKeyUtil(key: string): string {
  const token = String(key || '').trim();
  if (!token) return '';
  if (token.length <= 4) return '····';
  return `····${token.slice(-4)}`;
}

/* ===================== AI 配置多配置管理（需求 #28） ===================== */

/** AI Provider 选项：OpenAI 兼容 / DeepSeek / Anthropic */
export const aiProviderOptions: Array<SettingsChoiceOption<string>> = [
  { value: 'openai', label: 'OpenAI 兼容', description: 'OpenAI / 其他兼容端点' },
  { value: 'deepseek', label: 'DeepSeek', description: 'DeepSeek API 端点' },
  { value: 'anthropic', label: 'Anthropic', description: 'Claude 系列模型' },
];

/** 思考深度选项（OpenAI o-series / DeepSeek 推理模型）*/
export const thinkingDepthOptions: Array<{ value: string; label: string; description: string }> = [
  { value: '', label: '关闭', description: '不使用思考深度' },
  { value: 'low', label: '低', description: '快速响应' },
  { value: 'medium', label: '中', description: '默认平衡' },
  { value: 'high', label: '高', description: '深入推理' },
];

/** 根据 provider 返回默认 Base URL 占位符 */
export function defaultBaseUrlForProvider(provider: string): string {
  if (provider === 'deepseek') return 'https://api.deepseek.com';
  if (provider === 'anthropic') return 'https://api.anthropic.com';
  return 'https://api.openai.com';
}

/** 根据 provider 返回默认模型占位符 */
export function defaultModelForProvider(provider: string): string {
  if (provider === 'deepseek') return 'deepseek-chat';
  if (provider === 'anthropic') return 'claude-sonnet-4-6';
  return 'gpt-4o';
}

/** 判断 provider 是否需要显示思考深度选择器（OpenAI 兼容 / DeepSeek）*/
export function providerSupportsThinkingDepth(provider: string): boolean {
  return provider === 'openai' || provider === 'deepseek';
}

/** 判断 provider 是否需要显示思考 token 预算输入（Anthropic）*/
export function providerSupportsThinkingBudget(provider: string): boolean {
  return provider === 'anthropic';
}

/* ===================== 脚本 draft 表单（新建/编辑共用弹窗） ===================== */

export const SCRIPT_RUNTIMES: ScriptRuntime[] = ['node', 'bash', 'ps', 'cmd'];
export const SCRIPT_HOOK_STAGES: ScriptHookStage[] = [
  'plan:after',
  'task:after',
  'validation:before',
  'loop:end',
  'on:fail',
];
export const SCRIPT_DEFAULT_TIMEOUT_SECONDS = 120;

export type ScriptDraftState = {
  /** null 表示新建；存在 id 表示编辑既有脚本 */
  id: number | null;
  name: string;
  description: string;
  runtime: ScriptRuntime;
  /** 脚本来源：'inline' 执行 body（写临时文件），'file' 直接运行 path 指向的原文件 */
  sourceType: ScriptSourceType;
  /** 文件来源时的文件路径（内联来源时为空，但切换来源不丢失已填内容） */
  path: string;
  body: string;
  triggerMode: ScriptTriggerMode;
  /** 仅手动模式下序列化为 null；保留值以便切回自动钩子时恢复 */
  hookStage: ScriptHookStage;
  workDir: string;
  /** 文本输入框值，序列化时再解析为正整数 */
  timeoutSeconds: string;
  failAborts: boolean;
  contextInject: ScriptContextInject;
  enabled: boolean;
  /** 定时 cron 表达式（仅 triggerMode='schedule' 时序列化入库；其它模式保留草稿值以便切回不丢） */
  scheduleCron: string;
};

function readScriptRuntime(value: unknown): ScriptRuntime {
  return value === 'bash' || value === 'ps' || value === 'cmd' ? value : 'node';
}

function readScriptSourceType(value: unknown): ScriptSourceType {
  return value === 'file' ? 'file' : 'inline';
}

function readScriptTriggerMode(value: unknown): ScriptTriggerMode {
  if (value === 'hook') return 'hook';
  if (value === 'schedule') return 'schedule';
  return 'manual';
}

function readScriptContextInject(value: unknown): ScriptContextInject {
  return value === 'stdin' || value === 'none' ? value : 'env';
}

function readScriptHookStage(value: unknown): ScriptHookStage {
  return SCRIPT_HOOK_STAGES.includes(value as ScriptHookStage) ? (value as ScriptHookStage) : 'plan:after';
}

export function createScriptDraft(script: Script | null): ScriptDraftState {
  if (!script) {
    return {
      id: null,
      name: '',
      description: '',
      runtime: 'node',
      sourceType: 'inline',
      path: '',
      body: '',
      triggerMode: 'hook',
      hookStage: 'validation:before',
      workDir: '${workspace}',
      timeoutSeconds: String(SCRIPT_DEFAULT_TIMEOUT_SECONDS),
      failAborts: false,
      contextInject: 'env',
      enabled: true,
      scheduleCron: '*/5 * * * *',
    };
  }
  const timeoutSeconds = Number(script.timeout_seconds ?? script.timeoutSeconds);
  return {
    id: script.id,
    name: script.name || '',
    description: script.description || '',
    runtime: readScriptRuntime(script.runtime),
    sourceType: readScriptSourceType(script.source_type ?? script.sourceType),
    path: script.path || '',
    body: script.body || '',
    triggerMode: readScriptTriggerMode(script.trigger_mode ?? script.triggerMode),
    hookStage: readScriptHookStage(script.hook_stage ?? script.hookStage),
    workDir: script.work_dir ?? script.workDir ?? '',
    timeoutSeconds: Number.isFinite(timeoutSeconds) && timeoutSeconds > 0 ? String(timeoutSeconds) : String(SCRIPT_DEFAULT_TIMEOUT_SECONDS),
    failAborts: Boolean(script.fail_aborts ?? script.failAborts),
    contextInject: readScriptContextInject(script.context_inject ?? script.contextInject),
    enabled: Boolean(script.enabled),
    scheduleCron: script.schedule_cron ?? script.scheduleCron ?? '',
  };
}

/** 解析超时秒数，非法时回退到默认值；供校验与序列化共用 */
export function parseScriptTimeoutSeconds(value: string) {
  const trimmed = String(value || '').trim();
  const parsed = Number(trimmed);
  if (!trimmed || !Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) return null;
  return parsed;
}

/** 返回校验错误文案；通过校验返回 null */
export function validateScriptDraft(draft: ScriptDraftState): string | null {
  const name = draft.name.trim();
  if (!name) return '请填写脚本名称';
  if (name.length > 120) return '脚本名称过长（最多 120 字符）';
  if (draft.triggerMode === 'hook' && !draft.hookStage) return '自动钩子需选择挂载阶段';
  if (draft.triggerMode === 'schedule' && !draft.scheduleCron.trim()) return '定时任务需填写 cron 表达式';
  if (draft.sourceType === 'file' && !draft.path.trim()) return '选择文件来源时需指定脚本文件';
  const timeout = parseScriptTimeoutSeconds(draft.timeoutSeconds);
  if (timeout === null) return '超时秒数需为正整数';
  return null;
}

export function scriptCreateInputFromDraft(projectId: number, draft: ScriptDraftState): CreateScriptInput {
  return {
    projectId,
    name: draft.name.trim(),
    description: draft.description.trim(),
    runtime: draft.runtime,
    sourceType: draft.sourceType,
    path: draft.path.trim(),
    body: draft.body,
    triggerMode: draft.triggerMode,
    hookStage: draft.triggerMode === 'hook' ? draft.hookStage : null,
    scheduleCron: draft.triggerMode === 'schedule' ? draft.scheduleCron.trim() : null,
    workDir: draft.workDir.trim(),
    timeoutSeconds: parseScriptTimeoutSeconds(draft.timeoutSeconds) ?? SCRIPT_DEFAULT_TIMEOUT_SECONDS,
    failAborts: draft.failAborts ? 1 : 0,
    contextInject: draft.contextInject,
    enabled: draft.enabled ? 1 : 0,
  };
}

export function scriptUpdateInputFromDraft(projectId: number, draft: ScriptDraftState): UpdateScriptInput {
  return { ...scriptCreateInputFromDraft(projectId, draft), scriptId: draft.id as number };
}

export type ComposerDrafts = Record<IntakeType, string>;

export const COMPOSER_DRAFT_STORAGE_PREFIX = 'autoplan.composerDrafts.';

export function emptyComposerDrafts(): ComposerDrafts {
  return { requirement: '', feedback: '' };
}

export function normalizeComposerDrafts(raw: unknown): ComposerDrafts {
  if (!raw || typeof raw !== 'object') return emptyComposerDrafts();
  const record = raw as Record<string, unknown>;
  return {
    requirement: typeof record.requirement === 'string' ? record.requirement : '',
    feedback: typeof record.feedback === 'string' ? record.feedback : '',
  };
}

export function composerDraftStorageKey(projectId: number): string | null {
  if (!Number.isInteger(projectId) || projectId <= 0) return null;
  return `${COMPOSER_DRAFT_STORAGE_PREFIX}${projectId}`;
}

export function loadComposerDrafts(projectId: number): ComposerDrafts {
  const storageKey = composerDraftStorageKey(projectId);
  if (!storageKey) return emptyComposerDrafts();
  try {
    const stored = window.localStorage.getItem(storageKey);
    if (!stored) return emptyComposerDrafts();
    return normalizeComposerDrafts(JSON.parse(stored));
  } catch {
    return emptyComposerDrafts();
  }
}
