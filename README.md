# AutoPlan

## 简介

一款支持24小时执行编程任务的开源工具，支持项目管理、需求管理、反馈管理、计划任务队列。

所有计划与任务都可以回溯，每次计划与任务都在增加项目的长期记忆。

## 为什么有这个项目？

claude,codex,zcode之类的工具喜欢问问题，事实上讨论需求才需要问问题，需求明确还问个毛线，一个脚本搞定编程任务就行了。

[一个脚本搞定全自动编程](https://www.bilibili.com/video/BV142jX6zEyd)

随着AI越来越智能，编程任务其实就可以像人工智能驾驶一样，逐渐卸载方向盘了。

人工智能驾驶，需要给它目的地和路况，那么AutoPlan也一样，只需要给它需求和反馈。

也就是说，项目开发只需要需求与反馈的循环，就可以让项目无限趋近100%完成任务。

这个可以验证，[ai哲学，解决99%编程问题](https://www.bilibili.com/video/BV1TsEC6DEik)。

随着需求和反馈的循环，项目会越来越完善，你的钱包也会越来越完善。


## 快速开始

1.安装codex/claude/opencode

2.安装autoplan

3.创建项目

4.启动循环(工作界面，右上角启动)

5.提需求(可以通过第三方工具讨论需求，然后mcp发送给autoplan执行)

6.提反馈

7.验收(对完成的任务进行人工验收即可)

## 计划生成与执行配置

AutoPlan 现在把"生成计划"和"执行任务"拆成两组独立配置。默认仍兼容老版本：未填写新字段时，计划生成走 `external-cli-markdown`，任务执行走 `external-cli`，provider 从旧 `agentCliProvider` 读取，最后回退到 `codex`。

### 计划生成策略

| 策略 | 含义 | 适用场景 |
| --- | --- | --- |
| `external-cli-markdown` | 外置 CLI 直接生成 Markdown 计划。 | 默认兼容路径，适合继续使用现有 Codex/Claude/OpenCode 工作流。 |
| `external-cli-structured` | 外置 CLI 生成 `PlanSpec` JSON，AutoPlan 校验后确定性渲染 Markdown。 | 希望保留外置 CLI，同时提升计划格式稳定性。 |
| `builtin-llm-structured` | 内置 LLM 生成 `PlanSpec`，AutoPlan 校验后确定性渲染 Markdown。 | 希望用内置 AI 配置稳定生成计划。使用前必须配置可用的 AI provider、模型和 API key。 |

### 计划执行策略

| 策略 | 含义 | 当前状态 |
| --- | --- | --- |
| `external-cli` | 使用外置 CLI 执行计划任务。 | 已支持，provider 可选 `codex`、`claude`、`opencode`、`oh-my-pi`。 |
| `builtin-llm` | 预留给内置 LLM 执行任务。 | 第一阶段未支持。选择后可以保存配置，但执行任务时会明确报 `builtin-llm execution is not supported yet`，不会静默回退到外置 CLI。 |

常用字段含义如下：

| 字段 | 含义 |
| --- | --- |
| `planGenerationStrategy` / `planExecutionStrategy` | 分别选择计划生成策略和任务执行策略。 |
| `planGenerationProvider` / `planExecutionProvider` | 分别选择生成或执行 provider。外置 CLI 使用 `codex`、`claude`、`opencode`、`oh-my-pi`；内置 LLM 使用 `openai`、`deepseek`、`anthropic`。 |
| `planGenerationCommand` / `planExecutionCommand` | 外置 CLI 命令覆盖；仅外置 CLI 策略使用。 |
| `planGenerationModel` / `planExecutionModel` | 内置 LLM 模型名；`planExecutionModel` 当前仅作为预留配置。 |
| `planGenerationCodexReasoningEffort` / `planExecutionCodexReasoningEffort` | Codex provider 的 reasoning effort，可选 `low`、`medium`、`high`、`xhigh`；非 Codex provider 会忽略。 |

推荐组合：

- 稳定兼容：`external-cli-markdown` + `external-cli`，provider 使用 `codex`。
- 外置结构化生成：`external-cli-structured` + `external-cli`，例如生成使用 `claude`，执行使用 `codex` 或 `opencode`。
- 内置稳定生成、外置执行：`builtin-llm-structured` + `external-cli`，例如生成使用 `openai`，执行使用 `codex`。这需要先在 AI 配置中准备 API key。

项目默认配置示例：

```json
{
  "planGenerationStrategy": "builtin-llm-structured",
  "planGenerationProvider": "openai",
  "planGenerationModel": "model-from-ai-config",
  "planExecutionStrategy": "external-cli",
  "planExecutionProvider": "codex",
  "planExecutionCommand": "",
  "planExecutionCodexReasoningEffort": "medium"
}
```

### UI 与 MCP 兼容说明

- 工作区设置页已拆成"计划生成方案"和"计划执行方案"。生成配置只影响后续计划生成，执行配置只影响后续任务执行。
- Composer 创建单条需求/反馈时只能覆盖本次计划生成方案，也就是 `planGeneration*` 字段；不会覆盖 `planExecution*` 字段。任务执行方案来自项目默认值和生成计划时保存的 plan 快照。
- MCP `create_project` 支持同时传 `planGeneration*` 与 `planExecution*`。`create_requirement` / `create_feedback` 只支持传 `planGeneration*` 覆盖。
- 旧字段 `agentCliProvider`、`agentCliCommand`、`codexReasoningEffort` 仍兼容。项目级旧字段会映射到生成和执行默认值；单条需求/反馈里的旧字段只映射到计划生成，不会改变执行方案。

单条需求覆盖生成方案示例：

```json
{
  "projectId": 1,
  "title": "新需求",
  "body": "需求正文",
  "planGenerationStrategy": "external-cli-structured",
  "planGenerationProvider": "claude",
  "planGenerationCommand": "claude"
}
```


## 使用教程

[AutoPlan使用教程](https://www.bilibili.com/video/BV1KLTY6oEHe)

[如何让AI 24小时工作？](https://www.bilibili.com/video/BV1ExTK6NEPW)

[AI计划草稿，开发前先对齐需求~](https://www.bilibili.com/video/BV16jTP6YE45)



## 功能列表

- [x] 项目管理
- [x] 工作循环
- [ ] 对话
- [x] 需求
- [x] 反馈
- [x] 计划与任务
- [x] 脚本
- [x] 事件流
- [ ] 终端
- [ ] 执行器

## 相关案例

[AutoPlan重构笔记编辑器](https://www.bilibili.com/video/BV1VcTH6qEKw)

案例征集中：请直接联系下方[联系方式](#联系方式)，或者直接提issue~

## 桌面端截图

### 项目管理
![](./snapshot/projects.png)

### 工作界面
![](./snapshot/workspace.png)

## Star History

<a href="https://www.star-history.com/?repos=lyming99%2Fautoplan&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=lyming99/autoplan&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=lyming99/autoplan&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=lyming99/autoplan&type=date&legend=top-left" />
 </picture>
</a>

## 理念

天之道，损有余而补不足，即没有空中楼阁，AI的根本在于服务于人。

AI不服务于人，那么AI必死，AI服务于人的时候，时代就是进步的。

AI不会淘汰你，淘汰你的是其它人，或者说是你自己。

不必慌张，不必焦虑，用好AI，科技改变生活。

当你不知所措，迷失方向的时候，不妨参考这个视频，
[这套循环，60天不出结果，我拜你为师](https://www.bilibili.com/video/BV1H2KU6oEgz)。


![](./snapshot/chat.jpg)

积极的人士，请点个star，证明一下自己是积极的哈，嘻嘻。


## 联系方式

遇到问题？欢迎联系微信：lyming555，Email: 44185539@qq.com
