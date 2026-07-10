const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('path');
const {
  analyzeIntakePlanPhasing,
  recoverPlanFromStdout,
  recoverPlanSpecFromStdoutResult,
  generatePlanForIntake,
  isPlanContentValid,
  validatePlanContent,
  shouldGeneratePhasedPlans,
} = require('./planGeneration');
const { BUILTIN_PLAN_GENERATION_ERROR_CODES } = require('./builtinPlanGenerator');
const {
  PLAN_DESCRIPTION_PLACEHOLDER,
  injectPlanDescription,
  normalizePlanMarkdown,
  normalizePlanMarkdownFile,
} = require('./planParser');
const { parsePlanTasksFromMarkdown } = require('./planTaskSync');

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
        '- [ ] P002: 完整验收 <!-- scope: validation -->',
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


describe('recoverPlanSpecFromStdoutResult', () => {
  it('recovers a balanced PlanSpec JSON object from stdout and writes the target file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoplan-spec-stdout-'));
    try {
      const planSpecFile = path.join(dir, 'docs', 'plan', 'plan_spec_stdout.json');
      const spec = strategyPlanSpec('stdout recovery spec');
      const result = recoverPlanSpecFromStdoutResult(
        planSpecFile,
        `prefix\n${JSON.stringify(spec)}\nsuffix`,
        { workspace: dir, helpers: strategyHelpers(dir) },
      );

      assert.equal(result.recovered, true);
      assert.equal(result.classification, 'valid_json');
      assert.equal(result.reason, 'stdout_json_recovered');
      assert.equal(result.targetPath, 'docs/plan/plan_spec_stdout.json');
      assert.equal(JSON.parse(fs.readFileSync(planSpecFile, 'utf8')).title, 'stdout recovery spec');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('classifies markdown stdout without writing a PlanSpec file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoplan-spec-markdown-'));
    try {
      const planSpecFile = path.join(dir, 'docs', 'plan', 'plan_spec_missing.json');
      const result = recoverPlanSpecFromStdoutResult(
        planSpecFile,
        ['# Generated plan', '', '## 任务拆解', '- [ ] P001: wrong artifact <!-- scope: src/a.js -->'].join('\n'),
        { workspace: dir, helpers: strategyHelpers(dir) },
      );

      assert.equal(result.recovered, false);
      assert.equal(result.classification, 'markdown');
      assert.equal(result.reason, 'stdout_markdown_not_json');
      assert.ok(result.error, 'parse error should be retained for diagnostics');
      assert.equal(fs.existsSync(planSpecFile), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('classifies greeting-only stdout as non-json text', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoplan-spec-greeting-'));
    try {
      const result = recoverPlanSpecFromStdoutResult(
        path.join(dir, 'docs', 'plan', 'plan_spec_missing.json'),
        'I need more information before I can create the plan.',
        { workspace: dir, helpers: strategyHelpers(dir) },
      );

      assert.equal(result.recovered, false);
      assert.equal(result.classification, 'non_json_text');
      assert.equal(result.reason, 'stdout_non_json_text');
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
    '- [ ] P002: 完整验收 <!-- scope: validation -->',
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
    const noScope = ['## 任务拆解', '', '- [ ] P001: 任务一', '- [ ] P002: 完整验收 <!-- scope: validation -->'].join('\n');
    assert.equal(isPlanContentValid(noScope), false);
  });

  it('空内容/非字符串 → 校验失败', () => {
    assert.equal(isPlanContentValid(''), false);
    assert.equal(isPlanContentValid(null), false);
    assert.equal(isPlanContentValid(undefined), false);
  });

  it('rejects a task list whose final task is not validation scoped acceptance', () => {
    const invalid = [
      '## 任务拆解',
      '',
      '- [ ] P001: implement feature <!-- scope: src/feature.js -->',
      '- [ ] P002: follow-up work <!-- scope: src/follow.js -->',
    ].join('\n');
    const result = validatePlanContent(invalid);

    assert.equal(result.valid, false);
    assert.match(result.reason, /完整验收|validation/);
  });
});

describe('parsePlanTasksFromMarkdown structured task section filtering', () => {
  it('parses only real top-level task lines in the exact task section', () => {
    const markdown = [
      '# Parser guard',
      '',
      '- [ ] P000: outside before section <!-- scope: src/outside.js -->',
      '',
      '## 任务拆解',
      '',
      '- [ ] P001: implement feature <!-- scope: src/feature.js -->',
      '  - [ ] P099: nested checkbox <!-- scope: src/nested.js -->',
      '> - [ ] P098: quoted checkbox <!-- scope: src/quote.js -->',
      '| - [ ] P097: table checkbox <!-- scope: src/table.js --> |',
      '```markdown',
      '- [ ] P096: fenced checkbox <!-- scope: src/fenced.js -->',
      '```',
      '- [ ] P002: 完整验收 <!-- scope: validation -->',
      '',
      '## 进度区',
      '- [ ] P003: outside after section <!-- scope: src/after.js -->',
    ].join('\n');

    const tasks = parsePlanTasksFromMarkdown(markdown);

    assert.deepEqual(tasks.map((task) => task.key), ['P001', 'P002']);
    assert.deepEqual(tasks.map((task) => task.scope), ['src/feature.js', 'validation']);
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
      const valid = ['## 任务拆解', '', '- [ ] P001: 任务一 <!-- scope: src/foo.js -->', '- [ ] P002: 完整验收 <!-- scope: validation -->', ''].join('\n');
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
      for (const call of svc.insertPlanCalls) {
        const markdown = fs.readFileSync(path.join(dir, call.filePath), 'utf8');
        assertPlanDescription(markdown, intake.body);
      }

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


describe('generatePlanForIntake 计划生成耗时（P006）', () => {
  it('成功生成计划时写入落库字段并在事件 meta 中携带同一耗时', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoplan-duration-ok-'));
    try {
      const { svc } = strategyFlowService({
        status: {
          plan_generation_strategy: 'external-cli-markdown',
          plan_generation_provider: 'claude',
        },
        async runCodex(workspace) {
          const planFile = path.join(workspace, 'docs', 'plan', 'plan_requirement_106_20260704-120000.md');
          fs.mkdirSync(path.dirname(planFile), { recursive: true });
          fs.writeFileSync(planFile, validStrategyPlanMarkdown('耗时记录计划', 'src/loop/planGeneration.js'), 'utf8');
          return { exitCode: 0, output: '', logFile: path.join(workspace, 'duration.log') };
        },
      });

      let result;
      await withDateNowSequence([1000, 3456], async () => {
        result = await generatePlanForIntake(
          svc,
          strategyHelpers(dir),
          'p1',
          dir,
          strategyIntake(106, '这是一段足够长的需求描述，用于校验计划生成耗时会被计算并写入。'),
        );
      });

      assert.equal(result, 801);
      assert.equal(svc.insertPlanCalls[0].planGenerationDurationMs, 2456);
      const generated = svc.events.find((event) => event.type === 'plan.generated');
      assert.ok(generated, '成功生成计划应记录 plan.generated 事件');
      assert.equal(generated.meta.durationMs, 2456);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

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
      const markdown = fs.readFileSync(path.join(dir, svc.insertPlanCalls[0].filePath), 'utf8');
      assertPlanDescription(markdown, '这是一段足够长的需求描述，走 markdown 兼容生成路径。');
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
      const markdown = fs.readFileSync(path.join(dir, svc.insertPlanCalls[0].filePath), 'utf8');
      assertPlanDescription(markdown, '这是一段足够长的需求描述，走结构化文件生成路径。');
      assert.match(markdown, /^## 需求概要\n\n覆盖结构化计划生成路径$/m, '模型 summary 应继续渲染为需求概要');
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
      const markdown = fs.readFileSync(path.join(dir, svc.insertPlanCalls[0].filePath), 'utf8');
      assertPlanDescription(markdown, '这是一段足够长的需求描述，走结构化 stdout 兜底路径。');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('external-cli-structured records markdown stdout diagnostics without inserting a plan', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoplan-p11-structured-markdown-'));
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
            output: ['# Wrong artifact', '', '## 任务拆解', '- [ ] P001: markdown only <!-- scope: src/a.js -->'].join('\n'),
            logFile: '/tmp/opencode-markdown-only.log',
            agentCliProvider: operation.agentCliProvider,
            agentCliCommand: operation.agentCliCommand,
            opencodeAgent: operation.opencodeAgent,
            opencodePlanMode: operation.opencodePlanMode,
          };
        },
      });

      const result = await generatePlanForIntake(
        svc,
        strategyHelpers(dir),
        'p1',
        dir,
        strategyIntake(106, '这是一段足够长的需求描述，用来触发 OpenCode 结构化 PlanSpec 缺失诊断。'),
      );

      assert.equal(result, null);
      assert.equal(svc.insertPlanCalls.length, 0, 'markdown stdout must not insert a plan');
      assert.equal(svc.syncPlanTasksCalls.length, 0, 'markdown stdout must not sync plan_tasks');
      const failure = svc.events.find((event) => event.type === 'plan.spec.missing');
      assert.ok(failure, 'missing PlanSpec should emit plan.spec.missing');
      assert.equal(failure.meta.agentCliProvider, 'opencode');
      assert.equal(failure.meta.planGenerationProvider, 'opencode');
      assert.equal(failure.meta.logFile, '/tmp/opencode-markdown-only.log');
      assert.equal(failure.meta.planSpecFileExists, false);
      assert.match(failure.meta.planSpecTargetPath, /docs\/plan\/plan_spec_requirement_106_/);
      assert.equal(failure.meta.stdoutPlanSpecClassification, 'markdown');
      assert.equal(failure.meta.stdoutPlanSpecRecoveryAttempted, true);
      assert.equal(failure.meta.stdoutPlanSpecRecoveryReason, 'stdout_markdown_not_json');
      assert.equal(failure.meta.planSpecRecoveredFromStdout, false);
      assert.match(failure.meta.stdoutPreview, /Wrong artifact/);
      assert.ok(svc.hooks.some((hook) => hook.hook === 'on:fail'), 'failure should still use the failure hook path');
      assert.ok(svc.dbRuns.some((entry) => entry.sql.includes('last_generate_error = ?')), 'intake failure state should be persisted');
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
      const markdown = fs.readFileSync(path.join(dir, svc.insertPlanCalls[0].filePath), 'utf8');
      assertPlanDescription(markdown, '这是一段足够长的需求描述，走内置 LLM 结构化路径。');
      assert.match(markdown, /^## 需求概要\n\n覆盖结构化计划生成路径$/m, '内置 PlanSpec summary 应继续保留');
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

describe('intake 原始需求描述端到端保留（反馈 #10）', () => {
  it('external-cli-markdown 从 stdout 恢复后注入多行原始正文并保留一级标题', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoplan-description-stdout-'));
    try {
      const body = ['第一行需求正文。', '第二行必须原样进入最终计划。'].join('\n');
      const { svc } = strategyFlowService({
        status: {
          plan_generation_strategy: 'external-cli-markdown',
          plan_generation_provider: 'codex',
        },
        async runCodex(_workspace, prompt) {
          const planFile = prompt.match(/输出文件：(.+)/)?.[1]?.trim();
          fs.mkdirSync(path.dirname(planFile), { recursive: true });
          return {
            exitCode: 0,
            output: `模型回复：\n${validStrategyPlanMarkdown('stdout 恢复计划', 'src/stdout.js')}`,
            logFile: '/tmp/description-stdout.log',
            agentCliProvider: 'codex',
          };
        },
      });

      const result = await generatePlanForIntake(
        svc,
        strategyHelpers(dir),
        'p1',
        dir,
        strategyIntake(201, body),
      );

      assert.equal(result, 801);
      assert.ok(svc.events.some((event) => event.type === 'plan.stdout.recovered'));
      assert.equal(svc.syncPlanTasksCalls.length, 1);
      const markdown = fs.readFileSync(path.join(dir, svc.insertPlanCalls[0].filePath), 'utf8');
      assert.match(markdown, /^# stdout 恢复计划$/m, 'stdout 恢复应保留计划一级标题');
      assertPlanDescription(markdown, body);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('feedback 正文中的标题、checkbox、HTML 注释和代码围栏不会污染任务解析', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoplan-description-feedback-'));
    try {
      const body = [
        '反馈首行。',
        '## 原始正文标题',
        '- [ ] 这不是计划任务',
        '<!-- 原始反馈注释 -->',
        '```markdown',
        '## 任务拆解',
        '- [ ] P999: 围栏中的伪任务 <!-- scope: fake.js -->',
        '```',
      ].join('\n');
      const { svc } = strategyFlowService({
        status: {
          plan_generation_strategy: 'external-cli-markdown',
          plan_generation_provider: 'claude',
        },
        async runCodex(_workspace, prompt) {
          const planFile = prompt.match(/输出文件：(.+)/)?.[1]?.trim();
          fs.mkdirSync(path.dirname(planFile), { recursive: true });
          const modelPlan = validStrategyPlanMarkdown('反馈描述安全计划', 'src/feedback.js').replace(
            '\n\n## 任务拆解',
            '\n\n## 需求描述\n\n> 模型生成的旧描述\n\n## 任务拆解',
          );
          fs.writeFileSync(planFile, modelPlan, 'utf8');
          return { exitCode: 0, output: '', logFile: '/tmp/description-feedback.log', agentCliProvider: 'claude' };
        },
      });

      await generatePlanForIntake(svc, strategyHelpers(dir), 'p1', dir, {
        __type: 'feedback',
        id: 202,
        title: 'Markdown 内容安全反馈',
        body,
      });

      const markdown = fs.readFileSync(path.join(dir, svc.insertPlanCalls[0].filePath), 'utf8');
      assertPlanDescription(markdown, body);
      assert.doesNotMatch(markdown, /^## 原始正文标题$/m);
      assert.doesNotMatch(markdown, /^- \[ \] 这不是计划任务$/m);
      assert.ok(!markdown.includes('模型生成的旧描述'), '已有描述章节应被原始 feedback 正文替换');
      assert.equal(validatePlanContent(markdown).valid, true);
      assert.deepEqual(parsePlanTasksFromMarkdown(markdown).map((task) => task.key), ['P001', 'P002']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('空 requirement 正文使用明确占位文本', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoplan-description-empty-'));
    try {
      const { svc } = strategyFlowService({
        status: { plan_generation_strategy: 'external-cli-markdown' },
        async runCodex(_workspace, prompt) {
          const planFile = prompt.match(/输出文件：(.+)/)?.[1]?.trim();
          fs.mkdirSync(path.dirname(planFile), { recursive: true });
          fs.writeFileSync(planFile, validStrategyPlanMarkdown('空正文计划', 'src/empty.js'), 'utf8');
          return { exitCode: 0, output: '', logFile: '/tmp/description-empty.log' };
        },
      });

      await generatePlanForIntake(svc, strategyHelpers(dir), 'p1', dir, strategyIntake(203, ''));

      const markdown = fs.readFileSync(path.join(dir, svc.insertPlanCalls[0].filePath), 'utf8');
      assertPlanDescription(markdown, '');
      assert.match(markdown, new RegExp(`^> ${PLAN_DESCRIPTION_PLACEHOLDER}$`, 'm'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('已有或重复描述章节经注入与 Markdown 规范化后保持幂等', () => {
    const body = [
      '真实正文',
      '## 嵌入标题',
      '- [ ] 嵌入 checkbox',
      '<!-- 嵌入注释 -->',
      '```js',
      'const value = true;',
      '```',
    ].join('\n');
    const input = validStrategyPlanMarkdown('幂等计划', 'src/idempotent.js')
      .replace(
        '\n\n## 任务拆解',
        '\n\n## 需求描述\n\n旧描述一\n\n## 任务拆解',
      )
      .replace(
        '\n\n## 进度区',
        '\n\n## 需求描述\n\n旧描述二\n\n## 进度区',
      );

    const once = injectPlanDescription(input, body);
    const twice = injectPlanDescription(once, body);
    const normalized = normalizePlanMarkdown(once);

    assert.equal(twice, once, '重复注入不应改变 plan');
    assert.equal(normalized, once, '安全描述区块不应被 Markdown 规范化改写');
    assert.equal(normalizePlanMarkdown(normalized), normalized, '重复规范化应保持稳定');
    assertPlanDescription(once, body);
    assert.ok(!once.includes('旧描述一'));
    assert.ok(!once.includes('旧描述二'));
    assert.deepEqual(parsePlanTasksFromMarkdown(once).map((task) => task.key), ['P001', 'P002']);
  });
});

describe('generatePlanForIntake @ mention prompt context (P004)', () => {
  function mentionRows(sql, params) {
    const id = Number(params[1]);
    if (sql.includes('FROM requirements') && id === 12) {
      return {
        id: 12,
        project_id: 'p1',
        title: '\u767b\u5f55\u6539\u9020',
        body: '\u9700\u8981\u652f\u6301\u90ae\u7bb1\u767b\u5f55\uff0c\u5e76\u4fdd\u7559\u5df2\u6709\u624b\u673a\u53f7\u767b\u5f55\u5165\u53e3\u3002',
        status: 'open',
        updated_at: '2026-07-01 10:00:00',
      };
    }
    if (sql.includes('FROM requirements') && id === 22) {
      return {
        id: 22,
        project_id: 'p1',
        title: '\u5bfc\u51fa PlanSpec',
        body: '\u7ed3\u6784\u5316\u8ba1\u5212\u751f\u6210\u9700\u8981\u5f15\u7528\u9700\u6c42\u4e0a\u4e0b\u6587\u3002',
        status: 'accepted',
        updated_at: '2026-07-02 10:00:00',
      };
    }
    if (sql.includes('FROM requirements') && id === 32) {
      return {
        id: 32,
        project_id: 'p1',
        title: '\u5185\u7f6e\u7ed3\u6784\u5316\u751f\u6210',
        body: '\u5185\u7f6e LLM prompt \u4e5f\u8981\u5305\u542b\u5f15\u7528\u6458\u8981\u3002',
        status: 'open',
        updated_at: '2026-07-03 10:00:00',
      };
    }
    if (sql.includes('FROM feedback') && id === 7) {
      return {
        id: 7,
        project_id: 'p1',
        title: '\u7528\u6237\u53cd\u9988\u767b\u5f55\u6162',
        body: '\u7528\u6237\u53cd\u9988\u767b\u5f55\u9875\u9996\u5c4f\u54cd\u5e94\u504f\u6162\uff0c\u9700\u8981\u6392\u67e5\u63a5\u53e3\u548c\u8d44\u6e90\u52a0\u8f7d\u3002',
        status: 'triaged',
        updated_at: '2026-07-04 10:00:00',
      };
    }
    return null;
  }

  it('external-cli-markdown prompt includes de-duplicated requirement and feedback mention summaries', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoplan-p004-mentions-markdown-'));
    try {
      const { svc } = strategyFlowService({
        status: {
          plan_generation_strategy: 'external-cli-markdown',
          plan_generation_provider: 'claude',
        },
        dbGet: mentionRows,
        async runCodex(workspace, prompt) {
          const planFile = prompt.match(/\u8f93\u51fa\u6587\u4ef6\uff1a(.+)/)?.[1]?.trim();
          fs.mkdirSync(path.dirname(planFile), { recursive: true });
          fs.writeFileSync(planFile, validStrategyPlanMarkdown('Mention Context Markdown', 'src/login.js'), 'utf8');
          return { exitCode: 0, output: '', logFile: path.join(workspace, 'mentions-markdown.log') };
        },
      });

      await generatePlanForIntake(
        svc,
        strategyHelpers(dir),
        'p1',
        dir,
        strategyIntake(301, '\u8bf7\u7ed3\u5408 @\u9700\u6c42#12 \u548c @\u53cd\u9988#7 \u63a8\u8fdb\u767b\u5f55\u4f18\u5316\uff0c\u5e76\u518d\u6b21\u53c2\u8003 @\u9700\u6c42#12\uff0c\u751f\u6210\u53ef\u6267\u884c\u8ba1\u5212\u3002'),
      );

      const prompt = svc.runCodexCalls[0].prompt;
      assert.match(prompt, /@ \u5f15\u7528\u4e0a\u4e0b\u6587/);
      assert.match(prompt, /@\u9700\u6c42#12/);
      assert.match(prompt, /\u767b\u5f55\u6539\u9020/);
      assert.match(prompt, /\u9700\u8981\u652f\u6301\u90ae\u7bb1\u767b\u5f55/);
      assert.match(prompt, /@\u53cd\u9988#7/);
      assert.match(prompt, /\u7528\u6237\u53cd\u9988\u767b\u5f55\u6162/);
      const context = prompt.slice(prompt.indexOf('@ \u5f15\u7528\u4e0a\u4e0b\u6587'));
      assert.equal((context.match(/@\u9700\u6c42#12/g) || []).length, 1, 'duplicate @requirement mention is summarized once');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('external-cli-structured prompt keeps PlanSpec contract and includes mention context', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoplan-p004-mentions-structured-'));
    try {
      const { svc } = strategyFlowService({
        status: {
          plan_generation_strategy: 'external-cli-structured',
          plan_generation_provider: 'codex',
        },
        dbGet: mentionRows,
        async runCodex(_workspace, prompt) {
          const planSpecFile = prompt.match(/PlanSpec JSON \u8f93\u51fa\u6587\u4ef6\uff1a(.+)/)?.[1]?.trim();
          fs.mkdirSync(path.dirname(planSpecFile), { recursive: true });
          fs.writeFileSync(planSpecFile, JSON.stringify(strategyPlanSpec('Mention Context PlanSpec'), null, 2), 'utf8');
          return { exitCode: 0, output: '', logFile: '/tmp/mentions-structured.log' };
        },
      });

      await generatePlanForIntake(
        svc,
        strategyHelpers(dir),
        'p1',
        dir,
        strategyIntake(302, '\u8bf7\u57fa\u4e8e @\u9700\u6c42#22 \u751f\u6210\u7ed3\u6784\u5316\u8ba1\u5212\uff0c\u5e76\u4fdd\u6301 PlanSpec \u5951\u7ea6\u3002'),
      );

      const prompt = svc.runCodexCalls[0].prompt;
      assert.match(prompt, /PlanSpec \u5951\u7ea6\uff1a/);
      assert.match(prompt, /@ \u5f15\u7528\u4e0a\u4e0b\u6587/);
      assert.match(prompt, /@\u9700\u6c42#22/);
      assert.match(prompt, /\u7ed3\u6784\u5316\u8ba1\u5212\u751f\u6210\u9700\u8981\u5f15\u7528\u9700\u6c42\u4e0a\u4e0b\u6587/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('builtin-llm-structured prompt includes mention context and submit_plan_spec constraints', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoplan-p004-mentions-builtin-'));
    try {
      const { svc } = strategyFlowService({
        status: {
          plan_generation_strategy: 'builtin-llm-structured',
          plan_generation_provider: 'openai',
          plan_generation_model: 'gpt-4o',
        },
        dbGet: mentionRows,
        async generateBuiltinPlanSpec(input) {
          svc.builtinInputs.push(input);
          return { planSpec: strategyPlanSpec('Mention Context Builtin PlanSpec'), aiConfig: { provider: 'openai', model: 'gpt-4o', hasApiKey: true }, output: '' };
        },
      });

      await generatePlanForIntake(
        svc,
        strategyHelpers(dir),
        'p1',
        dir,
        strategyIntake(303, '\u8bf7\u7ed3\u5408 @\u9700\u6c42#32 \u751f\u6210\u5185\u7f6e\u7ed3\u6784\u5316\u8ba1\u5212\u3002'),
      );

      const prompt = svc.builtinInputs[0].prompt;
      assert.match(prompt, /submit_plan_spec/);
      assert.match(prompt, /Markdown/);
      assert.match(prompt, /@ \u5f15\u7528\u4e0a\u4e0b\u6587/);
      assert.match(prompt, /\u5185\u7f6e LLM prompt \u4e5f\u8981\u5305\u542b\u5f15\u7528\u6458\u8981/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('mentions to self or missing current-project records produce readable prompt hints', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoplan-p004-mentions-missing-'));
    try {
      const { svc } = strategyFlowService({
        status: {
          plan_generation_strategy: 'external-cli-markdown',
          plan_generation_provider: 'claude',
        },
        dbGet: () => null,
        async runCodex(workspace, prompt) {
          const planFile = prompt.match(/\u8f93\u51fa\u6587\u4ef6\uff1a(.+)/)?.[1]?.trim();
          fs.mkdirSync(path.dirname(planFile), { recursive: true });
          fs.writeFileSync(planFile, validStrategyPlanMarkdown('Mention Missing Hints', 'src/missing.js'), 'utf8');
          return { exitCode: 0, output: '', logFile: path.join(workspace, 'mentions-missing.log') };
        },
      });

      await generatePlanForIntake(
        svc,
        strategyHelpers(dir),
        'p1',
        dir,
        strategyIntake(1, '\u56f4\u7ed5 @\u9700\u6c42#1 \u548c @\u53cd\u9988#404 \u7ee7\u7eed\u63a8\u8fdb\uff0c\u8fd9\u662f\u4e00\u6bb5\u8db3\u591f\u957f\u7684\u9700\u6c42\u63cf\u8ff0\u3002'),
      );

      const prompt = svc.runCodexCalls[0].prompt;
      assert.match(prompt, /@\u9700\u6c42#1\uff1a\u5f15\u7528\u81ea\u8eab\uff0c\u5df2\u8df3\u8fc7\u6b63\u6587\u6ce8\u5165\u4ee5\u907f\u514d\u91cd\u590d\u3002/);
      assert.match(prompt, /@\u53cd\u9988#404\uff1a\u672a\u627e\u5230\u5f53\u524d\u9879\u76ee\u5185\u5bf9\u5e94\u8bb0\u5f55\uff0c\u6309\u666e\u901a\u6587\u672c\u5f15\u7528\u5904\u7406\u3002/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('generatePlanForIntake @ mention prompt regression coverage (P005)', () => {
  it('external-cli-markdown keeps mention summaries, project prompt, and Markdown task constraints together', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoplan-p005-mentions-project-prompt-'));
    try {
      const { svc } = strategyFlowService({
        status: {
          project_prompt: 'P005 project prompt: keep intake mention context with local planning rules.',
          plan_generation_strategy: 'external-cli-markdown',
          plan_generation_provider: 'codex',
        },
        dbGet(sql, params) {
          if (sql.includes('FROM requirements') && Number(params[1]) === 44) {
            return {
              id: 44,
              project_id: 'p1',
              title: '\u88ab\u5f15\u7528\u9700\u6c42',
              body: '\u8fd9\u662f\u4e00\u6bb5\u88ab @ \u5f15\u7528\u6ce8\u5165\u5230 prompt \u7684\u9700\u6c42\u6458\u8981\u3002',
              status: 'open',
              updated_at: '2026-07-05 10:00:00',
            };
          }
          if (sql.includes('FROM feedback') && Number(params[1]) === 45) {
            return {
              id: 45,
              project_id: 'p1',
              title: '\u88ab\u5f15\u7528\u53cd\u9988',
              body: '\u53cd\u9988\u6458\u8981\u4e5f\u5e94\u8be5\u51fa\u73b0\u5728 prompt \u4e2d\u3002',
              status: 'triaged',
              updated_at: '2026-07-06 10:00:00',
            };
          }
          return null;
        },
        async runCodex(workspace, prompt) {
          const planFile = prompt.match(/\u8f93\u51fa\u6587\u4ef6\uff1a(.+)/)?.[1]?.trim();
          fs.mkdirSync(path.dirname(planFile), { recursive: true });
          fs.writeFileSync(planFile, validStrategyPlanMarkdown('P005 mention project prompt', 'src/p005.js'), 'utf8');
          return { exitCode: 0, output: '', logFile: path.join(workspace, 'p005-mentions.log') };
        },
      });

      await generatePlanForIntake(
        svc,
        strategyHelpers(dir),
        'p1',
        dir,
        strategyIntake(305, '\u8bf7\u7ed3\u5408 @\u9700\u6c42#44 \u548c @\u53cd\u9988#45 \u751f\u6210\u8ba1\u5212\uff0c\u5e76\u4fdd\u6301\u9879\u76ee prompt \u4e0e Markdown \u683c\u5f0f\u7ea6\u675f\u3002'),
      );

      const prompt = svc.runCodexCalls[0].prompt;
      assert.match(prompt, /@ \u5f15\u7528\u4e0a\u4e0b\u6587/);
      assert.match(prompt, /@\u9700\u6c42#44/);
      assert.match(prompt, /@\u53cd\u9988#45/);
      assert.match(prompt, /\u88ab\u5f15\u7528\u9700\u6c42/);
      assert.match(prompt, /\u88ab\u5f15\u7528\u53cd\u9988/);
      assert.match(prompt, /P005 project prompt: keep intake mention context with local planning rules\./);
      assert.match(prompt, /\u56fa\u5b9a\u683c\u5f0f\uff1a`- \[ \] P001:/);
      assert.match(prompt, /scope \u5fc5\u586b/);
      assert.match(prompt, /\u5b8c\u6574\u9a8c\u6536/);
      assert.match(prompt, /\u53ea\u5199 plan \u6587\u4ef6\uff0c\u4e0d\u8981\u6539\u4e1a\u52a1\u4ee3\u7801/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

async function withDateNowSequence(values, fn) {
  const originalDateNow = Date.now;
  let index = 0;
  Date.now = () => values[Math.min(index++, values.length - 1)];
  try {
    return await fn();
  } finally {
    Date.now = originalDateNow;
  }
}
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
      get(sql, params = []) {
        if (typeof options.dbGet === 'function') return options.dbGet(sql, params);
        return null;
      },
      all(sql, params = []) {
        if (typeof options.dbAll === 'function') return options.dbAll(sql, params);
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

function assertPlanDescription(markdown, description) {
  const text = String(markdown || '');
  const body = String(description ?? '').replace(/\r\n?/g, '\n');
  const expected = body.trim() ? body : PLAN_DESCRIPTION_PLACEHOLDER;
  const descriptionHeadings = text.match(/^## 需求描述$/gm) || [];
  assert.equal(descriptionHeadings.length, 1, '最终 plan 应只包含一个规范需求描述章节');
  const h1Index = text.search(/^# [^#].*$/m);
  const descriptionIndex = text.indexOf('## 需求描述');
  const taskIndex = text.lastIndexOf('## 任务拆解');
  if (h1Index !== -1) assert.ok(descriptionIndex > h1Index, '需求描述应位于一级标题之后');
  assert.ok(taskIndex === -1 || descriptionIndex < taskIndex, '需求描述应位于任务拆解之前');
  for (const line of expected.split('\n')) {
    const quoted = line ? `> ${line}` : '>';
    assert.ok(text.split(/\r?\n/).includes(quoted), `需求描述应保留引用行：${quoted}`);
  }
}

function assertSkillTransferPromptConstraint(prompt) {
  assert.ok(prompt.includes('用户指定 skill 传递约束：'), 'prompt 应包含用户指定 skill 传递约束标题');
  assert.ok(
    prompt.includes('禁止把“使用某 skill/调用某工具”拆成独立任务项'),
    'prompt 应禁止把 skill 使用拆成独立任务',
  );
  assert.ok(
    prompt.includes('真正需要执行的具体开发任务标题、验收要点或任务说明'),
    'prompt 应要求把 skill 传递到具体任务信息中',
  );
}

function assertMarkdownPlanPromptHardConstraints(prompt) {
  assert.match(prompt, /一级标题之后必须紧接精确二级标题 `## 需求描述`/);
  assert.match(prompt, /只能包含当前 intake 的原始正文/);
  assert.match(prompt, /正文为空时写 `（未提供需求或反馈正文）`/);
  assert.match(prompt, /必须包含精确二级标题 `## 任务拆解`/);
  assert.match(prompt, /固定格式：`- \[ \] P001:/);
  assert.match(prompt, /scope 必填/);
  assert.match(prompt, /完整验收/);
  assert.match(prompt, /`## 进度区` 初始内容不要预置任务状态表格/);
  assert.match(prompt, /只写 (?:plan 文件|manifest 和阶段 plan 文件)，不要改业务代码/);
}

function assertStructuredPlanPromptHardConstraints(prompt, { builtin = false } = {}) {
  if (builtin) {
    assert.match(prompt, /必须通过 submit_plan_spec 结构化工具提交 PlanSpec JSON/);
  } else {
    assert.match(prompt, /只写 PlanSpec JSON 文件，不要写最终 Markdown plan 文件，不要改业务代码/);
  }
  assert.match(prompt, /PlanSpec 契约：/);
  assert.match(prompt, /tasks 是开发任务数组/);
  assert.match(prompt, /scope 必须是字符串数组/);
  assert.match(prompt, /finalValidation/);
  assert.match(prompt, /最终 Markdown 渲染约束/);
  assert.match(prompt, /AutoPlan 渲染出的最终 Markdown 必须包含精确二级标题 `## 任务拆解`/);
  assert.match(prompt, /最终 Markdown 任务行必须由 AutoPlan 连续编号/);
}

describe('plan generation prompt skill transfer constraints', () => {
  it('external-cli-markdown requirement and feedback prompts include skill transfer and Markdown hard constraints', async () => {
    const cases = [
      { type: 'requirement', id: 301 },
      { type: 'feedback', id: 302 },
    ];

    for (const item of cases) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), `autoplan-skill-markdown-${item.type}-`));
      try {
        const { svc } = strategyFlowService({
          status: {
            plan_generation_strategy: 'external-cli-markdown',
            plan_generation_provider: 'codex',
          },
          async runCodex(_workspace, prompt) {
            const planFile = prompt.match(/输出文件：(.+)/)?.[1]?.trim();
            fs.mkdirSync(path.dirname(planFile), { recursive: true });
            fs.writeFileSync(planFile, validStrategyPlanMarkdown(`skill ${item.type}`, 'src/skill.js'), 'utf8');
            return { exitCode: 0, output: '', logFile: '/tmp/skill-markdown.log', agentCliProvider: 'codex' };
          },
        });

        await generatePlanForIntake(svc, strategyHelpers(dir), 'p1', dir, {
          __type: item.type,
          id: item.id,
          title: `skill ${item.type}`,
          body: '请使用 $SkillName 处理这段足够长的需求描述，并生成可执行计划。',
        });

        const prompt = svc.runCodexCalls[0].prompt;
        assertSkillTransferPromptConstraint(prompt);
        assertMarkdownPlanPromptHardConstraints(prompt);
        assert.match(prompt, new RegExp(`${item.type === 'feedback' ? '反馈' : '需求'} #${item.id} 内容：`));
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('external-cli-structured prompt includes skill transfer and PlanSpec hard constraints', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoplan-skill-structured-'));
    try {
      const { svc } = strategyFlowService({
        status: {
          plan_generation_strategy: 'external-cli-structured',
          plan_generation_provider: 'claude',
        },
        async runCodex(_workspace, prompt, _label, operation) {
          const planSpecFile = prompt.match(/PlanSpec JSON 输出文件：(.+)/)?.[1]?.trim();
          fs.mkdirSync(path.dirname(planSpecFile), { recursive: true });
          fs.writeFileSync(planSpecFile, JSON.stringify(strategyPlanSpec('skill structured'), null, 2), 'utf8');
          return { exitCode: 0, output: '', logFile: '/tmp/skill-structured.log', agentCliProvider: operation.agentCliProvider };
        },
      });

      await generatePlanForIntake(svc, strategyHelpers(dir), 'p1', dir, strategyIntake(303, '请使用 $SkillName 处理这段足够长的结构化需求描述。'));

      const prompt = svc.runCodexCalls[0].prompt;
      assertSkillTransferPromptConstraint(prompt);
      assertStructuredPlanPromptHardConstraints(prompt);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('builtin-llm-structured prompt includes skill transfer and submit_plan_spec contract', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoplan-skill-builtin-'));
    try {
      const { svc } = strategyFlowService({
        status: {
          plan_generation_strategy: 'builtin-llm-structured',
          plan_generation_provider: 'openai',
          plan_generation_model: 'gpt-4o',
        },
        async generateBuiltinPlanSpec(input) {
          svc.builtinInputs.push(input);
          return { planSpec: strategyPlanSpec('skill builtin'), aiConfig: { provider: 'openai', model: 'gpt-4o', hasApiKey: true }, output: '' };
        },
      });

      await generatePlanForIntake(svc, strategyHelpers(dir), 'p1', dir, strategyIntake(304, '请使用 $SkillName 处理这段足够长的内置结构化需求描述。'));

      const prompt = svc.builtinInputs[0].prompt;
      assertSkillTransferPromptConstraint(prompt);
      assertStructuredPlanPromptHardConstraints(prompt, { builtin: true });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('phased plan prompt includes skill transfer and per-phase Markdown hard constraints', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoplan-skill-phased-'));
    try {
      const helpers = helpersForPhased(dir);
      const { svc, captured } = phasedFlowService(dir);
      await generatePlanForIntake(svc, helpers, 'p1', dir, {
        __type: 'requirement',
        id: 77,
        title: 'skill phased',
        body: '请使用 $SkillName 分阶段推进：第一阶段建立模型，第二阶段完成界面和验收。',
      });

      const prompt = captured.prompt;
      assertSkillTransferPromptConstraint(prompt);
      assert.match(prompt, /每个阶段 plan 的格式要求：/);
      assertMarkdownPlanPromptHardConstraints(prompt);
      assert.match(prompt, /只写 manifest 和阶段 plan 文件，不要改业务代码/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('normalizePlanMarkdown 规范化（反馈 #95）', () => {
  it('数字编号前缀 ## 2. 任务拆解 → ## 任务拆解', () => {
    assert.equal(normalizePlanMarkdown('## 2. 任务拆解\n'), '## 任务拆解\n');
  });

  it('阿拉伯数字 + 中文顿号 ## 2、任务拆解 → ## 任务拆解', () => {
    assert.equal(normalizePlanMarkdown('## 2、任务拆解'), '## 任务拆解');
  });

  it('无空格紧凑写法 ##2.任务拆解 → ## 任务拆解', () => {
    assert.equal(normalizePlanMarkdown('##2.任务拆解'), '## 任务拆解');
  });

  it('中文数字编号前缀 ## 二、任务拆解 → ## 任务拆解', () => {
    assert.equal(normalizePlanMarkdown('## 二、任务拆解'), '## 任务拆解');
  });

  it('错误层级 ### 任务拆解 → ## 任务拆解', () => {
    assert.equal(normalizePlanMarkdown('### 任务拆解'), '## 任务拆解');
  });

  it('一级标题 # 任务拆解 也修正为二级', () => {
    assert.equal(normalizePlanMarkdown('# 任务拆解'), '## 任务拆解');
  });

  it('同步规范化 总体验收标准 / 进度区 的编号前缀与错误层级', () => {
    const input = ['## 1. 任务拆解', '## 2. 总体验收标准', '### 进度区'].join('\n');
    assert.equal(
      normalizePlanMarkdown(input),
      ['## 任务拆解', '## 总体验收标准', '## 进度区'].join('\n'),
    );
  });

  it('无前缀任务行按出现顺序补齐连续 P0NN 编号（不跳号）', () => {
    const input = ['## 任务拆解', '', '- [ ] 实现规范化', '- [ ] 接入校验'].join('\n');
    const out = normalizePlanMarkdown(input);
    assert.ok(out.includes('- [ ] P001: 实现规范化 <!-- scope: unknown -->'));
    assert.ok(out.includes('- [ ] P002: 接入校验 <!-- scope: unknown -->'));
  });

  it('任务行缺失 scope 注释时补 unknown，已有 scope 保留', () => {
    const input = [
      '## 任务拆解',
      '',
      '- [ ] P009: 保留 scope <!-- scope: src/a.js -->',
      '- [ ] 补 unknown',
    ].join('\n');
    const out = normalizePlanMarkdown(input);
    assert.ok(out.includes('- [ ] P001: 保留 scope <!-- scope: src/a.js -->'), '已有 scope 应保留且重排为 P001');
    assert.ok(out.includes('- [ ] P002: 补 unknown <!-- scope: unknown -->'), '缺失 scope 应补 unknown');
  });

  it('幂等：已是规范内容经规范化后字符串不变', () => {
    const standard = [
      '# 反馈 #95 计划',
      '',
      '## 任务拆解',
      '',
      '- [ ] P001: 任务一 <!-- scope: src/a.js -->',
      '- [ ] P002: 任务二 <!-- scope: src/b.js -->',
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
    assert.equal(normalizePlanMarkdown(standard), standard);
    assert.equal(normalizePlanMarkdown(normalizePlanMarkdown(standard)), standard);
  });

  it('幂等：带漂移的 plan 二次规范化稳定', () => {
    const drifted = ['## 2. 任务拆解', '', '- [ ] 任务一'].join('\n');
    const once = normalizePlanMarkdown(drifted);
    assert.equal(normalizePlanMarkdown(once), once);
  });

  it('围栏代码块内的标题与任务行不被改动', () => {
    const input = [
      '## 任务拆解',
      '',
      '```markdown',
      '## 2. 任务拆解',
      '- [ ] 不是真任务',
      '```',
      '',
      '- [ ] 真任务',
    ].join('\n');
    const out = normalizePlanMarkdown(input);
    assert.ok(
      out.includes('```markdown\n## 2. 任务拆解\n- [ ] 不是真任务\n```'),
      '代码块内容应原样保留',
    );
    assert.ok(out.includes('- [ ] P001: 真任务 <!-- scope: unknown -->'), '代码块外的真任务应被编号');
  });

  it('只动已知标题与任务行，其它标题/段落不受影响', () => {
    const input = [
      '# 标题',
      '',
      '## 需求概要',
      '正文里提到任务拆解但不是标题。',
      '',
      '## 1. 任务拆解',
      '',
      '- [ ] 任务一',
    ].join('\n');
    const out = normalizePlanMarkdown(input);
    assert.ok(out.includes('## 需求概要'), '非目标标题应保留');
    assert.ok(out.includes('正文里提到任务拆解但不是标题。'), '正文段落应保留');
    assert.ok(out.includes('## 任务拆解'), '目标标题应被规范化');
  });

  it('规范化后漂移 plan 通过 isPlanContentValid 校验', () => {
    const drifted = ['## 2. 任务拆解', '', '- [ ] 实现规范化 <!-- scope: src/a.js -->', '- [ ] 完整验收 <!-- scope: validation -->'].join('\n');
    assert.equal(isPlanContentValid(drifted), false, '规范化前应判为不合规');
    assert.equal(isPlanContentValid(normalizePlanMarkdown(drifted)), true, '规范化后应通过校验');
  });

  it('normalizePlanMarkdownFile 幂等：规范内容不写盘', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoplan-norm-idem-'));
    try {
      const file = path.join(dir, 'plan.md');
      const standard = ['## 任务拆解', '', '- [ ] P001: 任务一 <!-- scope: src/a.js -->', '- [ ] P002: 完整验收 <!-- scope: validation -->'].join('\n');
      fs.writeFileSync(file, standard, 'utf8');
      assert.equal(normalizePlanMarkdownFile(file), false, '规范内容不应触发写盘');
      assert.equal(fs.readFileSync(file, 'utf8'), standard, '内容应不变');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('normalizePlanMarkdownFile 对漂移文件写回规范化内容', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoplan-norm-fix-'));
    try {
      const file = path.join(dir, 'plan.md');
      const drifted = ['## 2. 任务拆解', '', '- [ ] 任务一'].join('\n');
      fs.writeFileSync(file, drifted, 'utf8');
      assert.equal(normalizePlanMarkdownFile(file), true, '漂移内容应触发写盘');
      const content = fs.readFileSync(file, 'utf8');
      assert.ok(content.includes('## 任务拆解'), '标题应被规范化');
      assert.ok(!content.includes('## 2. 任务拆解'), '原标题应被移除');
      assert.ok(
        content.includes('- [ ] P001: 任务一 <!-- scope: unknown -->'),
        '任务行应补 P001 与 scope',
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('generatePlanForIntake 标题漂移经规范化后成功落库（反馈 #95）', () => {
  // runCodex 写出带编号前缀标题的漂移 plan，捕获 insertPlan/syncPlanTasks/事件以校验规范化兜底链路。
  function driftedPlanService(planFilePath, planContent) {
    const events = [];
    let insertCalls = 0;
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
      async runHookScripts() {},
      insertPlan() {
        insertCalls += 1;
        return 1;
      },
      syncPlanTasks() {
        synced = true;
      },
      db: {
        all() {
          return [];
        },
        run() {},
      },
    };
    return { svc, events, insertCount: () => insertCalls, isSynced: () => synced };
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

  it('claude 写出 ## 2. 任务拆解 标题 → 规范化后成功落库（plans>0、plan_tasks 同步），不触发 plan.format.invalid', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoplan-p95-drift-'));
    try {
      const planFilePath = path.join(dir, 'docs', 'plan', 'plan_requirement_1_20260629-120000.md');
      // 模拟 claude 直写：带编号前缀的三个二级标题 + 无 P0NN 前缀的任务行
      const drifted = [
        '# 反馈 #95 计划',
        '',
        '## 2. 任务拆解',
        '',
        '- [ ] 实现规范化函数 <!-- scope: src/loop/planParser.js -->',
        '- [ ] 接入校验流程 <!-- scope: src/loop/planGeneration.js -->',
        '- [ ] 完整验收 <!-- scope: validation -->',
        '',
        '## 3. 总体验收标准',
        '',
        '最终验收命令：npm test',
        '',
        '## 4. 进度区',
        '',
      ].join('\n');
      const { svc, events, insertCount, isSynced } = driftedPlanService(planFilePath, drifted);

      const intake = { __type: 'requirement', id: 1, body: '这是一段足够长的需求描述超过二十个字符。' };
      const result = await generatePlanForIntake(svc, helpersFor(), 'p1', dir, intake);

      assert.ok(result, '规范化后应返回 plan id（成功落库）');
      assert.ok(insertCount() > 0, 'plans 计数应 > 0（已 insertPlan）');
      assert.equal(isSynced(), true, 'plan_tasks 应同步成功');
      assert.ok(!events.some((e) => e.type === 'plan.format.invalid'), '不应触发 plan.format.invalid');
      // 磁盘文件经规范化：标题与任务行均为规范写法
      const onDisk = fs.readFileSync(planFilePath, 'utf8');
      assert.ok(onDisk.includes('## 任务拆解'), '磁盘文件应含规范 ## 任务拆解');
      assert.ok(!onDisk.includes('## 2. 任务拆解'), '磁盘文件不应再含漂移标题');
      assert.ok(
        onDisk.includes('- [ ] P001: 实现规范化函数 <!-- scope: src/loop/planParser.js -->'),
        '任务行应补 P001 且保留 scope',
      );
      assert.ok(onDisk.includes('## 总体验收标准'), '总体验收标准应规范化');
      assert.ok(onDisk.includes('## 进度区'), '进度区应规范化');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('project prompt injection for plan generation', () => {
  const projectPrompt = '项目级计划规范：优先小步拆分，并遵守 src/ 目录边界。';

  it('injects project prompt into external-cli-markdown without removing Markdown hard constraints', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoplan-project-prompt-markdown-'));
    try {
      const { svc } = strategyFlowService({
        status: {
          project_prompt: projectPrompt,
          plan_generation_strategy: 'external-cli-markdown',
          plan_generation_provider: 'codex',
        },
        async runCodex(workspace, prompt) {
          const planFile = prompt.match(/输出文件：(.+)/)?.[1]?.trim();
          fs.mkdirSync(path.dirname(planFile), { recursive: true });
          fs.writeFileSync(planFile, validStrategyPlanMarkdown('项目 Prompt Markdown', 'src/prompt.js'), 'utf8');
          return { exitCode: 0, output: '', logFile: path.join(workspace, 'markdown.log'), agentCliProvider: 'codex' };
        },
      });

      await generatePlanForIntake(svc, strategyHelpers(dir), 'p1', dir, strategyIntake(201, '这是一段足够长的需求描述，用于捕获 markdown prompt。'));

      const prompt = svc.runCodexCalls[0].prompt;
      assert.match(prompt, /项目级 Prompt/);
      assert.match(prompt, /项目级计划规范：优先小步拆分/);
      assert.match(prompt, /不能覆盖 AutoPlan 系统级格式/);
      assert.match(prompt, /固定格式：`- \[ \] P001:/);
      assert.match(prompt, /只写 (?:plan 文件|manifest 和阶段 plan 文件)，不要改业务代码/);
      assert.ok(prompt.indexOf(projectPrompt) < prompt.indexOf('需求 #201 内容：'), '项目 Prompt 应位于需求正文之外');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('injects project prompt into external-cli-structured without weakening PlanSpec contract', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoplan-project-prompt-structured-'));
    try {
      const { svc } = strategyFlowService({
        status: {
          project_prompt: projectPrompt,
          plan_generation_strategy: 'external-cli-structured',
          plan_generation_provider: 'claude',
        },
        async runCodex(_workspace, prompt, _label, operation) {
          const planSpecFile = prompt.match(/PlanSpec JSON 输出文件：(.+)/)?.[1]?.trim();
          fs.mkdirSync(path.dirname(planSpecFile), { recursive: true });
          fs.writeFileSync(planSpecFile, JSON.stringify(strategyPlanSpec('项目 Prompt PlanSpec'), null, 2), 'utf8');
          return { exitCode: 0, output: '', logFile: '/tmp/structured-project-prompt.log', agentCliProvider: operation.agentCliProvider };
        },
      });

      await generatePlanForIntake(svc, strategyHelpers(dir), 'p1', dir, strategyIntake(202, '这是一段足够长的需求描述，用于捕获 structured prompt。'));

      const prompt = svc.runCodexCalls[0].prompt;
      assert.match(prompt, /项目级 Prompt/);
      assert.match(prompt, /项目级计划规范：优先小步拆分/);
      assert.match(prompt, /PlanSpec 契约：/);
      assert.match(prompt, /只写 PlanSpec JSON 文件，不要写最终 Markdown plan 文件，不要改业务代码/);
      assert.ok(prompt.indexOf(projectPrompt) < prompt.indexOf('需求 #202 内容：'), '项目 Prompt 应位于需求正文之外');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('injects project prompt into builtin-llm-structured prompt while keeping structured contract', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoplan-project-prompt-builtin-'));
    try {
      const { svc } = strategyFlowService({
        status: {
          project_prompt: projectPrompt,
          plan_generation_strategy: 'builtin-llm-structured',
          plan_generation_provider: 'openai',
          plan_generation_model: 'gpt-4o',
        },
        async generateBuiltinPlanSpec(input) {
          svc.builtinInputs.push(input);
          return { planSpec: strategyPlanSpec('项目 Prompt 内置 PlanSpec'), aiConfig: { provider: 'openai', model: 'gpt-4o', hasApiKey: true }, output: '' };
        },
      });

      await generatePlanForIntake(svc, strategyHelpers(dir), 'p1', dir, strategyIntake(203, '这是一段足够长的需求描述，用于捕获 builtin prompt。'));

      const prompt = svc.builtinInputs[0].prompt;
      assert.match(prompt, /项目级 Prompt/);
      assert.match(prompt, /项目级计划规范：优先小步拆分/);
      assert.match(prompt, /必须通过 submit_plan_spec 结构化工具提交 PlanSpec JSON/);
      assert.match(prompt, /最终 Markdown 渲染约束/);
      assert.ok(prompt.indexOf(projectPrompt) < prompt.indexOf('需求 #203 内容：'), '项目 Prompt 应位于需求正文之外');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
