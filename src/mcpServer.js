const http = require('node:http');
const crypto = require('node:crypto');
const path = require('node:path');
const { registerMcpTools } = require('./mcpTools');

const DEFAULT_MCP_CONFIG = Object.freeze({
  enabled: true,
  transport: 'http',
  host: '127.0.0.1',
  port: 43847,
  path: '/mcp',
  authToken: '',
  name: 'autoplan',
  version: '0.2.0',
});

const LOCAL_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

class AutoPlanMcpServer {
  constructor(options = {}) {
    this.db = options.db;
    this.loop = options.loop;
    this.intakeService = options.intakeService;
    this.registerTools = options.registerTools || registerMcpTools;
    this.logger = options.logger || console;
    this.config = normalizeMcpConfig(options.config);
    this.httpServer = null;
    this.stdioTransport = null;
    this.stdioSdkServer = null;
    this.state = stoppedState(this.config);
  }

  async start() {
    if (!this.config.enabled) {
      this.state = { ...stoppedState(this.config), enabled: false };
      return this.state;
    }
    if (this.state.running) return this.state;
    validateSafeHost(this.config);

    try {
      if (this.config.transport === 'stdio') {
        await this.startStdio();
      } else {
        await this.startHttp();
      }
      return this.state;
    } catch (error) {
      await this.stop().catch(() => undefined);
      this.state = { ...stoppedState(this.config), lastError: errorMessage(error) };
      throw error;
    }
  }

  async stop() {
    const closeHttpServer = this.httpServer
      ? new Promise((resolve) => {
          this.httpServer.close(() => resolve());
        })
      : Promise.resolve();

    this.httpServer = null;
    await closeHttpServer;

    if (this.stdioTransport?.close) await this.stdioTransport.close();
    if (this.stdioSdkServer?.close) await this.stdioSdkServer.close();
    this.stdioTransport = null;
    this.stdioSdkServer = null;
    this.state = stoppedState(this.config);
    return this.state;
  }

  status() {
    return { ...this.state };
  }

  async startHttp() {
    this.httpServer = http.createServer((request, response) => {
      this.handleHttpRequest(request, response).catch((error) => {
        this.logger.error?.('[mcp] request failed', error);
        writeJson(response, 500, { error: 'MCP request failed', message: errorMessage(error) });
      });
    });

    await listenHttpServer(this.httpServer, this.config.port, this.config.host).catch(async (error) => {
      if (!shouldFallbackToAvailablePort(error, this.config)) {
        throw new Error(describeListenError(error, this.config.port));
      }
      await listenHttpServer(this.httpServer, 0, this.config.host);
    });

    const address = this.httpServer.address();
    const port = typeof address === 'object' && address ? address.port : this.config.port;
    this.state = {
      enabled: true,
      running: true,
      transport: 'http',
      host: this.config.host,
      port,
      path: this.config.path,
      url: `http://${this.config.host}:${port}${this.config.path}`,
      localOnly: isLocalHost(this.config.host),
      startedAt: new Date().toISOString(),
      lastError: null,
    };
  }

  async startStdio() {
    const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
    this.stdioSdkServer = await this.createSdkServer();
    this.stdioTransport = new StdioServerTransport();
    await this.stdioSdkServer.connect(this.stdioTransport);
    this.state = {
      enabled: true,
      running: true,
      transport: 'stdio',
      host: null,
      port: null,
      path: null,
      url: null,
      localOnly: true,
      startedAt: new Date().toISOString(),
      lastError: null,
    };
  }

