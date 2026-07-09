import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import {
  DEFAULT_WORKSPACE_TAB,
  PENDING_ATTACHMENT_SOURCES,
  PLAN_EXECUTION_STRATEGIES,
  PLAN_GENERATION_STRATEGIES,
} from '../types';
import type {
  AgentCliOption,
  AgentCliProvider,
  AiConfigCreateInput,
  AiConfig,
  AiThinkingDepth,
  ChatConfig,
  ChatProvider,
  ClaudeCliConfigListItem,
  CodexReasoningEffort,
  CreateScriptInput,
  EnvVarEntry,
  Executor,
  ExecutorArg,
  ExecutorDependsOrder,
  ExecutorInput,
  ExecutorOptions,
  ExecutorPresentation,
  ExecutorProblemMatcher,
  ExecutorType,
  FileAccessScope,
  FileAccessSettings,
  IntakeType,
  LoopConfigInput,
  McpConfigInput,
  McpStatus,
  McpTransport,
  NewProjectDefaultCliPreferences,
  PendingAttachment,
  PlanBackendProvider,
  PlanExecutionStrategy,
  PlanGenerationInputFields,
  PlanGenerationStrategy,
  ProjectState,
  Script,
  ScriptContextInject,
  ScriptHookStage,
  ScriptRuntime,
  ScriptSourceType,
  ScriptTriggerMode,
  TerminalCreateInput,
  UpdateExecutorInput,
  UpdateScriptInput,
  WorkspacePlanReadState,
  WorkspaceTab,
} from '../types';
import { getFilePath, toSafeFileUrl } from '../components/shared';

const DEFAULT_OPENAI_MODEL = 'gpt-5.5';
const LEGACY_OPENAI_DEFAULT_MODELS = new Set(['gpt-4o']);

const workspaceTabIds: WorkspaceTab[] = [
  'overview',
  'requirement',
  'feedback',
  'acceptance',
  'tasks',
  'terminal',
  'executors',
  'scripts',
  'events',
  'settings',
  'chat',
];

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

export const planGenerationStrategyOptions: Array<SettingsChoiceOption<PlanGenerationStrategy>> = [
  {
    value: PLAN_GENERATION_STRATEGIES.EXTERNAL_CLI_MARKDOWN,
    label: '外部 CLI · Markdown',
    description: '沿用 CLI 生成确定性 Markdown 计划。',
  },
  {
    value: PLAN_GENERATION_STRATEGIES.EXTERNAL_CLI_STRUCTURED,
    label: '外部 CLI · 结构化',
    description: '外部 CLI 生成 PlanSpec 后渲染 Markdown。',
  },
  {
    value: PLAN_GENERATION_STRATEGIES.BUILTIN_LLM_STRUCTURED,
    label: '内置 LLM · 结构化',
    description: '使用内置 LLM 生成 PlanSpec，配置模型名称。',
  },
];

export const planExecutionStrategyOptions: Array<SettingsChoiceOption<PlanExecutionStrategy>> = [
  {
    value: PLAN_EXECUTION_STRATEGIES.EXTERNAL_CLI,
    label: '外部 CLI',
    description: '使用本机 CLI 执行计划任务。',
  },
  {
    value: PLAN_EXECUTION_STRATEGIES.BUILTIN_LLM,
    label: '内置 LLM',
    description: '阶段一仅保存配置，任务执行会明确失败。',
  },
];

export const externalPlanBackendProviderOptions: Array<SettingsChoiceOption<PlanBackendProvider>> = [
  { value: 'codex', label: 'Codex CLI', description: '默认 CLI，支持思考深度参数。' },
  { value: 'claude', label: 'Claude CLI', description: '使用本机 claude 命令。' },
  { value: 'opencode', label: 'OpenCode CLI', description: '使用本机 opencode 命令。' },
  { value: 'oh-my-pi', label: 'Oh My Pi CLI', description: '使用本机 omp 命令。' },
];

export const builtinPlanBackendProviderOptions: Array<SettingsChoiceOption<PlanBackendProvider>> = [
  { value: 'openai', label: 'OpenAI 兼容', description: 'OpenAI 或兼容 API 模型。' },
  { value: 'deepseek', label: 'DeepSeek', description: 'DeepSeek API 模型。' },
  { value: 'anthropic', label: 'Anthropic', description: 'Claude 系列模型。' },
];

export type ComposerPlanGenerationSelection = {
  strategy: PlanGenerationStrategy;
  provider: PlanBackendProvider;
  command: string;
  model: string;
  codexReasoningEffort: CodexReasoningEffort;
};

export function createDefaultPlanGenerationSelection(
  overrides: Partial<ComposerPlanGenerationSelection> = {},
): ComposerPlanGenerationSelection {
  const strategy = normalizePlanGenerationStrategy(overrides.strategy);
  const provider = normalizePlanBackendProvider(overrides.provider, strategy);
  return {
    strategy,
    provider,
    command: String(overrides.command ?? ''),
    model: String(overrides.model ?? (isBuiltinPlanGenerationStrategy(strategy) ? planBackendDefaultModel(provider) : '')),
    codexReasoningEffort: normalizeCodexReasoningEffort(overrides.codexReasoningEffort),
  };
}

export const defaultComposerPlanGenerationSelections: Record<IntakeType, ComposerPlanGenerationSelection> = {
  requirement: createDefaultPlanGenerationSelection(),
  feedback: createDefaultPlanGenerationSelection(),
};

export const NEW_PROJECT_DEFAULT_CLI_PREFERENCES_STORAGE_KEY = 'autoplan.newProjectDefaultCliPreferences';

export const defaultNewProjectDefaultCliPreferences: NewProjectDefaultCliPreferences = {
  agentCliProvider: 'codex',
  agentCliCommand: '',
  codexReasoningEffort: defaultCodexReasoningEffort,
  planGenerationStrategy: PLAN_GENERATION_STRATEGIES.EXTERNAL_CLI_MARKDOWN,
  planGenerationProvider: 'codex',
  planGenerationCommand: '',
  planGenerationModel: '',
  planGenerationCodexReasoningEffort: defaultCodexReasoningEffort,
  planExecutionStrategy: PLAN_EXECUTION_STRATEGIES.EXTERNAL_CLI,
  planExecutionProvider: 'codex',
  planExecutionCommand: '',
  planExecutionModel: '',
  planExecutionCodexReasoningEffort: defaultCodexReasoningEffort,
};

export type LoopFormState = {
  workspacePath: string;
  intervalSeconds: string;
  validationCommand: string;
  projectPrompt: string;
  agentCliProvider: string;
  agentCliCommand: string;
  codexReasoningEffort: CodexReasoningEffort;
  planGenerationStrategy: PlanGenerationStrategy;
  planGenerationProvider: PlanBackendProvider;
  planGenerationCommand: string;
  planGenerationModel: string;
  planGenerationCodexReasoningEffort: CodexReasoningEffort;
  // Claude CLI 自定义连接字段。authToken 输入框永不回填明文——hasAuthToken=true 时显示脱敏占位，
  // 用户输入新值才会覆盖；留空（且未 touch）时不下发字段，保留数据库原值。
  planGenerationClaudeBaseUrl: string;
  planGenerationClaudeAuthToken: string;
  planGenerationClaudeModel: string;
  planGenerationHasClaudeAuthToken: boolean;
  // Claude CLI 多配置（需求 #93）：所选 claude_cli_configs.id；0 = 未选（回退默认配置或内联字段）。
  planGenerationClaudeConfigId: number;
  planExecutionStrategy: PlanExecutionStrategy;
  planExecutionProvider: PlanBackendProvider;
  planExecutionCommand: string;
  planExecutionModel: string;
  planExecutionCodexReasoningEffort: CodexReasoningEffort;
  planExecutionClaudeBaseUrl: string;
  planExecutionClaudeAuthToken: string;
  planExecutionClaudeModel: string;
  planExecutionHasClaudeAuthToken: boolean;
  planExecutionClaudeConfigId: number;
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

/* ===================== 终端配置与快捷命令（工作区终端独立使用） ===================== */

export type TerminalSettingsFormState = {
  defaultProfile: string;
  initialCwd: string;
  fontSize: string;
  scrollbackLimit: string;
  retainOnExit: boolean;
  confirmBeforeKill: boolean;
};

export type TerminalCreateInputWithSettings = TerminalCreateInput & {
  scrollbackLimit?: number;
  retainOnExit?: boolean;
};

export type TerminalCommandShortcutSource = 'package' | 'script' | 'executor';

export type TerminalCommandShortcut = {
  id: string;
  source: TerminalCommandShortcutSource;
  label: string;
  command: string;
  cwd: string;
  description?: string;
};

export type TerminalPackageScriptsInput =
  | Record<string, string>
  | Array<{ name?: string; label?: string; command?: string; script?: string; value?: string }>;

export const TERMINAL_SETTINGS_STORAGE_PREFIX = 'autoplan.terminalSettings.';
export const TERMINAL_MIN_FONT_SIZE = 10;
export const TERMINAL_MAX_FONT_SIZE = 24;
export const TERMINAL_MIN_SCROLLBACK_LIMIT = 100;
export const TERMINAL_MAX_SCROLLBACK_LIMIT = 50000;

export const defaultTerminalSettingsForm: TerminalSettingsFormState = {
  defaultProfile: 'default',
  initialCwd: '',
  fontSize: '13',
  scrollbackLimit: '10000',
  retainOnExit: true,
  confirmBeforeKill: true,
};

export function normalizeTerminalSettingsForm(input?: Partial<TerminalSettingsFormState> | Record<string, unknown> | null): TerminalSettingsFormState {
  const source = isRecord(input) ? input : {};
  return {
    defaultProfile: normalizeTerminalProfileId(readTerminalField(source, 'defaultProfile')),
    initialCwd: limitTerminalText(String(readTerminalField(source, 'initialCwd') ?? defaultTerminalSettingsForm.initialCwd).trim(), 2048),
    fontSize: String(clampTerminalInteger(
      readTerminalField(source, 'fontSize'),
      Number(defaultTerminalSettingsForm.fontSize),
      TERMINAL_MIN_FONT_SIZE,
      TERMINAL_MAX_FONT_SIZE,
    )),
    scrollbackLimit: String(clampTerminalInteger(
      readTerminalField(source, 'scrollbackLimit'),
      Number(defaultTerminalSettingsForm.scrollbackLimit),
      TERMINAL_MIN_SCROLLBACK_LIMIT,
      TERMINAL_MAX_SCROLLBACK_LIMIT,
    )),
    retainOnExit: readTerminalBoolean(readTerminalField(source, 'retainOnExit'), defaultTerminalSettingsForm.retainOnExit),
    confirmBeforeKill: readTerminalBoolean(readTerminalField(source, 'confirmBeforeKill'), defaultTerminalSettingsForm.confirmBeforeKill),
  };
}

export function terminalSettingsStorageKey(projectId: number): string | null {
  if (!Number.isInteger(projectId) || projectId <= 0) return null;
  return `${TERMINAL_SETTINGS_STORAGE_PREFIX}${projectId}`;
}

export function loadTerminalSettings(projectId: number): TerminalSettingsFormState {
  const storageKey = terminalSettingsStorageKey(projectId);
  if (!storageKey || typeof window === 'undefined') return { ...defaultTerminalSettingsForm };
  try {
    const stored = window.localStorage.getItem(storageKey);
    return normalizeTerminalSettingsForm(stored ? JSON.parse(stored) : null);
  } catch {
    return { ...defaultTerminalSettingsForm };
  }
}

export function saveTerminalSettings(projectId: number, settings: Partial<TerminalSettingsFormState>): TerminalSettingsFormState {
  const normalized = normalizeTerminalSettingsForm(settings);
  const storageKey = terminalSettingsStorageKey(projectId);
  if (storageKey && typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(normalized));
    } catch { /* localStorage 不可用时仅保留当前会话状态 */ }
  }
  return normalized;
}

