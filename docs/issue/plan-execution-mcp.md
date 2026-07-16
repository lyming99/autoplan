# 规划执行一体化与 MCP 方案

- 状态：Proposal
- 优先级：P1
- 范围：PlanSpec、Plan/Task Runtime、Operation、MCP、Chat/UI 兼容层
- 核心原则：Go 单 writer、同一应用服务、异步执行、可恢复、可审计

## 背景

AutoPlan 已经具备需求、计划、任务、循环执行、验收、Operation、HTTP/stdio MCP 等基础能力，但“规划”和“执行”还没有收敛成一个对外稳定的工作契约：

1. 当前 MCP 的 Plan/Task 工具以查询为主，外部 Agent 可以创建需求并启动整个循环，但不能直接提交结构化计划、运行指定计划、控制指定任务或查询长期 Operation。
2. Go 应用层已经声明 `plan.run`、`plan.stop`、`plan.resume`、`plan.reexecute`、`plan.validate`、`task.run`、`task.stop` 等命令，但公开 capability 仍未全部启用，MCP catalog 也没有暴露这些能力。
3. 当前存在多套计划输入格式：
   - `src/loop/structuredPlanSpec.js` 的结构化 PlanSpec；
   - `src/chat/chatPlanTools.js` 的 Chat `create_plan` 参数；
   - `backend/internal/bootstrap/loop_runner.go` 的 Go Sidecar 计划生成格式。
4. Chat 创建计划仍包含直接写 Markdown、插入计划和同步任务的逻辑。Go 接管数据库后，所有入口都必须调用同一个 Go application service，不能形成 Node/Go 双写路径。
5. 当前 Go 循环按项目领取“下一个任务”。如果 MCP 要支持 `run_plan(planId)` 或 `run_task(taskId)`，执行选择必须绑定目标资源，不能通过调整排序或启动全局循环间接实现。

## 目标

实现下面的完整闭环：

```text
外部 AI / AutoPlan Chat / 内置规划器
              │
              ▼
         统一 PlanSpec
              │
              ▼
     创建草稿或创建并提交执行
              │
              ▼
      Operation + Scheduler
              │
              ▼
       指定 Plan / Task 执行
              │
              ▼
     验证、验收、重做、事件回溯
```

具体目标：

- 所有规划入口使用同一版本化 PlanSpec。
- MCP 可以提交计划，并控制指定计划或任务。
- 所有长任务立即返回 `operationId`，不占用 MCP 请求等待完整执行。
- 数据库中的 Plan/Task/Operation 是执行状态权威；Markdown 是可修复的兼容投影。
- HTTP 与 stdio 使用相同 catalog、schema、handler 和 application service。
- 保留现有 28 个 MCP 工具及其成功/失败语义。
- 重试、停止、崩溃恢复、验收和重做都可审计、可回溯。

## 非目标

- 不允许 MCP 提交任意 shell command、cwd、环境变量或进程参数。
- 不把任务 `scope` 当作文件访问授权；它只用于提示、冲突检查和调度。
- 不开放远程 MCP 监听；首版仍只允许 loopback HTTP 或本机 stdio。
- 不在 MCP adapter 中复制计划、执行、验收或数据库业务逻辑。
- 首版不实现基于 DAG 的自动依赖分析；任务默认按顺序执行，并发批次需要显式提交。

## 总体架构

```text
Codex / Claude / IDE / AutoPlan Chat
                 │
          MCP HTTP / stdio
                 │
                 ▼
       Go MCP Registry + Factory
                 │
                 ▼
  PlanApplication / RuntimeBridge / OperationService
          │              │              │
          │              │              └─ 幂等、取消、恢复、结果摘要
          │              └─ Scheduler、Agent CLI、Validator
          └─ PlanSpec 校验、Plan/Task、来源关联
                 │
                 ▼
       SQLite 权威状态 + Event Outbox
                 │
                 ▼
      Markdown Projector / UI / MCP 查询
```

