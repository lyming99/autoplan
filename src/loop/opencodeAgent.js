const fs = require('node:fs');
const path = require('node:path');

// AutoPlan 专用 OpenCode 计划生成 agent 名称。使用 `autoplan-` 命名空间前缀，避免与
// 用户既有的 .opencode/agents/*.md 自定义 agent 同名冲突。该名称即 `--agent` 参数取值，
// 由 src/agentCli.js 的 opencodeCliArgs 在计划生成阶段注入（见 P002）。
const AUTOPLAN_OPENCODE_PLAN_AGENT = 'autoplan-plan';

// OpenCode 按项目加载自定义 agent 的目录为 <workspace>/.opencode/agents（复数，官方文档
// opencode.ai/docs/agents 的「Markdown」小节：Per-project: `.opencode/agents/`）。
// 文件名（去掉 .md）即 agent 名，因此 autoplan-plan.md 会被解析为名为 autoplan-plan 的
// primary agent，供 `opencode run --agent autoplan-plan` 直接调用。
const OPENCODE_PLAN_AGENT_DIR = path.join('.opencode', 'agents');

function openCodePlanAgentFilePath(workspace) {
  return path.join(workspace, OPENCODE_PLAN_AGENT_DIR, `${AUTOPLAN_OPENCODE_PLAN_AGENT}.md`);
}

// OpenCode 计划生成 agent 的工具权限策略。
// 依据 opencode.ai/docs/agents：
//  - 当前用 `permission`（单数）字段限制工具；旧版 `tools` 字段已被官方标记为 deprecated
//    （"tools is deprecated, prefer the agent's permission field"）。写 `permissions`/`tools`
//    会被 OpenCode 忽略，等于不限制——这正是反馈 #14 中 OpenCode 自主探索失控的根因，故必须用 permission。
//  - 未在 permission 中显式声明的 key 默认为 allow/ask（非 deny），因此必须显式 deny 所有
//    会引发自主探索/联网/子代理/反问的工具，才能真正把行为收敛到「只读少量文件 + 写计划」。
//  - `edit` 权限同时 gate `write`/`edit`/`apply_patch`，足以覆盖「写入计划文件」所需的写工具。
//  仅 allow read/edit/glob/grep（读、写计划、定位、检索），其余一律 deny。
const OPENCODE_PLAN_AGENT_PERMISSION = [
  '  read: allow', // 读取为判断 scope 所需的少量文件
  '  edit: allow', // 覆盖 write/edit/apply_patch，用于把计划写入输出文件
  '  glob: allow', // 按需按模式定位文件
  '  grep: allow', // 按需检索内容
  '  list: deny', // 禁止整目录列举，抑制整仓浏览
  '  bash: deny', // 禁止执行任何命令
  '  task: deny', // 禁止派生子代理
  '  webfetch: deny', // 禁止联网抓取
  '  websearch: deny', // 禁止联网搜索
  '  todowrite: deny', // 计划生成无需 todo 工具
  '  lsp: deny', // 禁止 LSP 符号查询
  '  skill: deny', // 禁止触发外部 skill
  '  question: deny', // 禁止反问，强制自行推断
  '  external_directory: deny', // 限制在工作区内，不读取外部目录
];

function openCodePlanAgentFrontMatter() {
  return [
    '---',
    'description: "AutoPlan 计划生成专用 agent：仅依据给定需求/反馈正文（及显式列出的附件）生成开发计划，最小化仓库探索，严格遵循 AutoPlan 任务拆解格式并写入指定输出文件。"',
    'mode: primary',
    'temperature: 0.2',
    'permission:',
    ...OPENCODE_PLAN_AGENT_PERMISSION,
    '---',
  ].join('\n');
}

function openCodePlanAgentSystemPrompt() {
  return [
    '你是 AutoPlan 的计划生成 agent，职责是把给定的需求/反馈转化为开发计划并写入指定文件；不得做任何业务代码改动。',
    '',
    '## 唯一指令来源',
    '- 你的唯一输入是用户消息中提供的「需求/反馈正文」，以及消息中显式列出的附件路径或文件清单。',
    '- 不得主动通读整仓（README、目录树、源码全量浏览）后“自行发挥”。除为判断某个任务的 scope 而必须确认的少量明确文件外，不读取其他内容。',
    '- 不得联网检索、不得抓取外部文档、不得派生子代理、不得执行任何命令。',
    '',
    '## 计划主题',
    '- 计划必须忠实于给定需求/反馈正文的主题与范围；不得自行改写、扩展或替换需求主题。',
    '- 正文简短或模糊时，按最合理的工程解释直接推进；禁止反问、禁止请求补充信息、禁止输出“请告诉我/需要更多信息”之类的话。',
    '',
    '## 产物格式（必须严格遵循）',
    '- 必须包含 `## 任务拆解` 二级标题章节，其下列出所有开发任务。',
    '- 每个任务行严格使用固定格式：`- [ ] P0NN: 任务标题 <!-- scope: lib/foo.js,test/foo_test.js -->`，编号从 P001 起连续递增。',
    '- scope 必填，表示该任务预计修改的文件或模块，多个用英文逗号分隔；无法判断时写 `<!-- scope: unknown -->`。',
    '- 每个任务需附验收要点。',
    '- 不要把“运行测试/回归/验收/构建”拆成普通开发任务；最后一个任务必须是“完整验收”节点（标题建议“完整验收”，scope 写 validation），负责对整个 plan 做最终验收。',
    '- 必须包含「总体验收标准」（写明最终验收命令、范围、通过标准）与「进度区」。',
    '',
    '## 落盘方式（关键）',
    '- 必须使用文件写入工具（write/edit，受 edit 权限允许）把完整 plan 内容写入用户消息中指定的「输出文件」路径。',
    '- 仅在回复里打印 plan 不算成功；只有成功写入该输出文件才算完成。',
    '- 只写该 plan 文件，不得创建或修改任何业务代码、配置或测试文件。',
    '',
    '## 禁止事项',
    '- 不得反问用户、不得请求确认或补充信息。',
    '- 不得自主重写计划主题或偏离给定需求。',
    '- 不得改业务代码、不得执行命令、不得联网、不得派生子代理。',
  ].join('\n');
}

function buildOpenCodePlanAgentContent() {
  return `${openCodePlanAgentFrontMatter()}\n\n${openCodePlanAgentSystemPrompt()}\n`;
}

// 幂等生成：每次用规范内容覆写该 agent 文件，确保无论先前是否存在或被改动，落盘后均为
// AutoPlan 期望的受限 primary agent。目录不存在时自动创建。返回写入文件的绝对路径。
function ensureOpenCodePlanAgent(workspace) {
  const filePath = openCodePlanAgentFilePath(workspace);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, buildOpenCodePlanAgentContent(), 'utf8');
  return filePath;
}

module.exports = {
  AUTOPLAN_OPENCODE_PLAN_AGENT,
  OPENCODE_PLAN_AGENT_DIR,
  OPENCODE_PLAN_AGENT_PERMISSION,
  openCodePlanAgentFilePath,
  openCodePlanAgentFrontMatter,
  openCodePlanAgentSystemPrompt,
  buildOpenCodePlanAgentContent,
  ensureOpenCodePlanAgent,
};