export function terminalSettingsFormsEqual(left: TerminalSettingsFormState, right: TerminalSettingsFormState) {
  return left.defaultProfile === right.defaultProfile
    && left.initialCwd === right.initialCwd
    && left.fontSize === right.fontSize
    && left.scrollbackLimit === right.scrollbackLimit
    && left.retainOnExit === right.retainOnExit
    && left.confirmBeforeKill === right.confirmBeforeKill;
}

export function terminalCreateInputFromSettings(
  projectId: number,
  settings: Partial<TerminalSettingsFormState>,
  input: Partial<TerminalCreateInputWithSettings> = {},
): TerminalCreateInputWithSettings {
  const normalized = normalizeTerminalSettingsForm(settings);
  const cwd = String(input.cwd ?? normalized.initialCwd).trim();
  const profileId = String(input.profileId ?? '').trim()
    || (normalized.defaultProfile === 'default' ? '' : normalized.defaultProfile);
  const payload: TerminalCreateInputWithSettings = {
    ...input,
    projectId,
    cwd: cwd || undefined,
    scrollbackLimit: clampTerminalInteger(
      input.scrollbackLimit ?? normalized.scrollbackLimit,
      Number(normalized.scrollbackLimit),
      TERMINAL_MIN_SCROLLBACK_LIMIT,
      TERMINAL_MAX_SCROLLBACK_LIMIT,
    ),
    retainOnExit: input.retainOnExit ?? normalized.retainOnExit,
  };
  if (profileId && !input.profile) payload.profileId = profileId;
  return payload;
}

export function buildTerminalCommandShortcuts(input: {
  packageScripts?: TerminalPackageScriptsInput | null;
  scripts?: Script[] | null;
  executors?: Executor[] | null;
  workspacePath?: string;
}): TerminalCommandShortcut[] {
  return dedupeTerminalShortcuts([
    ...terminalCommandShortcutsFromPackageScripts(input.packageScripts, input.workspacePath),
    ...terminalCommandShortcutsFromScripts(input.scripts, input.workspacePath),
    ...terminalCommandShortcutsFromExecutors(input.executors, input.workspacePath),
  ]);
}

export function terminalCommandShortcutsFromPackageScripts(
  packageScripts?: TerminalPackageScriptsInput | null,
  workspacePath = '',
): TerminalCommandShortcut[] {
  const rows = Array.isArray(packageScripts)
    ? packageScripts.map((item) => ({
      name: String(item.name ?? item.label ?? '').trim(),
      script: String(item.command ?? item.script ?? item.value ?? '').trim(),
    }))
    : Object.entries(packageScripts || {}).map(([name, script]) => ({
      name: String(name || '').trim(),
      script: String(script || '').trim(),
    }));

  return rows
    .filter((item) => item.name)
    .map((item) => ({
      id: `package:${slugTerminalText(item.name)}`,
      source: 'package' as const,
      label: `npm: ${item.name}`,
      command: `npm run ${quoteTerminalArg(item.name)}`,
      cwd: String(workspacePath || '').trim(),
      description: item.script,
    }));
}

export function terminalCommandShortcutsFromScripts(
  scripts?: Script[] | null,
  workspacePath = '',
): TerminalCommandShortcut[] {
  if (!Array.isArray(scripts)) return [];
  return scripts
    .filter((script) => readTerminalBoolean(script.enabled, true))
    .map((script) => {
      const sourceType = String(script.source_type ?? script.sourceType ?? 'inline');
      const scriptPath = String(script.path || '').trim();
      if (sourceType !== 'file' || !scriptPath) return null;
      const command = scriptFileCommand(script.runtime, scriptPath);
      const name = String(script.name || scriptPath.split(/[\\/]/).pop() || command).trim();
      return {
        id: `script:${Number.isFinite(Number(script.id)) ? script.id : slugTerminalText(name)}`,
        source: 'script' as const,
        label: `脚本: ${name}`,
        command,
        cwd: resolveTerminalCwd(script.work_dir ?? script.workDir ?? '', workspacePath),
        description: script.description || '',
      };
    })
    .filter(isPresent);
}

export function terminalCommandShortcutsFromExecutors(
  executors?: Executor[] | null,
  workspacePath = '',
): TerminalCommandShortcut[] {
  if (!Array.isArray(executors)) return [];
  return executors
    .filter((executor) => readTerminalBoolean(executor.enabled, true))
    .map((executor) => {
      const command = String(executor.command || '').trim();
      if (!command) return null;
      const args = Array.isArray(executor.args) ? executor.args : [];
      const argsText = args.map(terminalExecutorArgText).filter(Boolean).join(' ');
      const label = String(executor.label || command).trim();
      return {
        id: `executor:${Number.isFinite(Number(executor.id)) ? executor.id : slugTerminalText(label)}`,
        source: 'executor' as const,
        label: `执行器: ${label}`,
        command: [command, argsText].filter(Boolean).join(' '),
        cwd: resolveTerminalCwd(executor.options?.cwd || '', workspacePath),
        description: executor.group?.kind || executor.type || '',
      };
    })
    .filter(isPresent);
}

export function terminalShortcutCommandText(shortcut: TerminalCommandShortcut | null | undefined): string {
  return String(shortcut?.command || '').trim();
}

function isPresent<T>(value: T | null | undefined): value is T {
  return value !== null && typeof value !== 'undefined';
}

function readTerminalField(source: Record<string, unknown>, name: string): unknown {
  return firstDefined(readValue(source, name), readValue(source, `terminal.${name}`), undefined);
}

function normalizeTerminalProfileId(value: unknown): string {
  const id = String(value ?? defaultTerminalSettingsForm.defaultProfile)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return id || defaultTerminalSettingsForm.defaultProfile;
}

function readTerminalBoolean(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null || value === '') return fallback;
  if (value === false || value === 0) return false;
  return !['0', 'false', 'off', 'no', 'disabled'].includes(String(value).trim().toLowerCase());
}

function clampTerminalInteger(value: unknown, fallback: number, min: number, max: number): number {
  const number = Number(value);
  const integer = Number.isFinite(number) ? Math.floor(number) : fallback;
  return Math.min(max, Math.max(min, integer));
}

function limitTerminalText(value: string, maxLength: number): string {
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

function dedupeTerminalShortcuts(shortcuts: TerminalCommandShortcut[]): TerminalCommandShortcut[] {
  const seen = new Set<string>();
  const result: TerminalCommandShortcut[] = [];
  for (const shortcut of shortcuts) {
    const key = `${shortcut.source}:${shortcut.id}:${shortcut.command}`;
    if (!shortcut.command || seen.has(key)) continue;
    seen.add(key);
    result.push(shortcut);
  }
  return result;
}

function scriptFileCommand(runtime: ScriptRuntime, scriptPath: string): string {
  const quotedPath = quoteTerminalArg(scriptPath);
  if (runtime === 'bash') return `bash ${quotedPath}`;
  if (runtime === 'ps') return `powershell -NoProfile -ExecutionPolicy Bypass -File ${quotedPath}`;
  if (runtime === 'cmd') return `cmd /c ${quotedPath}`;
  return `node ${quotedPath}`;
}

function terminalExecutorArgText(arg: ExecutorArg): string {
  if (typeof arg === 'string') return quoteTerminalArg(arg);
  const value = String(arg?.value ?? '');
  if (!value) return '';
  if (arg.quoting === 'strong') return `'${value.replace(/'/g, "'\"'\"'")}'`;
  if (arg.quoting === 'weak') return `"${value.replace(/(["\\$`])/g, '\\$1')}"`;
  return quoteTerminalArg(value);
}

function quoteTerminalArg(value: string): string {
  const text = String(value || '');
  if (!text) return '';
  if (!/[\s"'`$&|<>()[\]{};]/.test(text)) return text;
  return `"${text.replace(/(["\\$`])/g, '\\$1')}"`;
}

function resolveTerminalCwd(cwd: string, workspacePath = ''): string {
  return resolveExecutorCwdHint(cwd, workspacePath).resolved || String(cwd || workspacePath || '').trim();
}

function slugTerminalText(value: string): string {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'command';
}

/* ===================== 文件访问范围 draft 表单（设置面板，需求 #35） ===================== */

export type FileAccessFormState = {
  scope: FileAccessScope;
  allowCrossProject: boolean;
  allowedRoots: string[];
};

/** 默认文件访问设置：默认安全，仅当前项目工作区 */
export const defaultFileAccessSettings: FileAccessFormState = {
  scope: 'project',
  allowCrossProject: false,
  allowedRoots: [],
};

