# AutoPlan

Electron 桌面应用：基于 issue/需求驱动的自主规划与开发循环。收集需求与反馈，自动生成开发计划，调用 AI CLI 后端逐个执行任务，并通过验收命令闭环。

## 需求与反馈附件

需求和反馈输入框共用同一套附件能力，适合提交截图、设计稿或日志文件作为上下文：

- **添加方式**：支持从文件选择器添加、拖拽文件到输入区，以及在输入框内直接粘贴剪贴板图片（如截图、PNG、JPEG、WebP）。
- **提交方式**：附件会先进入待提交列表，可预览和移除；可以和正文一起提交，也可以在正文为空时只提交附件。
- **失败重试**：发送失败时会保留待提交附件，便于修正正文或网络问题后再次提交。
- **计划上下文**：生成计划时，需求/反馈绑定的附件会作为“附件清单”注入给 AI 工具，包含原始名称、MIME、大小、SHA256 和持久化本地路径。
- **读取边界**：图片或其他大文件不会以内联二进制写入 prompt；AI 工具会按需通过清单中的本地文件路径读取附件内容，以控制上下文体积并明确本机文件访问边界。

## CLI 后端

AutoPlan 的计划生成、任务执行、修复与验收通过外部 AI CLI 完成。支持**项目级**与**单条需求/反馈级**选择后端，不同项目和不同记录可使用不同 CLI：

| 后端 | 默认命令 | 说明 |
| --- | --- | --- |
| **Codex CLI**（默认） | `codex` | 通过 `codex exec` 非交互执行，支持会话（session）复用，失败任务重试时延续上下文 |
| **Claude CLI** | `claude` | 通过 `claude --print` 非交互模式执行，prompt 经 stdin 传入，支持同一 plan 内恢复 Claude 会话 |
| **OpenCode CLI** | `opencode` | 通过 `opencode run --format default` 非交互执行，prompt 以位置参数传入、输出从 stdout 读取；不使用 Codex 思考深度，按 plan 复用 OpenCode session |

- **默认仍是 Codex**：未配置过的历史项目升级后继续使用 Codex，无需重新配置。
- **项目级切换**：进入项目 →「计划与任务」→「循环控制」表单，选择「CLI 后端」并保存；也可在创建/编辑项目时选择。命令路径留空时使用上表默认命令名。
- **单条配置优先**：需求输入框和反馈输入框下方都可单独选择 CLI 后端与 Codex 思考深度；命令路径使用项目级配置，或由外部接口显式传入。单条记录已配置时，计划生成、任务执行、失败修复和验收重试优先使用该记录生成计划时的配置；未配置时继承项目级默认配置。
- **Codex 思考深度**：Codex 支持 `low`、`medium`、`high`、`xhigh` 四档思考深度，默认 `medium`，执行时转换为 Codex CLI 的 `model_reasoning_effort` 配置；Claude 与 OpenCode 均不使用该参数，选择非 Codex 后端时思考深度控件不参与提交或执行。
- **计划级 CLI 快照**：每个计划会保存生成该计划时实际解析出的 CLI 后端、命令路径和 Codex 思考深度，用于计划列表与 Plan 全文阅读器展示；后续切换项目默认配置不会改变历史计划显示。
- **历史计划兼容**：早期计划缺少计划级 CLI 字段时，展示按 Codex CLI + `medium` 思考深度降级；Claude 与 OpenCode 计划只显示对应 CLI，不展示可误解的 Codex 思考深度。
- **验收命令默认空**：新建项目不会预填验收命令；留空时任务完成后跳过外部验收命令，已保存的历史命令保持不变。
- **Claude 前置条件**：需在本机已安装 `claude` CLI 并完成认证（`claude` 已可正常登录调用）。若命令不在 PATH，可在「CLI 命令路径」填写完整路径。
- **OpenCode 前置条件**：需在本机已安装并完成认证 `opencode`（开源 AI 编码代理 CLI，见 opencode.ai/docs/cli），命令默认解析为 `opencode`，自定义路径同样在「CLI 命令路径」或外部接口的 `agentCliCommand` 中填写完整路径。AutoPlan 固定使用 `opencode run --format default` 的非交互模式执行，prompt 以位置参数传入、输出从 stdout 读取，**不会**调用交互式 TUI；OpenCode 会话按 plan 复用，首次执行用 `--title` 创建并记录 session id，后续同一 plan 通过 `--session` 恢复。
- **会话隔离**：Codex、Claude 与 OpenCode 各自使用独立的 Agent CLI 会话；Claude/OpenCode 使用 plan 级 `agent_cli_session_id` 恢复上下文，不会复用历史 `codex_session_id`，也不会把 Codex resume 参数传给非 Codex 后端。
- **可观测性**：运行中日志、事件流、任务卡片和概览会显示当前使用的 CLI 后端，CLI 缺失、认证失败、命令失败等问题有可读提示和日志可追踪。

