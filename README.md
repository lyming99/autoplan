# AutoPlan

## 简介

一款支持24小时执行编程任务的开源工具，支持项目管理、需求管理、反馈管理、计划任务队列。

所有计划与任务都可以回溯，每次计划与任务都在增加项目的长期记忆。

随着AI越来越智能，项目开发只需要需求与反馈的循环，就可以让项目无限趋近100%完成任务。

这个可以验证，[ai哲学，解决99%编程问题](https://www.bilibili.com/video/BV1TsEC6DEik)。


## 快速开始

1.安装codex/claude/opencode

2.安装autoplan

3.创建项目

4.启动循环(工作界面，右上角启动)

5.提需求(可以通过第三方工具讨论需求，然后mcp发送给autoplan执行)

## 为什么有这个项目？

[一个脚本搞定全自动编程](https://www.bilibili.com/video/BV142jX6zEyd)

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


## 开发

```bash
npm install
npm run dev        # 启动开发模式（Vite + Electron）
npm run check      # TypeScript + 主进程/预加载/冒烟脚本静态检查
npm run smoke      # 核心流程冒烟测试（含空验收、单条 CLI 覆盖、Codex 深度与 MCP 工具 stub 覆盖）
npm run package:win  # 打包 Windows 安装包
```

> 真实的 Claude CLI 调用需要本机安装并认证 `claude`；真实 MCP 客户端连通性需手动验证。`npm run smoke` 通过 stub 覆盖后端路由、Agent CLI 会话隔离、Codex 思考深度参数转换和 MCP 工具写入核心分支，不依赖真实二进制或外部 MCP 客户端。



## 理念

随着AI越来越智能，编程任务其实就可以像人工智能驾驶一样，逐渐卸载方向盘了。

人工智能驾驶，需要给它目的地，那么AutoPlan也一样，只需要给它需求和反馈。

随着需求和反馈的循环，项目会越来越完善，你的钱包也会越来越完善。

项目完善是内因，环境变化是外因，内因是根本，外因是条件。

天之道，损有余而补不足，即没有空中楼阁，AI的根本在于服务于人。

技术毫无作用，服务于人的时候，技术才起作用。

AI不服务于人，那么AI必死，AI服务于人的时候，时代就是进步的。

AI不会淘汰你，淘汰你的是其它人，或者说是你自己。

不必慌张，用好AI，用科技改变生活。