  async handleHttpRequest(request, response) {
    const requestUrl = new URL(request.url || '/', `http://${this.config.host}:${this.config.port}`);
    if (!isAuthorizedRequest(request, this.config.authToken)) {
      writeJson(response, 401, { error: 'Unauthorized', message: '缺少或无效的 Authorization Bearer 密钥' }, {
        'WWW-Authenticate': 'Bearer realm="AutoPlan MCP"',
      });
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname === '/health') {
      writeJson(response, 200, this.status());
      return;
    }
    if (requestUrl.pathname !== this.config.path) {
      writeJson(response, 404, { error: 'Not found' });
      return;
    }
    if (request.method !== 'POST') {
      writeJson(response, 405, { error: 'Method not allowed' }, { Allow: 'POST' });
      return;
    }

    const body = await readJsonBody(request);
    const sdkServer = await this.createSdkServer();
    const { StreamableHTTPServerTransport } = await import('@modelcontextprotocol/sdk/server/streamableHttp.js');
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    response.on('close', () => {
      transport.close?.();
      sdkServer.close?.();
    });
    await sdkServer.connect(transport);
    await transport.handleRequest(request, response, body);
  }

  async createSdkServer() {
    const { Server } = await import('@modelcontextprotocol/sdk/server/index.js');
    const sdkServer = new Server(
      { name: this.config.name, version: this.config.version },
      { capabilities: { tools: {} } },
    );
    if (typeof this.registerTools === 'function') {
      await this.registerTools(sdkServer, {
        db: this.db,
        loop: this.loop,
        intakeService: this.intakeService,
      });
    }
    return sdkServer;
  }
}

function createMcpServer(options = {}) {
  return new AutoPlanMcpServer(options);
}

function normalizeMcpConfig(input = {}, env = process.env) {
  const transport = String(input.transport || env.AUTOPLAN_MCP_TRANSPORT || DEFAULT_MCP_CONFIG.transport).toLowerCase();
  const normalizedTransport = transport === 'stdio' ? 'stdio' : 'http';
  const inputHasPort = Object.prototype.hasOwnProperty.call(input || {}, 'port');
  const envHasPort = env.AUTOPLAN_MCP_PORT !== undefined && env.AUTOPLAN_MCP_PORT !== null && env.AUTOPLAN_MCP_PORT !== '';
  const port = normalizePort(input.port ?? env.AUTOPLAN_MCP_PORT, DEFAULT_MCP_CONFIG.port);
  return {
    ...DEFAULT_MCP_CONFIG,
    ...input,
    enabled: input.enabled ?? env.AUTOPLAN_MCP_ENABLED !== '0',
    transport: normalizedTransport,
    host: String(input.host || env.AUTOPLAN_MCP_HOST || DEFAULT_MCP_CONFIG.host).trim() || DEFAULT_MCP_CONFIG.host,
    port,
    path: normalizeHttpPath(input.path || env.AUTOPLAN_MCP_PATH || DEFAULT_MCP_CONFIG.path),
    authToken: normalizeAuthToken(input.authToken || env.AUTOPLAN_MCP_AUTH_TOKEN || DEFAULT_MCP_CONFIG.authToken),
    allowRemote: input.allowRemote ?? env.AUTOPLAN_MCP_ALLOW_REMOTE === '1',
    autoPortFallback: input.autoPortFallback ?? (!inputHasPort && !envHasPort && port === DEFAULT_MCP_CONFIG.port),
  };
}

function validateSafeHost(config) {
  if (config.transport !== 'http') return;
  if (isLocalHost(config.host) || config.allowRemote) return;
  throw new Error('MCP HTTP 服务默认仅允许绑定 localhost/127.0.0.1；如需远程访问请显式设置 AUTOPLAN_MCP_ALLOW_REMOTE=1');
}

function stoppedState(config) {
  return {
    enabled: Boolean(config.enabled),
    running: false,
    transport: config.transport,
    host: config.transport === 'http' ? config.host : null,
    port: config.transport === 'http' ? config.port : null,
    path: config.transport === 'http' ? config.path : null,
    url: config.transport === 'http' ? `http://${config.host}:${config.port}${config.path}` : null,
    localOnly: config.transport !== 'http' || isLocalHost(config.host),
    startedAt: null,
    lastError: null,
  };
}

