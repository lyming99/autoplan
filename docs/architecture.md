# AutoPlan 代码架构评估与重构方案

> 评估时间：2026-06-28
> 评估范围：`src/` 全量代码（约 16200 行）
> 结论：**架构骨架合理，但存在 4 个"上帝模块"，需要从"按技术分层"演进到"按领域分块"**

---

## 一、总体判断

架构方向是对的，但拆分不彻底。项目已经搭好了分层骨架（Electron 三进程分离、`loop/` 子模块、渲染层路由），但**每一层内部都有一个过度膨胀的核心文件**在拖后腿。

### 值得肯定的地方

- ✅ **Electron 安全实践规范**：`contextIsolation: true` + `nodeIntegration: false` + preload 隔离（`src/main.js`）
- ✅ **循环逻辑已做领域拆分**：`src/loop/` 下按职责拆出了 runtime / taskExecution / planGeneration / validation / concurrency / snapshots / taskEvents / workspaceFiles / agentCliConfig / planParser 共 10 个模块
- ✅ **渲染层用了 React Router**，CSS 已按模块拆分（workspace / components / layout），有配套测试文件
- ✅ **IPC 命名规范**：`projects:create` / `loop:start` / `tasks:run` 等 domain:action 风格，一致性好

### 问题集中在 4 个地方

见下文详述。

---

## 二、四个核心问题

### 问题 1：`loopService.js`（1462 行 / 90 个方法）是上帝类

`LoopService extends EventEmitter` 一个类包揽了：

- 运行时编排（start / stop / runOnce / schedule）
- 计划生命周期（insertPlan / reorderPlans / nextRunnablePlan / generatePlan）
- 任务调度与执行（runTask / runTaskBatches / executeTask / completeTask）
- Codex / Shell 进程执行（`runCodex` 单方法约 180 行、`runShell`、`runCodexWithPlanGuard`）
- 快照序列化（snapshot / status / projectStateColumns）
- 并发批处理（parallelTaskBatch / validatedParallelTaskBatches）

虽然部分方法已经**委托**给 `loop/` 子模块（如 `executeTask` → `taskExecution.executeTask`），但类本身仍是巨型门面 + 状态持有者。`runCodex` 一个方法就近 180 行，包含了流式输出、session 恢复失败回退、tail 计时器清理等多重职责。

### 问题 2：`main.js`（704 行）IPC 全堆一个文件

所有 IPC handler 混在 `main.js`：

- projects（create / update / delete）
- loop（configure / start / stop / runOnce）
- tasks（run / runParallel / stop）
- requirements / feedback / intake（create / update / delete / interrupt / resume / appendTask）
- plans（read / reorder）
- workspace（openFile）

同时还塞进了：

- 文件协议注册（`registerFileProtocol`）
- MCP 服务管理（startMcpServer / restartMcpServer / saveMcpSettings）
- 路径安全校验（`isInsidePath` / `resolvePlanPath` / `resolveWorkspaceFilePath`）
- 文件打开器（vscode / command / folder / system 四种模式）
- Plan 解析状态机（`planReadTaskParseStatus` 等）

`main.js` 本应只负责 app 生命周期和窗口创建。

### 问题 3：`useWorkspaceController.ts`（540 行 / 65 个回调）巨型 Hook

整个工作区页面的**所有**状态和操作塞在一个 hook 里：

- 表单状态（loopForm / loopFormDirty / mcpAuthToken / scopeFileOpenSettings）
- 搜索（searchQuery / workspaceSearch / filteredItems）
- 计划读取（planReadState / openPlanReader / refreshPlanReader）
- 附件（pendingAttachments / addPendingFiles / removePendingAttachment）
- tab 切换（activeTab / selectTab）
- intake CRUD（createRequirement / createFeedback / updateRequirement...）
- loop 控制（submitLoopConfig / runLoopAction / switchProject）

`WorkspacePage.tsx` 从它解构出 **46 个字段**。任何一处改动都要审查整个 hook，重新渲染逻辑难以推理。

### 问题 4：渲染层按"技术类型"而非"领域"组织

