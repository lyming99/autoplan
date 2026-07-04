'use strict';

const { createLlmClient } = require('../chat/llmClient');
const { resolveAiConfigForPlanGeneration } = require('../chat/aiConfigService');
const {
  PlanSpecValidationError,
  normalizePlanSpec,
  parsePlanSpecJson,
} = require('./structuredPlanSpec');

const PLAN_SPEC_TOOL_NAME = 'submit_plan_spec';
const BUILTIN_PLAN_GENERATION_ERROR_CODES = Object.freeze({
  CONFIG_INVALID: 'config_invalid',
  MISSING_API_KEY: 'missing_api_key',
  MISSING_MODEL: 'missing_model',
  REQUEST_FAILED: 'request_failed',
  NON_STRUCTURED_RESPONSE: 'non_structured_response',
  INVALID_PLAN_SPEC: 'invalid_plan_spec',
});

const STRICT_PLAN_SPEC_TOOL_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['title', 'summary', 'tasks', 'finalValidation'],
  properties: {
    title: { type: 'string', minLength: 1 },
    summary: { type: 'string', minLength: 1 },
    tasks: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'scope', 'acceptance'],
        properties: {
          title: { type: 'string', minLength: 1 },
          scope: { type: 'array', items: { type: 'string' } },
          acceptance: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    finalValidation: {
      type: 'object',
      additionalProperties: false,
      required: ['command', 'criteria'],
      properties: {
        command: { type: 'string', minLength: 1 },
        criteria: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } },
      },
    },
  },
});

async function generateBuiltinPlanSpec(input = {}) {
  const {
    db,
    planGenerationConfig = {},
    prompt,
    signal,
    fetch,
    llmClient = createLlmClient,
  } = input;
  if (!db || typeof db.get !== 'function') {
    throw builtinPlanGenerationError(
      '内置 LLM 计划生成无法读取 AI 配置：数据库连接不可用',
      BUILTIN_PLAN_GENERATION_ERROR_CODES.CONFIG_INVALID,
    );
  }

  const aiConfig = resolveAiConfigForPlanGeneration(db, planGenerationConfig);
  validateBuiltinAiConfig(aiConfig);

  const tool = buildBuiltinPlanSpecTool();
  const stream = llmClient({
    config: {
      provider: aiConfig.provider,
      baseUrl: aiConfig.baseUrl,
      apiKey: aiConfig.apiKey,
      model: aiConfig.model,
      temperature: Number(aiConfig.temperature ?? 0.3),
      messages: buildBuiltinPlanMessages(prompt),
      tools: [tool],
      toolChoice: toolChoiceForProvider(aiConfig.provider),
      signal,
      thinkingDepth: aiConfig.thinkingDepth,
      thinkingBudgetTokens: aiConfig.thinkingBudgetTokens,
    },
    fetch,
  });

  let text = '';
  const toolCalls = [];
  try {
    for await (const event of stream) {
      if (!event || !event.type) continue;
      switch (event.type) {
        case 'text_delta':
          text += event.content || '';
          break;
        case 'tool_call':
          toolCalls.push(event);
          break;
        case 'error':
          throw builtinPlanGenerationError(
            `内置 LLM 请求失败：${event.message || 'unknown error'}`,
            BUILTIN_PLAN_GENERATION_ERROR_CODES.REQUEST_FAILED,
            aiConfig,
          );
        default:
          break;
      }
    }
  } catch (error) {
    if (isBuiltinPlanGenerationError(error)) throw error;
    throw builtinPlanGenerationError(
      `内置 LLM 请求失败：${error?.message || String(error)}`,
      BUILTIN_PLAN_GENERATION_ERROR_CODES.REQUEST_FAILED,
      aiConfig,
    );
  }

  return {
    planSpec: parseBuiltinPlanSpecResult({ toolCalls, text, aiConfig }),
    aiConfig: summarizeAiConfig(aiConfig),
    output: text,
    toolCalls,
  };
}

function validateBuiltinAiConfig(aiConfig) {
  if (!normalizeText(aiConfig?.apiKey)) {
    throw builtinPlanGenerationError(
      '内置 LLM 计划生成缺少 API Key：请先在 ai_configs 中配置可用 API Key',
      BUILTIN_PLAN_GENERATION_ERROR_CODES.MISSING_API_KEY,
      aiConfig,
    );
  }
  if (!normalizeText(aiConfig?.model)) {
    throw builtinPlanGenerationError(
      '内置 LLM 计划生成缺少模型：请设置 AI 配置 model 或 planGenerationModel',
      BUILTIN_PLAN_GENERATION_ERROR_CODES.MISSING_MODEL,
      aiConfig,
    );
  }
  if (!normalizeText(aiConfig?.baseUrl)) {
    throw builtinPlanGenerationError(
      '内置 LLM 计划生成缺少 API Base URL',
      BUILTIN_PLAN_GENERATION_ERROR_CODES.CONFIG_INVALID,
      aiConfig,
    );
  }
}

