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

## 项目级 Prompt

项目设置里可以填写“项目级 Prompt”，用于给当前项目补充长期生效的代码规范、计划拆解偏好和执行约束。例如：要求遵循现有目录风格、控制单个任务的修改范围、优先小步拆分、不要引入某类依赖等。

作用范围：

- 计划生成：`external-cli-markdown`、`external-cli-structured` 和 `builtin-llm-structured` 都会在需求正文之外收到当前项目级 Prompt。
- 任务执行：执行单个 plan task、重试、恢复同一 plan 前序会话、重做补充内容等场景都会带上同一项目级 Prompt。
- 项目隔离：项目级 Prompt 存在当前项目配置中，不会影响其它项目。
- 空值行为：留空表示不追加项目级 Prompt；保存为空字符串会清空已有项目级 Prompt。

项目级 Prompt 只能补充项目约定，不能覆盖 AutoPlan 的系统级硬约束。它不能改变任务拆解 Markdown 格式、PlanSpec JSON 契约、只写指定输出文件、只执行当前 checkbox、plan 文件只读、scope 隔离和最终验收边界；发生冲突时，AutoPlan 硬约束优先。

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

## 结构化计划格式

AutoPlan 支持两类计划生成产物：

- `external-cli-markdown`：外部 CLI 直接写最终 Markdown plan。
- `external-cli-structured` / `builtin-llm-structured`：先生成结构化 `PlanSpec` JSON，再由 AutoPlan 确定性渲染为 Markdown plan。

结构化 `PlanSpec` 必须是合法 JSON 对象，核心字段为 `title`、`summary`、`tasks`、`finalValidation`。`tasks` 中只写任务标题、影响范围 `scope` 和验收要点，不手写 P001/P002 编号；最终 Markdown 由 AutoPlan 统一渲染。

渲染后的 Markdown 必须满足：

- 包含精确二级标题 `## 任务拆解`。
- 任务必须是该章节下的顶层 checkbox 行，格式为 `- [ ] P001: 任务标题 <!-- scope: src/file.js -->`。
- 编号必须从 P001 连续递增，不能跳号或重复。
- 每个任务必须有 `scope`；无法判断时使用 `unknown`。
- 最后一个任务必须是“完整验收”类任务，且 `scope` 必须为 `validation`。
- 代码块、引用、表格、嵌套 checkbox 不会被当作可执行任务同步到 `plan_tasks`。

OpenCode 作为结构化计划生成后端时，AutoPlan 会使用专用 `autoplan-plan` agent：只允许写指定的 PlanSpec JSON 文件，不允许创建最终 Markdown plan 文件，也不允许修改业务代码、配置或测试文件。若 CLI 没有写入 PlanSpec 文件但 stdout 中包含合法 JSON 对象，AutoPlan 会兜底恢复；若 stdout 只有 Markdown、寒暄或非 JSON 文本，会记录明确的失败诊断并停止落库。

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
