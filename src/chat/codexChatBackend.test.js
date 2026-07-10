'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const childProcess = require('node:child_process');

/* ------------------------------------------------------------------ 伪 spawn ------------------------------------------------------------------ */

const realSpawn = childProcess.spawn;
let fakeSpawn = null;
childProcess.spawn = function injectedSpawn(command, args, options) {
  return fakeSpawn ? fakeSpawn(command, args, options) : realSpawn(command, args, options);
};

/**
 * 伪子进程：EventEmitter + stdout/stderr 流 + stdin 可写缓冲 + kill 记录。
 * 调用 fakeChild 后需手动 emit stdout/stderr data 与 close 事件。
 */
function fakeChild({ pid = 26001 } = {}) {
  const child = new EventEmitter();
  child.pid = pid;
  child.killed = false;
  child.killSignal = null;
  child.stdin = {
    destroyed: false,
    buffer: [],
    write(chunk) {
      this.buffer.push(String(chunk));
      return true;
    },
    end(chunk) {
      if (chunk !== undefined) this.write(chunk);
      this.destroyed = true;
    },
    setDefaultEncoding() {},
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = (signal) => {
    child.killed = true;
    child.killSignal = signal || 'SIGTERM';
  };
  return child;
}

/** 发送 stdout NDJSON 行后关闭子进程 */
function deliverLines(child, lines, exitCode = 0) {
  setImmediate(() => {
    if (lines.length > 0) {
      child.stdout.emit('data', Buffer.from(lines.join('\n') + '\n', 'utf8'));
    }
    child.emit('close', exitCode);
  });
}

/* ------------------------------------------------------------------ 被测模块 ------------------------------------------------------------------ */

const { runCodexChat } = require('./codexChatBackend');

/* ------------------------------------------------------------------ 辅助 ------------------------------------------------------------------ */

const WORKSPACE = process.platform === 'win32' ? 'C:\\test\\workspace' : '/tmp/test-workspace';

/**
 * 检查 args 在某处包含所有给定片段（逐个 .includes 检查），
 * 兼容 Windows cmd.exe 包装后 args 变为 ['/d','/s','/c','call "... all flags ..."'] 的情况。
 */
function argsContain(args, ...fragments) {
  const haystack = args.join(' \x00'); // NUL 分隔，确保跨 arg 边界也能匹配
  for (const f of fragments) {
    if (!haystack.includes(f)) return false;
  }
  return true;
}

/* ------------------------------------------------------------------ 用例 ------------------------------------------------------------------ */

describe('runCodexChat 新会话', () => {
  it('新会话 spawn args 包含 --json、仓库检查绕过参数及原有关键参数', () => {
    let capturedArgs;
    fakeSpawn = (cmd, args) => {
      capturedArgs = args;
      const child = fakeChild();
      deliverLines(child, []);
      return child;
    };

    return runCodexChat({
      workspacePath: WORKSPACE,
      prompt: 'hello',
      reasoningEffort: 'xhigh',
      command: 'test-codex-cli',
      onEvent: () => {},
    }).then(() => {
      assert.ok(capturedArgs, 'spawn 应被调用');
      assert.ok(argsContain(capturedArgs, 'exec', '--json'), '应包含 exec + --json');
      assert.ok(argsContain(capturedArgs, '--sandbox', 'danger-full-access'), '应保留 --sandbox danger-full-access');
      assert.ok(argsContain(capturedArgs, 'model_reasoning_effort="xhigh"'), '应注入 reasoning effort 配置');
      const skipIndex = capturedArgs.indexOf('--skip-git-repo-check');
      assert.ok(skipIndex > capturedArgs.indexOf('danger-full-access'), '绕过参数应位于 sandbox 参数之后');
      assert.ok(skipIndex < capturedArgs.length - 1, '绕过参数应位于 stdin 标记之前');
      assert.strictEqual(capturedArgs[capturedArgs.length - 1], '-', '末尾位置参数应为 -（stdin 标记）');
    });
  });

  it('恢复会话 spawn args 在注入 --json 后保留仓库检查绕过参数及原有关键参数', () => {
    let capturedArgs;
    fakeSpawn = (cmd, args) => {
      capturedArgs = args;
      const child = fakeChild();
      deliverLines(child, []);
      return child;
    };

    return runCodexChat({
      workspacePath: WORKSPACE,
      prompt: 'continue',
      sessionId: '00000000-aaaa-bbbb-cccc-000000000001',
      reasoningEffort: 'low',
      command: 'test-codex-cli',
      onEvent: () => {},
    }).then(() => {
      assert.ok(capturedArgs, 'spawn 应被调用');
      assert.ok(argsContain(capturedArgs, 'exec', 'resume', '--json'), '应包含 exec + resume + --json');
      assert.ok(argsContain(capturedArgs, '00000000-aaaa-bbbb-cccc-000000000001'), '应包含 sessionId');
      assert.ok(argsContain(capturedArgs, 'model_reasoning_effort="low"'), '应包含 reasoning effort');
      const skipIndex = capturedArgs.indexOf('--skip-git-repo-check');
      const sessionIndex = capturedArgs.indexOf('00000000-aaaa-bbbb-cccc-000000000001');
      assert.ok(skipIndex > capturedArgs.indexOf('resume'), '绕过参数应位于 resume 子命令之后');
      assert.ok(skipIndex < sessionIndex, '绕过参数应位于 sessionId 之前');
      assert.strictEqual(capturedArgs[capturedArgs.length - 1], '-', '末尾位置参数应为 -（stdin 标记）');
    });
  });

  it('stdin 收到完整 prompt', () => {
    let child;
    fakeSpawn = () => {
      child = fakeChild();
      deliverLines(child, []);
      return child;
    };

    return runCodexChat({
      workspacePath: WORKSPACE,
      prompt: 'multi\nline\nprompt',
      command: 'test-codex-cli',
      onEvent: () => {},
    }).then(() => {
      const allWritten = child.stdin.buffer.join('');
      assert.equal(allWritten, 'multi\nline\nprompt');
    });
  });
});

describe('runCodexChat session / 事件', () => {
  it('session_configured → getSessionId 提取并返回', () => {
    let child;
    fakeSpawn = () => {
      child = fakeChild();
      const lines = [
        JSON.stringify({ type: 'session_configured', payload: { session_id: 'abcd1234-ef56-7890-abcd-1234567890ab' } }),
        JSON.stringify({ type: 'item', payload: { type: 'message', text: 'answer' } }),
      ];
      deliverLines(child, lines);
      return child;
    };

    return runCodexChat({
      workspacePath: WORKSPACE,
      prompt: 'q',
      command: 'test-codex-cli',
      onEvent: () => {},
    }).then((result) => {
      assert.equal(result.sessionId, 'abcd1234-ef56-7890-abcd-1234567890ab');
      assert.equal(result.content, 'answer');
      assert.equal(result.error, '');
      assert.equal(result.aborted, false);
    });
  });

  it('onEvent 收到翻译后的事件', () => {
    let child;
    const events = [];
    fakeSpawn = () => {
      child = fakeChild();
      const lines = [
        JSON.stringify({ type: 'reasoning', payload: { text: 'think' } }),
        JSON.stringify({ type: 'item', payload: { type: 'message', text: 'hi' } }),
        JSON.stringify({ type: 'task_complete', payload: {} }),
      ];
      deliverLines(child, lines);
      return child;
    };

    return runCodexChat({
      workspacePath: WORKSPACE,
      prompt: 'q',
      command: 'test-codex-cli',
      onEvent: (e) => events.push(e),
    }).then(() => {
      const types = events.map((e) => e.type);
      assert.ok(types.includes('thinking_start'));
      assert.ok(types.includes('thinking_delta'));
      assert.ok(types.includes('text_delta'));
      assert.ok(types.includes('done'));
    });
  });
});

describe('runCodexChat abort', () => {
  it('signal.abort → child.kill 且返回 aborted=true', () => {
    const ctrl = new AbortController();
    let child;
    fakeSpawn = () => {
      child = fakeChild();
      // 在 spawnOnce 注册好 abort 监听并进入 await 后，异步触发 abort。
      // 这样 signal.abort → spawnOnce 内的 abortHandler → child.kill → child.emit('close')。
      setImmediate(() => {
        ctrl.abort();
        child.emit('close', null);
      });
      return child;
    };

    return runCodexChat({
      workspacePath: WORKSPACE,
      prompt: 'cancel',
      command: 'test-codex-cli',
      signal: ctrl.signal,
      onEvent: () => {},
    }).then((result) => {
      assert.equal(result.aborted, true);
      assert.ok(child.killed);
    });
  });
});

describe('runCodexChat resume 失败回退', () => {
  it('resume 失败（exitCode != 0 + isCodexResumeFailure）自动回退新会话', () => {
    const sessionId = '00000000-bbbb-cccc-dddd-000000000002';
    let spawnCalls = [];
    fakeSpawn = (cmd, args, opts) => {
      spawnCalls.push({ cmd, args });
      const child = fakeChild();
      if (spawnCalls.length === 1) {
        // 第一次：resume 尝试 → stderr 输出 resume 失败特征
        setImmediate(() => {
          child.stderr.emit('data', Buffer.from('thread/resume failed: no rollout found', 'utf8'));
          child.emit('close', 1);
        });
      } else {
        // 第二次：回退新会话 → 正常返回
        const lines = [
          JSON.stringify({ type: 'session_configured', payload: { session_id: 'new-fallback-session-000000000003' } }),
          JSON.stringify({ type: 'item', payload: { type: 'message', text: 'fallback answer' } }),
        ];
        deliverLines(child, lines);
      }
      return child;
    };

    return runCodexChat({
      workspacePath: WORKSPACE,
      prompt: 'resume me',
      sessionId,
      command: 'test-codex-cli',
      onEvent: () => {},
    }).then((result) => {
      assert.equal(spawnCalls.length, 2, '应调用两次 spawn：resume + fallback');
      // 第一次调用为 resume
      assert.ok(argsContain(spawnCalls[0].args, 'resume'), '第一次应为 resume');
      assert.ok(argsContain(spawnCalls[0].args, sessionId), '第一次应包含 sessionId');
      // 第二次调用为 new session（不含 resume）
      assert.ok(!argsContain(spawnCalls[1].args, 'resume'), '第二次应为新会话（无 resume）');
      // 返回的是新会话的 sessionId
      assert.ok(result.sessionId.includes('new-fallback'), `sessionId 应为新会话: ${result.sessionId}`);
      assert.equal(result.content, 'fallback answer');
    });
  });
});
