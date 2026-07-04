'use strict';

/**
 * LLM 客户端（需求 #26 / #28）：OpenAI 兼容协议 + Anthropic Messages 协议的流式请求。
 *
 * 变更（需求 #28）：
 * - OpenAI 兼容路径（含 DeepSeek）引入 openai npm 包（v4），替代手写 fetch SSE 解析
 * - 支持 reasoning_effort / thinking_depth 思考深度参数
 * - Anthropic 路径保持 fetch + SSE，增加 thinking 扩展参数
 * - 流式事件新增 thinking_start / thinking_delta / thinking_end
 *
 * yield 事件类型：
 * - {type:'thinking_start'}                       推理开始
 * - {type:'thinking_delta', content:string}        推理增量文本
 * - {type:'thinking_end'}                         推理结束，后续为正式回复
 * - {type:'text_delta', content:string}            增量文本
 * - {type:'tool_call', id:string, name:string, arguments:string} 工具调用（已完整拼接）
 * - {type:'done', finishReason?:string}            流结束
 * - {type:'error', message:string, status?:number, aborted?:boolean} 错误
 */

const OpenAI = require('openai').OpenAI;

/**
 * @param {object} opts
 * @param {object} opts.config
 * @param {'openai'|'deepseek'|'anthropic'} opts.config.provider
 * @param {string} opts.config.baseUrl
 * @param {string} opts.config.apiKey
 * @param {string} opts.config.model
 * @param {number|string} opts.config.temperature
 * @param {Array<{role:string,content:string|Array}>} opts.config.messages
 * @param {Array<object>} [opts.config.tools]
 * @param {object|string} [opts.config.toolChoice] - OpenAI/Anthropic 工具选择透传
 * @param {AbortSignal} [opts.config.signal]
 * @param {string} [opts.config.thinkingDepth] - 'low'|'medium'|'high'（OpenAI o-series / DeepSeek 推理模型）
 * @param {number} [opts.config.thinkingBudgetTokens] - Anthropic 扩展思考 token 预算
 * @param {Function} [opts.fetch] - 可注入 fetch（默认 globalThis.fetch）
 * @yields {{type:string}}
 */
async function* createLlmClient({ config, fetch: injectedFetch }) {
  const fetchFn = injectedFetch || globalThis.fetch;
  const {
    provider,
    baseUrl,
    apiKey,
    model,
    temperature,
    messages,
    tools,
    toolChoice,
    tool_choice: snakeToolChoice,
    signal,
    thinkingDepth,
    thinkingBudgetTokens,
  } = config;
  const effectiveToolChoice = toolChoice ?? snakeToolChoice;

  const temp = temperature != null ? Number(temperature) : 0.3;

  if (provider === 'anthropic') {
    yield* streamAnthropic({
      fetchFn,
      baseUrl,
      apiKey,
      model,
      temperature: temp,
      messages,
      tools,
      toolChoice: effectiveToolChoice,
      signal,
      thinkingBudgetTokens,
    });
  } else {
    yield* streamOpenAiCompat({
      fetchFn,
      baseUrl,
      apiKey,
      model,
      temperature: temp,
      messages,
      tools,
      toolChoice: effectiveToolChoice,
      signal,
      thinkingDepth,
    });
  }
}

/* ------------------------------------------------------------------ OpenAI 兼容协议（openai SDK）------------------------------------------------------------------ */

