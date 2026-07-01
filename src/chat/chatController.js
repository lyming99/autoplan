'use strict';

/**
 * Chat Agent Loop 编排（需求 #26 / #28）：多轮对话编排，LLM 调用 → 工具执行 → 回灌 → 下一轮。
 *
 * 职责：
 * - 管理对话状态与 chat_messages 持久化（按 conversation_id 隔离）
 * - 构建 LLM messages 数组（最近 20 条，≈2000 token 预算）
 * - Agent loop：最多 8 轮，工具调用逐条执行后回灌
 * - stop() 中止、超时（120s）、错误处理
 * - 事件推送 via onEvent/onDone 回调
 * - AI 配置通过 conversation → ai_config → 项目默认 → 内置默认 链路解析
 */

const { nowIso } = require('../database');
const { resolveAiConfigForConversation } = require('./aiConfigService');

const MAX_ROUNDS = 8;
const MAX_MESSAGES = 20;

/**
 * @param {object} deps
 * @param {object} deps.db
 * @param {Function} deps.llmClient - createLlmClient({ config, fetch }?) async generator
 * @param {Array} deps.chatTools - getChatToolDefinitions() 返回的工具定义列表
 * @param {number} deps.conversationId
 * @param {number} deps.projectId
 * @param {string} deps.workspacePath
 * @param {Function} deps.onEvent - ({type, data}) => void
 * @param {Function} deps.onDone - ({status, error?}) => void
 * @returns {{send:Function, stop:Function, getHistory:Function, clearHistory:Function, getConfig:Function, isActive:Function}}
 */