约束：

- Go application service 是唯一业务写入口。
- MCP handler 只负责解码、构造可信 caller context、调用应用服务和编码安全结果。
- HTTP 与 stdio 不得出现不同工具集或不同 schema。
- 执行器、进程、文件系统和密钥能力不得注入 MCP handler。

## 统一 PlanSpec V1

新增机器可读契约：

```text
backend/openapi/schemas/plan-spec.schema.json
```

建议结构：

```json
{
  "schemaVersion": "1",
  "title": "增加 MCP 计划执行闭环",
  "summary": "统一规划、执行、观测和验收入口",
  "tasks": [
    {
      "title": "统一 PlanSpec 契约",
      "details": "将 Chat、Node 规划器和 Go 规划器映射到同一结构",
      "scope": [
        "backend/openapi/schemas",
        "src/loop"
      ],
      "acceptance": [
        "相同输入生成相同任务编号和 Markdown",
        "非法字段在入库前被拒绝"
      ]
    }
  ],
  "finalValidation": {
    "executorIds": [3, 4],
    "criteria": [
      "Node 与 Go 合约测试通过",
      "HTTP 与 stdio MCP 结果一致"
    ]
  }
}
```

规则：

- `schemaVersion` 首版固定为 `1`。
- `title`、`summary`、`tasks`、`finalValidation.criteria` 必填。
- 普通任务不得携带 P001/P002 等最终编号；服务端按顺序生成。
- `scope` 是字符串数组；无法判断时规范化为 `unknown`。
- `acceptance` 是可观测验收标准数组，不允许嵌套 checkbox。
- 服务端统一追加或规范化最后一个“完整验收”任务，scope 固定为 `validation`。
- `finalValidation.executorIds` 只能引用当前项目已保存、已启用的执行器。
- MCP 不接受原始命令。旧 PlanSpec 中的 command 仅作为兼容展示信息迁移，不能直接成为执行授权。
- PlanSpec 使用 canonical JSON 计算 digest，用于去重、幂等和审计。

### 兼容映射

- `structuredPlanSpec.js`：映射 `scope[]`、`acceptance[]` 和 `finalValidation.criteria`。
- Chat `create_plan`：将 `acceptancePoints` 映射为 `acceptance`，将 `overallAcceptance` 映射为 `finalValidation`。
- Go Sidecar：将单字符串 `scope`、`acceptance` 和 `finalValidation` 规范化为数组结构。
- 新写入只产生 V1；旧数据保持可读，不在读取时静默重写。

## MCP 工具设计

### 保留工具

保留现有 Project、Requirement、Feedback、Plan/Task 查询、Executor 和 Loop 工具，行为保持兼容。

### 新增工具

| 工具 | 类型 | 说明 |
|---|---|---|
| `create_plan` | mutation | 提交 PlanSpec，创建草稿或创建并入队 |
| `run_plan` | command | 执行指定计划 |
| `stop_plan` | command | 停止指定计划及其活动任务 |
| `resume_plan` | command | 恢复停止、中断或验收失败的计划 |
| `reexecute_plan` | command | 重置并重新执行已完成计划 |
| `recreate_plan` | command | 基于关联需求/反馈创建新计划版本 |
| `validate_plan` | command | 执行指定计划的完整验收 |
| `run_task` | command | 执行指定任务 |
| `run_task_batches` | command | 按显式批次执行任务 |
| `stop_task` | command | 停止指定任务 |
| `set_acceptance` | mutation | accept、unaccept 或 redo 计划/任务 |
| `get_operation` | query | 查询 Operation 状态及安全结果摘要 |
| `list_events` | query | 按项目和游标读取事件 |

首批 MVP 工具：

```text
create_plan
run_plan
stop_plan
get_operation
list_events
```

第二批再开放任务级执行、恢复、重跑、验证和验收工具。

### create_plan

输入：

