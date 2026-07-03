'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const initSqlJs = require('sql.js');
const { AppDatabase } = require('../database');
const {
  createChatController: createRealChatController,
  createConversation,
  deleteConversation,
  ensureDefaultConversation,
  listConversations,
  updateConversation,
} = require('./chatController');

function createChatController(options = {}) {
  return createRealChatController({
    ...options,
    conversationId: options.conversationId ?? options.projectId ?? 1,
  });
}

/* ------------------------------------------------------------------ 测试辅助 ------------------------------------------------------------------ */

/** 默认 chat 配置 */
function chatSettings(overrides = {}) {
  const defaults = {
    'chat.provider': 'openai',
    'chat.baseUrl': 'https://api.openai.com/v1',
    'chat.apiKey': 'sk-test',
    'chat.model': 'gpt-4o',
    'chat.temperature': '0.3',
  };
  return { ...defaults, ...overrides };
}

function aiConfigFromSettings(settings, overrides = {}) {
  return {
    id: overrides.id ?? 1,
    project_id: Object.prototype.hasOwnProperty.call(overrides, 'project_id') ? overrides.project_id : null,
    name: overrides.name ?? '默认配置',
    provider: overrides.provider ?? settings['chat.provider'] ?? 'openai',
    base_url: overrides.base_url ?? settings['chat.baseUrl'] ?? 'https://api.openai.com',
    api_key: overrides.api_key ?? settings['chat.apiKey'] ?? '',
    model: overrides.model ?? settings['chat.model'] ?? 'gpt-4o',
    temperature: overrides.temperature ?? settings['chat.temperature'] ?? '0.3',
    thinking_depth: overrides.thinking_depth ?? null,
    thinking_budget_tokens: overrides.thinking_budget_tokens ?? null,
  };
}

/** 内存 DB 替身：完整模拟 chatController 所需的 SQL 操作 */
function createMemoryDb(settings = chatSettings(), options = {}) {
  const store = {
    chat_messages: [],
    settings: new Map(Object.entries(settings)),
    conversations: options.conversations || [
      { id: 1, project_id: 1, title: 'Project 1', ai_config_id: null },
      { id: 2, project_id: 2, title: 'Project 2', ai_config_id: null },
    ],
    ai_configs: options.aiConfigs || [
      aiConfigFromSettings(settings, { id: 1, name: 'Global default' }),
    ],
  };
  let nextId = 1;

  const db = {
    all(sql, params = []) {
      db._calls.all += 1;
      if (sql.includes('chat_messages')) {
        let rows = [...store.chat_messages];
        if (sql.includes('conversation_id = ?')) {
          const cid = params[0];
          rows = rows.filter((r) => r.conversation_id === cid);
          if (sql.includes('project_id = ?')) {
            const pid = params[1];
            rows = rows.filter((r) => r.project_id === pid);
          }
        } else if (sql.includes('project_id = ?')) {
          const pid = params[0];
          rows = rows.filter((r) => r.project_id === pid);
        }
        rows.sort((a, b) => {
          const ca = a.created_at || '';
          const cb = b.created_at || '';
          if (ca < cb) return -1;
          if (ca > cb) return 1;
          return a.id - b.id;
        });
        return rows;
      }
      return [];
    },

    get(sql, params = []) {
      db._calls.get += 1;
      if (sql.includes('conversations') && sql.includes('WHERE id = ? AND project_id = ?')) {
        const [id, projectId] = params;
        return store.conversations.find((r) => r.id === id && r.project_id === projectId) || null;
      }
      if (sql.includes('conversations') && sql.includes('project_id = ?') && sql.includes('ORDER BY id ASC LIMIT 1')) {
        const projectId = params[0];
        return store.conversations
          .filter((r) => r.project_id === projectId)
          .sort((a, b) => a.id - b.id)[0] || null;
      }
      if (sql.includes('conversations') && sql.includes('WHERE id = ?')) {
        const id = params[0];
        return store.conversations.find((r) => r.id === id) || null;
      }
      if (sql.includes('ai_configs')) {
        if (sql.includes('WHERE id = ? AND project_id IS NULL')) {
          const id = params[0];
          return store.ai_configs.find((r) => r.id === id && r.project_id === null) || null;
        }
        if (sql.includes('WHERE id = ? AND project_id = ?')) {
          const [id, projectId] = params;
          return store.ai_configs.find((r) => r.id === id && r.project_id === projectId) || null;
        }
        if (sql.includes('WHERE id = ?')) {
          const id = params[0];
          return store.ai_configs.find((r) => r.id === id) || null;
        }
        if (sql.includes('project_id IS NULL')) {
          return store.ai_configs
            .filter((r) => r.project_id === null)
            .sort((a, b) => a.id - b.id)[0] || null;
        }
        if (sql.includes('project_id = ?')) {
          const projectId = params[0];
          return store.ai_configs
            .filter((r) => r.project_id === projectId)
            .sort((a, b) => a.id - b.id)[0] || null;
        }
      }
      if (sql.includes('chat_messages') && sql.includes('ORDER BY id DESC LIMIT 1')) {
        const [cid, projectId] = params;
        const rows = store.chat_messages
          .filter((r) => (
            r.conversation_id === cid &&
            (!sql.includes('project_id = ?') || r.project_id === projectId) &&
            r.role === 'assistant' &&
            r.status === 'done'
          ))
          .sort((a, b) => b.id - a.id);
        return rows[0] || null;
      }
      if (sql.includes('chat_messages') && sql.includes("role = 'user'") && sql.includes('ORDER BY id ASC LIMIT 1')) {
        const [cid, projectId] = params;
        const rows = store.chat_messages
          .filter((r) => (
            r.conversation_id === cid &&
            (!sql.includes('project_id = ?') || r.project_id === projectId) &&
            r.role === 'user'
          ))
          .sort((a, b) => a.id - b.id);
        return rows[0] || null;
      }
      return null;
    },

    run(sql, params = []) {
      db._calls.run += 1;
      db._runs.push({ sql, params });

      if (sql.includes('INSERT INTO chat_messages')) {
        const [pid, cid, role, content, tool_calls, tool_result, status, created_at] = params;
        const row = {
          id: nextId++,
          project_id: pid,
          conversation_id: cid,
          role,
          content,
          tool_calls,
          tool_result,
          status,
          created_at,
        };
        store.chat_messages.push(row);
      } else if (sql.includes('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ? AND project_id = ?')) {
        const [title, updatedAt, id, projectId] = params;
        const row = store.conversations.find((item) => item.id === id && item.project_id === projectId);
        if (row) {
          row.title = title;
          row.updated_at = updatedAt;
        }
      } else if (sql.includes('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?')) {
        const [title, updatedAt, id] = params;
        const row = store.conversations.find((item) => item.id === id);
        if (row) {
          row.title = title;
          row.updated_at = updatedAt;
        }
      } else if (sql.includes('UPDATE conversations SET updated_at = ? WHERE id = ? AND project_id = ?')) {
        const [updatedAt, id, projectId] = params;
        const row = store.conversations.find((item) => item.id === id && item.project_id === projectId);
        if (row) row.updated_at = updatedAt;
      } else if (sql.includes('UPDATE conversations SET updated_at = ? WHERE id = ?')) {
        const [updatedAt, id] = params;
        const row = store.conversations.find((item) => item.id === id);
        if (row) row.updated_at = updatedAt;
      } else if (sql.includes('DELETE FROM chat_messages') && sql.includes('project_id = ?')) {
        const [cid, projectId] = params;
        store.chat_messages = store.chat_messages.filter((r) => r.conversation_id !== cid || r.project_id !== projectId);
      } else if (sql.includes('DELETE FROM chat_messages')) {
        const cid = params[0];
        store.chat_messages = store.chat_messages.filter((r) => r.conversation_id !== cid);
      } else if (sql.includes('UPDATE chat_messages SET status')) {
        const [status, id] = params;
        const msg = store.chat_messages.find((r) => r.id === id);
        if (msg) msg.status = status;
      }
    },

    getSettings(prefix = '') {
      db._calls.getSettings += 1;
      const result = {};
      for (const [k, v] of store.settings) {
        if (!prefix || k.startsWith(prefix)) result[k] = v;
      }
      return result;
    },

    // 队列入队（需求 #37）：复用 run 的 INSERT 逻辑并回传新行 id
    insert(sql, params = []) {
      db._calls.insert += 1;
      db.run(sql, params);
      const last = store.chat_messages[store.chat_messages.length - 1];
      return last ? last.id : null;
    },
    _calls: { all: 0, get: 0, run: 0, getSettings: 0, insert: 0 },
    _runs: [],
    _store: store,
  };
  return db;
}

