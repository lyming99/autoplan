const MCP_AUTH_TOKEN_INPUT_KEYS = Object.freeze(['mcpAuthToken', 'mcp_auth_token', 'authToken']);

function mcpServerConfig(db, env = process.env) {
  const settings = db?.getSettings ? db.getSettings('mcp.') : {};
  return {
    enabled: normalizeMcpEnabled(env.AUTOPLAN_MCP_ENABLED ?? settings['mcp.enabled']),
    transport: env.AUTOPLAN_MCP_TRANSPORT ?? settings['mcp.transport'],
    host: env.AUTOPLAN_MCP_HOST ?? settings['mcp.host'],
    port: env.AUTOPLAN_MCP_PORT ?? settings['mcp.port'],
    path: env.AUTOPLAN_MCP_PATH ?? settings['mcp.path'],
    authToken: env.AUTOPLAN_MCP_AUTH_TOKEN ?? settings['mcp.authToken'],
  };
}

function saveMcpSettings(db, input = {}) {
  if (!hasOwnInput(input, MCP_AUTH_TOKEN_INPUT_KEYS)) return false;
  const token = normalizeMcpAuthToken(readOwnInput(input, MCP_AUTH_TOKEN_INPUT_KEYS));
  const current = db.getSetting ? db.getSetting('mcp.authToken', '') : '';
  if (token === current) return false;
  db.setSetting('mcp.authToken', token);
  return true;
}

function normalizeMcpEnabled(value) {
  if (value === undefined || value === null || value === '') return true;
  return !['0', 'false', 'off', 'disabled'].includes(String(value).trim().toLowerCase());
}

function normalizeMcpAuthToken(value) {
  const token = String(value || '').trim();
  if (!token) throw new Error('MCP 密钥不能为空');
  return token;
}

function hasOwnInput(source, keys) {
  return keys.some((key) => Object.prototype.hasOwnProperty.call(source || {}, key));
}

function readOwnInput(source, keys) {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(source || {}, key)) return source[key];
  }
  return undefined;
}

module.exports = { mcpServerConfig, saveMcpSettings };
