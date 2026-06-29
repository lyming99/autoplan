const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createMcpServer, describeListenError } = require('./mcpServer');

/**
 * 临时把 process.platform 改写为指定值，用于覆盖 describeListenError 的 darwin 平台分支。
 * process.platform 描述符为 configurable:true，可用 Object.defineProperty 临时覆盖并在 finally 还原，
 * 既能在 Windows/Linux 环境验证 darwin 提示，也不污染 node:test 进程其它用例的真实平台判定。
 */
function withPlatform(platform, fn) {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, 'platform', original);
  }
}

describe('describeListenError 错误码分类', () => {
  it('EADDRINUSE 归为端口占用语义并携带触发冲突的端口号', () => {
    const message = describeListenError({ code: 'EADDRINUSE', message: 'listen EADDRINUSE' }, 43847);
    assert.match(message, /端口/);
    assert.match(message, /占用/);
    assert.match(message, /43847/, '文案应携带 config.port');
  });

  it('EACCES 归为网络监听权限或防火墙语义', () => {
    const message = describeListenError({ code: 'EACCES', message: 'listen EACCES' }, 43847);
    assert.match(message, /网络监听权限|防火墙/);
  });

  it('EPERM 与 EACCES 同归为网络监听权限或防火墙语义', () => {
    const message = describeListenError({ code: 'EPERM', message: 'listen EPERM' }, 43847);
    assert.match(message, /网络监听权限|防火墙/);
  });

  it('其它错误码归为通用启动失败语义并保留原始信息', () => {
    const message = describeListenError({ code: 'ECONNREFUSED', message: 'something broke' }, 43847);
    assert.match(message, /MCP HTTP 启动失败/);
    assert.match(message, /something broke/);
  });

  it('无 code 的普通 Error 也归为通用语义', () => {
    const message = describeListenError(new Error('boom'), 43847);
    assert.match(message, /MCP HTTP 启动失败/);
    assert.match(message, /boom/);
  });
});

describe('describeListenError 平台感知分支', () => {
  it('darwin 平台追加 stdio 降级与防火墙放行提示', () => {
    withPlatform('darwin', () => {
      const message = describeListenError({ code: 'EADDRINUSE', message: 'listen EADDRINUSE' }, 43847);
      assert.match(message, /npm run mcp:stdio/);
      assert.match(message, /防火墙/);
    });
  });

  it('非 darwin 平台不追加 macOS 专属段（不污染 Windows/Linux 文案）', () => {
    for (const platform of ['linux', 'win32']) {
      withPlatform(platform, () => {
        const message = describeListenError({ code: 'EACCES', message: 'listen EACCES' }, 43847);
        assert.doesNotMatch(message, /npm run mcp:stdio/, `${platform} 不应追加 stdio 降级提示`);
        assert.doesNotMatch(message, /系统设置→网络→防火墙/, `${platform} 不应追加 macOS 防火墙提示段`);
      });
    }
  });
});

describe('MCP HTTP 监听失败集成路径', () => {
  it('绑定已占用端口时 start() 以分类文案 reject 且 lastError 与之一致、running 保持 false', async () => {
    // 占用一个临时端口制造 EADDRINUSE，触发 startHttp 的 listen 'error' 事件。
    const occupier = http.createServer();
    await new Promise((resolve) => occupier.listen(0, '127.0.0.1', resolve));
    const occupiedPort = occupier.address().port;

    const server = createMcpServer({
      config: { transport: 'http', host: '127.0.0.1', port: occupiedPort },
    });
    try {
      await assert.rejects(
        () => server.start(),
        (error) => {
          assert.match(error.message, /端口/);
          assert.match(error.message, /占用/);
          return true;
        },
        'start() 应以分类后文案 reject',
      );
      const status = server.status();
      assert.equal(status.running, false, '监听失败后应保持未运行');
      assert.match(status.lastError, /端口/);
      assert.match(status.lastError, /占用/, 'lastError 应携带分类后可处置文案');
    } finally {
      await server.stop().catch(() => undefined);
      await new Promise((resolve) => occupier.close(() => resolve()));
    }
  });

  it('stdio 正常启动不受 HTTP 错误分类影响（transport===stdio、不写入错误文案）', async () => {
    const server = createMcpServer({
      config: { transport: 'stdio' },
      registerTools: async () => {},
    });
    try {
      const state = await server.start();
      assert.equal(state.transport, 'stdio');
      assert.equal(state.running, true);
      assert.equal(state.lastError, null, 'stdio 正常路径不应触发 HTTP 错误分类文案');
    } finally {
      await server.stop().catch(() => undefined);
    }
  });
});
