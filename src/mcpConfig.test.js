const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { saveMcpSettings, mcpServerConfig } = require('./mcpConfig');

/**
 * 最小 settings 存储替身，仅实现 saveMcpSettings / mcpServerConfig 依赖的
 * getSetting / setSetting / getSettings，隔离真实 SQLite 与 sql.js 依赖。
 * setSetting 与 AppDatabase 一律 String(value) 化存储，保证与生产比较口径一致。
 */
function createSettingsDb(initial = {}) {
  const store = new Map();
  for (const [key, value] of Object.entries(initial)) store.set(key, String(value));
  return {
    getSetting(key, fallback = null) {
      return store.has(key) ? store.get(key) : fallback;
    },
    setSetting(key, value) {
      store.set(key, String(value));
    },
    getSettings(prefix = '') {
      const entries = [...store.entries()]
        .filter(([key]) => (prefix ? key.startsWith(prefix) : true))
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return Object.fromEntries(entries);
    },
  };
}

describe('saveMcpSettings 完整保存', () => {
  it('按 mcp. 前缀完整保存 enabled/transport/host/port/path/authToken 并返回发生变化', () => {
    const db = createSettingsDb();
    const changed = saveMcpSettings(db, {
      enabled: false,
      transport: 'stdio',
      host: '0.0.0.0',
      port: 12345,
      path: '/api',
      authToken: 'sekret',
    });

    assert.equal(changed, true, '首次写入应返回发生变化');
    assert.equal(db.getSetting('mcp.enabled'), 'false');
    assert.equal(db.getSetting('mcp.transport'), 'stdio');
    assert.equal(db.getSetting('mcp.host'), '0.0.0.0');
    assert.equal(db.getSetting('mcp.port'), '12345');
    assert.equal(db.getSetting('mcp.path'), '/api');
    assert.equal(db.getSetting('mcp.authToken'), 'sekret');
  });

  it('仅在输入显式提供某字段时写入，未提供的字段保持原值不变', () => {
    const db = createSettingsDb({
      'mcp.enabled': 'true',
      'mcp.transport': 'stdio',
      'mcp.host': '10.0.0.1',
      'mcp.port': '7000',
      'mcp.path': '/x',
      'mcp.authToken': 'keep',
    });

    const changed = saveMcpSettings(db, { port: 9999 });

    assert.equal(changed, true, '改动端口应返回发生变化');
    assert.equal(db.getSetting('mcp.port'), '9999');
    // 未显式提供的字段不应被改写
    assert.equal(db.getSetting('mcp.enabled'), 'true');
    assert.equal(db.getSetting('mcp.transport'), 'stdio');
    assert.equal(db.getSetting('mcp.host'), '10.0.0.1');
    assert.equal(db.getSetting('mcp.path'), '/x');
    assert.equal(db.getSetting('mcp.authToken'), 'keep');
  });

  it('传入与当前相同的值时返回未变化且不重复写入', () => {
    const db = createSettingsDb({ 'mcp.authToken': 'same-token' });

    const changed = saveMcpSettings(db, { authToken: 'same-token' });

    assert.equal(changed, false, '值未变化应返回 false');
    assert.equal(db.getSetting('mcp.authToken'), 'same-token');
  });
});

describe('normalizeMcpAuthToken 允许清空（经 saveMcpSettings 覆盖内部归一契约）', () => {
  // normalizeMcpAuthToken 为 mcpConfig 内部归一函数（未直接导出），
  // 以下通过公开 API saveMcpSettings 验证其契约：传入空值不再抛错，且以空串落库。

  it('传入空串 authToken 不抛错并落库为空串（关闭 Bearer 鉴权）', () => {
    const db = createSettingsDb({ 'mcp.authToken': 'old-token' });

    assert.doesNotThrow(() => saveMcpSettings(db, { authToken: '' }));
    assert.equal(db.getSetting('mcp.authToken'), '', '清空后应落库为空串以关闭鉴权');
  });

  it('传入纯空白 authToken 归一为空串落库', () => {
    const db = createSettingsDb({ 'mcp.authToken': 'prior' });

    assert.doesNotThrow(() => saveMcpSettings(db, { authToken: '   ' }));
    assert.equal(db.getSetting('mcp.authToken'), '');
  });

  it('传入 null authToken 同样归一为空串而不抛错', () => {
    const db = createSettingsDb({ 'mcp.authToken': 'prior' });

    assert.doesNotThrow(() => saveMcpSettings(db, { authToken: null }));
    assert.equal(db.getSetting('mcp.authToken'), '');
  });

  it('设置非空 authToken 仍正常落库（trim 后保留）', () => {
    const db = createSettingsDb();

    assert.doesNotThrow(() => saveMcpSettings(db, { authToken: '  real-secret  ' }));
    assert.equal(db.getSetting('mcp.authToken'), 'real-secret');
  });
});

