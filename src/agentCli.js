const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const DEFAULT_AGENT_CLI_PROVIDER = 'codex';
const AGENT_CLI_PROVIDERS = new Set([DEFAULT_AGENT_CLI_PROVIDER, 'claude', 'opencode', 'oh-my-pi']);
const DEFAULT_CODEX_REASONING_EFFORT = 'medium';
const CODEX_REASONING_EFFORTS = new Set(['low', DEFAULT_CODEX_REASONING_EFFORT, 'high', 'xhigh']);
const AGENT_CLI_DISPLAY_NAMES = Object.freeze({
  codex: 'Codex',
  claude: 'Claude',
  opencode: 'OpenCode',
  'oh-my-pi': 'Oh My Pi',
});
const OPENCODE_SESSION_LOOKUP_MAX_COUNT = 50;

function normalizeAgentCliProvider(value) {
  const provider = String(value || '').trim().toLowerCase();
  return AGENT_CLI_PROVIDERS.has(provider) ? provider : DEFAULT_AGENT_CLI_PROVIDER;
}

function normalizeAgentCliCommand(value) {
  return String(value || '').trim();
}

function defaultAgentCliCommand(provider) {
  const normalized = normalizeAgentCliProvider(provider);
  // oh-my-pi 是首个 provider 名与命令名不一致的后端：默认命令为 omp（可被自定义命令路径覆盖）。
  return normalized === 'oh-my-pi' ? 'omp' : normalized;
}

function normalizeCodexReasoningEffort(value) {
  const effort = String(value || '').trim().toLowerCase();
  return CODEX_REASONING_EFFORTS.has(effort) ? effort : DEFAULT_CODEX_REASONING_EFFORT;
}

function codexReasoningConfigArgs(reasoningEffort) {
  return ['-c', `model_reasoning_effort="${normalizeCodexReasoningEffort(reasoningEffort)}"`];
}

function codexNewSessionArgs(workspace, lastFile, options = {}) {
  return [
    'exec',
    ...codexReasoningConfigArgs(options.reasoningEffort),
    '--cd',
    workspace,
    '--color',
    'never',
    '-o',
    lastFile,
    '--sandbox',
    'danger-full-access',
    '-',
  ];
}

function codexResumeSessionArgs(sessionId, lastFile, options = {}) {
  return [
    'exec',
    'resume',
    ...codexReasoningConfigArgs(options.reasoningEffort),
    '-o',
    lastFile,
    sessionId,
    '-',
  ];
}

function claudeCliArgs(options = {}) {
  return [
    '--print',
    '--output-format',
    'stream-json',
    '--verbose',
    '--dangerously-skip-permissions',
    ...claudeSessionArgs(options),
  ];
}

function normalizeAgentCliSessionId(value) {
  const text = String(value || '').trim();
  if (!text || text.length > 256) return '';
  return /^[A-Za-z0-9._:-]+$/.test(text) ? text : '';
}

function firstOwnSessionValue(source, keys) {
  if (!source || typeof source !== 'object') return '';
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
    const value = source[key];
    if (value === null || value === undefined || String(value).trim() === '') continue;
    return value;
  }
  return '';
}

function normalizeClaudeSessionMode(value, sessionIds = {}) {
  const mode = String(value || '').trim().toLowerCase().replace(/_/g, '-');
  if (mode === 'resume' || mode === 'continue' || mode === 'new') return mode;
  if (mode === 'session' || mode === 'session-id' || mode === 'specified' || mode === 'start') return 'session-id';
  if (sessionIds.requestedSessionId) return 'resume';
  if (sessionIds.sessionId) return 'session-id';
  return 'new';
}