### 回归验证场景

`npm run smoke` 使用 stub 覆盖反馈 #10 的关键路径，不依赖真实 `claude` 二进制：

- 空验收命令保持为空字符串，并在计划完成后跳过外部验收命令。
- 项目默认 Codex 时，单条需求可覆盖为 Codex + `high` 思考深度，生成计划时携带 `model_reasoning_effort="high"`。
- 同一项目内单条反馈可覆盖为 Claude，生成计划时使用 `claude --print`，执行同一 plan 时可恢复 Claude 会话，且不携带 Codex session 或思考深度参数。
- 同一项目内单条需求/反馈可覆盖为 OpenCode，生成计划时使用 `opencode run --format default`，prompt 以位置参数传入、不通过 stdin 投递，且不携带 Codex session 或思考深度参数；同一 plan 的执行/修复步骤会复用 OpenCode session。
- 计划生成后快照会记录本次实际使用的后端与命令；Codex 计划记录规范化后的思考深度，Claude 与 OpenCode 计划不写入 Codex 思考深度；历史空字段按 Codex + `medium` 展示。

手动验证推荐组合：项目默认选择 Codex、验收命令留空；提交一条需求并选择 Codex + `high` 后生成计划，再提交一条反馈并选择 Claude 后生成计划。确认事件/日志中 Codex 需求显示 `high` 思考深度，Claude 反馈显示 Claude 会话新建/恢复/回退标签且不带 Codex session，任务完成时空验收命令被跳过。

OpenCode 推荐手动验证：在项目「设置」选择 OpenCode CLI（或在单条需求/反馈输入区选择 OpenCode CLI），命令路径留空时使用默认 `opencode`。已安装并完成认证 `opencode` 时，提交一条需求生成计划并执行两个普通任务，确认首次任务命令包含 `opencode run --format default --title ...` 并在计划快照记录 `agent_cli_provider: 'opencode'` 与 `agent_cli_session_id`；第二个任务命令包含 `--session <同一 session id>`，且不出现 Codex 思考深度或 `codex_session_id` 传参；未安装 `opencode` 时执行计划，应得到标明 OpenCode CLI 与日志位置的可读错误，任务状态可恢复。

## MCP 外部接入

AutoPlan 内置本机 MCP 服务，方便其它 MCP 客户端在不打开 GUI 表单的情况下查询项目上下文、创建项目、提交需求/反馈、查看计划/任务，并启动或停止项目循环。桌面应用启动并完成数据库初始化后会启动 MCP 服务；启动失败不会影响 GUI，错误会进入事件流并显示在「设置 → MCP 外部接入」卡片。

### 默认连接方式

| 项 | 默认值 | 说明 |
| --- | --- | --- |
| 传输方式 | `http` | 使用 Streamable HTTP MCP 端点 |
| 地址 | `127.0.0.1` | 默认仅绑定本机，不暴露公网 |
| 端口 | `43847` | 连接地址为 `http://127.0.0.1:43847/mcp` |
| stdio | `npm run mcp:stdio` | 供需要 stdio 的 MCP 客户端按进程方式启动 |