export const fileAccessScopeOptions: Array<SettingsChoiceOption<FileAccessScope>> = [
  { value: 'project', label: '仅当前项目', description: '默认安全，仅可访问当前项目工作区。' },
  { value: 'workspace', label: '工作区', description: '当前项目为单根，等同于仅当前项目。' },
  { value: 'custom', label: '自定义白名单', description: '当前项目工作区 + 额外白名单根目录。' },
  { value: 'all', label: '不限制', description: '访问不受应用层限制，高风险。' },
];

/** 将存储值归一化为合法 scope；非法值回退 project */
export function normalizeFileAccessScope(value?: string | null): FileAccessScope {
  const scope = String(value || '').trim().toLowerCase();
  return scope === 'workspace' || scope === 'custom' || scope === 'all' ? scope : 'project';
}

/** 从 file-access:get 返回的快照构造表单 draft */
export function fileAccessFormFromSettings(settings?: FileAccessSettings | null): FileAccessFormState {
  if (!settings) return { ...defaultFileAccessSettings, allowedRoots: [] };
  const roots = Array.isArray(settings.allowedRoots)
    ? settings.allowedRoots.filter((root): root is string => typeof root === 'string')
    : [];
  return {
    scope: normalizeFileAccessScope(settings.scope),
    allowCrossProject: Boolean(settings.allowCrossProject),
    allowedRoots: roots,
  };
}

/** 比较两个文件访问表单 draft 是否一致（用于脏检测） */
export function fileAccessFormsEqual(a: FileAccessFormState, b: FileAccessFormState): boolean {
  if (a.scope !== b.scope) return false;
  if (a.allowCrossProject !== b.allowCrossProject) return false;
  if (a.allowedRoots.length !== b.allowedRoots.length) return false;
  return a.allowedRoots.every((root, i) => root === b.allowedRoots[i]);
}

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

export function normalizeAgentCliProvider(value?: string | null): AgentCliProvider {
  const provider = String(value || '').trim().toLowerCase();
  if (provider === 'claude' || provider === 'opencode' || provider === 'oh-my-pi') return provider;
  return 'codex';
}

export function isCodexAgentCliProvider(provider?: string | null) {
  return normalizeAgentCliProvider(provider) === 'codex';
}

export function agentCliDefaultCommand(provider?: string | null) {
  const normalized = normalizeAgentCliProvider(provider);
  if (normalized === 'claude') return 'claude';
  if (normalized === 'opencode') return 'opencode';
  if (normalized === 'oh-my-pi') return 'omp';
  return 'codex';
}

export function normalizePlanGenerationStrategy(value?: string | null): PlanGenerationStrategy {
  const strategy = String(value || '').trim().toLowerCase();
  if (strategy === PLAN_GENERATION_STRATEGIES.EXTERNAL_CLI_STRUCTURED) return PLAN_GENERATION_STRATEGIES.EXTERNAL_CLI_STRUCTURED;
  if (strategy === PLAN_GENERATION_STRATEGIES.BUILTIN_LLM_STRUCTURED) return PLAN_GENERATION_STRATEGIES.BUILTIN_LLM_STRUCTURED;
  return PLAN_GENERATION_STRATEGIES.EXTERNAL_CLI_MARKDOWN;
}

export function normalizePlanExecutionStrategy(value?: string | null): PlanExecutionStrategy {
  const strategy = String(value || '').trim().toLowerCase();
  if (strategy === PLAN_EXECUTION_STRATEGIES.BUILTIN_LLM) return PLAN_EXECUTION_STRATEGIES.BUILTIN_LLM;
  return PLAN_EXECUTION_STRATEGIES.EXTERNAL_CLI;
}

export function isBuiltinPlanGenerationStrategy(strategy?: string | null) {
  return normalizePlanGenerationStrategy(strategy) === PLAN_GENERATION_STRATEGIES.BUILTIN_LLM_STRUCTURED;
}

export function isExternalPlanGenerationStrategy(strategy?: string | null) {
  return !isBuiltinPlanGenerationStrategy(strategy);
}

export function isBuiltinPlanExecutionStrategy(strategy?: string | null) {
  return normalizePlanExecutionStrategy(strategy) === PLAN_EXECUTION_STRATEGIES.BUILTIN_LLM;
}

export function isExternalPlanExecutionStrategy(strategy?: string | null) {
  return !isBuiltinPlanExecutionStrategy(strategy);
}

export function isBuiltinPlanBackendStrategy(strategy?: string | null) {
  const value = String(strategy || '').trim().toLowerCase();
  return value === PLAN_GENERATION_STRATEGIES.BUILTIN_LLM_STRUCTURED || value === PLAN_EXECUTION_STRATEGIES.BUILTIN_LLM;
}

export function normalizePlanBackendProvider(
  value?: string | null,
  strategy?: string | null,
): PlanBackendProvider {
  const provider = String(value || '').trim().toLowerCase();
  if (isBuiltinPlanBackendStrategy(strategy)) {
    if (provider === 'deepseek' || provider === 'anthropic') return provider;
    return 'openai';
  }
  if (provider === 'claude' || provider === 'opencode' || provider === 'oh-my-pi') return provider;
  return 'codex';
}

export function isCodexPlanBackendProvider(provider?: string | null) {
  return String(provider || '').trim().toLowerCase() === 'codex';
}

export function planBackendDefaultCommand(provider?: string | null) {
  return agentCliDefaultCommand(provider);
}

export function planBackendDefaultModel(provider?: string | null) {
  const normalized = normalizePlanBackendProvider(provider, PLAN_GENERATION_STRATEGIES.BUILTIN_LLM_STRUCTURED);
  return defaultModelForProvider(normalized);
}

export function planBackendProviderOptionsForStrategy(strategy?: string | null): Array<SettingsChoiceOption<PlanBackendProvider>> {
  return isBuiltinPlanBackendStrategy(strategy) ? builtinPlanBackendProviderOptions : externalPlanBackendProviderOptions;
}

export function defaultPlanBackendProviderForStrategy(strategy?: string | null): PlanBackendProvider {
  return isBuiltinPlanBackendStrategy(strategy) ? 'openai' : 'codex';
}

export function planGenerationStrategyLabel(strategy?: string | null) {
  const normalized = normalizePlanGenerationStrategy(strategy);
  return planGenerationStrategyOptions.find((option) => option.value === normalized)?.label || normalized;
}

export function planExecutionStrategyLabel(strategy?: string | null) {
  const normalized = normalizePlanExecutionStrategy(strategy);
  return planExecutionStrategyOptions.find((option) => option.value === normalized)?.label || normalized;
}

export function planBackendProviderLabel(provider?: string | null) {
  const value = String(provider || '').trim().toLowerCase();
  const option = [...externalPlanBackendProviderOptions, ...builtinPlanBackendProviderOptions]
    .find((item) => item.value === value);
  return option?.label || agentCliOptionDetails.find((item) => item.value === normalizeAgentCliProvider(value))?.label || 'Codex CLI';
}

export function normalizeNewProjectDefaultCliPreferences(
  input?: Partial<NewProjectDefaultCliPreferences> | Record<string, unknown> | null,
): NewProjectDefaultCliPreferences {
  const source = isRecord(input) ? input : {};
  const planGenerationStrategy = normalizePlanGenerationStrategy(readNewProjectDefaultString(
    source,
    'planGenerationStrategy',
    'plan_generation_strategy',
  ));
  const planGenerationProvider = normalizePlanBackendProvider(
    readNewProjectDefaultString(source, 'planGenerationProvider', 'plan_generation_provider'),
    planGenerationStrategy,
  );
  const planExecutionStrategy = normalizePlanExecutionStrategy(readNewProjectDefaultString(
    source,
    'planExecutionStrategy',
    'plan_execution_strategy',
  ));
  const planExecutionProvider = normalizePlanBackendProvider(
    readNewProjectDefaultString(source, 'planExecutionProvider', 'plan_execution_provider'),
    planExecutionStrategy,
  );
  const planGenerationCodexReasoningEffort = isCodexPlanBackendProvider(planGenerationProvider)
    ? normalizeCodexReasoningEffort(firstNonEmptyString(
        readNewProjectDefaultString(source, 'planGenerationCodexReasoningEffort', 'plan_generation_codex_reasoning_effort'),
        readNewProjectDefaultString(source, 'codexReasoningEffort', 'codex_reasoning_effort'),
      ))
    : null;
  const planExecutionCodexReasoningEffort = isCodexPlanBackendProvider(planExecutionProvider)
    ? normalizeCodexReasoningEffort(firstNonEmptyString(
        readNewProjectDefaultString(source, 'planExecutionCodexReasoningEffort', 'plan_execution_codex_reasoning_effort'),
        readNewProjectDefaultString(source, 'codexReasoningEffort', 'codex_reasoning_effort'),
      ))
    : null;
  const agentCliProvider = normalizeAgentCliProvider(firstNonEmptyString(
    readNewProjectDefaultString(source, 'agentCliProvider', 'agent_cli_provider'),
    isExternalPlanExecutionStrategy(planExecutionStrategy) ? planExecutionProvider : '',
  ));
  const agentCliCommand = firstNonEmptyString(
    readNewProjectDefaultString(source, 'agentCliCommand', 'agent_cli_command'),
    isExternalPlanExecutionStrategy(planExecutionStrategy)
      ? readNewProjectDefaultString(source, 'planExecutionCommand', 'plan_execution_command')
      : '',
  ).trim();
  const codexReasoningEffort = agentCliProvider === 'codex'
    ? normalizeCodexReasoningEffort(firstNonEmptyString(
        readNewProjectDefaultString(source, 'codexReasoningEffort', 'codex_reasoning_effort'),
        planExecutionCodexReasoningEffort || '',
        planGenerationCodexReasoningEffort || '',
      ))
    : null;

  return {
    agentCliProvider,
    agentCliCommand,
    codexReasoningEffort,
    planGenerationStrategy,
    planGenerationProvider,
    planGenerationCommand: isExternalPlanGenerationStrategy(planGenerationStrategy)
      ? readNewProjectDefaultString(source, 'planGenerationCommand', 'plan_generation_command').trim()
      : '',
    planGenerationModel: isBuiltinPlanGenerationStrategy(planGenerationStrategy)
      ? firstNonEmptyString(
          readNewProjectDefaultString(source, 'planGenerationModel', 'plan_generation_model'),
          planBackendDefaultModel(planGenerationProvider),
        )
      : '',
    planGenerationCodexReasoningEffort,
    planExecutionStrategy,
    planExecutionProvider,
    planExecutionCommand: isExternalPlanExecutionStrategy(planExecutionStrategy)
      ? readNewProjectDefaultString(source, 'planExecutionCommand', 'plan_execution_command').trim()
      : '',
    planExecutionModel: isBuiltinPlanExecutionStrategy(planExecutionStrategy)
      ? firstNonEmptyString(
          readNewProjectDefaultString(source, 'planExecutionModel', 'plan_execution_model'),
          planBackendDefaultModel(planExecutionProvider),
        )
      : '',
    planExecutionCodexReasoningEffort,
  };
}

