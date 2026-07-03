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


## 使用教程

[AutoPlan使用教程](https://www.bilibili.com/video/BV1KLTY6oEHe)

[如何让AI 24小时工作？](https://www.bilibili.com/video/BV1ExTK6NEPW)

[AI计划草稿，开发前先对齐需求~](https://www.bilibili.com/video/BV16jTP6YE45)

## 案例

[AutoPlan重构笔记编辑器](https://www.bilibili.com/video/BV1VcTH6qEKw)

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

## 文件访问范围与安全

AutoPlan 中所有文件读取入口（`read_file`、`search_files`、打开文件、读取计划）默认**仅允许访问当前项目工作区**内部，越界路径与符号链接逃逸都会被拒绝（统一错误码 `FILE_PATH_OUTSIDE_SCOPE`）。

可在「工作区 → 设置 → 文件访问」中按需放宽：

- **范围** `fileAccess.scope`：`project`（默认安全）/ `workspace`（等同 project）/ `custom`（工作区 + 白名单）/ `all`（不限制，高风险）；
- **跨项目访问** `fileAccess.allowCrossProject`：开启后等效 `custom`，需配合白名单；
- **白名单目录** `fileAccess.allowedRoots`：工作区之外额外允许读取的绝对路径根。

> 注意：计划/需求**写入**路径（`docs/plan`）刻意保持工作区锁定，不受本开关放宽；`all` 仅受操作系统权限约束，建议优先用 `custom` + 最小白名单。

完整模型、各语义、安全边界与最小安全实践见 [docs/file-access.md](./docs/file-access.md)。

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

积极的人士，请点个star，证明一下自己是积极的哈。

## 赞赏

有闲钱的老板们，请喝个咖啡好吗。

![](./snapshot/zanshangma.png)

## 最后

遇到问题？欢迎联系微信：lyming555，Email: 44185539@qq.com