function createChatController({ db, llmClient, chatTools, conversationId, projectId, workspacePath, onEvent, onDone }) {
  const noop = () => {};
  const emitEvent = onEvent || noop;
  const emitDone = onDone || noop;

  let abortController = null;
  let active = false;
  let currentRound = 0;

  // 懒加载：首次 getConfig() 时解析并缓存
  let cachedAiConfig = null;

  /**
   * 发送用户消息，启动 agent loop（不等待结束）。
   * @param {string} message
   */
  function send(message) {
    const text = String(message || '').trim();
    if (!text) return;
    if (active) return; // 已在进行中，忽略重复发送

    active = true;
    currentRound = 0;
    abortController = new AbortController();

    // 持久化用户消息（含 conversation_id）
    storeMessage(db, conversationId, projectId, 'user', text, null, null, 'done');

    // 异步启动 agent loop
    runAgentLoop(text).catch((error) => {
      if (error?.name === 'AbortError') {
        emitDone({ status: 'aborted' });
      } else {
        emitDone({ status: 'error', error: error?.message || 'unknown error' });
        storeMessage(db, conversationId, projectId, 'system', `错误：${error?.message || 'unknown error'}`, null, null, 'error');
      }
    }).finally(() => {
      active = false;
      abortController = null;
    });
  }

  /**
   * 中止当前生成。
   */
  function stop() {
    if (!active || !abortController) return;
    try {
      abortController.abort();
    } catch {
      /* 中止失败不阻塞 */
    }
    markLastAssistantAborted(db, conversationId);
  }

  /**
   * 获取当前对话的历史消息。
   */
  function getHistory() {
    return db.all(
      'SELECT * FROM chat_messages WHERE conversation_id = ? ORDER BY created_at ASC, id ASC',
      [conversationId],
    );
  }

  /**
   * 清空当前对话的历史。
   */
  function clearHistory() {
    db.run('DELETE FROM chat_messages WHERE conversation_id = ?', [conversationId]);
  }

  /**
   * 读取当前对话的 AI 配置（通过 conversation 解析链路）。
   */
  function getConfig() {
    if (cachedAiConfig) return cachedAiConfig;

    const conversation = db.get('SELECT * FROM conversations WHERE id = ?', [conversationId]);
    const resolved = resolveAiConfigForConversation(db, conversation || { project_id: projectId });
    cachedAiConfig = {
      provider: resolved.provider,
      baseUrl: resolved.baseUrl,
      apiKey: resolved.apiKey,
      model: resolved.model,
      temperature: resolved.temperature,
      thinkingDepth: resolved.thinkingDepth,
      thinkingBudgetTokens: resolved.thinkingBudgetTokens,
    };
    return cachedAiConfig;
  }

  function isActive() {
    return active;
  }

  /* ------------------------------------------------------------------ Agent Loop ------------------------------------------------------------------ */

  async function runAgentLoop(userMessage) {
    const config = getConfig();

    if (!config.apiKey) {
      emitDone({ status: 'error', error: '未配置 API Key，请在设置 AI 面板中配置 LLM 接口。' });
      storeMessage(db, conversationId, projectId, 'system', '未配置 API Key，请在设置 AI 面板中配置 LLM 接口。', null, null, 'error');
      return;
    }

    // 构建初始 messages（按 conversation_id）
    let messages = buildMessages(db, conversationId, config.provider);
    const tools = formatToolsForProvider(chatTools, config.provider);

    for (let round = 0; round < MAX_ROUNDS; round += 1) {
      if (!active) return;

      currentRound = round + 1;
      emitEvent({ type: 'status', data: { status: `第 ${currentRound}/${MAX_ROUNDS} 轮` } });

      const llmResult = await callLlm(llmClient, config, messages, tools, abortController.signal);

      if (llmResult.error) {
        if (llmResult.aborted) {
          emitDone({ status: 'aborted' });
        } else {
          emitDone({ status: 'error', error: llmResult.error });
          storeMessage(db, conversationId, projectId, 'system', `LLM 调用失败：${llmResult.error}`, null, null, 'error');
        }
        return;
      }

      const { content, toolCalls } = llmResult;

      // 持久化 assistant 消息
      const toolCallsJson =
        toolCalls.length > 0
          ? JSON.stringify(
              toolCalls.map((tc) => ({
                id: tc.id,
                type: 'function',
                function: { name: tc.name, arguments: tc.arguments },
              })),
            )
          : null;
      storeMessage(db, conversationId, projectId, 'assistant', content, toolCallsJson, null, 'done');

      // 纯文本回复 → 结束
      if (toolCalls.length === 0) {
        emitDone({ status: 'done' });
        return;
      }

      // 有工具调用 → 执行工具
      messages.push(buildAssistantMessage(content, toolCalls, config.provider));

      for (const tc of toolCalls) {
        if (!active) return;

        const toolDef = chatTools.find((t) => t.name === tc.name);
        const result = await executeTool(toolDef, tc, db, conversationId, projectId);
        messages.push(buildToolResultMessage(tc, result, config.provider));
      }
    }

    // 达到最大轮次
    emitDone({ status: 'max_rounds' });
    storeMessage(
      db,
      conversationId,
      projectId,
      'system',
      `已达到最大对话轮次（${MAX_ROUNDS}），对话自动终止。`,
      null,
      null,
      'error',
    );
  }

  /* ------------------------------------------------------------------ LLM 调用 ------------------------------------------------------------------ */

  async function callLlm(llmClientFn, config, messages, tools, signal) {
    let content = '';
    const toolCalls = [];
    let hasError = false;
    let errorMessage = '';
    let aborted = false;

    try {
      const stream = llmClientFn({
        config: {
          provider: config.provider,
          baseUrl: config.baseUrl,
          apiKey: config.apiKey,
          model: config.model,
          temperature: Number(config.temperature ?? 0.3),
          messages,
          tools: tools.length > 0 ? tools : undefined,
          signal,
          thinkingDepth: config.thinkingDepth,
          thinkingBudgetTokens: config.thinkingBudgetTokens,
        },
      });

      for await (const event of stream) {
        if (!active) break;

        switch (event.type) {
          case 'thinking_start':
            emitEvent({ type: 'thinking_start', data: {} });
            break;

          case 'thinking_delta':
            emitEvent({ type: 'thinking_delta', data: { content: event.content } });
            break;

          case 'thinking_end':
            emitEvent({ type: 'thinking_end', data: {} });
            break;

          case 'text_delta': {
            content += event.content;
            emitEvent({ type: 'chunk', data: { content: event.content } });
            break;
          }

          case 'tool_call': {
            const tc = {
              id: event.id || '',
              name: event.name || '',
              arguments: event.arguments || '{}',
            };
            toolCalls.push(tc);

            let args;
            try {
              args = JSON.parse(tc.arguments);
            } catch {
              args = {};
            }
            emitEvent({ type: 'tool_start', data: { name: tc.name, args } });
            break;
          }

          case 'error': {
            hasError = true;
            errorMessage = event.message || 'LLM error';
            aborted = event.aborted === true;
            emitEvent({ type: 'error', data: { message: errorMessage } });
            break;
          }

          case 'done':
            break;

          default:
            break;
        }
      }
    } catch (error) {
      hasError = true;
      errorMessage = error?.message || 'LLM request failed';
      if (error?.name === 'AbortError') {
        aborted = true;
      }
    }

    return { content, toolCalls, error: hasError ? errorMessage : null, aborted };
  }

  /* ------------------------------------------------------------------ 工具执行 ------------------------------------------------------------------ */

  async function executeTool(toolDef, toolCall, dbParam, cId, pId) {
    const name = toolCall.name;
    const toolCallId = toolCall.id;

    if (!toolDef) {
      const errResult = { error: `未知工具：${name}`, errorCode: 'UNKNOWN_TOOL' };
      const errStr = JSON.stringify(errResult);
      storeMessage(dbParam, cId, pId, 'tool', errStr, null, { tool_call_id: toolCallId, name }, 'done');
      emitEvent({ type: 'tool_result', data: { name, tool_call_id: toolCallId, result: errResult } });
      return errResult;
    }

    emitEvent({ type: 'status', data: { status: `执行工具：${name}` } });

    let args;
    try {
      args = JSON.parse(toolCall.arguments);
    } catch {
      args = {};
    }

    let result;
    try {
      result = await toolDef.handler(args);
    } catch (err) {
      result = { error: `工具执行异常：${err.message}`, errorCode: 'TOOL_EXECUTION_ERROR' };
    }

    const resultStr = JSON.stringify(result);
    storeMessage(
      dbParam,
      cId,
      pId,
      'tool',
      typeof result?.content === 'string' ? result.content : resultStr,
      null,
      { tool_call_id: toolCallId, name, result },
      'done',
    );

    emitEvent({ type: 'tool_result', data: { name, tool_call_id: toolCallId, result } });

    return result;
  }

  return { send, stop, getHistory, clearHistory, getConfig, isActive };
}