可通过环境变量覆盖默认值：`AUTOPLAN_MCP_ENABLED=0` 禁用服务，`AUTOPLAN_MCP_TRANSPORT=stdio|http` 切换传输方式，`AUTOPLAN_MCP_HOST`、`AUTOPLAN_MCP_PORT`、`AUTOPLAN_MCP_PATH` 调整 HTTP 监听。HTTP 默认只允许本机地址；若显式绑定非本机地址，需同时设置 `AUTOPLAN_MCP_ALLOW_REMOTE=1`，并自行承担网络访问控制。

### macOS 使用说明

AutoPlan 的 macOS 产物以**非沙箱直接分发**方式发布（非 Mac App Store），因此应用可读写用户选择的任意本地工作区文件夹，也可监听本机端口用于 MCP，不受 App Sandbox 容器限制。这与 Windows/Linux 行为一致，不会出现沙箱导致的文件夹或网络访问受限。

- **首次启动的网络弹窗**：macOS 在应用首次监听本机端口（MCP HTTP 服务默认 `127.0.0.1:43847`）时，可能弹出「是否允许 AutoPlan 接收传入网络连接」。请前往「系统设置 → 网络 → 防火墙」点「允许」放行 AutoPlan；若未放行，MCP HTTP 服务可能无法绑定端口，相关错误会显示在「设置 → MCP 外部接入」卡片的「最近错误」中。
- **MCP 两种接入方式的区别**：
  - **in-app HTTP（默认）**：桌面应用启动后自动拉起 HTTP MCP 端点，默认地址 `http://127.0.0.1:43847/mcp`，供本机其它 MCP 客户端（如 Claude Desktop）连接。
  - **独立 stdio 进程**：通过 `npm run mcp:stdio`（等价于 `node src/mcpServer.js --stdio`）单独运行，由外部 MCP 客户端 spawn 该进程并经 stdin/stdout 通信，不依赖本机端口监听。
- **GUI 内的 stdio 模式不对外部客户端可用**：在 GUI「设置」中把传输方式切到 stdio，只会让应用主进程读写自身的 stdin/stdout，外部 MCP 客户端无法接入。macOS 下若端口受限（防火墙未放行、无监听权限），应改用上述**独立 stdio 进程**，或在防火墙放行后继续使用 HTTP，**不要**指望 GUI 内的 stdio 模式接入外部客户端。
- **端口无法监听时的环境变量调整**：参见上节「默认连接方式」——可用 `AUTOPLAN_MCP_PORT=<其它端口>` 换一个可用端口；或改走 stdio 独立进程（`AUTOPLAN_MCP_TRANSPORT=stdio` 配合 `npm run mcp:stdio`）；`AUTOPLAN_MCP_ENABLED=0` 可禁用应用启动时自动拉起 MCP（不影响 GUI 主功能与本地工作区访问）。

### 工具清单与示例

MCP 工具返回 `content[0].text` 中的 JSON 字符串，并在支持的客户端中提供 `structuredContent`。可用工具包括：`list_projects`、`get_project`、`create_project`、`list_requirements`、`create_requirement`、`list_feedback`、`create_feedback`、`list_plans`、`get_plan`、`list_tasks`、`start_loop`、`stop_loop`。

查询类工具通常接收 `projectId` 和可选 `status` / `limit`；创建和启停类工具会返回最新 `snapshot` 摘要（当前项目、运行状态和记录数量）。

#### `list_projects`

```json
{
  "query": "My App",
  "limit": 20
}
```

#### `create_project`

```json
{
  "name": "My App",
  "workspacePath": "D:/project/my-app",
  "description": "外部 MCP 创建的项目",
  "agentCliProvider": "codex",
  "agentCliCommand": "",
  "codexReasoningEffort": "high"
}
```

#### `create_requirement`

```json
{
  "projectId": 1,
  "title": "实现登录页",
  "body": "请增加邮箱登录、错误提示和基础表单校验。",
  "attachments": [
    { "name": "login-sketch.png", "path": "D:/tmp/login-sketch.png", "type": "image/png" }
  ],
  "autoRun": true,
  "agentCliProvider": "codex",
  "codexReasoningEffort": "high"
}
```

