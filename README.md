# AutoPlan

一款支持24小时执行编程任务的开源工具，支持项目管理、需求管理、反馈管理。

支持队列执行任务，所有计划与任务都可以回溯，每次计划与任务都在增加项目的长期记忆。

随着AI越来越智能，项目开发只需要需求与反馈的循环，就可以让项目无限趋近100%完成任务。

这个可以验证，[ai哲学，解决99%编程问题](https://www.bilibili.com/video/BV1TsEC6DEik)

## 快速开始

1.安装codex/claude/opencode

2.安装autoplan

3.创建项目

4.启动循环(工作界面，右上角启动)

5.提需求(可以通过第三方工具讨论需求，然后mcp发送给autoplan执行)

## 为什么有这个项目？

[一个脚本搞定全自动编程](https://www.bilibili.com/video/BV142jX6zEyd)

## 理念

随着AI越来越智能，编程任务其实就可以像人工智能驾驶一样，逐渐卸载方向盘了。

人工智能驾驶，需要给它目的地，那么AutoPlan也一样，只需要给它需求和反馈。

随着需求和反馈的循环，项目会越来越完善，你的钱包也会越来越完善。

项目完善是内因，环境变化是外因，内因是根本，外因是条件。

天之道，损有余而补不足，即没有空中楼阁，AI的根本在于服务于人。

技术毫无作用，服务于人的时候，技术才起作用。

AI不服务于人，那么AI必死，AI服务于人的时候，时代就是进步的。

AI不会淘汰你，淘汰你的是其它人。

不必慌张，用好AI，用科技改变生活。

## 使用教程

[AutoPlan使用教程](https://www.bilibili.com/video/BV1KLTY6oEHe)

[如何让AI 24小时工作？](https://www.bilibili.com/video/BV1ExTK6NEPW)

[AI计划草稿，开发前先对齐需求~](https://www.bilibili.com/video/BV16jTP6YE45)

[这套循环，60天不出结果，我拜你为师](https://www.bilibili.com/video/BV1H2KU6oEgz)

## 桌面端截图

### 项目管理
![](./snapshot/projects.png)

### 工作界面
![](./snapshot/workspace.png)


## 自动化发布

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

## 版本更新检查

AutoPlan 启动后会自动从 GitHub 检查是否有更新的**正式版本**，并在有更新时提醒，帮助你及时升级。更新检查默认开启，**只检查、只提醒，不会自动下载或安装**——三端产物需要 Windows 代码签名、macOS Developer ID 签名与 Apple 公证（见上文「发布」），自动替换二进制会引入签名/公证与进程提权等高风险问题，因此本期只做「检测 + 提醒 + 跳转」。

- **检查来源**：固定查询本仓库 GitHub `releases/latest` 端点，其官方语义即「最新的非 prerelease、非 draft Release」，因此**只提醒正式版，不含 beta**。即便解析层保留了 prerelease/draft 防御过滤，也不会把 beta 误判为正式版。
- **默认节奏**：自动检查默认每 6 小时一次（`update.intervalMinutes=360`）。应用启动后若自动检查开启，会延迟触发首次检查，并按该间隔周期复查；本地为 beta 版本时也会正确比较（如 `0.2.1-beta.6` 低于同号稳定版 `0.2.1`）。
- **更新提醒**：检测到比本地更新的正式版时，会在项目列表页与工作区顶部展示「新正式版本 vX.Y.Z 可用」横幅，提供「前往下载」（打开对应 Release 页面）与「稍后提醒」（忽略当前版本，本轮不再弹横幅）。
- **手动控制**：在「设置 → 关于/更新」可查看当前版本与最新正式版（或「已是最新」）、上次检查时间，切换自动检查开关，或点「立即检查」手动触发一次。无更新或检查失败时不打扰用户，失败信息仅在该面板可见。
- **外链跳转**：所有外链（如 Release 页面）统一经主进程 `shell.openExternal` 在系统浏览器打开，不在渲染进程直接发起网络请求。

> 「正式版更新提醒」与本仓库的「beta 分发」（见上文「Beta 版本说明」）是**两条独立通道**：beta 通过 `vX.Y.Z-beta.N` tag 单独分发，用于快速灰度修复；更新检查只盯正式版，不会因为存在更新的 beta 版本而提醒。

## 开发

```bash
npm install
npm run dev        # 启动开发模式（Vite + Electron）
npm run check      # TypeScript + 主进程/预加载/冒烟脚本静态检查
npm run smoke      # 核心流程冒烟测试（含空验收、单条 CLI 覆盖、Codex 深度与 MCP 工具 stub 覆盖）
npm run package:win  # 打包 Windows 安装包
```

> 真实的 Claude CLI 调用需要本机安装并认证 `claude`；真实 MCP 客户端连通性需手动验证。`npm run smoke` 通过 stub 覆盖后端路由、Agent CLI 会话隔离、Codex 思考深度参数转换和 MCP 工具写入核心分支，不依赖真实二进制或外部 MCP 客户端。