function claudeSessionLaunchSpec(options = {}) {
  const sessionId = normalizeAgentCliSessionId(
    firstOwnSessionValue(options, [
      'sessionId',
      'session_id',
      'agentCliSessionId',
      'agent_cli_session_id',
      'claudeSessionId',
      'claude_session_id',
    ]),
  );
  const requestedSessionId = normalizeAgentCliSessionId(
    firstOwnSessionValue(options, [
      'requestedSessionId',
      'requested_session_id',
      'resumeSessionId',
      'resume_session_id',
      'agentCliSessionRequestedId',
      'agent_cli_session_requested_id',
      'agentCliSessionResumeId',
      'agent_cli_session_resume_id',
      'claudeSessionRequestedId',
      'claude_session_requested_id',
      'claudeSessionResumeId',
      'claude_session_resume_id',
    ]),
  );
  const mode = normalizeClaudeSessionMode(
    firstOwnSessionValue(options, [
      'sessionMode',
      'session_mode',
      'agentCliSessionMode',
      'agent_cli_session_mode',
      'claudeSessionMode',
      'claude_session_mode',
    ]),
    { sessionId, requestedSessionId },
  );

  if (mode === 'continue') {
    return { args: ['--continue'], mode, sessionId: '', requestedSessionId: '' };
  }
  if (mode === 'resume') {
    const resumeSessionId = requestedSessionId || sessionId;
    return {
      args: resumeSessionId ? ['--resume', resumeSessionId] : [],
      mode: resumeSessionId ? mode : 'new',
      sessionId: resumeSessionId,
      requestedSessionId: resumeSessionId,
    };
  }
  if (mode === 'session-id') {
    return {
      args: sessionId ? ['--session-id', sessionId] : [],
      mode: sessionId ? mode : 'new',
      sessionId,
      requestedSessionId: '',
    };
  }
  return { args: [], mode: 'new', sessionId: '', requestedSessionId: '' };
}

function claudeSessionArgs(options = {}) {
  return claudeSessionLaunchSpec(options).args;
}

// opencode 的非交互模式为 `run` 子命令（官方文档 opencode.ai/docs/cli）。
// prompt 以位置参数方式在运行时追加，输出走 stdout（`--format default` 为格式化输出）。
// opencode 不支持从 stdin 读取 prompt（官方长期未实现，见 sst/opencode issue #16283 / #25508），
// 因此不可沿用 Codex/Claude 的 stdin 投递方式，否则会进入 TUI 或挂起。
function normalizeOpenCodeSessionTitle(value) {
  const text = String(value || '').trim();
  return text ? text.slice(0, 160) : '';
}

function opencodeCliArgs(options = {}) {
  const args = ['run', '--format', 'default'];
  const sessionId = normalizeAgentCliSessionId(options.sessionId || options.opencodeSessionId);
  const title = normalizeOpenCodeSessionTitle(options.title || options.opencodeSessionTitle);
  if (sessionId) args.push('--session', sessionId);
  if (title) args.push('--title', title);
  return args;
}

// oh-my-pi 的非交互模式为 `--print`（pi.dev/docs/latest/usage）：
// 读取 stdin prompt、把最终回复写入 stdout 后退出，无 TUI、无权限确认挂起。
// print 模式为 CI/脚本设计，omp 本身不做沙箱（无需也不存在 --dangerously-skip-permissions 类标志）；
// prompt 经 stdin 投递以规避命令行长度/转义问题，不走 stdin→位置参数回退。
function ompCliArgs() {
  return ['--print'];
}