function createConversationCrudDb(options = {}) {
  const store = {
    conversations: (options.conversations || []).map((row) => ({ ...row })),
    chat_messages: (options.chatMessages || []).map((row) => ({ ...row })),
    ai_configs: options.aiConfigs || [
      aiConfigFromSettings(chatSettings(), { id: 1, name: 'Default 1' }),
      aiConfigFromSettings(chatSettings(), { id: 2, name: 'Default 2' }),
    ],
  };
  let nextId = store.conversations.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1;

  const db = {
    all(sql, params = []) {
      db._calls.all += 1;
      db._alls.push({ sql, params });
      if (sql.includes('FROM conversations') && sql.includes('project_id = ?')) {
        const projectId = params[0];
        return store.conversations
          .filter((row) => row.project_id === projectId)
          .sort(compareConversationRows)
          .map((row) => ({ ...row }));
      }
      return [];
    },

    get(sql, params = []) {
      db._calls.get += 1;
      if (sql.includes('FROM conversations') && sql.includes('WHERE id = ? AND project_id = ?')) {
        const [id, projectId] = params;
        const row = store.conversations.find((item) => item.id === id && item.project_id === projectId);
        return row ? { ...row } : null;
      }
      if (sql.includes('FROM conversations') && sql.includes('project_id = ?') && sql.includes('ORDER BY id ASC LIMIT 1')) {
        const projectId = params[0];
        const row = store.conversations
          .filter((item) => item.project_id === projectId)
          .sort((a, b) => a.id - b.id)[0];
        return row ? { ...row } : null;
      }
      if (sql.includes('FROM conversations') && sql.includes('WHERE id = ?')) {
        const id = params[0];
        const row = store.conversations.find((item) => item.id === id);
        return row ? { ...row } : null;
      }
      if (sql.includes('FROM ai_configs') && sql.includes('WHERE id = ? AND project_id IS NULL')) {
        const id = params[0];
        return store.ai_configs.find((row) => row.id === id && row.project_id === null) || null;
      }
      if (sql.includes('FROM ai_configs') && sql.includes('WHERE id = ? AND project_id = ?')) {
        const [id, projectId] = params;
        return store.ai_configs.find((row) => row.id === id && row.project_id === projectId) || null;
      }
      return null;
    },

    run(sql, params = []) {
      db._calls.run += 1;
      db._runs.push({ sql, params });
      if (sql.includes('UPDATE conversations SET title = ?, ai_config_id = ?, pinned_at = ?, updated_at = ? WHERE id = ? AND project_id = ?')) {
        const [title, aiConfigId, pinnedAt, updatedAt, id, projectId] = params;
        const row = store.conversations.find((item) => item.id === id && item.project_id === projectId);
        if (row) {
          row.title = title;
          row.ai_config_id = aiConfigId;
          row.pinned_at = pinnedAt;
          row.updated_at = updatedAt;
        }
      } else if (sql.includes('UPDATE conversations SET title = ?, ai_config_id = ?, pinned_at = ?, updated_at = ? WHERE id = ?')) {
        const [title, aiConfigId, pinnedAt, updatedAt, id] = params;
        const row = store.conversations.find((item) => item.id === id);
        if (row) {
          row.title = title;
          row.ai_config_id = aiConfigId;
          row.pinned_at = pinnedAt;
          row.updated_at = updatedAt;
        }
      } else if (sql.includes('DELETE FROM chat_messages') && sql.includes('project_id = ?')) {
        const [conversationId, projectId] = params;
        store.chat_messages = store.chat_messages.filter(
          (item) => item.conversation_id !== conversationId || item.project_id !== projectId,
        );
      } else if (sql.includes('DELETE FROM chat_messages')) {
        const [conversationId] = params;
        store.chat_messages = store.chat_messages.filter((item) => item.conversation_id !== conversationId);
      } else if (sql.includes('DELETE FROM conversations') && sql.includes('project_id = ?')) {
        const [id, projectId] = params;
        store.conversations = store.conversations.filter((item) => item.id !== id || item.project_id !== projectId);
      } else if (sql.includes('DELETE FROM conversations')) {
        const [id] = params;
        store.conversations = store.conversations.filter((item) => item.id !== id);
      }
    },

    insert(sql, params = []) {
      db._calls.insert += 1;
      if (sql.includes('INSERT INTO conversations')) {
        const [projectId, title, aiConfigId, pinnedAt, createdAt, updatedAt] = params;
        const id = nextId++;
        store.conversations.push({
          id,
          project_id: projectId,
          title,
          ai_config_id: aiConfigId,
          pinned_at: pinnedAt,
          created_at: createdAt,
          updated_at: updatedAt,
        });
        return id;
      }
      throw new Error(`unsupported insert: ${sql}`);
    },

    _calls: { all: 0, get: 0, run: 0, insert: 0 },
    _alls: [],
    _runs: [],
    _store: store,
  };

  return db;
}

function compareConversationRows(a, b) {
  const aPinned = a.pinned_at ? 0 : 1;
  const bPinned = b.pinned_at ? 0 : 1;
  if (aPinned !== bPinned) return aPinned - bPinned;
  const aUpdated = String(a.updated_at || '');
  const bUpdated = String(b.updated_at || '');
  if (aUpdated < bUpdated) return 1;
  if (aUpdated > bUpdated) return -1;
  return Number(b.id || 0) - Number(a.id || 0);
}

