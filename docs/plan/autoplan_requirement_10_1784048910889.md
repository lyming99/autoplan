# 统一验收模块与需求<path>

将计划验收作为关联需求、反馈验收状态的权威来源：验收单阶段计划或全部阶段计划后自动写入关联 intake 的 accepted_at；取消验收或重做任一计划时同步清空。Node 与 Go 两条运行链路采用相同规则，并通过快照更新现有列表，无需用户再次验收。

## Tasks

- [x] P001: 在 Node 验收链路中同步关联需求和反馈 <!-- scope: src<path> -->
  - Acceptance: 单项或批量验收 plan 后，基于 intake_plan_links 及 legacy linked_plan_id 找到同项目关联项；单阶段计划验收后立即写入 requirements<path> intake 仅在所有关联计划均已验收时写入；取消 plan 验收或 plan<path> 重做导致计划验收失效时清空关联 intake 的 accepted_at；task 的普通验收<path> intake；同步写入对应 requirement<path> accepted<path> 事件且只 emitUpdate 一次。
- [x] P002: 在 Go 计划验收事务中实现相同的原子级联 <!-- scope: backend<path> 的计划验收与 intake-plan 关联持久化 -->
  - Acceptance: SetAcceptance、SetAcceptances、运行时验收及 redo 路径在同一事务内同步计划和关联 intake；同时支持规范化链接与 legacy linked_plan_id，多阶段完成条件与 Node 一致；计划验收、intake accepted_at、项目事件和 outbox 要么全部提交要么全部回滚；操作返回的 snapshot 已包含最新需求和反馈验收状态。
- [x] P003: 补充 Node 与 Go 的验收状态回归测试 <!-- scope: src<path> 测试、backend<path> 测试 -->
  - Acceptance: 测试覆盖关联 requirement 和 feedback、规范化及 legacy 链接、单阶段与多阶段计划、单项与批量验收、取消验收、重做、重复操作、跨项目隔离和事务失败回滚；明确验证 task 普通验收不会提前验收 intake，并验证所有阶段验收后 intake 不再处于等待验收状态。
- [x] P004: 扩展端到端 smoke 验证两条运行链路 <!-- scope: scripts<path> -->
  - Acceptance: 现有验收模块 smoke 在验收关联计划后同时断言计划及 requirement<path> 非空，取消验收后同时恢复为空；Node IPC 和启用 go_acceptance_retry_actions 的 HTTP<path> 路径均证明需求、反馈列表可直接从返回或后续 snapshot 显示已验收，无需调用独立 intake accept 接口。
- [x] P005: Final validation <!-- scope: validation -->
  - Acceptance: 依次执行 node --test src<path> backend 目录执行 go test .<path> .<path> -count=1；在仓库根目录执行 npm run check、npm test、npm run smoke，并在已准备 Go sidecar 的环境执行 npm run smoke:go:business。最后手动创建分别关联需求和反馈的单阶段及多阶段计划，在验收模块完成计划验收，确认需求<path> intake 验收。
