const {
  DEFAULT_AGENT_CLI_PROVIDER,
  codexSessionContextFields,
  normalizeAgentCliSessionId,
  opencodeSessionContextFields,
} = require('./agentCliConfig');

const PLAN_GENERATION_FORMAT_GUARD_TITLE = 'AutoPlan 任务拆解格式硬性要求（必须遵守）';
const CLAUDE_SESSION_INPUT_KEYS = [
  'agentCliSessionId',
  'agentCliSessionRequestedId',
  'claudeSessionId',
  'claudeSessionRequestedId',
  'sessionId',
];

function planGenerationGuardedPrompt(prompt, label, operation = {}) {
  if (!isPlanGenerationOperation(label, operation)) return prompt;
  const text = String(prompt || '');
  if (text.includes(PLAN_GENERATION_FORMAT_GUARD_TITLE)) return text;
  return `${text.trimEnd()}\n\n${PLAN_GENERATION_FORMAT_GUARD_TITLE}\n${[
    '- 必须包含二级标题 `## 任务拆解`，所有开发任务只能放在这个章节里。',
    '- 每个任务行必须独占一行，并严格使用 `- [ ] P001: 任务标题 <!-- scope: src/file.js,src/other.ts -->`。',
    '- 禁止把任务拆解写成普通段落、代码块、表格、引用块或嵌套 checkbox；验收要点可以缩进，但不能写成 checkbox 任务。',
    '- 缺少明确影响范围时写 `<!-- scope: unknown -->`；最后一个完整验收任务也使用连续编号，例如 `- [ ] P007: 完整验收 <!-- scope: validation -->`。',
    '- 任务编号按 P001、P002 递增；不要跳号、复用编号或把多个任务写在同一行。',
  ].join('\n')}`;
}

function isPlanGenerationOperation(label, operation = {}) {
  const text = String(label || '');
  return text === 'generate-plan' || text.startsWith('gen-requirement-') || text.startsWith('gen-feedback-') || Boolean(operation.intakeType);
}

function opencodePlanSessionTitle(projectId, planId) {
  return `AutoPlan project ${Number(projectId || 0)} plan ${Number(planId || 0)}`;
}

function isOpenCodeSessionMissing(output) {
  return /(?:session\s+not\s+found|unknown\s+session|invalid\s+session)/i.test(String(output || ''));
}

function requestedAgentCliSessionId(operation = {}) {
  return normalizeAgentCliSessionId(
    operation.agentCliSessionId
      || operation.agentCliSessionRequestedId
      || operation.claudeSessionId
      || operation.claudeSessionRequestedId
      || operation.sessionId,
  );
}

function agentCliSessionContextFields(provider, options = {}) {
  const sessionId = normalizeAgentCliSessionId(options.sessionId);
  const requestedId = normalizeAgentCliSessionId(options.requestedId);
  const mode = options.mode || (sessionId ? 'resume' : 'new');
  const state = options.state || mode;
  const context = {
    agentCliSessionMode: mode,
    agentCliSessionState: state,
  };
  if (sessionId) context.agentCliSessionId = sessionId;
  if (requestedId) context.agentCliSessionRequestedId = requestedId;
  if (options.fallback) context.agentCliSessionFallback = true;
  if (provider === 'claude') {
    if (sessionId) context.claudeSessionId = sessionId;
    if (requestedId) context.claudeSessionRequestedId = requestedId;
    context.claudeSessionMode = mode;
    context.claudeSessionState = state;
    if (options.fallback) context.claudeSessionFallback = true;
  }
  return context;
}

function agentCliSessionStateFor(mode, requestedState, fallback = false) {
  if (fallback) return 'fallback-new';
  if (mode === 'resume' && requestedState === 'plan-resume') return 'plan-resume';
  return mode || requestedState || 'new';
}

function isClaudeSessionMissing(output) {
  return /(?:session\s+not\s+found|unknown\s+session|invalid\s+session|conversation\s+not\s+found|no\s+conversation)/i.test(String(output || ''));
}

function agentCliResultSessionContextFields(result = {}) {
  const provider = result.agentCliProvider || result.provider;
  if (provider === DEFAULT_AGENT_CLI_PROVIDER) return codexSessionContextFields(result);
  if (provider === 'opencode') return opencodeSessionContextFields(result);
  if (provider === 'claude') {
    return agentCliSessionContextFields('claude', {
      sessionId: result.agentCliSessionId || result.claudeSessionId || result.sessionId,
      requestedId: result.agentCliSessionRequestedId || result.claudeSessionRequestedId,
      mode: result.agentCliSessionMode || result.claudeSessionMode,
      state: result.agentCliSessionState || result.claudeSessionState,
      fallback: result.agentCliSessionFallback || result.claudeSessionFallback,
    });
  }
  return {};
}

module.exports = {
  planGenerationGuardedPrompt,
  isPlanGenerationOperation,
  opencodePlanSessionTitle,
  isOpenCodeSessionMissing,
  requestedAgentCliSessionId,
  agentCliSessionContextFields,
  agentCliSessionStateFor,
  isClaudeSessionMissing,
  agentCliResultSessionContextFields,
  PLAN_GENERATION_FORMAT_GUARD_TITLE,
  CLAUDE_SESSION_INPUT_KEYS,
};
