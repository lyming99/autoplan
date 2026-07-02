import { useCallback, useEffect, useRef, useState } from 'react';
import type { AiConfig, ChatConfig, ChatMessage, ChatToolCall, Conversation } from '../types';

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
  if (configId == null) return '默认配置';
  const found = configs.find((c) => c.id === configId);
  return found ? found.name : `配置 #${configId}`;
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
 * - mount 时加载 LLM 配置与对话列表
 * - projectId / activeConversationId 变更时重新加载历史消息
 * - 订阅 onChatChunk / onChatDone 事件，实时拼装消息
 * - 切换对话时正确清理上一个对话的流式状态
 */
export function useChat(projectId: number) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingContent, setStreamingContent] = useState('');
  const [streamingToolCall, setStreamingToolCall] = useState<ChatToolCall | null>(null);
  const [config, setConfig] = useState<ChatConfig | null>(null);

  // 多对话状态（需求 #28）
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [aiConfigs, setAiConfigs] = useState<AiConfig[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<number | null>(null);

  // 思考状态（需求 #28）
  const [isThinking, setIsThinking] = useState(false);
  const [thinkingContent, setThinkingContent] = useState('');
  const [streamPhase, setStreamPhase] = useState<'idle' | 'thinking' | 'replying'>('idle');

  // Refs 避免事件回调中的闭包过期问题
  const tempIdRef = useRef({ value: 0 });
  const stateRef = useRef({
    isStreaming: false,
    streamingContent: '',
    streamingToolCall: null as ChatToolCall | null,
    messages: [] as ChatMessage[],
    activeConversationId: null as number | null,
    isThinking: false,
    thinkingContent: '',
    streamPhase: 'idle' as 'idle' | 'thinking' | 'replying',
  });

  /* ---- 初始化：加载配置 ---- */

  useEffect(() => {
    window.autoplan
      .chatGetConfig()
      .then((c) => setConfig(c))
      .catch(() => {
        /* 取配置失败保持 null */
      });
  }, []);

  /* ---- 加载对话列表与 AI 配置列表 ---- */

  const loadConversations = useCallback(async () => {
    if (!projectId) return;
    try {
      const [convs, cfgs] = await Promise.all([
        window.autoplan.conversationList({ projectId }),
        window.autoplan.aiConfigList({ projectId }).catch(() => [] as AiConfig[]),
      ]);
      setConversations(convs);
      setAiConfigs(cfgs);

      // 若尚未选中对话，自动选第一条
      if (convs.length > 0 && !stateRef.current.activeConversationId) {
        const firstId = convs[0].id;
        stateRef.current.activeConversationId = firstId;
        setActiveConversationId(firstId);
      } else if (convs.length === 0) {
        stateRef.current.activeConversationId = null;
        setActiveConversationId(null);
        setMessages([]);
        stateRef.current.messages = [];
      }
    } catch {
      /* 加载失败忽略 */
    }
  }, [projectId]);

  useEffect(() => {
    stateRef.current.activeConversationId = null;
    setActiveConversationId(null);
    setMessages([]);
    stateRef.current.messages = [];
    if (projectId) loadConversations();
  }, [projectId, loadConversations]);

  /* ---- activeConversationId 变更：重新加载历史 ---- */

  const loadHistory = useCallback(async (cid: number) => {
    try {
      const history = await window.autoplan.chatHistory({ conversationId: cid });
      setMessages(history);
      stateRef.current.messages = history;
    } catch {
      setMessages([]);
      stateRef.current.messages = [];
    }
  }, []);

  useEffect(() => {
    if (activeConversationId) loadHistory(activeConversationId);
    else {
      setMessages([]);
      stateRef.current.messages = [];
    }
  }, [activeConversationId, loadHistory]);

  /* ---- 订阅流式事件 ---- */

  useEffect(() => {
    const s = stateRef;

    const unsubChunk = window.autoplan.onChatChunk((event) => {
      const cur = s.current;

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

          if (!cur.isStreaming) {
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
            for (let i = msgs.length - 1; i >= 0; i -= 1) {
              if (msgs[i].role === 'assistant' && msgs[i].status === 'streaming') {
                msgs[i] = { ...msgs[i], content: cur.streamingContent };
                break;
              }
            }
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
      cur.isStreaming = false;
      cur.isThinking = false;
      cur.thinkingContent = '';
      cur.streamPhase = 'idle';
      setIsStreaming(false);
      setStreamingContent('');
      setStreamingToolCall(null);
      setIsThinking(false);
      setThinkingContent('');
      setStreamPhase('idle');

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
      const cid = cur.activeConversationId;
      if (cid) {
        window.autoplan
          .chatHistory({ conversationId: cid })
          .then((history) => {
            cur.messages = history;
            setMessages(history);
          })
          .catch(() => {
            /* 刷新失败保留本地消息 */
          });
      }
    });

    return () => {
      unsubChunk();
      unsubDone();
    };
  }, [projectId]);

  /* ---- 组件卸载时停止未完成的生成 ---- */

  useEffect(() => {
    return () => {
      if (stateRef.current.isStreaming && stateRef.current.activeConversationId) {
        window.autoplan
          .chatStop({ conversationId: stateRef.current.activeConversationId })
          .catch(() => {});
      }
    };
  }, []);

  /* ---- 操作 ---- */

  const sendMessage = useCallback(
    async (message: string) => {
      const text = String(message || '').trim();
      const cid = stateRef.current.activeConversationId;
      if (!text || stateRef.current.isStreaming || !cid || !projectId) return;

      const userMsg = newMessage(projectId, 'user', {
        id: makeTempId(tempIdRef.current),
        content: text,
      });
      const next = [...stateRef.current.messages, userMsg];
      stateRef.current.messages = next;
      setMessages(next);

      try {
        await window.autoplan.chatSend({
          projectId,
          conversationId: cid,
          message: text,
        });
      } catch {
        /* 错误经 onChatDone 推送处理 */
      }
    },
    [projectId],
  );

  const stopGeneration = useCallback(async () => {
    const cid = stateRef.current.activeConversationId;
    if (!cid) return;
    try {
      await window.autoplan.chatStop({ conversationId: cid });
    } catch {
      /* 中止失败忽略 */
    }
  }, []);

  const clearSession = useCallback(async () => {
    const cid = stateRef.current.activeConversationId;
    if (!cid) return;
    try {
      await window.autoplan.chatClear({ conversationId: cid });
    } catch {
      /* 清空失败忽略 */
    }
    stateRef.current.messages = [];
    stateRef.current.streamingContent = '';
    stateRef.current.streamingToolCall = null;
    stateRef.current.isStreaming = false;
    stateRef.current.isThinking = false;
    stateRef.current.thinkingContent = '';
    stateRef.current.streamPhase = 'idle';
    setMessages([]);
    setStreamingContent('');
    setStreamingToolCall(null);
    setIsStreaming(false);
    setIsThinking(false);
    setThinkingContent('');
    setStreamPhase('idle');
  }, []);

  /** 切换到指定对话 */
  const switchConversation = useCallback(
    async (cid: number) => {
      if (cid === stateRef.current.activeConversationId) return;

      // 中止当前对话的流式生成
      if (stateRef.current.isStreaming && stateRef.current.activeConversationId) {
        try {
          await window.autoplan.chatStop({
            conversationId: stateRef.current.activeConversationId,
          });
        } catch {
          /* 忽略 */
        }
      }

      // 重置状态
      stateRef.current.isStreaming = false;
      stateRef.current.streamingContent = '';
      stateRef.current.streamingToolCall = null;
      stateRef.current.messages = [];
      stateRef.current.isThinking = false;
      stateRef.current.thinkingContent = '';
      stateRef.current.streamPhase = 'idle';
      stateRef.current.activeConversationId = cid;
      setIsStreaming(false);
      setStreamingContent('');
      setStreamingToolCall(null);
      setMessages([]);
      setIsThinking(false);
      setThinkingContent('');
      setStreamPhase('idle');
      setActiveConversationId(cid);
    },
    [],
  );

  /** 创建新对话 */
  const createConversation = useCallback(async () => {
    if (!projectId) return;
    try {
      const conv = await window.autoplan.conversationCreate({ projectId });
      setConversations((prev) => [conv, ...prev]);
      setActiveConversationId(conv.id);
      stateRef.current.activeConversationId = conv.id;
    } catch {
      /* 创建失败忽略 */
    }
  }, [projectId]);

  /** 删除对话 */
  const deleteConversation = useCallback(
    async (cid: number) => {
      try {
        await window.autoplan.conversationDelete({ conversationId: cid });
        const list = await window.autoplan.conversationList({ projectId });
        setConversations(list);
        if (stateRef.current.activeConversationId === cid) {
          const nextId = list.length > 0 ? list[0].id : null;
          stateRef.current.activeConversationId = nextId;
          setActiveConversationId(nextId);
        }
      } catch {
        /* 删除失败忽略 */
      }
    },
    [projectId],
  );

  /** 重命名对话 */
  const renameConversation = useCallback(
    async (cid: number, title: string) => {
      try {
        await window.autoplan.conversationUpdate({ conversationId: cid, title });
        setConversations((prev) =>
          prev.map((c) => (c.id === cid ? { ...c, title } : c)),
        );
      } catch {
        /* 重命名失败忽略 */
      }
    },
    [],
  );

  return {
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
  };
}