export function newProjectDefaultCliPreferencesStorageKey(): string {
  return NEW_PROJECT_DEFAULT_CLI_PREFERENCES_STORAGE_KEY;
}

export function loadNewProjectDefaultCliPreferences(): NewProjectDefaultCliPreferences {
  if (typeof window === 'undefined') return { ...defaultNewProjectDefaultCliPreferences };
  try {
    const stored = window.localStorage.getItem(NEW_PROJECT_DEFAULT_CLI_PREFERENCES_STORAGE_KEY);
    return normalizeNewProjectDefaultCliPreferences(stored ? JSON.parse(stored) : null);
  } catch {
    return { ...defaultNewProjectDefaultCliPreferences };
  }
}

export function saveNewProjectDefaultCliPreferences(
  preferences: Partial<NewProjectDefaultCliPreferences> | Record<string, unknown>,
): NewProjectDefaultCliPreferences {
  const normalized = normalizeNewProjectDefaultCliPreferences(preferences);
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(
        NEW_PROJECT_DEFAULT_CLI_PREFERENCES_STORAGE_KEY,
        JSON.stringify(newProjectDefaultCliPreferencesForStorage(normalized)),
      );
    } catch { /* localStorage 不可用时仅保留当前会话状态 */ }
  }
  return normalized;
}

export function newProjectDefaultCliPreferencesForStorage(
  preferences: Partial<NewProjectDefaultCliPreferences> | Record<string, unknown>,
): Record<string, string> {
  const normalized = normalizeNewProjectDefaultCliPreferences(preferences);
  const stored: Record<string, string> = {
    agentCliProvider: normalized.agentCliProvider,
    agentCliCommand: normalized.agentCliCommand,
    planGenerationStrategy: normalized.planGenerationStrategy,
    planGenerationProvider: normalized.planGenerationProvider,
    planGenerationCommand: normalized.planGenerationCommand,
    planGenerationModel: normalized.planGenerationModel,
    planExecutionStrategy: normalized.planExecutionStrategy,
    planExecutionProvider: normalized.planExecutionProvider,
    planExecutionCommand: normalized.planExecutionCommand,
    planExecutionModel: normalized.planExecutionModel,
  };
  if (normalized.codexReasoningEffort) stored.codexReasoningEffort = normalized.codexReasoningEffort;
  if (normalized.planGenerationCodexReasoningEffort) {
    stored.planGenerationCodexReasoningEffort = normalized.planGenerationCodexReasoningEffort;
  }
  if (normalized.planExecutionCodexReasoningEffort) {
    stored.planExecutionCodexReasoningEffort = normalized.planExecutionCodexReasoningEffort;
  }
  return stored;
}

function readNewProjectDefaultValue(source: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(source, key)) return source[key];
  }
  return undefined;
}

function readNewProjectDefaultString(source: Record<string, unknown>, ...keys: string[]): string {
  return String(readNewProjectDefaultValue(source, ...keys) ?? '');
}

function firstNonEmptyString(...values: Array<string | null | undefined>) {
  for (const value of values) {
    const text = String(value ?? '').trim();
    if (text) return text;
  }
  return '';
}

function generationSelectionFromSource(source: ProjectState | null | undefined): ComposerPlanGenerationSelection {
  const legacyProvider = normalizeAgentCliProvider(source?.agent_cli_provider);
  const legacyCommand = String(source?.agent_cli_command || '');
  const legacyReasoning = normalizeCodexReasoningEffort(source?.codex_reasoning_effort);
  const strategy = normalizePlanGenerationStrategy(source?.plan_generation_strategy);
  const provider = normalizePlanBackendProvider(firstNonEmptyString(source?.plan_generation_provider, legacyProvider), strategy);
  return createDefaultPlanGenerationSelection({
    strategy,
    provider,
    command: isExternalPlanGenerationStrategy(strategy)
      ? firstNonEmptyString(source?.plan_generation_command, legacyCommand)
      : String(source?.plan_generation_command || ''),
    model: isBuiltinPlanGenerationStrategy(strategy)
      ? firstNonEmptyString(source?.plan_generation_model, planBackendDefaultModel(provider))
      : String(source?.plan_generation_model || ''),
    codexReasoningEffort: isCodexPlanBackendProvider(provider)
      ? normalizeCodexReasoningEffort(firstNonEmptyString(source?.plan_generation_codex_reasoning_effort, legacyReasoning))
      : defaultCodexReasoningEffort,
  });
}

function composerGenerationSelectionFromSource(source: ProjectState | null | undefined): ComposerPlanGenerationSelection {
  const sourceStrategy = normalizePlanGenerationStrategy(source?.plan_generation_strategy);
  const strategy = isExternalPlanGenerationStrategy(sourceStrategy)
    ? sourceStrategy
    : PLAN_GENERATION_STRATEGIES.EXTERNAL_CLI_MARKDOWN;
  const legacyProvider = normalizeAgentCliProvider(source?.agent_cli_provider);
  const legacyCommand = String(source?.agent_cli_command || '');
  const legacyReasoning = normalizeCodexReasoningEffort(source?.codex_reasoning_effort);
  const provider = normalizePlanBackendProvider(
    isExternalPlanGenerationStrategy(sourceStrategy)
      ? firstNonEmptyString(source?.plan_generation_provider, legacyProvider)
      : legacyProvider,
    strategy,
  );
  return createDefaultPlanGenerationSelection({
    strategy,
    provider,
    command: isExternalPlanGenerationStrategy(sourceStrategy)
      ? firstNonEmptyString(source?.plan_generation_command, legacyCommand)
      : legacyCommand,
    model: '',
    codexReasoningEffort: isCodexPlanBackendProvider(provider)
      ? normalizeCodexReasoningEffort(
          isExternalPlanGenerationStrategy(sourceStrategy)
            ? firstNonEmptyString(source?.plan_generation_codex_reasoning_effort, legacyReasoning)
            : legacyReasoning,
        )
      : defaultCodexReasoningEffort,
  });
}

export function composerPlanGenerationSelectionFromProjectState(
  state: ProjectState | null | undefined,
): ComposerPlanGenerationSelection {
  return composerGenerationSelectionFromSource(state);
}

export function planGenerationInputFromComposerSelection(
  selection: ComposerPlanGenerationSelection,
): PlanGenerationInputFields {
  const selectedStrategy = normalizePlanGenerationStrategy(selection.strategy);
  const strategy = isExternalPlanGenerationStrategy(selectedStrategy)
    ? selectedStrategy
    : PLAN_GENERATION_STRATEGIES.EXTERNAL_CLI_MARKDOWN;
  const provider = normalizePlanBackendProvider(selection.provider, strategy);
  const input: PlanGenerationInputFields = {
    planGenerationStrategy: strategy,
    planGenerationProvider: provider,
    planGenerationCommand: selection.command.trim(),
    planGenerationModel: '',
    planGenerationCodexReasoningEffort: isCodexPlanBackendProvider(provider)
      ? normalizeCodexReasoningEffort(selection.codexReasoningEffort)
      : null,
  };
  return input;
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
  const legacyProvider = normalizeAgentCliProvider(state.agent_cli_provider);
  const legacyCommand = String(state.agent_cli_command || '');
  const legacyReasoning = normalizeCodexReasoningEffort(state.codex_reasoning_effort);
  const planGeneration = generationSelectionFromSource(state);
  const planExecutionStrategy = normalizePlanExecutionStrategy(state.plan_execution_strategy);
  const planExecutionProvider = normalizePlanBackendProvider(
    firstNonEmptyString(state.plan_execution_provider, legacyProvider),
    planExecutionStrategy,
  );
  const planExecutionCommand = isExternalPlanExecutionStrategy(planExecutionStrategy)
    ? firstNonEmptyString(state.plan_execution_command, legacyCommand)
    : String(state.plan_execution_command || '');
  const planExecutionModel = isBuiltinPlanExecutionStrategy(planExecutionStrategy)
    ? firstNonEmptyString(state.plan_execution_model, planBackendDefaultModel(planExecutionProvider))
    : String(state.plan_execution_model || '');
  const planExecutionReasoning = isCodexPlanBackendProvider(planExecutionProvider)
    ? normalizeCodexReasoningEffort(firstNonEmptyString(state.plan_execution_codex_reasoning_effort, legacyReasoning))
    : defaultCodexReasoningEffort;

  // Claude 自定义连接：baseUrl/model 直接回填；authToken 永不回填明文，仅读 has 标志位（来自 snapshot 脱敏）。
  const planGenerationClaudeBaseUrl = String(state.plan_generation_claude_base_url || '');
  const planGenerationClaudeModel = String(state.plan_generation_claude_model || '');
  const planGenerationHasClaudeAuthToken = Boolean(state.plan_generation_has_claude_auth_token);
  const planExecutionClaudeBaseUrl = String(state.plan_execution_claude_base_url || '');
  const planExecutionClaudeModel = String(state.plan_execution_claude_model || '');
  const planExecutionHasClaudeAuthToken = Boolean(state.plan_execution_has_claude_auth_token);
  // Claude 多配置 id（需求 #93）：从快照 *_claude_config_id 回填，归一为非负整数（0 = 未选）。
  const planGenerationClaudeConfigId = normalizeClaudeConfigIdValue(state.plan_generation_claude_config_id);
  const planExecutionClaudeConfigId = normalizeClaudeConfigIdValue(state.plan_execution_claude_config_id);

  return {
    workspacePath: state.workspace_path || '',
    intervalSeconds: String(state.interval_seconds || 5),
    validationCommand: state.validation_command ?? '',
    projectPrompt: state.project_prompt ?? '',
    agentCliProvider: legacyProvider,
    agentCliCommand: legacyCommand,
    codexReasoningEffort: legacyReasoning,
    planGenerationStrategy: planGeneration.strategy,
    planGenerationProvider: planGeneration.provider,
    planGenerationCommand: planGeneration.command,
    planGenerationModel: planGeneration.model,
    planGenerationCodexReasoningEffort: planGeneration.codexReasoningEffort,
    planGenerationClaudeBaseUrl,
    planGenerationClaudeAuthToken: '',
    planGenerationClaudeModel,
    planGenerationHasClaudeAuthToken,
    planGenerationClaudeConfigId,
    planExecutionStrategy,
    planExecutionProvider,
    planExecutionCommand,
    planExecutionModel,
    planExecutionCodexReasoningEffort: planExecutionReasoning,
    planExecutionClaudeBaseUrl,
    planExecutionClaudeAuthToken: '',
    planExecutionClaudeModel,
    planExecutionHasClaudeAuthToken,
    planExecutionClaudeConfigId,
    envVars,
  };
}

