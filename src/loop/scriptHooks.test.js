const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const {
  runHookScripts,
  runScriptManually,
  stopScript,
  buildScriptContext,
  contextEnvVars,
  resolveWorkDir,
  resolveScriptFile,
} = require('./scriptHooks');

const PROJECT_ID = 42;
const WORKSPACE = path.join(os.tmpdir(), 'autoplan-script-hooks-test-workspace');

let nextScriptId = 1000;

/** 构造一条 scripts 表行，覆盖默认值，允许按用例覆盖字段。 */
function makeScript(overrides = {}) {
  nextScriptId += 1;
  return {
    id: nextScriptId,
    project_id: PROJECT_ID,
    name: `脚本 ${nextScriptId}`,
    path: '',
    runtime: 'node',
    body: 'console.log("ok")',
    description: '',
    trigger_mode: 'hook',
    hook_stage: 'task:after',
    enabled: 1,
    work_dir: '',
    timeout_seconds: 60,
    fail_aborts: 0,
    context_inject: 'none',
    sort_order: 0,
    last_status: null,
    last_exit_code: null,
    last_duration_ms: null,
    last_log: null,
    last_run_at: null,
    ...overrides,
  };
}

/**
 * 最小化 service 替身，隔离循环钩子执行逻辑：
 * - db.all 复刻 scripts 表的 WHERE 语义（project_id + hook_stage + enabled + trigger_mode='hook'）；
 * - runShell 捕获调用参数并按 runShellImpl 返回结果，便于断言 AUTOPLAN_* 上下文注入；
 * - addEvent 收集脚本运行事件，便于断言成功/失败事件。
 */
function createFakeService({ scripts = [], runShellImpl, workspace = WORKSPACE, snapshot } = {}) {
  const events = [];
  const updates = [];
  const runs = [];
  const scriptUpdates = [];
  const store = scripts.map((script) => ({ ...script }));

  const matchingScripts = (projectId, stage) => store
    .filter((script) => Number(script.project_id) === Number(projectId)
      && script.hook_stage === stage
      && Number(script.enabled) === 1
      && (script.trigger_mode || 'manual') === 'hook')
    .sort((a, b) => Number(a.sort_order || 0) - Number(b.sort_order || 0) || Number(a.id) - Number(b.id));

  return {
    events,
    updates,
    runs,
    scriptUpdates,
    db: {
      all: (_sql, params) => matchingScripts(params[0], params[1]),
      get: (_sql, params) => store.find((script) => Number(script.id) === Number(params[0])
        && Number(script.project_id) === Number(params[1])) || null,
      run: (_sql, params) => { scriptUpdates.push(params); },
    },
    async runShell(workspaceArg, command, label, operation = {}) {
      runs.push({ workspace: workspaceArg, command, label, operation });
      if (typeof runShellImpl === 'function') return runShellImpl(operation);
      return {
        exitCode: 0,
        output: 'ok\n',
        errorMessage: '',
        timedOut: false,
        logFile: path.join(os.tmpdir(), 'autoplan-script-hooks-fake.log'),
      };
    },
    addEvent: (projectId, type, message, meta = null) => { events.push({ projectId, type, message, meta }); },
    emitUpdate: (projectId) => { updates.push(projectId); },
    project: (projectId) => ({ id: projectId, workspace_path: workspace }),
    existingRuntime: () => null,
    snapshot: () => snapshot || { scripts: [] },
  };
}

describe('runHookScripts 空操作', () => {
  it('默认无启用脚本时不调用 runShell 且不中断循环', async () => {
    const service = createFakeService({ scripts: [] });
    const result = await runHookScripts(service, PROJECT_ID, 'task:after', { taskKey: 'P001', planId: 7 });

    assert.deepEqual(result, { ran: false, aborted: false, results: [] });
    assert.equal(service.runs.length, 0, '无脚本时不应调用 runShell');
    assert.equal(service.events.length, 0, '无脚本时不应写入脚本事件');
  });

  it('仅存在手动或禁用脚本时同样视为空操作', async () => {
    const service = createFakeService({
      scripts: [
        makeScript({ trigger_mode: 'manual' }),
        makeScript({ enabled: 0 }),
      ],
    });
    const result = await runHookScripts(service, PROJECT_ID, 'task:after', {});

    assert.equal(result.ran, false, '手动/禁用脚本不应触发钩子执行');
    assert.equal(service.runs.length, 0);
  });
});