#### `create_feedback`

```json
{
  "projectId": 1,
  "requirementId": 12,
  "title": "登录页反馈",
  "body": "错误提示需要展示在输入框下方。",
  "attachments": [
    { "name": "feedback-placeholder.txt", "size": 0 }
  ],
  "autoRun": false,
  "agentCliProvider": "claude"
}
```

#### `list_plans` / `get_plan` / `list_tasks`

```json
{ "projectId": 1, "status": "running", "limit": 20 }
```

```json
{ "projectId": 1, "planId": 3 }
```

```json
{ "projectId": 1, "planId": 3, "status": "pending", "limit": 50 }
```

#### `start_loop` / `stop_loop`

```json
{ "projectId": 1 }
```

### 附件、安全与错误处理

- **附件支持范围**：`attachments` 支持本机 `path` 文件、`dataUrl`、`base64` / `dataBase64`、`bytes`，也支持仅提供 `name` / `size` 的占位信息；仅占位附件会进入工具入参校验，但不会复制为持久化文件。
- **安全边界**：HTTP MCP 默认监听 `127.0.0.1`，不会默认暴露公网；附件路径由本机 AutoPlan 进程读取，请只传入可信路径。
- **关联校验**：`create_feedback.requirementId` 可为空；若需求不存在或属于其它项目，会返回明确错误，不会误写跨项目关联。
- **常见错误**：必填字段缺失、字符串超长、`autoRun` 非布尔值、CLI 后端或 Codex 思考深度枚举非法、项目 ID 非正整数，都会以可修正的中文错误返回。

`npm run smoke` 覆盖 MCP 工具项目查询/创建、需求/反馈查询/提交、计划/任务查询、项目循环启动/停止、反馈关联需求、`autoRun`、CLI 配置规范化、附件保存和无效入参错误；真实 MCP 客户端连通性留给最终手动验收。

## 计划并发执行与 scope 文件

AutoPlan 生成计划时要求所有任务拆解都放在 `## 任务拆解` 章节中，且每个任务行都必须独占一行并携带固定格式的 `scope` 注释，例如：

```md
- [ ] P001: 修改数据模型 <!-- scope: src/database.js,src/loopService.js -->
- [ ] P002: 梳理暂不确定影响范围的兼容逻辑 <!-- scope: unknown -->
- [ ] P007: 完整验收 <!-- scope: validation -->
```

任务行必须使用 `- [ ] P001: 任务标题 <!-- scope: ... -->` 或已完成态 `- [x] P001: 任务标题 <!-- scope: ... -->`。不要把任务拆解写成普通段落、代码块、表格、引用块或嵌套 checkbox；验收要点可以作为任务下方的缩进列表，但不能写成新的 checkbox 任务。

### 并发建议规则

- **核心依据是 scope 冲突检测**：只有待执行任务的规范化 scope 文件集合互不重叠时，才会进入同一建议并发批次。
- **不会自动并发的任务**：`unknown`、`validation`、空 scope、无法解析 scope、标题包含验收/测试/发布等串行关键词，或与同批任务 scope 重叠的任务都会被归为需串行任务。
- **路径归一化**：同一任务内重复 scope、Windows/Unix 分隔符差异、首尾空格会被稳定归一化，不影响原始任务标题和 plan 正文展示。
- **建议可追踪**：计划列表会展示可并发任务数、建议批次数、需串行任务数，并在确认弹窗中列出每批任务和不建议并发原因。

### 手动并发执行流程

1. 进入项目 →「计划与任务」，在 Plan 列表查看并发建议摘要。
2. 当计划存在安全并发批次、计划未完成且没有任务运行中时，「并发执行」按钮可点击。
3. 点击后先查看建议批次和串行原因；只有点击「确认并发执行」才会启动任务，取消不会改变任务状态。
4. 并发执行复用普通任务链路：任务状态、日志文件、事件流、失败记录和计划进度都会继续追踪。
5. 若某一批中有任务失败，后续批次不会继续启动，事件流会记录失败任务和是否继续下一批。