```json
{
  "projectId": 7,
  "source": {
    "type": "requirement",
    "id": 42
  },
  "mode": "queue",
  "planSpec": {
    "schemaVersion": "1",
    "title": "计划标题",
    "summary": "计划概要",
    "tasks": [],
    "finalValidation": {
      "executorIds": [],
      "criteria": []
    }
  }
}
```

`mode`：

- `draft`：默认值，只创建计划，等待显式 `run_plan`。
- `queue`：创建成功后提交 `plan.run` Operation。

`source` 可省略。提供时必须验证来源属于同一项目，并在同一业务事务中建立 Requirement/Feedback 与 Plan 的关联。

输出：

```json
{
  "projectId": 7,
  "plan": {
    "id": 101,
    "status": "pending",
    "totalTasks": 4
  },
  "operation": {
    "operationId": "op-01...",
    "type": "plan.run",
    "status": "queued",
    "requestId": "request-01...",
    "acceptedAt": "2026-07-15T10:00:00Z"
  },
  "nextPollAfterMs": 1000
}
```

`draft` 模式不返回 Operation。

### run_plan

```json
{
  "projectId": 7,
  "planId": 101
}
```

要求：

- Plan 必须属于指定项目。
- 只允许 `draft`、`pending`、`stopped`、`interrupted`、`validation_failed` 等可执行状态。
- draft 激活、Operation 创建和执行入队必须形成一个可恢复的业务动作。
- 执行选择必须绑定 `planId`，不能通过启动全局循环后领取任意计划实现。

### get_operation

```json
{
  "projectId": 7,
  "operationId": "op-01..."
}
```

返回字段限制为：

- Operation ID、类型、状态、版本和时间；
- 关联 planId/taskId；
- 有界、脱敏的错误代码和摘要；
- 可选的最新 Plan/Task 进度摘要；
- 下一次建议轮询间隔。

禁止返回 prompt、完整 stdout/stderr、环境变量、真实 userData、token、PID、绝对日志路径或未授权文件路径。

### list_events

```json
{
  "projectId": 7,
  "afterEventId": 1200,
  "limit": 100
}
```

返回稳定游标和有界事件列表。MVP 使用工具轮询；后续可以增加 MCP resource template 和 subscription：

```text
autoplan://projects/{projectId}/plans/{planId}
autoplan://projects/{projectId}/operations/{operationId}
autoplan://projects/{projectId}/events
```

## 状态模型

### Plan

```text
draft
  └─ run ─→ pending ─→ running ─→ ready_for_validation ─→ completed
                         │                    │
                         │                    └─ validation failure ─→ validation_failed
                         ├─ explicit stop ─→ stopped
                         └─ crash/recovery ─→ interrupted
```

规则：

- `stopped` 表示用户或 MCP 显式停止。
- `interrupted` 表示崩溃、进程丢失或恢复阶段中断。
- `resume_plan` 将可恢复任务重置为 `pending`，Plan 回到 `pending`。
- `reexecute_plan` 只接受已完成计划，清理验收状态并按既有语义重置任务。
- `recreate_plan` 不修改旧计划，而是生成带来源关系的新计划。
- Plan 完成必须以数据库状态和最终验收结果为准，不能只依赖 Markdown checkbox。

### Task

```text
pending → running → completed
             │
             ├→ failed
             ├→ stopped
             └→ interrupted
```

- 停止请求可以先进入 `stopping`。
- redo 将已完成或已验收任务重置为 `pending`，同时使父 Plan 回到 `pending`。
- 同一任务在同一时刻只能存在一个活动执行 Operation。

### Operation

```text
queued → running → succeeded
             │
             ├→ failed
             ├→ cancelled
             └→ interrupted
```

- 每个长任务必须先持久化 Operation，再启动进程。
- MCP 超时或断开不能取消已接受的 Operation。
- 显式 stop/cancel、执行超时、Scheduler 关闭才是取消权威。
- 重启后 queued/running Operation 必须按 recovery policy 进入可解释终态或恢复执行。