describe('runHookScripts 上下文注入', () => {
  it('env 模式经 runShell 注入 AUTOPLAN_* 环境变量', async () => {
    const script = makeScript({ hook_stage: 'task:after', context_inject: 'env', timeout_seconds: 30 });
    const service = createFakeService({ scripts: [script] });

    const result = await runHookScripts(service, PROJECT_ID, 'task:after', {
      taskKey: 'P001',
      planId: 7,
      scopeFiles: ['src/a.js', 'src/b.js'],
    });

    assert.equal(result.ran, true);
    assert.equal(service.runs.length, 1, '匹配阶段的启用脚本应被 runShell 执行一次');
    const operation = service.runs[0].operation;
    assert.equal(operation.scriptId, script.id, 'operation 应绑定脚本 id');
    assert.equal(operation.stage, 'task:after');
    assert.equal(operation.timeoutMs, 30000, '应按 timeout_seconds 折算超时');
    assert.equal(operation.extraEnv.AUTOPLAN_STAGE, 'task:after');
    assert.equal(operation.extraEnv.AUTOPLAN_TASK_KEY, 'P001');
    assert.equal(operation.extraEnv.AUTOPLAN_PLAN_ID, '7');
    assert.equal(operation.extraEnv.AUTOPLAN_SCOPE_FILES, 'src/a.js,src/b.js');
    assert.ok(operation.extraEnv.AUTOPLAN_CONTEXT.includes('"taskKey":"P001"'), 'AUTOPLAN_CONTEXT 应为含上下文的 JSON');
    assert.equal(operation.stdin, undefined, 'env 模式不应写 stdin');
  });

  it('stdin 模式把上下文 JSON 写入子进程 stdin', async () => {
    const script = makeScript({ hook_stage: 'task:after', context_inject: 'stdin' });
    const service = createFakeService({ scripts: [script] });

    await runHookScripts(service, PROJECT_ID, 'task:after', { taskKey: 'P001', planId: 9 });

    const operation = service.runs[0].operation;
    assert.equal(operation.extraEnv, undefined, 'stdin 模式不应注入环境变量');
    assert.equal(typeof operation.stdin, 'string');
    const parsed = JSON.parse(operation.stdin);
    assert.equal(parsed.taskKey, 'P001');
    assert.equal(parsed.planId, 9);
    assert.equal(parsed.stage, 'task:after');
  });

  it('none 模式既不注入环境变量也不写 stdin', async () => {
    const script = makeScript({ hook_stage: 'task:after', context_inject: 'none' });
    const service = createFakeService({ scripts: [script] });

    await runHookScripts(service, PROJECT_ID, 'task:after', { taskKey: 'P001' });

    const operation = service.runs[0].operation;
    assert.equal(operation.extraEnv, undefined);
    assert.equal(operation.stdin, undefined);
  });
});

