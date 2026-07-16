const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { nowIso } = require('../src/database');

function loadMainPlanReadHandler(db, loop) {
  const handlers = loadMainIpcHandlers(db, loop);
  const handler = handlers.get('plans:read');
  assert.equal(typeof handler, 'function', '主进程应注册 plans:read IPC handler');
  return handler;
}

function loadMainIpcHandlers(db, loop, options = {}) {
  const mainPath = path.join(__dirname, '..', 'src', 'main.js');
  const handlers = new Map();
  const module = { exports: {} };
  const source = `${fs.readFileSync(mainPath, 'utf8')}\nmodule.exports.__setSmokeState = (state) => { db = state.db; loop = state.loop; if (typeof state.updateChecker !== 'undefined') updateChecker = state.updateChecker; };\nmodule.exports.__smokeIpcHandlers = __smokeIpcHandlers;\n`;
  const fakeChildProcess = {
    spawn: options.spawn || (() => createSpawnOnlyChild()),
  };
  const fakeElectron = {
    app: {
      isPackaged: false,
      getPath: () => path.join(os.tmpdir(), 'autoplan-smoke-user-data'),
      on: () => {},
      quit: () => {},
      requestSingleInstanceLock: () => true,
      setPath: () => {},
      whenReady: () => ({ then: () => undefined }),
    },
    BrowserWindow: function SmokeBrowserWindow() {
      throw new Error('smoke 不应创建 Electron 窗口');
    },
    ipcMain: {
      handle: (channel, handler) => handlers.set(channel, handler),
    },
    Menu: {
      setApplicationMenu: () => {},
    },
    shell: options.shell || {
      openPath: async () => '',
      showItemInFolder: () => {},
    },
  };
  const localRequire = (request) => {
    if (request === 'electron') return fakeElectron;
    if (request === 'node:child_process') return fakeChildProcess;
    if (request.startsWith('./')) return require(path.join(path.dirname(mainPath), request));
    return require(request);
  };

  vm.runInNewContext(
    source,
    {
      require: localRequire,
      module,
      exports: module.exports,
      __dirname: path.dirname(mainPath),
      __filename: mainPath,
      __smokeIpcHandlers: handlers,
      Buffer,
      clearTimeout,
      console,
      process,
      setTimeout,
    },
    { filename: mainPath },
  );
  module.exports.__setSmokeState({ db, loop, updateChecker: options.updateChecker });
  return handlers;
}

function loadRendererTsModule(modulePath, cache = new Map()) {
  const absolutePath = path.resolve(modulePath);
  const cachedModule = cache.get(absolutePath);
  if (cachedModule) return cachedModule.exports;

  const ts = require('typescript');
  const module = { exports: {} };
  cache.set(absolutePath, module);

  const source = fs.readFileSync(absolutePath, 'utf8');
  const transpiled = ts.transpileModule(source, {
    fileName: absolutePath,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
    },
    reportDiagnostics: true,
  });
  const diagnostics = (transpiled.diagnostics || []).filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  );
  assert.deepEqual(
    diagnostics.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')),
    [],
    `${absolutePath} 应能被 TypeScript 转译`,
  );

  const rendererRoot = path.join(__dirname, '..', 'src', 'renderer');
  const localRequire = (request) => {
    if (request.startsWith('.') || path.isAbsolute(request)) {
      return loadRendererTsModule(resolveRendererModule(path.dirname(absolutePath), request, rendererRoot), cache);
    }
    return require(request);
  };

  const script = new vm.Script(transpiled.outputText, { filename: absolutePath });
  script.runInNewContext({
    require: localRequire,
    module,
    exports: module.exports,
    __dirname: path.dirname(absolutePath),
    __filename: absolutePath,
    console,
  });
  return module.exports;
}

