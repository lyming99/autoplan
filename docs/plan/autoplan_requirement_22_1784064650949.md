# 实现项目级大模型 Token 消耗统计

在 Go sidecar 中统一解析 Codex、Claude、OpenCode、Oh My Pi CLI 及 OpenAI<path> HTTP 响应提供的用量信息，使用新增 SQLite 表持久化每次调用的输入、输出、缓存、推理及总 Token，并按项目聚合到 AppSnapshot；前端工作区概览展示累计与当日消耗。无法提供完整用量的供应商调用保留可获得字段，不通过文本长度进行不准确估算。

## Tasks

- [x] P001: 定义统一 Token 用量领域模型并新增 v4 数据库迁移 <!-- scope: backend<path> -->
  - Acceptance: 新增 model_usage 表及项目、时间、供应商查询索引，记录 project、provider、model、source、关联 operation<path> Token 数和采集时间；迁移注册表、校验和、SchemaVersion、RequiredTables<path> 全部更新，旧 v3 数据库可无损升级到 v4。
- [x] P002: 实现用量记录写入与项目聚合查询 <!-- scope: backend<path> 及仓储测试 -->
  - Acceptance: 仓储提供受限的幂等写入和项目聚合接口，可返回累计、当日及按 provider<path> 分组的输入、输出、缓存、推理和总 Token；重复 invocation key 不会重复计数，负数、字段溢出和跨项目关联会被拒绝。
- [x] P003: 从各供应商响应中提取标准化 Token 用量 <!-- scope: backend<path> 及对应测试夹具 -->
  - Acceptance: 解析器覆盖 Claude stream-json<path> usage、Codex JSON<path> My Pi 可用的结构化用量事件，以及 OpenAI SSE usage 和 Anthropic message_start<path> usage；HTTP 请求启用供应商支持的流式 usage 返回；缺失字段保持未知或零值，畸形、截断响应不会产生虚假统计，也不会泄露原始提示词或凭据。
- [x] P004: 在计划生成、任务执行和聊天调用完成边界记录用量 <!-- scope: backend<path> -->
  - Acceptance: 计划生成、每次任务执行（包括 session fallback 的实际调用）和内置聊天在供应商调用结束后写入独立用量记录，并关联现有 project、operation、intake、plan、task 或 conversation；成功、供应商失败及取消场景只要取得可信 usage 都会统计，数据库写入重试不会重复累计。
- [x] P005: 通过强类型 AppSnapshot 暴露项目用量汇总 <!-- scope: backend<path> HTTP contract 测试 -->
  - Acceptance: AppSnapshot 新增强类型 modelUsage 汇总字段，包含累计、当日和分组数据；字段不借用会将 token 视为密钥的 SanitizedObject 通道，现有敏感字段校验仍保持严格；无历史记录时稳定返回全零结构，HTTP snapshot 契约测试通过。
- [x] P006: 接入前端传输类型并在工作区概览展示消耗统计 <!-- scope: src<path> -->
  - Acceptance: 客户端严格校验并映射 modelUsage；概览页展示格式化的累计 Token、今日 Token 及输入<path> snapshot<path> 更新重新渲染；统计卡片在桌面和窄屏布局下不溢出，缺失旧版字段时回退为零且不影响页面。
- [x] P007: 补齐端到端回归与兼容性测试 <!-- scope: backend<path> 与 backend<path> 的 Go 测试、src<path> 的组件和传输测试、必要的 fixtures<path> 夹具 -->
  - Acceptance: 测试覆盖 v3→v4 升级、幂等写入、聚合边界、各 provider 用量样本、失败<path> 严格解码和概览渲染；既有数据库敏感信息红线、唯一写入者和迁移契约测试继续通过。
- [x] P008: Final validation <!-- scope: validation -->
  - Acceptance: 在 backend 目录执行 gofmt -w 于所有变更 Go 文件并运行 go test .<path> npm test、npm run check、npm run build、npm run migration:p15:unique-writer 和 npm run migration:p15:verify；使用 v3 数据库副本启动 sidecar 验证自动升级到 user_version=4，再分别触发一次计划生成、任务执行和聊天，确认 model_usage 无重复记录且工作区概览的累计、当日、输入与输出数值与供应商 usage 响应一致。