describe('runHookScripts 可中断语义', () => {
  it('validation:before 在 fail_aborts 且非零退出码时中断当前阶段', async () => {
    const first = makeScript({ hook_stage: 'validation:before', fail_aborts: 1, sort_order: 1 });
    const second = makeScript({ hook_stage: 'validation:before', fail_aborts: 1, sort_order: 2 });
    const service = createFakeService({
      scripts: [first, second],
      runShellImpl: () => ({ exitCode: 1, output: 'fail', errorMessage: '', timedOut: false }),
    });

    const result = await runHookScripts(service, PROJECT_ID, 'validation:before', { validationCommand: 'npm run check' });

    assert.equal(result.aborted, true, '前置钩子非零退出应中断当前阶段');
    assert.equal(service.runs.length, 1, '中断后不应继续执行后续脚本');
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0].exitCode, 1);
    assert.equal(result.results[0].status, 'bad');
    assert.ok(service.events.some((event) => event.type === 'script.run.failed'), '中断应记录失败事件');
  });

  it('validation:before 退出码 0 时不中断', async () => {
    const service = createFakeService({
      scripts: [
        makeScript({ hook_stage: 'validation:before', fail_aborts: 1, sort_order: 1 }),
        makeScript({ hook_stage: 'validation:before', fail_aborts: 1, sort_order: 2 }),
      ],
      runShellImpl: () => ({ exitCode: 0, output: 'ok', errorMessage: '', timedOut: false }),
    });

    const result = await runHookScripts(service, PROJECT_ID, 'validation:before', {});

    assert.equal(result.aborted, false, '退出码 0 不应中断');
    assert.equal(service.runs.length, 2, '应继续执行所有匹配脚本');
  });

  it('validation:before 关闭 fail_aborts 时非零退出码不中断', async () => {
    const service = createFakeService({
      scripts: [
        makeScript({ hook_stage: 'validation:before', fail_aborts: 0, sort_order: 1 }),
        makeScript({ hook_stage: 'validation:before', fail_aborts: 0, sort_order: 2 }),
      ],
      runShellImpl: () => ({ exitCode: 1, output: 'fail', errorMessage: '', timedOut: false }),
    });

    const result = await runHookScripts(service, PROJECT_ID, 'validation:before', {});

    assert.equal(result.aborted, false, 'fail_aborts 关闭时非零退出码不应中断');
    assert.equal(service.runs.length, 2);
  });

  it('其它阶段失败只记事件不中断循环', async () => {
    const service = createFakeService({
      scripts: [makeScript({ hook_stage: 'task:after', fail_aborts: 1 })],
      runShellImpl: () => ({ exitCode: 1, output: 'fail', errorMessage: '', timedOut: false }),
    });

    const result = await runHookScripts(service, PROJECT_ID, 'task:after', {});

    assert.equal(result.aborted, false, 'task:after 失败不应中断循环');
    assert.equal(result.results[0].status, 'bad');
    assert.ok(service.events.some((event) => event.type === 'script.run.failed'), '应记录失败事件但不中断');
  });
});

describe('runHookScripts 异常隔离', () => {
  it('单脚本 runShell 抛错被捕获并记为失败事件、不向上冒泡', async () => {
    const script = makeScript({ hook_stage: 'task:after' });
    const service = createFakeService({
      scripts: [script],
      runShellImpl: () => { throw new Error('interpreter missing'); },
    });

    // 不应抛错：钩子异常必须被吞掉，绝不中断循环
    const result = await runHookScripts(service, PROJECT_ID, 'task:after', {});

    assert.equal(result.ran, true);
    assert.equal(result.aborted, false);
    assert.equal(result.results[0].status, 'bad');
    assert.equal(result.results[0].exitCode, -1);
    assert.match(result.results[0].errorMessage, /interpreter missing/);
    const failureEvent = service.events.find((event) => event.type === 'script.run.failed');
    assert.ok(failureEvent, '应写入脚本运行失败事件');
    assert.equal(failureEvent.meta.scriptId, script.id);
    assert.equal(failureEvent.meta.exitCode, -1);
  });

  it('脚本超时被捕获并标记 timedOut 且不中断循环', async () => {
    const service = createFakeService({
      scripts: [makeScript({ hook_stage: 'loop:end' })],
      runShellImpl: () => ({ exitCode: -1, output: '', errorMessage: 'timed out', timedOut: true }),
    });

    const result = await runHookScripts(service, PROJECT_ID, 'loop:end', {});

    assert.equal(result.aborted, false, 'loop:end 超时不应中断循环');
    assert.equal(result.results[0].status, 'bad');
    assert.equal(result.results[0].timedOut, true);
    const failureEvent = service.events.find((event) => event.type === 'script.run.failed');
    assert.equal(failureEvent.meta.timedOut, true);
  });
});

describe('runScriptManually 手动运行', () => {
  it('返回退出码/状态/日志并刷新快照', async () => {
    const script = makeScript({ trigger_mode: 'manual', hook_stage: null });
    const service = createFakeService({
      scripts: [script],
      runShellImpl: () => ({ exitCode: 0, output: 'manual ok', errorMessage: '', timedOut: false }),
      snapshot: { scripts: [script] },
    });

    const result = await runScriptManually(service, PROJECT_ID, script.id);

    assert.equal(result.exitCode, 0);
    assert.equal(result.status, 'ok');
    assert.equal(result.error, null);
    assert.ok(result.log.includes('manual ok'));
    assert.equal(result.snapshot.scripts.length, 1);
  });

  it('脚本不存在时抛出可定位错误', async () => {
    const service = createFakeService();
    await assert.rejects(() => runScriptManually(service, PROJECT_ID, 999999), /脚本不存在/);
  });
});

