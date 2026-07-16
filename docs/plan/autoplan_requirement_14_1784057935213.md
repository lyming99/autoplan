# 为需求与反馈列表增加“计划生成失败”筛选

当前仓库在 IntakePanel 中以内嵌失败卡展示尚未绑定 Plan 且存在生成失败信息的需求或反馈，但列表没有状态筛选。复用现有 intakeGenerationFailure 与 linkedPlansOf 判定，在需求、反馈面板增加“全部<path>

## Tasks

- [x] P001: 统一计划生成失败筛选判定并派生列表数据 <!-- scope: src<path> -->
  - Acceptance: 定义 IntakePanel 内可复用的失败判定：记录存在 generate_fail_count 或 last_generate_error 等现有失败信息，且尚未绑定可用 Plan；增加面板筛选状态和 useMemo 派生集合；全部模式保留现有顺序，失败模式只展示符合判定的记录；分页的 visibleCount、visibleItems、hasMoreItems 和加载更多上限均基于筛选后集合，切换需求<path>
- [x] P002: 在需求与反馈面板加入筛选控件和筛选空状态 <!-- scope: src<path> src<path> -->
  - Acceptance: 需求模块和反馈模块标题区均显示“全部”和“计划生成失败”筛选按钮，并展示各自基于当前 items 计算的数量；选中状态具备明确的 active 与 aria 语义；失败筛选无结果时显示“暂无计划生成失败记录”而不是通用列表空文案；控件复用现有 filter-tabs<path> 视觉体系，并在窄屏下可换行或横向滚动，不挤压标题、副标题和列表区域。
- [x] P003: 补充失败筛选与分页定位回归测试 <!-- scope: src<path> src<path> -->
  - Acceptance: 测试覆盖无失败、单个失败、历史失败但已绑定 Plan、需求与反馈分别筛选、筛选数量、专用空状态以及从失败模式切回全部；验证失败筛选发生在 visibleItems 切片之前，加载更多使用筛选后总数；验证 WorkspacePage 的两个 IntakePanel 均自动获得筛选能力，现有工作区搜索、locateItemId、失败详情卡和 retryIntakePlanGeneration 的 CLI<path> 参数传递不回归。
- [x] P004: Final validation <!-- scope: validation -->
  - Acceptance: 运行 npm run build、npm run check、npm test 和 npm run smoke；手动在同一项目准备普通记录、未绑定 Plan 的生成失败记录及失败后已成功绑定 Plan 的记录，分别进入需求和反馈模块，确认数量正确、“计划生成失败”仅显示当前失败项、切换筛选与加载更多正常、搜索<path> Plan 后该记录立即从失败筛选结果中消失。