export function loopConfigurePayloadFromForm(projectId: number, form: LoopFormState): LoopConfigInput {
  const planGenerationStrategy = normalizePlanGenerationStrategy(form.planGenerationStrategy);
  const planGenerationProvider = normalizePlanBackendProvider(form.planGenerationProvider, planGenerationStrategy);
  const planExecutionStrategy = normalizePlanExecutionStrategy(form.planExecutionStrategy);
  const planExecutionProvider = normalizePlanBackendProvider(form.planExecutionProvider, planExecutionStrategy);
  const legacyProvider = isExternalPlanExecutionStrategy(planExecutionStrategy)
    ? normalizeAgentCliProvider(planExecutionProvider)
    : isExternalPlanGenerationStrategy(planGenerationStrategy)
      ? normalizeAgentCliProvider(planGenerationProvider)
      : normalizeAgentCliProvider(form.agentCliProvider);
  const legacyCommand = isExternalPlanExecutionStrategy(planExecutionStrategy)
    ? form.planExecutionCommand
    : isExternalPlanGenerationStrategy(planGenerationStrategy)
      ? form.planGenerationCommand
      : form.agentCliCommand;
  const legacyReasoning = legacyProvider === 'codex'
    ? (isExternalPlanExecutionStrategy(planExecutionStrategy) && planExecutionProvider === 'codex'
        ? form.planExecutionCodexReasoningEffort
        : form.planGenerationCodexReasoningEffort)
    : defaultCodexReasoningEffort;
  const payload: LoopConfigInput = {
    projectId,
    workspacePath: form.workspacePath,
    intervalSeconds: Number(form.intervalSeconds || 5),
    validationCommand: form.validationCommand,
    projectPrompt: form.projectPrompt,
    agentCliProvider: legacyProvider,
    agentCliCommand: legacyCommand.trim(),
    planGenerationStrategy,
    planGenerationProvider,
    planGenerationCommand: isExternalPlanGenerationStrategy(planGenerationStrategy) ? form.planGenerationCommand.trim() : '',
    planGenerationModel: isBuiltinPlanGenerationStrategy(planGenerationStrategy)
      ? (form.planGenerationModel.trim() || planBackendDefaultModel(planGenerationProvider))
      : '',
    planGenerationCodexReasoningEffort: planGenerationProvider === 'codex'
      ? normalizeCodexReasoningEffort(form.planGenerationCodexReasoningEffort)
      : null,
    planExecutionStrategy,
    planExecutionProvider,
    planExecutionCommand: isExternalPlanExecutionStrategy(planExecutionStrategy) ? form.planExecutionCommand.trim() : '',
    planExecutionModel: isBuiltinPlanExecutionStrategy(planExecutionStrategy)
      ? (form.planExecutionModel.trim() || planBackendDefaultModel(planExecutionProvider))
      : '',
    planExecutionCodexReasoningEffort: planExecutionProvider === 'codex'
      ? normalizeCodexReasoningEffort(form.planExecutionCodexReasoningEffort)
      : null,
    // Claude 自定义连接：仅在外部 CLI（claude provider）下生效。baseUrl/model 总是下发（空串=清空）；
    // authToken 仅在用户输入新值时下发，留空则不下发以保留数据库原值（后端 hasAnyOwnProperty 判断是否更新）。
    planGenerationClaudeBaseUrl: isExternalPlanGenerationStrategy(planGenerationStrategy)
      ? form.planGenerationClaudeBaseUrl.trim()
      : '',
    planGenerationClaudeModel: isExternalPlanGenerationStrategy(planGenerationStrategy)
      ? form.planGenerationClaudeModel.trim()
      : '',
    planExecutionClaudeBaseUrl: isExternalPlanExecutionStrategy(planExecutionStrategy)
      ? form.planExecutionClaudeBaseUrl.trim()
      : '',
    planExecutionClaudeModel: isExternalPlanExecutionStrategy(planExecutionStrategy)
      ? form.planExecutionClaudeModel.trim()
      : '',
    // Claude 多配置 id（需求 #93）：仅 claude provider + 外部 CLI 策略下下发所选 id；
    // 切到非 claude provider 或非外部 CLI 策略时清 0（解除关联，后端回退默认/内联）。
    planGenerationClaudeConfigId: isExternalPlanGenerationStrategy(planGenerationStrategy) && planGenerationProvider === 'claude'
      ? normalizeClaudeConfigIdValue(form.planGenerationClaudeConfigId)
      : 0,
    planExecutionClaudeConfigId: isExternalPlanExecutionStrategy(planExecutionStrategy) && planExecutionProvider === 'claude'
      ? normalizeClaudeConfigIdValue(form.planExecutionClaudeConfigId)
      : 0,
  };
  // authToken 单独处理：仅当用户填写了新值才下发。留空表示「不改动」（保留数据库原值）。
  const genAuthToken = form.planGenerationClaudeAuthToken.trim();
  if (genAuthToken) payload.planGenerationClaudeAuthToken = genAuthToken;
  const execAuthToken = form.planExecutionClaudeAuthToken.trim();
  if (execAuthToken) payload.planExecutionClaudeAuthToken = execAuthToken;
  if (legacyProvider === 'codex') {
    payload.codexReasoningEffort = normalizeCodexReasoningEffort(legacyReasoning);
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
    && left.projectPrompt === right.projectPrompt
    && left.agentCliProvider === right.agentCliProvider
    && left.agentCliCommand === right.agentCliCommand
    && left.codexReasoningEffort === right.codexReasoningEffort
    && left.planGenerationStrategy === right.planGenerationStrategy
    && left.planGenerationProvider === right.planGenerationProvider
    && left.planGenerationCommand === right.planGenerationCommand
    && left.planGenerationModel === right.planGenerationModel
    && left.planGenerationCodexReasoningEffort === right.planGenerationCodexReasoningEffort
    && left.planGenerationClaudeBaseUrl === right.planGenerationClaudeBaseUrl
    && left.planGenerationClaudeAuthToken === right.planGenerationClaudeAuthToken
    && left.planGenerationClaudeModel === right.planGenerationClaudeModel
    && left.planGenerationHasClaudeAuthToken === right.planGenerationHasClaudeAuthToken
    && left.planGenerationClaudeConfigId === right.planGenerationClaudeConfigId
    && left.planExecutionStrategy === right.planExecutionStrategy
    && left.planExecutionProvider === right.planExecutionProvider
    && left.planExecutionCommand === right.planExecutionCommand
    && left.planExecutionModel === right.planExecutionModel
    && left.planExecutionCodexReasoningEffort === right.planExecutionCodexReasoningEffort
    && left.planExecutionClaudeBaseUrl === right.planExecutionClaudeBaseUrl
    && left.planExecutionClaudeAuthToken === right.planExecutionClaudeAuthToken
    && left.planExecutionClaudeModel === right.planExecutionClaudeModel
    && left.planExecutionHasClaudeAuthToken === right.planExecutionHasClaudeAuthToken
    && left.planExecutionClaudeConfigId === right.planExecutionClaudeConfigId
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

/** 归一化 Claude 配置 id：正整数取 floor，其余（undefined/null/''/0/负数/NaN）归 0（未选）。 */
export function normalizeClaudeConfigIdValue(value: unknown): number {
  if (value === undefined || value === null || value === '') return 0;
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return 0;
  return Math.floor(num);
}

/**
 * Claude 配置下拉选择联动（需求 #93）：给定配置列表与所选 id，返回所选配置的 baseUrl/model，
 * 以及基于配置 hasAuthToken 的脱敏标志。authToken 永不回填明文（由调用方把表单 authToken 字段置空）。
 * 未选（id<=0）或列表中未命中时返回 null，由调用方决定回退（默认配置或清空）。
 */
export type ClaudeConfigSelectionFields = {
  baseUrl: string;
  model: string;
  hasAuthToken: boolean;
};

export function resolveClaudeConfigSelection(
  configs: ClaudeCliConfigListItem[] | null | undefined,
  selectedId: number | null | undefined,
): ClaudeConfigSelectionFields | null {
  if (!Array.isArray(configs) || configs.length === 0) return null;
  const id = normalizeClaudeConfigIdValue(selectedId);
  if (id <= 0) return null;
  const matched = configs.find((config) => normalizeClaudeConfigIdValue(config.id) === id);
  if (!matched) return null;
  return {
    baseUrl: String(matched.baseUrl || ''),
    model: String(matched.model || ''),
    hasAuthToken: Boolean(matched.hasAuthToken),
  };
}

/* ===================== MCP 配置 draft 表单（设置面板） ===================== */

export type McpAuthTokenIntent = 'unchanged' | 'set' | 'clear';

export type McpConfigFormState = {
  enabled: boolean;
  transport: McpTransport;
  host: string;
  port: number | string;
  path: string;
  authToken: string;
  authTokenIntent: McpAuthTokenIntent;
};

/** 从快照构造表单：transport/host/port/path 取自快照，authToken 永不回填明文 */
export function mcpConfigFormFromSnapshot(mcp: McpStatus | null | undefined): McpConfigFormState {
  if (!mcp) return { enabled: true, transport: 'http', host: '', port: '', path: '', authToken: '', authTokenIntent: 'unchanged' };
  return {
    enabled: Boolean(mcp.enabled),
    transport: 'http',
    host: mcp.host ?? '',
    port: mcp.port ?? '',
    path: mcp.path ?? '',
    authToken: '',
    authTokenIntent: 'unchanged',
  };
}

export function mcpConfigFormsEqual(left: McpConfigFormState, right: McpConfigFormState) {
  return left.enabled === right.enabled
    && left.transport === right.transport
    && left.host === right.host
    && String(left.port) === String(right.port)
    && left.path === right.path
    && left.authToken === right.authToken
    && normalizeMcpAuthTokenIntent(left.authTokenIntent, left.authToken) === normalizeMcpAuthTokenIntent(right.authTokenIntent, right.authToken);
}

/** 将端口解析为 1–65535 整数；非法返回 null */
export function parseMcpPort(value: number | string): number | null {
  const parsed = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 1 || parsed > 65535) return null;
  return parsed;
}

/** 返回校验错误文案；通过校验返回 null（仅 http 传输校验地址/端口/路径） */
export function validateMcpConfigForm(form: McpConfigFormState): string | null {
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
    transport: 'http',
    host: form.host.trim(),
    port: form.port,
    path: form.path.trim(),
  };
  const authTokenIntent = normalizeMcpAuthTokenIntent(form.authTokenIntent, form.authToken, authTokenTouched);
  if (authTokenTouched || authTokenIntent !== 'unchanged') {
    payload.authToken = authTokenIntent === 'clear' ? '' : form.authToken.trim();
  }
  return payload;
}

