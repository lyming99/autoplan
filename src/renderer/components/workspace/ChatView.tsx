import { useCallback, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { AppSnapshot, ChatMessage } from '../../types';
import { useChat } from '../../hooks/useChat';
import { Icon } from '../icons';

/* ------------------------------------------------------------------ 子组件 ------------------------------------------------------------------ */

/** 工具调用可折叠卡片 */
function ChatToolCard({ message }: { message: ChatMessage }) {
  const [expanded, setExpanded] = useState(false);
  const result = (message.toolResult || {}) as Record<string, unknown>;
  const name = String(result.name || '工具');
  const args = (result.args || {}) as Record<string, unknown>;
  const isLoading = result.loading === true;
  const toolResult = result.result;

  const argsSummary = Object.entries(args)
    .slice(0, 2)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v.slice(0, 40) : JSON.stringify(v).slice(0, 40)}`)
    .join(', ');

  return (
    <div className="chat-message chat-message--tool">
      <div className="chat-tool-card">
        <button
          className="chat-tool-card__header"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
        >
          <span className="chat-tool-card__icon">{isLoading ? '⚙' : '✓'}</span>
          <span className="chat-tool-card__name">{name}</span>
          {isLoading && <span className="chat-tool-card__loading">执行中…</span>}
          {argsSummary && !isLoading && (
            <span className="chat-tool-card__args">{argsSummary}</span>
          )}
          <span className="chat-tool-card__toggle">{expanded ? '▾' : '▸'}</span>
        </button>
        {expanded && toolResult !== undefined && (
          <div className="chat-tool-card__body">
            <pre><code>{formatToolResult(toolResult)}</code></pre>
          </div>
        )}
        {expanded && toolResult === undefined && isLoading && (
          <div className="chat-tool-card__body chat-tool-card__body--pending">等待结果…</div>
        )}
      </div>
    </div>
  );
}

function formatToolResult(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** 推理内容可折叠区域 */
function ReasoningSection({ content, isThinking }: { content: string; isThinking: boolean }) {
  const [expanded, setExpanded] = useState(false);

  if (!content && !isThinking) return null;

  return (
    <div className="chat-reasoning-collapsible">
      <button
        className="chat-reasoning-header"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <span className="chat-reasoning-header__icon">
          {isThinking ? '🤔' : '✅'}
        </span>
        <span className="chat-reasoning-header__label">
          {isThinking ? '思考中…' : '思考完成'}
        </span>
        <span className="chat-reasoning-header__toggle">
          {expanded ? '▾' : '▸'}
        </span>
      </button>
      {expanded && content ? (
        <div className="chat-reasoning-body">
          <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml>
            {content}
          </ReactMarkdown>
        </div>
      ) : null}
    </div>
  );
}

/** 单条消息气泡 */
function ChatMessageBubble({
  message,
  isThinking = false,
  thinkingContent = '',
}: {
  message: ChatMessage;
  isThinking?: boolean;
  thinkingContent?: string;
}) {
  switch (message.role) {
    case 'user':
      return (
        <div className="chat-message chat-message--user">
          <div className="chat-message__avatar" aria-label="用户">U</div>
          <div className="chat-message__bubble">{message.content}</div>
        </div>
      );

    case 'assistant': {
      const isStreaming = message.status === 'streaming';
      const isError = message.status === 'error' || message.status === 'aborted';
      const hasThinkingContent = thinkingContent.length > 0;
      const hasReplyContent = message.content.length > 0;

      return (
        <div className={`chat-message chat-message--assistant${isStreaming ? ' chat-message--streaming' : ''}`}>
          <div className="chat-message__avatar" aria-label="AI">AI</div>
          <div className="chat-message__bubble">
            {/* 错误消息 */}
            {isError ? (
              <span className="chat-message__error">
                {message.status === 'aborted' ? '已中止生成' : message.content || '生成失败'}
              </span>
            ) : null}

            {/* 思考中指示器（streaming + thinking + no reply yet） */}
            {!isError && isStreaming && isThinking && !hasReplyContent ? (
              <span className="chat-thinking-indicator">
                <span className="chat-thinking-indicator__icon">🤔</span>
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
              <span className="chat-message__pending">思考中…</span>
            ) : null}

            {/* 正式回复内容 */}
            {!isError && hasReplyContent ? (
              <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml>
                {message.content}
              </ReactMarkdown>
            ) : null}
          </div>
          {isStreaming && <span className="chat-message__cursor" aria-hidden>▊</span>}
        </div>
      );
    }

    case 'tool':
      return <ChatToolCard message={message} />;

    case 'system':
      return (
        <div className="chat-message chat-message--system">
          <span>{message.content}</span>
        </div>
      );

    default:
      return null;
  }
}

/* ------------------------------------------------------------------ 对话侧栏 ------------------------------------------------------------------ */

function ConversationSidebar({
  conversations,
  aiConfigs,
  activeConversationId,
  sidebarOpen,
  onToggleSidebar,
  onSelect,
  onCreate,
  onDelete,
  onRename,
  getAiConfigName,
  formatRelativeTime,
}: {
  conversations: Array<{
    id: number;
    title: string;
    ai_config_id: number | null;
    aiConfigId: number | null;
    updated_at: string;
    updatedAt: string;
  }>;
  aiConfigs: Array<{ id: number; name: string }>;
  activeConversationId: number | null;
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  onSelect: (id: number) => void;
  onCreate: () => void;
  onDelete: (id: number) => void;
  onRename: (id: number, title: string) => void;
  getAiConfigName: (configId: number | null) => string;
  formatRelativeTime: (iso: string) => string;
}) {
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const renameInputRef = useRef<HTMLInputElement>(null);

  const startRename = (id: number, currentTitle: string) => {
    setRenamingId(id);
    setRenameValue(currentTitle);
    setTimeout(() => renameInputRef.current?.focus(), 0);
  };

  const commitRename = (id: number) => {
    const trimmed = renameValue.trim();
    if (trimmed) onRename(id, trimmed);
    setRenamingId(null);
    setRenameValue('');
  };

  if (!sidebarOpen) {
    return (
      <button
        className="chat-sidebar-toggle chat-sidebar-toggle--closed"
        onClick={onToggleSidebar}
        aria-label="展开对话列表"
        title="展开对话列表"
      >
        <Icon name="chat" />
      </button>
    );
  }

  return (
    <div className="chat-sidebar">
      <div className="chat-sidebar__head">
        <span className="chat-sidebar__title">对话列表</span>
        <button
          className="chat-sidebar__collapse"
          onClick={onToggleSidebar}
          aria-label="收起对话列表"
          title="收起"
        >
          ✕
        </button>
      </div>

      <button
        className="chat-sidebar__new-btn"
        onClick={onCreate}
        aria-label="新建对话"
      >
        + 新建对话
      </button>

      <div className="chat-sidebar__list">
        {conversations.length === 0 ? (
          <div className="chat-sidebar__empty">暂无对话</div>
        ) : (
          conversations.map((conv) => {
            const cid = conv.id;
            const isActive = cid === activeConversationId;
            const updatedAt = conv.updated_at || conv.updatedAt || '';

            return (
              <div
                key={cid}
                className={`chat-sidebar__item${isActive ? ' chat-sidebar__item--active' : ''}`}
              >
                {renamingId === cid ? (
                  <input
                    ref={renameInputRef}
                    className="chat-sidebar__rename-input"
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onBlur={() => commitRename(cid)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitRename(cid);
                      if (e.key === 'Escape') {
                        setRenamingId(null);
                        setRenameValue('');
                      }
                    }}
                  />
                ) : (
                  <button
                    className="chat-sidebar__item-main"
                    onClick={() => onSelect(cid)}
                    aria-current={isActive ? 'true' : undefined}
                  >
                    <span className="chat-sidebar__item-title">
                      {conv.title || '新对话'}
                    </span>
                    <span className="chat-sidebar__item-meta">
                      {getAiConfigName(conv.ai_config_id ?? conv.aiConfigId)}
                      {updatedAt ? ` · ${formatRelativeTime(updatedAt)}` : ''}
                    </span>
                  </button>
                )}
                {renamingId !== cid && (
                  <div className="chat-sidebar__item-actions">
                    <button
                      className="chat-sidebar__action-btn"
                      title="重命名"
                      aria-label="重命名对话"
                      onClick={(e) => {
                        e.stopPropagation();
                        startRename(cid, conv.title);
                      }}
                    >
                      ✎
                    </button>
                    <button
                      className="chat-sidebar__action-btn chat-sidebar__action-btn--danger"
                      title="删除对话"
                      aria-label="删除对话"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (window.confirm('确认删除该对话？关联的消息将被清空。')) {
                          onDelete(cid);
                        }
                      }}
                    >
                      ✕
                    </button>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ 主组件 ------------------------------------------------------------------ */

/**
 * Chat 对话视图（需求 #26 / #28）。
 *
 * Props：
 * - projectId: 当前项目 ID
 * - snapshot: 项目快照（用于读取 hasApiKey 等配置信息）
 */
export function ChatView({ projectId }: { projectId: number; snapshot: AppSnapshot }) {
  const {
    messages,
    isStreaming,
    config,
    sendMessage,
    stopGeneration,
    clearSession,
    conversations,
    activeConversationId,
    switchConversation,
    createConversation,
    deleteConversation,
    renameConversation,
    getAiConfigName,
    formatRelativeTime,
    isThinking,
    thinkingContent,
    streamPhase,
  } = useChat(projectId);

  const [input, setInput] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  /* ---- 新消息自动滚到底部 ---- */
  useEffect(() => {
    const el = messagesEndRef.current;
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isStreaming]);

  /* ---- 发送 ---- */
  const handleSend = useCallback(() => {
    const text = input.trim();
    if (!text || isStreaming) return;
    sendMessage(text);
    setInput('');
  }, [input, isStreaming, sendMessage]);

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

  /* ---- 清空 ---- */
  const handleClear = useCallback(() => {
    if (!window.confirm('确认清空当前对话？此操作不可撤销。')) return;
    clearSession();
  }, [clearSession]);

  /* ---- 当前 AI 配置信息 ---- */
  const activeConv = conversations.find((c) => c.id === activeConversationId);
  const activeConfigName = activeConv
    ? getAiConfigName(activeConv.ai_config_id ?? activeConv.aiConfigId)
    : '';

  /* ---- 未配置 API Key ---- */
  if (config && !config.hasApiKey) {
    return (
      <div className="chat-container">
        <div className="chat-empty">
          <span className="chat-empty__icon"><Icon name="key" /></span>
          <p className="chat-empty__title">尚未配置 AI 接口</p>
          <p className="chat-empty__hint">
            请在「设置 → AI 对话」面板中配置 LLM 接口的 API Key、模型等参数后开始对话。
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="chat-container">
      {/* 对话侧栏 */}
      <ConversationSidebar
        conversations={conversations}
        aiConfigs={[]}
        activeConversationId={activeConversationId}
        sidebarOpen={sidebarOpen}
        onToggleSidebar={() => setSidebarOpen((v) => !v)}
        onSelect={(id) => { void switchConversation(id); }}
        onCreate={() => { void createConversation(); }}
        onDelete={(id) => { void deleteConversation(id); }}
        onRename={(id, title) => { void renameConversation(id, title); }}
        getAiConfigName={getAiConfigName}
        formatRelativeTime={formatRelativeTime}
      />

      {/* 主区域 */}
      <div className="chat-main">
        {/* 当前 AI 配置指示器 */}
        {activeConversationId && activeConfigName ? (
          <div className="chat-config-indicator">
            <span className="chat-config-indicator__label">AI 配置：</span>
            <span className="chat-config-indicator__value">{activeConfigName}</span>
          </div>
        ) : null}

        <div className="chat-messages" ref={messagesContainerRef}>
          {messages.length === 0 && !isStreaming && (
            <div className="chat-empty">
              <span className="chat-empty__icon"><Icon name="send" /></span>
              <p className="chat-empty__title">
                {activeConversationId ? '开始对话' : '选择或创建对话'}
              </p>
              <p className="chat-empty__hint">
                {activeConversationId
                  ? 'AI 可读取项目文件、搜索代码、创建需求/反馈/脚本。\n输入消息后按 Enter 发送，Shift + Enter 换行。'
                  : '点击左侧「新建对话」创建第一个对话。'}
              </p>
            </div>
          )}

          {messages.map((msg, i) => {
            const isLast = i === messages.length - 1;
            const isLastStreaming = isLast && msg.role === 'assistant' && msg.status === 'streaming';
            return (
              <ChatMessageBubble
                key={msg.id}
                message={msg}
                isThinking={isLastStreaming ? isThinking : false}
                thinkingContent={isLastStreaming ? thinkingContent : ''}
              />
            );
          })}

          <div ref={messagesEndRef} />
        </div>

        <div className="chat-input-bar">
          <textarea
            ref={textareaRef}
            className="chat-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={
              streamPhase === 'thinking'
                ? 'AI 正在思考…'
                : streamPhase === 'replying'
                  ? 'AI 正在回复…'
                  : activeConversationId
                    ? '输入消息…（Enter 发送，Shift+Enter 换行）'
                    : '请先选择或创建对话'
            }
            rows={2}
            disabled={isStreaming || !activeConversationId}
            aria-label="消息输入框"
          />
          <div className="chat-input-actions">
            {isStreaming ? (
              <button
                className="chat-stop-btn"
                onClick={() => stopGeneration()}
                aria-label="停止生成"
              >
                <Icon name="stop" /> 停止
              </button>
            ) : (
              <button
                className="chat-send-btn"
                onClick={handleSend}
                disabled={!input.trim() || !activeConversationId}
                aria-label="发送消息"
              >
                <Icon name="send" /> 发送
              </button>
            )}
            <button
              className="chat-clear-btn"
              onClick={handleClear}
              disabled={(isStreaming && messages.length === 0) || !activeConversationId}
              aria-label="清空对话"
            >
              <Icon name="trash" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default ChatView;