## 数据与投影

建议为 Plan 增加以下权威字段，或建立等价的 `plan_specs` 表：

```text
spec_version
spec_json
spec_digest
artifact_state
artifact_updated_at
```

推荐原则：

1. PlanSpec 和 plan_tasks 在同一数据库事务中写入。
2. Markdown 由 PlanSpec 和数据库任务状态确定性生成。
3. 执行完成时先提交 Task/Plan/Event/Operation 状态，再刷新 Markdown 投影。
4. Markdown 投影失败只记录 `plan.artifact.sync_failed`，不得回滚已完成的业务执行状态。
5. 启动时运行 artifact reconciliation，修复缺失、陈旧或 digest 不一致的投影。
6. 老 plan 没有 spec_json 时继续读取 SourceRef/Markdown，并在显式迁移时生成 PlanSpec，不在普通查询中写回。

## 指定目标执行

扩展运行选择器：

```go
type RunInput struct {
    ProjectID   int64
    OperationID string
    PlanID      int64
    TaskIDs     []int64
    Mode        string // automatic | plan | task | batches | validation
}
```

Repository 增加目标绑定能力，例如：

```text
ClaimSelectedPlanTask(projectId, planId, taskId, operationId)
ClaimNextTaskInPlan(projectId, planId, operationId)
```

禁止通过以下方式模拟指定执行：

- 临时修改 Plan 排序；
- 启动全局 loop 后假设目标计划会首先被选中；
- 只在 MCP handler 中检查 ID，实际 Runner 仍领取全局下一个任务。

Scheduler 至少保证：

- 同一项目状态变更串行化；
- 同一工作区不会被两个项目并发写入；
- 相同 Plan/Task 不会产生重复活动 Operation；
- stop 能定位并终止对应的进程树；
- 执行结果只能完成创建它的 Operation 和任务 claim。

## 幂等与并发

- HTTP 使用 `Idempotency-Key`；stdio 使用稳定 request identity 派生幂等键。
- `create_plan` 同时使用 canonical PlanSpec digest、projectId 和 source 形成重复检测材料。
- 相同 key、相同 digest 返回原结果。
- 相同 key、不同 digest 返回 `idempotency_key_reused`。
- 已有相同目标 Operation 时返回 `request_in_progress` 或原 Operation，不重复启动进程。
- 所有 mutation 支持 project/resource 归属校验和 optimistic version 检查。

## 错误契约

继续使用稳定、无敏感信息的错误代码：

```text
invalid_request
not_found
precondition_failed
relation_conflict
idempotency_key_reused
request_in_progress
operation_cancelled
request_timeout
service_unavailable
internal_error
```

MCP 失败结果保持：

```json
{
  "isError": true,
  "content": [
    {
      "type": "text",
      "text": "Plan cannot be executed in its current state."
    }
  ],
  "structuredContent": {
    "error": "Plan cannot be executed in its current state.",
    "code": "precondition_failed",
    "errorCode": "precondition_failed"
  }
}
```

## 安全要求

- HTTP 只绑定 `127.0.0.1`，继续验证 Bearer token、session、Origin、method/path、body 上限、超时和连接上限。
- stdio stdout 只输出 MCP 协议帧，诊断信息只能写 stderr。
- `create_plan` 不接受绝对输出路径，Plan 文件名和目录由服务端生成。
- `run_plan`、`run_task` 不接受 command、args、cwd、env 或 debug 配置。
- 最终验收只能引用当前项目已保存执行器；disabled executor 不可运行。
- MCP adapter 不能直接访问 repository、SQL、文件系统或 process runner。
- 返回结果和审计不得包含 token、prompt、完整模型输出、完整日志或未授权路径。
- 不得为了兼容失败而回退到 Node MCP 或启动第二个 listener。

## 兼容与迁移

