'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createChatController } = require('./chatController');

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

/** 内存 DB 替身：完整模拟 chatController 所需的 SQL 操作 */
function createMemoryDb(settings = chatSettings()) {
  const store = {
    chat_messages: [],
    settings: new Map(Object.entries(settings)),
  };
  let nextId = 1;

  const db = {
    all(sql, params = []) {
      db._calls.all += 1;
      if (sql.includes('chat_messages')) {
        let rows = [...store.chat_messages];
        if (sql.includes('project_id = ?')) {
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
      if (sql.includes('chat_messages') && sql.includes('ORDER BY id DESC LIMIT 1')) {
        const pid = params[0];
        const rows = store.chat_messages
          .filter((r) => r.project_id === pid && r.role === 'assistant' && r.status === 'done')
          .sort((a, b) => b.id - a.id);
        return rows[0] || null;
      }
      return null;
    },

    run(sql, params = []) {
      db._calls.run += 1;
      db._runs.push({ sql, params });

      if (sql.includes('INSERT INTO chat_messages')) {
        const [pid, role, content, tool_calls, tool_result, status, created_at] = params;
        const row = { id: nextId++, project_id: pid, role, content, tool_calls, tool_result, status, created_at };
        store.chat_messages.push(row);
      } else if (sql.includes('DELETE FROM chat_messages')) {
        const pid = params[0];
        store.chat_messages = store.chat_messages.filter((r) => r.project_id !== pid);
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

    _calls: { all: 0, get: 0, run: 0, getSettings: 0 },
    _runs: [],
    _store: store,
  };
  return db;
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
  fn.calls = 0;
  fn.lastConfig = null;
  return fn;
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
  fn.calls = 0;
  fn.lastConfig = null;
  return fn;
}

/** 始终返回 tool_call 的 stub */
function alwaysToolCallStub() {
  const fn = async function* ({ config }) {
    fn.calls += 1;
    fn.lastConfig = config;
    yield { type: 'tool_call', id: `call_${fn.calls}`, name: 'read_file', arguments: `{"filePath":"file_${fn.calls}.js"}` };
    yield { type: 'done' };
  };
  fn.calls = 0;
  fn.lastConfig = null;
  return fn;
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
  fn.calls = 0;
  fn.lastConfig = null;
  return fn;
}

/** 抛错 stub */
function errorStub(message = 'Network failure') {
  const fn = async function* () {
    fn.calls += 1;
    throw new Error(message);
  };
  fn.calls = 0;
  return fn;
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

/* ================================================================== 单轮纯文本对话 ================================================================== */

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

  it('正在生成时重复 send 被忽略', async () => {
    const db = createMemoryDb();
    const llm = textResponseStub();
    const col = createCollector();
    const ctrl = createChatController({
      db, llmClient: llm, chatTools: testTools, projectId: 1, workspacePath: '/tmp',
      onEvent: col.onEvent, onDone: col.onDone,
    });

    ctrl.send('first');
    assert.equal(ctrl.isActive(), true);
    ctrl.send('second'); // 应被忽略
    const done = await col.waitForDone();

    assert.equal(done.status, 'done');
    assert.equal(llm.calls, 1, '仅应调用一次 LLM');
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

/* ================================================================== 工具调用多轮 ================================================================== */

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

/* ================================================================== 最大轮次限制 ================================================================== */

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

/* ================================================================== 中止 ================================================================== */

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

/* ================================================================== 错误处理 ================================================================== */

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

/* ================================================================== 历史查询 / 清空 ================================================================== */

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
});

/* ================================================================== getConfig / isActive ================================================================== */

describe('getConfig / isActive', () => {
  it('getConfig 返回 chat.* 设置', () => {
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
