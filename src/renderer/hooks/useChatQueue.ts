import { useCallback, useEffect, useState } from 'react';
import type { ChatQueueItem } from '../types';

export interface UseChatQueueResult {
  items: ChatQueueItem[];
  count: number;
  cancelQueueItem: (id: number) => Promise<void>;
  editQueueItem: (id: number, text: string) => Promise<void>;
  clearQueue: () => Promise<void>;
}

/**
 * 对话队列状态 hook（需求 #37）：维护当前会话的排队消息快照与管理动作。
 * - mount/会话切换时经 chatQueueList 拉取初始快照；订阅 onChatQueue 增量更新
 * - 按 conversationId 隔离事件（与 onChatChunk 同模式），仅更新当前活跃会话
 * - 暴露取消/编辑/清空动作：乐观更新本地快照 + IPC 落盘，onChatQueue 广播保证最终一致
 */
export function useChatQueue(projectId: number, activeConversationId: number | null): UseChatQueueResult {
  const [items, setItems] = useState<ChatQueueItem[]>([]);

  useEffect(() => {
    if (!projectId || !activeConversationId) {
      setItems([]);
      return;
    }
    const cid = activeConversationId;
    let cancelled = false;
    window.autoplan
      .chatQueueList({ projectId, conversationId: cid })
      .then((list) => {
        if (!cancelled) setItems(Array.isArray(list) ? list : []);
      })
      .catch(() => {
        /* 拉取失败保留空快照 */
      });
    const unsubscribe = window.autoplan.onChatQueue((snapshot) => {
      if (snapshot.conversationId !== cid) return; // 会话隔离
      setItems(Array.isArray(snapshot.items) ? snapshot.items : []);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [projectId, activeConversationId]);

  const cancelQueueItem = useCallback(
    async (id: number) => {
      if (!projectId || !activeConversationId) return;
      setItems((cur) => cur.filter((it) => it.id !== id));
      try {
        await window.autoplan.chatQueueCancel({ projectId, conversationId: activeConversationId, id });
      } catch {
        /* 失败经 onChatQueue 广播修正 */
      }
    },
    [projectId, activeConversationId],
  );

  const editQueueItem = useCallback(
    async (id: number, text: string) => {
      const content = String(text || '').trim();
      if (!projectId || !activeConversationId || !content) return;
      setItems((cur) => cur.map((it) => (it.id === id ? { ...it, content } : it)));
      try {
        await window.autoplan.chatQueueEdit({ projectId, conversationId: activeConversationId, id, message: content });
      } catch {
        /* 失败经 onChatQueue 广播修正 */
      }
    },
    [projectId, activeConversationId],
  );

  const clearQueue = useCallback(
    async () => {
      if (!projectId || !activeConversationId) return;
      setItems([]);
      try {
        await window.autoplan.chatQueueClear({ projectId, conversationId: activeConversationId });
      } catch {
        /* 失败经 onChatQueue 广播修正 */
      }
    },
    [projectId, activeConversationId],
  );

  return { items, count: items.length, cancelQueueItem, editQueueItem, clearQueue };
}