/** 用 Web Crypto 生成 32 字节高熵随机密钥（base64url，无填充） */
function normalizeMcpAuthTokenIntent(
  intent: McpAuthTokenIntent | undefined,
  authToken: string,
  touched = false,
): McpAuthTokenIntent {
  if (intent === 'unchanged' || intent === 'set' || intent === 'clear') return intent;
  if (!touched) return 'unchanged';
  return String(authToken || '').trim() ? 'set' : 'clear';
}

function mcpAuthTokenIntentFromPatch(patch: Partial<McpConfigFormState>): McpAuthTokenIntent | null {
  if (patch.authTokenIntent === 'unchanged' || patch.authTokenIntent === 'set' || patch.authTokenIntent === 'clear') {
    return patch.authTokenIntent;
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'authToken')) {
    return String(patch.authToken || '').trim() ? 'set' : 'clear';
  }
  return null;
}

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
    const nextPatch = { ...patch };
    const authTokenIntent = mcpAuthTokenIntentFromPatch(patch);
    if (authTokenIntent) {
      nextPatch.authTokenIntent = authTokenIntent;
      setMcpAuthTokenTouched(authTokenIntent !== 'unchanged');
    }
    setMcpFormDirty(true);
    applyForm({ ...formRef.current, ...nextPatch });
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
  /** 思考深度（需求 #28）：'' | 'low' | 'medium' | 'high' | 'xhigh' */
  thinkingDepth: AiThinkingDepthValue;
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
      model: DEFAULT_OPENAI_MODEL,
      temperature: '0.3',
      thinkingDepth: '',
      thinkingBudgetTokens: '',
    };
  }
  const provider = config.provider || 'openai';
  return {
    provider,
    baseUrl: config.baseUrl || defaultBaseUrlForProvider(provider),
    apiKey: '',
    model: config.model || defaultModelForProvider(provider),
    temperature: config.temperature || '0.3',
    thinkingDepth: normalizeAiThinkingDepthInput(config.thinkingDepth, provider),
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
  { value: 'codex', label: 'Codex', description: 'Codex CLI 本地执行' },
];

const AI_THINKING_DEPTHS_BY_PROVIDER: Record<string, readonly AiThinkingDepth[]> = {
  openai: ['low', 'medium', 'high', 'xhigh'],
  deepseek: ['low', 'medium', 'high'],
  codex: ['low', 'medium', 'high', 'xhigh'],
};

export type AiThinkingDepthValue = '' | AiThinkingDepth;
export type AiThinkingDepthOption = {
  value: AiThinkingDepthValue;
  label: string;
  description: string;
};

/** 思考深度选项（OpenAI o-series / DeepSeek 推理模型）*/
export const thinkingDepthOptions: AiThinkingDepthOption[] = [
  { value: '', label: '关闭', description: '不使用思考深度' },
  { value: 'low', label: '低', description: '快速响应' },
  { value: 'medium', label: '中', description: '默认平衡' },
  { value: 'high', label: '高', description: '深入推理' },
  { value: 'xhigh', label: '超高', description: '最深入推理' },
];

export function aiProviderLabel(provider?: string | null): string {
  const normalized = String(provider || '').trim();
  if (!normalized) return '未选择供应商';
  const option = aiProviderOptions.find((item) => item.value === normalized);
  if (option) return option.label;
  return normalized;
}

export function normalizeAiThinkingDepthInput(
  value?: string | null,
  provider = 'openai',
): AiThinkingDepthValue {
  const depth = String(value || '').trim().toLowerCase();
  if (isAiThinkingDepthForProvider(depth, provider)) return depth;
  return '';
}

export function thinkingDepthOptionsForProvider(provider: string): AiThinkingDepthOption[] {
  const providerKey = normalizeAiThinkingDepthProvider(provider);
  if (!providerKey) return [];
  const supported = new Set<AiThinkingDepthValue>(['', ...AI_THINKING_DEPTHS_BY_PROVIDER[providerKey]]);
  return thinkingDepthOptions.filter((item) => supported.has(item.value));
}

export function aiThinkingDepthLabel(value?: string | null, provider = 'openai'): string {
  const depth = normalizeAiThinkingDepthInput(value, provider);
  const option = thinkingDepthOptionsForProvider(provider).find((item) => item.value === depth);
  return `思考 · ${option?.label || '关闭'}`;
}

export function chatProviderRequiresApiKey(provider?: string | null): boolean {
  return normalizeAiConfigProvider(provider) !== 'codex';
}

type ChatAvailabilityConfig = Pick<ChatConfig, 'provider' | 'hasApiKey'>
  | Pick<AiConfig, 'provider' | 'hasApiKey'>
  | null
  | undefined;

export function isChatConfigAvailableForSend(config?: ChatAvailabilityConfig): boolean {
  if (!config) return false;
  if (!chatProviderRequiresApiKey(config.provider)) return true;
  return config.hasApiKey === true;
}

/** 根据 provider 返回默认 Base URL 占位符 */
export function defaultBaseUrlForProvider(provider: string): string {
  if (provider === 'deepseek') return 'https://api.deepseek.com';
  if (provider === 'anthropic') return 'https://api.anthropic.com';
  if (provider === 'codex') return '';
  return 'https://api.openai.com';
}

/** 根据 provider 返回默认模型占位符 */
export function defaultModelForProvider(provider: string): string {
  if (provider === 'deepseek') return 'deepseek-chat';
  if (provider === 'anthropic') return 'claude-sonnet-4-6';
  if (provider === 'codex') return '';
  return DEFAULT_OPENAI_MODEL;
}

/** 判断 provider 是否需要显示思考深度选择器（OpenAI 兼容 / DeepSeek）*/
export function providerSupportsThinkingDepth(provider: string): boolean {
  return Boolean(normalizeAiThinkingDepthProvider(provider));
}

/** 判断 provider 是否需要显示思考 token 预算输入（Anthropic）*/
export function providerSupportsThinkingBudget(provider: string): boolean {
  return provider === 'anthropic';
}

export function aiConfigFormForProviderChange(
  form: ChatConfigFormState,
  provider: string,
): ChatConfigFormState {
  const currentProvider = form.provider || 'openai';
  const baseUrl = shouldUseProviderDefault(form.baseUrl, defaultBaseUrlForProvider(currentProvider))
    ? defaultBaseUrlForProvider(provider)
    : form.baseUrl;
  const model = shouldUseProviderDefaultModel(form.model, currentProvider)
    ? defaultModelForProvider(provider)
    : form.model;
  return {
    ...form,
    provider,
    baseUrl,
    model,
    thinkingDepth: normalizeAiThinkingDepthInput(form.thinkingDepth, provider),
    thinkingBudgetTokens: providerSupportsThinkingBudget(provider) ? form.thinkingBudgetTokens : '',
  };
}

export function aiConfigInputFromForm(
  name: string,
  form: ChatConfigFormState,
  options: { preserveEmptyApiKey?: boolean } = {},
): AiConfigCreateInput {
  const provider = normalizeAiConfigProvider(form.provider || 'openai');
  const apiKey = form.apiKey.trim();
  const payload: AiConfigCreateInput = {
    name: name.trim(),
    provider,
    baseUrl: form.baseUrl.trim(),
    model: form.model.trim() || defaultModelForProvider(provider),
    temperature: form.temperature.trim() || '0.3',
    thinkingDepth: normalizeAiThinkingDepth(form.thinkingDepth, provider),
    thinkingBudgetTokens: providerSupportsThinkingBudget(provider)
      ? normalizeAiThinkingBudgetTokens(form.thinkingBudgetTokens)
      : null,
  };
  if (!options.preserveEmptyApiKey || apiKey) {
    payload.apiKey = apiKey;
  }
  return payload;
}

function shouldUseProviderDefault(value: string, providerDefault: string) {
  const normalized = String(value || '').trim();
  return !normalized || normalized === providerDefault;
}

function shouldUseProviderDefaultModel(value: string, provider: string) {
  const normalized = String(value || '').trim();
  if (!normalized || normalized === defaultModelForProvider(provider)) return true;
  return normalizeAiConfigProvider(provider) === 'openai' && LEGACY_OPENAI_DEFAULT_MODELS.has(normalized);
}

function normalizeAiThinkingDepth(value: string, provider = 'openai'): AiThinkingDepth | null {
  const depth = normalizeAiThinkingDepthInput(value, provider);
  return depth || null;
}

function normalizeAiConfigProvider(value?: string | null): ChatProvider {
  const provider = String(value || '').trim().toLowerCase();
  if (provider === 'deepseek' || provider === 'anthropic' || provider === 'codex') return provider;
  return 'openai';
}

function normalizeAiThinkingDepthProvider(value?: string | null): 'openai' | 'deepseek' | 'codex' | '' {
  const provider = String(value || '').trim().toLowerCase();
  if (provider === 'openai' || provider === 'deepseek' || provider === 'codex') return provider;
  return '';
}

