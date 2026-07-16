# 修复计划停止触发 invalid_runtime_command

当前 go_plan_actions 默认启用，停止请求会进入 Go 的 plan.stop 路由，但计划 RuntimeHandler 随后委托给仅支持 task.run<path> 的 manualRuntimeDispatcher，最终把 unsupported command 映射成 invalid_runtime_command。实现 Go 所有权下的计划停止事务与运行时取消流程，使计划、未完成任务、Operation 和事件一致落盘，并补齐 HTTP 到持久层的回归覆盖。

## Tasks

- [x] P001: 定义计划停止领域命令与原子持久化接口 <!-- scope: backend<path> backend<path> backend<path> 或独立 plan_stop.go -->
  - Acceptance: 新增项目作用域的 PlanStop 输入<path> 事务仅允许停止 running 或存在 running<path> 任务的计划，将计划置为 interrupted、未完成任务置为 blocked，并拒绝跨项目、不存在或不可停止的计划且不产生部分写入。
- [x] P002: 实现 Go 计划停止应用服务与审计事件 <!-- scope: backend<path> backend<path> 新增或现有停止动作文件及测试 -->
  - Acceptance: 计划服务在同一 TransactPlans 事务中完成状态转换并追加 plan.stopped 事件；重复或非法停止返回稳定的 not-found<path> 语义，成功结果包含被停止计划及受影响任务信息。
- [x] P003: 让运行时桥原生处理 plan.stop <!-- scope: backend<path> backend<path> backend<path> 或新的 plan stop dispatcher, backend<path> -->
  - Acceptance: CommandPlanStop 不再进入只支持任务运行的分派分支；处理器创建并认领幂等 Operation，确认目标计划正在运行后取消该项目当前关联的 Loop 工作，提交计划停止事务并完成 Operation；相同幂等键可安全重放，且不会误停其他项目或非目标计划。
- [x] P004: 校正停止错误到 HTTP 稳定错误码的映射 <!-- scope: backend<path> backend<path> backend<path> -->
  - Acceptance: POST <path> 对合法运行中计划返回 202 Operation 引用，不再返回 invalid_runtime_command；不存在、状态冲突、仓储不可用和取消失败分别映射到既有稳定错误码，空 JSON 请求和严格路径校验保持不变。
- [x] P005: 补齐计划停止的端到端回归测试 <!-- scope: backend<path> backend<path> backend<path> backend<path> src<path> 或 runtimeTransport.contract.test.ts -->
  - Acceptance: 测试复现 go_plan_actions=true 时的原故障，并验证停止请求经过 renderer HTTP client、资源路由、RuntimeHandler、Operation 和 SQLite 事务后成功；覆盖运行中计划、无活跃进程但有运行任务、非运行计划、跨项目 ID、重复幂等请求、事务回滚以及停止后快照显示 interrupted<path> invalid_runtime_command 或回退 IPC。
- [x] P006: Final validation <!-- scope: validation -->
  - Acceptance: 在 backend 目录运行 go test .<path> .<path> .<path> .<path> .<path> .<path> -count=1 和 go test .<path> -count=1；在仓库根目录运行 node --test src<path> run migration:p11:verify -- --fixture-root <authorized-fixture-copy>（具备授权 fixture 时）、npm test、npm run check、npm run build；最后以启用 go_plan_actions 的本地 sidecar 创建并运行一个计划，点击停止，确认 HTTP 返回 202、Operation 完成、计划为 interrupted、未完成任务为 blocked、执行进程终止且界面不再显示 AutoPlan HTTP request failed (invalid_runtime_command)。
