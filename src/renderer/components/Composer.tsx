import {
  ClipboardEvent,
  createContext,
  DragEvent,
  FormEvent,
  KeyboardEvent,
  type ReactNode,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { PENDING_ATTACHMENT_SOURCES } from '../types';
import type {
  AgentCliOption,
  CodexReasoningEffort,
  IntakeType,
  PendingAttachment,
  PlanBackendProvider,
  PlanGenerationInputFields,
  PlanGenerationStrategy,
} from '../types';
import { Icon } from './icons';
import { autoGrowTextarea, formatBytes, getFilePath, toSafeFileUrl } from './shared';
import {
  defaultComposerPlanGenerationSelections,
  isBuiltinPlanGenerationStrategy,
  isCodexPlanBackendProvider,
  planBackendDefaultCommand,
  planBackendDefaultModel,
  planBackendProviderLabel,
  planBackendProviderOptionsForStrategy,
  planGenerationInputFromComposerSelection,
  planGenerationStrategyOptions,
  type ComposerPlanGenerationSelection,
} from '../utils/workspaceForms';

interface ComposerCliSelectionValue {
  options: AgentCliOption[];
  reasoningOptions: AgentCliOption[];
  selectedByType: Record<IntakeType, ComposerPlanGenerationSelection>;
  onUseProjectDefaultChange: (type: IntakeType, useProjectDefault: boolean) => void;
  onStrategyChange: (type: IntakeType, strategy: PlanGenerationStrategy) => void;
  onProviderChange: (type: IntakeType, provider: PlanBackendProvider) => void;
  onCommandChange: (type: IntakeType, command: string) => void;
  onModelChange: (type: IntakeType, model: string) => void;
  onReasoningChange: (type: IntakeType, effort: CodexReasoningEffort) => void;
}

const ComposerCliSelectionContext = createContext<ComposerCliSelectionValue | null>(null);

export function ComposerCliSelectionProvider({
  children,
  value,
}: {
  children: ReactNode;
  value: ComposerCliSelectionValue;
}) {
  return <ComposerCliSelectionContext.Provider value={value}>{children}</ComposerCliSelectionContext.Provider>;
}

interface ComposerProps {
  identityKey?: string;
  pendingAttachments: PendingAttachment[];
  placeholder: string;
  submitLabel: string;
  type: IntakeType;
  value: string;
  onValueChange: (next: string) => void;
  onAddFiles: (type: IntakeType, files: FileList | File[] | null) => void;
  onRemoveAttachment: (type: IntakeType, index: number) => void;
  onSubmit: (body: string | ComposerSubmitPayload) => Promise<boolean>;
}

export interface ComposerSubmitPayload {
  body: string;
  createAsDraft: boolean;
  planGenerationStrategy?: PlanGenerationInputFields['planGenerationStrategy'];
  planGenerationProvider?: PlanGenerationInputFields['planGenerationProvider'];
  planGenerationCommand?: PlanGenerationInputFields['planGenerationCommand'];
  planGenerationModel?: PlanGenerationInputFields['planGenerationModel'];
  planGenerationCodexReasoningEffort?: PlanGenerationInputFields['planGenerationCodexReasoningEffort'];
}

function getClipboardImageFiles(event: ClipboardEvent<HTMLTextAreaElement>) {
  const itemFiles = Array.from(event.clipboardData.items || [])
    .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
    .map((item) => item.getAsFile())
    .filter((file): file is File => Boolean(file));

  if (itemFiles.length) return itemFiles;
  return Array.from(event.clipboardData.files || []).filter((file) => file.type.startsWith('image/'));
}

export function Composer({
  identityKey,
  pendingAttachments,
  placeholder,
  submitLabel,
  type,
  value,
  onValueChange,
  onAddFiles,
  onRemoveAttachment,
  onSubmit,
}: ComposerProps) {
  const [createAsDraft, setCreateAsDraft] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const cliSelection = useContext(ComposerCliSelectionContext);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composerIdentityKey = identityKey || type;

  useEffect(() => {
    setCreateAsDraft(false);
    setDragOver(false);
    if (fileInputRef.current) fileInputRef.current.value = '';
    if (textareaRef.current) autoGrowTextarea(textareaRef.current);
  }, [composerIdentityKey]);

  useEffect(() => {
    if (textareaRef.current) autoGrowTextarea(textareaRef.current);
  }, [value]);

  const selectedGeneration = cliSelection?.selectedByType[type] || defaultComposerPlanGenerationSelections[type];
  const selectedStrategy = selectedGeneration.strategy;
  const useProjectDefault = selectedGeneration.useProjectDefault;
  const isBuiltinGeneration = isBuiltinPlanGenerationStrategy(selectedStrategy);
  const providerOptions = planBackendProviderOptionsForStrategy(selectedStrategy);
  const selectedProvider = selectedGeneration.provider;
  const isCodexProvider = isCodexPlanBackendProvider(selectedProvider);
  const selectedStrategyOption = planGenerationStrategyOptions.find((option) => option.value === selectedStrategy);
  const selectedProviderOption = providerOptions.find((option) => option.value === selectedProvider);
  const selectedReasoning = selectedGeneration.codexReasoningEffort || cliSelection?.reasoningOptions[1]?.value || 'medium';
  const selectedReasoningOption = cliSelection?.reasoningOptions.find((option) => option.value === selectedReasoning);
  const backendValueLabel = isBuiltinGeneration
    ? (selectedGeneration.model.trim() || planBackendDefaultModel(selectedProvider))
    : (selectedGeneration.command.trim() || planBackendDefaultCommand(selectedProvider));
  const draftHelp = '创建为草稿后只生成计划，不会立即进入执行队列；确认后可在计划与任务中手动执行。';

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!value.trim() && !pendingAttachments.length) return;
    const payload = cliSelection
      ? {
          body: value,
          createAsDraft,
          ...planGenerationInputFromComposerSelection(selectedGeneration),
        }
      : createAsDraft ? { body: value, createAsDraft } : value;
    const succeeded = await onSubmit(payload);
    if (succeeded) {
      onValueChange('');
      setCreateAsDraft(false);
    }
  };

  const addFiles = (files: FileList | File[] | null) => onAddFiles(type, files);

  const handleTextareaKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  };

  const handleTextareaPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const imageFiles = getClipboardImageFiles(event);
    if (!imageFiles.length) return;
    addFiles(imageFiles);
  };

  const clearDragState = (event: DragEvent<HTMLElement>) => {
    const relatedTarget = event.relatedTarget as Node | null;
    if (relatedTarget && event.currentTarget.contains(relatedTarget)) return;
    setDragOver(false);
  };

  return (
    <form
      className={`composer docked-composer compact-composer${dragOver ? ' drag-over' : ''}`}
      data-composer-identity={composerIdentityKey}
      onDragLeave={clearDragState}
      onDragOver={(event) => {
        event.preventDefault();
        setDragOver(true);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setDragOver(false);
        addFiles(event.dataTransfer.files);
      }}
      onSubmit={submit}
    >
      <textarea
        key={composerIdentityKey}
        name="body"
        onChange={(event) => onValueChange(event.target.value)}
        onInput={(event) => autoGrowTextarea(event.currentTarget)}
        onKeyDown={handleTextareaKeyDown}
        onPaste={handleTextareaPaste}
        placeholder={placeholder}
        ref={textareaRef}
        value={value}
      />
      <div className="composer-bottom">
        <div className="composer-tools">
          <div
            className={`attachment-dropzone attachment-trigger${dragOver ? ' drag-over' : ''}`}
            onClick={() => fileInputRef.current?.click()}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                fileInputRef.current?.click();
              }
            }}
            role="button"
            tabIndex={0}
            aria-label="添加附件"
            title="添加附件"
          >
            <input
              multiple
              onChange={(event) => {
                addFiles(event.target.files);
                event.target.value = '';
              }}
              ref={fileInputRef}
              type="file"
            />
            <Icon name="attachment" size={20} className="attachment-trigger-icon" aria-hidden="true" />
          </div>
          {cliSelection ? (
            <div className="composer-cli-row composer-plan-row">
              <label
                className="composer-icon-select"
                title={useProjectDefault ? '计划生成：项目默认' : '计划生成：自定义'}
              >
                <Icon name="plan" size={18} aria-hidden="true" />
                <span className="composer-select-label">{useProjectDefault ? '项目默认' : '自定义生成'}</span>
                <select
                  aria-label="选择计划生成配置来源"
                  value={useProjectDefault ? 'default' : 'custom'}
                  onChange={(event) => cliSelection.onUseProjectDefaultChange(type, event.target.value === 'default')}
                >
                  <option value="default">项目默认</option>
                  <option value="custom">自定义生成</option>
                </select>
              </label>
              {!useProjectDefault ? (
                <>
                  <label
                    className="composer-icon-select composer-icon-select-wide"
                    title={`生成策略：${selectedStrategyOption?.label || selectedStrategy}`}
                  >
                    <Icon name="sliders" size={18} aria-hidden="true" />
                    <span className="composer-select-label">{selectedStrategyOption?.label || selectedStrategy}</span>
                    <select
                      aria-label="选择计划生成策略"
                      value={selectedStrategy}
                      onChange={(event) => cliSelection.onStrategyChange(type, event.target.value as PlanGenerationStrategy)}
                    >
                      {planGenerationStrategyOptions.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label
                    className="composer-icon-select"
                    title={`生成 Provider：${selectedProviderOption?.label || planBackendProviderLabel(selectedProvider)}`}
                  >
                    <Icon name={isBuiltinGeneration ? 'chat' : 'cli'} size={18} aria-hidden="true" />
                    <span className="composer-select-label">
                      {selectedProviderOption?.label || planBackendProviderLabel(selectedProvider)}
                    </span>
                    <select
                      aria-label="选择计划生成 Provider"
                      value={selectedProvider}
                      onChange={(event) => cliSelection.onProviderChange(type, event.target.value)}
                    >
                      {providerOptions.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label
                    className="composer-inline-input"
                    title={isBuiltinGeneration ? `生成模型：${backendValueLabel}` : `生成命令：${backendValueLabel}`}
                  >
                    <Icon name={isBuiltinGeneration ? 'chat' : 'terminal'} size={18} aria-hidden="true" />
                    <input
                      aria-label={isBuiltinGeneration ? '计划生成模型' : '计划生成命令'}
                      className="mono"
                      value={isBuiltinGeneration ? selectedGeneration.model : selectedGeneration.command}
                      onChange={(event) =>
                        isBuiltinGeneration
                          ? cliSelection.onModelChange(type, event.target.value)
                          : cliSelection.onCommandChange(type, event.target.value)
                      }
                      placeholder={isBuiltinGeneration ? planBackendDefaultModel(selectedProvider) : planBackendDefaultCommand(selectedProvider)}
                    />
                  </label>
                  {isCodexProvider ? (
                    <label
                      className="composer-icon-select"
                      title={`Codex 思考深度：${selectedReasoningOption?.label || selectedReasoning}`}
                    >
                      <Icon name="thinking" size={18} aria-hidden="true" />
                      <span className="composer-select-label">{selectedReasoningOption?.label || selectedReasoning}</span>
                      <select
                        aria-label="选择 Codex 思考深度"
                        value={selectedReasoning}
                        onChange={(event) => cliSelection.onReasoningChange(type, event.target.value as CodexReasoningEffort)}
                      >
                        {cliSelection.reasoningOptions.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : null}
                </>
              ) : null}
            </div>
          ) : null}
          <PendingAttachmentList
            attachments={pendingAttachments}
            onRemove={(index) => onRemoveAttachment(type, index)}
          />
        </div>
        <div className="composer-actions">
          <div className="composer-draft-option">
            <label className="composer-draft-toggle" title={draftHelp}>
              <input
                checked={createAsDraft}
                onChange={(event) => setCreateAsDraft(event.target.checked)}
                type="checkbox"
              />
              <span>创建为草稿</span>
            </label>
            <span className="composer-help-trigger" title={draftHelp} aria-label={draftHelp}>
              <Icon name="help" size={14} className="composer-help-icon" aria-hidden="true" />
            </span>
          </div>
          <span>Enter 发送</span>
          <button className="send-button" type="submit" aria-label={submitLabel}>
            <Icon name="send" size={20} aria-hidden="true" />
          </button>
        </div>
      </div>
    </form>
  );
}

function PendingAttachmentList({
  attachments,
  onRemove,
}: {
  attachments: PendingAttachment[];
  onRemove: (index: number) => void;
}) {
  return (
    <div className="attachment-list pending">
      {attachments.map((attachment, index) => (
        <div className="pending-attachment" key={attachment.id}>
          <PendingAttachmentPreview attachment={attachment} />
          <span title={attachment.name}>{attachment.name}</span>
          <small>{formatBytes(attachment.size)}</small>
          <button type="button" onClick={() => onRemove(index)}>
            移除
          </button>
        </div>
      ))}
    </div>
  );
}

function PendingAttachmentPreview({ attachment }: { attachment: PendingAttachment }) {
  if (!attachment.type.startsWith('image/')) {
    return (
      <span className="pending-file-icon" aria-hidden="true">
        <Icon name="file" size={22} />
      </span>
    );
  }
  return (
    <img
      className="pending-thumb"
      src={
        attachment.source === PENDING_ATTACHMENT_SOURCES.PATH
          ? toSafeFileUrl(attachment.path)
          : attachment.previewUrl
      }
      alt={attachment.name || '附件'}
    />
  );
}