/* ------------------------------------------------------------------ 消息持久化 ------------------------------------------------------------------ */

function storeMessage(db, conversationId, projectId, role, content, toolCalls, toolResult, status) {
  db.run(
    `INSERT INTO chat_messages (project_id, conversation_id, role, content, tool_calls, tool_result, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      projectId,
      conversationId,
      role,
      content || '',
      toolCalls || null,
      toolResult ? JSON.stringify(toolResult) : null,
      status || 'done',
      nowIso(),
    ],
  );
}

function markLastAssistantAborted(db, conversationId) {
  const last = db.get(
    `SELECT id FROM chat_messages
     WHERE conversation_id = ? AND role = 'assistant' AND status = 'done'
     ORDER BY id DESC LIMIT 1`,
    [conversationId],
  );
  if (last) {
    db.run('UPDATE chat_messages SET status = ? WHERE id = ?', ['aborted', last.id]);
  }
}

/* ------------------------------------------------------------------ 消息构建 ------------------------------------------------------------------ */

/**
 * 从 chat_messages 构建 LLM messages 数组（按 conversation_id）。
 * 取最近 MAX_MESSAGES 条已完成的非系统消息（排除 streaming 状态）。
 */
function buildMessages(db, conversationId, provider) {
  const rows = db.all(
    `SELECT * FROM chat_messages
     WHERE conversation_id = ?
     ORDER BY created_at ASC, id ASC`,
    [conversationId],
  );

  const completed = rows.filter((row) => {
    if (row.status === 'streaming') return false;
    return true;
  });

  const recent = completed.slice(-MAX_MESSAGES);

  const messages = [];
  for (const row of recent) {
    switch (row.role) {
      case 'user':
        messages.push({ role: 'user', content: row.content });
        break;

      case 'assistant': {
        const entry = { role: 'assistant', content: row.content || '' };
        if (row.tool_calls) {
          try {
            entry.tool_calls = JSON.parse(row.tool_calls);
          } catch {
            // 解析失败，跳过 tool_calls
          }
        }
        messages.push(entry);
        break;
      }

      case 'tool': {
        const tr = parseToolResult(row.tool_result);
        messages.push({
          role: 'tool',
          content: row.content,
          tool_call_id: tr?.tool_call_id || '',
        });
        break;
      }

      case 'system':
        messages.push({ role: 'system', content: row.content });
        break;

      default:
        messages.push({ role: 'user', content: row.content });
        break;
    }
  }

  return messages;
}

function parseToolResult(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function buildAssistantMessage(content, toolCalls, provider) {
  const openAiToolCalls = toolCalls.map((tc) => ({
    id: tc.id,
    type: 'function',
    function: { name: tc.name, arguments: tc.arguments },
  }));

  return {
    role: 'assistant',
    content: content || null,
    tool_calls: openAiToolCalls,
  };
}

function buildToolResultMessage(toolCall, result, provider) {
  return {
    role: 'tool',
    content: JSON.stringify(result),
    tool_call_id: toolCall.id,
  };
}

/* ------------------------------------------------------------------ 工具格式化 ------------------------------------------------------------------ */

function formatToolsForProvider(tools, provider) {
  if (provider === 'anthropic') {
    return tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema,
    }));
  }
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    },
  }));
}

/* ------------------------------------------------------------------ 对话 CRUD（需求 #28）------------------------------------------------------------------ */

/**
 * 创建新对话。
 * @param {object} db
 * @param {object} params
 * @param {number} params.projectId
 * @param {string} [params.title] - 对话标题，默认空字符串（首条消息到达后可由 UI 层更新）
 * @param {number} [params.aiConfigId] - 可选绑定 AI 配置
 * @returns {object} 创建的对话记录
 */
function createConversation(db, { projectId, title, aiConfigId }) {
  if (!projectId) throw new Error('projectId 不能为空');
  const now = nowIso();
  const id = db.insert(
    'INSERT INTO conversations (project_id, title, ai_config_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    [projectId, String(title || '').trim(), aiConfigId || null, now, now],
  );
  return db.get('SELECT * FROM conversations WHERE id = ?', [id]);
}

/**
 * 列出项目的所有对话（按最近活跃排序）。
 */
function listConversations(db, projectId) {
  return db.all(
    'SELECT id, project_id, title, ai_config_id, created_at, updated_at FROM conversations WHERE project_id = ? ORDER BY updated_at DESC, id DESC',
    [projectId],
  );
}

/**
 * 更新对话。
 */
function updateConversation(db, id, fields = {}) {
  const existing = db.get('SELECT * FROM conversations WHERE id = ?', [id]);
  if (!existing) throw new Error('对话不存在');

  const now = nowIso();
  db.run(
    'UPDATE conversations SET title = ?, ai_config_id = ?, updated_at = ? WHERE id = ?',
    [
      fields.title !== undefined ? String(fields.title).trim() : existing.title,
      fields.aiConfigId !== undefined ? (fields.aiConfigId || null) : existing.ai_config_id,
      now,
      id,
    ],
  );
  return db.get('SELECT * FROM conversations WHERE id = ?', [id]);
}

/**
 * 删除对话（级联删除关联的 chat_messages）。
 */
function deleteConversation(db, id) {
  const existing = db.get('SELECT id FROM conversations WHERE id = ?', [id]);
  if (!existing) throw new Error('对话不存在');

  db.run('DELETE FROM chat_messages WHERE conversation_id = ?', [id]);
  db.run('DELETE FROM conversations WHERE id = ?', [id]);
  return { deleted: true, id };
}

/**
 * 确保项目存在一个默认对话（向后兼容：现有 chat:send 未传 conversationId 时自动使用）。
 */
function ensureDefaultConversation(db, projectId) {
  const existing = db.get(
    'SELECT id FROM conversations WHERE project_id = ? ORDER BY id ASC LIMIT 1',
    [projectId],
  );
  if (existing) return existing.id;

  return createConversation(db, { projectId, title: '默认对话' }).id;
}

module.exports = {
  createChatController,
  createConversation,
  listConversations,
  updateConversation,
  deleteConversation,
  ensureDefaultConversation,
};
