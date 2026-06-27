import type { Dispatch, SetStateAction } from 'react';
import {
  DEFAULT_WORKSPACE_TAB,
  PENDING_ATTACHMENT_SOURCES,
} from '../types';
import type {
  AgentCliOption,
  AgentCliProvider,
  CodexReasoningEffort,
  IntakeType,
  LoopConfigInput,
  PendingAttachment,
  ProjectState,
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
];

export const codexReasoningOptionDetails: Array<SettingsChoiceOption<CodexReasoningEffort>> = [
  { value: 'low', label: '低', description: '快速响应，适合小范围改动。' },
  { value: 'medium', label: '中', description: '默认平衡速度与质量。' },
  { value: 'high', label: '高', description: '更深入分析复杂代码。' },
  { value: 'xhigh', label: '超高', description: '最充分推理，适合高风险任务。' },
];

export const defaultCodexReasoningEffort: CodexReasoningEffort = 'medium';

export const defaultComposerCliProviders: Record<IntakeType, AgentCliProvider> = {
  requirement: 'codex',
  feedback: 'codex',
};

export const defaultComposerCodexReasoning: Record<IntakeType, CodexReasoningEffort> = {
  requirement: defaultCodexReasoningEffort,
  feedback: defaultCodexReasoningEffort,
};

export type LoopFormState = {
  workspacePath: string;
  intervalSeconds: string;
  validationCommand: string;
  agentCliProvider: string;
  agentCliCommand: string;
  codexReasoningEffort: CodexReasoningEffort;
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

export function loopFormFromProjectState(state: ProjectState): LoopFormState {
  return {
    workspacePath: state.workspace_path || '',
    intervalSeconds: String(state.interval_seconds || 5),
    validationCommand: state.validation_command ?? '',
    agentCliProvider: state.agent_cli_provider || 'codex',
    agentCliCommand: state.agent_cli_command || '',
    codexReasoningEffort: normalizeCodexReasoningEffort(state.codex_reasoning_effort),
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
  if (form.agentCliProvider !== 'claude') {
    payload.codexReasoningEffort = form.codexReasoningEffort;
  }
  return payload;
}

export function loopFormsEqual(left: LoopFormState, right: LoopFormState) {
  return left.workspacePath === right.workspacePath
    && left.intervalSeconds === right.intervalSeconds
    && left.validationCommand === right.validationCommand
    && left.agentCliProvider === right.agentCliProvider
    && left.agentCliCommand === right.agentCliCommand
    && left.codexReasoningEffort === right.codexReasoningEffort;
}