1. 保留已有 28 个 MCP 工具的名称、输入和输出语义。
2. 新工具以 catalog v2 的加法方式发布，不重命名旧工具。
3. HTTP 与 stdio在同一版本同时增加新工具。
4. Chat `create_plan` 改成 PlanSpec adapter，并调用 Go `CreateFromSpec`。
5. Node owner 兼容期可以保留旧实现，但 Go owner 模式下必须 fail closed，禁止写同一个数据库。
6. AppSnapshot 继续保留旧 camelCase 投影；新 Operation/PlanSpec 字段采用可选增量字段。
7. 老 Plan、Plan 文件和 Intake link 不进行破坏性批量重写。

## 实施任务

### P001：冻结统一契约

范围：

```text
backend/openapi/schemas/plan-spec.schema.json
backend/openapi/schemas/mcp.schema.json
docs/issue/plan-execution-mcp.md
```

内容：

- 定义 PlanSpec V1。
- 定义新 MCP 工具的严格输入/输出 schema。
- 定义状态转换和错误码。
- 增加三套旧格式到 V1 的 fixture。

验收：同一 fixture 在 Node、Go、Chat adapter 中得到相同 canonical JSON、digest、任务编号和最终验收任务。

### P002：Go PlanSpec 应用服务

范围：

```text
backend/internal/application/plans/
backend/internal/domain/plan/
backend/internal/repository/
backend/internal/repository/sqlite/
```

内容：

- 增加 `CreateFromSpec`。
- 在事务内创建 Plan、PlanTask、Intake link 和 Event。
- 保存 spec version/json/digest。
- 实现重复检测和 optimistic concurrency。

验收：数据库失败、重复请求、跨项目 source、非法 executor 引用均不产生部分业务数据。

### P003：Markdown Projector

范围：

```text
backend/internal/application/plans/
backend/internal/application/files/
backend/internal/bootstrap/
```

内容：

- 从 PlanSpec 和 Task 状态确定性渲染 Markdown。
- 使用受控路径和临时文件原子替换。
- 增加 artifact digest、失败事件和启动修复。
- 执行状态不再依赖先写 checkbox 再提交数据库。

验收：模拟文件写失败后数据库状态仍正确，恢复任务可以重新生成一致 Markdown。

### P004：目标绑定 Runtime

范围：

```text
backend/internal/application/loop/
backend/internal/application/plans/runtime_handler.go
backend/internal/application/tasks/runtime_handler.go
backend/internal/bootstrap/loop_runner.go
backend/internal/runtime/scheduler/
```

内容：

- 扩展 `RunInput` 和目标 claim。
- 实现 `plan.run/stop/resume/reexecute/recreate/validate`。
- 完善 `task.run/run_batches/stop`。
- 接入 Operation、取消、进程树停止和恢复。
- 增加工作区级互斥。

验收：指定 Plan/Task 执行不会领取其他目标；重复 run 不会启动第二个进程。

### P005：MCP Catalog 与 Handler

范围：

```text
backend/internal/mcp/registry.go
backend/internal/mcp/tools/catalog.go
backend/internal/mcp/tools/handlers.go
backend/internal/mcp/runtime_tools.go
backend/openapi/schemas/mcp.schema.json
```

内容：

- 注册新增工具。
- tools/list 返回严格 schema，不使用宽泛 `additionalProperties: true` 替代权威契约。
- handler 只调用 PlanApplication、RuntimeBridge、OperationService 和 EventService。
- HTTP/stdio 使用同一 factory。

验收：所有新增工具跨 transport 的业务 DTO、错误码、Operation、Event 和持久化后状态一致。

### P006：Operation 与 Event 查询

范围：

```text
backend/internal/application/operations/
backend/internal/application/events/
backend/internal/mcp/tools/
```

内容：

- 增加 MCP 安全 Operation DTO。
- 增加 project-scoped event cursor 查询。
- 对错误和输出做长度限制及脱敏。

验收：跨项目 Operation/Event ID 不泄漏资源是否存在；返回内容不含敏感字段。

