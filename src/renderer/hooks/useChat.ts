import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AiConfig,
  ChatConfig,
  ChatMessage,
  ChatStreamPhase,
  ChatToolCall,
  Conversation,
  WorkspaceChatState,
} from '../types';
import { useChatQueue } from './useChatQueue';

/* ------------------------------------------------------------------ 辅助 ------------------------------------------------------------------ */

function makeTempId(counter: { value: number }) {
  return -(counter.value += 1);
}

function newMessage(
  projectId: number,
  role: ChatMessage['role'],
  overrides: Partial<ChatMessage> = {},
): ChatMessage {
  return {
    id: 0,
    projectId,
    role,
    content: '',
    toolCalls: null,
    toolResult: null,
    status: 'done',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function getAiConfigName(configs: AiConfig[], configId: number | null): string {
  const fallback = configs.find((c) => c.hasApiKey) ?? configs[0];
  if (configId == null) {
    return fallback ? fallback.name : '默认配置';
  }
  const found = configs.find((c) => c.id === configId);
  return found ? found.name : fallback ? fallback.name : '默认配置';
}

function getConversationAiConfigId(conversation: Conversation | null | undefined): number | null {
  return conversation?.ai_config_id ?? conversation?.aiConfigId ?? null;
}

const AUTO_TITLE_PLACEHOLDERS = new Set(['新对话', '默认对话']);

function normalizeDoneConversationId(value: unknown): number | null {
  const id = Number(value || 0);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function shouldApplyAutoTitle(currentTitle: string | null | undefined): boolean {
  const title = String(currentTitle || '').trim();
  return title === '' || AUTO_TITLE_PLACEHOLDERS.has(title);
}

export type ChatThinkingDepth = AiConfig['thinkingDepth'];

export type WorkspaceChatComposerActions = {
  updateConversationAiConfig: (configId: number | null) => Promise<void>;
  updateActiveAiConfigThinkingDepth: (thinkingDepth: ChatThinkingDepth) => Promise<void>;
};

export type CreateConversationOptions = {
  activate?: boolean;
};

function resolveCurrentAiConfig(
  configs: AiConfig[],
  conversations: Conversation[],
  activeConversationId: number | null,
): AiConfig | null {
  const activeConversation = activeConversationId
    ? conversations.find((c) => c.id === activeConversationId)
    : null;
  const boundConfigId = getConversationAiConfigId(activeConversation);

  if (boundConfigId != null) {
    const bound = configs.find((c) => c.id === boundConfigId);
    if (bound) return bound;
  }

  return configs.find((c) => c.hasApiKey) ?? configs[0] ?? null;
}

function normalizeConversationAiConfigBinding(conversation: Conversation, configs: AiConfig[]): Conversation {
  const boundConfigId = getConversationAiConfigId(conversation);
  if (boundConfigId == null || configs.some((config) => config.id === boundConfigId)) {
    return conversation;
  }
  return {
    ...conversation,
    ai_config_id: null,
    aiConfigId: null,
  };
}

function normalizeConversationAiConfigBindings(conversations: Conversation[], configs: AiConfig[]): Conversation[] {
  return conversations.map((conversation) => normalizeConversationAiConfigBinding(conversation, configs));
}

function toChatConfig(aiConfig: AiConfig | null): ChatConfig {
  if (!aiConfig) {
    return {
      aiConfigId: null,
      name: '默认配置',
      provider: 'openai',
      baseUrl: 'https://api.openai.com',
      hasApiKey: false,
      maskedKey: '',
      model: 'gpt-4o',
      temperature: '0.3',
      thinkingDepth: null,
      thinkingBudgetTokens: null,
    };
  }

  return {
    aiConfigId: aiConfig.id,
    name: aiConfig.name,
    provider: aiConfig.provider,
    baseUrl: aiConfig.baseUrl,
    hasApiKey: aiConfig.hasApiKey,
    maskedKey: aiConfig.maskedKey,
    model: aiConfig.model,
    temperature: aiConfig.temperature,
    thinkingDepth: aiConfig.thinkingDepth,
    thinkingBudgetTokens: aiConfig.thinkingBudgetTokens,
  };
}

/** 格式化相对时间 */
function formatRelativeTime(iso: string): string {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return '刚刚';
  if (mins < 60) return `${mins} 分钟前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  return new Date(iso).toLocaleDateString('zh-CN');
}

/* ------------------------------------------------------------------ Hook ------------------------------------------------------------------ */

/**
 * Chat 对话模块状态管理（需求 #26 / #28）。
 *
 * 职责：
 * - 管理消息列表、流式状态、当前工具调用
 * - 管理多对话列表（conversations）与活跃对话切换
 * - mount 时加载全局 AI 配置与项目对话列表
 * - projectId / activeConversationId 变更时重新加载历史消息
 * - 订阅 onChatChunk / onChatDone 事件，实时拼装消息
 * - 切换对话时正确清理上一个对话的流式状态
 */
export function useChat(projectId: number): WorkspaceChatState {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingContent, setStreamingContent] = useState('');
  const [streamingToolCall, setStreamingToolCall] = useState<ChatToolCall | null>(null);

  // 多对话状态（需求 #28）
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [aiConfigs, setAiConfigs] = useState<AiConfig[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<number | null>(null);
  const config = useMemo(
    () => toChatConfig(resolveCurrentAiConfig(aiConfigs, conversations, activeConversationId)),
    [activeConversationId, aiConfigs, conversations],
  );

  // 思考状态（需求 #28）
  const [isThinking, setIsThinking] = useState(false);
  const [thinkingContent, setThinkingContent] = useState('');
  const [streamPhase, setStreamPhase] = useState<ChatStreamPhase>('idle');

  // Refs 避免事件回调中的闭包过期问题
  const tempIdRef = useRef({ value: 0 });
  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;
  const conversationsRequestRef = useRef(0);
  const stateRef = useRef({
    isStreaming: false,
    streamingContent: '',
    streamingToolCall: null as ChatToolCall | null,
    messages: [] as ChatMessage[],
    activeConversationId: null as number | null,
    awaitingResponse: false,
    isThinking: false,
    thinkingContent: '',
    streamPhase: 'idle' as ChatStreamPhase,
    projectId,
  });

  const resetTransientState = useCallback(() => {
    stateRef.current.isStreaming = false;
    stateRef.current.streamingContent = '';
    stateRef.current.streamingToolCall = null;
    stateRef.current.awaitingResponse = false;
    stateRef.current.isThinking = false;
    stateRef.current.thinkingContent = '';
    stateRef.current.streamPhase = 'idle';
    setIsStreaming(false);
    setStreamingContent('');
    setStreamingToolCall(null);
    setIsThinking(false);
    setThinkingContent('');
    setStreamPhase('idle');
  }, []);

  const resetMessages = useCallback(() => {
    stateRef.current.messages = [];
    setMessages([]);
  }, []);

  const resetActiveConversation = useCallback(
    (conversationId: number | null) => {
      stateRef.current.activeConversationId = conversationId;
      setActiveConversationId(conversationId);
      resetMessages();
      resetTransientState();
    },
    [resetMessages, resetTransientState],
  );

  /* ---- 加载对话列表与 AI 配置列表 ---- */

  const loadConversations = useCallback(async () => {
    if (!projectId) return;
    const requestId = (conversationsRequestRef.current += 1);
    const loadingProjectId = projectId;
    try {
      const [convs, cfgs] = await Promise.all([
        window.autoplan.conversationList({ projectId }),
        window.autoplan.aiConfigList().catch(() => [] as AiConfig[]),
      ]);
      if (requestId !== conversationsRequestRef.current || loadingProjectId !== projectIdRef.current) {
        return;
      }
      const normalizedConversations = normalizeConversationAiConfigBindings(convs, cfgs);
      setConversations(normalizedConversations);
      setAiConfigs(cfgs);

      const currentId = stateRef.current.activeConversationId;
      const currentExists = currentId != null && normalizedConversations.some((conv) => conv.id === currentId);
      const nextId = normalizedConversations.length === 0 ? null : currentExists ? currentId : normalizedConversations[0].id;

      if (nextId !== currentId) {
        resetActiveConversation(nextId);
      }
    } catch {
      /* 加载失败忽略 */
    }
  }, [projectId, resetActiveConversation]);

  const refreshAiConfigState = useCallback(async (eventConfigs?: AiConfig[]) => {
    if (eventConfigs) {
      setAiConfigs(eventConfigs);
      setConversations((current) => normalizeConversationAiConfigBindings(current, eventConfigs));
    }
    if (projectIdRef.current) {
      await loadConversations();
      return;
    }
    if (!eventConfigs) {
      const cfgs = await window.autoplan.aiConfigList().catch(() => [] as AiConfig[]);
      setAiConfigs(cfgs);
      setConversations((current) => normalizeConversationAiConfigBindings(current, cfgs));
    }
  }, [loadConversations]);

  useEffect(() => {
    const previousProjectId = stateRef.current.projectId;
    const previousConversationId = stateRef.current.activeConversationId;
    conversationsRequestRef.current += 1;
    if (
      (stateRef.current.isStreaming ||
        stateRef.current.awaitingResponse ||
        stateRef.current.streamPhase !== 'idle') &&
      previousConversationId &&
      previousProjectId
    ) {
      window.autoplan
        .chatStop({ projectId: previousProjectId, conversationId: previousConversationId })
        .catch(() => {});
    }
    stateRef.current.projectId = projectId;
    setConversations([]);
    resetActiveConversation(null);
    if (projectId) {
      loadConversations();
    } else {
      void refreshAiConfigState();
    }
  }, [projectId, loadConversations, refreshAiConfigState, resetActiveConversation]);

  useEffect(() => {
    return window.autoplan.onAiConfigChanged((event) => {
      void refreshAiConfigState(Array.isArray(event.configs) ? event.configs : undefined);
    });
  }, [refreshAiConfigState]);

  /* ---- activeConversationId 变更：重新加载历史 ---- */

  const loadHistory = useCallback(async (cid: number) => {
    if (!projectId) return;
    const loadingProjectId = projectId;
    try {
      const history = await window.autoplan.chatHistory({ projectId: loadingProjectId, conversationId: cid });
      if (stateRef.current.activeConversationId !== cid || projectIdRef.current !== loadingProjectId) return;
      setMessages(history);
      stateRef.current.messages = history;
    } catch {
      if (stateRef.current.activeConversationId !== cid || projectIdRef.current !== loadingProjectId) return;
      setMessages([]);
      stateRef.current.messages = [];
    }
  }, [projectId]);

  const syncDoneConversationTitle = useCallback((conversationId: number | null, title: string | null | undefined) => {
    const nextTitle = String(title || '').trim();
    if (!conversationId || !nextTitle) return;

    setConversations((current) => {
      let changed = false;
      const next = current.map((conversation) => {
        if (conversation.id !== conversationId || !shouldApplyAutoTitle(conversation.title)) {
          return conversation;
        }
        changed = true;
        return { ...conversation, title: nextTitle };
      });
      return changed ? next : current;
    });
  }, []);

  useEffect(() => {
    if (activeConversationId) loadHistory(activeConversationId);
    else {
      resetMessages();
    }
  }, [activeConversationId, loadHistory, resetMessages]);

  /* ---- 订阅流式事件 ---- */

  useEffect(() => {
    const s = stateRef;

    const unsubChunk = window.autoplan.onChatChunk((event) => {
      const cur = s.current;
      if (!cur.activeConversationId && event.type !== 'status') return;
      if (
        event.type !== 'status' &&
        !cur.awaitingResponse &&
        !cur.isStreaming &&
        cur.streamPhase === 'idle'
      ) {
        return;
      }

      switch (event.type) {
        /* -------- text_delta -------- */
        case 'text_delta': {
          const text = String(event.data?.content || '');
          cur.streamingContent += text;
          setStreamingContent(cur.streamingContent);

          // 首个 text_delta → 切换为回复阶段
          if (cur.streamPhase !== 'replying') {
            cur.streamPhase = 'replying';
            setStreamPhase('replying');
          }

          let streamingAssistantIndex = -1;
          for (let i = cur.messages.length - 1; i >= 0; i -= 1) {
            if (cur.messages[i].role === 'assistant' && cur.messages[i].status === 'streaming') {
              streamingAssistantIndex = i;
              break;
            }
          }

          if (!cur.isStreaming || streamingAssistantIndex === -1) {
            cur.isStreaming = true;
            setIsStreaming(true);
            const placeholder = newMessage(projectId, 'assistant', {
              id: makeTempId(tempIdRef.current),
              content: text,
              status: 'streaming',
            });
            cur.messages = [...cur.messages, placeholder];
            setMessages(cur.messages);
          } else {
            const msgs = [...cur.messages];
            msgs[streamingAssistantIndex] = { ...msgs[streamingAssistantIndex], content: cur.streamingContent };
            cur.messages = msgs;
            setMessages(msgs);
          }
          break;
        }

        /* -------- tool_start -------- */
        case 'tool_start': {
          const tc: ChatToolCall = {
            name: String(event.data?.name || ''),
            args: (event.data?.args || {}) as Record<string, unknown>,
          };
          cur.streamingToolCall = tc;
          setStreamingToolCall(tc);

          const toolMsg = newMessage(projectId, 'tool', {
            id: makeTempId(tempIdRef.current),
            toolResult: { name: tc.name, args: tc.args, loading: true },
            status: 'streaming',
          });
          cur.messages = [...cur.messages, toolMsg];
          setMessages(cur.messages);
          break;
        }

        /* -------- tool_result -------- */
        case 'tool_result': {
          const result = (event.data?.result || {}) as Record<string, unknown>;
          cur.streamingToolCall = null;
          setStreamingToolCall(null);

          const msgs = [...cur.messages];
          for (let i = msgs.length - 1; i >= 0; i -= 1) {
            if (msgs[i].role === 'tool' && msgs[i].status === 'streaming') {
              const existing = (msgs[i].toolResult || {}) as Record<string, unknown>;
              msgs[i] = { ...msgs[i], toolResult: { ...existing, result, loading: false }, status: 'done' };
              break;
            }
          }
          cur.messages = msgs;
          setMessages(msgs);
          break;
        }

        /* -------- thinking_*（需求 #28）-------- */
        case 'thinking_start':
          cur.isThinking = true;
          cur.thinkingContent = '';
          cur.streamPhase = 'thinking';
          setIsThinking(true);
          setThinkingContent('');
          setStreamPhase('thinking');
          break;

        case 'thinking_delta':
          cur.thinkingContent += String(event.data?.content || '');
          setThinkingContent(cur.thinkingContent);
          break;

        case 'thinking_end':
          cur.isThinking = false;
          cur.streamPhase = 'replying';
          setIsThinking(false);
          setStreamPhase('replying');
          break;

        /* -------- error -------- */
        case 'error': {
          const errMsg = newMessage(projectId, 'system', {
            id: makeTempId(tempIdRef.current),
            content: String(event.data?.message || '发生未知错误'),
            status: 'error',
          });
          cur.messages = [...cur.messages, errMsg];
          setMessages(cur.messages);
          break;
        }

        /* -------- status（仅日志，不落消息） -------- */
        case 'status':
        default:
          break;
      }
    });

    const unsubDone = window.autoplan.onChatDone((event) => {
      const cur = s.current;
      const doneConversationId = normalizeDoneConversationId(event.conversationId);
      const cid = cur.activeConversationId;
      if (event.status === 'done') {
        syncDoneConversationTitle(doneConversationId ?? cid, event.title);
      }

      if (doneConversationId !== null && doneConversationId !== cid) {
        return;
      }

      const hadActiveStream =
        cur.awaitingResponse ||
        cur.isStreaming ||
        cur.streamPhase !== 'idle' ||
        cur.messages.some((message) => message.status === 'streaming');
      resetTransientState();
      if (!cid || !hadActiveStream) return;

      // 固化流式 assistant 消息的状态
      const msgs = [...cur.messages];
      const finalStatus: ChatMessage['status'] =
        event.status === 'done' ? 'done' : event.status === 'aborted' ? 'aborted' : 'error';
      for (let i = msgs.length - 1; i >= 0; i -= 1) {
        if (msgs[i].role === 'assistant' && msgs[i].status === 'streaming') {
          msgs[i] = { ...msgs[i], status: finalStatus };
          break;
        }
        if (msgs[i].role === 'tool' && msgs[i].status === 'streaming') {
          msgs[i] = { ...msgs[i], status: 'done' };
        }
      }
      cur.messages = msgs;
      setMessages(msgs);

      // 重新加载历史以获取服务端真实 ID
      const historyProjectId = cur.projectId;
      window.autoplan
        .chatHistory({ projectId: historyProjectId, conversationId: cid })
        .then((history) => {
          if (stateRef.current.activeConversationId !== cid || stateRef.current.projectId !== historyProjectId) return;
          cur.messages = history;
          setMessages(history);
        })
        .catch(() => {
          /* 刷新失败保留本地消息 */
        });
    });

    return () => {
      unsubChunk();
      unsubDone();
    };
  }, [projectId, resetTransientState, syncDoneConversationTitle]);

  /* ---- 组件卸载时停止未完成的生成 ---- */

  useEffect(() => {
    return () => {
      if (
        (stateRef.current.isStreaming ||
          stateRef.current.awaitingResponse ||
          stateRef.current.streamPhase !== 'idle') &&
        stateRef.current.activeConversationId
      ) {
        window.autoplan
          .chatStop({
            projectId: stateRef.current.projectId,
            conversationId: stateRef.current.activeConversationId,
          })
          .catch(() => {});
      }
    };
  }, []);

  /* ---- 操作 ---- */

  const sendMessage = useCallback(
    async (message: string) => {
      const text = String(message || '').trim();
      const cid = stateRef.current.activeConversationId;
      // 移除流式中发送守卫：回复中也可继续输入并入队（需求 #37）
      if (!text || !cid || !projectId) return;

      // 乐观以排队态追加用户消息（onChatDone 后 reload history 以服务端真实 id 协调，避免重复/错位）
      const userMsg = newMessage(projectId, 'user', {
        id: makeTempId(tempIdRef.current),
        content: text,
        status: 'queued',
      });
      const next = [...stateRef.current.messages, userMsg];
      stateRef.current.messages = next;
      setMessages(next);

      // 首次发送（非流式中）乐观进入流式态；流式中再发送仅入队，不重置流式态
      if (!stateRef.current.isStreaming) {
        stateRef.current.isStreaming = true;
        stateRef.current.awaitingResponse = true;
        setIsStreaming(true);
      }

      try {
        await window.autoplan.chatSend({
          projectId,
          conversationId: cid,
          message: text,
        });
      } catch {
        resetTransientState();
        /* 错误经 onChatDone 推送处理 */
      }
    },
    [projectId, resetTransientState],
  );

  const stopGeneration = useCallback(async () => {
    const cid = stateRef.current.activeConversationId;
    const pid = stateRef.current.projectId || projectId;
    if (!cid || !pid) return;
    try {
      await window.autoplan.chatStop({ projectId: pid, conversationId: cid });
    } catch {
      /* 中止失败忽略 */
    }
  }, [projectId]);

  const clearSession = useCallback(async () => {
    const cid = stateRef.current.activeConversationId;
    const pid = stateRef.current.projectId || projectId;
    if (!cid || !pid) return;
    try {
      await window.autoplan.chatClear({ projectId: pid, conversationId: cid });
    } catch {
      /* 清空失败忽略 */
    }
    resetMessages();
    resetTransientState();
  }, [projectId, resetMessages, resetTransientState]);

  /** 切换到指定对话 */
  const switchConversation = useCallback(
    async (cid: number) => {
      if (cid === stateRef.current.activeConversationId) return;

      // 中止当前对话的流式生成
      if (
        (stateRef.current.isStreaming ||
          stateRef.current.awaitingResponse ||
          stateRef.current.streamPhase !== 'idle') &&
        stateRef.current.activeConversationId
      ) {
        try {
          await window.autoplan.chatStop({
            projectId,
            conversationId: stateRef.current.activeConversationId,
          });
        } catch {
          /* 忽略 */
        }
      }

      resetActiveConversation(cid);
    },
    [projectId, resetActiveConversation],
  );

  /** 创建新对话 */
  const createConversation = useCallback(async (options: CreateConversationOptions = {}) => {
    if (!projectId) return;
    try {
      const cfgs = await window.autoplan.aiConfigList().catch(() => aiConfigs);
      const selectedConfig = cfgs.find((c) => c.hasApiKey);
      const conv = await window.autoplan.conversationCreate({
        projectId,
        aiConfigId: selectedConfig?.id ?? null,
      });
      if (projectIdRef.current !== projectId) return;
      setAiConfigs(cfgs);
      setConversations((prev) => [conv, ...prev]);
      if (options.activate !== false) {
        resetActiveConversation(conv.id);
      }
    } catch {
      /* 创建失败忽略 */
    }
  }, [aiConfigs, projectId, resetActiveConversation]);

  /** 删除对话 */
  const deleteConversation = useCallback(
    async (cid: number) => {
      try {
        if (
          stateRef.current.activeConversationId === cid &&
          (stateRef.current.isStreaming ||
            stateRef.current.awaitingResponse ||
            stateRef.current.streamPhase !== 'idle')
        ) {
          await window.autoplan.chatStop({ projectId, conversationId: cid }).catch(() => {});
        }
        await window.autoplan.conversationDelete({ projectId, conversationId: cid });
        await loadConversations();
      } catch {
        /* 删除失败忽略 */
      }
    },
    [loadConversations, projectId],
  );

  /** 重命名对话 */
  const renameConversation = useCallback(
    async (cid: number, title: string) => {
      try {
        await window.autoplan.conversationUpdate({ projectId, conversationId: cid, title });
        if (projectIdRef.current !== projectId) return;
        setConversations((prev) =>
          prev.map((c) => (c.id === cid ? { ...c, title } : c)),
        );
      } catch {
        /* 重命名失败忽略 */
      }
    },
    [projectId],
  );

  /** 切换当前对话绑定的 AI 配置 */
  const updateConversationAiConfig = useCallback(async (configId: number | null) => {
    const cid = stateRef.current.activeConversationId;
    if (!cid || !projectId) return;
    const updated = await window.autoplan.conversationUpdate({
      projectId,
      conversationId: cid,
      aiConfigId: configId,
    });
    if (stateRef.current.activeConversationId !== cid || projectIdRef.current !== projectId) return;
    setConversations((prev) =>
      prev.map((conversation) => (conversation.id === cid ? updated : conversation)),
    );
  }, [projectId]);

  /** 更新当前会话所绑定 AI 配置的思考深度 */
  const updateActiveAiConfigThinkingDepth = useCallback(
    async (thinkingDepth: ChatThinkingDepth) => {
      const targetConfig = resolveCurrentAiConfig(
        aiConfigs,
        conversations,
        stateRef.current.activeConversationId,
      );
      if (!targetConfig) return;
      const updated = await window.autoplan.aiConfigUpdate({
        configId: targetConfig.id,
        thinkingDepth,
      });
      setAiConfigs((prev) =>
        prev.map((item) => (item.id === updated.id ? updated : item)),
      );
    },
    [aiConfigs, conversations],
  );

  // 队列发送（需求 #37）：组合队列状态 hook（会话隔离快照 + 管理动作）
  const queue = useChatQueue(projectId, activeConversationId);

  const chatState: WorkspaceChatState & WorkspaceChatComposerActions = {
    messages,
    isStreaming,
    streamingContent,
    streamingToolCall,
    config,
    sendMessage,
    stopGeneration,
    clearSession,
    loadHistory,
    // 多对话扩展（需求 #28）
    conversations,
    aiConfigs,
    activeConversationId,
    switchConversation,
    createConversation,
    deleteConversation,
    renameConversation,
    getAiConfigName: (configId: number | null) => getAiConfigName(aiConfigs, configId),
    formatRelativeTime,
    // 思考状态（需求 #28）
    isThinking,
    thinkingContent,
    streamPhase,
    // 队列发送（需求 #37）
    queue: queue.items,
    queueCount: queue.count,
    cancelQueueItem: queue.cancelQueueItem,
    editQueueItem: queue.editQueueItem,
    clearQueue: queue.clearQueue,
    updateConversationAiConfig,
    updateActiveAiConfigThinkingDepth,
  };

  return chatState;
}