```
src/renderer/
  components/    ← 平铺：PlanLists, IntakePanel, Composer, SearchResults, CodexLog...
    plans/       ← 已有子目录
    workspace/   ← 已有子目录
  hooks/         ← 只有 2 个，useWorkspaceController 巨大
  utils/         ← search.ts(618行)、workspaceForms、planTasks... 平铺
  types.ts       ← 796 行，全应用类型一锅端
```

同一个领域（比如 intake 需求/反馈）的逻辑散落在 4 处：

- `intakeService.js`（主进程业务）
- `main.js` 的 IPC handler
- `useWorkspaceController` 的回调
- `IntakePanel.tsx` 组件

没有"内聚到一个文件夹"的概念。修改一个领域要跨 4 个目录找代码。

---

## 三、推荐的目标架构

核心理念：**从"按技术分层"转向"按领域分块（feature/domain）"**，每层都设立"薄入口 + 厚模块"的原则。

### 3.1 主进程：拆分 IPC 与服务

```
src/main/
  index.js                  ← 仅 app 生命周期、窗口创建（目标 ~80 行）
  ipc/
    projects.js             ← projects:create / update / delete
    loop.js                 ← loop:configure / start / stop / runOnce
    tasks.js                ← tasks:run / runParallel / stop
    intake.js               ← requirements / feedback / intake:*
    plans.js                ← plans:read / reorder
    workspace.js            ← workspace:openFile
    register.js             ← 汇总注册所有 handler
  services/
    loop/                   ← 现有 src/loop/ 目录平移进来
      LoopOrchestrator.js   ← 从 loopService 拆出：只管调度 / 状态机 / 事件
      CodexRunner.js        ← runCodex / runCodexWithPlanGuard / runShell
      PlanRepository.js     ← insertPlan / reorderPlans / nextRunnablePlan...
      TaskRunner.js         ← 委托 taskExecution 的门面
      ...（保留现有 runtime / taskExecution / validation 等模块）
    database.js
    intake.js
    attachments.js
    mcp/
    agentCli.js
  utils/
    paths.js                ← isInsidePath / resolvePlanPath / resolveWorkspaceFilePath
    fileOpener.js           ← openResolvedFilePath / runOpenCommand
```

**关键动作：**

1. **把 `LoopService` 拆成协作类**

   | 新类 | 职责 | 来源方法 |
   |------|------|----------|
   | `LoopOrchestrator` | 调度 + 状态机 + 事件发射 | `start` / `stop` / `runOnce` / `scheduleProject` / `status` / `snapshot` |
   | `CodexRunner` | 进程执行 + 流式输出 + session 管理 | `runCodex` / `runCodexWithPlanGuard` / `runShell` |
   | `PlanRepository` | 计划 CRUD + 排序 + 激活 | `insertPlan` / `reorderPlans` / `nextRunnablePlan` / `activateDraftPlan` / `generatePlan` |
   | `TaskRunner` | 任务执行门面 | `runTask` / `runTaskBatches` / `executeTask` / `completeTask` |

   `runCodex` 那 180 行单独成文件，抽出"流式输出 / session 回退 / tail 计时器"为内部辅助函数。

2. **IPC 按域分文件**，`index.js` 只需：

   ```js
   require('./ipc/register').registerAll({ db, loop, intakeService, attachmentsRoot });
   ```

3. **路径安全与文件打开工具函数**抽到 `utils/`，`index.js` 不再承载。

### 3.2 渲染层：引入 feature 目录

```
src/renderer/
  app/                      ← 路由、App 壳、全局 Provider
  pages/                    ← 页面只做组装（瘦）
    ProjectsPage.tsx
    WorkspacePage.tsx       ← 目标 ~80 行，只做 tab 路由 + 组件组装
  features/                 ← 按领域内聚 ★关键
    intake/
      IntakePanel.tsx
      useIntakeActions.ts   ← 从 useWorkspaceController 拆出
      intakeTypes.ts
    plans/
      PlanList.tsx
      TaskList.tsx
      EventList.tsx
      usePlanReader.ts      ← planReadState 相关逻辑
    tasks/
      ...
    search/
      SearchResults.tsx
      WorkspaceSearchBox.tsx
      search.ts             ← 从 utils/ 平移，并按职责进一步拆分
      workspaceSearch.ts
    workspace-setup/        ← loopForm / mcpAuthToken / scopeFileOpen 设置
      WorkspaceSettingsView.tsx
      useLoopConfigForm.ts
    overview/
      WorkspaceOverviewView.tsx
      WorkspaceSidebar.tsx
  shared/                   ← icons, shared.tsx, MarkdownReader 等跨域复用
  lib/api.ts                ← 封装 window.autoplan 的 TS 调用（现在散在各处）
  types/                    ← types.ts 按域拆分
    plan.ts
    intake.ts
    project.ts
    workspace.ts
```