async function* streamOpenAiCompat({
  fetchFn,
  baseUrl,
  apiKey,
  model,
  temperature,
  messages,
  tools,
  toolChoice,
  signal,
  thinkingDepth,
}) {
  const client = new OpenAI({
    baseURL: baseUrl.replace(/\/+$/, ''),
    apiKey: apiKey || 'sk-placeholder',
    dangerouslyAllowBrowser: true,
    fetch: fetchFn,
  });

  /** @type {import('openai').Chat.Completions.ChatCompletionCreateParams} */
  const params = {
    model,
    messages,
    stream: true,
    stream_options: { include_usage: false },
  };
  if (Number.isFinite(temperature)) params.temperature = temperature;
  if (tools && tools.length > 0) {
    params.tools = tools.map(normalizeToolForOpenAiSdk);
  }
  if (toolChoice !== undefined && toolChoice !== null) {
    params.tool_choice = toolChoice;
  }
  if (thinkingDepth) {
    params.reasoning_effort = thinkingDepth;
  }

  let stream;
  try {
    // @ts-ignore - reasoning_effort 非官方类型但在实际请求体中有效
    stream = await client.chat.completions.create(params, { signal });
  } catch (error) {
    yield errorEvent(error);
    return;
  }

  const toolCalls = {}; // keyed by index
  let inThinking = false;

  try {
    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta;
      if (!delta) continue;

      // reasoning_content（DeepSeek R1 等推理模型的思考内容）
      const reasoningContent = delta.reasoning_content;
      if (reasoningContent) {
        if (!inThinking) {
          inThinking = true;
          yield { type: 'thinking_start' };
        }
        yield { type: 'thinking_delta', content: reasoningContent };
      }

      // 正式文本内容
      if (delta.content) {
        if (inThinking) {
          inThinking = false;
          yield { type: 'thinking_end' };
        }
        yield { type: 'text_delta', content: delta.content };
      }

      // 工具调用增量拼接
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          if (!toolCalls[idx]) {
            toolCalls[idx] = { id: '', name: '', arguments: '' };
          }
          if (tc.id) toolCalls[idx].id = tc.id;
          if (tc.function?.name) toolCalls[idx].name += tc.function.name;
          if (tc.function?.arguments) toolCalls[idx].arguments += tc.function.arguments;
        }
      }

      const finishReason = chunk.choices?.[0]?.finish_reason;
      if (finishReason === 'stop' || finishReason === 'length' || finishReason === 'content_filter') {
        if (inThinking) {
          inThinking = false;
          yield { type: 'thinking_end' };
        }
        yield { type: 'done', finishReason };
        return;
      }
      if (finishReason === 'tool_calls') {
        if (inThinking) {
          inThinking = false;
          yield { type: 'thinking_end' };
        }
        for (const tc of Object.values(toolCalls).filter(Boolean)) {
          yield { type: 'tool_call', id: tc.id, name: tc.name, arguments: tc.arguments };
        }
        yield { type: 'done', finishReason: 'tool_calls' };
        return;
      }
    }

    if (inThinking) {
      yield { type: 'thinking_end' };
    }
    yield { type: 'done' };
  } catch (error) {
    yield errorEvent(error);
  } finally {
    try {
      // @ts-ignore - controller 为 SDK 内部属性，用于释放连接
      stream?.controller?.abort();
    } catch {
      /* 清理失败不阻塞 */
    }
  }
}

/* ------------------------------------------------------------------ Anthropic Messages 协议（fetch + SSE）------------------------------------------------------------------ */

