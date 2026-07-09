const { describe, it } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

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
    const spec = agentCliSpawnSpec('claude', '', 'last.txt', ['resume', 'codex-session-id', '-c', 'model_reasoning_effort="xhigh"']);

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
      ['-c', 'model_reasoning_effort="xhigh"', 'resume'],
    );

    expectNotIncludes(spec.args, 'model_reasoning_effort');
    expectNotIncludes(spec.args, 'resume');
    expectNotIncludes(spec.args, 'session-id');
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
      ['-c', 'model_reasoning_effort="xhigh"', 'resume', 'session-id'],
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

describe('OpenCode prompt spillover (命令行长度上限规避)', () => {
  it('returns null for short prompts under the effective limit', () => {
    const spec = agentCliSpawnSpec('opencode', 'opencode', 'last.txt');
    const result = writePromptSpilloverFile(spec, 'short prompt', os.tmpdir());
    expectEqual(result, null);
  });

  it('returns null for non-argument prompt sources (codex/claude/oh-my-pi)', () => {
    const longPrompt = 'x'.repeat(WIN_CMD_LIMIT + 1000);
    const stdinSpec = agentCliSpawnSpec('codex', 'codex', 'last.txt', ['exec']);
    expectEqual(writePromptSpilloverFile(stdinSpec, longPrompt, os.tmpdir()), null);
    const claudeSpec = agentCliSpawnSpec('claude', 'claude', 'last.txt');
    expectEqual(writePromptSpilloverFile(claudeSpec, longPrompt, os.tmpdir()), null);
  });

  it('writes a long OpenCode prompt to a temp file and returns a pointer + -f path', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autoplan-spillover-'));
    try {
      const spec = agentCliSpawnSpec('opencode', 'opencode', 'last.txt');
      // 远超 cmd.exe 8191 上限（按字符数判断，cmd.exe/.cmd shim 路径）
      const longPrompt = '需求：' + '丰富内容'.repeat(5000);
      const spillover = writePromptSpilloverFile(spec, longPrompt, tmpRoot);
      expectTruthy(spillover);
      expectTruthy(spillover.filePath);
      expectTruthy(spillover.promptChars > WIN_CMD_LIMIT);
      // P003：指针消息为权威指令，含附件路径与"禁止转而探索"措辞（不再含糊提示）
      expectIncludes(spillover.pointerMessage, spillover.filePath);
      expectIncludes(spillover.pointerMessage, '禁止转而探索');
      expectIncludes(spillover.pointerMessage, '必须完整读取');
      // 文件确实落盘且内容与原 prompt 一致
      expectTruthy(fs.existsSync(spillover.filePath));
      expectEqual(fs.readFileSync(spillover.filePath, 'utf8'), longPrompt);
      // 落在 progress/prompt-tmp 目录下
      expectIncludes(spillover.filePath, path.join('docs', 'progress', 'prompt-tmp'));
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('spills prompts that exceed the cmd.exe 8191 limit (the requirement-#6 scenario)', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autoplan-spillover-'));
    try {
      const spec = agentCliSpawnSpec('opencode', 'opencode', 'last.txt');
      // 需求 #6 实际生成的 prompt 约 14700 字符：8 字符正文 + 自动注入的 README/目录上下文，
      // 远超 cmd.exe 的 8191 字符上限，必须触发落盘。这是「命令行太长」失败的复现场景。
      const prompt = 'x'.repeat(14700);
      const spillover = writePromptSpilloverFile(spec, prompt, tmpRoot);
      expectTruthy(spillover);
      expectTruthy(spillover.promptChars === 14700);
      // 落盘后位置参数（指针消息）远小于上限
      expectTruthy(spillover.pointerMessage.length < WIN_CMD_LIMIT);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('does not spill a moderate prompt that fits within cmd.exe limit', () => {
    const spec = agentCliSpawnSpec('opencode', 'opencode', 'last.txt');
    // ~4000 字符的 prompt：加上 run 子命令参数和余量后仍在 8191 之内，不应落盘
    const prompt = 'x'.repeat(4000);
    expectEqual(writePromptSpilloverFile(spec, prompt, os.tmpdir()), null);
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
