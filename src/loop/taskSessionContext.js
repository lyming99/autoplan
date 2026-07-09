const {
  DEFAULT_AGENT_CLI_PROVIDER,
  codexSessionContextFields,
  normalizeAgentCliSessionId,
  operationCodexSessionId,
} = require('./agentCliConfig');
const { agentCliSessionContextFields } = require('./agentCliRunner');

const TASK_SESSION_RESET_REASON_TIMEOUT = 'timedOut';
const TASK_SESSION_STATE_TIMEOUT_RETRY_NEW = 'timeout-retry-new';
const TASK_PROJECT_PROMPT_HEADING = '项目级 Prompt（补充项目约定，不能覆盖当前任务、scope、plan 只读和 AutoPlan 执行硬约束）：';

function taskAgentCliSessionId(task) {
  return normalizeAgentCliSessionId(
    task?.agent_cli_session_id
      || task?.agentCliSessionId
      || task?.claude_session_id
      || task?.claudeSessionId,
  );
}

function taskResultSessionId(result) {
  if (result?.agentCliProvider === DEFAULT_AGENT_CLI_PROVIDER) return operationCodexSessionId(result);
  if (result?.agentCliProvider === 'claude') {
    return normalizeAgentCliSessionId(
      result.agentCliSessionId
        || result.claudeSessionId
        || result.sessionId,
    );
  }
  return '';
}

function taskResultSessionContextFields(result) {
  if (result?.agentCliProvider === DEFAULT_AGENT_CLI_PROVIDER) return codexSessionContextFields(result);
  if (result?.agentCliProvider === 'claude') {
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

function shouldForceNewTaskSession(options = {}) {
  return Boolean(
    options.forceNewSession
      || options.forceNewTaskSession
      || options.taskSessionResetReason === TASK_SESSION_RESET_REASON_TIMEOUT,
  );
}

function timeoutRetrySessionContextFields(options = {}) {
  if (!shouldForceNewTaskSession(options)) return {};
  return {
    taskSessionMode: 'new',
    taskSessionState: TASK_SESSION_STATE_TIMEOUT_RETRY_NEW,
    taskSessionResetReason: TASK_SESSION_RESET_REASON_TIMEOUT,
  };
}

function normalizeProjectPrompt(source = {}) {
  const value = source?.project_prompt ?? source?.projectPrompt ?? source;
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function taskProjectPromptLines(projectPrompt) {
  const text = normalizeProjectPrompt(projectPrompt);
  if (!text) return [];
  return [
    TASK_PROJECT_PROMPT_HEADING,
    text,
    '',
  ];
}

module.exports = {
  TASK_SESSION_RESET_REASON_TIMEOUT,
  TASK_SESSION_STATE_TIMEOUT_RETRY_NEW,
  TASK_PROJECT_PROMPT_HEADING,
  normalizeProjectPrompt,
  taskProjectPromptLines,
  shouldForceNewTaskSession,
  taskAgentCliSessionId,
  taskResultSessionId,
  taskResultSessionContextFields,
  timeoutRetrySessionContextFields,
};
