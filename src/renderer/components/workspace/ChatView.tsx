import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ChatMessage, OpenIntakeHandler, WorkspaceChatState } from '../../types';
import type { ChatThinkingDepth, WorkspaceChatComposerActions } from '../../hooks/useChat';
import {
  aiProviderLabel,
  aiThinkingDepthLabel,
  chatProviderRequiresApiKey,
  isChatConfigAvailableForSend,
  normalizeAiThinkingDepthInput,
  providerSupportsThinkingDepth,
  thinkingDepthOptionsForProvider,
} from '../../utils/workspaceForms';
import { parseOpenIntakeIntent } from '../../utils/chatIntents';
import { Icon } from '../icons';
import { ChatToolCard } from './ChatToolCard';
import { ChatQueueView } from './ChatQueueView';

/* ------------------------------------------------------------------ 子组件 ------------------------------------------------------------------ */

/** 推理内容可折叠区域 */
function ReasoningSection({ content, isThinking }: { content: string; isThinking: boolean }) {
  const [expanded, setExpanded] = useState(false);

  if (!content && !isThinking) return null;

  return (
    <div className={`chat-reasoning-collapsible${isThinking ? ' is-thinking' : ''}${expanded ? ' is-expanded' : ''}`}>
      <button
        className="chat-reasoning-header"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <span className="chat-reasoning-header__icon" aria-hidden>
          <Icon name={isThinking ? 'thinking' : 'check'} size={14} />
        </span>
        <span className="chat-reasoning-header__label">
          {isThinking ? '思考中...' : '思考完成'}
        </span>
        <span className="chat-reasoning-header__toggle" aria-hidden>
          <Icon name="chevron-down" size={14} />
        </span>
      </button>
      {expanded && content ? (
        <div className="chat-reasoning-body">
          <div className="chat-markdown chat-markdown--reasoning">
            <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml>
              {content}
            </ReactMarkdown>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** 单条消息 */
function ChatMessageBubble({
  message,
  isThinking = false,
  thinkingContent = '',
  onOpenIntake,
}: {
  message: ChatMessage;
  isThinking?: boolean;
  thinkingContent?: string;
  onOpenIntake?: OpenIntakeHandler;
}) {
  switch (message.role) {
    case 'user':
      return (
        <div className="chat-message chat-message--user">
          <div className="chat-message__content">
            <div className="chat-message__bubble chat-message__bubble--plain">
              <div className="chat-message__text">{message.content}</div>
            </div>
          </div>
        </div>
      );

    case 'assistant': {
      const isStreaming = message.status === 'streaming';
      const isError = message.status === 'error' || message.status === 'aborted';
      const hasThinkingContent = thinkingContent.length > 0;
      const hasReplyContent = message.content.length > 0;

      return (
        <div className={`chat-message chat-message--assistant${isStreaming ? ' chat-message--streaming' : ''}`}>
          <div className="chat-message__content">
            <div className="chat-message__body chat-message__body--markdown">
              {/* 错误消息 */}
              {isError ? (
                <span className="chat-message__error">
                  {message.status === 'aborted' ? '已中止生成' : message.content || '生成失败'}
                </span>
              ) : null}

              {/* 思考中指示器（streaming + thinking + no reply yet） */}
              {!isError && isStreaming && isThinking && !hasReplyContent ? (
                <span className="chat-thinking-indicator">
                  <span className="chat-thinking-indicator__icon" aria-hidden><Icon name="thinking" size={16} /></span>
                  <span className="chat-thinking-indicator__text">思考中</span>
                  <span className="chat-thinking-dots">
                    <span className="chat-thinking-dots__dot" />
                    <span className="chat-thinking-dots__dot" />
                    <span className="chat-thinking-dots__dot" />
                  </span>
                </span>
              ) : null}

              {/* 推理内容可折叠区域 */}
              {!isError && hasThinkingContent ? (
                <ReasoningSection content={thinkingContent} isThinking={isThinking} />
              ) : null}

              {/* 旧 provider 兼容：无 thinking 事件时的占位 */}
              {!isError && !isThinking && !hasThinkingContent && isStreaming && !hasReplyContent ? (
                <span className="chat-message__pending">思考中...</span>
              ) : null}

              {/* 正式回复内容 */}
              {!isError && hasReplyContent ? (
                <div className="chat-markdown">
                  <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml>
                    {message.content}
                  </ReactMarkdown>
                </div>
              ) : null}
            </div>
            {isStreaming && <span className="chat-message__cursor" aria-hidden />}
          </div>
        </div>
      );
    }

    case 'tool':
      return <ChatToolCard message={message} onOpenIntake={onOpenIntake} />;

    case 'system':
      return (
        <div className="chat-message chat-message--system">
          <div className="chat-system-message">{message.content}</div>
        </div>
      );

    default:
      return null;
  }
}

type ChatEmptyStateKind = 'missing-key' | 'no-conversation' | 'empty-conversation';

type ChatConfigSummary = {
  name?: string;
  provider?: string | null;
  model?: string | null;
  hasApiKey?: boolean;
};

function chatConfigModelLabel(config?: ChatConfigSummary | null): string {
  if (!config) return '无可用配置';
  const provider = config.provider || 'openai';
  if (!chatProviderRequiresApiKey(provider)) {
    return config.model || 'Codex CLI 本地后端';
  }
  return config.model || '未设置模型';
}

function chatConfigKeySuffix(config: ChatConfigSummary): string {
  if (!chatProviderRequiresApiKey(config.provider)) return '';
  return config.hasApiKey ? '' : ' · 未配置 Key';
}

function ChatEmptyState({
  kind,
  onCreateConversation,
}: {
  kind: ChatEmptyStateKind;
  onCreateConversation: () => void;
}) {
  const content = {
    'missing-key': {
      icon: 'key' as const,
      title: '尚未配置 AI 接口',
      hint: '在设置的 AI 对话面板中配置全局 API Key 后即可发送消息。',
      action: false,
    },
    'no-conversation': {
      icon: 'chat' as const,
      title: '选择或创建对话',
      hint: '从左侧对话列表选择已有会话，或新建对话开始一次独立上下文。',
      action: true,
    },
    'empty-conversation': {
      icon: 'send' as const,
      title: '开始对话',
      hint: '输入消息后按 Enter 发送，Shift + Enter 换行。AI 可读取项目文件并协助推进需求。',
      action: false,
    },
  }[kind];

  return (
    <div className={`chat-empty chat-empty--${kind}`}>
      <span className="chat-empty__icon" aria-hidden><Icon name={content.icon} /></span>
      <p className="chat-empty__title">{content.title}</p>
      <p className="chat-empty__hint">{content.hint}</p>
      {content.action ? (
        <button
          type="button"
          className="btn btn-sm btn-primary"
          onClick={onCreateConversation}
          aria-label="新建对话"
        >
          <Icon name="chat" size={14} aria-hidden />
          新建对话
        </button>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ 主组件 ------------------------------------------------------------------ */

/**
 * Chat 对话视图（需求 #26 / #28）。
 *
 * Props：
 * - chatState: 工作区层共享的聊天状态容器
 */
export function ChatView({ chatState, onOpenIntake }: { chatState: WorkspaceChatState; onOpenIntake?: OpenIntakeHandler }) {
  const {
    messages,
    isStreaming,
    config,
    sendMessage,
    stopGeneration,
    clearSession,
    conversations,
    aiConfigs,
    activeConversationId,
    createConversation,
    getAiConfigName,
    isThinking,
    thinkingContent,
    streamPhase,
    queue,
    queueCount,
  } = chatState;
  const { cancelQueueItem, editQueueItem, clearQueue } = chatState;
  const composerActions = chatState as WorkspaceChatState & Partial<WorkspaceChatComposerActions>;
  const { updateConversationAiConfig, updateActiveAiConfigThinkingDepth } = composerActions;

  const [input, setInput] = useState('');
  const [isComposerConfigSaving, setIsComposerConfigSaving] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  /* ---- 当前模型配置 ---- */
  const activeConv = conversations.find((c) => c.id === activeConversationId);
  // 当前项目 id：意图直达「打开需求/反馈 #N」需用其定位（活动会话所属项目，回退到最近一条消息）
  const currentProjectId = activeConv?.project_id
    ?? (messages.length > 0 ? messages[messages.length - 1].projectId : null)
    ?? null;
  const activeAiConfigId = config?.aiConfigId ?? (activeConv
    ? activeConv.ai_config_id ?? activeConv.aiConfigId
    : null);
  const currentAiConfig = useMemo(
    () => aiConfigs.find((item) => item.id === activeAiConfigId) ?? null,
    [activeAiConfigId, aiConfigs],
  );
  const activeConfigName = currentAiConfig?.name || config?.name || (activeConv
    ? getAiConfigName(activeConv.ai_config_id ?? activeConv.aiConfigId)
    : '');
  const selectedProvider = currentAiConfig?.provider || config?.provider || 'openai';
  const canSendWithCurrentConfig = isChatConfigAvailableForSend(currentAiConfig ?? config);
  const missingRequiredApiKey = chatProviderRequiresApiKey(selectedProvider) && !canSendWithCurrentConfig;
  const providerOptions = useMemo(() => {
    const providers = new Map<string, { value: string; label: string }>();
    for (const item of aiConfigs) {
      const provider = item.provider || 'openai';
      if (!providers.has(provider)) {
        providers.set(provider, { value: provider, label: aiProviderLabel(provider) });
      }
    }
    if (!providers.has(selectedProvider)) {
      providers.set(selectedProvider, { value: selectedProvider, label: aiProviderLabel(selectedProvider) });
    }
    return Array.from(providers.values());
  }, [aiConfigs, selectedProvider]);
  const providerConfigs = useMemo(
    () => aiConfigs.filter((item) => (item.provider || 'openai') === selectedProvider),
    [aiConfigs, selectedProvider],
  );
  const configSelectOptions = providerConfigs.length > 0
    ? providerConfigs
    : currentAiConfig
      ? [currentAiConfig]
      : [];
  const selectedConfigId = currentAiConfig?.id ?? config?.aiConfigId ?? configSelectOptions[0]?.id ?? null;
  const selectedThinkingDepth = normalizeAiThinkingDepthInput(
    currentAiConfig?.thinkingDepth ?? config?.thinkingDepth,
    selectedProvider,
  );
  const supportsThinkingDepth = providerSupportsThinkingDepth(selectedProvider);
  const thinkingDepthSelectOptions = useMemo(
    () => (supportsThinkingDepth ? thinkingDepthOptionsForProvider(selectedProvider) : []),
    [selectedProvider, supportsThinkingDepth],
  );
  const activeModelLabel = currentAiConfig
    ? `${currentAiConfig.name} · ${chatConfigModelLabel(currentAiConfig)}`
    : activeConfigName
      ? `${activeConfigName} · ${chatConfigModelLabel(config)}`
      : chatConfigModelLabel(config);
  const configControlsDisabled =
    !activeConversationId || isStreaming || isComposerConfigSaving || aiConfigs.length === 0;
  const thinkingDepthDisabled =
    configControlsDisabled ||
    !supportsThinkingDepth ||
    selectedConfigId == null ||
    !updateActiveAiConfigThinkingDepth;
  const inputDisabled = !activeConversationId || !canSendWithCurrentConfig; // 流式中输入框保持可用（需求 #37）
  const sendDisabled = !input.trim() || inputDisabled;
  /* ---- 新消息自动滚到底部 ---- */
  useEffect(() => {
    const el = messagesEndRef.current;
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isStreaming]);

  const resizeTextarea = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, []);

  useEffect(() => {
    resizeTextarea();
  }, [input, resizeTextarea]);

  /* ---- 发送 ---- */
  const handleSend = useCallback(() => {
    const text = input.trim();
    // 移除流式中发送守卫：回复中也可继续输入并入队（需求 #37）
    if (!text || !activeConversationId || !canSendWithCurrentConfig) return;
    // 意图直达：识别「打开/查看 需求/反馈 #N」并立即触发；无论是否命中均继续正常发送（保留 AI 补充说明）
    if (onOpenIntake && currentProjectId) {
      const intent = parseOpenIntakeIntent(text);
      if (intent) onOpenIntake({ type: intent.type, projectId: currentProjectId, id: intent.id });
    }
    void sendMessage(text);
    setInput('');
  }, [activeConversationId, canSendWithCurrentConfig, currentProjectId, input, onOpenIntake, sendMessage]);

  /* ---- 键盘 ---- */
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  const handleComposerSubmit = useCallback(
    (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      handleSend();
    },
    [handleSend],
  );

  /* ---- 清空 ---- */
  const handleClear = useCallback(() => {
    if (!window.confirm('确认清空当前对话？此操作不可撤销。')) return;
    void clearSession();
  }, [clearSession]);

  const handleCreateConversation = useCallback(() => {
    void createConversation();
  }, [createConversation]);

  const commitComposerConfigUpdate = useCallback(
    (action: () => Promise<void>) => {
      if (isComposerConfigSaving) return;
      setIsComposerConfigSaving(true);
      void action()
        .catch(() => {})
        .finally(() => {
          setIsComposerConfigSaving(false);
        });
    },
    [isComposerConfigSaving],
  );

  const handleProviderChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const nextProvider = e.target.value;
      if (!activeConversationId || isStreaming || !updateConversationAiConfig) return;
      const matches = aiConfigs.filter((item) => (item.provider || 'openai') === nextProvider);
      const nextConfig = matches.find((item) => isChatConfigAvailableForSend(item)) ?? matches[0];
      if (!nextConfig || nextConfig.id === selectedConfigId) return;
      commitComposerConfigUpdate(() => updateConversationAiConfig(nextConfig.id));
    },
    [
      activeConversationId,
      aiConfigs,
      commitComposerConfigUpdate,
      isStreaming,
      selectedConfigId,
      updateConversationAiConfig,
    ],
  );

  const handleConfigChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const nextConfigId = Number(e.target.value);
      if (
        !Number.isInteger(nextConfigId) ||
        nextConfigId <= 0 ||
        nextConfigId === selectedConfigId ||
        !activeConversationId ||
        isStreaming ||
        !updateConversationAiConfig
      ) {
        return;
      }
      commitComposerConfigUpdate(() => updateConversationAiConfig(nextConfigId));
    },
    [
      activeConversationId,
      commitComposerConfigUpdate,
      isStreaming,
      selectedConfigId,
      updateConversationAiConfig,
    ],
  );

  const handleThinkingDepthChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      if (!supportsThinkingDepth || thinkingDepthDisabled) return;
      const normalized = normalizeAiThinkingDepthInput(e.target.value, selectedProvider);
      const nextDepth: ChatThinkingDepth = normalized ? normalized : null;
      const currentDepth: ChatThinkingDepth = selectedThinkingDepth ? selectedThinkingDepth : null;
      if (nextDepth === currentDepth || !updateActiveAiConfigThinkingDepth) return;
      commitComposerConfigUpdate(() => updateActiveAiConfigThinkingDepth(nextDepth));
    },
    [
      commitComposerConfigUpdate,
      selectedThinkingDepth,
      selectedProvider,
      supportsThinkingDepth,
      thinkingDepthDisabled,
      updateActiveAiConfigThinkingDepth,
    ],
  );

  const emptyStateKind: ChatEmptyStateKind = missingRequiredApiKey
    ? 'missing-key'
    : activeConversationId
      ? 'empty-conversation'
      : 'no-conversation';

  return (
    <div className="chat-container">
      <div className="chat-main">
        <div className="chat-messages" ref={messagesContainerRef}>
          <div className="chat-messages__inner">
            {messages.length === 0 && !isStreaming ? (
              <ChatEmptyState
                kind={emptyStateKind}
                onCreateConversation={handleCreateConversation}
              />
            ) : null}

            {messages.map((msg, i) => {
              if (msg.status === 'queued') return null; // 排队态消息由队列视图渲染，避免重复（需求 #37）
              const isLast = i === messages.length - 1;
              const isLastStreaming = isLast && msg.role === 'assistant' && msg.status === 'streaming';
              return (
                <ChatMessageBubble
                  key={msg.id}
                  message={msg}
                  isThinking={isLastStreaming ? isThinking : false}
                  thinkingContent={isLastStreaming ? thinkingContent : ''}
                  onOpenIntake={onOpenIntake}
                />
              );
            })}

            <ChatQueueView
              queue={queue}
              cancelQueueItem={cancelQueueItem}
              editQueueItem={editQueueItem}
              clearQueue={clearQueue}
            />

            <div ref={messagesEndRef} />
          </div>
        </div>

        <div className="chat-composer-zone">
          <form className="chat-composer" onSubmit={handleComposerSubmit}>
            <textarea
              ref={textareaRef}
              className="chat-composer__textarea"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={
                streamPhase === 'thinking'
                  ? 'AI 正在思考…'
                  : streamPhase === 'replying'
                    ? 'AI 正在回复…'
                    : missingRequiredApiKey
                      ? '请先在设置中配置全局 AI 接口'
                      : activeConversationId
                        ? '输入消息…（Enter 发送，Shift+Enter 换行）'
                        : '请先选择或创建对话'
              }
              rows={1}
              disabled={inputDisabled}
              aria-label="消息输入框"
            />

            <div className="chat-composer__bar">
              <div className="chat-composer__tools" aria-label="AI 模型配置">
                <label
                  className="chat-model-select chat-model-select--provider"
                  title="选择模型供应商"
                >
                  <Icon name="bolt" size={16} aria-hidden />
                  <span className="chat-model-select__label">{aiProviderLabel(selectedProvider)}</span>
                  <select
                    value={selectedProvider}
                    onChange={handleProviderChange}
                    disabled={configControlsDisabled}
                    aria-label="选择模型供应商"
                  >
                    {providerOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="chat-model-select" title="选择模型配置">
                  <Icon name="chat" size={16} aria-hidden />
                  <span className="chat-model-select__label">{activeModelLabel}</span>
                  <select
                    value={selectedConfigId != null ? String(selectedConfigId) : ''}
                    onChange={handleConfigChange}
                    disabled={configControlsDisabled}
                    aria-label="选择模型配置"
                  >
                    {configSelectOptions.length > 0 ? (
                      configSelectOptions.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name} · {chatConfigModelLabel(item)}
                          {chatConfigKeySuffix(item)}
                        </option>
                      ))
                    ) : (
                      <option value="">无可用配置</option>
                    )}
                  </select>
                </label>

                <label
                  className={`chat-model-select${thinkingDepthDisabled ? ' is-disabled' : ''}`}
                  title={supportsThinkingDepth ? '选择思考深度' : '当前供应商不支持思考深度'}
                >
                  <Icon name="thinking" size={16} aria-hidden />
                  <span className="chat-model-select__label">
                    {supportsThinkingDepth ? aiThinkingDepthLabel(selectedThinkingDepth, selectedProvider) : '思考 · 不支持'}
                  </span>
                  <select
                    value={selectedThinkingDepth}
                    onChange={handleThinkingDepthChange}
                    disabled={thinkingDepthDisabled}
                    aria-label="选择思考深度"
                  >
                    {supportsThinkingDepth ? (
                      thinkingDepthSelectOptions.map((option) => (
                        <option key={option.value || 'off'} value={option.value}>
                          思考 · {option.label}
                        </option>
                      ))
                    ) : (
                      <option value="">思考 · 不支持</option>
                    )}
                  </select>
                </label>
              </div>

              <div className="chat-composer__actions">
                {queueCount && queueCount > 0 ? (
                  <span className="chat-queue-count" title="未发送的排队消息">队列中 {queueCount} 条</span>
                ) : null}
                <button
                  type="button"
                  className="chat-icon-btn"
                  onClick={handleClear}
                  disabled={isStreaming || messages.length === 0 || !activeConversationId}
                  aria-label="清空当前对话"
                  title="清空当前对话"
                >
                  <Icon name="trash" size={16} aria-hidden />
                </button>
                <span className="chat-composer__hint">
                  {isStreaming ? '可继续输入排队 · Enter 发送' : 'Enter 发送'}
                </span>
                {isStreaming ? (
                  <button
                    type="button"
                    className="stop-button"
                    onClick={() => { void stopGeneration(); }}
                    aria-label="停止生成"
                    title="停止当前生成"
                  >
                    <Icon name="stop" size={18} aria-hidden />
                  </button>
                ) : null}
                <button
                  type="submit"
                  className="send-button"
                  disabled={sendDisabled}
                  aria-label="发送消息"
                  title={isStreaming ? '加入队列' : '发送消息'}
                >
                  <Icon name="send" size={20} aria-hidden />
                </button>
              </div>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}

export default ChatView;
