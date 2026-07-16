# 计划列表改为显示计划 Markdown 内部标题

修正 Go 后端计划投影将 file_path 直接作为 title 的行为，复用受工作区约束的计划文件读取能力，从 Markdown 一级标题（无一级标题时取首个标题）生成展示标题，并将其一致传递到计划、任务及需求<path>

## Tasks

- [x] P001: 实现安全的计划 Markdown 标题提取与标题覆盖投影 <!-- scope: backend<path> 及 plans 包测试 -->
  - Acceptance: 能够从计划文件内容提取并清理 Markdown 标题；优先使用一级标题，无一级标题时使用首个合法标题；PlanDTO、PlanSnapshot 和 TaskDTO 支持使用提取结果，且无标题、文件缺失、非法路径、超限或无效编码时采用明确的 Plan #ID 回退而不是把文件名当标题。
- [x] P002: 将内部标题接入计划查询和项目快照组装链路 <!-- scope: backend<path> -->
  - Acceptance: 计划列表<path> snapshot 的 plans[].title 均来自对应计划 Markdown；tasks[].plan_title、需求和反馈的 linked_plans[].title 及兼容 plan_title 字段使用同一标题；file_path 仍原样保留并继续用于打开文件和关联，不改变排序、状态或任务数据。
- [x] P003: 补充标题展示链路的回归测试和契约断言 <!-- scope: backend<path> -->
  - Acceptance: 测试覆盖标题与文件名不同、一级标题优先、仅有次级标题、标题尾部井号<path> snapshot<path> 继续通过 plan.title 展示标题且 file_path 仅作为文件路径信息。
- [x] P004: Final validation <!-- scope: validation -->
  - Acceptance: 在 backend 目录运行 go test .<path> .<path> 和 go test .<path> npm test 与 npm run build；启动应用后准备文件名与 Markdown 标题不同的计划，确认计划卡片、任务分组及需求<path> Markdown 标题，打开文件仍定位到原 file_path，并验证缺失或无标题文件显示 Plan #ID 回退。
