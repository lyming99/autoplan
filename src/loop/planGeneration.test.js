const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('path');
const { recoverPlanFromStdout, generatePlanForIntake, isPlanContentValid } = require('./planGeneration');

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