describe('source_type 分流：文件来源执行', () => {
  it('source_type=file 且文件存在时直接运行原文件（不写临时副本）', async () => {
    const realFile = path.join(os.tmpdir(), `autoplan-script-source-file-${Date.now()}.js`);
    fs.writeFileSync(realFile, 'console.log("from file")', 'utf8');
    try {
      const script = makeScript({ hook_stage: 'task:after', source_type: 'file', path: realFile });
      const service = createFakeService({ scripts: [script] });

      const result = await runHookScripts(service, PROJECT_ID, 'task:after', {});

      assert.equal(result.ran, true);
      assert.equal(service.runs.length, 1, '文件来源应调用 runShell 执行该文件');
      assert.ok(service.runs[0].command.includes(realFile), '执行命令应指向用户选定的原文件');
      assert.ok(
        !service.runs[0].command.includes(path.join(os.tmpdir(), 'autoplan-scripts')),
        '文件来源不应写入临时脚本目录',
      );
    } finally {
      fs.rmSync(realFile, { force: true });
    }
  });

  it('source_type=file 但路径不存在时返回退出码 -1 / 状态 bad 且不抛错', async () => {
    const missingFile = path.join(os.tmpdir(), `autoplan-script-source-missing-${Date.now()}.js`);
    const script = makeScript({ hook_stage: 'task:after', source_type: 'file', path: missingFile });
    const service = createFakeService({ scripts: [script] });

    const result = await runHookScripts(service, PROJECT_ID, 'task:after', {});

    assert.equal(result.ran, true);
    assert.equal(service.runs.length, 0, '文件不存在时不应调用 runShell');
    assert.equal(result.results[0].status, 'bad');
    assert.equal(result.results[0].exitCode, -1);
    assert.match(result.results[0].errorMessage, /脚本文件不存在/);
    assert.ok(service.events.some((event) => event.type === 'script.run.failed'), '应记录失败事件但不中断循环');
  });

  it('source_type=file 但 path 为空时同样记为失败、不抛错', async () => {
    const script = makeScript({ hook_stage: 'task:after', source_type: 'file', path: '' });
    const service = createFakeService({ scripts: [script] });

    const result = await runHookScripts(service, PROJECT_ID, 'task:after', {});

    assert.equal(result.results[0].status, 'bad');
    assert.equal(result.results[0].exitCode, -1);
    assert.equal(service.runs.length, 0, '空路径不应调用 runShell');
  });

  it('runScriptManually 对文件来源脚本直接运行原文件', async () => {
    const realFile = path.join(os.tmpdir(), `autoplan-script-source-manual-${Date.now()}.js`);
    fs.writeFileSync(realFile, 'console.log("manual file")', 'utf8');
    try {
      const script = makeScript({ trigger_mode: 'manual', hook_stage: null, source_type: 'file', path: realFile });
      const service = createFakeService({
        scripts: [script],
        runShellImpl: () => ({ exitCode: 0, output: 'manual file ok', errorMessage: '', timedOut: false }),
        snapshot: { scripts: [script] },
      });

      const result = await runScriptManually(service, PROJECT_ID, script.id);

      assert.equal(result.exitCode, 0);
      assert.equal(result.status, 'ok');
      assert.ok(service.runs[0].command.includes(realFile), '手动运行文件来源脚本命令应指向原文件');
    } finally {
      fs.rmSync(realFile, { force: true });
    }
  });

  it('source_type 缺省/inline 时维持写临时文件行为（回归）', async () => {
    const explicitInline = makeScript({ hook_stage: 'task:after', source_type: 'inline', body: 'console.log("inline")' });
    const legacyNoSource = makeScript({ hook_stage: 'task:after', body: 'console.log("legacy")' });
    const service = createFakeService({ scripts: [explicitInline, legacyNoSource] });

    const result = await runHookScripts(service, PROJECT_ID, 'task:after', {});

    assert.equal(service.runs.length, 2, '内联来源应照常写入临时文件并执行');
    const tempDir = path.join(os.tmpdir(), 'autoplan-scripts');
    for (const run of service.runs) {
      assert.ok(run.command.includes(tempDir), '内联来源执行命令应指向临时脚本目录');
    }
    assert.ok(result.results.every((item) => item.status === 'ok'), '内联来源应运行成功');
  });
});