**关键动作：**

1. **拆分 `useWorkspaceController`**（P0，最大痛点）

   按领域拆成多个 hook，页面层组合它们：

   | 新 Hook | 负责的状态/操作 |
   |---------|----------------|
   | `useIntakeActions` | pendingAttachments / createRequirement / createFeedback / updateRequirement / deleteRequirement / appendIntakeTask / interruptIntake / resumeIntake |
   | `usePlanReader` | planReadState / openPlanReader / closePlanReader / refreshPlanReader |
   | `useLoopConfigForm` | loopForm / loopFormDirty / submitLoopConfig / mcpAuthToken / scopeFileOpenSettings |
   | `useWorkspaceSearch` | searchQuery / workspaceSearch / filteredItems / selectSearchResult |

   `WorkspacePage` 只做组合：

   ```tsx
   export function WorkspacePage() {
     const intake = useIntakeActions(projectId);
     const planReader = usePlanReader(projectId);
     const loopForm = useLoopConfigForm(projectId);
     const search = useWorkspaceSearch(snapshot);
     // ...
   }
   ```

2. **`types.ts` 按域拆分**（P0，机械拆分，立刻降低认知负担）

   - `types/project.ts`：`Project` / `AppSnapshot`
   - `types/plan.ts`：`Plan` / `PlanTask` / `WorkspacePlanReadState`
   - `types/intake.ts`：`IntakeType` / `PendingAttachment`
   - `types/workspace.ts`：`WorkspaceTab` / `WorkspaceSearchResult`

3. **建立 `lib/api.ts`**

   把对 `window.autoplan.xxx` 的直接调用收敛成一层 typed API，组件不直接碰 `window.autoplan`：

   ```ts
   // lib/api.ts
   export const api = {
     snapshot: (projectId: number | null) => window.autoplan.snapshot(projectId),
     createProject: (input: CreateProjectInput) => window.autoplan.createProject(input),
     // ...
   };
   ```

   好处：类型安全、便于测试时 mock、调用点统一。

4. **搜索逻辑**（`search.ts` 618 行）进一步拆成：

   - `search/snapshotFilter.ts`：快照过滤
   - `search/highlight.ts`：高亮匹配
   - `search/routeLocator.ts`：结果路由定位

### 3.3 关于"是否拆分多个界面（路由页）"

当前只有 `ProjectsPage` 和 `WorkspacePage` 两个路由，而 `WorkspacePage` 通过 tab 承载了概览 / 计划 / 任务 / 事件 / 设置 / 搜索 6 种视图。

**建议：不必急着拆成多个路由页面。** tab 式工作区对这类"一个项目一个工作台"的场景是合理的。真正要做的是**把 tab 内容拆成独立 feature 模块**（上面 `features/` 结构已经体现），让 `WorkspacePage` 退化为纯组装：

```tsx
// 理想的 WorkspacePage —— 只做布局和 tab 路由，~80 行
export function WorkspacePage() {
  return (
    <WorkspaceShell sidebar={<WorkspaceSidebar />} search={<WorkspaceSearchBox />}>
      {activeTab === 'overview' && <OverviewView />}
      {activeTab === 'plans'   && <PlansView />}
      {activeTab === 'tasks'   && <TasksView />}
      {activeTab === 'events'  && <EventsView />}
      {activeTab === 'settings' && <WorkspaceSettingsView />}
    </WorkspaceShell>
  );
}
```

