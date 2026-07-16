# 补全 Go Sidecar 生成计划耗时统计与持久化

在当前权威的 Go 计划生成链路中复用 Agent 执行起止时间计算非负耗时，将其通过 GeneratedPlanInput 传递到 SQLite，并写入现有 plans.plan_generation_duration_ms 字段；保持现有 API DTO 和前端“生成耗时”展示逻辑不变，同时增加生成链路与仓储层回归测试。

## Tasks

- [x] P001: 在计划生成流程中计算并传递生成耗时 <!-- scope: backend<path> backend<path> -->
  - Acceptance: GeneratedPlanInput 包含生成耗时字段；sidecarLoopRunner 在 Agent 成功生成、解析并构建计划后，将基于进程 StartedAt<path> 或本地计时回退得到的非负毫秒数传给 SavePlan，成功日志中的耗时与保存值口径一致。
- [x] P002: 将生成耗时写入 plans 记录 <!-- scope: backend<path> -->
  - Acceptance: CreateGeneratedPlan 校验耗时不能为负，并在事务内 INSERT plans 时显式写入 plan_generation_duration_ms；随后通过现有计划查询、DTO 和 HTTP 响应能够读取该值，不再因数据库默认值而固定返回 0。
- [x] P003: 补充生成耗时传递与持久化回归测试 <!-- scope: backend<path> backend<path> 计划生成测试 -->
  - Acceptance: 测试使用确定的进程起止时间验证 RunOnce 保存了预期毫秒数，并验证 CreateGeneratedPlan 的 SQL 参数包含该耗时、读取计划后 GenerationMillis 保持一致，同时覆盖负数耗时被拒绝，现有生成失败与未记录兼容场景不回归。
- [x] P004: Final validation <!-- scope: validation -->
  - Acceptance: 在 backend 目录运行 go test .<path> .<path> .<path> 和 go test .<path> npm run build，并确认新生成计划的 API 字段 plan_generation_duration_ms 大于 0，计划列表由现有 formatPlanGenerationDuration 显示具体耗时而非“未记录”。