describe('stopScript 停止运行', () => {
  it('无运行时上下文时安全空操作', () => {
    const service = createFakeService();
    assert.doesNotThrow(() => stopScript(service, PROJECT_ID, 1));
  });
});

describe('buildScriptContext 上下文构造', () => {
  it('归一化 scope 字符串并补默认值', () => {
    const ctx = buildScriptContext('task:after', { taskKey: 'P001', scope: 'a.js, b.js', workspace: WORKSPACE });
    assert.equal(ctx.stage, 'task:after');
    assert.equal(ctx.taskKey, 'P001');
    assert.deepEqual(ctx.scopeFiles, ['a.js', 'b.js']);
    assert.equal(ctx.trigger, 'hook');
    assert.equal(ctx.workspace, WORKSPACE);
  });
});

describe('contextEnvVars AUTOPLAN_* 变量', () => {
  it('仅在有值时注入 plan/task/scope 变量', () => {
    const full = contextEnvVars(buildScriptContext('plan:after', {
      planId: 3,
      taskKey: 'P002',
      scopeFiles: ['x.js'],
    }));
    assert.equal(full.AUTOPLAN_STAGE, 'plan:after');
    assert.equal(full.AUTOPLAN_PLAN_ID, '3');
    assert.equal(full.AUTOPLAN_TASK_KEY, 'P002');
    assert.equal(full.AUTOPLAN_SCOPE_FILES, 'x.js');
    assert.ok(full.AUTOPLAN_CONTEXT);

    const minimal = contextEnvVars(buildScriptContext('loop:end', {}));
    assert.equal(minimal.AUTOPLAN_STAGE, 'loop:end');
    assert.equal(minimal.AUTOPLAN_PLAN_ID, undefined);
    assert.equal(minimal.AUTOPLAN_TASK_KEY, undefined);
    assert.equal(minimal.AUTOPLAN_SCOPE_FILES, undefined);
  });
});

describe('resolveWorkDir 占位解析', () => {
  it('解析 ${workspace}/${planDir} 占位，空值返回空串，相对路径锚定工作区', () => {
    const planDir = path.join(WORKSPACE, 'docs', 'plan');
    assert.equal(resolveWorkDir('', { workspace: WORKSPACE, planDir }), '');
    assert.equal(resolveWorkDir('   ', { workspace: WORKSPACE, planDir }), '');
    assert.equal(resolveWorkDir('${workspace}', { workspace: WORKSPACE, planDir }), WORKSPACE);
    assert.equal(resolveWorkDir('${planDir}', { workspace: WORKSPACE, planDir }), planDir);
    assert.equal(resolveWorkDir('sub/dir', { workspace: WORKSPACE, planDir }), path.resolve(WORKSPACE, 'sub/dir'));
  });
});

describe('resolveScriptFile 文件来源路径解析', () => {
  it('解析 ${workspace}/${planDir} 占位，空串返回空串，相对路径锚定工作区，绝对路径直通', () => {
    const planDir = path.join(WORKSPACE, 'docs', 'plan');
    assert.equal(resolveScriptFile('', { workspace: WORKSPACE, planDir }), '');
    assert.equal(resolveScriptFile('   ', { workspace: WORKSPACE, planDir }), '');
    assert.equal(resolveScriptFile('${workspace}', { workspace: WORKSPACE, planDir }), WORKSPACE);
    assert.equal(resolveScriptFile('${planDir}', { workspace: WORKSPACE, planDir }), planDir);
    assert.equal(resolveScriptFile('sub/dir', { workspace: WORKSPACE, planDir }), path.resolve(WORKSPACE, 'sub/dir'));
    const absolute = path.join(os.tmpdir(), 'autoplan-script-source-abs.js');
    assert.equal(resolveScriptFile(absolute, { workspace: WORKSPACE, planDir }), absolute);
  });
});
