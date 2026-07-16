# 修复删除计划触发 go_business_transport_unavailable

补齐 Go HTTP 计划删除接口及运行时路由注册，使 capabilities 正确声明并实际提供 plans.delete，复用现有 plans.Service.Delete 完成乐观锁校验、级联数据清理和最新快照返回，避免 HttpAutoplanClient 回退到不可用 IPC transport。

## Tasks

- [x] P001: 实现计划删除 HTTP 适配器 <!-- scope: backend<path> 新增计划持久化 mutation 路由及测试 -->
  - Acceptance: 注册 DELETE <path> project_id、plan_id、expected_updated_at 和幂等请求元数据，调用 plans.Service.Delete，并按现有 API envelope 返回 snapshot；无效输入、未找到、版本冲突、受保护关系和服务不可用均映射为稳定 HTTP 错误。
- [x] P002: 将 capabilities 与计划删除路由接入真实 Go daemon <!-- scope: backend<path> -->
  - Acceptance: RegisterRuntimeRoutes 同时注册 <path> 和计划删除路由；真实 daemon 的 capability discovery 返回 plans.delete enabled=true，经过安全中间件的 DELETE 请求不再返回 404，也不会触发 UnavailableAutoplanClient。
- [x] P003: 增加删除计划端到端传输回归覆盖 <!-- scope: backend<path> 计划接口测试、src<path> -->
  - Acceptance: 测试证明 HttpAutoplanClient 在 plans.delete 启用时依次获取 capability<path> 并发送 DELETE <path> 服务删除计划后返回不含目标计划的 snapshot，且全流程没有 go_business_transport_unavailable 或 IPC 调用；同时覆盖版本冲突与不存在计划的失败响应。
- [x] P004: 同步公开接口契约 <!-- scope: backend<path> 及相关迁移契约检查 -->
  - Acceptance: OpenAPI 描述 DELETE <path> 的请求体、幂等头、成功 envelope 和错误响应，并与 plans.delete capability、实际路由和前端请求格式一致，契约检查不再报告已启用 capability 缺少实现路由。
- [x] P005: Final validation <!-- scope: validation -->
  - Acceptance: 运行 cd backend; go test .<path> .<path> .<path> node --test src<path> run build、npm run smoke:go:business；最后在运行中的 Go sidecar 上确认 GET <path> 包含 enabled=true 的 plans.delete，删除一个测试计划后 DELETE <path> 返回 200 和更新后的 snapshot，界面不再出现 go_business_transport_unavailable。