/** 收集 onEvent / onDone 回调 */
function createCollector() {
  const events = [];
  let doneResult = null;
  let doneResolve = null;
  const donePromise = new Promise((r) => { doneResolve = r; });

  return {
    events,
    doneResult: () => doneResult,
    onEvent: (e) => events.push(e),
    onDone: (d) => {
      doneResult = d;
      doneResolve(d);
    },
    waitForDone: (timeoutMs = 3000) => {
      const timer = setTimeout(() => {
        if (!doneResult) doneResolve({ status: 'timeout' });
      }, timeoutMs);
      return donePromise.then((d) => {
        clearTimeout(timer);
        return d;
      });
    },
  };
}

/** 轮询等待条件成立 */
function waitUntil(fn, timeoutMs = 2000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      if (fn()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('waitUntil timeout'));
      setImmediate(check);
    };
    check();
  });
}

/** 简单 text response llmClient stub */
function textResponseStub(text = 'Hello!') {
  const fn = async function* ({ config }) {
    fn.calls += 1;
    fn.lastConfig = config;
    yield { type: 'text_delta', content: text };
    yield { type: 'done' };
  };
  return Object.assign(fn, { calls: 0, lastConfig: null });
}

function textThenTitleStub({ reply = 'Hello!', title = '自动标题', failTitle = false } = {}) {
  const fn = async function* ({ config }) {
    fn.calls += 1;
    fn.configs.push(config);
    fn.lastConfig = config;
    const isTitleCall = config.temperature === 0.2 && config.tools === undefined;
    if (isTitleCall && failTitle) {
      throw new Error('title generation failed');
    }
    yield { type: 'text_delta', content: isTitleCall ? title : reply };
    yield { type: 'done' };
  };
  return Object.assign(fn, { calls: 0, configs: [], lastConfig: null });
}

/** tool_call → text 的两轮 llmClient stub */
function toolThenTextStub() {
  let round = 0;
  const fn = async function* ({ config }) {
    round += 1;
    fn.calls = round;
    fn.lastConfig = config;
    if (round === 1) {
      yield { type: 'tool_call', id: 'call_001', name: 'read_file', arguments: '{"filePath":"src/index.js"}' };
      yield { type: 'done' };
    } else {
      yield { type: 'text_delta', content: 'File content looks good.' };
      yield { type: 'done' };
    }
  };
  return Object.assign(fn, { calls: 0, lastConfig: null });
}

function toolThenTextAndTitleStub({ reply = 'File content looks good.', title = '文件阅读' } = {}) {
  let round = 0;
  const fn = async function* ({ config }) {
    round += 1;
    fn.calls = round;
    fn.configs.push(config);
    fn.lastConfig = config;
    const isTitleCall = config.temperature === 0.2 && config.tools === undefined;
    if (round === 1) {
      yield { type: 'tool_call', id: 'call_001', name: 'read_file', arguments: '{"filePath":"src/index.js"}' };
      yield { type: 'done' };
    } else {
      yield { type: 'text_delta', content: isTitleCall ? title : reply };
      yield { type: 'done' };
    }
  };
  return Object.assign(fn, { calls: 0, configs: [], lastConfig: null });
}

/** 始终返回 tool_call 的 stub */
function alwaysToolCallStub() {
  const fn = async function* ({ config }) {
    fn.calls += 1;
    fn.lastConfig = config;
    yield { type: 'tool_call', id: `call_${fn.calls}`, name: 'read_file', arguments: `{"filePath":"file_${fn.calls}.js"}` };
    yield { type: 'done' };
  };
  return Object.assign(fn, { calls: 0, lastConfig: null });
}

/** 可中止 stub：yield 文本后挂起，等待 signal 触发 */
function abortableStub() {
  const fn = async function* ({ config }) {
    fn.calls += 1;
    fn.lastConfig = config;
    yield { type: 'text_delta', content: 'streaming partial...' };
    await new Promise((_resolve, reject) => {
      if (config.signal?.aborted) {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        reject(err);
        return;
      }
      const onAbort = () => {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        reject(err);
      };
      config.signal?.addEventListener('abort', onAbort, { once: true });
    });
  };
  return Object.assign(fn, { calls: 0, lastConfig: null });
}

/** 首次可中止（yield 后挂起等 abort），后续返回文本 done（队列续跑场景） */
function abortThenTextStub() {
  const fn = async function* ({ config }) {
    fn.calls += 1;
    fn.lastConfig = config;
    if (fn.calls > 1) {
      yield { type: 'text_delta', content: 'next reply' };
      yield { type: 'done' };
      return;
    }
    yield { type: 'text_delta', content: 'streaming partial...' };
    await new Promise((_resolve, reject) => {
      if (config.signal?.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; return reject(e); }
      config.signal?.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); }, { once: true });
    });
  };
  return Object.assign(fn, { calls: 0, lastConfig: null });
}

/** 抛错 stub */
function errorStub(message = 'Network failure') {
  const fn = async function* () {
    fn.calls += 1;
    throw new Error(message);
  };
  return Object.assign(fn, { calls: 0 });
}

/** 测试工具定义 */
const testTools = [
  {
    name: 'read_file',
    description: 'Read a file',
    input_schema: {
      type: 'object',
      properties: { filePath: { type: 'string' } },
      required: ['filePath'],
    },
    handler: async (args) => ({
      content: `mock content of ${args.filePath}`,
      filePath: args.filePath,
      fileSize: 100,
      truncated: false,
    }),
  },
];


