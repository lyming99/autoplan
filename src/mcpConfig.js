const MCP_DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  transport: 'http',
  host: '127.0.0.1',
  port: 43847,
  path: '/mcp',
  authToken: '',
});

const MCP_AUTH_TOKEN_INPUT_KEYS = Object.freeze(['mcpAuthToken', 'mcp_auth_token', 'authToken']);

// 可保存字段及其入参键别名（沿用既有 mcpAuthToken 多别名风格扩展到多字段）。
// 仅当输入中显式提供任一别名时才写入对应 mcp.<field> 设置。
const MCP_FIELD_INPUT_KEYS = Object.freeze({
  enabled: Object.freeze(['enabled', 'mcpEnabled', 'mcp_enabled']),
  transport: Object.freeze(['transport', 'mcpTransport', 'mcp_transport']),
  host: Object.freeze(['host', 'mcpHost', 'mcp_host']),
  port: Object.freeze(['port', 'mcpPort', 'mcp_port']),
  path: Object.freeze(['path', 'mcpPath', 'mcp_path']),
  authToken: MCP_AUTH_TOKEN_INPUT_KEYS,
});

const MCP_SAVE_FIELDS = Object.freeze(['enabled', 'transport', 'host', 'port', 'path', 'authToken']);

const MCP_FIELD_NORMALIZERS = {
  enabled: normalizeMcpEnabled,
  transport: normalizeMcpTransport,
  host: normalizeMcpHost,
  port: normalizeMcpPort,
  path: normalizeMcpPath,
  authToken: normalizeMcpAuthToken,
};

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
  let changed = false;
  for (const field of MCP_SAVE_FIELDS) {
    const keys = MCP_FIELD_INPUT_KEYS[field];
    if (!hasOwnInput(input, keys)) continue;
    const next = String(MCP_FIELD_NORMALIZERS[field](readOwnInput(input, keys)));
    const settingKey = `mcp.${field}`;
    const current = db && db.getSetting ? db.getSetting(settingKey, '') : '';
    // setSetting 内部 String(value) 化存储，故以字符串形式比较判断是否变化。
    if (next === current) continue;
    if (db && db.setSetting) db.setSetting(settingKey, next);
    changed = true;
  }
  return changed;
}

function normalizeMcpEnabled(value) {
  if (value === undefined || value === null || value === '') return MCP_DEFAULT_CONFIG.enabled;
  return !['0', 'false', 'off', 'disabled'].includes(String(value).trim().toLowerCase());
}

function normalizeMcpTransport(value) {
  return String(value || MCP_DEFAULT_CONFIG.transport).trim().toLowerCase() === 'stdio' ? 'stdio' : 'http';
}

function normalizeMcpHost(value) {
  return String(value || MCP_DEFAULT_CONFIG.host).trim() || MCP_DEFAULT_CONFIG.host;
}

function normalizeMcpPort(value) {
  const port = Number(value || MCP_DEFAULT_CONFIG.port);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : MCP_DEFAULT_CONFIG.port;
}

function normalizeMcpPath(value) {
  const trimmed = String(value || MCP_DEFAULT_CONFIG.path).trim();
  if (!trimmed || trimmed === '/') return MCP_DEFAULT_CONFIG.path;
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

function normalizeMcpAuthToken(value) {
  // 允许清空：传入空值时返回空串（不抛错），空串以空串落库表示关闭 Bearer 鉴权。
  return String(value || '').trim();
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