### scope 文件打开配置

Plan 全文阅读器会把任务行 `scope` 注释中的文件路径渲染为可点击链接。点击前主进程会校验路径必须位于当前项目工作区内，且目标必须是存在的普通文件；不存在、目录、越界路径、权限不足或命令失败都会返回明确提示。

打开方式在项目「设置」中配置，默认使用系统默认方式：

| 打开方式 | 说明 | 示例配置 |
| --- | --- | --- |
| 系统默认方式 | 调用系统默认应用打开文件 | 无需填写命令 |
| 系统文件夹定位 | 在文件管理器中定位该文件 | 无需填写命令 |
| VSCode | 调用 VSCode CLI 打开文件 | 命令留空默认 `code`，或填写完整 `code` 路径 |
| 第三方编辑器命令 | 调用自定义编辑器 | `cursor {file}`、`notepad++ {file}` 或 `zed {file}` |

请确保 scope 路径相对项目工作区填写且尽量精确。无法判断影响范围时应写 `unknown`，完整验收任务应写 `validation`，避免把无法安全判断的任务错误放入并发批次。

## 发布

项目通过 GitHub Actions + electron-builder 发布 Windows、macOS、Linux 三端产物。发布 workflow 支持推送 `v*` tag 自动触发，也支持在 GitHub Actions 页面手动触发。

### Beta 版本说明

Beta 版本用于更快分发近期修复和功能更新，是未完整人工测试的预发布版本，不等同于稳定正式版，也不承诺零缺陷。当前 beta 发布策略是：AI 修复问题后，只要项目编译通过即可发布，用于减少人工测试和等待时间。

如果你下载测试或日常使用 beta 版本时发现问题，请直接到 GitHub Issue 界面提交反馈，尽量附上复现步骤、截图或日志。后续 AutoPlan/AI 流程会持续从 Issue 中发现问题，生成修复计划并继续处理。

自动 beta 发布脚本会读取当前 `package.json` 版本，生成下一个 `X.Y.Z-beta.N` 版本号，调用 Codex CLI 分析最近提交并生成 release notes，更新版本文件，执行编译验证，然后提交、推送分支并调用底层发布脚本推送 tag：

```bash
python scripts/release_beta.py --dry-run
python scripts/release_beta.py --yes
```

底层一键发布脚本只负责创建并推送 tag，三端构建由 GitHub Actions 完成：

```bash
python scripts/release.py --tag v0.2.0 --notes "发布说明"
python scripts/release.py --tag v0.2.0 --notes-file notes.md --dry-run
```

发布前请确认工作区没有未提交的业务代码变更、远端可推送，并且仓库 Actions 权限允许 `GITHUB_TOKEN` 写入 Release。自动 beta 脚本会临时 stash `docs/plan` 和 `docs/progress/logs` 下的生成文件，避免这些运行日志混入发布提交。完整流程、产物说明、权限要求和能力边界见 [发布说明](docs/release.md)。macOS 正式包需要 Developer ID 签名和 Apple 公证；维护者配置 GitHub Secrets、用户选择 `arm64`/`x64` 产物以及“已损坏/无法打开”排查流程见 [macOS 发布与安装说明](docs/release/macos.md)。

## 开发

```bash
npm install
npm run dev        # 启动开发模式（Vite + Electron）
npm run check      # TypeScript + 主进程/预加载/冒烟脚本静态检查
npm run smoke      # 核心流程冒烟测试（含空验收、单条 CLI 覆盖、Codex 深度与 MCP 工具 stub 覆盖）
npm run package:win  # 打包 Windows 安装包
```

> 真实的 Claude CLI 调用需要本机安装并认证 `claude`；真实 MCP 客户端连通性需手动验证。`npm run smoke` 通过 stub 覆盖后端路由、Agent CLI 会话隔离、Codex 思考深度参数转换和 MCP 工具写入核心分支，不依赖真实二进制或外部 MCP 客户端。

