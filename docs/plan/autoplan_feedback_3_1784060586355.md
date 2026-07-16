# 修复停止任务返回 invalid_runtime_command

补齐 Go 运行时对 task.stop 的实际分发与取消链路。当前 REST 路由、能力声明和任务 RuntimeHandler 已接受 task.stop，但 backend<path> 仅支持 task.run 与 task.run_batches，导致停止请求最终以 ErrUnsupportedCommand 映射为 invalid_runtime_command。实现时将按 project_id、plan_id、task_id 校验任务归属和运行状态，取消对应的活动 Loop Operation，可靠落库任务终态和事件，并保持重复停止幂等。

## Tasks

- [x] P001: 增加失败场景回归测试并固定 task.stop 契约 <!-- scope: backend<path> 及测试 -->
  - Acceptance: 使用合法 project_id、plan_id、task_id 调用项目级任务停止接口时，命令以 CommandTaskStop 到达运行时且不再返回 invalid_runtime_command；缺少或错误的标识、跨项目<path>
- [x] P002: 为任务停止定义目标校验与持久化接口 <!-- scope: backend<path> 及 SQLite 测试 -->
  - Acceptance: 仓储可在单个事务内确认任务属于指定项目和计划，并将 running<path> 任务推进到一致的停止状态；不存在、归属不匹配、已终态和重复停止均有明确且无部分写入的结果。
- [x] P003: 实现 task.stop 的运行时分发和活动执行取消 <!-- scope: backend<path> 及相关单元测试 -->
  - Acceptance: manualRuntimeDispatcher 显式处理 CommandTaskStop，不再返回 ErrUnsupportedCommand；仅当活动 Loop 正在执行目标任务时请求取消对应 Operation<path>
- [x] P004: 完善取消后的任务、计划、Operation 和事件收尾 <!-- scope: backend<path> 子系统及测试 -->
  - Acceptance: 停止中的 CLI 收到 context 取消，任务最终呈现停止<path> 仅产生一个 cancelled 终态，任务事件包含停止结果，计划计数与状态保持一致，迟到进程退出和重复停止不会覆盖终态。
- [x] P005: 覆盖桌面 HTTP 调用与业务冒烟场景 <!-- scope: src<path> -->
  - Acceptance: HTTP 客户端继续向 <path> 发送 plan_id，并能接收 accepted Operation、跟踪取消结果和刷新快照；业务冒烟测试实际启动任务后停止，确认界面不再显示“AutoPlan HTTP request failed (invalid_runtime_command)”。
- [x] P006: Final validation <!-- scope: validation -->
  - Acceptance: 运行 go test .<path> .<path> .<path> .<path> .<path> npm test、npm run build 和 npm run smoke:go:business；人工验证运行中任务点击“停止”后请求返回 202，Operation 与任务最终为取消<path> plan_id、跨项目 task_id 及停止与自然完成竞争场景。
