const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  AUTOPLAN_OPENCODE_PLAN_AGENT,
  ensureOpenCodePlanAgent,
  openCodePlanAgentFilePath,
  buildOpenCodePlanAgentContent,
} = require('./opencodeAgent');

/**
 * OpenCode 计划生成专用 agent 生成器单元测试（P001，node:test 风格，对齐 planGeneration.test.js）。
 * 覆盖：落盘路径/目录自动创建、frontmatter（mode/permission 允许与拒绝集）、
 * system prompt（格式约束 + 忠实于反馈正文/最小化探索）、幂等性。
 */

describe('OpenCode 计划生成专用 agent 生成器（P001）', () => {
  it('导出常量 AUTOPLAN_OPENCODE_PLAN_AGENT 为带命名空间前缀的 agent 名', () => {
    assert.equal(AUTOPLAN_OPENCODE_PLAN_AGENT, 'autoplan-plan');
  });

  it('落盘到 <workspace>/.opencode/agents/autoplan-plan.md，目录不存在时自动创建', () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'autoplan-oc-agent-'));
    try {
      // 整个 .opencode 目录预置不存在，验证自动创建
      const filePath = ensureOpenCodePlanAgent(workspace);
      assert.equal(filePath, openCodePlanAgentFilePath(workspace));
      assert.ok(fs.existsSync(filePath));
      assert.ok(filePath.endsWith(path.join('.opencode', 'agents', 'autoplan-plan.md')));
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('frontmatter 声明 mode: primary 且 description 非空', () => {
    const content = buildOpenCodePlanAgentContent();
    assert.match(content, /^mode:\s*primary/m);
    assert.match(content, /^description:\s*.+/m);
  });

  it('permission 仅允许 read/edit/glob/grep，显式拒绝 bash/webfetch/websearch/task/todowrite/lsp/skill', () => {
    const content = buildOpenCodePlanAgentContent();
    // 允许的工具（值为 allow）
    for (const tool of ['read', 'edit', 'glob', 'grep']) {
      assert.ok(content.includes(`  ${tool}: allow`), `应允许 ${tool}`);
    }
    // 显式拒绝的工具（值为 deny），从工具层抑制自主探索/联网/子代理
    for (const tool of ['bash', 'webfetch', 'websearch', 'task', 'todowrite', 'lsp', 'skill']) {
      assert.ok(content.includes(`  ${tool}: deny`), `应拒绝 ${tool}`);
    }
    // 危险工具不得出现在 allow 集
    assert.ok(!content.includes('bash: allow'), 'bash 不得被允许');
    assert.ok(!content.includes('webfetch: allow'), 'webfetch 不得被允许');
    assert.ok(!content.includes('task: allow'), 'task 不得被允许');
  });

  it('system prompt 含格式约束与"忠实于反馈正文/最小化探索"约束', () => {
    const content = buildOpenCodePlanAgentContent();
    // 产物格式约束
    assert.ok(content.includes('## 任务拆解'), '应约束产出 ## 任务拆解 章节');
    assert.ok(content.includes('P0NN'), '应约束任务行编号格式 P0NN');
    assert.ok(content.includes('<!-- scope'), '应约束 scope 注释');
    // 忠实于反馈正文、最小化探索
    assert.ok(content.includes('需求/反馈正文'), '应约束仅依据需求/反馈正文');
    assert.ok(/通读整仓|最小化|不得主动通读/.test(content), '应约束最小化/禁止整仓探索');
    // 必须用 write/edit 写入指定输出文件
    assert.ok(/write|edit/.test(content), '应要求用 write/edit 写入输出文件');
    // 不得反问、不得改业务代码
    assert.ok(content.includes('不得反问'), '应约束不得反问');
    assert.ok(/不得改业务代码|不得.*业务代码改动|不读取其他内容/.test(content), '应约束不改业务代码');
  });

  it('重复调用幂等：两次落盘内容完全一致，且等于规范内容', () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'autoplan-oc-agent-'));
    try {
      const filePath = ensureOpenCodePlanAgent(workspace);
      const first = fs.readFileSync(filePath, 'utf8');
      // 再次调用（无论中间是否被改动，均覆写为规范内容）
      ensureOpenCodePlanAgent(workspace);
      const second = fs.readFileSync(filePath, 'utf8');
      assert.equal(first, second);
      assert.equal(first, buildOpenCodePlanAgentContent());
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });
});