function agentCliSpawnSpec(provider, command, lastFile, codexArgs, agentCliOptions = {}) {
  const normalizedProvider = normalizeAgentCliProvider(provider);
  const resolvedCommand = normalizeAgentCliCommand(command) || defaultAgentCliCommand(normalizedProvider);
  if (normalizedProvider === 'claude') {
    const sessionSpec = claudeSessionLaunchSpec(agentCliOptions);
    return {
      provider: normalizedProvider,
      agentCliProvider: normalizedProvider,
      command: resolvedCommand,
      args: claudeCliArgs(agentCliOptions),
      lastFileSource: 'claude-stream-json',
      useShell: false,
      promptSource: 'stdin',
      agentCliSessionId: sessionSpec.sessionId,
      agentCliSessionRequestedId: sessionSpec.requestedSessionId,
      agentCliSessionMode: sessionSpec.mode,
      agentCliSessionState: sessionSpec.mode,
    };
  }
  if (normalizedProvider === 'opencode') {
    const sessionId = normalizeAgentCliSessionId(agentCliOptions.sessionId || agentCliOptions.opencodeSessionId);
    const title = normalizeOpenCodeSessionTitle(agentCliOptions.title || agentCliOptions.opencodeSessionTitle);
    return {
      provider: normalizedProvider,
      agentCliProvider: normalizedProvider,
      command: resolvedCommand,
      args: opencodeCliArgs({ sessionId, title }),
      lastFileSource: 'stdout',
      useShell: false,
      promptSource: 'argument',
      agentCliSessionId: sessionId,
      agentCliSessionTitle: title,
    };
  }
  if (normalizedProvider === 'oh-my-pi') {
    // 无状态单次后端：不含任何会话字段（agentCliSessionId/Title 等），
    // 每次生成计划/执行任务都是一次全新的 `omp --print` 调用。
    return {
      provider: normalizedProvider,
      agentCliProvider: normalizedProvider,
      command: resolvedCommand,
      args: ompCliArgs(),
      lastFileSource: 'stdout',
      useShell: false,
      promptSource: 'stdin',
    };
  }
  return {
    provider: normalizedProvider,
    agentCliProvider: normalizedProvider,
    command: resolvedCommand,
    args: codexArgs || [],
    lastFileSource: 'cli',
    useShell: true,
    promptSource: 'stdin',
  };
}

