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
