'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createLlmClient } = require('./llmClient');

/* ------------------------------------------------------------------ 测试辅助 ------------------------------------------------------------------ */

/**
 * 抓取式 fetch stub：记录 request 细节，返回给定的 response（或 factory）。
 * 对齐 updateChecker.test.js 的 fetchStub 形态，但增加 url/body/headers 捕获。
 */
function capturingFetch(responseOrFactory) {
  const fn = async (url, init) => {
    fn.calls += 1;
    fn.url = url;
    fn.body = init?.body ? JSON.parse(init.body) : null;
    fn.headers = init?.headers || {};
    fn.signal = init?.signal || null;
    const resp = typeof responseOrFactory === 'function' ? responseOrFactory() : responseOrFactory;
    return resp;
  };
  fn.calls = 0;
  fn.url = null;
  fn.body = null;
  fn.headers = {};
  fn.signal = null;
  return fn;
}

/**
 * 可中止 fetch stub：返回永不 resolve 的 Promise，监听 signal.abort 以 reject AbortError。
 */
function abortableFetchStub() {
  const fn = async (url, init) => {
    fn.calls += 1;
    fn.url = url;
    fn.signal = init?.signal || null;
    return new Promise((_resolve, reject) => {
      if (init?.signal?.aborted) {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        reject(err);
        return;
      }
      init?.signal?.addEventListener(
        'abort',
        () => {
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          reject(err);
        },
        { once: true },
      );
    });
  };
  fn.calls = 0;
  fn.url = null;
  fn.signal = null;
  return fn;
}

/**
 * 将字符串数组模拟为 ReadableStream（SSE 流式响应 body）。
 * 每个 chunk 可能跨行拆分，用于验证部分行缓存逻辑。
 */
function sseStream(chunks) {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(encoder.encode(chunks[index]));
        index += 1;
      } else {
        controller.close();
      }
    },
  });
}

/** 收集 async generator 所有事件 */
async function collectEvents(generator) {
  const events = [];
  for await (const event of generator) {
    events.push(event);
  }
  return events;
}

/** 按 type 过滤事件 */
function eventsOfType(events, type) {
  return events.filter((e) => e.type === type);
}

/* ------------------------------------------------------------------ 公用配置 ------------------------------------------------------------------ */

const baseOpenAiConfig = {
  provider: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'sk-test-key',
  model: 'gpt-4o',
  temperature: 0.3,
  messages: [{ role: 'user', content: 'hello' }],
};

const baseAnthropicConfig = {
  provider: 'anthropic',
  baseUrl: 'https://api.anthropic.com',
  apiKey: 'sk-ant-test-key',
  model: 'claude-sonnet-4-6',
  temperature: 0.3,
  messages: [{ role: 'user', content: 'hello' }],
};

const sampleTools = [
  {
    type: 'function',
    function: { name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: {} } },
  },
];

const strictCreatePlanSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: { type: 'string' },
    tasks: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string' },
          scope: { type: 'string' },
          acceptancePoints: { type: 'array', items: { type: 'string' }, minItems: 1 },
        },
        required: ['title', 'scope', 'acceptancePoints'],
      },
    },
    overallAcceptance: {
      type: 'object',
      additionalProperties: false,
      properties: {
        commands: { type: 'array', items: { type: 'string' }, minItems: 1 },
        scope: { type: 'string' },
        passCriteria: { type: 'array', items: { type: 'string' }, minItems: 1 },
      },
      required: ['commands', 'scope', 'passCriteria'],
    },
  },
  required: ['title', 'tasks', 'overallAcceptance'],
};

/* ================================================================== OpenAI 协议 ================================================================== */