**只有当某个 tab 满足以下条件时，才升级为独立路由页面：**

- 需要独立 URL / 深链接（可分享、可刷新保持位置）
- 有独立的数据加载（不依赖工作区快照）
- 内容足够重，独立加载能提升首屏

目前 6 个 tab 都依赖同一个工作区快照，保持在同一页面内更合适。

### 3.4 计划后端配置架构

计划后端配置已经从旧的单组 `agentCliProvider` / `agentCliCommand` / `codexReasoningEffort` 拆成两条独立链路：

- **计划生成配置**：`planGenerationStrategy`、`planGenerationProvider`、`planGenerationCommand`、`planGenerationModel`、`planGenerationCodexReasoningEffort`。
- **计划执行配置**：`planExecutionStrategy`、`planExecutionProvider`、`planExecutionCommand`、`planExecutionModel`、`planExecutionCodexReasoningEffort`。

数据流按层保存快照：

- `project_states` 保存项目默认生成配置和执行配置，同时保留旧 `agent_cli_*` 字段作为兼容输入。
- `requirements` / `feedback` 只保存 intake 级计划生成覆盖，不保存单条 intake 的执行覆盖。单条需求/反馈只能影响这次生成什么计划，不能改变任务由谁执行。
- `plans` 在计划生成成功时同时保存生成配置快照和执行配置快照。执行快照来自项目默认执行配置，不从生成 provider 反推。
- 快照、MCP 返回值和 UI 展示会带出新字段；旧字段继续存在，便于旧客户端、旧日志和旧 plan 回退。

三种计划生成策略由 `src/loop/planGeneration.js` 分派：

| 策略 | 产物 | 后续处理 |
| --- | --- | --- |
| `external-cli-markdown` | 外置 CLI 写 Markdown plan。 | 保持旧 prompt、stdout 兜底、格式校验、失败事件和 `syncPlanTasks` 流程。 |
| `external-cli-structured` | 外置 CLI 写 `PlanSpec` JSON，或从 stdout 兜底提取 JSON。 | `structuredPlanSpec` 校验/规范化，`planRenderer` 确定性渲染 Markdown，再走现有 Markdown 校验和任务同步。 |
| `builtin-llm-structured` | 内置 LLM 返回 `PlanSpec`。 | 复用同一套 PlanSpec 校验、规范化、渲染和 Markdown 校验。该路径依赖 `ai_configs` 中可用的 provider、模型和 API key。 |

### 结构化 PlanSpec 与 Markdown 渲染契约

结构化计划生成分两步：生成端只产出 `PlanSpec` JSON，AutoPlan 负责校验、规范化和确定性渲染最终 Markdown。这样可以避免外部 agent 直接写出漂移的 Markdown 任务格式，也让 `plans` / `plan_tasks` 入库前有统一的失败边界。

`PlanSpec` JSON 的最小契约：

- 顶层必须是对象，且包含非空 `title`、`summary`、`tasks`、`finalValidation`。
- `tasks` 至少 1 项；每项写 `title`、可选 `scope: string[]`、可选 `acceptance: string[]`。
- 普通任务不要写 P001/P002 编号，`normalizePlanSpec` 会清理手写编号并由渲染器重新编号。
- `finalValidation.command` 和 `finalValidation.criteria` 必填，最终会并入最后的完整验收任务。
- 普通任务缺失 scope 时归一为 `unknown`；完整验收任务 scope 强制归一为 `validation`。

渲染后的 Markdown 在写入 plan 文件前必须通过硬校验：

- 必须包含精确的 `## 任务拆解` 二级标题，不能写成 `## 2. 任务拆解`、`### 任务拆解` 或其它变体。
- 任务拆解章节只能包含顶层任务 checkbox；代码块、引用、表格或嵌套 checkbox 里的内容不允许作为任务来源。
- 任务行必须严格形如 `- [ ] P001: 标题 <!-- scope: src/file.js -->`，编号从 P001 连续递增。
- 最后一项必须是完整验收类任务，且唯一 scope 为 `validation`。
- Markdown 校验失败时按计划生成失败处理，不插入 `plans`，不调用 `syncPlanTasks`。

