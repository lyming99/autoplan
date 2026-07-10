const { describe, it } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const createYargs = require('yargs/yargs');

const {
  AGENT_CLI_PROVIDERS,
  WIN_CMD_LIMIT,
  WIN_CREATEPROCESS_LIMIT,
  agentCliSpawnSpec,
  buildClaudeEnv,
  claudeCliArgs,
  claudeSessionArgs,
  codexNewSessionArgs,
  codexResumeSessionArgs,
  createChunkDecoder,
  normalizeAgentCliProvider,
  normalizeCodexReasoningEffort,
  runAgentCliAttempt,
  writePromptSpilloverFile,
} = require('./agentCli');

function expectEqual(actual, expected) {
  if (actual !== expected) {
    throw new Error(`Expected ${JSON.stringify(actual)} to equal ${JSON.stringify(expected)}`);
  }
}

function expectIncludes(items, expected) {
  if (!items.includes(expected)) {
    throw new Error(`Expected ${JSON.stringify(items)} to include ${JSON.stringify(expected)}`);
  }
}

function expectNotIncludes(items, expected) {
  if (items.includes(expected)) {
    throw new Error(`Expected ${JSON.stringify(items)} not to include ${JSON.stringify(expected)}`);
  }
}

function expectTruthy(value) {
  if (!value) {
    throw new Error(`Expected ${JSON.stringify(value)} to be truthy`);
  }
}

function structuredPlanPrompt(eol) {
  return [
    '你是需求整理与开发计划生成者。',
    '',
    '## 原始需求',
    '修正 OpenCode prompt 附件参数绑定，并固化真实参数解析回归。',
    '',
    '## PlanSpec 输出契约',
    'PlanSpec JSON 输出路径：D:/project/GitHub/autoplan/docs/progress/plan-spec-feedback-9.json',
    '格式契约：只能输出包含 title、summary、tasks 和 validation 的合法 PlanSpec JSON。',
    'tasks 必须包含连续 P001 编号、精确 scope 和完整验收要点，最后一项必须是 validation。',
    '',
    '## 引用上下文',
    '反馈 #9 日志：OpenCode 1.17.15 报错 File not found: 你的完整唯一指令已作为附件提供。',
    '已确认 run [message..] 是位置消息数组，-f/--file 是文件数组。',
    '仓库上下文：src/agentCli.js 负责 provider 参数组装和 prompt 投递。',
    '',
    '只写入上述目标文件，不要改动 Markdown plan 或勾选 checkbox。',
  ].join(eol);
}

function createAgentCliTestContext(operationKey, extraOperation = {}) {
  const activeOperation = { label: 'OpenCode structured plan test', ...extraOperation };
  return {
    activeOperation,
    runtime: {
      activeOperation,
      activeChild: null,
      activeOperations: new Map([[operationKey, activeOperation]]),
      activeChildren: new Map(),
    },
  };
}

function waitForTestChild(child) {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (exitCode) => {
      if (settled) return;
      settled = true;
      resolve(Number.isInteger(exitCode) ? exitCode : -1);
    };
    child.once('error', () => finish(-1));
    child.once('exit', finish);
  });
}

function writeOpenCodeCmdShim(root, options = {}) {
  const exitCode = Number.isInteger(options.exitCode) ? options.exitCode : 0;
  const delay = options.delay ? 'ping 127.0.0.1 -n 3 >nul\r\n' : '';
  let capture = '';
  if (options.captureArgsFile) {
    const recorderPath = path.join(root, `capture-opencode-args-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.js`);
    fs.writeFileSync(
      recorderPath,
      `require('node:fs').writeFileSync(${JSON.stringify(options.captureArgsFile)}, JSON.stringify(process.argv.slice(2)), 'utf8');\n`,
      'utf8',
    );
    capture = `"${process.execPath}" "${recorderPath}" %*\r\n`;
  }
  const shimPath = path.join(root, `opencode-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.cmd`);
  fs.writeFileSync(shimPath, `@echo off\r\n${delay}${capture}echo shim-output\r\nexit /b ${exitCode}\r\n`, 'utf8');
  return shimPath;
}

// 与 OpenCode 1.17.15 `run [message..]` / `-f, --file [file..]` 相同的 yargs 语法。
// 使用真实解析器验证参数归属，避免仅凭命令字符串顺序产生无法发现 greedy file[] 的假阳性。
function parseOpenCodeRunArgs(args) {
  return createYargs(args)
    .exitProcess(false)
    .help(false)
    .version(false)
    .command(
      'run [message..]',
      false,
      (parser) => parser
        .positional('message', { type: 'string', array: true })
        .option('format', { type: 'string' })
        .option('auto', { type: 'boolean' })
        .option('session', { type: 'string' })
        .option('title', { type: 'string' })
        .option('agent', { type: 'string' })
        .option('file', { alias: 'f', type: 'string', array: true }),
    )
    .parse();
}