describe('saveMcpSettings 入参键兼容', () => {
  it('仍识别 mcpAuthToken / mcp_auth_token / authToken 等既有别名', () => {
    const dbLegacy = createSettingsDb();
    saveMcpSettings(dbLegacy, { mcpAuthToken: 'from-legacy' });
    assert.equal(dbLegacy.getSetting('mcp.authToken'), 'from-legacy');

    const dbSnake = createSettingsDb();
    saveMcpSettings(dbSnake, { mcp_auth_token: 'from-snake' });
    assert.equal(dbSnake.getSetting('mcp.authToken'), 'from-snake');

    const dbCamel = createSettingsDb();
    saveMcpSettings(dbCamel, { authToken: 'from-camel' });
    assert.equal(dbCamel.getSetting('mcp.authToken'), 'from-camel');
  });

  it('多别名同时存在时按既定优先级取首个匹配键', () => {
    const db = createSettingsDb();

    saveMcpSettings(db, { mcpAuthToken: 'first', authToken: 'second' });

    assert.equal(db.getSetting('mcp.authToken'), 'first');
  });
});

describe('saveMcpSettings 字段归一化', () => {
  it('transport 仅允许 http/stdio，其它值归一为 http', () => {
    const dbDefault = createSettingsDb();
    saveMcpSettings(dbDefault, { transport: 'weird' });
    assert.equal(dbDefault.getSetting('mcp.transport'), 'http');

    const dbStdio = createSettingsDb();
    saveMcpSettings(dbStdio, { transport: 'STDIO' });
    assert.equal(dbStdio.getSetting('mcp.transport'), 'stdio');
  });

  it('port 越界或非数字时回退默认端口', () => {
    const dbZero = createSettingsDb();
    saveMcpSettings(dbZero, { port: 0 });
    assert.equal(Number(dbZero.getSetting('mcp.port')), 43847);

    const dbBig = createSettingsDb();
    saveMcpSettings(dbBig, { port: 99999 });
    assert.equal(Number(dbBig.getSetting('mcp.port')), 43847);

    const dbBad = createSettingsDb();
    saveMcpSettings(dbBad, { port: 'abc' });
    assert.equal(Number(dbBad.getSetting('mcp.port')), 43847);
  });

  it('path 归一为以 / 开头的路径', () => {
    const db = createSettingsDb();
    saveMcpSettings(db, { path: 'mcp' });
    assert.equal(db.getSetting('mcp.path'), '/mcp');
  });

  it('host 空白值兜底默认本机地址', () => {
    const db = createSettingsDb();
    saveMcpSettings(db, { host: '   ' });
    assert.equal(db.getSetting('mcp.host'), '127.0.0.1');
  });

  it('enabled 归一为布尔语义字符串', () => {
    const dbOff = createSettingsDb();
    saveMcpSettings(dbOff, { enabled: '0' });
    assert.equal(dbOff.getSetting('mcp.enabled'), 'false');

    const dbOn = createSettingsDb();
    saveMcpSettings(dbOn, { enabled: 'yes' });
    assert.equal(dbOn.getSetting('mcp.enabled'), 'true');
  });
});

describe('mcpServerConfig 读取', () => {
  it('从 settings 推导完整配置（env 缺省时兼容回填）', () => {
    const db = createSettingsDb({
      'mcp.enabled': 'false',
      'mcp.transport': 'stdio',
      'mcp.host': '0.0.0.0',
      'mcp.port': '12345',
      'mcp.path': '/api',
      'mcp.authToken': 'tok',
    });

    const config = mcpServerConfig(db, {});

    assert.equal(config.enabled, false);
    assert.equal(config.transport, 'stdio');
    assert.equal(config.host, '0.0.0.0');
    assert.equal(config.port, '12345');
    assert.equal(config.path, '/api');
    assert.equal(config.authToken, 'tok');
  });
});

describe('默认传输不回退（需求 #69 回归）', () => {
  // normalizeMcpTransport / MCP_DEFAULT_CONFIG 为 mcpConfig 内部归一（未直接导出），
  // 以下经公开 API saveMcpSettings 覆盖其契约，确认本需求未改动默认传输与 stdio/http 归一口径。

  it('transport 显式为 stdio 时归一为 stdio（normalizeMcpTransport 契约）', () => {
    const db = createSettingsDb();
    saveMcpSettings(db, { transport: 'stdio' });
    assert.equal(db.getSetting('mcp.transport'), 'stdio');
  });

  it('transport 空白时回退默认传输 http（MCP_DEFAULT_CONFIG.transport 未被改动）', () => {
    const db = createSettingsDb();
    saveMcpSettings(db, { transport: '' });
    assert.equal(db.getSetting('mcp.transport'), 'http');
  });

  it('非 stdio 值仍归一为 http', () => {
    const db = createSettingsDb();
    saveMcpSettings(db, { transport: 'websocket' });
    assert.equal(db.getSetting('mcp.transport'), 'http');
  });
});