async function* streamAnthropic({
  fetchFn,
  baseUrl,
  apiKey,
  model,
  temperature,
  messages,
  tools,
  toolChoice,
  signal,
  thinkingBudgetTokens,
}) {
  const url = `${baseUrl.replace(/\/+$/, '')}/messages`;
  const body = buildAnthropicBody({ model, messages, temperature, tools, toolChoice, thinkingBudgetTokens });

  let response;
  try {
    response = await fetchFn(url, {
      method: 'POST',
      headers: buildAnthropicHeaders(apiKey),
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    yield errorEvent(error);
    return;
  }

  if (!response.ok) {
    const errorBody = await readTextSafe(response);
    yield { type: 'error', message: errorBody || `HTTP ${response.status}`, status: response.status };
    return;
  }

  const reader = response.body?.getReader();
  if (!reader) {
    yield { type: 'error', message: 'response body is not readable' };
    return;
  }

  const decoder = new TextDecoder();
  let buffer = '';
  const toolCalls = {}; // keyed by content_block index
  let inThinking = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();

        if (!trimmed) continue;

        if (trimmed.startsWith('event:')) {
          continue;
        }

        if (!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        const parsed = parseJsonSafe(data);
        if (!parsed) continue;

        switch (parsed.type) {
          case 'message_start':
            break;

          case 'content_block_start': {
            const block = parsed.content_block;
            if (block?.type === 'thinking') {
              inThinking = true;
              yield { type: 'thinking_start' };
            } else if (block?.type === 'tool_use') {
              if (inThinking) {
                inThinking = false;
                yield { type: 'thinking_end' };
              }
              const idx = parsed.index ?? 0;
              toolCalls[idx] = { id: block.id || '', name: block.name || '', arguments: '' };
            } else if (block?.type === 'text') {
              if (inThinking) {
                inThinking = false;
                yield { type: 'thinking_end' };
              }
            }
            break;
          }

          case 'content_block_delta': {
            const delta = parsed.delta;
            if (delta?.type === 'thinking_delta' && delta.thinking) {
              yield { type: 'thinking_delta', content: delta.thinking };
            } else if (delta?.type === 'signature_delta') {
              // 思考签名（不展示给用户）
            } else if (delta?.type === 'text_delta' && delta.text) {
              yield { type: 'text_delta', content: delta.text };
            } else if (delta?.type === 'input_json_delta') {
              const idx = parsed.index ?? 0;
              if (toolCalls[idx]) {
                toolCalls[idx].arguments += delta.partial_json || '';
              }
            }
            break;
          }

          case 'content_block_stop':
            break;

          case 'message_delta':
            break;

          case 'message_stop': {
            if (inThinking) {
              inThinking = false;
              yield { type: 'thinking_end' };
            }
            for (const tc of Object.values(toolCalls).filter(Boolean)) {
              yield { type: 'tool_call', id: tc.id, name: tc.name, arguments: tc.arguments };
            }
            yield { type: 'done' };
            return;
          }

          case 'error': {
            const msg = parsed.error?.message || 'Anthropic API error';
            yield { type: 'error', message: msg };
            return;
          }

          default:
            break;
        }
      }
    }

    if (inThinking) {
      yield { type: 'thinking_end' };
    }
    yield { type: 'done' };
  } catch (error) {
    yield errorEvent(error);
  } finally {
    try {
      reader.cancel();
    } catch {
      /* cancel 失败不阻塞 */
    }
  }
}

/* ------------------------------------------------------------------ 请求构造 ------------------------------------------------------------------ */

/**
 * 为 OpenAI SDK 规范化工具定义格式。
 * SDK 期望 tools 数组中每项含 type: 'function' 和 function: { name, description, parameters }。
 */
function normalizeToolForOpenAiSdk(tool) {
  if (tool.type === 'function' && tool.function) {
    const fn = { ...tool.function };
    if (tool.strict === true && fn.strict !== true) fn.strict = true;
    return { type: 'function', function: fn };
  }
  const fn = {
    name: tool.name,
    description: tool.description,
    parameters: tool.input_schema || tool.parameters,
  };
  if (tool.strict === true) fn.strict = true;
  return {
    type: 'function',
    function: fn,
  };
}

function buildAnthropicBody({ model, messages, temperature, tools, toolChoice, thinkingBudgetTokens }) {
  const thinkingEnabled = thinkingBudgetTokens != null && Number(thinkingBudgetTokens) > 0;
  const body = {
    model,
    messages,
    max_tokens: thinkingEnabled ? Math.max(Number(thinkingBudgetTokens) + 4096, 8192) : 4096,
    stream: true,
  };
  if (Number.isFinite(temperature)) body.temperature = temperature;
  if (tools && tools.length > 0) body.tools = tools;
  if (toolChoice !== undefined && toolChoice !== null) body.tool_choice = toolChoice;

  // Anthropic 扩展思考（需求 #28）
  if (thinkingEnabled) {
    body.thinking = {
      type: 'enabled',
      budget_tokens: Number(thinkingBudgetTokens),
    };
  }

  return body;
}

function buildAnthropicHeaders(apiKey) {
  return {
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
  };
}

/* ------------------------------------------------------------------ 工具函数 ------------------------------------------------------------------ */

function errorEvent(error) {
  if (error?.name === 'AbortError') {
    return { type: 'error', message: 'aborted', aborted: true };
  }
  return { type: 'error', message: error?.message || 'network error' };
}

async function readTextSafe(response) {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

function parseJsonSafe(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

module.exports = { createLlmClient };