function promptAttachmentFiles(workspace) {
  const promptDir = path.join(workspace, 'docs', 'progress', 'prompt-tmp');
  if (!fs.existsSync(promptDir)) return [];
  return fs.readdirSync(promptDir)
    .filter((name) => name.startsWith('prompt-') && name.endsWith('.md'))
    .map((name) => path.join(promptDir, name));
}

function runOpenCodeTestAttempt({ workspace, prompt, command, waitForChild, env }) {
  const operationKey = `op-opencode-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const { activeOperation, runtime } = createAgentCliTestContext(operationKey, { structuredPlan: true });
  return runAgentCliAttempt({
    workspace,
    prompt,
    lastFile: path.join(workspace, 'last.txt'),
    logFile: path.join(workspace, 'agent.log'),
    runtime,
    activeOperation,
    operationKey,
    waitForChild,
    stream: { write() { return true; } },
    provider: 'opencode',
    command,
    agentCliOptions: {
      sessionId: 'ses_plan_feedback_9',
      title: 'AutoPlan feedback 9 structured plan',
      agent: 'autoplan-plan',
      structuredPlan: true,
    },
    timeoutMs: 2000,
    ...(env ? { env } : {}),
  });
}

describe('Agent CLI timeout handling', () => {
  it('marks timed-out attempts and returns timeout metadata', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autoplan-agent-timeout-'));
    try {
      const activeOperation = { label: 'timeout test' };
      const runtime = {
        activeOperation,
        activeChild: null,
        activeOperations: new Map([['op-timeout', activeOperation]]),
        activeChildren: new Map(),
      };
      const writes = [];

      const result = await runAgentCliAttempt({
        workspace: tmpRoot,
        prompt: 'timeout prompt',
        lastFile: path.join(tmpRoot, 'last.txt'),
        logFile: path.join(tmpRoot, 'agent.log'),
        runtime,
        activeOperation,
        operationKey: 'op-timeout',
        waitForChild: async (child, timeoutMs) => {
          expectEqual(timeoutMs, 2000);
          child.__autoplanTimedOut = true;
          try { child.kill(); } catch (_) { /* ignore cleanup races in timeout simulation */ }
          return -1;
        },
        stream: {
          write(text) {
            writes.push(text);
            return true;
          },
        },
        provider: 'codex',
        command: process.execPath,
        codexArgs: [],
        timeoutMs: 2000,
      });

      expectEqual(result.exitCode, -1);
      expectEqual(result.timedOut, true);
      expectEqual(result.timeoutMs, 2000);
      expectEqual(activeOperation.timedOut, true);
      expectEqual(activeOperation.timeoutMs, 2000);
      expectTruthy(/timed out/i.test(result.errorMessage));
      expectTruthy(writes.some((item) => /timed out/i.test(item)));
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});

describe('Codex reasoning effort', () => {
  it('normalizes xhigh while preserving legacy fallbacks', () => {
    expectEqual(normalizeCodexReasoningEffort('xhigh'), 'xhigh');
    expectEqual(normalizeCodexReasoningEffort(' XHIGH '), 'xhigh');
    expectEqual(normalizeCodexReasoningEffort(''), 'medium');
    expectEqual(normalizeCodexReasoningEffort('invalid'), 'medium');
  });

  it('passes xhigh to new and resumed Codex sessions', () => {
    const expectedArg = 'model_reasoning_effort="xhigh"';

    expectIncludes(codexNewSessionArgs('last.txt', { reasoningEffort: 'xhigh' }), expectedArg);
    expectIncludes(codexResumeSessionArgs('session-id', 'last.txt', { reasoningEffort: 'xhigh' }), expectedArg);
  });

  it('does not add Codex reasoning args to Claude CLI specs', () => {
    const spec = agentCliSpawnSpec('claude', 'claude', 'last.txt', ['-c', 'model_reasoning_effort="xhigh"']);

    expectEqual(spec.agentCliProvider, 'claude');
    expectNotIncludes(spec.args, 'model_reasoning_effort="xhigh"');
  });
});

describe('Codex 非受信任目录参数构造', () => {
  it('新会话在 stdin 占位符前注入仓库检查绕过参数，并保留既有关键参数顺序', () => {
    const args = codexNewSessionArgs('last.txt', { reasoningEffort: 'high' });
    const ordered = [
      'exec',
      '-c',
      'model_reasoning_effort="high"',
      '--color',
      'never',
      '-o',
      'last.txt',
      '--sandbox',
      'danger-full-access',
      '--skip-git-repo-check',
      '-',
    ];

    let prev = -1;
    for (const item of ordered) {
      const idx = args.indexOf(item);
      expectTruthy(idx > prev);
      prev = idx;
    }
    expectEqual(args[args.length - 2], '--skip-git-repo-check');
    expectEqual(args[args.length - 1], '-');
  });

  it('恢复会话在 sessionId 与 stdin 占位符前注入仓库检查绕过参数，并保留输出与 reasoning 参数', () => {
    const sessionId = '00000000-aaaa-bbbb-cccc-000000000001';
    const args = codexResumeSessionArgs(sessionId, 'last.txt', { reasoningEffort: 'low' });
    const ordered = [
      'exec',
      'resume',
      '-c',
      'model_reasoning_effort="low"',
      '-o',
      'last.txt',
      '--skip-git-repo-check',
      sessionId,
      '-',
    ];

    let prev = -1;
    for (const item of ordered) {
      const idx = args.indexOf(item);
      expectTruthy(idx > prev);
      prev = idx;
    }
    expectEqual(args[args.length - 2], sessionId);
    expectEqual(args[args.length - 1], '-');
  });
});

describe('Codex 新会话参数构造（反馈 #92：移除 --cd）', () => {
  it('不包含 --cd / -C，且 workspace 值不会作为裸位置参数泄漏到末尾 - 之前', () => {
    const args = codexNewSessionArgs('last.txt', { reasoningEffort: 'medium' });

    expectNotIncludes(args, '--cd');
    expectNotIncludes(args, '-C');
    // 反馈 #92 前 workspace（如 'D:/workspace'）会被作为 args 元素注入；移除后不应再泄漏。
    expectNotIncludes(args, 'D:/workspace');
    expectNotIncludes(args, '/workspace');
    // stdin prompt 占位符 '-' 仍是末尾元素，前面不应混入 workspace 之类的裸位置参数。
    expectEqual(args[args.length - 1], '-');
    expectNotIncludes(args.slice(0, -1), 'D:/workspace');
  });

  it('保留 exec / --color / never / -o / --sandbox / danger-full-access / - 关键元素及顺序', () => {
    const args = codexNewSessionArgs('last.txt', { reasoningEffort: 'medium' });
    const ordered = ['exec', '--color', 'never', '-o', 'last.txt', '--sandbox', 'danger-full-access', '-'];

    let prev = -1;
    for (const item of ordered) {
      expectIncludes(args, item);
      const idx = args.indexOf(item);
      expectTruthy(idx > prev);
      prev = idx;
    }
  });

  it('reasoningEffort 取 low/medium/high/xhigh 及缺省回退时结构稳定且始终无 --cd', () => {
    for (const effort of ['low', 'medium', 'high', 'xhigh']) {
      const args = codexNewSessionArgs('last.txt', { reasoningEffort: effort });

      expectNotIncludes(args, '--cd');
      expectIncludes(args, `model_reasoning_effort="${effort}"`);
      expectIncludes(args, 'exec');
      expectIncludes(args, '--sandbox');
      expectIncludes(args, 'danger-full-access');
      expectEqual(args[args.length - 1], '-');
    }

    // 缺省回退到 medium，结构同样稳定且无 --cd。
    const fallbackArgs = codexNewSessionArgs('last.txt');
    expectNotIncludes(fallbackArgs, '--cd');
    expectIncludes(fallbackArgs, 'model_reasoning_effort="medium"');
    expectEqual(fallbackArgs[fallbackArgs.length - 1], '-');
  });
});

describe('Claude session spec', () => {
  it('starts fresh Claude runs without Codex session or reasoning args', () => {
    const spec = agentCliSpawnSpec('claude', '', 'last.txt', [
      'resume',
      'codex-session-id',
      '-c',
      'model_reasoning_effort="xhigh"',
      '--skip-git-repo-check',
    ]);

    expectEqual(spec.command, 'claude');
    expectEqual(spec.agentCliProvider, 'claude');
    expectEqual(spec.promptSource, 'stdin');
    expectEqual(spec.lastFileSource, 'claude-stream-json');
    expectEqual(spec.agentCliSessionMode, 'new');
    expectEqual(spec.agentCliSessionId, '');
    expectIncludes(spec.args, '--print');
    expectIncludes(spec.args, '--output-format');
    expectIncludes(spec.args, 'stream-json');
    expectIncludes(spec.args, '--verbose');
    expectIncludes(spec.args, '--dangerously-skip-permissions');
    expectNotIncludes(spec.args, 'resume');
    expectNotIncludes(spec.args, 'codex-session-id');
    expectNotIncludes(spec.args, 'model_reasoning_effort="xhigh"');
    expectNotIncludes(spec.args, '--skip-git-repo-check');
  });

  it('starts Claude with an explicit session id when requested', () => {
    const spec = agentCliSpawnSpec('claude', 'claude', 'last.txt', [], {
      sessionMode: 'session-id',
      sessionId: 'claude-new-session-1',
    });

    expectIncludes(claudeSessionArgs({ sessionMode: 'session-id', sessionId: 'claude-new-session-1' }), '--session-id');
    expectIncludes(spec.args, '--session-id');
    expectIncludes(spec.args, 'claude-new-session-1');
    expectEqual(spec.agentCliSessionId, 'claude-new-session-1');
    expectEqual(spec.agentCliSessionRequestedId, '');
    expectEqual(spec.agentCliSessionMode, 'session-id');
  });

  it('resumes Claude sessions with the requested session id', () => {
    const spec = agentCliSpawnSpec('claude', 'claude', 'last.txt', [], {
      agentCliSessionRequestedId: 'claude-plan-session-1',
    });

    expectIncludes(claudeCliArgs({ agentCliSessionRequestedId: 'claude-plan-session-1' }), '--resume');
    expectIncludes(spec.args, '--resume');
    expectIncludes(spec.args, 'claude-plan-session-1');
    expectEqual(spec.agentCliSessionId, 'claude-plan-session-1');
    expectEqual(spec.agentCliSessionRequestedId, 'claude-plan-session-1');
    expectEqual(spec.agentCliSessionMode, 'resume');
  });

  it('supports Claude continue mode without leaking stale session ids', () => {
    const spec = agentCliSpawnSpec('claude', 'claude', 'last.txt', [], {
      agentCliSessionMode: 'continue',
      agentCliSessionId: 'claude-stale-session',
    });

    expectIncludes(spec.args, '--continue');
    expectNotIncludes(spec.args, 'claude-stale-session');
    expectEqual(spec.agentCliSessionId, '');
    expectEqual(spec.agentCliSessionRequestedId, '');
    expectEqual(spec.agentCliSessionMode, 'continue');
  });
});

describe('Claude custom connection env injection', () => {
  it('buildClaudeEnv maps fields to ANTHROPIC_* variables and skips empties', () => {
    // 全部非空：三个变量都注入。
    const full = buildClaudeEnv({
      baseUrl: 'https://gateway.example.com',
      authToken: 'sk-test-123',
      model: 'claude-sonnet-4-5',
    });
    expectEqual(full.ANTHROPIC_BASE_URL, 'https://gateway.example.com');
    expectEqual(full.ANTHROPIC_AUTH_TOKEN, 'sk-test-123');
    expectEqual(full.ANTHROPIC_MODEL, 'claude-sonnet-4-5');

    // 部分为空：仅注入非空字段，避免覆盖用户 settings.json 的合法配置。
    const partial = buildClaudeEnv({ baseUrl: '', authToken: 'sk-only', model: '  ' });
    expectEqual(partial.ANTHROPIC_AUTH_TOKEN, 'sk-only');
    expectEqual(partial.ANTHROPIC_BASE_URL, undefined);
    expectEqual(partial.ANTHROPIC_MODEL, undefined);

    // 全空：返回 null，调用方跳过合并。
    expectEqual(buildClaudeEnv({}), null);
    expectEqual(buildClaudeEnv(undefined), null);
  });

  it('agentCliSpawnSpec exposes env only when claudeEnv options are provided', () => {
    const withEnv = agentCliSpawnSpec('claude', 'claude', 'last.txt', [], {
      claudeEnv: { baseUrl: 'https://plan.example.com', authToken: 'sk-plan', model: 'claude-plan' },
    });
    expectEqual(withEnv.env.ANTHROPIC_BASE_URL, 'https://plan.example.com');
    expectEqual(withEnv.env.ANTHROPIC_AUTH_TOKEN, 'sk-plan');
    expectEqual(withEnv.env.ANTHROPIC_MODEL, 'claude-plan');

    // 未提供 claudeEnv：env 为 null，spawn 时不会合并任何 ANTHROPIC_* 变量（保留 settings.json）。
    const withoutEnv = agentCliSpawnSpec('claude', 'claude', 'last.txt', [], {});
    expectEqual(withoutEnv.env, null);
  });

  it('agentCliSpawnSpec env not present for non-claude providers', () => {
    // codex/opencode/oh-my-pi 分支不应注入 Claude env（buildClaudeEnv 仅在 claude 分支调用）。
    const codexSpec = agentCliSpawnSpec('codex', 'codex', 'last.txt', ['-c', 'model_reasoning_effort="high"']);
    expectEqual(codexSpec.env, undefined);
  });
});

describe('OpenCode backend spec', () => {
  it('normalizes opencode and degrades unknown providers to codex', () => {
    expectIncludes([...AGENT_CLI_PROVIDERS], 'opencode');
    expectEqual(normalizeAgentCliProvider('opencode'), 'opencode');
    expectEqual(normalizeAgentCliProvider('OPENCODE'), 'opencode');
    expectEqual(normalizeAgentCliProvider('unknown-backend'), 'codex');
    expectEqual(normalizeAgentCliProvider(''), 'codex');
    expectEqual(normalizeAgentCliProvider(null), 'codex');
  });

  it('resolves the default opencode command and keeps custom command paths', () => {
    expectEqual(agentCliSpawnSpec('opencode', '', 'last.txt').command, 'opencode');
    expectEqual(agentCliSpawnSpec('opencode', '/usr/local/bin/opencode', 'last.txt').command, '/usr/local/bin/opencode');
  });

  it('produces opencode spawn args with stdout output and positional prompt', () => {
    const spec = agentCliSpawnSpec(
      'opencode',
      'opencode',
      'last.txt',
      ['-c', 'model_reasoning_effort="xhigh"', 'resume', 'session-id'],
    );

    expectEqual(spec.agentCliProvider, 'opencode');
    expectIncludes(spec.args, 'run');
    expectIncludes(spec.args, '--format');
    expectEqual(spec.promptSource, 'argument');
    expectEqual(spec.lastFileSource, 'stdout');
    expectEqual(spec.useShell, false);
  });

  it('keeps opencode specs free of Codex reasoning and session flags', () => {
    const spec = agentCliSpawnSpec(
      'opencode',
      'opencode',
      'last.txt',
      ['-c', 'model_reasoning_effort="xhigh"', 'resume', '--skip-git-repo-check'],
    );

    expectNotIncludes(spec.args, 'model_reasoning_effort');
    expectNotIncludes(spec.args, 'resume');
    expectNotIncludes(spec.args, 'session-id');
    expectNotIncludes(spec.args, '--skip-git-repo-check');
  });

  it('passes OpenCode session options as native run flags', () => {
    const spec = agentCliSpawnSpec(
      'opencode',
      'opencode',
      'last.txt',
      [],
      { sessionId: 'ses_12345', title: 'AutoPlan project 1 plan 2' },
    );

    expectIncludes(spec.args, '--session');
    expectIncludes(spec.args, 'ses_12345');
    expectIncludes(spec.args, '--title');
    expectIncludes(spec.args, 'AutoPlan project 1 plan 2');
    expectEqual(spec.agentCliSessionId, 'ses_12345');
    expectEqual(spec.agentCliSessionTitle, 'AutoPlan project 1 plan 2');
  });
});

describe('OpenCode 无人值守权限参数回归', () => {
  it('普通任务执行精确使用 run --format default --auto，并移除失效的旧权限参数', () => {
    const spec = agentCliSpawnSpec('opencode', 'opencode', 'last.txt');

    expectEqual(
      JSON.stringify(spec.args),
      JSON.stringify(['run', '--format', 'default', '--auto']),
    );
    expectNotIncludes(spec.args, '--dangerously-skip-permissions');
  });

  it('会话恢复在 --auto 后按合法顺序追加 --session 与 --title', () => {
    const spec = agentCliSpawnSpec('opencode', 'opencode', 'last.txt', [], {
      sessionId: 'ses_12345',
      title: 'AutoPlan project 1 plan 2',
    });

    expectEqual(
      JSON.stringify(spec.args),
      JSON.stringify([
        'run',
        '--format',
        'default',
        '--auto',
        '--session',
        'ses_12345',
        '--title',
        'AutoPlan project 1 plan 2',
      ]),
    );
    expectNotIncludes(spec.args, '--dangerously-skip-permissions');
  });

  it('结构化计划生成在权限、会话和标题参数后注入 autoplan-plan agent', () => {
    const spec = agentCliSpawnSpec('opencode', 'opencode', 'last.txt', [], {
      sessionId: 'ses_plan_12345',
      title: 'AutoPlan structured plan',
      agent: 'autoplan-plan',
      structuredPlan: true,
    });

    expectEqual(
      JSON.stringify(spec.args),
      JSON.stringify([
        'run',
        '--format',
        'default',
        '--auto',
        '--session',
        'ses_plan_12345',
        '--title',
        'AutoPlan structured plan',
        '--agent',
        'autoplan-plan',
      ]),
    );
    expectNotIncludes(spec.args, '--dangerously-skip-permissions');
    expectEqual(spec.opencodeAgent, 'autoplan-plan');
    expectEqual(spec.structuredPlan, true);
  });

  it('OpenCode 的 --auto 不泄漏到 Claude、Codex 与 Oh My Pi', () => {
    const claudeSpec = agentCliSpawnSpec('claude', 'claude', 'last.txt');
    const codexSpec = agentCliSpawnSpec('codex', 'codex', 'last.txt', codexNewSessionArgs('last.txt'));
    const ompSpec = agentCliSpawnSpec('oh-my-pi', 'omp', 'last.txt');

    expectIncludes(claudeSpec.args, '--dangerously-skip-permissions');
    expectNotIncludes(claudeSpec.args, '--auto');
    expectNotIncludes(codexSpec.args, '--auto');
    expectNotIncludes(ompSpec.args, '--auto');
  });
});

describe('OpenCode 计划生成专用 agent 注入（P002）', () => {
  it('传入 agent 选项时 spawn 参数含 --agent autoplan-plan', () => {
    const spec = agentCliSpawnSpec('opencode', 'opencode', 'last.txt', [], { agent: 'autoplan-plan' });

    expectIncludes(spec.args, '--agent');
    expectIncludes(spec.args, 'autoplan-plan');
    expectEqual(spec.opencodeAgent, 'autoplan-plan');
  });

  it('不传 agent 选项时（任务执行/修复）参数不含 --agent', () => {
    const spec = agentCliSpawnSpec('opencode', 'opencode', 'last.txt', [], {
      sessionId: 'ses_12345',
      title: 'AutoPlan task exec',
    });

    expectNotIncludes(spec.args, '--agent');
    expectEqual(spec.opencodeAgent, undefined);
  });

  it('--agent 位于 --format / --session / --title 之后，值紧随其后', () => {
    const spec = agentCliSpawnSpec('opencode', 'opencode', 'last.txt', [], {
      sessionId: 'ses_12345',
      title: 'AutoPlan title',
      agent: 'autoplan-plan',
    });
    const args = spec.args;
    const idxFormat = args.indexOf('--format');
    const idxSession = args.indexOf('--session');
    const idxTitle = args.indexOf('--title');
    const idxAgent = args.indexOf('--agent');

    expectTruthy(idxFormat >= 0 && idxSession >= 0 && idxTitle >= 0 && idxAgent >= 0);
    expectTruthy(idxAgent > idxFormat);
    expectTruthy(idxAgent > idxSession);
    expectTruthy(idxAgent > idxTitle);
    expectEqual(args[idxAgent + 1], 'autoplan-plan');
  });

  it('拒绝非法 agent 名（含空格/特殊字符），不注入 --agent', () => {
    const spec = agentCliSpawnSpec('opencode', 'opencode', 'last.txt', [], {
      agent: 'Bad Agent!; rm -rf',
    });

    expectNotIncludes(spec.args, '--agent');
  });
});

describe('Oh My Pi backend spec', () => {
  it('normalizes oh-my-pi and degrades unknown providers to codex', () => {
    expectIncludes([...AGENT_CLI_PROVIDERS], 'oh-my-pi');
    expectEqual(normalizeAgentCliProvider('oh-my-pi'), 'oh-my-pi');
    expectEqual(normalizeAgentCliProvider('OH-MY-PI'), 'oh-my-pi');
    expectEqual(normalizeAgentCliProvider('Oh-My-Pi'), 'oh-my-pi');
    expectEqual(normalizeAgentCliProvider('unknown-backend'), 'codex');
    expectEqual(normalizeAgentCliProvider(''), 'codex');
    expectEqual(normalizeAgentCliProvider(null), 'codex');
  });

  it('resolves the default omp command and keeps custom command paths', () => {
    expectEqual(agentCliSpawnSpec('oh-my-pi', '', 'last.txt').command, 'omp');
    expectEqual(agentCliSpawnSpec('oh-my-pi', '/usr/local/bin/omp', 'last.txt').command, '/usr/local/bin/omp');
  });

  it('produces oh-my-pi spawn args with stdin prompt and stdout output', () => {
    const spec = agentCliSpawnSpec(
      'oh-my-pi',
      'omp',
      'last.txt',
      ['-c', 'model_reasoning_effort="xhigh"', 'resume', 'session-id'],
    );

    expectEqual(spec.agentCliProvider, 'oh-my-pi');
    expectIncludes(spec.args, '--print');
    expectEqual(spec.promptSource, 'stdin');
    expectEqual(spec.lastFileSource, 'stdout');
    expectEqual(spec.useShell, false);
  });

  it('keeps oh-my-pi specs stateless and free of other provider flags', () => {
    const spec = agentCliSpawnSpec(
      'oh-my-pi',
      'omp',
      'last.txt',
      ['-c', 'model_reasoning_effort="xhigh"', 'resume', 'session-id', '--skip-git-repo-check'],
      { sessionId: 'ses_12345', title: 'AutoPlan project 1 plan 2' },
    );

    // 无状态后端：不产出任何会话字段。
    expectEqual(spec.agentCliSessionId, undefined);
    expectEqual(spec.agentCliSessionTitle, undefined);
    expectEqual(spec.agentCliSessionMode, undefined);

    // 不含 Codex 思考深度 / 会话标志。
    expectNotIncludes(spec.args, 'model_reasoning_effort');
    expectNotIncludes(spec.args, 'resume');
    expectNotIncludes(spec.args, 'session-id');
    expectNotIncludes(spec.args, 'exec');
    expectNotIncludes(spec.args, '--skip-git-repo-check');
    // 不含 Claude stream-json / 会话续接标志（--print 为 omp 自身非交互标志，需保留）。
    expectNotIncludes(spec.args, 'stream-json');
    expectNotIncludes(spec.args, '--output-format');
    expectNotIncludes(spec.args, '--verbose');
    expectNotIncludes(spec.args, '--dangerously-skip-permissions');
    // 不含 OpenCode run/session/title 标志。
    expectNotIncludes(spec.args, 'run');
    expectNotIncludes(spec.args, '--format');
    expectNotIncludes(spec.args, '--session');
    expectNotIncludes(spec.args, '--title');
  });
});

describe('OpenCode prompt spillover (命令行长度与 Windows 多行安全投递)', () => {
  it('keeps a short single-line prompt as the existing positional argument', () => {
    const spec = agentCliSpawnSpec('opencode', path.join(os.tmpdir(), 'opencode.cmd'), 'last.txt');
    expectEqual(writePromptSpilloverFile(spec, 'short prompt', os.tmpdir()), null);
  });

  it('does not apply argument spillover to Codex, Claude, or Oh My Pi stdin prompts', () => {
    const longMultilinePrompt = `first line\n${'x'.repeat(WIN_CMD_LIMIT + 1000)}`;
    const codexSpec = agentCliSpawnSpec('codex', 'codex', 'last.txt', ['exec']);
    const claudeSpec = agentCliSpawnSpec('claude', 'claude', 'last.txt');
    const ompSpec = agentCliSpawnSpec('oh-my-pi', 'omp', 'last.txt');

    expectEqual(writePromptSpilloverFile(codexSpec, longMultilinePrompt, os.tmpdir()), null);
    expectEqual(writePromptSpilloverFile(claudeSpec, longMultilinePrompt, os.tmpdir()), null);
    expectEqual(writePromptSpilloverFile(ompSpec, longMultilinePrompt, os.tmpdir()), null);
  });

  it('keeps a low-length multiline prompt direct for a Windows native executable', () => {
    const nativeSpec = agentCliSpawnSpec(
      'opencode',
      path.join(os.tmpdir(), 'opencode-native.exe'),
      'last.txt',
    );
    expectEqual(writePromptSpilloverFile(nativeSpec, structuredPlanPrompt('\n'), os.tmpdir()), null);
  });

  for (const newlineCase of [
    { label: 'LF', eol: '\n' },
    { label: 'CRLF', eol: '\r\n' },
  ]) {
    it(`delivers a realistic low-length structured plan prompt through an attachment (${newlineCase.label})`, {
      skip: process.platform !== 'win32',
    }, async () => {
      const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autoplan-structured-prompt-'));
      const prompt = structuredPlanPrompt(newlineCase.eol);
      const capturedArgsFile = path.join(tmpRoot, 'opencode-args.json');
      const shimPath = writeOpenCodeCmdShim(tmpRoot, { captureArgsFile: capturedArgsFile });
      let observedDelivery = null;
      try {
        expectTruthy(prompt.length < WIN_CMD_LIMIT);
        const result = await runOpenCodeTestAttempt({
          workspace: tmpRoot,
          prompt,
          command: shimPath,
          waitForChild: async (child) => {
            const exitCode = await waitForTestChild(child);
            const attachments = promptAttachmentFiles(tmpRoot);
            const attachmentPath = attachments[0];
            const actualArgs = JSON.parse(fs.readFileSync(capturedArgsFile, 'utf8'));
            observedDelivery = {
              attachmentCount: attachments.length,
              attachmentPath,
              attachment: fs.readFileSync(attachmentPath, 'utf8'),
              actualArgs,
              parsedArgs: parseOpenCodeRunArgs(actualArgs),
              commandLine: child.spawnargs[child.spawnargs.length - 1],
            };
            return exitCode;
          },
        });

        expectEqual(result.exitCode, 0);
        expectTruthy(observedDelivery);
        expectEqual(observedDelivery.attachmentCount, 1);
        expectEqual(observedDelivery.attachment, prompt);
        expectEqual(/[\r\n]/.test(observedDelivery.commandLine), false);
        expectNotIncludes(observedDelivery.commandLine, prompt);
        expectNotIncludes(observedDelivery.commandLine, '你是需求整理与开发计划生成者。');

        expectEqual(observedDelivery.parsedArgs.format, 'default');
        expectEqual(observedDelivery.parsedArgs.auto, true);
        expectEqual(observedDelivery.parsedArgs.session, 'ses_plan_feedback_9');
        expectEqual(observedDelivery.parsedArgs.title, 'AutoPlan feedback 9 structured plan');
        expectEqual(observedDelivery.parsedArgs.agent, 'autoplan-plan');
        expectEqual(observedDelivery.parsedArgs.message.length, 1);
        expectIncludes(observedDelivery.parsedArgs.message[0], observedDelivery.attachmentPath);
        expectIncludes(observedDelivery.parsedArgs.message[0], '必须完整读取');
        expectEqual(
          JSON.stringify(observedDelivery.parsedArgs.file),
          JSON.stringify([observedDelivery.attachmentPath]),
        );
        expectNotIncludes(observedDelivery.parsedArgs.file, observedDelivery.parsedArgs.message[0]);

        expectEqual(fs.existsSync(observedDelivery.attachmentPath), false);
        expectEqual(promptAttachmentFiles(tmpRoot).length, 0);
      } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
      }
    });
  }

  it('spills the 14700-character cmd.exe requirement scenario without truncating content', {
    skip: process.platform !== 'win32',
  }, () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autoplan-spillover-'));
    try {
      const spec = agentCliSpawnSpec('opencode', path.join(tmpRoot, 'opencode.cmd'), 'last.txt');
      const prompt = '需求：' + 'x'.repeat(14697);
      const spillover = writePromptSpilloverFile(spec, prompt, tmpRoot);

      expectTruthy(spillover);
      expectEqual(spillover.promptChars, 14700);
      expectEqual(fs.readFileSync(spillover.filePath, 'utf8'), prompt);
      expectIncludes(spillover.pointerMessage, spillover.filePath);
      expectIncludes(spillover.pointerMessage, '禁止转而探索');
      expectIncludes(spillover.pointerMessage, '必须完整读取');
      expectTruthy(spillover.pointerMessage.length < WIN_CMD_LIMIT);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('preserves over-limit spillover for a Windows native executable', {
    skip: process.platform !== 'win32',
  }, () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autoplan-native-spillover-'));
    try {
      const spec = agentCliSpawnSpec('opencode', path.join(tmpRoot, 'opencode.exe'), 'last.txt');
      const prompt = 'x'.repeat(WIN_CREATEPROCESS_LIMIT + 1000);
      const spillover = writePromptSpilloverFile(spec, prompt, tmpRoot);

      expectTruthy(spillover);
      expectEqual(fs.readFileSync(spillover.filePath, 'utf8'), prompt);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('cleans multiline attachments after nonzero exit, timeout, and synchronous spawn failure', {
    skip: process.platform !== 'win32',
  }, async () => {
    const scenarios = [
      { name: 'nonzero', exitCode: 7, expectedExitCode: 7 },
      { name: 'timeout', delay: true, expectedExitCode: -1, timedOut: true },
      {
        name: 'spawn-failure',
        expectedExitCode: -1,
        env: { ...process.env, AUTOPLAN_INVALID_ENV: 'invalid\0value' },
      },
    ];

    for (const scenario of scenarios) {
      const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), `autoplan-${scenario.name}-`));
      try {
        const shimPath = writeOpenCodeCmdShim(tmpRoot, scenario);
        let attachmentObserved = false;
        const result = await runOpenCodeTestAttempt({
          workspace: tmpRoot,
          prompt: structuredPlanPrompt('\n'),
          command: shimPath,
          env: scenario.env,
          waitForChild: async (child) => {
            attachmentObserved = promptAttachmentFiles(tmpRoot).length === 1;
            if (scenario.timedOut) {
              child.__autoplanTimedOut = true;
              try { child.kill(); } catch (_) { /* process may have already exited */ }
              await waitForTestChild(child);
              return -1;
            }
            return waitForTestChild(child);
          },
        });

        expectEqual(result.exitCode, scenario.expectedExitCode);
        expectEqual(promptAttachmentFiles(tmpRoot).length, 0);
        if (scenario.name !== 'spawn-failure') expectEqual(attachmentObserved, true);
        if (scenario.timedOut) expectEqual(result.timedOut, true);
        if (scenario.name === 'spawn-failure') expectTruthy(result.errorMessage);
      } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
      }
    }
  });

  it('returns a diagnosable failure when the required attachment cannot be written', {
    skip: process.platform !== 'win32',
  }, async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autoplan-spillover-write-failure-'));
    const blockedWorkspace = path.join(tmpRoot, 'workspace-is-a-file');
    fs.writeFileSync(blockedWorkspace, 'not a directory', 'utf8');
    let childStarted = false;
    try {
      const result = await runOpenCodeTestAttempt({
        workspace: blockedWorkspace,
        prompt: structuredPlanPrompt('\r\n'),
        command: path.join(tmpRoot, 'opencode.cmd'),
        waitForChild: async () => {
          childStarted = true;
          return 0;
        },
      });

      expectEqual(result.exitCode, -1);
      expectEqual(childStarted, false);
      expectIncludes(result.errorMessage, 'OpenCode CLI prompt 安全投递失败');
      expectIncludes(result.errorMessage, '无法写入 OpenCode prompt 附件');
      expectEqual(promptAttachmentFiles(blockedWorkspace).length, 0);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});

describe('Chunk decoder (GBK/UTF-8 容错解码)', () => {
  it('decodes valid UTF-8 chunks unchanged (including split multibyte sequences)', () => {
    const decoder = createChunkDecoder();
    const full = Buffer.from('你好，世界 hello', 'utf8');
    const mid = Math.floor(full.length / 2);
    const out = decoder.decode(full.subarray(0, mid)) + decoder.decode(full.subarray(mid));
    expectEqual(out, '你好，世界 hello');
  });

  it('decodes GBK/GB18030 bytes instead of producing U+FFFD mojibake', () => {
    const decoder = createChunkDecoder();
    // 「文件名或扩展名太长」(WinError 206) 的 GBK 字节
    const gbk = Buffer.from('cec4bcfec3fbbbf2c0a9d5b9c3fbccabb3a4', 'hex');
    const out = decoder.decode(gbk);
    expectEqual(out, '文件名或扩展名太长');
    // 关键：不应出现替换字符（锟斤拷）
    expectNotIncludes(out, '\uFFFD');
  });

  it('keeps ASCII prefixes intact when mixed with GBK bytes', () => {
    const decoder = createChunkDecoder();
    const mixed = Buffer.concat([Buffer.from('Error: '), Buffer.from('b4edcef3', 'hex')]); // Error: 错误
    expectEqual(decoder.decode(mixed), 'Error: 错误');
  });

  it('tolerates ANSI errors without throwing even for partial GBK tails', () => {
    const decoder = createChunkDecoder();
    const truncated = Buffer.from('cec4bcfec3fbbbf2c0a9d5b9c3fbccab', 'hex'); // 少一个字节
    const out = decoder.decode(truncated);
    // 不抛异常；可读部分保留，至多末尾一个替换字符
    expectTruthy(out.includes('文件名或扩展名'));
  });
});