describe('单轮纯文本对话', () => {
  it('send → LLM 返回文本 → assistant 落库 → onDone done', async () => {
    const db = createMemoryDb();
    const llm = textResponseStub('Hello, World!');
    const col = createCollector();
    const ctrl = createChatController({
      db,
      llmClient: llm,
      chatTools: testTools,
      projectId: 1,
      workspacePath: '/tmp/test',
      onEvent: col.onEvent,
      onDone: col.onDone,
    });

    ctrl.send('Hi there');
    const done = await col.waitForDone();

    assert.equal(done.status, 'done');
    assert.equal(llm.calls, 1);

    // 验证 user + assistant 消息均已落库
    const messages = ctrl.getHistory(1);
    assert.equal(messages.length, 2);
    assert.equal(messages[0].role, 'user');
    assert.equal(messages[0].content, 'Hi there');
    assert.equal(messages[1].role, 'assistant');
    assert.equal(messages[1].content, 'Hello, World!');
    assert.equal(messages[1].status, 'done');

    // 验证 onEvent 收到 chunk
    const chunks = col.events.filter((e) => e.type === 'chunk');
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].data.content, 'Hello, World!');
  });

  it('占位标题对话成功完成后自动生成标题并通过 onDone 返回', async () => {
    const db = createMemoryDb(chatSettings(), {
      conversations: [
        { id: 1, project_id: 1, title: '新对话', ai_config_id: null },
      ],
    });
    const llm = textThenTitleStub({ reply: '已收到需求。', title: '需求规划' });
    const col = createCollector();
    const ctrl = createChatController({
      db,
      llmClient: llm,
      chatTools: testTools,
      projectId: 1,
      workspacePath: '/tmp/test',
      onEvent: col.onEvent,
      onDone: col.onDone,
    });

    ctrl.send('请帮我规划这个需求');
    const done = await col.waitForDone();

    assert.equal(done.status, 'done');
    assert.equal(done.conversationId, 1);
    assert.equal(done.title, '需求规划');
    assert.equal(llm.calls, 2, '主回复与标题生成应分别调用 LLM');
    assert.equal(db._store.conversations[0].title, '需求规划');
    assert.ok(db._runs.some((run) => run.sql.includes('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?')));

    const titleConfig = llm.configs[1];
    assert.equal(titleConfig.temperature, 0.2);
    assert.equal(titleConfig.tools, undefined);
    assert.equal(titleConfig.messages[1].content, '请帮我规划这个需求');
  });

  it('已有非占位标题不会被自动标题覆盖', async () => {
    const db = createMemoryDb(chatSettings(), {
      conversations: [
        { id: 1, project_id: 1, title: '用户手动标题', ai_config_id: null },
      ],
    });
    const llm = textThenTitleStub({ reply: '主回复完成。', title: '不应写入' });
    const col = createCollector();
    const ctrl = createChatController({
      db,
      llmClient: llm,
      chatTools: testTools,
      projectId: 1,
      workspacePath: '/tmp/test',
      onEvent: col.onEvent,
      onDone: col.onDone,
    });

    ctrl.send('继续聊');
    const done = await col.waitForDone();

    assert.equal(done.status, 'done');
    assert.equal(done.conversationId, 1);
    assert.equal(done.title, undefined);
    assert.equal(llm.calls, 1, '非占位标题不应触发标题生成 LLM 调用');
    assert.equal(db._store.conversations[0].title, '用户手动标题');
  });

  it('标题生成失败不影响主聊天完成事件', async () => {
    const db = createMemoryDb(chatSettings(), {
      conversations: [
        { id: 1, project_id: 1, title: '默认对话', ai_config_id: null },
      ],
    });
    const llm = textThenTitleStub({ reply: '主回复成功。', failTitle: true });
    const col = createCollector();
    const ctrl = createChatController({
      db,
      llmClient: llm,
      chatTools: testTools,
      projectId: 1,
      workspacePath: '/tmp/test',
      onEvent: col.onEvent,
      onDone: col.onDone,
    });

    ctrl.send('标题生成失败也不能影响回复');
    const done = await col.waitForDone();

    assert.equal(done.status, 'done');
    assert.equal(done.conversationId, 1);
    assert.equal(done.title, undefined);
    assert.equal(llm.calls, 2, '应尝试标题生成但静默吞掉失败');
    assert.equal(db._store.conversations[0].title, '默认对话');

    const messages = ctrl.getHistory(1);
    assert.equal(messages.at(-1).role, 'assistant');
    assert.equal(messages.at(-1).content, '主回复成功。');
  });

  it('send 空消息被忽略', () => {
    const db = createMemoryDb();
    const llm = textResponseStub();
    const col = createCollector();
    const ctrl = createChatController({
      db, llmClient: llm, chatTools: testTools, projectId: 1, workspacePath: '/tmp',
      onEvent: col.onEvent, onDone: col.onDone,
    });

    ctrl.send('   ');
    assert.equal(llm.calls, 0, '空消息不应触发 LLM 调用');
    assert.equal(ctrl.isActive(), false);
  });

  it('正在生成时重复 send 改为入队（需求 #37）', async () => {
    const db = createMemoryDb();
    const llm = textResponseStub();
    const col = createCollector();
    const ctrl = createChatController({ db, llmClient: llm, chatTools: testTools, projectId: 1, workspacePath: '/tmp', onEvent: col.onEvent, onDone: col.onDone });
    ctrl.send('first');
    assert.equal(ctrl.isActive(), true);
    ctrl.send('second'); // active → 入队而非忽略
    assert.ok(ctrl.hasQueued(), 'second 应入队等待顺序处理');
    assert.equal(ctrl.getQueue().length, 2, '队列含处理中 first + 排队 second');
    await col.waitForDone();
    await waitUntil(() => llm.calls >= 2);
    assert.equal(llm.calls, 2, '两条消息顺序派发，各调用一次 LLM');
  });

  it('未配置 API Key → onDone error', async () => {
    const db = createMemoryDb(chatSettings({ 'chat.apiKey': '' }));
    const llm = textResponseStub();
    const col = createCollector();
    const ctrl = createChatController({
      db, llmClient: llm, chatTools: testTools, projectId: 1, workspacePath: '/tmp',
      onEvent: col.onEvent, onDone: col.onDone,
    });

    ctrl.send('hello');
    const done = await col.waitForDone();

    assert.equal(done.status, 'error');
    assert.match(done.error, /API Key/);
    assert.equal(llm.calls, 0, '无 API Key 不应调用 LLM');

    // 验证 system 错误消息落库
    const messages = ctrl.getHistory(1);
    const sysMsg = messages.find((m) => m.role === 'system');
    assert.ok(sysMsg);
    assert.match(sysMsg.content, /API Key/);
  });

  it('LLM 请求中信号传入了 config.tools 和 config.messages', async () => {
    const db = createMemoryDb();
    const llm = textResponseStub('ok');
    const col = createCollector();
    const ctrl = createChatController({
      db, llmClient: llm, chatTools: testTools, projectId: 1, workspacePath: '/tmp',
      onEvent: col.onEvent, onDone: col.onDone,
    });

    ctrl.send('test tools passing');
    await col.waitForDone();

    const cfg = llm.lastConfig;
    assert.ok(cfg, 'llmClient 应收到 config');
    assert.equal(cfg.provider, 'openai');
    assert.equal(cfg.model, 'gpt-4o');
    assert.equal(cfg.temperature, 0.3);
    assert.ok(Array.isArray(cfg.messages), 'messages 应为数组');
    assert.ok(cfg.messages.length >= 1);
    assert.ok(Array.isArray(cfg.tools), 'tools 应为数组');
    assert.equal(cfg.tools.length, 1);
    assert.equal(cfg.tools[0].function.name, 'read_file');
    assert.ok(cfg.signal, '应传入 AbortSignal');
  });
});


