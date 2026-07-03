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
 * - AI 配置通过 conversation → 全局 ai_config → 内置默认 链路解析
 */

const { nowIso } = require('../database');
const { resolveAiConfigForConversation } = require('./aiConfigService');
const { createChatQueue } = require('./chatQueue');

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
 * @param {Function} deps.onDone - ({status, error?, conversationId?, title?}) => void
 * @returns {{send:Function, stop:Function, getHistory:Function, clearHistory:Function, getConfig:Function, invalidateConfig:Function, isActive:Function}}
 */
function createChatController({ db, llmClient, chatTools, conversationId, projectId, workspacePath, onEvent, onDone, onQueue }) {
  conversationId = normalizeRequiredId(conversationId, 'conversationId');
  projectId = normalizeRequiredId(projectId, 'projectId');
  requireConversationForProject(db, conversationId, projectId);

  const noop = () => {};
  const emitEvent = onEvent || noop;
  const emitDone = onDone || noop;

  // 会话级消息队列（需求 #37）：快照优先走主进程专用通道（onQueue → chat:queue），否则回退 queue_update 事件
  const emitQueue = (snap) => (typeof onQueue === 'function' ? onQueue(snap) : emitEvent({ type: 'queue_update', data: snap }));
  const queue = createChatQueue({ db, conversationId, projectId, emit: emitQueue });

  let abortController = null;
  let active = false;
  let currentRound = 0;

  // 懒加载：首次 getConfig() 时解析并缓存
  let cachedAiConfig = null;

  /**
   * 发送用户消息：入队（status='queued'）后尝试派发；生成中再次发送改为排队（不再丢弃）。
   * @returns {{id:number, content:string, state:string}|null} 入队项（含 chat_messages 行 id），空串为 null
   */
  function send(message) {
    const enqueued = queue.enqueue(message);
    if (!enqueued) return null;
    pump();
    return enqueued;
  }

  /**
   * 顺序派发：空闲且有排队项时取队首、置处理中（库内行翻为 done 进入上下文）并启动 agent loop；
   * 由 send 与 finishGeneration 调用，上一条结束（done/aborted/error/max_rounds）后立即续跑下一条。
   */
  function pump() {
    if (active || !queue.hasQueued()) return;
    const item = queue.peekNext();
    if (!item) return;
    queue.markProcessing(item.id);
    active = true;
    currentRound = 0;
    abortController = new AbortController();
    runAgentLoop(item.content).catch((error) => {
      if (error?.name === 'AbortError') return finishGeneration({ status: 'aborted' });
      finishGeneration({ status: 'error', error: error?.message || 'unknown error' });
      storeMessage(db, conversationId, projectId, 'system', `错误：${error?.message || 'unknown error'}`, null, null, 'error');
    });
  }

  /** 恢复历史排队（刷新/重启后）：从库内 status='queued' 行重建 FIFO 并尝试派发；主进程创建 controller 后调用。 */
  function resumeQueue() {
    queue.loadPersisted();
    pump();
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
    markLastAssistantAborted(db, conversationId, projectId);
  }

  /**
   * 获取当前对话的历史消息。
   */
  function getHistory() {
    return db.all(
      `SELECT * FROM chat_messages
       WHERE conversation_id = ? AND project_id = ?
       ORDER BY created_at ASC, id ASC`,
      [conversationId, projectId],
    );
  }

  /**
   * 清空当前对话的历史。
   */
  function clearHistory() {
    db.run('DELETE FROM chat_messages WHERE conversation_id = ? AND project_id = ?', [conversationId, projectId]);
  }

  /**
   * 读取当前对话的 AI 配置（通过 conversation 解析链路）。
   */
  function getConfig() {
    if (cachedAiConfig) return cachedAiConfig;

    const conversation = getConversationForProject(db, conversationId, projectId);
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

  function invalidateConfig() {
    cachedAiConfig = null;
  }

  function isActive() {
    return active;
  }

  function finishGeneration(payload) {
    active = false;
    abortController = null;
    queue.releaseProcessing(); // 上一条结束，出队其队列项（库内行已为 done，保留为历史用户消息）
    pump(); // 续跑下一条（若有）
    emitDone(payload);
  }

  /* ------------------------------------------------------------------ 标题生成 ------------------------------------------------------------------ */

  /**
   * 根据首条用户消息内容生成简短对话标题（需求 #36）。
   * 仅当标题为空或占位（新对话/默认对话）时生成；已有真实标题不覆盖。
   * 任意异常或解析失败静默返回 null，绝不抛出。
   * @param {number} cid
   * @returns {Promise<string|null>} 规范化后的标题，或 null
   */
  async function generateConversationTitle(cid) {
    try {
      const conversation = db.get('SELECT title FROM conversations WHERE id = ? AND project_id = ?', [cid, projectId]);
      if (!conversation) return null;
      if (!shouldGenerateTitle(conversation.title)) return null;

      // 读取首条 user 消息内容（截断约 500 字）
      const firstUser = db.get(
        `SELECT content FROM chat_messages
         WHERE conversation_id = ? AND project_id = ? AND role = 'user'
         ORDER BY id ASC LIMIT 1`,
        [cid, projectId],
      );
      const userText = String(firstUser?.content || '').trim();
      if (!userText) return null;

      const config = getConfig();
      if (!config.apiKey) return null;

      // 低 temperature、不带 tools、不带 thinking 的独立调用
      let raw = '';
      const stream = llmClient({
        config: {
          provider: config.provider,
          baseUrl: config.baseUrl,
          apiKey: config.apiKey,
          model: config.model,
          temperature: 0.2,
          messages: [
            { role: 'system', content: TITLE_SYSTEM_PROMPT },
            { role: 'user', content: userText.slice(0, 500) },
          ],
          tools: undefined,
          signal: abortController ? abortController.signal : undefined,
        },
      });

      // 静默消费流式 text_delta（不向 UI 投递任何事件）
      for await (const event of stream) {
        if (event.type === 'text_delta' && typeof event.content === 'string') {
          raw += event.content;
        }
      }

      const title = normalizeTitle(raw);
      if (!title) return null;

      db.run('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ? AND project_id = ?', [
        title,
        nowIso(),
        cid,
        projectId,
      ]);
      return title;
    } catch {
      return null;
    }
  }

  /* ------------------------------------------------------------------ Agent Loop ------------------------------------------------------------------ */

  async function runAgentLoop(userMessage) {
    const config = getConfig();

    if (!config.apiKey) {
      finishGeneration({ status: 'error', error: '未配置 API Key，请在设置 AI 面板中配置 LLM 接口。' });
      storeMessage(db, conversationId, projectId, 'system', '未配置 API Key，请在设置 AI 面板中配置 LLM 接口。', null, null, 'error');
      return;
    }

    // 构建初始 messages（按 conversation_id）
    let messages = buildMessages(db, conversationId, projectId, config.provider);
    const tools = formatToolsForProvider(chatTools, config.provider);

    for (let round = 0; round < MAX_ROUNDS; round += 1) {
      if (!active) return;

      currentRound = round + 1;
      emitEvent({ type: 'status', data: { status: `第 ${currentRound}/${MAX_ROUNDS} 轮` } });

      const llmResult = await callLlm(llmClient, config, messages, tools, abortController.signal);

      if (llmResult.error) {
        if (llmResult.aborted) {
          finishGeneration({ status: 'aborted' });
        } else {
          finishGeneration({ status: 'error', error: llmResult.error });
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

      // 纯文本回复 → 结束（顺带尝试基于内容生成标题，失败不影响主流程）
      if (toolCalls.length === 0) {
        const title = await generateConversationTitle(conversationId).catch(() => null);
        finishGeneration({ status: 'done', conversationId, title: title ?? undefined });
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
    finishGeneration({ status: 'max_rounds' });
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

  return {
    send,
    stop,
    getHistory,
    clearHistory,
    getConfig,
    invalidateConfig,
    isActive,
    resumeQueue,
    getQueue: () => queue.getQueue(),
    hasQueued: () => queue.hasQueued(),
    cancelQueueItem: (id) => queue.cancelItem(id),
    editQueueItem: (id, text) => queue.editItem(id, text),
    clearQueue: () => queue.clear(),
  };
}

/* ------------------------------------------------------------------ 消息持久化 ------------------------------------------------------------------ */

function storeMessage(db, conversationId, projectId, role, content, toolCalls, toolResult, status) {
  const createdAt = nowIso();
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
      createdAt,
    ],
  );
  db.run('UPDATE conversations SET updated_at = ? WHERE id = ? AND project_id = ?', [
    createdAt,
    conversationId,
    projectId,
  ]);
}

function markLastAssistantAborted(db, conversationId, projectId) {
  const last = db.get(
    `SELECT id FROM chat_messages
     WHERE conversation_id = ? AND project_id = ? AND role = 'assistant' AND status = 'done'
     ORDER BY id DESC LIMIT 1`,
    [conversationId, projectId],
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
function buildMessages(db, conversationId, projectId, provider) {
  const rows = db.all(
    `SELECT * FROM chat_messages
     WHERE conversation_id = ? AND project_id = ?
     ORDER BY created_at ASC, id ASC`,
    [conversationId, projectId],
  );

  // 排除 streaming（流式中未完成）与 queued（尚未派发的排队消息，不得提前进入上下文）；
  // 处理中项已被 markProcessing 翻为 done，自然进入。
  const completed = rows.filter((row) => row.status !== 'streaming' && row.status !== 'queued');

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

/* ------------------------------------------------------------------ 标题生成工具（需求 #36） ------------------------------------------------------------------ */

const TITLE_PLACEHOLDERS = new Set(['新对话', '默认对话']);
const TITLE_MAX_LENGTH = 30;
const TITLE_SYSTEM_PROMPT =
  '你是对话标题生成器。请根据用户的首条消息生成一个简短的对话标题（不超过15个字）。' +
  '直接输出标题文本，不要解释，不要使用引号，不要以标点符号结尾。';

/**
 * 判断是否需要生成标题：仅空标题或占位标题（新对话/默认对话）才生成。
 */
function shouldGenerateTitle(title) {
  const t = String(title || '').trim();
  return t === '' || TITLE_PLACEHOLDERS.has(t);
}

/**
 * 规范化标题：去除引号/括号 → 折叠换行与空白 → 去除句末标点 → 截断 ≤ TITLE_MAX_LENGTH 字。
 */
function normalizeTitle(raw) {
  let t = String(raw || '');
  // 去除各类引号与书名号/方括号
  t = t.replace(/[“”‘’「」『』《》【】"'`]/g, '');
  // 折叠换行/制表符为空格并压缩连续空白
  t = t.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  // 去除句末标点（中英文常见）
  t = t.replace(/[。.！!？?；;，,：:、…]+$/g, '').trim();
  // 截断至最大长度
  if (t.length > TITLE_MAX_LENGTH) t = t.slice(0, TITLE_MAX_LENGTH);
  return t;
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
function createConversation(db, { projectId, title, aiConfigId } = {}) {
  projectId = normalizeRequiredId(projectId, 'projectId');
  const boundAiConfigId = resolveConversationAiConfigId(db, aiConfigId);
  const now = nowIso();
  const id = db.insert(
    'INSERT INTO conversations (project_id, title, ai_config_id, pinned_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    [projectId, String(title || '').trim(), boundAiConfigId, null, now, now],
  );
  return serializeConversation(db.get('SELECT * FROM conversations WHERE id = ?', [id]));
}

/**
 * 列出项目的所有对话（按最近活跃排序）。
 */
function listConversations(db, projectId) {
  const scopedProjectId = normalizeRequiredId(projectId, 'projectId');
  return db.all(
    `SELECT id, project_id, title, ai_config_id, pinned_at, created_at, updated_at
     FROM conversations
     WHERE project_id = ?
     ORDER BY
       CASE WHEN pinned_at IS NULL OR pinned_at = '' THEN 1 ELSE 0 END ASC,
       updated_at DESC,
       id DESC`,
    [scopedProjectId],
  ).map(serializeConversation);
}

/**
 * 更新对话。
 */
function updateConversation(db, id, fields = {}) {
  const conversationId = normalizeRequiredId(id, 'conversationId');
  const projectScope = normalizeProjectScope(fields);
  const existing = getConversationForProject(db, conversationId, projectScope);
  if (!existing) throw new Error('对话不存在');

  const nextAiConfigId =
    fields.aiConfigId !== undefined
      ? resolveConversationAiConfigId(db, fields.aiConfigId)
      : existing.ai_config_id;
  const now = nowIso();
  const nextPinnedAt = resolveConversationPinnedAt(existing.pinned_at, fields, () => now);
  const params = [
    fields.title !== undefined ? String(fields.title).trim() : existing.title,
    nextAiConfigId,
    nextPinnedAt,
    now,
    conversationId,
  ];
  if (projectScope === null) {
    db.run(
      'UPDATE conversations SET title = ?, ai_config_id = ?, pinned_at = ?, updated_at = ? WHERE id = ?',
      params,
    );
  } else {
    db.run(
      'UPDATE conversations SET title = ?, ai_config_id = ?, pinned_at = ?, updated_at = ? WHERE id = ? AND project_id = ?',
      [...params, projectScope],
    );
  }
  return serializeConversation(getConversationForProject(db, conversationId, projectScope));
}

/**
 * 删除对话（级联删除关联的 chat_messages）。
 */
function deleteConversation(db, id, scope = {}) {
  const conversationId = normalizeRequiredId(id, 'conversationId');
  const projectScope = normalizeProjectScope(scope);
  const existing = getConversationForProject(db, conversationId, projectScope);
  if (!existing) throw new Error('对话不存在');

  if (projectScope === null) {
    db.run('DELETE FROM chat_messages WHERE conversation_id = ?', [conversationId]);
    db.run('DELETE FROM conversations WHERE id = ?', [conversationId]);
  } else {
    db.run('DELETE FROM chat_messages WHERE conversation_id = ? AND project_id = ?', [conversationId, projectScope]);
    db.run('DELETE FROM conversations WHERE id = ? AND project_id = ?', [conversationId, projectScope]);
  }
  return { deleted: true, id: conversationId };
}

/**
 * 确保项目存在一个默认对话（向后兼容：现有 chat:send 未传 conversationId 时自动使用）。
 */
function ensureDefaultConversation(db, projectId) {
  const scopedProjectId = normalizeRequiredId(projectId, 'projectId');
  const existing = db.get(
    'SELECT id FROM conversations WHERE project_id = ? ORDER BY id ASC LIMIT 1',
    [scopedProjectId],
  );
  if (existing) return existing.id;

  return createConversation(db, { projectId: scopedProjectId, title: '默认对话' }).id;
}

function resolveConversationAiConfigId(db, aiConfigId) {
  const id = normalizeOptionalId(aiConfigId);
  if (id === null) return null;
  const row = db.get('SELECT id FROM ai_configs WHERE id = ? AND project_id IS NULL', [id]);
  return row ? row.id : null;
}

function getConversationForProject(db, conversationId, projectId = null) {
  const id = normalizeRequiredId(conversationId, 'conversationId');
  if (projectId === undefined || projectId === null) {
    return db.get('SELECT * FROM conversations WHERE id = ?', [id]);
  }
  const scopedProjectId = normalizeRequiredId(projectId, 'projectId');
  return db.get('SELECT * FROM conversations WHERE id = ? AND project_id = ?', [id, scopedProjectId]);
}

function requireConversationForProject(db, conversationId, projectId) {
  const conversation = getConversationForProject(db, conversationId, projectId);
  if (!conversation) throw new Error('对话不存在或不属于当前项目');
  return conversation;
}

function normalizeProjectScope(input) {
  if (input === undefined || input === null) return null;
  if (typeof input === 'object') {
    if (!Object.prototype.hasOwnProperty.call(input, 'projectId')) return null;
    return normalizeRequiredId(input.projectId, 'projectId');
  }
  return normalizeRequiredId(input, 'projectId');
}

function normalizeRequiredId(value, label) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw new Error(`${label} 不能为空`);
  return id;
}

function normalizeOptionalId(value) {
  if (value === undefined || value === null || value === '') return null;
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function resolveConversationPinnedAt(existingPinnedAt, fields = {}, clock = nowIso) {
  if (Object.prototype.hasOwnProperty.call(fields, 'pinned')) {
    return normalizePinnedFlag(fields.pinned) ? clock() : null;
  }
  if (Object.prototype.hasOwnProperty.call(fields, 'pinnedAt')) {
    return normalizePinnedAt(fields.pinnedAt);
  }
  return normalizePinnedAt(existingPinnedAt);
}

function normalizePinnedAt(value) {
  if (value === undefined || value === null || value === '') return null;
  return String(value);
}

function normalizePinnedFlag(value) {
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (!normalized || normalized === '0' || normalized === 'false' || normalized === 'off' || normalized === 'no') {
      return false;
    }
    return true;
  }
  return value === true || value === 1;
}

function serializeConversation(row) {
  if (!row) return null;
  const pinnedAt = row.pinned_at ?? null;
  return {
    ...row,
    pinned_at: pinnedAt,
    projectId: row.project_id,
    aiConfigId: row.ai_config_id ?? null,
    pinnedAt,
    pinned: Boolean(pinnedAt),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

module.exports = {
  createChatController,
  createConversation,
  listConversations,
  updateConversation,
  deleteConversation,
  ensureDefaultConversation,
};
