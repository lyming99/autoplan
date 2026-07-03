import { useState } from 'react';
import type { ChatQueueItem } from '../../types';

interface ChatQueueViewProps {
  queue?: ChatQueueItem[];
  cancelQueueItem?: (id: number) => Promise<void>;
  editQueueItem?: (id: number, text: string) => Promise<void>;
  clearQueue?: () => Promise<void>;
}

/**
 * 对话队列视图（需求 #37）：在消息列表末尾穿插渲染排队/处理中消息。
 * - queued 项：内容预览 + 「排队中」徽标，提供编辑/取消
 * - processing 项：「处理中」徽标，不可编辑/取消（仅展示当前正在生成的消息）
 * - 顶部「清空」按钮一键移除全部排队项（不影响处理中项）
 */
export function ChatQueueView({ queue, cancelQueueItem, editQueueItem, clearQueue }: ChatQueueViewProps) {
  if (!queue || queue.length === 0) return null;
  return (
    <div className="chat-queue-list" aria-label="消息队列">
      {clearQueue ? (
        <div className="chat-queue-list__head">
          <span className="chat-queue-list__title">队列（{queue.length}）</span>
          <button type="button" className="chat-queue-item__btn" onClick={() => { void clearQueue(); }}>清空</button>
        </div>
      ) : null}
      {queue.map((item) => (
        <ChatQueueItemRow
          key={item.id}
          item={item}
          cancelQueueItem={cancelQueueItem}
          editQueueItem={editQueueItem}
        />
      ))}
    </div>
  );
}

function ChatQueueItemRow({
  item,
  cancelQueueItem,
  editQueueItem,
}: {
  item: ChatQueueItem;
  cancelQueueItem?: (id: number) => Promise<void>;
  editQueueItem?: (id: number, text: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.content);
  const isProcessing = item.state === 'processing';

  const startEdit = () => {
    setDraft(item.content);
    setEditing(true);
  };
  const cancelEdit = () => {
    setDraft(item.content);
    setEditing(false);
  };
  const saveEdit = () => {
    const text = draft.trim();
    if (!text || !editQueueItem) return;
    void editQueueItem(item.id, text);
    setEditing(false);
  };

  return (
    <div className={`chat-queue-item chat-queue-item--${item.state}`}>
      <span className={`chat-queue-item__badge chat-queue-item__badge--${item.state}`}>
        {isProcessing ? '处理中' : '排队中'}
      </span>
      {editing && !isProcessing ? (
        <div className="chat-queue-item__edit">
          <textarea
            className="chat-queue-item__edit-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={2}
            autoFocus
          />
          <div className="chat-queue-item__edit-actions">
            <button type="button" className="btn btn-sm btn-primary" onClick={saveEdit}>保存</button>
            <button type="button" className="btn-link" onClick={cancelEdit}>取消</button>
          </div>
        </div>
      ) : (
        <div className="chat-queue-item__content">{item.content}</div>
      )}
      {!isProcessing && !editing ? (
        <div className="chat-queue-item__actions">
          {editQueueItem ? (
            <button type="button" className="chat-queue-item__btn" onClick={startEdit}>编辑</button>
          ) : null}
          {cancelQueueItem ? (
            <button
              type="button"
              className="chat-queue-item__btn"
              onClick={() => { void cancelQueueItem(item.id); }}
            >
              取消
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
