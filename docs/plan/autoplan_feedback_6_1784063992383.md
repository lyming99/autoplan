# 修复 Go 数据库所有者模式下计划文件路径打开失败

将计划卡片文件路径的原生打开流程改为运行时感知：Go 模式通过 sidecar 获取项目工作区和文件访问策略，Node 模式保留现有数据库读取；路径解析只消费已加载的策略，并消除 Go 模式下对受禁 Node SQL<path> 的隐式回退，同时保留目录边界、realpath 和符号链接防逃逸校验。

## Tasks

- [x] P001: 抽取运行时安全的工作区文件打开服务 <!-- scope: 新增 src<path> src<path> -->
  - Acceptance: 服务接收项目加载器、文件策略加载器、打开模式和 shell 依赖；能够解析工作区内文件并以 system、folder、vscode 或 command 模式打开，且继续拒绝越界路径、符号链接逃逸、目录和不存在的文件。
- [x] P002: 让 Electron 文件打开 IPC 在 Go 模式完全绕过 Node 数据库 <!-- scope: src<path> 的 workspace:openFile、openWorkspaceFile、resolveWorkspaceFilePath 及相关策略<path> -->
  - Acceptance: Go 模式从 <path> 和 <path> 获取工作区及策略，空 command 或显式 folder 模式不会调用 db.get、db.getSetting 或 readSetting；Node 模式仍使用原有数据库设置，并保持现有错误结果结构。
- [x] P003: 补充计划路径点击场景的回归测试 <!-- scope: 新增 src<path> src<path> -->
  - Acceptance: 测试使用会抛出 DATABASE_NODE_SQL_FORBIDDEN 的数据库替身验证 Go 模式仍能打开计划文件所在文件夹；同时覆盖 sidecar 策略映射、folder 模式、Node 兼容路径、文件不存在及越界<path> plan.file_path 和 folder 模式。
- [x] P004: Final validation <!-- scope: validation -->
  - Acceptance: 运行 node --test src<path> src<path> src<path> run check、npm run migration:p15:unique-writer 和 npm test；随后以 Go owner 模式启动应用，点击计划卡片中的文件路径，确认系统文件管理器定位到该计划文件，界面不再显示 DATABASE_NODE_SQL_FORBIDDEN，并验证越界文件仍被拒绝。