function resolveRendererModule(fromDir, request, rendererRoot) {
  const basePath = path.resolve(fromDir, request);
  const candidates = [
    basePath,
    `${basePath}.ts`,
    `${basePath}.tsx`,
    `${basePath}.js`,
    `${basePath}.jsx`,
    path.join(basePath, 'index.ts'),
    path.join(basePath, 'index.tsx'),
    path.join(basePath, 'index.js'),
  ];
  const resolvedPath = candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
  assert.ok(resolvedPath, `应能解析前端模块 ${request}`);

  const relativePath = path.relative(rendererRoot, resolvedPath);
  assert.ok(
    relativePath && !relativePath.startsWith('..') && !path.isAbsolute(relativePath),
    `前端 smoke 模块应限制在 renderer 目录内：${request}`,
  );
  return resolvedPath;
}

function loadPatchedLoopService({ spawnOverride }) {
  const loopServicePath = path.join(__dirname, '..', 'src', 'loopService.js');
  const source = fs.readFileSync(loopServicePath, 'utf8');
  const module = { exports: {} };
  const patchedAgentCli = loadPatchedAgentCli({ spawnOverride });
  const fakeChildProcess = {
    spawn: (command, args, options) => spawnOverride(command, args, options),
  };
  const localRequire = (request) => {
    if (request === 'node:child_process') return fakeChildProcess;
    if (request === './database') return { nowIso };
    if (request === './agentCli') return patchedAgentCli;
    if (request.startsWith('./')) return require(path.join(path.dirname(loopServicePath), request));
    return require(request);
  };
  vm.runInNewContext(
    source,
    {
      require: localRequire,
      module,
      exports: module.exports,
      __dirname: path.dirname(loopServicePath),
      __filename: loopServicePath,
      Buffer,
      clearTimeout,
      console,
      process,
      setTimeout,
      setInterval,
      clearInterval,
    },
    { filename: loopServicePath },
  );
  assert.equal(typeof module.exports.LoopService, 'function', 'patched loopService 应导出 LoopService');
  return module.exports;
}

function loadPatchedAgentCli({ spawnOverride }) {
  const agentCliPath = path.join(__dirname, '..', 'src', 'agentCli.js');
  const source = fs.readFileSync(agentCliPath, 'utf8');
  const module = { exports: {} };
  const fakeChildProcess = {
    spawn: (command, args, options) => spawnOverride(command, args, options),
  };
  const localRequire = (request) => {
    if (request === 'node:child_process') return fakeChildProcess;
    return require(request);
  };
  vm.runInNewContext(
    source,
    {
      require: localRequire,
      module,
      exports: module.exports,
      __dirname: path.dirname(agentCliPath),
      __filename: agentCliPath,
      Buffer,
      clearTimeout,
      console,
      process,
      setTimeout,
    },
    { filename: agentCliPath },
  );
  return module.exports;
}

function createFakeChild(options = {}) {
  const { EventEmitter } = require('node:events');
  const child = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdin.setDefaultEncoding = () => {};
  child.stdin.end = (prompt = '') => {
    if (typeof options.onPrompt === 'function') options.onPrompt(String(prompt || ''));
    child.stdout.emit('data', Buffer.from(options.output || 'fake agent output\n', 'utf8'));
    setImmediate(() => child.emit('exit', typeof options.exitCode === 'number' ? options.exitCode : 0));
  };
  child.stdout = new EventEmitter();
  child.stdout.pipe = () => {};
  child.stderr = new EventEmitter();
  child.stderr.pipe = () => {};
  child.killed = false;
  child.kill = () => {};
  child.pid = Math.floor(Math.random() * 1e6);
  return child;
}

function createSpawnOnlyChild() {
  const { EventEmitter } = require('node:events');
  const child = new EventEmitter();
  child.unref = () => {};
  child.kill = () => {};
  child.killed = false;
  child.pid = Math.floor(Math.random() * 1e6);
  setImmediate(() => child.emit('spawn'));
  return child;
}

module.exports = {
  loadMainPlanReadHandler,
  loadMainIpcHandlers,
  loadRendererTsModule,
  loadPatchedLoopService,
  loadPatchedAgentCli,
  createFakeChild,
  createSpawnOnlyChild,
};