async function runAgentCliAttempt(options) {
  const {
    workspace,
    prompt,
    lastFile,
    logFile,
    runtime,
    activeOperation,
    operationKey,
    onOperationKey,
    registerRuntimeOperation,
    waitForChild,
    stream,
    provider,
    command,
    codexArgs,
    agentCliOptions,
    onChunk,
    env,
    timeoutMs = 45 * 60 * 1000,
  } = options;

  const spawnSpec = agentCliSpawnSpec(provider, command, lastFile, codexArgs, agentCliOptions);
  activeOperation.agentCliProvider = spawnSpec.agentCliProvider;
  activeOperation.agentCliCommand = spawnSpec.command;
  if (spawnSpec.agentCliSessionId) activeOperation.agentCliSessionId = spawnSpec.agentCliSessionId;
  if (spawnSpec.agentCliSessionRequestedId) activeOperation.agentCliSessionRequestedId = spawnSpec.agentCliSessionRequestedId;
  if (spawnSpec.agentCliSessionMode) activeOperation.agentCliSessionMode = spawnSpec.agentCliSessionMode;
  if (spawnSpec.agentCliSessionState) activeOperation.agentCliSessionState = spawnSpec.agentCliSessionState;
  if (spawnSpec.agentCliSessionTitle) activeOperation.agentCliSessionTitle = spawnSpec.agentCliSessionTitle;

  // opencode 仅支持以位置参数传入 prompt，在构造命令行前追加，复用既有转义/引用逻辑。
  if (spawnSpec.promptSource === 'argument') {
    spawnSpec.args = [...spawnSpec.args, prompt];
  }

  const executionSpec = agentCliExecutionSpec(spawnSpec);
  const child = spawn(executionSpec.command, executionSpec.args, {
    shell: executionSpec.shell,
    windowsVerbatimArguments: executionSpec.windowsVerbatimArguments,
    cwd: workspace,
    env: env || process.env,
  });

  const nextOperationKey = bindRuntimeOperation({
    runtime,
    child,
    activeOperation,
    operationKey,
    registerRuntimeOperation,
  });
  if (typeof onOperationKey === 'function') onOperationKey(nextOperationKey);

  let output = '';
  let stdoutOutput = '';
  let spawnError = null;
  const handleChunk = (chunk, source) => {
    const text = chunk.toString('utf8');
    output += text;
    if (source === 'stdout') stdoutOutput += text;
    safeWriteStream(stream, text);
    if (!runtime.activeOperations.has(nextOperationKey)) return;
    appendOperationBuffer(activeOperation, text);
    if (typeof onChunk === 'function') onChunk(text, { operationKey: nextOperationKey, spawnSpec });
    if (activeOperation.activity) activeOperation.activity.offer(text);
  };

  if (child.stdout) {
    child.stdout.on('data', (chunk) => handleChunk(chunk, 'stdout'));
  }
  if (child.stderr) {
    child.stderr.on('data', (chunk) => handleChunk(chunk, 'stderr'));
  }
  child.on('error', (error) => {
    spawnError = error;
    const message = readableAgentCliError({
      provider: spawnSpec.agentCliProvider,
      command: spawnSpec.command,
      exitCode: -1,
      error,
      logFile,
    });
    const text = `\n[AutoPlan] ${message}\n`;
    output += text;
    safeWriteStream(stream, text);
    if (!runtime.activeOperations.has(nextOperationKey)) return;
    appendOperationBuffer(activeOperation, text);
    activeOperation.errorMessage = message;
  });

  if (child.stdin) {
    child.stdin.setDefaultEncoding('utf8');
    // prompt 作为位置参数的后端（opencode）不再通过 stdin 投递 prompt，
    // 直接发送 EOF 关闭 stdin，避免 opencode 误读管道 stdin 导致挂起（见 sst/opencode #11891）。
    if (spawnSpec.promptSource === 'argument') {
      child.stdin.end();
    } else {
      child.stdin.end(prompt);
    }
  }

  let exitCode = await waitForChild(child, timeoutMs);
  const timedOut = Boolean(child.__autoplanTimedOut);
  const timeoutMessage = timedOut
    ? `${AGENT_CLI_DISPLAY_NAMES[spawnSpec.agentCliProvider] || 'Agent CLI'} CLI timed out after ${formatDurationMs(timeoutMs)}`
    : '';
  if (timeoutMessage) {
    const text = `\n[AutoPlan] ${timeoutMessage}\n`;
    output += text;
    safeWriteStream(stream, text);
    if (runtime.activeOperations.has(nextOperationKey)) {
      appendOperationBuffer(activeOperation, text);
      activeOperation.errorMessage = timeoutMessage;
    }
  }
  const printer = activeOperation.activity;
  const isClaudeStream = spawnSpec.lastFileSource === 'claude-stream-json';
  let lastFileError = null;
  if (isClaudeStream && printer && typeof printer.flush === 'function') {
    printer.flush();
    const resultText = typeof printer.getResultText === 'function' ? printer.getResultText() : '';
    if (resultText) stdoutOutput = resultText;
  }
  if (spawnSpec.lastFileSource === 'stdout' || isClaudeStream) {
    try {
      fs.writeFileSync(lastFile, stdoutOutput, 'utf8');
    } catch (error) {
      lastFileError = error;
      if (exitCode === 0) exitCode = -1;
      const text = `\n[AutoPlan] ${readableAgentCliLastFileError({
        provider: spawnSpec.agentCliProvider,
        command: spawnSpec.command,
        lastFile,
        error,
      })}\n`;
      output += text;
      safeWriteStream(stream, text);
      if (runtime.activeOperations.has(nextOperationKey)) {
        appendOperationBuffer(activeOperation, text);
      }
    }
  }
  if (runtime.activeOperations.has(nextOperationKey)) activeOperation.exitCode = exitCode;
  let agentCliSessionId = normalizeAgentCliSessionId(spawnSpec.agentCliSessionId);
  if (isClaudeStream && printer && typeof printer.getSessionId === 'function') {
    const parsedSessionId = normalizeAgentCliSessionId(printer.getSessionId());
    if (parsedSessionId) agentCliSessionId = parsedSessionId;
  }
  let sessionLookupError = '';
  if (
    spawnSpec.agentCliProvider === 'opencode' &&
    !agentCliSessionId &&
    spawnSpec.agentCliSessionTitle
  ) {
    const lookup = await findOpenCodeSessionByTitle({
      command: spawnSpec.command,
      title: spawnSpec.agentCliSessionTitle,
      workspace,
      env: env || process.env,
      waitForChild,
    });
    agentCliSessionId = lookup.sessionId;
    sessionLookupError = lookup.error || '';
  }
  if (agentCliSessionId && runtime.activeOperations.has(nextOperationKey)) {
    activeOperation.agentCliSessionId = agentCliSessionId;
    activeOperation.opencodeSessionId = agentCliSessionId;
  }
  const errorMessage = timeoutMessage || (lastFileError
    ? readableAgentCliLastFileError({
        provider: spawnSpec.agentCliProvider,
        command: spawnSpec.command,
        lastFile,
        error: lastFileError,
      })
    : readableAgentCliError({
        provider: spawnSpec.agentCliProvider,
        command: spawnSpec.command,
        exitCode,
        error: spawnError,
        logFile,
      }));
  if (errorMessage && runtime.activeOperations.has(nextOperationKey)) {
    activeOperation.errorMessage = errorMessage;
  }

  return {
    exitCode,
    output,
    logFile,
    lastFile,
    provider: spawnSpec.agentCliProvider,
    agentCliProvider: spawnSpec.agentCliProvider,
    command: spawnSpec.command,
    agentCliCommand: spawnSpec.command,
    operationKey: nextOperationKey,
    activity: agentCliActivity(activeOperation),
    errorMessage,
    timedOut,
    timeoutMs,
    ...(agentCliSessionId ? { agentCliSessionId, opencodeSessionId: agentCliSessionId } : {}),
    ...(spawnSpec.agentCliSessionTitle ? { agentCliSessionTitle: spawnSpec.agentCliSessionTitle, opencodeSessionTitle: spawnSpec.agentCliSessionTitle } : {}),
    ...(sessionLookupError ? { sessionLookupError } : {}),
  };
}