function isLocalHost(host) {
  return LOCAL_HOSTS.has(String(host || '').toLowerCase());
}

function normalizePort(value, fallback) {
  const port = Number(value || fallback);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return fallback;
  return port;
}

function normalizeHttpPath(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed || trimmed === '/') return DEFAULT_MCP_CONFIG.path;
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

function normalizeAuthToken(value) {
  return String(value || '').trim();
}

function shouldFallbackToAvailablePort(error, config) {
  return error?.code === 'EADDRINUSE'
    && config?.autoPortFallback
    && config?.transport === 'http'
    && Number(config.port) === DEFAULT_MCP_CONFIG.port;
}

function listenHttpServer(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

function isAuthorizedRequest(request, authToken) {
  if (!authToken) return true;
  const authorization = String(request.headers.authorization || '').trim();
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match ? timingSafeEqualString(match[1].trim(), authToken) : false;
}

function timingSafeEqualString(left, right) {
  const leftBuffer = Buffer.from(String(left || ''));
  const rightBuffer = Buffer.from(String(right || ''));
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch (error) {
        reject(new Error(`MCP 请求 JSON 解析失败：${errorMessage(error)}`));
      }
    });
    request.on('error', reject);
  });
}

function writeJson(response, statusCode, body, headers = {}) {
  if (response.headersSent) return;
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    ...headers,
  });
  response.end(JSON.stringify(body));
}

function errorMessage(error) {
  return error?.message || String(error || '未知错误');
}

// 把 HTTP listen 失败按错误码分类为中文可处置文案，并在 macOS 下追加平台感知指引。
// 复用既有 lastError → mcp.start.failed 事件 → IPC → McpControlPanel「最近错误」链路，不新增通道。
function describeListenError(error, port) {
  const code = error?.code;
  let message;
  if (code === 'EADDRINUSE') {
    message = `端口 ${port} 已被占用（可换端口或关闭占用进程）`;
  } else if (code === 'EACCES' || code === 'EPERM') {
    message = '无网络监听权限或被防火墙拦截';
  } else {
    message = `MCP HTTP 启动失败：${errorMessage(error)}`;
  }
  if (process.platform === 'darwin') {
    message += `\nmacOS 请在「系统设置→网络→防火墙」放行 AutoPlan、确认应用为非沙箱直接分发版本；若本机端口仍无法监听，可改用独立 stdio 进程（npm run mcp:stdio），由外部 MCP 客户端 spawn 该进程接入`;
  }
  return message;
}

async function startStandalone() {
  const args = new Set(process.argv.slice(2));
  const transport = args.has('--stdio') ? 'stdio' : 'http';
  const dataDir = process.env.AUTOPLAN_DATA_DIR || path.join(process.cwd(), '.autoplan-runtime', 'mcp');
  const { AppDatabase } = require('./database');
  const { createIntakeService } = require('./intakeService');
  const { LoopService } = require('./loopService');
  const db = new AppDatabase(path.join(dataDir, 'autoplan.sqlite'));
  await db.init();
  const loop = new LoopService(db);
  const server = createMcpServer({
    db,
    loop,
    intakeService: createIntakeService({
      db,
      loop,
      attachmentsRoot: () => path.join(dataDir, 'attachments'),
    }),
    config: normalizeMcpConfig({ transport }),
  });
  const state = await server.start();
  process.stderr.write(`AutoPlan MCP ${state.transport} server started${state.url ? ` at ${state.url}` : ''}\n`);
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, async () => {
      await server.stop().catch(() => undefined);
      process.exit(0);
    });
  }
}

if (require.main === module) {
  startStandalone().catch((error) => {
    process.stderr.write(`AutoPlan MCP server failed: ${errorMessage(error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  AutoPlanMcpServer,
  DEFAULT_MCP_CONFIG,
  createMcpServer,
  normalizeMcpConfig,
  describeListenError,
};
