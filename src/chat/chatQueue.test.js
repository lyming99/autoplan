'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createChatQueue } = require('./chatQueue');

/* ------------------------------------------------------------------ 内存 db stub ------------------------------------------------------------------ */
/* 复用 chatController.test.js 的 stub 风格，支持 chat_messages 的 INSERT(insert)/UPDATE/DELETE/SELECT status='queued'。 */

function createQueueDb(existingRows = []) {
  let nextId = 100;
  const store = { chat_messages: existingRows.map((r) => ({ ...r })) };
  const db = {
    insert(sql, params) {
      db._calls.insert += 1;
      const [pid, cid, role, content, tool_calls, tool_result, status, created_at] = params;
      const row = {
        id: nextId++, project_id: pid, conversation_id: cid, role, content,
        tool_calls, tool_result, status, created_at,
      };
      store.chat_messages.push(row);
      return row.id;
    },
    run(sql, params = []) {
      db._calls.run += 1;
      if (sql.includes('UPDATE chat_messages SET status')) {
        const [status, id] = params;
        const row = store.chat_messages.find((r) => r.id === id);
        if (row) row.status = status;
      } else if (sql.includes('UPDATE chat_messages SET content')) {
        const [content, id] = params;
        const row = store.chat_messages.find((r) => r.id === id);
        if (row) row.content = content;
      } else if (sql.includes('DELETE FROM chat_messages') && sql.includes('WHERE id = ?')) {
        const [id] = params;
        store.chat_messages = store.chat_messages.filter((r) => !(r.id === id && r.status === 'queued'));
      } else if (sql.includes('DELETE FROM chat_messages')) {
        const [cid, pid] = params;
        store.chat_messages = store.chat_messages.filter(
          (r) => !(r.conversation_id === cid && r.project_id === pid && r.status === 'queued'),
        );
      }
    },
    all(sql, params = []) {
      db._calls.all += 1;
      const [cid, pid] = params;
      return store.chat_messages
        .filter((r) => r.conversation_id === cid && r.project_id === pid && r.status === 'queued')
        .sort((a, b) => a.id - b.id)
        .map((r) => ({ id: r.id, content: r.content }));
    },
    _calls: { insert: 0, run: 0, all: 0 },
    _store: store,
  };
  return db;
}

const DONE_ROW = (id, content) => ({
  id, project_id: 1, conversation_id: 1, role: 'user', content, status: 'done', created_at: 't',
});
const QUEUED_ROW = (id, content) => ({
  id, project_id: 1, conversation_id: 1, role: 'user', content, status: 'queued', created_at: 't',
});

/* ------------------------------------------------------------------ 测试 ------------------------------------------------------------------ */