describe('工具调用多轮', () => {
  it('send → tool_calls → 工具执行 → 工具结果落库 → 回灌 LLM → 文本回复 → done', async () => {
    const db = createMemoryDb();
    const llm = toolThenTextStub();
    const col = createCollector();
    const ctrl = createChatController({
      db, llmClient: llm, chatTools: testTools, projectId: 1, workspacePath: '/tmp',
      onEvent: col.onEvent, onDone: col.onDone,
    });

    ctrl.send('read src/index.js');
    const done = await col.waitForDone();

    assert.equal(done.status, 'done');
    assert.equal(llm.calls, 2, '应调用 LLM 两次（tool_call + 文本回复）');

    // 验证消息完整性
    const messages = ctrl.getHistory(1);
    const roles = messages.map((m) => m.role);
    assert.deepEqual(roles, ['user', 'assistant', 'tool', 'assistant']);

    // 第一轮 assistant 应有 tool_calls
    assert.ok(messages[1].tool_calls);
    const parsedTc = JSON.parse(messages[1].tool_calls);
    assert.equal(parsedTc[0].function.name, 'read_file');

    // tool 消息应有 tool_result
    assert.ok(messages[2].tool_result);
    const parsedTr = JSON.parse(messages[2].tool_result);
    assert.equal(parsedTr.name, 'read_file');
    assert.equal(parsedTr.tool_call_id, 'call_001');

    // 第二轮 assistant 为纯文本
    assert.equal(messages[3].content, 'File content looks good.');

    // 验证 onEvent 事件类型
    const eventTypes = col.events.map((e) => e.type);
    assert.ok(eventTypes.includes('status'), '应有 status 事件');
    assert.ok(eventTypes.includes('tool_start'), '应有 tool_start 事件');
    assert.ok(eventTypes.includes('tool_result'), '应有 tool_result 事件');
    assert.ok(eventTypes.includes('chunk'), '应有 chunk 事件');
  });

  it('工具循环最终文本回复完成后也会为占位标题生成标题', async () => {
    const db = createMemoryDb(chatSettings(), {
      conversations: [
        { id: 1, project_id: 1, title: '', ai_config_id: null },
      ],
    });
    const llm = toolThenTextAndTitleStub({
      reply: 'File content looks good.',
      title: '文件检查',
    });
    const col = createCollector();
    const ctrl = createChatController({
      db, llmClient: llm, chatTools: testTools, projectId: 1, workspacePath: '/tmp',
      onEvent: col.onEvent, onDone: col.onDone,
    });

    ctrl.send('read src/index.js');
    const done = await col.waitForDone();

    assert.equal(done.status, 'done');
    assert.equal(done.conversationId, 1);
    assert.equal(done.title, '文件检查');
    assert.equal(llm.calls, 3, 'tool_call、最终文本回复、标题生成应各调用一次 LLM');
    assert.equal(db._store.conversations[0].title, '文件检查');

    const messages = ctrl.getHistory(1);
    assert.deepEqual(messages.map((m) => m.role), ['user', 'assistant', 'tool', 'assistant']);
  });

  it('未知工具返回错误但不中断对话', async () => {
    const db = createMemoryDb();
    let round = 0;
    const stubWithUnknown = async function* ({ config }) {
      round += 1;
      if (round === 1) {
        yield { type: 'tool_call', id: 'call_x', name: 'nonexistent_tool', arguments: '{}' };
        yield { type: 'done' };
      } else {
        yield { type: 'text_delta', content: 'Attempted unknown tool.' };
        yield { type: 'done' };
      }
    };
    const col = createCollector();
    const ctrl = createChatController({
      db, llmClient: stubWithUnknown, chatTools: testTools, projectId: 1, workspacePath: '/tmp',
      onEvent: col.onEvent, onDone: col.onDone,
    });

    ctrl.send('use bad tool');
    const done = await col.waitForDone();

    assert.equal(done.status, 'done');

    // 验证 tool_result 事件包含错误
    const toolResults = col.events.filter((e) => e.type === 'tool_result');
    assert.equal(toolResults.length, 1);
    assert.equal(toolResults[0].data.name, 'nonexistent_tool');
    assert.equal(toolResults[0].data.result.errorCode, 'UNKNOWN_TOOL');
  });
});


describe('最大轮次限制', () => {
  it('LLM 持续返回 tool_calls，第 8 轮后 onDone max_rounds', async () => {
    const db = createMemoryDb();
    const llm = alwaysToolCallStub();
    const col = createCollector();
    const ctrl = createChatController({
      db, llmClient: llm, chatTools: testTools, projectId: 1, workspacePath: '/tmp',
      onEvent: col.onEvent, onDone: col.onDone,
    });

    ctrl.send('keep reading files');
    const done = await col.waitForDone(5000);

    assert.equal(done.status, 'max_rounds');
    assert.equal(llm.calls, 8, 'LLM 应被调用恰好 8 次');

    // 验证 system 提示消息
    const messages = ctrl.getHistory(1);
    const sysMsg = messages.find((m) => m.role === 'system' && m.content.includes('最大对话轮次'));
    assert.ok(sysMsg, '应有最大轮次 system 提示');
    assert.equal(sysMsg.status, 'error');
  });
});


describe('中止', () => {
  it('send 后立即 stop() → onDone aborted → chat_messages 有 aborted 标记', async () => {
    const db = createMemoryDb();
    const llm = abortableStub();
    const col = createCollector();
    const ctrl = createChatController({
      db, llmClient: llm, chatTools: testTools, projectId: 1, workspacePath: '/tmp',
      onEvent: col.onEvent, onDone: col.onDone,
    });

    ctrl.send('start streaming');
    // 等待 text_delta 被 emit（generator 已挂起）
    await waitUntil(() => col.events.some((e) => e.type === 'chunk'), 1000);

    ctrl.stop();
    const done = await col.waitForDone();

    assert.equal(done.status, 'aborted');
    assert.equal(llm.calls, 1);
  });

  it('非活跃时 stop() 无操作', () => {
    const db = createMemoryDb();
    const ctrl = createChatController({
      db, llmClient: textResponseStub(), chatTools: testTools, projectId: 1, workspacePath: '/tmp',
    });

    // 不应抛错
    ctrl.stop();
    assert.equal(ctrl.isActive(), false);
  });
});


describe('错误处理', () => {
  it('LLM 调用抛异常 → onDone error → system 错误消息落库', async () => {
    const db = createMemoryDb();
    const llm = errorStub('Connection refused');
    const col = createCollector();
    const ctrl = createChatController({
      db, llmClient: llm, chatTools: testTools, projectId: 1, workspacePath: '/tmp',
      onEvent: col.onEvent, onDone: col.onDone,
    });

    ctrl.send('crash test');
    const done = await col.waitForDone();

    assert.equal(done.status, 'error');
    assert.match(done.error, /Connection refused/);

    // 验证 system 错误消息落库
    const messages = ctrl.getHistory(1);
    const sysMsg = messages.find((m) => m.role === 'system' && m.content.includes('Connection refused'));
    assert.ok(sysMsg, '应有 system 错误消息');
  });

  it('LLM 返回 error 事件 → onDone error', async () => {
    const db = createMemoryDb();
    const llmWithError = async function* () {
      yield { type: 'error', message: 'Rate limit exceeded', aborted: false };
    };
    const col = createCollector();
    const ctrl = createChatController({
      db, llmClient: llmWithError, chatTools: testTools, projectId: 1, workspacePath: '/tmp',
      onEvent: col.onEvent, onDone: col.onDone,
    });

    ctrl.send('rate limit test');
    const done = await col.waitForDone();

    assert.equal(done.status, 'error');
    assert.match(done.error, /Rate limit exceeded/);
  });

  it('工具 handler 抛错时返回结构化错误且不中断对话', async () => {
    const db = createMemoryDb();
    const throwingTools = [
      {
        name: 'buggy_tool',
        description: 'Always throws',
        input_schema: { type: 'object', properties: {}, required: [] },
        handler: async () => { throw new Error('handler crash'); },
      },
    ];

    let round = 0;
    const llm = async function* () {
      round += 1;
      if (round === 1) {
        yield { type: 'tool_call', id: 'call_e', name: 'buggy_tool', arguments: '{}' };
        yield { type: 'done' };
      } else {
        yield { type: 'text_delta', content: 'Tool failed, but I will continue.' };
        yield { type: 'done' };
      }
    };

    const col = createCollector();
    const ctrl = createChatController({
      db, llmClient: llm, chatTools: throwingTools, projectId: 1, workspacePath: '/tmp',
      onEvent: col.onEvent, onDone: col.onDone,
    });

    ctrl.send('test tool crash');
    const done = await col.waitForDone();

    assert.equal(done.status, 'done');

    // tool_result 包含错误
    const toolResults = col.events.filter((e) => e.type === 'tool_result');
    assert.equal(toolResults.length, 1);
    assert.equal(toolResults[0].data.result.errorCode, 'TOOL_EXECUTION_ERROR');
    assert.match(toolResults[0].data.result.error, /handler crash/);
  });
});