`planTaskSync` 只解析精确 `## 任务拆解` 章节内的真实顶层 checkbox 行；章节外、代码块、引用、表格和嵌套 checkbox 会被忽略，避免 UI 展示任务和数据库任务被伪任务污染。

OpenCode 结构化生成使用项目内 `.opencode/agents/autoplan-plan.md` 专用 agent：

- 只允许读取少量必要上下文并写指定的 PlanSpec JSON 文件。
- 禁止创建最终 Markdown plan 文件；最终 Markdown 必须由 AutoPlan 渲染。
- 禁止修改业务代码、配置、测试文件，禁止运行命令、联网、派生子 agent 或反问用户。
- 如果 OpenCode 未写 PlanSpec 文件但 stdout 中能提取合法 JSON 对象，`recoverPlanSpecFromStdoutResult` 会安全落盘并继续渲染。
- 如果 stdout 只是 Markdown、寒暄或非 JSON 文本，失败事件会记录 `stdoutPlanSpecClassification`、`stdoutPlanSpecRecoveryReason`、PlanSpec 目标路径、日志路径和 provider 信息，便于 UI 定位。

两种计划执行策略由 `src/loop/taskExecution.js`、`src/loop/validation.js` 通过 `src/loop/planAgentCli.js` 和 `src/loop/planBackendConfig.js` 读取：

- `external-cli` 是当前支持的执行路径，会转换为现有 agent CLI operation fields，继续复用 `runCodexWithPlanGuard`、CLI 会话、OpenCode 串行化、plan guard 和事件记录。
- `builtin-llm` 是第一阶段预留执行策略。任务执行或执行型修复遇到它时必须返回明确错误 `builtin-llm execution is not supported yet`，不能静默 fallback 到外置 CLI。

兼容映射规则：

- 未提供新字段时，生成策略默认 `external-cli-markdown`，执行策略默认 `external-cli`。
- provider 优先读取新字段，其次读取旧 `agentCliProvider`，最后回退 `codex`。
- command 优先读取对应的新 command 字段，其次读取旧 `agentCliCommand`。
- Codex reasoning 优先读取对应的新 reasoning 字段，其次读取旧 `codexReasoningEffort`，最后回退 `medium`；非 Codex provider 的 reasoning 归一为空。
- 项目级旧字段会同时作为生成默认值和执行默认值；intake 级旧字段只兼容映射为计划生成覆盖。
- 老 plan 没有 `plan_execution_*` 快照时，`planAgentCliConfig` 仍会按旧 plan 行、`plan.generated` 事件、来源 intake 和项目默认值回退。

推荐组合：

- 默认兼容：`external-cli-markdown` 生成 + `external-cli` 执行，provider 为 `codex`。
- 外置结构化生成：`external-cli-structured` 生成 + `external-cli` 执行，生成和执行 provider 可以不同。
- 内置结构化生成：`builtin-llm-structured` 生成 + `external-cli` 执行，用内置 AI 配置稳定产出 PlanSpec，再交给 Codex/Claude/OpenCode/oh-my-pi 执行。

### 3.5 项目级 Prompt 配置与注入

项目级 Prompt 是项目维度的补充约束，存储在 `project_states.project_prompt`，通过 `loop.configure` 保存、清空并随 `status` / `snapshot` 回填到渲染层。它用于表达长期项目约定，例如代码风格、目录边界、计划拆解偏好、禁止引入的依赖或执行时需要额外遵守的团队规范。

注入链路分为两段：

- **计划生成**：`src/loop/planGeneration.js` 在需求正文之外追加项目级 Prompt。覆盖 `external-cli-markdown`、`external-cli-structured` 和 `builtin-llm-structured` 三种生成策略；空字符串不追加该段内容。
- **任务执行**：`src/loop/taskExecution.js` 通过 `planAgentCli.planProjectPrompt` 读取当前项目状态，并在单任务执行 prompt 中加入项目级 Prompt。普通执行、超时后新上下文重试、恢复同一 plan 前序会话、任务/计划重做补充内容都会重新构造 prompt，因此都能带上同一项目级 Prompt。