async function findOpenCodeSessionByTitle({ command, title, workspace, env, waitForChild }) {
  const normalizedTitle = normalizeOpenCodeSessionTitle(title);
  if (!normalizedTitle) return { sessionId: '', error: '' };
  const sessions = await listOpenCodeSessions({ command, workspace, env, waitForChild });
  if (sessions.error) return { sessionId: '', error: sessions.error };
  const workspacePath = normalizeComparablePath(workspace);
  const matches = sessions.items.filter((session) => session?.title === normalizedTitle);
  const match = matches.find((session) => normalizeComparablePath(session.directory) === workspacePath) || matches[0];
  return { sessionId: normalizeAgentCliSessionId(match?.id), error: '' };
}

async function listOpenCodeSessions({ command, workspace, env, waitForChild }) {
  const executionSpec = agentCliExecutionSpec({
    command,
    args: ['session', 'list', '--format', 'json', '--max-count', String(OPENCODE_SESSION_LOOKUP_MAX_COUNT)],
    useShell: false,
  });
  const child = spawn(executionSpec.command, executionSpec.args, {
    shell: executionSpec.shell,
    windowsVerbatimArguments: executionSpec.windowsVerbatimArguments,
    cwd: workspace,
    env: env || process.env,
    windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  let spawnError = null;
  if (child.stdout) child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
  if (child.stderr) child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
  child.on('error', (error) => {
    spawnError = error;
  });
  const exitCode = await waitForChild(child, 15000);
  if (spawnError) return { items: [], error: spawnError.message || String(spawnError) };
  if (exitCode !== 0) {
    return { items: [], error: String(stderr || stdout || `exit ${exitCode}`).trim() };
  }
  const output = String(stdout || '').trim();
  if (!output) return { items: [], error: '' };
  try {
    const parsed = JSON.parse(output);
    return { items: Array.isArray(parsed) ? parsed : [], error: '' };
  } catch (error) {
    return { items: [], error: error?.message || String(error) };
  }
}

function normalizeComparablePath(value) {
  const text = String(value || '').trim();
  return text ? path.resolve(text).toLowerCase() : '';
}

function safeWriteStream(stream, text) {
  if (!stream || stream.destroyed || stream.writableEnded || stream.writableFinished) return false;
  try {
    stream.write(text);
    return true;
  } catch {
    return false;
  }
}

function bindRuntimeOperation({ runtime, child, activeOperation, operationKey, registerRuntimeOperation }) {
  if (operationKey) {
    runtime.activeChildren.set(operationKey, child);
    runtime.activeChild = child;
    runtime.activeOperation = activeOperation;
    return operationKey;
  }
  return registerRuntimeOperation(runtime, child, activeOperation);
}

function agentCliExecutionSpec(spawnSpec) {
  const shell = process.platform === 'win32' && spawnSpec.useShell;
  if (process.platform !== 'win32' || shell) {
    return { command: spawnSpec.command, args: spawnSpec.args, shell };
  }
  const resolvedCommand = resolveWindowsCommand(spawnSpec.command);
  if (!/\.(?:bat|cmd)$/i.test(resolvedCommand)) {
    return { command: resolvedCommand, args: spawnSpec.args, shell: false };
  }
  return {
    command: process.env.ComSpec || 'cmd.exe',
    args: ['/d', '/s', '/c', windowsCmdLine(resolvedCommand, spawnSpec.args)],
    shell: false,
    windowsVerbatimArguments: true,
  };
}

function resolveWindowsCommand(command) {
  const raw = normalizeAgentCliCommand(command);
  if (!raw) return raw;
  const hasPath = /[\\/]/.test(raw);
  const pathExts = String(process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD')
    .split(path.delimiter)
    .filter(Boolean);
  const names = path.extname(raw) ? [raw] : pathExts.map((ext) => `${raw}${ext}`);
  const dirs = hasPath ? [''] : String(process.env.PATH || '').split(path.delimiter);
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = hasPath ? path.resolve(name) : path.join(dir, name);
      if (isFile(candidate)) return candidate;
    }
  }
  return raw;
}

function isFile(filePath) {
  try { return fs.statSync(filePath).isFile(); } catch { return false; }
}

function windowsCmdLine(command, args) {
  return ['call', quoteWindowsCmdArg(command), ...args.map(quoteWindowsCmdArg)].join(' ');
}

function quoteWindowsCmdArg(value) {
  const text = String(value);
  if (!text) return '""';
  if (!/[\s&()^%!"<>|]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function appendOperationBuffer(activeOperation, text) {
  activeOperation.logBuffer = (activeOperation.logBuffer || '') + text;
  if (activeOperation.logBuffer.length > 24000) {
    activeOperation.logBuffer = activeOperation.logBuffer.slice(-16000);
  }
}

function agentCliActivity(activeOperation) {
  if (Array.isArray(activeOperation.activity)) return activeOperation.activity;
  if (activeOperation.activity && typeof activeOperation.activity.getLines === 'function') {
    return activeOperation.activity.getLines();
  }
  return [];
}

function formatDurationMs(milliseconds) {
  const seconds = Math.max(1, Math.round(Number(milliseconds || 0) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  return `${minutes}m`;
}

function readableAgentCliError({ provider, command, exitCode, error, logFile }) {
  if (exitCode === 0 && !error) return '';
  const displayName = AGENT_CLI_DISPLAY_NAMES[normalizeAgentCliProvider(provider)] || 'Agent CLI';
  const resolvedCommand = normalizeAgentCliCommand(command) || defaultAgentCliCommand(provider);
  if (error) return `${displayName} CLI 启动失败（${resolvedCommand}）：${error.message || String(error)}`;
  const logHint = logFile ? `，日志：${logFile}` : '';
  return `${displayName} CLI 退出码 ${exitCode}${logHint}`;
}

function readableAgentCliLastFileError({ provider, command, lastFile, error }) {
  const displayName = AGENT_CLI_DISPLAY_NAMES[normalizeAgentCliProvider(provider)] || 'Agent CLI';
  const resolvedCommand = normalizeAgentCliCommand(command) || defaultAgentCliCommand(provider);
  return `${displayName} CLI last message 写入失败（${resolvedCommand} -> ${lastFile}）：${error.message || String(error)}`;
}

module.exports = {
  AGENT_CLI_PROVIDERS,
  DEFAULT_AGENT_CLI_PROVIDER,
  agentCliSpawnSpec,
  claudeCliArgs,
  claudeSessionArgs,
  codexNewSessionArgs,
  codexResumeSessionArgs,
  ompCliArgs,
  normalizeCodexReasoningEffort,
  normalizeAgentCliCommand,
  normalizeAgentCliProvider,
  readableAgentCliError,
  runAgentCliAttempt,
};