describe('getHistory / clearHistory', () => {
  it('getHistory 返回按时间排序的消息列表', async () => {
    const db = createMemoryDb();
    const llm = textResponseStub('Reply A');
    const col = createCollector();
    const ctrl = createChatController({
      db, llmClient: llm, chatTools: testTools, projectId: 1, workspacePath: '/tmp',
      onEvent: col.onEvent, onDone: col.onDone,
    });

    ctrl.send('Q1');
    await col.waitForDone();

    // 第二轮
    const col2 = createCollector();
    const ctrl2 = createChatController({
      db, llmClient: textResponseStub('Reply B'), chatTools: testTools, projectId: 1, workspacePath: '/tmp',
      onEvent: col2.onEvent, onDone: col2.onDone,
    });
    ctrl2.send('Q2');
    await col2.waitForDone();

    const history = ctrl.getHistory(1);
    const roles = history.map((m) => m.role);

    assert.equal(history.length, 4);
    assert.deepEqual(roles, ['user', 'assistant', 'user', 'assistant']);
    assert.equal(history[0].content, 'Q1');
    assert.equal(history[1].content, 'Reply A');
    assert.equal(history[2].content, 'Q2');
    assert.equal(history[3].content, 'Reply B');
  });

  it('clearHistory 后 getHistory 返回空', async () => {
    const db = createMemoryDb();
    const llm = textResponseStub('msg');
    const col = createCollector();
    const ctrl = createChatController({
      db, llmClient: llm, chatTools: testTools, projectId: 1, workspacePath: '/tmp',
      onEvent: col.onEvent, onDone: col.onDone,
    });

    ctrl.send('hello');
    await col.waitForDone();

    assert.ok(ctrl.getHistory(1).length > 0, '清空前应有消息');

    ctrl.clearHistory(1);
    assert.equal(ctrl.getHistory(1).length, 0, '清空后应为空');
    assert.equal(db._store.chat_messages.length, 0);
  });

  it('按 projectId 隔离：不同项目的历史不混淆', async () => {
    const db = createMemoryDb();

    // 项目 1
    const llm1 = textResponseStub('P1 reply');
    const col1 = createCollector();
    const ctrl1 = createChatController({
      db, llmClient: llm1, chatTools: testTools, projectId: 1, workspacePath: '/tmp/p1',
      onEvent: col1.onEvent, onDone: col1.onDone,
    });
    ctrl1.send('P1 question');
    await col1.waitForDone();

    // 项目 2
    const llm2 = textResponseStub('P2 reply');
    const col2 = createCollector();
    const ctrl2 = createChatController({
      db, llmClient: llm2, chatTools: testTools, projectId: 2, workspacePath: '/tmp/p2',
      onEvent: col2.onEvent, onDone: col2.onDone,
    });
    ctrl2.send('P2 question');
    await col2.waitForDone();

    assert.equal(ctrl1.getHistory(1).length, 2, '项目 1 应有 2 条消息');
    assert.equal(ctrl2.getHistory(2).length, 2, '项目 2 应有 2 条消息');

    // 清空项目 1，项目 2 不受影响
    ctrl1.clearHistory(1);
    assert.equal(ctrl1.getHistory(1).length, 0);
    assert.equal(ctrl2.getHistory(2).length, 2, '清空项目 1 不应影响项目 2');
  });

  it('getHistory and clearHistory require both conversationId and projectId matches', () => {
    const db = createMemoryDb();
    db._store.chat_messages.push(
      {
        id: 101,
        project_id: 1,
        conversation_id: 1,
        role: 'user',
        content: 'project 1 visible',
        status: 'done',
        created_at: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 102,
        project_id: 2,
        conversation_id: 1,
        role: 'user',
        content: 'project 2 hidden',
        status: 'done',
        created_at: '2026-01-01T00:00:01.000Z',
      },
    );
    const ctrl = createChatController({
      db,
      llmClient: textResponseStub(),
      chatTools: testTools,
      projectId: 1,
      conversationId: 1,
      workspacePath: '/tmp/p1',
    });

    const before = ctrl.getHistory();
    assert.deepEqual(before.map((message) => message.content), ['project 1 visible']);

    ctrl.clearHistory();
    assert.deepEqual(ctrl.getHistory(), []);
    assert.deepEqual(db._store.chat_messages.map((message) => message.content), ['project 2 hidden']);
  });
});

