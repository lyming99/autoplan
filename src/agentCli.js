const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const DEFAULT_AGENT_CLI_PROVIDER = 'codex';
const AGENT_CLI_PROVIDERS = new Set([DEFAULT_AGENT_CLI_PROVIDER, 'claude']);
const DEFAULT_CODEX_REASONING_EFFORT = 'medium';
const CODEX_REASONING_EFFORTS = new Set(['low', DEFAULT_CODEX_REASONING_EFFORT, 'high']);
const AGENT_CLI_DISPLAY_NAMES = Object.freeze({
  codex: 'Codex',
  claude: 'Claude',
});

function normalizeAgentCliProvider(value) {
  const provider = String(value || '').trim().toLowerCase();
  return AGENT_CLI_PROVIDERS.has(provider) ? provider : DEFAULT_AGENT_CLI_PROVIDER;
}

function normalizeAgentCliCommand(value) {
  return String(value || '').trim();
}

function defaultAgentCliCommand(provider) {
  return normalizeAgentCliProvider(provider);
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

function claudeCliArgs() {
  return [
    '--print',
    '--output-format',
    'text',
    '--dangerously-skip-permissions',
  ];
}

function agentCliSpawnSpec(provider, command, lastFile, codexArgs) {
  const normalizedProvider = normalizeAgentCliProvider(provider);
  const resolvedCommand = normalizeAgentCliCommand(command) || defaultAgentCliCommand(normalizedProvider);
  if (normalizedProvider === 'claude') {
    return {
      provider: normalizedProvider,
      agentCliProvider: normalizedProvider,
      command: resolvedCommand,
      args: claudeCliArgs(),
      lastFileSource: 'stdout',
      useShell: false,
    };
  }
  return {
    provider: normalizedProvider,
    agentCliProvider: normalizedProvider,
    command: resolvedCommand,
    args: codexArgs || [],
    lastFileSource: 'cli',
    useShell: true,
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
    onChunk,
    env,
    timeoutMs = 45 * 60 * 1000,
  } = options;

  const spawnSpec = agentCliSpawnSpec(provider, command, lastFile, codexArgs);
  activeOperation.agentCliProvider = spawnSpec.agentCliProvider;
  activeOperation.agentCliCommand = spawnSpec.command;

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
    if (!runtime.activeOperations.has(nextOperationKey)) return;
    appendOperationBuffer(activeOperation, text);
    if (typeof onChunk === 'function') onChunk(text, { operationKey: nextOperationKey, spawnSpec });
    if (activeOperation.activity) activeOperation.activity.offer(text);
  };

  if (child.stdout) {
    child.stdout.on('data', (chunk) => handleChunk(chunk, 'stdout'));
    child.stdout.pipe(stream, { end: false });
  }
  if (child.stderr) {
    child.stderr.on('data', (chunk) => handleChunk(chunk, 'stderr'));
    child.stderr.pipe(stream, { end: false });
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
    if (stream && !stream.destroyed) stream.write(text);
    if (!runtime.activeOperations.has(nextOperationKey)) return;
    appendOperationBuffer(activeOperation, text);
    activeOperation.errorMessage = message;
  });

  if (child.stdin) {
    child.stdin.setDefaultEncoding('utf8');
    child.stdin.end(prompt);
  }

  let exitCode = await waitForChild(child, timeoutMs);
  const timedOut = Boolean(child.__autoplanTimedOut);
  const timeoutMessage = timedOut
    ? `${AGENT_CLI_DISPLAY_NAMES[spawnSpec.agentCliProvider] || 'Agent CLI'} CLI timed out after ${formatDurationMs(timeoutMs)}`
    : '';
  if (timeoutMessage) {
    const text = `\n[AutoPlan] ${timeoutMessage}\n`;
    output += text;
    if (stream && !stream.destroyed) stream.write(text);
    if (runtime.activeOperations.has(nextOperationKey)) {
      appendOperationBuffer(activeOperation, text);
      activeOperation.errorMessage = timeoutMessage;
    }
  }
  let lastFileError = null;
  if (spawnSpec.lastFileSource === 'stdout') {
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
      if (stream && !stream.destroyed) stream.write(text);
      if (runtime.activeOperations.has(nextOperationKey)) {
        appendOperationBuffer(activeOperation, text);
      }
    }
  }
  if (runtime.activeOperations.has(nextOperationKey)) activeOperation.exitCode = exitCode;
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
  };
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
  const names = path.extname(raw) ? [raw] : [raw, ...pathExts.map((ext) => `${raw}${ext}`)];
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
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
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
  codexNewSessionArgs,
  codexResumeSessionArgs,
  normalizeCodexReasoningEffort,
  normalizeAgentCliCommand,
  normalizeAgentCliProvider,
  readableAgentCliError,
  runAgentCliAttempt,
};