优先级规则：项目级 Prompt 只能补充约定，不能覆盖 AutoPlan 系统级边界。计划生成时必须继续遵守 Markdown 任务拆解格式、PlanSpec JSON 契约和“只写指定输出文件”；任务执行时必须继续遵守只执行当前任务、不提前执行其它 checkbox、plan 文件只读、只改当前 scope、并发隔离和最终验收统一执行等硬约束。项目级 Prompt 与这些规则冲突时，硬约束优先。

---

## 四、迁移优先级

| 优先级 | 改动 | 收益 | 风险 | 预估工作量 |
|--------|------|------|------|-----------|
| 🔴 P0 | 拆 `useWorkspaceController` → 按域 hook | 消除最大痛点，纯前端 | 低 | 中 |
| 🔴 P0 | 拆 `types.ts` → `types/` | 机械拆分，立刻降低认知负担 | 极低 | 小 |
| 🟡 P1 | `main.js` IPC 按域分文件 | 隔离变更，可逐个 handler 迁移 | 低 | 中 |
| 🟡 P1 | 渲染层引入 `features/` 目录 | 配合 P0，物理隔离领域 | 低 | 中 |
| 🟢 P2 | `loopService.js` 拆 `LoopOrchestrator` + `CodexRunner` + `PlanRepository` | 主进程核心解耦，需配套测试 | 中（核心逻辑） | 大 |
| 🟢 P2 | 抽 `lib/api.ts` 收敛 IPC 调用 | 类型安全，便于 mock 测试 | 低 | 小 |

### 迁移原则

1. **增量迁移，不搞大重写**：每次只动一个领域，保持可编译可运行。
2. **先机械后语义**：P0 的 `types.ts` 拆分是纯搬运，零风险；`useWorkspaceController` 拆分是行为保持的重构，需跑测试。
3. **核心逻辑重构需先补测试**：`loopService.js` 拆分前，应先给 `runCodex` / `executeTask` 等核心路径补集成测试，作为重构的安全网。
4. **保持委托模式**：已有的 `executeTask` → `taskExecution.executeTask` 委托是好模式，拆分时延续——门面类调用专职模块。

---

## 五、目录结构对照（当前 → 目标）

### 当前

```
src/
  main.js              ← 混合：生命周期 + IPC + 工具函数（704 行）
  preload.js
  loopService.js       ← 上帝类（1462 行 / 90 方法）
  database.js
  agentCli.js
  attachments.js
  intakeService.js
  codexActivity.js
  mcpServer.js
  mcpTools.js
  loop/                ← 已拆分，可作模板
  renderer/
    App.tsx
    main.tsx
    types.ts           ← 上帝文件（796 行）
    pages/             ← ProjectsPage, WorkspacePage
    components/        ← 平铺 + plans/ + workspace/
    hooks/             ← useSnapshot, useWorkspaceController（巨型）
    utils/             ← search.ts(618行), workspaceForms, planTasks...
    styles/
```

### 目标

```
src/
  main/
    index.js           ← 仅生命周期（~80 行）
    preload.js
    ipc/               ← 按域拆分
    services/
      loop/            ← LoopOrchestrator + CodexRunner + PlanRepository + TaskRunner
      database.js
      intake.js
      attachments.js
      mcp/
      agentCli.js
    utils/             ← paths, fileOpener
  renderer/
    app/               ← 路由、App 壳、Provider
    pages/             ← 瘦页面
    features/          ← 按领域内聚 ★
      intake/
      plans/
      tasks/
      search/
      workspace-setup/
      overview/
    shared/            ← 跨域复用
    lib/api.ts         ← typed IPC 封装
    types/             ← 按域拆分
```

---

## 六、一句话总结

当前架构**骨架合理、血肉臃肿**——分层没错，但 `loopService.js` / `main.js` / `useWorkspaceController.ts` / `types.ts` 四个文件承担了远超它们名字所暗示的职责。

方向不是"推翻重写"，而是**把已有的 `loop/` 拆分模式向上推广到主进程 IPC 层、向下推广到渲染层 feature 层**，让每个领域（intake / plans / tasks / search / workspace-setup）都能内聚到一个文件夹。