describe('conversation project boundaries', () => {
  it('createChatController rejects a conversation from another project', () => {
    const db = createMemoryDb();

    assert.throws(
      () => createChatController({
        db,
        llmClient: textResponseStub(),
        chatTools: testTools,
        projectId: 1,
        conversationId: 2,
        workspacePath: '/tmp/p1',
      }),
    );
  });

  it('updateConversation scopes mutations by projectId and rejects wrong-project ids', () => {
    const db = createConversationCrudDb({
      conversations: [
        {
          id: 1,
          project_id: 1,
          title: 'project one',
          ai_config_id: null,
          pinned_at: null,
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:00.000Z',
        },
      ],
    });

    assert.throws(
      () => updateConversation(db, 1, { projectId: 2, title: 'wrong project' }),
    );

    const updated = updateConversation(db, 1, { projectId: 1, title: 'renamed in project' });
    const scopedRun = db._runs.at(-1);

    assert.equal(updated.title, 'renamed in project');
    assert.match(scopedRun.sql, /WHERE id = \? AND project_id = \?/);
    assert.deepEqual(scopedRun.params.slice(-2), [1, 1]);
  });

  it('deleteConversation removes only rows in the requested project scope', () => {
    const db = createConversationCrudDb({
      conversations: [
        {
          id: 1,
          project_id: 1,
          title: 'project one',
          ai_config_id: null,
          pinned_at: null,
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:00.000Z',
        },
        {
          id: 2,
          project_id: 2,
          title: 'project two',
          ai_config_id: null,
          pinned_at: null,
          created_at: '2026-01-02T00:00:00.000Z',
          updated_at: '2026-01-02T00:00:00.000Z',
        },
      ],
      chatMessages: [
        { id: 1, project_id: 1, conversation_id: 1, role: 'user', content: 'p1' },
        { id: 2, project_id: 2, conversation_id: 2, role: 'user', content: 'p2' },
      ],
    });

    assert.throws(() => deleteConversation(db, 1, { projectId: 2 }));
    assert.deepEqual(deleteConversation(db, 1, { projectId: 1 }), { deleted: true, id: 1 });

    assert.deepEqual(db._store.conversations.map((row) => row.id), [2]);
    assert.deepEqual(db._store.chat_messages.map((row) => row.content), ['p2']);
    assert.ok(db._runs.some((run) => run.sql.includes('DELETE FROM conversations WHERE id = ? AND project_id = ?')));
  });

  it('ensureDefaultConversation returns and creates defaults inside one project only', () => {
    const db = createConversationCrudDb({
      conversations: [
        {
          id: 10,
          project_id: 1,
          title: 'project one default',
          ai_config_id: null,
          pinned_at: null,
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:00.000Z',
        },
        {
          id: 20,
          project_id: 2,
          title: 'project two default',
          ai_config_id: null,
          pinned_at: null,
          created_at: '2026-01-02T00:00:00.000Z',
          updated_at: '2026-01-02T00:00:00.000Z',
        },
      ],
    });

    assert.equal(ensureDefaultConversation(db, 2), 20);

    const createdId = ensureDefaultConversation(db, 3);
    const created = db._store.conversations.find((row) => row.id === createdId);
    assert.equal(created.project_id, 3);
    assert.equal(created.ai_config_id, null);
    assert.ok(!db._store.conversations.some((row) => row.project_id === 1 && row.id === createdId));
  });

  it('conversation AI config binding only accepts global configs', () => {
    const db = createConversationCrudDb({
      conversations: [
        {
          id: 1,
          project_id: 1,
          title: 'project one',
          ai_config_id: null,
          pinned_at: null,
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:00.000Z',
        },
      ],
      aiConfigs: [
        aiConfigFromSettings(chatSettings(), { id: 1, project_id: null, name: 'Global' }),
        aiConfigFromSettings(chatSettings(), { id: 99, project_id: 1, name: 'Legacy project scoped' }),
      ],
    });

    const rejected = updateConversation(db, 1, { projectId: 1, aiConfigId: 99 });
    assert.equal(rejected.aiConfigId, null);

    const accepted = updateConversation(db, 1, { projectId: 1, aiConfigId: 1 });
    assert.equal(accepted.aiConfigId, 1);
  });
});


describe('getConfig / isActive', () => {
  it('getConfig 返回当前对话解析出的全局 AI 配置', () => {
    const db = createMemoryDb(chatSettings({
      'chat.provider': 'anthropic',
      'chat.model': 'claude-sonnet-4-6',
    }));
    const ctrl = createChatController({
      db, llmClient: textResponseStub(), chatTools: testTools, projectId: 1, workspacePath: '/tmp',
    });

    const cfg = ctrl.getConfig();
    assert.equal(cfg.provider, 'anthropic');
    assert.equal(cfg.model, 'claude-sonnet-4-6');
    assert.equal(cfg.baseUrl, 'https://api.openai.com/v1');
    assert.equal(cfg.temperature, '0.3');
  });

  it('旧 chat.apiKey 为空但全局 ai_configs 有密钥时仍可发送', async () => {
    const settings = chatSettings({
      'chat.apiKey': '',
      'chat.provider': 'openai',
      'chat.model': 'gpt-4o',
    });
    const db = createMemoryDb(settings, {
      aiConfigs: [
        aiConfigFromSettings(settings, {
          id: 10,
          project_id: null,
          name: 'Global Primary',
          provider: 'deepseek',
          base_url: 'https://api.deepseek.com',
          api_key: 'sk-global-ai-config-1234',
          model: 'deepseek-chat',
          temperature: '0.2',
        }),
      ],
    });
    const llm = textResponseStub('global config works');
    const col = createCollector();
    const ctrl = createChatController({
      db,
      llmClient: llm,
      chatTools: testTools,
      projectId: 1,
      workspacePath: '/tmp',
      onEvent: col.onEvent,
      onDone: col.onDone,
    });

    const cfg = ctrl.getConfig();
    assert.equal(cfg.provider, 'deepseek');
    assert.equal(cfg.apiKey, 'sk-global-ai-config-1234');
    assert.equal(cfg.model, 'deepseek-chat');

    ctrl.send('hello with global config');
    const done = await col.waitForDone();

    assert.equal(done.status, 'done');
    assert.equal(llm.calls, 1);
    assert.equal(llm.lastConfig.provider, 'deepseek');
    assert.equal(llm.lastConfig.apiKey, 'sk-global-ai-config-1234');
    assert.equal(llm.lastConfig.model, 'deepseek-chat');
  });

  it('isActive 反映当前生成状态', async () => {
    const db = createMemoryDb();
    const col = createCollector();
    const ctrl = createChatController({
      db, llmClient: textResponseStub(), chatTools: testTools, projectId: 1, workspacePath: '/tmp',
      onEvent: col.onEvent, onDone: col.onDone,
    });

    assert.equal(ctrl.isActive(), false);
    ctrl.send('test');
    assert.equal(ctrl.isActive(), true);
    await col.waitForDone();
    assert.equal(ctrl.isActive(), false);
  });

  it('getConfig 缺省值时使用默认值', () => {
    const db = createMemoryDb({}); // 完全空的 settings
    const ctrl = createChatController({
      db, llmClient: textResponseStub(), chatTools: testTools, projectId: 1, workspacePath: '/tmp',
    });

    const cfg = ctrl.getConfig();
    assert.equal(cfg.provider, 'openai');
    assert.equal(cfg.model, 'gpt-4o');
    assert.equal(cfg.baseUrl, 'https://api.openai.com');
    assert.equal(cfg.apiKey, '');
    assert.equal(cfg.temperature, '0.3');
  });
});