### P007：Chat/UI 收敛

范围：

```text
src/chat/chatPlanTools.js
src/chat/chatTools.js
src/data/goDataClient.js
src/loop/goRuntimeAdapter.js
src/renderer/
```

内容：

- Chat 输入映射到 PlanSpec V1。
- Go owner 模式通过 Go API 创建计划。
- UI 展示 Operation 状态和投影同步错误。
- 保留旧计划读取兼容。

验收：Chat、MCP、自动规划创建的计划在 UI 中具有相同结构和行为。

### P008：门禁、恢复与发布

内容：

- 新增独立 feature flag，例如 `mcp_plan_execution_v1`，默认关闭。
- capability 只在实现、恢复和跨 transport 门禁全部通过后启用。
- 验证崩溃恢复、取消、超时、重复请求和 artifact reconciliation。
- 更新 P13B contract、fixture、evidence 和 rollback 文档。

## 验收矩阵

必须覆盖：

- `create_plan(draft)` 只创建计划，不启动进程。
- `create_plan(queue)` 创建一次计划并产生一次 `plan.run` Operation。
- 相同幂等键重试返回相同 planId/operationId。
- 相同幂等键不同 PlanSpec 被拒绝。
- `run_plan(A)` 不执行计划 B。
- `run_task(T)` 不执行同计划的其他 pending task。
- 批次内 scope 冲突时 fail closed。
- 显式 stop 最终进入 stopped/cancelled，不继续下一任务。
- 进程崩溃或应用重启进入 interrupted 或按策略恢复。
- 验收失败进入 validation_failed，可 resume 或 redo。
- Markdown 写入失败不改变已提交的 Task/Operation 终态。
- 跨项目 planId/taskId/operationId/eventId 被拒绝。
- disabled executor、未知 executor、任意 command 字段被拒绝。
- HTTP 与 stdio的 tools/list、成功结果、错误结果一致。
- 响应、日志和审计中没有 token、env、prompt、完整输出或未授权路径。
- Go owner 模式不存在 Node/sql.js 业务写入。

建议验证命令：

```powershell
npm run check
npm test
npm run smoke:go:business
npm run migration:p13b:verify
Set-Location backend
go test ./...
```

## 发布与回滚

发布顺序：

1. 合入 PlanSpec schema 和只读兼容 adapter。
2. 合入 Go CreateFromSpec、Projector 和 Runtime，但 capability 保持关闭。
3. 运行完整 contract、恢复和安全门禁。
4. 先为本地 stdio/loopback HTTP 开启 MVP 工具。
5. 观察 Operation 失败率、重复率、停止成功率和 artifact drift。
6. 再开放任务级控制、验收和重做工具。

回滚规则：

- 关闭新 MCP capability 和 admission，不切换数据库 owner。
- 已接受 Operation 由当前 runtime 完成、取消或恢复，不由旧 Node 接管。
- 不启动第二个 MCP listener，不自动回退到旧 Node MCP。
- 保留 PlanSpec、Operation、Event 和 artifact 现场，用于前向修复。
- 已发生 Go 正式写入后，回滚只能使用兼容 Go sidecar 或经过演练的数据恢复流程。

## 完成定义

本 issue 只有同时满足以下条件才算完成：

- PlanSpec V1 成为 Chat、MCP、自动规划的统一新写入契约。
- MCP 能创建并执行指定计划，且返回可查询的 Operation。
- Plan/Task 执行选择与传入 ID 严格绑定。
- 数据库是执行状态权威，Markdown 可从数据库完整重建。
- HTTP 与 stdio MCP 完全共享 catalog、schema 和 application service。
- 所有新增 mutation 具备幂等、跨项目隔离、取消、恢复、审计和脱敏测试。
- 现有 MCP 工具和旧 Plan 保持兼容。
- 单 writer、Files policy、Operation、Scheduler 和发布门禁全部通过。