function buildBuiltinPlanMessages(prompt) {
  return [{
    role: 'user',
    content: [
      '系统约束：你是 AutoPlan 的结构化计划生成器。',
      `必须调用 ${PLAN_SPEC_TOOL_NAME} 工具提交 PlanSpec JSON；不要输出 Markdown，不要写文件，不要输出解释文字。`,
      'PlanSpec 只描述计划语义；任务编号、完整验收任务规范化和 Markdown 渲染由 AutoPlan 完成。',
      '',
      String(prompt || '').trim(),
    ].join('\n'),
  }];
}

function buildBuiltinPlanSpecTool() {
  return {
    name: PLAN_SPEC_TOOL_NAME,
    description: 'Submit a structured AutoPlan PlanSpec. Do not return Markdown.',
    strict: true,
    input_schema: STRICT_PLAN_SPEC_TOOL_SCHEMA,
  };
}

function toolChoiceForProvider(provider) {
  if (provider === 'anthropic') {
    return { type: 'tool', name: PLAN_SPEC_TOOL_NAME };
  }
  return { type: 'function', function: { name: PLAN_SPEC_TOOL_NAME } };
}

function parseBuiltinPlanSpecResult({ toolCalls, text, aiConfig }) {
  const matchingToolCalls = toolCalls.filter((call) => call?.name === PLAN_SPEC_TOOL_NAME);
  if (matchingToolCalls.length > 0) {
    const latest = matchingToolCalls[matchingToolCalls.length - 1];
    return parsePlanSpecPayload(latest.arguments, aiConfig);
  }
  if (toolCalls.length > 0) {
    const names = toolCalls.map((call) => call?.name || 'unknown').join(', ');
    throw builtinPlanGenerationError(
      `内置 LLM 返回了非预期工具调用：${names}`,
      BUILTIN_PLAN_GENERATION_ERROR_CODES.NON_STRUCTURED_RESPONSE,
      aiConfig,
    );
  }
  if (normalizeText(text)) {
    return parsePlanSpecPayload(text, aiConfig);
  }
  throw builtinPlanGenerationError(
    '内置 LLM 未返回 PlanSpec 工具调用或 JSON 内容',
    BUILTIN_PLAN_GENERATION_ERROR_CODES.NON_STRUCTURED_RESPONSE,
    aiConfig,
  );
}

function parsePlanSpecPayload(payload, aiConfig) {
  try {
    const raw = typeof payload === 'string' ? parsePlanSpecJson(payload) : payload;
    return normalizePlanSpec(raw);
  } catch (error) {
    const reason = error instanceof PlanSpecValidationError
      ? error.errors.join('; ')
      : (error?.message || String(error));
    throw builtinPlanGenerationError(
      `模型返回的 PlanSpec 不合规：${reason}`,
      BUILTIN_PLAN_GENERATION_ERROR_CODES.INVALID_PLAN_SPEC,
      aiConfig,
    );
  }
}

function builtinPlanGenerationError(message, code, aiConfig) {
  const error = new Error(message);
  error.name = 'BuiltinPlanGenerationError';
  error.code = code;
  if (aiConfig) error.aiConfig = summarizeAiConfig(aiConfig);
  return error;
}

function isBuiltinPlanGenerationError(error) {
  return error?.name === 'BuiltinPlanGenerationError';
}

function summarizeAiConfig(aiConfig = {}) {
  return {
    id: aiConfig.id ?? null,
    name: aiConfig.name ?? null,
    provider: aiConfig.provider ?? null,
    baseUrl: aiConfig.baseUrl ?? null,
    hasApiKey: Boolean(normalizeText(aiConfig.apiKey)),
    model: aiConfig.model ?? '',
    temperature: aiConfig.temperature ?? null,
    thinkingDepth: aiConfig.thinkingDepth ?? null,
    thinkingBudgetTokens: aiConfig.thinkingBudgetTokens ?? null,
  };
}

function normalizeText(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

module.exports = {
  BUILTIN_PLAN_GENERATION_ERROR_CODES,
  PLAN_SPEC_TOOL_NAME,
  STRICT_PLAN_SPEC_TOOL_SCHEMA,
  buildBuiltinPlanSpecTool,
  generateBuiltinPlanSpec,
  summarizeAiConfig,
};
