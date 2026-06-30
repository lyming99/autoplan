const {
  DEFAULT_AGENT_CLI_PROVIDER,
  codexSessionContextFields,
  normalizeAgentCliSessionId,
  operationCodexSessionId,
} = require('./agentCliConfig');
const { agentCliSessionContextFields } = require('./agentCliRunner');

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

module.exports = {
  taskAgentCliSessionId,
  taskResultSessionId,
  taskResultSessionContextFields,
};
