'use strict';

/**
 * 对话消息队列核心（需求 #37）：每会话 FIFO + 状态机 + 持久化 + 管理。
 *
 * 职责：
 * - 维护单会话待发送消息队列（内存 FIFO），与 chat_messages(status='queued') 双向同步
 * - 队列项状态机：queued（排队中/等待发送）→ processing（处理中）→ 出队
 * - enqueue 写 queued 行；markProcessing 翻为 done（进入 LLM 上下文）；cancel/clear 物理删除 queued 行
 * - loadPersisted 从库内 queued 行重建 FIFO（刷新/重启恢复）
 *
 * 纯函数式模块（依赖注入 db + conversationId + projectId + emit），无 React/Electron 依赖，
 * 可直接被 `node --test` 单测。
 *
 * @module chat/chatQueue
 */

const { nowIso } = require('../database');

/**
 * 创建一个会话级消息队列。
 *
 * @param {object} deps
 * @param {object} deps.db - AppDatabase（或兼容 stub）：需支持 insert/run/all
 * @param {number} deps.conversationId
 * @param {number} deps.projectId
 * @param {Function} [deps.emit] - 变更成功后广播快照：(snapshot: Array<{id,content,state}>) => void
 * @returns {{enqueue:Function, peekNext:Function, markProcessing:Function, releaseProcessing:Function, getQueue:Function, cancelItem:Function, editItem:Function, clear:Function, hasQueued:Function, loadPersisted:Function}}
 */
function createChatQueue({ db, conversationId, projectId, emit } = {}) {
  const cid = Number(conversationId);
  const pid = Number(projectId);
  const broadcast = typeof emit === 'function' ? emit : () => {};

  // 内存 FIFO：[{ id, content, state }]，state ∈ 'queued' | 'processing'
  let items = [];

  /** 当前快照（深拷贝，避免外部 mutate 内存结构）。 */
  function snapshot() {
    return items.map((item) => ({ id: item.id, content: item.content, state: item.state }));
  }

  function emitSnapshot() {
    broadcast(snapshot());
  }

  /**
   * 入队一条用户消息：trim 校验 → 写 chat_messages(status='queued') 行 → 记录到 FIFO。
   * @param {string} message
   * @returns {{id:number, content:string, state:'queued'}|null} 空串返回 null，不入库
   */
  function enqueue(message) {
    const content = String(message ?? '').trim();
    if (!content) return null;

    const createdAt = nowIso();
    const id = db.insert(
      `INSERT INTO chat_messages (project_id, conversation_id, role, content, tool_calls, tool_result, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [pid, cid, 'user', content, null, null, 'queued', createdAt],
    );

    const item = { id, content, state: 'queued' };
    items.push(item);
    emitSnapshot();
    return { id, content, state: 'queued' };
  }

  /**
   * 取队首首个 queued 项（不消费）。
   * @returns {{id:number, content:string, state:'queued'}|null}
   */
  function peekNext() {
    const item = items.find((it) => it.state === 'queued');
    if (!item) return null;
    return { id: item.id, content: item.content, state: 'queued' };
  }

  /**
   * 将指定项置为处理中：内存 state='processing'，库内行翻为 status='done'（进入 LLM 上下文）。
   * @param {number} id
   * @returns {boolean} 是否成功翻转（非 queued 项或不存在返回 false）
   */
  function markProcessing(id) {
    const item = items.find((it) => it.id === id && it.state === 'queued');
    if (!item) return false;
    item.state = 'processing';
    db.run('UPDATE chat_messages SET status = ? WHERE id = ?', ['done', id]);
    emitSnapshot();
    return true;
  }

  /**
   * 释放（出队）当前处理中项：上一条生成结束后由控制器调用，避免 processing 项长期滞留快照。
   * 不触碰库内行——已被 markProcessing 翻为 done，作为正常用户消息保留在历史中。
   * @returns {boolean} 是否移除了处理中项
   */
  function releaseProcessing() {
    const before = items.length;
    items = items.filter((it) => it.state !== 'processing');
    const changed = items.length !== before;
    if (changed) emitSnapshot();
    return changed;
  }

  /**
   * 快照（仅 queued + processing，按入队顺序）。
   * @returns {Array<{id:number, content:string, state:string}>}
   */
  function getQueue() {
    return snapshot();
  }

  /**
   * 是否存在排队中（queued）项。
   * @returns {boolean}
   */
  function hasQueued() {
    return items.some((it) => it.state === 'queued');
  }

  /**
   * 取消一条排队项：仅对 queued 生效——移出 FIFO 并物理删除库内 queued 行。
   * processing 项或不存在返回 false，不误删。
   * @param {number} id
   * @returns {boolean}
   */
  function cancelItem(id) {
    const idx = items.findIndex((it) => it.id === id && it.state === 'queued');
    if (idx === -1) return false;
    items.splice(idx, 1);
    db.run(`DELETE FROM chat_messages WHERE id = ? AND status = 'queued'`, [id]);
    emitSnapshot();
    return true;
  }

  /**
   * 编辑一条排队项内容：仅对 queued 生效——更新 FIFO 与库内行。
   * @param {number} id
   * @param {string} text
   * @returns {boolean}
   */
  function editItem(id, text) {
    const content = String(text ?? '').trim();
    if (!content) return false;
    const item = items.find((it) => it.id === id && it.state === 'queued');
    if (!item) return false;
    item.content = content;
    db.run(`UPDATE chat_messages SET content = ? WHERE id = ? AND status = 'queued'`, [content, id]);
    emitSnapshot();
    return true;
  }

  /**
   * 清空全部排队项（物理删除库内 queued 行）；不影响 processing 项与历史。
   * @returns {boolean} 是否清理了排队项
   */
  function clear() {
    const before = items.length;
    items = items.filter((it) => it.state !== 'queued');
    const changed = items.length !== before;
    if (changed) {
      db.run(
        `DELETE FROM chat_messages WHERE conversation_id = ? AND project_id = ? AND status = 'queued'`,
        [cid, pid],
      );
      emitSnapshot();
    }
    return changed;
  }

  /**
   * 从库内 status='queued' 行重建 FIFO（刷新/重启恢复）。
   * 保留内存中尚未回滚的处理中项（in-flight 生成，其库内行已为 done）。
   * @returns {Array<{id:number, content:string, state:string}>} 重建后的快照
   */
  function loadPersisted() {
    const rows = db.all(
      `SELECT id, content FROM chat_messages
       WHERE conversation_id = ? AND project_id = ? AND status = 'queued'
       ORDER BY id ASC`,
      [cid, pid],
    );
    const loadedIds = new Set(rows.map((r) => r.id));
    const preserved = items.filter((it) => it.state === 'processing' && !loadedIds.has(it.id));
    const loaded = rows.map((r) => ({ id: r.id, content: r.content, state: 'queued' }));
    items = [...preserved, ...loaded].sort((a, b) => a.id - b.id);
    emitSnapshot();
    return snapshot();
  }

  return {
    enqueue,
    peekNext,
    markProcessing,
    releaseProcessing,
    getQueue,
    cancelItem,
    editItem,
    clear,
    hasQueued,
    loadPersisted,
  };
}

module.exports = { createChatQueue };