function isAiThinkingDepthForProvider(depth: string, provider: string): depth is AiThinkingDepth {
  const providerKey = normalizeAiThinkingDepthProvider(provider);
  return Boolean(providerKey && AI_THINKING_DEPTHS_BY_PROVIDER[providerKey].includes(depth as AiThinkingDepth));
}

function normalizeAiThinkingBudgetTokens(value: string): number | null {
  const trimmed = String(value || '').trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.floor(parsed);
}

/* ===================== 执行器 draft 表单（VS Code Tasks 子集） ===================== */

export const EXECUTOR_TYPES: ExecutorType[] = ['shell', 'process'];
export const EXECUTOR_DEPENDS_ORDERS: ExecutorDependsOrder[] = ['parallel', 'sequence'];
export const EXECUTOR_PRESENTATION_REVEALS = ['always', 'silent', 'never'] as const;
export const EXECUTOR_PRESENTATION_PANELS = ['shared', 'dedicated', 'new'] as const;
export const EXECUTOR_PRESENTATION_REVEAL_PROBLEMS = ['never', 'onProblem', 'always'] as const;

export type ExecutorPresentationRevealDraft = '' | (typeof EXECUTOR_PRESENTATION_REVEALS)[number];
export type ExecutorPresentationPanelDraft = '' | (typeof EXECUTOR_PRESENTATION_PANELS)[number];
export type ExecutorPresentationRevealProblemsDraft = '' | (typeof EXECUTOR_PRESENTATION_REVEAL_PROBLEMS)[number];

export type ExecutorEnvVarDraft = {
  id: string;
  name: string;
  value: string;
};

export type ExecutorDraftState = {
  id: number | null;
  label: string;
  type: ExecutorType;
  command: string;
  argsText: string;
  cwd: string;
  envText: string;
  envVars: ExecutorEnvVarDraft[];
  groupKind: string;
  groupDefault: boolean;
  dependsOnText: string;
  dependsOrder: ExecutorDependsOrder;
  presentationReveal: ExecutorPresentationRevealDraft;
  presentationPanel: ExecutorPresentationPanelDraft;
  presentationRevealProblems: ExecutorPresentationRevealProblemsDraft;
  presentationEcho: boolean;
  presentationFocus: boolean;
  presentationShowReuseMessage: boolean;
  presentationClear: boolean;
  presentationClose: boolean;
  problemMatcherText: string;
  enabled: boolean;
  sortOrder: string;
};

type ExecutorRecord = Record<string, unknown>;
type ExecutorArgObject = { value: string; quoting?: 'escape' | 'strong' | 'weak' };

export function createExecutorDraft(
  executor: Executor | ExecutorRecord | null,
  executors: Array<Executor | ExecutorRecord> = [],
): ExecutorDraftState {
  const source = isRecord(executor) ? executor : {};
  const options = normalizeExecutorOptions(readExecutorJson(source, 'options', 'optionsJson', 'options_json'));
  const group = normalizeExecutorGroup(firstDefined(
    readValue(source, 'group'),
    executorGroupFromFlatFields(source),
    null,
  ));
  const presentation = normalizeExecutorPresentation(readExecutorJson(
    source,
    'presentation',
    'presentationJson',
    'presentation_json',
  ));
  const envVars = executorEnvVarDraftsFromRecord(options.env);

  return {
    id: normalizeNullableId(readValue(source, 'id')),
    label: String(readValue(source, 'label') ?? ''),
    type: readExecutorType(readValue(source, 'type')),
    command: String(readValue(source, 'command') ?? ''),
    argsText: formatExecutorArgs(readExecutorArgs(readExecutorJson(source, 'args', 'argsJson', 'args_json'))),
    cwd: options.cwd,
    envText: formatExecutorEnvText(options.env),
    envVars,
    groupKind: group.kind ?? '',
    groupDefault: group.isDefault,
    dependsOnText: formatExecutorDependsOn(readExecutorDependsOn(readExecutorJson(
      source,
      'dependsOn',
      'depends_on',
      'dependsOnJson',
      'depends_on_json',
    ))),
    dependsOrder: readExecutorDependsOrder(readValue(source, 'dependsOrder') ?? readValue(source, 'depends_order')),
    presentationReveal: readPresentationReveal(presentation.reveal),
    presentationPanel: readPresentationPanel(presentation.panel),
    presentationRevealProblems: readPresentationRevealProblems(presentation.revealProblems),
    presentationEcho: Boolean(presentation.echo),
    presentationFocus: Boolean(presentation.focus),
    presentationShowReuseMessage: Boolean(presentation.showReuseMessage),
    presentationClear: Boolean(presentation.clear),
    presentationClose: Boolean(presentation.close),
    problemMatcherText: formatExecutorProblemMatcher(readExecutorProblemMatcher(readExecutorJson(
      source,
      'problemMatcher',
      'problem_matcher',
      'problemMatcherJson',
      'problem_matcher_json',
    ))),
    enabled: readExecutorEnabled(readValue(source, 'enabled')),
    sortOrder: String(firstDefined(
      readValue(source, 'sortOrder'),
      readValue(source, 'sort_order'),
      nextExecutorSortOrder(executors),
    )),
  };
}

export function executorDraftFromTasksJsonTask(
  task: ExecutorRecord,
  executors: Array<Executor | ExecutorRecord> = [],
): ExecutorDraftState {
  const options = normalizeExecutorOptions(readValue(task, 'options'));
  const group = normalizeExecutorGroup(readValue(task, 'group'));
  const presentation = normalizeExecutorPresentation(readValue(task, 'presentation'));
  return {
    ...createExecutorDraft(null, executors),
    label: String(readValue(task, 'label') ?? ''),
    type: readExecutorType(readValue(task, 'type')),
    command: String(readValue(task, 'command') ?? ''),
    argsText: formatExecutorArgs(readExecutorArgs(readValue(task, 'args'))),
    cwd: options.cwd,
    envText: formatExecutorEnvText(options.env),
    envVars: executorEnvVarDraftsFromRecord(options.env),
    groupKind: group.kind ?? '',
    groupDefault: group.isDefault,
    dependsOnText: formatExecutorDependsOn(readExecutorDependsOn(readValue(task, 'dependsOn'))),
    dependsOrder: readExecutorDependsOrder(readValue(task, 'dependsOrder')),
    presentationReveal: readPresentationReveal(presentation.reveal),
    presentationPanel: readPresentationPanel(presentation.panel),
    presentationRevealProblems: readPresentationRevealProblems(presentation.revealProblems),
    presentationEcho: Boolean(presentation.echo),
    presentationFocus: Boolean(presentation.focus),
    presentationShowReuseMessage: Boolean(presentation.showReuseMessage),
    presentationClear: Boolean(presentation.clear),
    presentationClose: Boolean(presentation.close),
    problemMatcherText: formatExecutorProblemMatcher(readExecutorProblemMatcher(readValue(task, 'problemMatcher'))),
  };
}

export function validateExecutorDraft(draft: ExecutorDraftState): string | null {
  if (!draft.label.trim()) return '请填写执行器标签';
  if (draft.label.trim().length > 160) return '执行器标签过长（最多 160 字符）';
  if (!EXECUTOR_TYPES.includes(draft.type)) return '执行器类型仅支持 shell 或 process';
  if (!draft.command.trim()) return '请填写执行器命令';
  if (!EXECUTOR_DEPENDS_ORDERS.includes(draft.dependsOrder)) return 'dependsOrder 仅支持 parallel 或 sequence';

  try {
    parseExecutorArgsText(draft.argsText);
    executorEnvRecordFromDraft(draft);
    parseExecutorDependsOnText(draft.dependsOnText);
    parseExecutorProblemMatcherText(draft.problemMatcherText);
    parseExecutorSortOrder(draft.sortOrder);
  } catch (error) {
    return getErrorMessage(error, '执行器配置格式无效');
  }
  return null;
}

export function executorCreateInputFromDraft(projectId: number, draft: ExecutorDraftState): ExecutorInput {
  const validationError = validateExecutorDraft(draft);
  if (validationError) throw new Error(validationError);
  return {
    projectId,
    label: draft.label.trim(),
    type: draft.type,
    command: draft.command.trim(),
    args: parseExecutorArgsText(draft.argsText),
    options: {
      cwd: draft.cwd.trim(),
      env: executorEnvRecordFromDraft(draft),
    },
    group: {
      kind: draft.groupKind.trim() || null,
      isDefault: draft.groupDefault,
    },
    dependsOn: parseExecutorDependsOnText(draft.dependsOnText),
    dependsOrder: draft.dependsOrder,
    presentation: executorPresentationFromDraft(draft),
    problemMatcher: parseExecutorProblemMatcherText(draft.problemMatcherText),
    enabled: draft.enabled,
    sortOrder: parseExecutorSortOrder(draft.sortOrder),
  };
}

export function executorUpdateInputFromDraft(projectId: number, draft: ExecutorDraftState): UpdateExecutorInput {
  if (draft.id === null) throw new Error('执行器 ID 无效');
  return { ...executorCreateInputFromDraft(projectId, draft), executorId: draft.id };
}

export function parseExecutorArgsText(text: string): ExecutorArg[] {
  const trimmed = String(text || '').trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[')) {
    const parsed = parseJsonValue(trimmed, 'args JSON');
    if (!Array.isArray(parsed)) throw new Error('args JSON 必须是数组');
    return parsed.map((item, index) => normalizeExecutorArg(item, index));
  }
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

export function formatExecutorArgs(args: ExecutorArg[] | unknown): string {
  const normalized = readExecutorArgs(args);
  if (normalized.length === 0) return '';
  if (normalized.every((arg) => typeof arg === 'string')) return normalized.join('\n');
  return JSON.stringify(normalized, null, 2);
}

export function parseExecutorEnvText(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  String(text || '').split(/\r?\n/).forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) throw new Error(`环境变量第 ${index + 1} 行必须是 KEY=VALUE`);
    const key = trimmed.slice(0, eq).trim();
    validateExecutorEnvName(key);
    env[key] = trimmed.slice(eq + 1);
  });
  return env;
}

export function formatExecutorEnvText(env: Record<string, string> | unknown): string {
  if (!isRecord(env)) return '';
  return Object.entries(env)
    .map(([key, value]) => `${key}=${String(value ?? '')}`)
    .join('\n');
}

