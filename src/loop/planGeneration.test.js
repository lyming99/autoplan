const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('path');
const {
  analyzeIntakePlanPhasing,
  recoverPlanFromStdout,
  generatePlanForIntake,
  isPlanContentValid,
  shouldGeneratePhasedPlans,
} = require('./planGeneration');
const { BUILTIN_PLAN_GENERATION_ERROR_CODES } = require('./builtinPlanGenerator');

/**
 * planGeneration 模块单元测试（node:test 风格，对齐 acceptance.test.js）。
 * 覆盖 recoverPlanFromStdout 兜底落盘逻辑和短正文上下文注入。
 */

describe('recoverPlanFromStdout', () => {
  it('stdout 含 ## 任务拆解 → 正确切取并写入 planFile，返回 true', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoplan-test-'));
    try {
      const planFile = path.join(dir, 'test-plan.md');
      const stdout = [
        '好的，我来帮你生成开发计划。',
        '',
        '## 任务拆解',
        '',
        '- [ ] P001: 任务一 <!-- scope: src/foo.js -->',
        '- [ ] P002: 任务二 <!-- scope: src/bar.js -->',
      ].join('\n');

      const result = recoverPlanFromStdout(planFile, stdout);

      assert.equal(result, true);
      assert.ok(fs.existsSync(planFile));
      const content = fs.readFileSync(planFile, 'utf-8');
      assert.ok(content.startsWith('## 任务拆解'), '应从 ## 标题开始，去掉前面对话式寒暄');
      assert.ok(!content.includes('好的，我来帮你生成开发计划。'), '不应包含寒暄文本');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stdout 仅寒暄文本（无任何 ## 标题）→ 返回 false，不写入文件', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoplan-test-'));
    try {
      const planFile = path.join(dir, 'test-plan.md');
      const stdout = '好的，请告诉我你希望我生成什么样的计划？需要更多信息才能帮你。';

      const result = recoverPlanFromStdout(planFile, stdout);

      assert.equal(result, false);
      assert.ok(!fs.existsSync(planFile), '不应写入文件');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stdout 为空字符串 → 返回 false', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoplan-test-'));
    try {
      const planFile = path.join(dir, 'test-plan.md');

      const result = recoverPlanFromStdout(planFile, '');

      assert.equal(result, false);
      assert.ok(!fs.existsSync(planFile));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('generatePlanForIntake 短正文上下文注入', () => {
  /**
   * 构造最小 mock service，捕获 runCodex 收到的 prompt 后立即返回失败，
   * 避免进入完整生成流程。适用于 prompt 内容断言。
   */
  function createCaptureService() {
    const captured = { prompt: null };
    const svc = {
      setPhase() {},
      status() {
        return {};
      },
      intakeAttachmentPrompt() {
        return '';
      },
      async runCodex(_workspace, prompt) {
        captured.prompt = prompt;
        return { exitCode: 1, output: '', logFile: '/tmp/mock.log', errorMessage: 'mock' };
      },
      addEvent() {},
      async runHookScripts() {},
      db: {
        all() {
          return [];
        },
        run() {},
      },
    };
    return { svc, captured };
  }

  function makeHelpers(workspace) {
    return {
      timestampForPath: () => '20260629-120000',
      readSnippet: (filePath, maxLen) => {
        if (!fs.existsSync(filePath)) return '';
        return fs.readFileSync(filePath, 'utf-8').slice(0, maxLen);
      },
      normalizeRelative: (_ws, p) => p,
      hashFile: () => 'abc123',
      hashText: () => 'abc123',
    };
  }

  it('body 长度 < 20 时 prompt 含上下文标注和 README 摘要', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoplan-test-ctx-'));
    try {
      // 构造 workspace fixture：放一个 README.md
      fs.writeFileSync(path.join(dir, 'README.md'), '# 测试项目\n这是一个测试项目。\n', 'utf-8');
      // 放几个目录/文件以验证目录概览
      fs.mkdirSync(path.join(dir, 'src'));
      fs.mkdirSync(path.join(dir, 'docs'));
      fs.writeFileSync(path.join(dir, 'package.json'), '{}', 'utf-8');

      const { svc, captured } = createCaptureService();
      const helpers = makeHelpers(dir);
      const intake = { __type: 'requirement', id: 1, body: '优化' }; // 2 个字 < 20

      await generatePlanForIntake(svc, helpers, 'p1', dir, intake);

      assert.ok(captured.prompt, 'prompt 应被捕获');
      assert.ok(
        captured.prompt.includes('以下是项目自动收集的上下文，供你判断需求涉及范围：'),
        '短正文时 prompt 应包含上下文标注',
      );
      assert.ok(
        captured.prompt.includes('## 项目 README 摘要：'),
        '应包含 README 摘要章节',
      );
      assert.ok(
        captured.prompt.includes('# 测试项目'),
        '应包含 README 内容',
      );
      assert.ok(
        captured.prompt.includes('## 项目根目录概览：'),
        '应包含根目录概览',
      );
      assert.ok(captured.prompt.includes('src/'), '目录列表应包含 src/');
      assert.ok(captured.prompt.includes('docs/'), '目录列表应包含 docs/');
      assert.ok(captured.prompt.includes('package.json'), '目录列表应包含文件');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('body 长度 ≥ 20 时 prompt 不含上下文标注', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoplan-test-ctx-'));
    try {
      fs.writeFileSync(path.join(dir, 'README.md'), '# 不应出现\n', 'utf-8');

      const { svc, captured } = createCaptureService();
      const helpers = makeHelpers(dir);
      const intake = { __type: 'feedback', id: 2, body: '这是一段足够长的需求描述，超过二十个字符以触发跳过上下文注入逻辑。' };

      await generatePlanForIntake(svc, helpers, 'p1', dir, intake);

      assert.ok(captured.prompt, 'prompt 应被捕获');
      assert.ok(
        !captured.prompt.includes('以下是项目自动收集的上下文'),
        '长正文时 prompt 不应包含上下文标注',
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('README.md 不存在时不报错，上下文标注仍出现但不含 README 摘要', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoplan-test-ctx-'));
    try {
      // 不创建 README.md

      const { svc, captured } = createCaptureService();
      const helpers = makeHelpers(dir);
      const intake = { __type: 'requirement', id: 3, body: '修 bug' };

      await generatePlanForIntake(svc, helpers, 'p1', dir, intake);

      assert.ok(captured.prompt.includes('以下是项目自动收集的上下文'), '上下文标注应出现');
      assert.ok(!captured.prompt.includes('## 项目 README 摘要：'), 'README 不存在时不应有摘要');
      assert.ok(captured.prompt.includes('## 项目根目录概览：'), '目录概览仍应出现');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('generatePlanForIntake provider 感知 prompt（P004）', () => {
  // 通过 status 返回 agent_cli_provider 模拟不同后端；provider 判定复用 effectiveAgentCliConfig。
  function captureService(provider) {
    const captured = { prompt: null };
    const svc = {
      setPhase() {},
      status() {
        return provider ? { agent_cli_provider: provider } : {};
      },
      intakeAttachmentPrompt() {
        return '';
      },
      async runCodex(_workspace, prompt) {
        captured.prompt = prompt;
        return { exitCode: 1, output: '', logFile: '/tmp/mock.log', errorMessage: 'mock' };
      },
      addEvent() {},
      async runHookScripts() {},
      db: {
        all() {
          return [];
        },
        run() {},
      },
    };
    return { svc, captured };
  }

  function helpersFor(workspace) {
    return {
      timestampForPath: () => '20260629-120000',
      readSnippet: (filePath, maxLen) => {
        if (!fs.existsSync(filePath)) return '';
        return fs.readFileSync(filePath, 'utf-8').slice(0, maxLen);
      },
      normalizeRelative: (_ws, p) => p,
      hashFile: () => 'abc123',
      hashText: () => 'abc123',
    };
  }

  it('opencode 时短正文不注入 README/目录概览，且含弱化探索措辞', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoplan-p4-oc-'));
    try {
      fs.writeFileSync(path.join(dir, 'README.md'), '# 测试项目\n这是一个测试项目。\n', 'utf-8');
      fs.mkdirSync(path.join(dir, 'src'));
      fs.writeFileSync(path.join(dir, 'package.json'), '{}', 'utf-8');

      const { svc, captured } = captureService('opencode');
      const intake = { __type: 'requirement', id: 1, body: '优化' }; // 短正文 < 20
      await generatePlanForIntake(svc, helpersFor(dir), 'p1', dir, intake);

      assert.ok(captured.prompt, 'prompt 应被捕获');
      assert.ok(!captured.prompt.includes('以下是项目自动收集的上下文'), 'opencode 不应注入上下文标注');
      assert.ok(!captured.prompt.includes('## 项目 README 摘要：'), 'opencode 不应注入 README 摘要');
      assert.ok(!captured.prompt.includes('## 项目根目录概览：'), 'opencode 不应注入目录概览');
      assert.ok(captured.prompt.includes('禁止通读整仓'), '应含弱化探索措辞');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('claude 时短正文保留 README/目录概览注入', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoplan-p4-claude-'));
    try {
      fs.writeFileSync(path.join(dir, 'README.md'), '# 测试项目\n这是一个测试项目。\n', 'utf-8');
      fs.mkdirSync(path.join(dir, 'src'));

      const { svc, captured } = captureService('claude');
      const intake = { __type: 'feedback', id: 2, body: '修 bug' }; // 短正文
      await generatePlanForIntake(svc, helpersFor(dir), 'p1', dir, intake);

      assert.ok(captured.prompt.includes('以下是项目自动收集的上下文'), 'claude 应注入上下文标注');
      assert.ok(captured.prompt.includes('## 项目 README 摘要：'), 'claude 应注入 README 摘要');
      assert.ok(captured.prompt.includes('## 项目根目录概览：'), 'claude 应注入目录概览');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('isPlanContentValid plan 格式校验（P005）', () => {
  const validPlan = [
    '# 反馈 #1 开发计划',
    '',
    '## 任务拆解',
    '',
    '- [ ] P001: 任务一 <!-- scope: src/foo.js -->',
    '- [ ] P002: 任务二 <!-- scope: src/bar.js -->',
    '',
    '## 总体验收标准',
    '',
    '```bash',
    'npm test',
    '```',
  ].join('\n');

  it('合法 plan（含 ## 任务拆解 与合规任务行）校验通过', () => {
    assert.equal(isPlanContentValid(validPlan), true);
  });

  it('缺 ## 任务拆解 章节 → 校验失败', () => {
    const noSection = validPlan.replace('## 任务拆解', '## 开发任务');
    assert.equal(isPlanContentValid(noSection), false);
  });

  it('任务行缺 <!-- scope --> → 校验失败', () => {
    const noScope = ['## 任务拆解', '', '- [ ] P001: 任务一'].join('\n');
    assert.equal(isPlanContentValid(noScope), false);
  });

  it('空内容/非字符串 → 校验失败', () => {
    assert.equal(isPlanContentValid(''), false);
    assert.equal(isPlanContentValid(null), false);
    assert.equal(isPlanContentValid(undefined), false);
  });
});

describe('generatePlanForIntake 格式校验失败兜底（P005）', () => {
  // runCodex 写出指定 plan 内容并返回 exitCode=0，捕获事件/钩子/db/落库行为以校验失败兜底链路。
  function fullFlowService(planFilePath, planContent) {
    const events = [];
    const hooks = [];
    const dbRuns = [];
    let inserted = false;
    let synced = false;
    const svc = {
      setPhase() {},
      status() {
        return {};
      },
      intakeAttachmentPrompt() {
        return '';
      },
      async runCodex() {
        fs.mkdirSync(path.dirname(planFilePath), { recursive: true });
        fs.writeFileSync(planFilePath, planContent, 'utf8');
        return { exitCode: 0, output: '', logFile: '/tmp/mock.log' };
      },
      addEvent(_pid, type, message, meta) {
        events.push({ type, message, meta });
      },
      async runHookScripts(_pid, hook) {
        hooks.push(hook);
      },
      insertPlan() {
        inserted = true;
        return 1;
      },
      syncPlanTasks() {
        synced = true;
      },
      db: {
        all() {
          return [];
        },
        run(sql) {
          dbRuns.push(sql);
        },
      },
    };
    return { svc, events, hooks, dbRuns, isInserted: () => inserted, isSynced: () => synced };
  }

  function helpersFor() {
    return {
      timestampForPath: () => '20260629-120000',
      readSnippet: () => '',
      normalizeRelative: (_ws, p) => p,
      hashFile: () => 'abc123',
      hashText: () => 'abc123',
    };
  }

  it('畸形 plan（缺 ## 任务拆解）不落库，触发 plan.format.invalid + on:fail + generate_fail_count 自增', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoplan-p5-bad-'));
    try {
      const planFilePath = path.join(dir, 'docs', 'plan', 'plan_requirement_1_20260629-120000.md');
      const malformed = '# 某标题\n\n只有寒暄，没有 ## 任务拆解 章节和合规任务行。\n';
      const { svc, events, hooks, dbRuns, isInserted, isSynced } = fullFlowService(planFilePath, malformed);

      const intake = { __type: 'requirement', id: 1, body: '这是一段足够长的需求描述超过二十个字符。' };
      const result = await generatePlanForIntake(svc, helpersFor(), 'p1', dir, intake);

      assert.equal(result, null, '畸形 plan 应返回 null');
      assert.equal(isInserted(), false, '不应 insertPlan');
      assert.equal(isSynced(), false, '不应 syncPlanTasks');
      assert.ok(events.some((e) => e.type === 'plan.format.invalid'), '应记录 plan.format.invalid 事件');
      assert.ok(hooks.includes('on:fail'), '应触发 on:fail 钩子');
      assert.ok(dbRuns.some((sql) => /generate_fail_count\s*=\s*COALESCE/.test(sql)), '应自增 generate_fail_count');
      const invalidEvent = events.find((e) => e.type === 'plan.format.invalid');
      assert.ok(invalidEvent.meta && invalidEvent.meta.planFilePath, '事件 meta 应含 planFilePath');
      assert.ok(invalidEvent.meta && Object.prototype.hasOwnProperty.call(invalidEvent.meta, 'logFile'), '事件 meta 应含 logFile');
      assert.ok(invalidEvent.meta && invalidEvent.meta.agentCliProvider, '事件 meta 应含 provider');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('合法 plan 正常落库（不被误判为非法）', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoplan-p5-ok-'));
    try {
      const planFilePath = path.join(dir, 'docs', 'plan', 'plan_requirement_2_20260629-120000.md');
      const valid = '## 任务拆解\n\n- [ ] P001: 任务一 <!-- scope: src/foo.js -->\n';
      const { svc, isInserted } = fullFlowService(planFilePath, valid);

      const intake = { __type: 'requirement', id: 2, body: '这是一段足够长的需求描述超过二十个字符。' };
      const result = await generatePlanForIntake(svc, helpersFor(), 'p1', dir, intake);

      assert.ok(result, '合法 plan 应返回 plan id');
      assert.equal(isInserted(), true, '应 insertPlan');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('generatePlanForIntake 失败状态持久化与成功清理（P006）', () => {
  it('CLI 非 0 退出时写入可读失败原因、日志路径和本次 Codex CLI 信息', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoplan-p6-cli-fail-'));
    try {
      const { svc, dbRuns, events, hooks } = failureStateService({
        status: { agent_cli_provider: 'codex', codex_reasoning_effort: 'high' },
        result: {
          exitCode: 2,
          output: '',
          logFile: '/tmp/autoplan/codex-fail.log',
          errorMessage: 'Codex 启动失败：权限不足',
        },
      });
      const intake = {
        __type: 'requirement',
        id: 41,
        body: '这是一段足够长的需求描述，避免触发短正文上下文注入。',
      };

      const result = await generatePlanForIntake(svc, failureStateHelpers(dir), 'p1', dir, intake);

      assert.equal(result, null);
      const failureUpdate = latestGenerateFailureUpdate(dbRuns, 'requirements');
      assert.ok(failureUpdate, '应写入 requirements 失败状态');
      assert.equal(failureUpdate.params[1], 'Codex 启动失败：权限不足', '应优先使用 result.errorMessage');
      assert.equal(failureUpdate.params[2], '/tmp/autoplan/codex-fail.log', '应保存 result.logFile');
      assert.equal(failureUpdate.params[3], 'codex', '应保存失败时 CLI provider');
      assert.equal(failureUpdate.params[4], 'high', '应保存失败时 Codex 思考深度');
      assert.equal(failureUpdate.params[6], 41, '应更新当前 intake id');
      assert.ok(events.some((event) => event.type === 'plan.generate.failed'), '应记录生成失败事件');
      assert.deepEqual(hooks.map((hook) => hook.hook), ['on:fail'], '应触发 on:fail hook');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('CLI 成功但未写入 Plan 文件时记录缺失产物原因和非 Codex CLI 信息', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoplan-p6-missing-plan-'));
    try {
      const { svc, dbRuns, events } = failureStateService({
        status: { agent_cli_provider: 'opencode' },
        result: {
          exitCode: 0,
          output: '我已经完成计划。',
          logFile: '/tmp/autoplan/opencode-missing.log',
        },
      });
      const intake = {
        __type: 'feedback',
        id: 9,
        body: '这是一段足够长的反馈描述，计划生成成功退出但没有落盘文件。',
      };

      const result = await generatePlanForIntake(svc, failureStateHelpers(dir), 'p1', dir, intake);

      assert.equal(result, null);
      const failureUpdate = latestGenerateFailureUpdate(dbRuns, 'feedback');
      assert.ok(failureUpdate, '应写入 feedback 失败状态');
      assert.match(failureUpdate.params[1], /CLI 成功退出但未写入计划文件/, '应记录缺失 Plan 文件原因');
      assert.match(failureUpdate.params[1], /docs\/plan\/plan_feedback_9_20260629-120000\.md/, '原因应包含缺失计划路径');
      assert.equal(failureUpdate.params[2], '/tmp/autoplan/opencode-missing.log', '应保存日志路径');
      assert.equal(failureUpdate.params[3], 'opencode', '应保存本次生效 CLI provider');
      assert.equal(failureUpdate.params[4], null, '非 Codex provider 应清空思考深度');
      const failureEvent = events.find((event) => event.type === 'plan.generate.failed');
      assert.ok(failureEvent, '应记录计划生成失败事件');
      assert.equal(failureEvent.meta.planFileExists, false, '事件 meta 应记录计划文件不存在');
      assert.equal(failureEvent.meta.logFile, '/tmp/autoplan/opencode-missing.log', '事件 meta 应记录日志路径');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('Plan 格式不合规时写入明确原因、日志路径和失败时 CLI 字段', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoplan-p6-format-fail-'));
    try {
      const { svc, dbRuns, events } = failureStateService({
        status: { agent_cli_provider: 'claude' },
        result: {
          exitCode: 0,
          output: '',
          logFile: '/tmp/autoplan/claude-format.log',
        },
        planContent: '# 只有标题\n\n没有任务拆解章节。\n',
      });
      const intake = {
        __type: 'requirement',
        id: 42,
        body: '这是一段足够长的需求描述，触发计划格式校验失败。',
      };

      const result = await generatePlanForIntake(svc, failureStateHelpers(dir), 'p1', dir, intake);

      assert.equal(result, null);
      const failureUpdate = latestGenerateFailureUpdate(dbRuns, 'requirements');
      assert.ok(failureUpdate, '应写入格式失败状态');
      assert.equal(failureUpdate.params[1], '生成需求 #42 的计划格式不合规：缺少 ## 任务拆解');
      assert.equal(failureUpdate.params[2], '/tmp/autoplan/claude-format.log');
      assert.equal(failureUpdate.params[3], 'claude');
      assert.equal(failureUpdate.params[4], null);
      const invalidEvent = events.find((event) => event.type === 'plan.format.invalid');
      assert.ok(invalidEvent, '应记录 plan.format.invalid 事件');
      assert.equal(invalidEvent.meta.reason, '缺少 ## 任务拆解');
      assert.equal(invalidEvent.meta.logFile, '/tmp/autoplan/claude-format.log');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('计划生成成功后清零失败计数并清空旧失败状态字段', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoplan-p6-success-clear-'));
    try {
      const { svc, dbRuns } = failureStateService({
        status: { agent_cli_provider: 'codex', codex_reasoning_effort: 'xhigh' },
        result: {
          exitCode: 0,
          output: '',
          logFile: '/tmp/autoplan/codex-success.log',
        },
        planContent: validFailureStatePlanMarkdown('成功计划', 'src/success.js'),
      });
      const intake = {
        __type: 'requirement',
        id: 43,
        body: '这是一段足够长的需求描述，生成合法计划后应该清理旧错误。',
      };

      const result = await generatePlanForIntake(svc, failureStateHelpers(dir), 'p1', dir, intake);

      assert.equal(result, 901, '成功生成应返回新 plan id');
      const clearUpdate = dbRuns.find((entry) => (
        entry.sql.includes('UPDATE requirements') &&
        entry.sql.includes('last_generate_error = NULL') &&
        entry.sql.includes('last_generate_log_file = NULL')
      ));
      assert.ok(clearUpdate, '成功后应清理完整失败状态字段');
      assert.deepEqual(clearUpdate.params.slice(1), [43], '清理 SQL 应定位当前 intake');
      assert.ok(
        dbRuns.some((entry) => entry.sql.includes('UPDATE requirements SET linked_plan_id = ?') && entry.params[0] === 901),
        '成功生成仍应回写 linked_plan_id',
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('阶段化计划生成判定与落库（P006）', () => {
  it('仅 requirement 的长正文/显式阶段信号触发阶段化，feedback 与 draft 保持单计划', () => {
    const explicit = analyzeIntakePlanPhasing({
      __type: 'requirement',
      title: '按阶段推进登录体系',
      body: '请拆分成多个计划，先完成数据模型，再完成 UI 与最终验收。',
    });
    assert.equal(explicit.enabled, true);
    assert.equal(explicit.reason, 'explicit_phase_signal');
    assert.equal(explicit.explicitSignal, true);
    assert.equal(shouldGeneratePhasedPlans({ __type: 'requirement', body: '多阶段完成支付改造' }), true);

    const longRequirement = analyzeIntakePlanPhasing({
      __type: 'requirement',
      body: 'a'.repeat(3000),
    });
    assert.equal(longRequirement.enabled, true);
    assert.equal(longRequirement.reason, 'long_body');

    const structuredRequirement = analyzeIntakePlanPhasing({
      __type: 'requirement',
      body: Array.from({ length: 14 }, (_, index) => `- 子需求 ${index + 1}`).join('\n'),
    });
    assert.equal(structuredRequirement.enabled, true);
    assert.equal(structuredRequirement.reason, 'structured_long_body');

    const feedback = analyzeIntakePlanPhasing({
      __type: 'feedback',
      body: `用户反馈明确要求分阶段推进。\n${'b'.repeat(3000)}`,
    });
    assert.equal(feedback.enabled, false);
    assert.equal(feedback.reason, 'feedback_single_plan');

    const draft = analyzeIntakePlanPhasing({
      __type: 'requirement',
      createAsDraft: true,
      body: '分阶段完成草稿计划',
    });
    assert.equal(draft.enabled, false);
    assert.equal(draft.reason, 'draft_single_plan');
  });

  it('阶段 manifest 合法时写入多个 plan、阶段链接、事件和 hooks', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoplan-p6-phased-'));
    try {
      const helpers = helpersForPhased(dir);
      const { svc, captured } = phasedFlowService(dir);
      const intake = {
        __type: 'requirement',
        id: 77,
        title: '阶段化重构',
        body: '请分阶段推进：第一阶段建立模型，第二阶段完成界面和验收。',
      };

      const result = await generatePlanForIntake(svc, helpers, 'p1', dir, intake);

      assert.equal(result, 501, '应返回第一个阶段 plan id 兼容旧 linked_plan_id 契约');
      assert.ok(captured.prompt.includes('Phase manifest 输出文件：'), '阶段化 prompt 应声明 manifest 输出文件');
      assert.ok(captured.prompt.includes('阶段 plan 文件名必须严格使用：plan_requirement_77_20260629-120000_phaseNN.md'), 'prompt 应约束阶段文件名');
      assert.deepEqual(svc.insertPlanCalls.map((call) => call.filePath), [
        'docs/plan/plan_requirement_77_20260629-120000_phase01.md',
        'docs/plan/plan_requirement_77_20260629-120000_phase02.md',
      ]);
      assert.deepEqual(svc.insertPlanCalls.map((call) => call.sortOrder), [20, 21], '阶段 plan 应保持相邻 sort_order');
      assert.deepEqual(svc.syncPlanTasksCalls.map((call) => call.planId), [501, 502], '每个阶段 plan 都应同步任务');

      const insertLinkStatements = svc.dbBatchStatements.filter((statement) => statement.sql.includes('INSERT OR IGNORE INTO intake_plan_links'));
      assert.equal(insertLinkStatements.length, 2, '应写入两个 intake_plan_links 阶段链接');
      assert.deepEqual(insertLinkStatements.map((statement) => statement.params.slice(0, 6)), [
        ['p1', 'requirement', 77, 501, 1, '阶段一：模型与生命周期'],
        ['p1', 'requirement', 77, 502, 2, '阶段二：界面与回归'],
      ]);
      assert.ok(
        svc.dbBatchStatements.some((statement) => statement.sql.includes('UPDATE requirements') && statement.params[0] === 501),
        'legacy linked_plan_id 应回写为第一阶段 plan',
      );
      assert.ok(
        svc.dbRuns.some((entry) => entry.sql.includes('generate_fail_count = 0')),
        '成功后应清空生成失败计数',
      );

      const generated = svc.events.find((event) => event.type === 'plan.generated');
      assert.ok(generated, '应记录 plan.generated 事件');
      assert.deepEqual(generated.meta.planIds, [501, 502]);
      assert.deepEqual(generated.meta.generatedPlanIds, [501, 502]);
      assert.deepEqual(generated.meta.phases.map((phase) => [phase.phaseIndex, phase.phaseTitle, phase.planId]), [
        [1, '阶段一：模型与生命周期', 501],
        [2, '阶段二：界面与回归', 502],
      ]);
      assert.equal(svc.hooks.length, 2, '每个阶段 plan 应触发 plan:after hook');
      assert.deepEqual(svc.hooks.map((hook) => [hook.payload.planId, hook.payload.phaseIndex]), [[501, 1], [502, 2]]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

function helpersForPhased(workspace) {
  return {
    timestampForPath: () => '20260629-120000',
    readSnippet: (filePath, maxLen) => {
      if (!fs.existsSync(filePath)) return '';
      return fs.readFileSync(filePath, 'utf-8').slice(0, maxLen);
    },
    normalizeRelative: (ws, p) => path.relative(ws, p).replace(/\\/g, '/'),
    hashFile: (filePath) => `hash-${path.basename(filePath)}`,
    hashText: (text) => `text-${Buffer.from(String(text)).toString('hex').slice(0, 24)}`,
  };
}

function phasedFlowService(workspace) {
  const captured = { prompt: '' };
  let nextPlanId = 501;
  const svc = {
    insertPlanCalls: [],
    syncPlanTasksCalls: [],
    dbBatchStatements: [],
    dbRuns: [],
    events: [],
    hooks: [],
    setPhase() {},
    status() {
      return {};
    },
    intakeAttachmentPrompt() {
      return '';
    },
    nextPlanSortOrder() {
      return 20;
    },
    async runCodex(_workspace, prompt) {
      captured.prompt = prompt;
      writeValidPhaseManifestAndPlans(workspace);
      return { exitCode: 0, output: '', logFile: '/tmp/mock-phased.log' };
    },
    insertPlan(input) {
      svc.insertPlanCalls.push(input);
      const id = nextPlanId;
      nextPlanId += 1;
      return id;
    },
    syncPlanTasks(planId, planFile) {
      svc.syncPlanTasksCalls.push({ planId, planFile });
    },
    addEvent(projectId, type, message, meta) {
      svc.events.push({ projectId, type, message, meta });
    },
    async runHookScripts(projectId, hook, payload) {
      svc.hooks.push({ projectId, hook, payload });
    },
    db: {
      all() {
        return [];
      },
      get() {
        return null;
      },
      run(sql, params = []) {
        svc.dbRuns.push({ sql, params });
      },
      runBatch(statements) {
        svc.dbBatchStatements.push(...statements);
      },
    },
  };
  return { svc, captured };
}

function writeValidPhaseManifestAndPlans(workspace) {
  const planDir = path.join(workspace, 'docs', 'plan');
  fs.mkdirSync(planDir, { recursive: true });
  const phaseOne = path.join(planDir, 'plan_requirement_77_20260629-120000_phase01.md');
  const phaseTwo = path.join(planDir, 'plan_requirement_77_20260629-120000_phase02.md');
  fs.writeFileSync(phaseOne, validPhasePlanMarkdown('阶段一：模型与生命周期', 'src/database.js'), 'utf8');
  fs.writeFileSync(phaseTwo, validPhasePlanMarkdown('阶段二：界面与回归', 'src/renderer/pages/WorkspacePage.tsx'), 'utf8');
  fs.writeFileSync(
    path.join(planDir, 'plan_requirement_77_20260629-120000_manifest.json'),
    JSON.stringify({
      intakeType: 'requirement',
      intakeId: 77,
      phases: [
        { phaseIndex: 1, phaseTitle: '阶段一：模型与生命周期', file: phaseOne },
        { phaseIndex: 2, phaseTitle: '阶段二：界面与回归', file: phaseTwo },
      ],
    }),
    'utf8',
  );
}

function validPhasePlanMarkdown(title, scope) {
  return [
    `# ${title}`,
    '',
    '## 任务拆解',
    '',
    `- [ ] P001: ${title} <!-- scope: ${scope} -->`,
    '  - 验收要点：完成该阶段开发代码。',
    '- [ ] P002: 完整验收 <!-- scope: validation -->',
    '  - 验收要点：最终验收命令在统一验收阶段执行。',
    '',
    '## 总体验收标准',
    '',
    '```bash',
    'npm test',
    '```',
    '',
    '## 进度区',
    '',
    '- 待执行',
    '',
  ].join('\n');
}

function failureStateHelpers(workspace) {
  return {
    timestampForPath: () => '20260629-120000',
    readSnippet: (filePath, maxLen) => {
      if (!fs.existsSync(filePath)) return '';
      return fs.readFileSync(filePath, 'utf-8').slice(0, maxLen);
    },
    normalizeRelative: (ws, p) => path.relative(ws, p).replace(/\\/g, '/'),
    hashFile: (filePath) => `hash-${path.basename(filePath)}`,
    hashText: (text) => `text-${Buffer.from(String(text)).toString('hex').slice(0, 24)}`,
  };
}

function failureStateService({ status = {}, result, planContent = null }) {
  const dbRuns = [];
  const events = [];
  const hooks = [];
  let inserted = false;
  let synced = false;
  const svc = {
    setPhase() {},
    status() {
      return status;
    },
    intakeAttachmentPrompt() {
      return '';
    },
    async runCodex(workspace, _prompt, _label, operation = {}) {
      if (typeof planContent === 'string') {
        const planFile = path.join(
          workspace,
          'docs',
          'plan',
          `plan_${operation.intakeType}_${operation.intakeId}_20260629-120000.md`,
        );
        fs.mkdirSync(path.dirname(planFile), { recursive: true });
        fs.writeFileSync(planFile, planContent, 'utf8');
      }
      return result;
    },
    addEvent(projectId, type, message, meta) {
      events.push({ projectId, type, message, meta });
    },
    async runHookScripts(projectId, hook, payload) {
      hooks.push({ projectId, hook, payload });
    },
    insertPlan(input) {
      inserted = true;
      svc.insertPlanInput = input;
      return 901;
    },
    syncPlanTasks(planId, planFile) {
      synced = true;
      svc.syncPlanTasksInput = { planId, planFile };
    },
    db: {
      all() {
        return [];
      },
      run(sql, params = []) {
        dbRuns.push({ sql, params });
      },
    },
    wasInserted: () => inserted,
    wasSynced: () => synced,
  };
  return { svc, dbRuns, events, hooks };
}

function latestGenerateFailureUpdate(dbRuns, table) {
  const matches = dbRuns.filter((entry) => (
    entry.sql.includes(`UPDATE ${table}`) &&
    entry.sql.includes('last_generate_error = ?') &&
    entry.sql.includes('last_generate_log_file = ?')
  ));
  return matches[matches.length - 1] || null;
}

function validFailureStatePlanMarkdown(title, scope) {
  return [
    `# ${title}`,
    '',
    '## 任务拆解',
    '',
    `- [ ] P001: ${title} <!-- scope: ${scope} -->`,
    '',
  ].join('\n');
}

describe('generatePlanForIntake 生成策略路由（P011）', () => {
  it('external-cli-markdown keeps the compatibility path and stores generation/execution snapshots', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoplan-p11-markdown-'));
    try {
      const { svc } = strategyFlowService({
        status: {
          plan_generation_strategy: 'external-cli-markdown',
          plan_generation_provider: 'claude',
          plan_generation_command: 'claude-plan',
          plan_execution_strategy: 'external-cli',
          plan_execution_provider: 'codex',
          plan_execution_command: 'codex-exec',
          plan_execution_codex_reasoning_effort: 'xhigh',
        },
        async runCodex(workspace, prompt, _label, operation) {
          const planFile = prompt.match(/输出文件：(.+)/)?.[1]?.trim();
          assert.ok(planFile, 'markdown path prompt should contain output file');
          fs.mkdirSync(path.dirname(planFile), { recursive: true });
          fs.writeFileSync(planFile, validStrategyPlanMarkdown('Markdown 兼容路径', 'src/legacy.js'), 'utf8');
          return {
            exitCode: 0,
            output: '',
            logFile: path.join(workspace, 'markdown.log'),
            agentCliProvider: operation.agentCliProvider,
            agentCliCommand: operation.agentCliCommand,
          };
        },
      });

      const result = await generatePlanForIntake(
        svc,
        strategyHelpers(dir),
        'p1',
        dir,
        strategyIntake(101, '这是一段足够长的需求描述，走 markdown 兼容生成路径。'),
      );

      assert.equal(result, 801);
      assert.equal(svc.runCodexCalls.length, 1);
      assert.equal(svc.runCodexCalls[0].operation.structuredPlan, undefined);
      assert.equal(svc.runCodexCalls[0].operation.agentCliProvider, 'claude');
      assert.equal(svc.runCodexCalls[0].operation.agentCliCommand, 'claude-plan');
      assert.equal(svc.insertPlanCalls[0].planGenerationConfig.strategy, 'external-cli-markdown');
      assert.equal(svc.insertPlanCalls[0].planGenerationConfig.provider, 'claude');
      assert.equal(svc.insertPlanCalls[0].planExecutionConfig.provider, 'codex');
      assert.equal(svc.insertPlanCalls[0].planExecutionConfig.codexReasoningEffort, 'xhigh');
      assert.ok(svc.syncPlanTasksCalls.length === 1, 'success should sync rendered plan tasks');
      const generated = svc.events.find((event) => event.type === 'plan.generated');
      assert.equal(generated.meta.planGenerationProvider, 'claude');
      assert.equal(generated.meta.planExecutionProvider, 'codex');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('external-cli-structured reads PlanSpec from the declared JSON file and renders Markdown', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoplan-p11-structured-file-'));
    try {
      const { svc } = strategyFlowService({
        status: {
          plan_generation_strategy: 'external-cli-structured',
          plan_generation_provider: 'codex',
          plan_generation_codex_reasoning_effort: 'high',
          plan_execution_strategy: 'external-cli',
          plan_execution_provider: 'claude',
          plan_execution_command: 'claude-exec',
        },
        async runCodex(_workspace, prompt, _label, operation) {
          const planSpecFile = prompt.match(/PlanSpec JSON 输出文件：(.+)/)?.[1]?.trim();
          assert.ok(planSpecFile, 'structured prompt should contain PlanSpec output file');
          fs.mkdirSync(path.dirname(planSpecFile), { recursive: true });
          fs.writeFileSync(planSpecFile, JSON.stringify(strategyPlanSpec('文件 PlanSpec'), null, 2), 'utf8');
          return {
            exitCode: 0,
            output: '',
            logFile: '/tmp/structured-file.log',
            agentCliProvider: operation.agentCliProvider,
            agentCliCommand: operation.agentCliCommand,
            codexReasoningEffort: operation.codexReasoningEffort,
          };
        },
      });

      const result = await generatePlanForIntake(
        svc,
        strategyHelpers(dir),
        'p1',
        dir,
        strategyIntake(102, '这是一段足够长的需求描述，走结构化文件生成路径。'),
      );

      assert.equal(result, 801);
      assert.equal(svc.runCodexCalls[0].operation.structuredPlan, true);
      assert.equal(svc.insertPlanCalls[0].planGenerationConfig.strategy, 'external-cli-structured');
      assert.equal(svc.insertPlanCalls[0].planGenerationConfig.provider, 'codex');
      assert.equal(svc.insertPlanCalls[0].planGenerationConfig.codexReasoningEffort, 'high');
      assert.equal(svc.insertPlanCalls[0].planExecutionConfig.provider, 'claude');
      assert.ok(svc.insertPlanCalls[0].filePath.endsWith('.md'));
      assert.ok(fs.existsSync(path.join(dir, svc.insertPlanCalls[0].filePath)), 'rendered markdown should be written');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('external-cli-structured recovers PlanSpec JSON from stdout when the file is missing', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoplan-p11-structured-stdout-'));
    try {
      const { svc } = strategyFlowService({
        status: {
          plan_generation_strategy: 'external-cli-structured',
          plan_generation_provider: 'opencode',
          plan_execution_strategy: 'external-cli',
          plan_execution_provider: 'codex',
        },
        async runCodex(_workspace, _prompt, _label, operation) {
          return {
            exitCode: 0,
            output: `模型输出：\n${JSON.stringify(strategyPlanSpec('stdout PlanSpec'))}`,
            logFile: '/tmp/structured-stdout.log',
            agentCliProvider: operation.agentCliProvider,
            agentCliCommand: operation.agentCliCommand,
          };
        },
      });

      const result = await generatePlanForIntake(
        svc,
        strategyHelpers(dir),
        'p1',
        dir,
        strategyIntake(103, '这是一段足够长的需求描述，走结构化 stdout 兜底路径。'),
      );

      assert.equal(result, 801);
      assert.equal(svc.insertPlanCalls[0].planGenerationConfig.provider, 'opencode');
      assert.ok(svc.events.some((event) => event.type === 'plan.spec.stdout.recovered'));
      assert.ok(fs.existsSync(path.join(dir, svc.insertPlanCalls[0].filePath)));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('builtin-llm-structured uses the built-in PlanSpec generator and stores AI provider/model snapshot', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoplan-p11-builtin-ok-'));
    try {
      const { svc } = strategyFlowService({
        status: {
          plan_generation_strategy: 'builtin-llm-structured',
          plan_generation_provider: 'openai',
          plan_generation_model: 'gpt-4o',
          plan_execution_strategy: 'external-cli',
          plan_execution_provider: 'claude',
        },
        async generateBuiltinPlanSpec(input) {
          svc.builtinInputs.push(input);
          return {
            planSpec: strategyPlanSpec('内置 PlanSpec'),
            aiConfig: {
              id: 7,
              name: 'OpenAI 计划生成',
              provider: 'openai',
              baseUrl: 'https://api.example.test/v1',
              hasApiKey: true,
              model: 'gpt-4o',
            },
            output: '',
          };
        },
      });

      const result = await generatePlanForIntake(
        svc,
        strategyHelpers(dir),
        'p1',
        dir,
        strategyIntake(104, '这是一段足够长的需求描述，走内置 LLM 结构化路径。'),
      );

      assert.equal(result, 801);
      assert.equal(svc.runCodexCalls.length, 0, 'builtin path should not call external CLI');
      assert.equal(svc.builtinInputs.length, 1);
      assert.equal(svc.insertPlanCalls[0].agentCliConfig, null);
      assert.equal(svc.insertPlanCalls[0].planGenerationConfig.strategy, 'builtin-llm-structured');
      assert.equal(svc.insertPlanCalls[0].planGenerationConfig.provider, 'openai');
      assert.equal(svc.insertPlanCalls[0].planGenerationConfig.model, 'gpt-4o');
      const generated = svc.events.find((event) => event.type === 'plan.generated');
      assert.equal(generated.meta.builtinLlmProvider, 'openai');
      assert.equal(generated.meta.builtinLlmModel, 'gpt-4o');
      assert.equal(generated.meta.planExecutionProvider, 'claude');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('builtin-llm-structured records a clear failure when API key is missing', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoplan-p11-builtin-missing-key-'));
    try {
      const missingKey = new Error('内置 LLM 计划生成缺少 API Key');
      missingKey.name = 'BuiltinPlanGenerationError';
      missingKey.code = BUILTIN_PLAN_GENERATION_ERROR_CODES.MISSING_API_KEY;
      missingKey.aiConfig = {
        id: 8,
        name: 'OpenAI 缺少 Key',
        provider: 'openai',
        baseUrl: 'https://api.example.test/v1',
        hasApiKey: false,
        model: 'gpt-4o',
      };
      const { svc } = strategyFlowService({
        status: {
          plan_generation_strategy: 'builtin-llm-structured',
          plan_generation_provider: 'openai',
          plan_generation_model: 'gpt-4o',
        },
        async generateBuiltinPlanSpec() {
          throw missingKey;
        },
      });

      const result = await generatePlanForIntake(
        svc,
        strategyHelpers(dir),
        'p1',
        dir,
        strategyIntake(105, '这是一段足够长的需求描述，触发内置 LLM 缺少 API Key。'),
      );

      assert.equal(result, null);
      assert.equal(svc.insertPlanCalls.length, 0);
      assert.equal(svc.runCodexCalls.length, 0);
      const failure = svc.events.find((event) => event.type === 'plan.generate.failed');
      assert.ok(failure, 'missing API key should emit plan.generate.failed');
      assert.match(failure.meta.error, /API Key/);
      assert.equal(failure.meta.builtinLlmProvider, 'openai');
      assert.equal(failure.meta.builtinLlmHasApiKey, false);
      assert.ok(svc.hooks.some((hook) => hook.hook === 'on:fail'));
      assert.ok(svc.dbRuns.some((entry) => entry.sql.includes('last_generate_error = ?')));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

function strategyFlowService(options = {}) {
  const svc = {
    runCodexCalls: [],
    insertPlanCalls: [],
    syncPlanTasksCalls: [],
    events: [],
    hooks: [],
    dbRuns: [],
    builtinInputs: [],
    setPhase() {},
    status() {
      return options.status || {};
    },
    intakeAttachmentPrompt() {
      return '';
    },
    async runCodex(workspace, prompt, label, operation = {}) {
      svc.runCodexCalls.push({ workspace, prompt, label, operation });
      return options.runCodex(workspace, prompt, label, operation);
    },
    async generateBuiltinPlanSpec(input) {
      return options.generateBuiltinPlanSpec(input);
    },
    addEvent(projectId, type, message, meta) {
      svc.events.push({ projectId, type, message, meta });
    },
    async runHookScripts(projectId, hook, payload) {
      svc.hooks.push({ projectId, hook, payload });
    },
    insertPlan(input) {
      svc.insertPlanCalls.push(input);
      return 801 + svc.insertPlanCalls.length - 1;
    },
    syncPlanTasks(planId, planFile) {
      svc.syncPlanTasksCalls.push({ planId, planFile });
    },
    db: {
      all() {
        return [];
      },
      run(sql, params = []) {
        svc.dbRuns.push({ sql, params });
      },
    },
  };
  return { svc };
}

function strategyHelpers(workspace) {
  return {
    timestampForPath: () => '20260704-120000',
    readSnippet: (filePath, maxLen) => {
      if (!fs.existsSync(filePath)) return '';
      return fs.readFileSync(filePath, 'utf8').slice(0, maxLen);
    },
    normalizeRelative: (ws, p) => path.relative(ws, p).replace(/\\/g, '/'),
    hashFile: (filePath) => `hash-${path.basename(filePath)}`,
    hashText: (text) => `text-${Buffer.from(String(text)).toString('hex').slice(0, 24)}`,
  };
}

function strategyIntake(id, body) {
  return {
    __type: 'requirement',
    id,
    title: `策略需求 ${id}`,
    body,
  };
}

function strategyPlanSpec(title) {
  return {
    title,
    summary: '覆盖结构化计划生成路径',
    tasks: [
      {
        title: '实现策略路由',
        scope: ['src/loop/planGeneration.js'],
        acceptance: ['按配置选择正确生成路径'],
      },
    ],
    finalValidation: {
      command: 'npm test',
      criteria: ['最终验收阶段统一执行后端测试'],
    },
  };
}

function validStrategyPlanMarkdown(title, scope) {
  return [
    `# ${title}`,
    '',
    '## 任务拆解',
    '',
    `- [ ] P001: ${title} <!-- scope: ${scope} -->`,
    '  - 验收要点：计划生成路径保持兼容。',
    '- [ ] P002: 完整验收 <!-- scope: validation -->',
    '  - 验收要点：最终验收阶段统一执行。',
    '',
    '## 总体验收标准',
    '',
    '```bash',
    'npm test',
    '```',
    '',
    '## 进度区',
    '',
  ].join('\n');
}