describe('对话队列：续跑与上下文隔离（需求 #37）', () => {
  it('stop() 中止当前后继续派发队列下一条', async () => {
    const db = createMemoryDb();
    const llm = abortThenTextStub();
    const col = createCollector();
    const ctrl = createChatController({ db, llmClient: llm, chatTools: testTools, projectId: 1, workspacePath: '/tmp', onEvent: col.onEvent, onDone: col.onDone });
    ctrl.send('first');
    await waitUntil(() => llm.calls >= 1);
    ctrl.send('second'); // active → 入队
    assert.ok(ctrl.hasQueued(), 'second 应入队');
    ctrl.stop(); // 中止 first
    await col.waitForDone(); // first aborted done
    await waitUntil(() => llm.calls >= 2 && col.doneResult()?.status === 'done');
    assert.equal(llm.calls, 2, '中止 first 后 second 被顺序派发');
  });
  it('buildMessages 不包含 status=queued 行', async () => {
    const db = createMemoryDb();
    db.run(`INSERT INTO chat_messages (project_id, conversation_id, role, content, tool_calls, tool_result, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [1, 1, 'user', 'queued-msg', null, null, 'queued', '2026-01-01T00:00:00.000Z']);
    const llm = textResponseStub();
    const col = createCollector();
    const ctrl = createChatController({ db, llmClient: llm, chatTools: testTools, projectId: 1, workspacePath: '/tmp', onEvent: col.onEvent, onDone: col.onDone });
    ctrl.send('real question');
    await waitUntil(() => llm.calls >= 1);
    const msgs = (llm.lastConfig && llm.lastConfig.messages) || [];
    assert.ok(!msgs.some((m) => m.content === 'queued-msg'), 'queued 行不应进入 LLM 上下文');
    await col.waitForDone();
  });
});

describe('对话置顶与排序', () => {
  it('旧 conversations 表迁移时补齐 pinned_at 字段并保留已有会话', async () => {
    const fixture = await createConversationMigrationFixture();
    try {
      const columns = fixture.db.all('PRAGMA table_info(conversations)').map((column) => column.name);
      assert.ok(columns.includes('pinned_at'), '旧 conversations 表应补齐 pinned_at 列');

      const migrated = fixture.db.get(
        'SELECT title, pinned_at FROM conversations WHERE title = ?',
        ['legacy conversation'],
      );
      assert.equal(migrated.title, 'legacy conversation');
      assert.equal(migrated.pinned_at, null);
    } finally {
      fixture.cleanup();
    }
  });

  it('listConversations 返回置顶优先，组内按 updated_at DESC, id DESC 排序', () => {
    const db = createConversationCrudDb({
      conversations: [
        {
          id: 1,
          project_id: 1,
          title: 'old normal',
          ai_config_id: null,
          pinned_at: null,
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-03T00:00:00.000Z',
        },
        {
          id: 2,
          project_id: 1,
          title: 'older pinned',
          ai_config_id: null,
          pinned_at: '2026-01-02T00:00:00.000Z',
          created_at: '2026-01-02T00:00:00.000Z',
          updated_at: '2026-01-02T00:00:00.000Z',
        },
        {
          id: 3,
          project_id: 1,
          title: 'newer pinned',
          ai_config_id: null,
          pinned_at: '2026-01-01T00:00:00.000Z',
          created_at: '2026-01-03T00:00:00.000Z',
          updated_at: '2026-01-05T00:00:00.000Z',
        },
        {
          id: 4,
          project_id: 1,
          title: 'new normal',
          ai_config_id: null,
          pinned_at: null,
          created_at: '2026-01-04T00:00:00.000Z',
          updated_at: '2026-01-06T00:00:00.000Z',
        },
        {
          id: 5,
          project_id: 2,
          title: 'other project',
          ai_config_id: null,
          pinned_at: '2026-01-07T00:00:00.000Z',
          created_at: '2026-01-07T00:00:00.000Z',
          updated_at: '2026-01-07T00:00:00.000Z',
        },
      ],
    });

    const conversations = listConversations(db, 1);
    const listSql = db._alls[0].sql;

    assert.match(listSql, /CASE WHEN pinned_at IS NULL OR pinned_at = '' THEN 1 ELSE 0 END ASC/);
    assert.match(listSql, /updated_at DESC/);
    assert.match(listSql, /id DESC/);
    assert.deepEqual(conversations.map((item) => item.id), [3, 2, 4, 1]);
    assert.equal(conversations[0].pinned, true);
    assert.equal(conversations[0].pinnedAt, '2026-01-01T00:00:00.000Z');
    assert.equal(conversations[0].pinned_at, '2026-01-01T00:00:00.000Z');
    assert.equal(conversations[2].pinned, false);
    assert.equal(conversations[2].pinnedAt, null);
  });

  it('updateConversation 支持 title、aiConfigId 与置顶字段一起更新', () => {
    const db = createConversationCrudDb({
      conversations: [
        {
          id: 1,
          project_id: 1,
          title: 'before',
          ai_config_id: 1,
          pinned_at: null,
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:00.000Z',
        },
      ],
    });

    const updated = updateConversation(db, 1, {
      title: 'after',
      aiConfigId: 2,
      pinned: true,
    });

    assert.equal(updated.title, 'after');
    assert.equal(updated.aiConfigId, 2);
    assert.equal(updated.ai_config_id, 2);
    assert.equal(updated.pinned, true);
    assert.ok(updated.pinnedAt);
    assert.equal(updated.pinnedAt, updated.pinned_at);
  });

  it('updateConversation 支持取消置顶且不破坏旧客户端未传字段的兼容路径', () => {
    const pinnedAt = '2026-01-08T00:00:00.000Z';
    const db = createConversationCrudDb({
      conversations: [
        {
          id: 1,
          project_id: 1,
          title: 'pinned',
          ai_config_id: 1,
          pinned_at: pinnedAt,
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-08T00:00:00.000Z',
        },
      ],
    });

    const renamedOnly = updateConversation(db, 1, { title: 'renamed' });
    assert.equal(renamedOnly.title, 'renamed');
    assert.equal(renamedOnly.pinnedAt, pinnedAt);
    assert.equal(renamedOnly.pinned, true);

    const unpinned = updateConversation(db, 1, { pinned: false });
    assert.equal(unpinned.title, 'renamed');
    assert.equal(unpinned.aiConfigId, 1);
    assert.equal(unpinned.pinnedAt, null);
    assert.equal(unpinned.pinned_at, null);
    assert.equal(unpinned.pinned, false);
  });

  it('createConversation 默认未置顶并序列化 pinned 状态', () => {
    const db = createConversationCrudDb();

    const conversation = createConversation(db, { projectId: 1, title: 'new conversation' });

    assert.equal(conversation.title, 'new conversation');
    assert.equal(conversation.pinned_at, null);
    assert.equal(conversation.pinnedAt, null);
    assert.equal(conversation.pinned, false);
  });
});

async function createConversationMigrationFixture() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autoplan-conversation-migration-test-'));
  const dbPath = path.join(tempRoot, 'data', 'autoplan.sqlite');
  await writeLegacyConversationDatabase(dbPath);

  const db = new AppDatabase(dbPath);
  await db.init();
  return {
    db,
    cleanup() {
      try {
        db.db?.close?.();
      } catch {
        // sql.js close is best-effort in tests.
      }
      fs.rmSync(tempRoot, { recursive: true, force: true });
    },
  };
}

async function writeLegacyConversationDatabase(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const SQL = await initSqlJs({
    locateFile: (file) => path.join(__dirname, '..', '..', 'node_modules', 'sql.js', 'dist', file),
  });
  const db = new SQL.Database();
  db.run(`
    CREATE TABLE conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER,
      title TEXT NOT NULL DEFAULT '',
      ai_config_id INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  db.run(
    `INSERT INTO conversations (project_id, title, ai_config_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
    [1, 'legacy conversation', null, '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z'],
  );
  fs.writeFileSync(dbPath, Buffer.from(db.export()));
  db.close();
}