describe('createLlmClient OpenAI 协议', () => {
  it('构造请求体：model/messages/stream/temperature 字段正确', async () => {
    const fetch = capturingFetch(() => ({
      ok: true,
      body: sseStream(['data: {"id":"1","choices":[{"index":0,"delta":{"content":"Hi"},"finish_reason":"stop"}]}\n\n']),
    }));

    await collectEvents(createLlmClient({ config: baseOpenAiConfig, fetch }));

    assert.equal(fetch.url, 'https://api.openai.com/v1/chat/completions');
    assert.equal(fetch.body.model, 'gpt-4o');
    assert.equal(fetch.body.stream, true);
    assert.equal(fetch.body.temperature, 0.3);
    assert.deepEqual(fetch.body.messages, [{ role: 'user', content: 'hello' }]);
    assert.equal(fetch.body.tools, undefined, '无 tools 时不应出现在 body');
    assert.equal(fetch.headers['Content-Type'], 'application/json');
    assert.equal(fetch.headers['Authorization'], 'Bearer sk-test-key');
  });

  it('tools 非空时透传到请求体', async () => {
    const fetch = capturingFetch(() => ({
      ok: true,
      body: sseStream(['data: {"id":"1","choices":[{"index":0,"delta":{"content":"Hi"},"finish_reason":"stop"}]}\n\n']),
    }));

    await collectEvents(
      createLlmClient({ config: { ...baseOpenAiConfig, tools: sampleTools }, fetch }),
    );

    assert.ok(fetch.body.tools, 'tools 应出现在 body 中');
    assert.equal(fetch.body.tools.length, 1);
    assert.equal(fetch.body.tools[0].function.name, 'read_file');
  });

  it('OpenAI SDK 归一化保留 function.strict 与严格 parameters', async () => {
    const fetch = capturingFetch(() => ({
      ok: true,
      body: sseStream(['data: {"id":"1","choices":[{"index":0,"delta":{"content":"Hi"},"finish_reason":"stop"}]}\n\n']),
    }));
    const tools = [
      {
        type: 'function',
        function: {
          name: 'create_plan',
          description: 'Create plan',
          strict: true,
          parameters: strictCreatePlanSchema,
        },
      },
    ];

    await collectEvents(
      createLlmClient({ config: { ...baseOpenAiConfig, tools }, fetch }),
    );

    const tool = fetch.body.tools[0];
    assert.equal(tool.function.name, 'create_plan');
    assert.equal(tool.function.strict, true);
    assert.equal(tool.function.parameters.additionalProperties, false);
    assert.equal(tool.function.parameters.properties.tasks.minItems, 1);
    assert.equal(tool.function.parameters.properties.tasks.items.additionalProperties, false);
  });

  it('OpenAI SDK 归一化支持 top-level strict + input_schema 工具定义', async () => {
    const fetch = capturingFetch(() => ({
      ok: true,
      body: sseStream(['data: {"id":"1","choices":[{"index":0,"delta":{"content":"Hi"},"finish_reason":"stop"}]}\n\n']),
    }));

    await collectEvents(
      createLlmClient({
        config: {
          ...baseOpenAiConfig,
          tools: [{
            name: 'create_plan',
            description: 'Create plan',
            strict: true,
            input_schema: strictCreatePlanSchema,
          }],
        },
        fetch,
      }),
    );

    const tool = fetch.body.tools[0];
    assert.equal(tool.type, 'function');
    assert.equal(tool.function.strict, true);
    assert.deepEqual(tool.function.parameters.required, ['title', 'tasks', 'overallAcceptance']);
  });

  it('baseUrl 末尾斜杠规范化处理', async () => {
    const fetch = capturingFetch(() => ({
      ok: true,
      body: sseStream(['data: {"id":"1","choices":[{"index":0,"delta":{"content":"X"},"finish_reason":"stop"}]}\n\n']),
    }));

    await collectEvents(
      createLlmClient({ config: { ...baseOpenAiConfig, baseUrl: 'https://api.openai.com/v1/' }, fetch }),
    );

    assert.equal(fetch.url, 'https://api.openai.com/v1/chat/completions');
  });

  it('增量解析 text_delta 并累积 content', async () => {
    const fetch = capturingFetch(() => ({
      ok: true,
      body: sseStream([
        'data: {"id":"1","choices":[{"index":0,"delta":{"content":"Hello"}}]}\n\n',
        'data: {"id":"2","choices":[{"index":0,"delta":{"content":" World"}}]}\n\n',
        'data: {"id":"3","choices":[{"index":0,"delta":{"content":"!"},"finish_reason":"stop"}]}\n\n',
      ]),
    }));

    const events = await collectEvents(createLlmClient({ config: baseOpenAiConfig, fetch }));
    const texts = eventsOfType(events, 'text_delta');
    const content = texts.map((e) => e.content).join('');

    assert.equal(content, 'Hello World!');
    const done = events[events.length - 1];
    assert.equal(done.type, 'done');
    assert.equal(done.finishReason, 'stop');
  });

  it('跨 chunk 缓存未完成行（partial line buffering）', async () => {
    const fetch = capturingFetch(() => ({
      ok: true,
      body: sseStream([
        'data: {"id":"1","choices":[{"index":0,"delta":{"content":"Hel',
        'lo"}}]}\n\n',
        'data: {"id":"2","choices":[{"index":0,"delta":{"content":" World"},"finish_reason":"stop"}]}\n\n',
      ]),
    }));

    const events = await collectEvents(createLlmClient({ config: baseOpenAiConfig, fetch }));
    const texts = eventsOfType(events, 'text_delta');
    const content = texts.map((e) => e.content).join('');

    assert.equal(content, 'Hello World');
  });

  it('[DONE] 标记结束流', async () => {
    const fetch = capturingFetch(() => ({
      ok: true,
      body: sseStream([
        'data: {"id":"1","choices":[{"index":0,"delta":{"content":"Hi"}}]}\n\n',
        'data: [DONE]\n\n',
      ]),
    }));

    const events = await collectEvents(createLlmClient({ config: baseOpenAiConfig, fetch }));

    assert.equal(events[0].type, 'text_delta');
    assert.equal(events[events.length - 1].type, 'done');
  });

  it('finish_reason=length/content_filter 视为正常结束', async () => {
    for (const reason of ['length', 'content_filter']) {
      const fetch = capturingFetch(() => ({
        ok: true,
        body: sseStream([
          `data: {"id":"1","choices":[{"index":0,"delta":{"content":"x"},"finish_reason":"${reason}"}]}\n\n`,
        ]),
      }));

      const events = await collectEvents(createLlmClient({ config: baseOpenAiConfig, fetch }));
      const done = events.find((e) => e.type === 'done');
      assert.ok(done, `finish_reason=${reason} 应 yield done 事件`);
      assert.equal(done.finishReason, reason);
    }
  });

  it('解析 tool_calls 增量：index/id/name/arguments 拼接', async () => {
    const fetch = capturingFetch(() => ({
      ok: true,
      body: sseStream([
        'data: {"id":"1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_abc","type":"function","function":{"name":"read_file","arguments":""}}]}}]}\n\n',
        'data: {"id":"2","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"fil"}}]}}]}\n\n',
        'data: {"id":"3","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"ePath\\":\\"/src/main.js\\"}"}}]}}]}\n\n',
        'data: {"id":"4","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      ]),
    }));

    const events = await collectEvents(
      createLlmClient({ config: { ...baseOpenAiConfig, tools: sampleTools }, fetch }),
    );
    const toolCalls = eventsOfType(events, 'tool_call');

    assert.equal(toolCalls.length, 1);
    assert.equal(toolCalls[0].id, 'call_abc');
    assert.equal(toolCalls[0].name, 'read_file');
    assert.equal(toolCalls[0].arguments, '{"filePath":"/src/main.js"}');

    const done = events[events.length - 1];
    assert.equal(done.type, 'done');
    assert.equal(done.finishReason, 'tool_calls');
  });

  it('多工具并行调用：按 index 独立累积并全部 yield', async () => {
    const fetch = capturingFetch(() => ({
      ok: true,
      body: sseStream([
        'data: {"id":"1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read_file","arguments":""}},{"index":1,"id":"call_2","type":"function","function":{"name":"search_files","arguments":""}}]}}]}\n\n',
        'data: {"id":"2","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"p\\":1}"}},{"index":1,"function":{"arguments":"{\\"q\\":2}"}}]}}]}\n\n',
        'data: {"id":"3","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      ]),
    }));

    const events = await collectEvents(
      createLlmClient({ config: { ...baseOpenAiConfig, tools: sampleTools }, fetch }),
    );
    const toolCalls = eventsOfType(events, 'tool_call');

    assert.equal(toolCalls.length, 2);
    assert.equal(toolCalls[0].name, 'read_file');
    assert.equal(toolCalls[0].arguments, '{"p":1}');
    assert.equal(toolCalls[1].name, 'search_files');
    assert.equal(toolCalls[1].arguments, '{"q":2}');
  });

  it('HTTP 401/429/500 返回结构化 error 事件', async () => {
    for (const status of [401, 429, 500]) {
      const fetch = capturingFetch(() => ({
        ok: false,
        status,
        text: async () => `{"error":{"message":"error ${status}"}}`,
      }));

      const events = await collectEvents(createLlmClient({ config: baseOpenAiConfig, fetch }));

      assert.equal(events.length, 1);
      assert.equal(events[0].type, 'error');
      assert.equal(events[0].status, status);
    }
  });

  it('HTTP 错误无 text body 时回退到 status 消息', async () => {
    const fetch = capturingFetch(() => ({
      ok: false,
      status: 500,
      text: async () => '',
    }));

    const events = await collectEvents(createLlmClient({ config: baseOpenAiConfig, fetch }));

    assert.equal(events[0].type, 'error');
    assert.match(events[0].message, /500/);
  });

  it('网络异常（fetch reject）yield error 事件', async () => {
    const fetch = async () => {
      throw new Error('connection refused');
    };

    const events = await collectEvents(createLlmClient({ config: baseOpenAiConfig, fetch }));

    assert.equal(events[0].type, 'error');
    assert.equal(events[0].message, 'connection refused');
  });

  it('response.body 不可读时 yield error', async () => {
    const fetch = capturingFetch(() => ({ ok: true, body: null }));

    const events = await collectEvents(createLlmClient({ config: baseOpenAiConfig, fetch }));

    assert.equal(events[0].type, 'error');
    assert.match(events[0].message, /not readable/);
  });

  it('AbortController 中止后 yield aborted error', async () => {
    const controller = new AbortController();
    const fetch = abortableFetchStub();

    const eventsPromise = collectEvents(
      createLlmClient({ config: { ...baseOpenAiConfig, signal: controller.signal }, fetch }),
    );

    // 等 fetch 被调用并挂起
    await new Promise((r) => setImmediate(r));
    controller.abort();

    const events = await eventsPromise;
    const error = events.find((e) => e.type === 'error');
    assert.ok(error, '应 yield error 事件');
    assert.equal(error.aborted, true);
    assert.match(error.message, /aborted/);
  });

  it('signal 在调用前已中止时立即 yield aborted error', async () => {
    const controller = new AbortController();
    controller.abort();

    const fetch = abortableFetchStub();
    const events = await collectEvents(
      createLlmClient({ config: { ...baseOpenAiConfig, signal: controller.signal }, fetch }),
    );

    const error = events.find((e) => e.type === 'error');
    assert.ok(error);
    assert.equal(error.aborted, true);
  });

  it('temperature 为字符串时转为数字', async () => {
    const fetch = capturingFetch(() => ({
      ok: true,
      body: sseStream(['data: {"id":"1","choices":[{"index":0,"delta":{"content":"X"},"finish_reason":"stop"}]}\n\n']),
    }));

    await collectEvents(
      createLlmClient({ config: { ...baseOpenAiConfig, temperature: '0.7' }, fetch }),
    );

    assert.equal(fetch.body.temperature, 0.7);
  });

  it('temperature 为 null/undefined 时默认为 0.3', async () => {
    const fetch = capturingFetch(() => ({
      ok: true,
      body: sseStream(['data: {"id":"1","choices":[{"index":0,"delta":{"content":"X"},"finish_reason":"stop"}]}\n\n']),
    }));

    await collectEvents(
      createLlmClient({ config: { ...baseOpenAiConfig, temperature: undefined }, fetch }),
    );

    assert.equal(fetch.body.temperature, 0.3);
  });
});

/* ================================================================== Anthropic 协议 ================================================================== */

describe('createLlmClient Anthropic 协议', () => {
  it('构造请求体：model/messages/stream/max_tokens 字段正确', async () => {
    const fetch = capturingFetch(() => ({
      ok: true,
      body: sseStream([
        'event: message_start\ndata: {"type":"message_start","message":{"id":"m1","role":"assistant"}}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ]),
    }));

    await collectEvents(createLlmClient({ config: baseAnthropicConfig, fetch }));

    assert.equal(fetch.url, 'https://api.anthropic.com/messages');
    assert.equal(fetch.body.model, 'claude-sonnet-4-6');
    assert.equal(fetch.body.stream, true);
    assert.equal(fetch.body.max_tokens, 4096);
    assert.deepEqual(fetch.body.messages, [{ role: 'user', content: 'hello' }]);
    assert.equal(fetch.headers['Content-Type'], 'application/json');
    assert.equal(fetch.headers['x-api-key'], 'sk-ant-test-key');
    assert.equal(fetch.headers['anthropic-version'], '2023-06-01');
  });

  it('tools 非空时 Anthropic 请求体继续使用 input_schema', async () => {
    const fetch = capturingFetch(() => ({
      ok: true,
      body: sseStream([
        'event: message_start\ndata: {"type":"message_start","message":{"id":"m1","role":"assistant"}}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ]),
    }));
    const tools = [{
      name: 'create_plan',
      description: 'Create plan',
      input_schema: strictCreatePlanSchema,
    }];

    await collectEvents(createLlmClient({ config: { ...baseAnthropicConfig, tools }, fetch }));

    assert.equal(fetch.body.tools.length, 1);
    assert.equal(fetch.body.tools[0].name, 'create_plan');
    assert.equal(fetch.body.tools[0].function, undefined);
    assert.equal(fetch.body.tools[0].input_schema.additionalProperties, false);
    assert.equal(fetch.body.tools[0].input_schema.properties.tasks.items.additionalProperties, false);
  });

  it('增量解析 text_delta（content_block_delta type=text_delta）', async () => {
    const fetch = capturingFetch(() => ({
      ok: true,
      body: sseStream([
        'event: message_start\ndata: {"type":"message_start","message":{"id":"m1","role":"assistant"}}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" World"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ]),
    }));

    const events = await collectEvents(createLlmClient({ config: baseAnthropicConfig, fetch }));
    const texts = eventsOfType(events, 'text_delta');
    const content = texts.map((e) => e.content).join('');

    assert.equal(content, 'Hello World');
    assert.equal(events[events.length - 1].type, 'done');
  });

  it('解析 tool_use：content_block_start + input_json_delta 增量拼接', async () => {
    const fetch = capturingFetch(() => ({
      ok: true,
      body: sseStream([
        'event: message_start\ndata: {"type":"message_start","message":{"id":"m1","role":"assistant"}}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_01","name":"read_file","input":{}}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"filePath\\":\\""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"/src/main.js\\"}"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ]),
    }));

    const events = await collectEvents(
      createLlmClient({ config: { ...baseAnthropicConfig, tools: sampleTools }, fetch }),
    );
    const toolCalls = eventsOfType(events, 'tool_call');

    assert.equal(toolCalls.length, 1);
    assert.equal(toolCalls[0].id, 'toolu_01');
    assert.equal(toolCalls[0].name, 'read_file');
    assert.equal(toolCalls[0].arguments, '{"filePath":"/src/main.js"}');
  });

  it('message_stop 结束流并 yield 累积的 tool_calls', async () => {
    const fetch = capturingFetch(() => ({
      ok: true,
      body: sseStream([
        'event: message_start\ndata: {"type":"message_start","message":{"id":"m1","role":"assistant"}}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_x","name":"search_files","input":{}}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{}"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ]),
    }));

    const events = await collectEvents(
      createLlmClient({ config: { ...baseAnthropicConfig, tools: sampleTools }, fetch }),
    );
    const toolCalls = eventsOfType(events, 'tool_call');
    const done = events.find((e) => e.type === 'done');

    assert.equal(toolCalls.length, 1);
    assert.ok(done, 'message_stop 后应 yield done');
  });

  it('error 事件（Anthropic API 返回）yield error', async () => {
    const fetch = capturingFetch(() => ({
      ok: true,
      body: sseStream([
        'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n',
      ]),
    }));

    const events = await collectEvents(createLlmClient({ config: baseAnthropicConfig, fetch }));

    assert.equal(events[0].type, 'error');
    assert.equal(events[0].message, 'Overloaded');
  });

  it('error 事件无 message 时回退到默认文本', async () => {
    const fetch = capturingFetch(() => ({
      ok: true,
      body: sseStream([
        'event: error\ndata: {"type":"error","error":{}}\n\n',
      ]),
    }));

    const events = await collectEvents(createLlmClient({ config: baseAnthropicConfig, fetch }));

    assert.equal(events[0].type, 'error');
    assert.match(events[0].message, /Anthropic API error/);
  });

  it('HTTP 401/429/500 返回结构化 error 事件', async () => {
    for (const status of [401, 429, 500]) {
      const fetch = capturingFetch(() => ({
        ok: false,
        status,
        text: async () => `{"error":{"message":"anthropic error ${status}"}}`,
      }));

      const events = await collectEvents(createLlmClient({ config: baseAnthropicConfig, fetch }));

      assert.equal(events.length, 1);
      assert.equal(events[0].type, 'error');
      assert.equal(events[0].status, status);
    }
  });

  it('网络异常（fetch reject）yield error 事件', async () => {
    const fetch = async () => {
      throw new Error('connection refused');
    };

    const events = await collectEvents(createLlmClient({ config: baseAnthropicConfig, fetch }));

    assert.equal(events[0].type, 'error');
    assert.equal(events[0].message, 'connection refused');
  });

  it('AbortController 中止后 yield aborted error', async () => {
    const controller = new AbortController();
    const fetch = abortableFetchStub();

    const eventsPromise = collectEvents(
      createLlmClient({ config: { ...baseAnthropicConfig, signal: controller.signal }, fetch }),
    );

    await new Promise((r) => setImmediate(r));
    controller.abort();

    const events = await eventsPromise;
    const error = events.find((e) => e.type === 'error');
    assert.ok(error);
    assert.equal(error.aborted, true);
  });

  it('Anthropic SSE 流中混合 text 和 tool_use 交替出现', async () => {
    const fetch = capturingFetch(() => ({
      ok: true,
      body: sseStream([
        'event: message_start\ndata: {"type":"message_start","message":{"id":"m1","role":"assistant"}}\n\n',
        // text block
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Let me read that file."}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
        // tool_use block
        'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_02","name":"read_file","input":{}}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"filePath\\":\\"/src/a.js\\"}"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ]),
    }));

    const events = await collectEvents(
      createLlmClient({ config: { ...baseAnthropicConfig, tools: sampleTools }, fetch }),
    );

    const texts = eventsOfType(events, 'text_delta');
    const toolCalls = eventsOfType(events, 'tool_call');

    assert.equal(texts.length, 1);
    assert.equal(texts[0].content, 'Let me read that file.');
    assert.equal(toolCalls.length, 1);
    assert.equal(toolCalls[0].name, 'read_file');
  });
});