export function executorEnvVarDraftsFromRecord(env: Record<string, string> | unknown): ExecutorEnvVarDraft[] {
  if (!isRecord(env)) return [];
  return Object.entries(env).map(([name, value], index) => ({
    id: `env-${index}-${name}`,
    name,
    value: String(value ?? ''),
  }));
}

export function executorEnvRecordFromDraft(draft: Pick<ExecutorDraftState, 'envText' | 'envVars'>): Record<string, string> {
  const entryEnv = executorEnvRecordFromEntries(draft.envVars);
  if (Object.keys(entryEnv).length > 0) return entryEnv;
  return parseExecutorEnvText(draft.envText);
}

export function executorEnvRecordFromEntries(entries: ExecutorEnvVarDraft[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const entry of entries || []) {
    const name = String(entry?.name || '').trim();
    const value = String(entry?.value ?? '');
    if (!name && !value) continue;
    validateExecutorEnvName(name);
    env[name] = value;
  }
  return env;
}

export function parseExecutorDependsOnText(text: string): string[] {
  const trimmed = String(text || '').trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[') || trimmed.startsWith('"')) {
    const parsed = parseJsonValue(trimmed, 'dependsOn JSON');
    return normalizeStringList(Array.isArray(parsed) ? parsed : [parsed]);
  }
  return normalizeStringList(text.split(/\r?\n/));
}

export function formatExecutorDependsOn(dependsOn: string[] | unknown): string {
  return readExecutorDependsOn(dependsOn).join('\n');
}

export function parseExecutorProblemMatcherText(text: string): ExecutorProblemMatcher {
  const trimmed = String(text || '').trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const parsed = parseJsonValue(trimmed, 'problemMatcher JSON');
    if (typeof parsed === 'string' || Array.isArray(parsed) || isRecord(parsed)) {
      return parsed as ExecutorProblemMatcher;
    }
    throw new Error('problemMatcher JSON 必须是字符串、对象或数组');
  }
  const lines = normalizeStringList(text.split(/\r?\n/));
  return lines.length <= 1 ? lines[0] : lines;
}

export function formatExecutorProblemMatcher(value: ExecutorProblemMatcher | unknown): string {
  const normalized = readExecutorProblemMatcher(value);
  if (normalized === null || typeof normalized === 'undefined') return '';
  if (typeof normalized === 'string') return normalized;
  if (Array.isArray(normalized) && normalized.every((item) => typeof item === 'string')) return normalized.join('\n');
  return JSON.stringify(normalized, null, 2);
}

export function executorPresentationFromDraft(draft: Pick<
  ExecutorDraftState,
  | 'presentationReveal'
  | 'presentationPanel'
  | 'presentationRevealProblems'
  | 'presentationEcho'
  | 'presentationFocus'
  | 'presentationShowReuseMessage'
  | 'presentationClear'
  | 'presentationClose'
>): ExecutorPresentation {
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

export function parseExecutorSortOrder(value: string): number {
  const trimmed = String(value || '').trim();
  if (!trimmed) return 0;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) throw new Error('排序值必须是数字');
  return Math.floor(parsed);
}

export function resolveExecutorCwdHint(cwd: string, workspacePath = '') {
  const raw = String(cwd || '').trim();
  const workspace = String(workspacePath || '').trim();
  if (!raw || raw === '${workspace}') {
    return { kind: 'workspace' as const, label: '${workspace}', resolved: workspace };
  }
  if (raw.startsWith('${workspace}')) {
    const suffix = raw.slice('${workspace}'.length).replace(/^[/\\]+/, '');
    return {
      kind: 'workspace-child' as const,
      label: raw,
      resolved: workspace && suffix ? `${workspace.replace(/[\\/]+$/, '')}\\${suffix}` : raw,
    };
  }
  if (/^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith('\\\\') || raw.startsWith('/')) {
    return { kind: 'absolute' as const, label: raw, resolved: raw };
  }
  return {
    kind: 'relative' as const,
    label: raw,
    resolved: workspace ? `${workspace.replace(/[\\/]+$/, '')}\\${raw}` : raw,
  };
}

function readExecutorType(value: unknown): ExecutorType {
  return value === 'process' ? 'process' : 'shell';
}

function readExecutorDependsOrder(value: unknown): ExecutorDependsOrder {
  return value === 'sequence' ? 'sequence' : 'parallel';
}

function readExecutorEnabled(value: unknown): boolean {
  if (value === undefined || value === null || value === '') return true;
  if (value === false || value === 0) return false;
  return !['0', 'false', 'off', 'no', 'disabled'].includes(String(value).trim().toLowerCase());
}

function normalizeExecutorOptions(value: unknown): ExecutorOptions {
  const options = isRecord(value) ? value : {};
  return {
    cwd: typeof options.cwd === 'string' ? options.cwd : '',
    env: isRecord(options.env)
      ? Object.fromEntries(Object.entries(options.env).map(([key, envValue]) => [key, String(envValue ?? '')]))
      : {},
  };
}

function normalizeExecutorGroup(value: unknown): { kind: string | null; isDefault: boolean } {
  if (typeof value === 'string') {
    const kind = value.trim();
    return { kind: kind || null, isDefault: false };
  }
  if (!isRecord(value)) return { kind: null, isDefault: false };
  const kind = String(value.kind ?? '').trim();
  return { kind: kind || null, isDefault: Boolean(value.isDefault ?? value.is_default) };
}

function normalizeExecutorPresentation(value: unknown): ExecutorPresentation {
  if (!isRecord(value)) return {};
  return {
    reveal: readPresentationReveal(value.reveal) || undefined,
    panel: readPresentationPanel(value.panel) || undefined,
    revealProblems: readPresentationRevealProblems(value.revealProblems) || undefined,
    echo: Boolean(value.echo),
    focus: Boolean(value.focus),
    showReuseMessage: Boolean(value.showReuseMessage),
    clear: Boolean(value.clear),
    close: Boolean(value.close),
  };
}

function readPresentationReveal(value: unknown): ExecutorPresentationRevealDraft {
  return EXECUTOR_PRESENTATION_REVEALS.includes(value as (typeof EXECUTOR_PRESENTATION_REVEALS)[number])
    ? (value as ExecutorPresentationRevealDraft)
    : '';
}

function readPresentationPanel(value: unknown): ExecutorPresentationPanelDraft {
  return EXECUTOR_PRESENTATION_PANELS.includes(value as (typeof EXECUTOR_PRESENTATION_PANELS)[number])
    ? (value as ExecutorPresentationPanelDraft)
    : '';
}

function readPresentationRevealProblems(value: unknown): ExecutorPresentationRevealProblemsDraft {
  return EXECUTOR_PRESENTATION_REVEAL_PROBLEMS.includes(value as (typeof EXECUTOR_PRESENTATION_REVEAL_PROBLEMS)[number])
    ? (value as ExecutorPresentationRevealProblemsDraft)
    : '';
}

function readExecutorArgs(value: unknown): ExecutorArg[] {
  const parsed = parseJsonMaybe(value, []);
  if (!Array.isArray(parsed)) return [];
  const args: ExecutorArg[] = [];
  parsed.forEach((item, index) => {
    try {
      args.push(normalizeExecutorArg(item, index));
    } catch { /* 丢弃非法历史值，保存时会重新校验草稿 */ }
  });
  return args;
}

function normalizeExecutorArg(value: unknown, index: number): ExecutorArg {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (isRecord(value) && Object.prototype.hasOwnProperty.call(value, 'value')) {
    const arg: ExecutorArgObject = { value: String(value.value ?? '') };
    const quoting = String(value.quoting ?? '').trim();
    if (quoting) {
      if (quoting !== 'escape' && quoting !== 'strong' && quoting !== 'weak') {
        throw new Error(`args 第 ${index + 1} 项 quoting 仅支持 escape/strong/weak`);
      }
      arg.quoting = quoting;
    }
    return arg;
  }
  throw new Error(`args 第 ${index + 1} 项仅支持字符串、数字、布尔值或 { value, quoting }`);
}

function readExecutorDependsOn(value: unknown): string[] {
  const parsed = parseJsonMaybe(value, []);
  return normalizeStringList(Array.isArray(parsed) ? parsed : [parsed]);
}

function readExecutorProblemMatcher(value: unknown): ExecutorProblemMatcher {
  const parsed = parseJsonMaybe(value, null);
  if (parsed === null || typeof parsed === 'undefined') return null;
  if (typeof parsed === 'string' || Array.isArray(parsed) || isRecord(parsed)) return parsed as ExecutorProblemMatcher;
  return null;
}

function readExecutorJson(source: ExecutorRecord, ...keys: string[]): unknown {
  const value = firstDefined(...keys.map((key) => readValue(source, key)));
  return parseJsonMaybe(value, value);
}

function executorGroupFromFlatFields(source: ExecutorRecord) {
  const kind = firstDefined(readValue(source, 'groupKind'), readValue(source, 'group_kind'), undefined);
  const isDefault = firstDefined(readValue(source, 'groupIsDefault'), readValue(source, 'group_is_default'), undefined);
  if (kind === undefined && isDefault === undefined) return undefined;
  return { kind, isDefault };
}

function nextExecutorSortOrder(executors: Array<Executor | ExecutorRecord>) {
  return executors.reduce((max, executor) => {
    if (!isRecord(executor)) return max;
    const value = Number(firstDefined(readValue(executor, 'sortOrder'), readValue(executor, 'sort_order'), 0));
    return Number.isFinite(value) ? Math.max(max, value) : max;
  }, 0) + 1;
}

function normalizeNullableId(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : null;
}

function normalizeStringList(values: unknown[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  values.forEach((value) => {
    const text = String(value ?? '').trim();
    if (!text || seen.has(text)) return;
    seen.add(text);
    result.push(text);
  });
  return result;
}

function validateExecutorEnvName(name: string) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`环境变量名无效：${name || '空'}`);
}

function parseJsonValue(text: string, label: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${label} 格式无效`);
  }
}

function parseJsonMaybe(value: unknown, fallback: unknown): unknown {
  if (typeof value !== 'string') return value ?? fallback;
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[') && !trimmed.startsWith('"')) return value;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return fallback;
  }
}

function readValue(source: ExecutorRecord, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(source, key) ? source[key] : undefined;
}

function firstDefined<T>(...values: T[]): T | undefined {
  return values.find((value) => value !== undefined && value !== null);
}

function isRecord(value: unknown): value is ExecutorRecord {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
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