describe('chatQueue 队列核心（需求 #37）', () => {
  it('enqueue 保持 FIFO 顺序；空串返回 null 不入库', () => {
    const db = createQueueDb();
    const snaps = [];
    const q = createChatQueue({ db, conversationId: 1, projectId: 1, emit: (s) => snaps.push(s) });

    assert.equal(q.enqueue('   '), null, '空串返回 null');
    assert.equal(db._store.chat_messages.length, 0, '空串不入库');

    const a = q.enqueue('A');
    q.enqueue('B');
    q.enqueue('C');
    assert.equal(a.state, 'queued');
    assert.deepEqual(q.getQueue().map((i) => i.content), ['A', 'B', 'C'], '按入队顺序 FIFO');
    assert.equal(db._store.chat_messages.filter((r) => r.status === 'queued').length, 3);
    assert.ok(snaps.length >= 3, '每次入队广播快照');
  });

  it('markProcessing 将 queued 行翻为 done；peekNext 不消费首项', () => {
    const db = createQueueDb();
    const q = createChatQueue({ db, conversationId: 1, projectId: 1 });
    q.enqueue('A');
    q.enqueue('B');

    assert.equal(q.peekNext().content, 'A', 'peekNext 返回队首');
    assert.equal(q.peekNext().content, 'A', 'peekNext 不消费');

    const head = q.peekNext();
    assert.equal(q.markProcessing(head.id), true);
    assert.equal(db._store.chat_messages.find((r) => r.id === head.id).status, 'done', '库内行翻为 done');
    assert.equal(q.getQueue()[0].state, 'processing', '内存置 processing');
    assert.equal(q.peekNext().content, 'B', 'peekNext 跳过 processing 取下一个 queued');
    assert.equal(q.markProcessing(99999), false, '不存在 id 返回 false');
  });

  it('cancelItem 仅作用于 queued 项，不影响 processing 与历史', () => {
    const db = createQueueDb([DONE_ROW(1, 'old')]);
    const q = createChatQueue({ db, conversationId: 1, projectId: 1 });
    const a = q.enqueue('A');
    q.markProcessing(a.id);

    assert.equal(q.cancelItem(a.id), false, 'processing 项不可取消');
    const b = q.enqueue('B');
    assert.equal(q.cancelItem(b.id), true, 'queued 项可取消');
    assert.equal(db._store.chat_messages.find((r) => r.id === b.id), undefined, 'queued 行被物理删除');
    assert.equal(q.getQueue().length, 1, '仅剩 processing A');
    assert.ok(db._store.chat_messages.some((r) => r.id === 1), '历史 done 行不受影响');
  });

  it('editItem 仅更新 queued 项内容（FIFO 与库内行同步）', () => {
    const db = createQueueDb();
    const q = createChatQueue({ db, conversationId: 1, projectId: 1 });
    const a = q.enqueue('A');
    q.markProcessing(a.id);

    assert.equal(q.editItem(a.id, 'A2'), false, 'processing 项不可编辑');
    assert.equal(q.editItem(a.id, ''), false, '空串不可编辑');
    const b = q.enqueue('B');
    assert.equal(q.editItem(b.id, 'B-edited'), true);
    assert.equal(q.getQueue().find((i) => i.id === b.id).content, 'B-edited', 'FIFO 内容更新');
    assert.equal(db._store.chat_messages.find((r) => r.id === b.id).content, 'B-edited', '库内行内容更新');
  });

  it('clear 移除全部 queued 项，不影响 processing 与历史', () => {
    const db = createQueueDb([DONE_ROW(1, 'old')]);
    const q = createChatQueue({ db, conversationId: 1, projectId: 1 });
    const a = q.enqueue('A');
    q.markProcessing(a.id);
    q.enqueue('B');
    q.enqueue('C');

    assert.equal(q.clear(), true);
    assert.deepEqual(q.getQueue().map((i) => i.state), ['processing'], '仅剩 processing A');
    assert.equal(db._store.chat_messages.filter((r) => r.status === 'queued').length, 0, 'queued 行全删');
    assert.ok(db._store.chat_messages.some((r) => r.id === 1), '历史 done 行保留');
  });

  it('loadPersisted 从 status=queued 行按 id ASC 重建 FIFO（排除 done）', () => {
    const db = createQueueDb([
      QUEUED_ROW(5, 'five'),
      QUEUED_ROW(2, 'two'),
      DONE_ROW(9, 'nine'),
    ]);
    const q = createChatQueue({ db, conversationId: 1, projectId: 1 });
    const snap = q.loadPersisted();
    assert.deepEqual(snap.map((i) => i.id), [2, 5], '按 id ASC 重建，排除 done');
    assert.equal(q.hasQueued(), true);
    assert.equal(q.peekNext().id, 2, '队首为最小 id');
  });

  it('getQueue / hasQueued 快照与计数正确；releaseProcessing 出队处理中项', () => {
    const db = createQueueDb();
    const q = createChatQueue({ db, conversationId: 1, projectId: 1 });
    assert.equal(q.hasQueued(), false);
    assert.equal(q.getQueue().length, 0);

    q.enqueue('A');
    q.enqueue('B');
    assert.equal(q.hasQueued(), true);
    assert.equal(q.getQueue().length, 2);

    q.markProcessing(q.peekNext().id);
    assert.equal(q.hasQueued(), true, '仍有 queued B');
    assert.equal(q.getQueue().length, 2, 'processing 项仍在快照');

    q.releaseProcessing();
    assert.equal(q.getQueue().length, 1, 'releaseProcessing 出队处理中项');
    assert.equal(q.hasQueued(), true);
  });
});
