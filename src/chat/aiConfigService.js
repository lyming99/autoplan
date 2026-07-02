'use strict';

/**
 * AI 配置服务（需求 #28）：全局多 AI 配置 CRUD、默认配置回退与脱敏。
 *
 * 职责：
 * - 管理 ai_configs 表的 CRUD 操作
 * - API Key 脱敏输出（仅返回 hasApiKey 布尔值 + maskedKey 末 4 位）
 * - 对话 AI 配置解析：conversation.ai_config_id → 全局首条配置 → 内置默认
 */

const { nowIso } = require('../database');

const BUILTIN_DEFAULT_CONFIG = {
  provider: 'openai',
  baseUrl: 'https://api.openai.com',
  apiKey: '',
  model: 'gpt-4o',
  temperature: '0.3',
};

const AI_CONFIG_PROVIDERS = new Set(['openai', 'deepseek', 'anthropic']);
const THINKING_DEPTHS = new Set(['low', 'medium', 'high']);

/**
 * 创建 AI 配置。
 */
function createAiConfig(db, input = {}) {
  const config = normalizeCreateAiConfigInput(input);

  const now = nowIso();
  const id = db.insert(
    `INSERT INTO ai_configs (project_id, name, provider, base_url, api_key, model, temperature, thinking_depth, thinking_budget_tokens, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      null,
      config.name,
      config.provider,
      config.baseUrl,
      config.apiKey,
      config.model,
      config.temperature,
      config.thinkingDepth,
      config.thinkingBudgetTokens,
      now,
      now,
    ],
  );
  return getAiConfig(db, id);
}

/**
 * 更新 AI 配置。
 */
function updateAiConfig(db, id, fields = {}) {
  const existing = db.get('SELECT * FROM ai_configs WHERE id = ? AND project_id IS NULL', [id]);
  if (!existing) throw new Error('AI 配置不存在');

  const now = nowIso();
  db.run(
    `UPDATE ai_configs
     SET name = ?, provider = ?, base_url = ?, api_key = ?, model = ?, temperature = ?,
         thinking_depth = ?, thinking_budget_tokens = ?, updated_at = ?
     WHERE id = ?`,
    [
      fields.name !== undefined ? String(fields.name).trim() : existing.name,
      fields.provider ?? existing.provider,
      fields.baseUrl ?? existing.base_url,
      fields.apiKey ?? existing.api_key,
      fields.model ?? existing.model,
      fields.temperature ?? existing.temperature,
      fields.thinkingDepth !== undefined ? (fields.thinkingDepth || null) : existing.thinking_depth,
      fields.thinkingBudgetTokens !== undefined
        ? (fields.thinkingBudgetTokens != null ? Number(fields.thinkingBudgetTokens) : null)
        : existing.thinking_budget_tokens,
      now,
      id,
    ],
  );
  return getAiConfig(db, id);
}

/**
 * 删除 AI 配置。关联对话的 ai_config_id 自动置 null（降级为默认配置）。
 */
function deleteAiConfig(db, id) {
  const existing = db.get('SELECT * FROM ai_configs WHERE id = ? AND project_id IS NULL', [id]);
  if (!existing) throw new Error('AI 配置不存在');

  // 将关联对话的 ai_config_id 置 null，降级为默认配置
  db.run('UPDATE conversations SET ai_config_id = NULL, updated_at = ? WHERE ai_config_id = ?', [
    nowIso(),
    id,
  ]);
  db.run('DELETE FROM ai_configs WHERE id = ? AND project_id IS NULL', [id]);
  return { deleted: true };
}

/**
 * 列出全局 AI 配置（脱敏）。
 */
function listAiConfigs(db) {
  const rows = db.all('SELECT * FROM ai_configs WHERE project_id IS NULL ORDER BY id ASC');
  return rows.map(sanitizeAiConfig);
}

/**
 * 获取单条 AI 配置（脱敏）。
 */
function getAiConfig(db, id) {
  const row = db.get('SELECT * FROM ai_configs WHERE id = ? AND project_id IS NULL', [id]);
  return row ? sanitizeAiConfig(row) : null;
}

/**
 * 旧 chat.* 全局设置的兼容摘要。
 *
 * 仅供旧设置表单读写全局兼容配置，不代表任何项目的 ai_configs 可用状态。
 */
function getLegacyChatConfig(db) {
  const settings = db.getSettings('chat.');
  const apiKey = settings['chat.apiKey'] || '';
  return {
    source: 'legacy-chat-settings',
    compatibilityOnly: true,
    provider: settings['chat.provider'] || BUILTIN_DEFAULT_CONFIG.provider,
    baseUrl: settings['chat.baseUrl'] || BUILTIN_DEFAULT_CONFIG.baseUrl,
    hasApiKey: Boolean(apiKey),
    maskedKey: maskApiKey(apiKey),
    model: settings['chat.model'] || BUILTIN_DEFAULT_CONFIG.model,
    temperature: settings['chat.temperature'] || BUILTIN_DEFAULT_CONFIG.temperature,
  };
}

/**
 * 解析对话的实际 AI 配置。
 * 优先级：conversation.ai_config_id → 全局首条 ai_configs → 内置默认值。
 * 返回的配置对象含原始 apiKey（供 LLM 客户端调用），不脱敏。
 */
function resolveAiConfigForConversation(db, conversation) {
  if (conversation?.ai_config_id) {
    const row = db.get('SELECT * FROM ai_configs WHERE id = ? AND project_id IS NULL', [conversation.ai_config_id]);
    if (row) return rowToConfig(row);
  }

  // 回退到全局首条配置
  const first = db.get('SELECT * FROM ai_configs WHERE project_id IS NULL ORDER BY id ASC LIMIT 1');
  if (first) return rowToConfig(first);

  // 内置默认
  return { ...BUILTIN_DEFAULT_CONFIG };
}

/* ------------------------------------------------------------------ 工具函数 ------------------------------------------------------------------ */

function normalizeCreateAiConfigInput(input = {}) {
  const name = normalizeText(input.name);
  if (!name) throw new Error('配置名称不能为空');

  const provider = normalizeProvider(input.provider);
  return {
    name,
    provider,
    baseUrl: normalizeText(input.baseUrl),
    apiKey: normalizeText(input.apiKey),
    model: normalizeText(input.model),
    temperature: normalizeTemperature(input.temperature),
    thinkingDepth: supportsThinkingDepth(provider) ? normalizeThinkingDepth(input.thinkingDepth) : null,
    thinkingBudgetTokens: supportsThinkingBudget(provider)
      ? normalizeThinkingBudgetTokens(input.thinkingBudgetTokens)
      : null,
  };
}

function normalizeText(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function normalizeProvider(value) {
  const provider = normalizeText(value).toLowerCase();
  return AI_CONFIG_PROVIDERS.has(provider) ? provider : BUILTIN_DEFAULT_CONFIG.provider;
}

function normalizeTemperature(value) {
  const temperature = normalizeText(value);
  return temperature || BUILTIN_DEFAULT_CONFIG.temperature;
}

function normalizeThinkingDepth(value) {
  const depth = normalizeText(value).toLowerCase();
  return THINKING_DEPTHS.has(depth) ? depth : null;
}

function normalizeThinkingBudgetTokens(value) {
  if (value === undefined || value === null || value === '') return null;
  const tokens = Number(value);
  if (!Number.isFinite(tokens) || tokens <= 0) return null;
  return Math.floor(tokens);
}

function supportsThinkingDepth(provider) {
  return provider === 'openai' || provider === 'deepseek';
}

function supportsThinkingBudget(provider) {
  return provider === 'anthropic';
}

/**
 * 将数据库行转换为配置对象（含原始 apiKey）。
 */
function rowToConfig(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    provider: row.provider,
    baseUrl: row.base_url,
    apiKey: row.api_key,
    model: row.model,
    temperature: row.temperature,
    thinkingDepth: row.thinking_depth,
    thinkingBudgetTokens: row.thinking_budget_tokens,
  };
}

/**
 * 脱敏 AI 配置行：隐藏 api_key/apiKey，输出 hasApiKey + maskedKey。
 */
function sanitizeAiConfig(row) {
  if (!row) return null;
  const apiKey = row.api_key || '';
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    provider: row.provider,
    baseUrl: row.base_url,
    hasApiKey: Boolean(apiKey),
    maskedKey: maskApiKey(apiKey),
    model: row.model,
    temperature: row.temperature,
    thinkingDepth: row.thinking_depth,
    thinkingBudgetTokens: row.thinking_budget_tokens,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * 脱敏 API Key：保留末 4 位，其余用 ···· 替代。
 */
function maskApiKey(value) {
  const token = String(value || '').trim();
  if (!token) return '';
  if (token.length <= 4) return '····';
  return `····${token.slice(-4)}`;
}

module.exports = {
  createAiConfig,
  updateAiConfig,
  deleteAiConfig,
  listAiConfigs,
  getAiConfig,
  getLegacyChatConfig,
  resolveAiConfigForConversation,
  maskApiKey,
  sanitizeAiConfig,
  BUILTIN_DEFAULT_CONFIG,
};
