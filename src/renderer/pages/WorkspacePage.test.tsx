export {};

type TestRegistrar = (name: string, fn: () => void) => void;

declare function require(id: string): unknown;
declare const process: { cwd(): string };

const { describe, it } = require('node:test') as { describe: TestRegistrar; it: TestRegistrar };
const { readFileSync } = require('node:fs') as { readFileSync: (path: string, encoding: string) => string };
const { join } = require('node:path') as { join: (...parts: string[]) => string };

function expect(condition: unknown, message: string) {
  if (!condition) throw new Error(message);
}

function source(...parts: string[]) {
  return readFileSync(join(process.cwd(), ...parts), 'utf8');
}

function expectIncludes(sourceText: string, snippet: string, message: string) {
  expect(sourceText.includes(snippet), message);
}

function expectAnyIncludes(sourceText: string, snippets: string[], message: string) {
  expect(snippets.some((snippet) => sourceText.includes(snippet)), message);
}

function expectCountAtLeast(sourceText: string, snippet: string, minimum: number, message: string) {
  const count = sourceText.split(snippet).length - 1;
  expect(count >= minimum, message);
}

describe('Workspace task page structure', () => {
  it('keeps the task page split into Plan and task columns', () => {
    const page = source('src', 'renderer', 'pages', 'WorkspacePage.tsx');

    expectIncludes(page, 'data-testid="workspace-task-main"', 'task main test anchor should exist');
    expectIncludes(page, 'className="task-status-grid"', 'task page should use the two-column grid container');
    expectIncludes(page, '<PlanList', 'task page should render the Plan column');
    expectIncludes(page, '<TaskList', 'task page should render the task column');
    expectIncludes(page, 'selectedPlanTaskFilter', 'task column should stay connected to Plan selection filtering');
  });

  it('renders Plan cards with progress, concurrency, metadata, and actions', () => {
    const planList = source('src', 'renderer', 'components', 'plans', 'PlanList.tsx');
    const wrappedPlanList = source('src', 'renderer', 'components', 'PlanLists.tsx');

    expectIncludes(planList, "className={`plan-card ${cardState}${selected ? ' selected' : ''}`}", 'Plan list should render visual cards with selected state');
    expectIncludes(planList, 'onSelectPlan?.(plan);', 'Plan card should support direct selection');
    expectIncludes(wrappedPlanList, 'onSelectPlan={selectPlan}', 'Plan card selection should drive workspace selection state');
    expectIncludes(planList, 'className="plan-progress"', 'Plan card should include progress block');
    expectIncludes(planList, 'className="concurrency-row"', 'Plan card should include concurrency summary');
    expectIncludes(planList, 'className="plan-meta"', 'Plan card should include CLI/hash/update metadata');
    expectIncludes(planList, "className={`plan-validation ${plan.validation_passed ? 'passed' : 'pending'}`}", 'Plan card should expose validation state');
    expectIncludes(planList, 'plan-parallel-link', 'Plan card should preserve parallel execution entry');
    expectIncludes(planList, 'plan-read-link', 'Plan card should preserve read-full-plan entry');
  });

  it('keeps task grouping, status filters, and scope semantic classes wired', () => {
    const planLists = source('src', 'renderer', 'components', 'PlanLists.tsx');
    const taskList = source('src', 'renderer', 'components', 'plans', 'TaskList.tsx');
    const planTasks = source('src', 'renderer', 'utils', 'planTasks.ts');

    expectIncludes(planLists, 'className="task-filter-tabs"', 'task status filters should remain available');
    expectIncludes(planLists, 'className="list compact task-groups"', 'task groups should use the compact group layout');
    expectIncludes(planLists, 'task-plan-group-toggle', 'task groups should have an expand/collapse trigger');
    expectIncludes(planLists, 'formatTaskPlanGroupProgress(group)', 'task groups should render progress only');
    expectIncludes(taskList, "className={`task-item${running ? ' running' : ''}`}", 'standalone task list should render task cards');
    expectIncludes(taskList, "className={`task-scope-chip scope-chip${semanticClass ? ` ${semanticClass}` : ''}`}", 'scope chips should receive semantic classes');
    expectIncludes(planTasks, 'scopeFileClassName', 'scope file semantic class helper should exist');
    expectIncludes(planTasks, "if (file.isUnknown) return 'unknown special';", 'unknown scope should have a distinct class');
    expectIncludes(planTasks, "if (file.isValidation) return 'validation';", 'validation scope should have a distinct class');
  });
});

describe('Workspace intake Plan preview binding', () => {
  it('wires requirement and feedback panels to the shared Plan reader flow', () => {
    const page = source('src', 'renderer', 'pages', 'WorkspacePage.tsx');
    const controller = source('src', 'renderer', 'hooks', 'useWorkspaceController.ts');

    expectIncludes(page, 'const intakePlanPreviewProps = {', 'intake panels should share preview props');
    expectIncludes(page, 'plans: snapshot.plans', 'intake preview props should carry current Plan snapshots');
    expectAnyIncludes(
      page,
      ['onOpenPlan: openIntakePlanReader', 'onPreviewPlan: openIntakePlanReader'],
      'intake preview props should use the controller Plan reader callback',
    );
    expectCountAtLeast(page, '{...intakePlanPreviewProps}', 2, 'requirement and feedback panels should both receive preview props');
    expectIncludes(page, '<PlanReaderModal', 'workspace should mount the reusable Plan reader modal once');
    expectIncludes(page, 'readerState={planReadState}', 'intake preview should reuse the workspace Plan reader state');

    expectIncludes(controller, 'const openIntakePlanReader = useCallback', 'controller should expose an intake Plan reader opener');
    expectIncludes(controller, 'findLinkedPlanInSnapshot(snapshot?.plans || [], planId, projectId)', 'intake preview should locate plans from the current snapshot first');
    expectIncludes(controller, 'showUnavailableLinkedPlanReader', 'controller should provide unavailable Plan fallback state');
    expectIncludes(controller, '绑定 Plan ID 无效，暂无法预览。', 'invalid linked Plan IDs should produce a readable error');
    expectIncludes(controller, '绑定 Plan #${planId} 当前不可用', 'missing linked Plan snapshots should produce a readable error');
  });

  it('renders bound intake Plan metadata, progress, preview affordance, and fallbacks', () => {
    const page = source('src', 'renderer', 'pages', 'WorkspacePage.tsx');
    const intakePanel = source('src', 'renderer', 'components', 'IntakePanel.tsx');
    const styles = source('src', 'renderer', 'styles', 'components.css');
    const pageUsesOpenPlan = page.includes('onOpenPlan: openIntakePlanReader');
    const pageUsesPreviewPlan = page.includes('onPreviewPlan: openIntakePlanReader');
    const intakeAcceptsOpenPlan = intakePanel.includes('onOpenPlan');
    const intakeAcceptsPreviewPlan = intakePanel.includes('onPreviewPlan');

    expectIncludes(intakePanel, 'function PlanBindingCard', 'intake panel should render a dedicated bound Plan card');
    expectIncludes(intakePanel, 'if (linkedPlanId === null) return null;', 'unbound intake items should not show Plan preview UI');
    expectIncludes(intakePanel, "readStringField(item, ['plan_title', 'linked_plan_title'])", 'bound cards should read Plan title snapshots');
    expectIncludes(intakePanel, "readStringField(item, ['plan_file_path', 'linked_plan_file_path', 'plan_path', 'linked_plan_path'])", 'bound cards should read Plan path snapshots');
    expectIncludes(intakePanel, 'Plan ID <b>#{linkedPlanId}</b>', 'bound cards should display Plan ID');
    expectIncludes(intakePanel, '任务进度 <b>{progressLabel}</b>', 'bound cards should display task progress text');
    expectIncludes(intakePanel, 'className="intake-plan-progress"', 'bound cards should display task progress bars');
    expectIncludes(intakePanel, 'disabled={!canPreview}', 'unavailable Plan previews should be disabled');
    expectIncludes(intakePanel, '绑定 Plan 快照缺失，暂不能预览全文。', 'missing Plan snapshots should show fallback copy');
    expect(
      (pageUsesOpenPlan && intakeAcceptsOpenPlan) || (pageUsesPreviewPlan && intakeAcceptsPreviewPlan),
      'WorkspacePage and IntakePanel should use the same intake preview callback prop name',
    );

    expectIncludes(styles, '.intake-plan-card', 'bound Plan card styles should be scoped to intake cards');
    expectIncludes(styles, '.intake-plan-name', 'long Plan titles should have dedicated text styling');
    expectIncludes(styles, '.intake-plan-path', 'long Plan paths should have dedicated truncation styling');
    expectIncludes(styles, '.intake-plan-side', 'preview actions should be able to wrap without squeezing intake actions');
  });
});

describe('Workspace settings page structure', () => {
  it('defines four settings panes with navigation metadata', () => {
    const settingsView = source('src', 'renderer', 'components', 'workspace', 'WorkspaceSettingsView.tsx');

    expectIncludes(settingsView, "type SettingsPane = 'loop' | 'cli' | 'scope' | 'mcp';", 'settings panes should match the four required groups');
    expectIncludes(settingsView, 'className="settings-nav"', 'settings view should render the left navigation');
    expectIncludes(settingsView, 'settings-nav-item', 'settings navigation should render selectable items');
    expectIncludes(settingsView, 'className="settings-content"', 'settings view should render independently scrolling content');
    expectIncludes(settingsView, 'className="settings-pane active"', 'settings view should render active pane content');
  });

  it('keeps CLI, scope, and MCP interactions represented in source', () => {
    const composer = source('src', 'renderer', 'components', 'Composer.tsx');
    const settingsView = source('src', 'renderer', 'components', 'workspace', 'WorkspaceSettingsView.tsx');

    expectIncludes(settingsView, 'agentCliOptionDetails.map', 'CLI provider should use segmented option data');
    expectIncludes(settingsView, 'codexReasoningOptionDetails.map', 'Codex reasoning should render option cards');
    expectIncludes(settingsView, 'isCodexAgentCliProvider(loopForm.agentCliProvider)', 'non-Codex providers should hide Codex-only effort controls');
    expectIncludes(settingsView, 'agentCliDefaultCommand(loopForm.agentCliProvider)', 'CLI command placeholder should follow the selected provider');
    expectIncludes(composer, "selectedProvider !== 'claude'", 'composer should treat Claude as non-Codex');
    expectIncludes(composer, 'agentCliProvider: selectedProvider as AgentCliProvider', 'composer submit payload should carry the selected CLI provider');
    expectIncludes(composer, '...(isCodexProvider ? { codexReasoningEffort:', 'composer should only submit Codex reasoning for Codex provider');
    expectIncludes(settingsView, 'scopeFileOpenModeOptions.map', 'scope mode should use segmented option data');
    expectIncludes(settingsView, "scopeFileOpenSettings.mode === 'vscode' || scopeFileOpenSettings.mode === 'command'", 'editor command should only expand for command-based modes');
    expectIncludes(settingsView, '<InfoRow label="服务状态">', 'MCP pane should expose service status as readonly info');
    expectIncludes(settingsView, 'value={mcpAuthToken}', 'MCP pane should expose editable auth token');
    expectIncludes(settingsView, '<InfoRow label="请求头">', 'MCP pane should show the standard auth header');
    expectIncludes(settingsView, '<InfoRow label="工具清单">', 'MCP pane should expose tool list as readonly info');
    expectIncludes(settingsView, 'AUTOPLAN_MCP_ENABLED=0', 'MCP pane should keep the disable reminder');
  });
});

describe('OpenCode CLI backend integration', () => {
  it('exposes OpenCode CLI across shared labels, settings form, and option data', () => {
    const shared = source('src', 'renderer', 'components', 'shared.tsx');
    const forms = source('src', 'renderer', 'utils', 'workspaceForms.ts');
    const settingsView = source('src', 'renderer', 'components', 'workspace', 'WorkspaceSettingsView.tsx');

    expectIncludes(shared, "if (value === 'opencode') return 'OpenCode';", 'shared label helper should resolve opencode to OpenCode');
    expectIncludes(forms, "{ value: 'opencode', label: 'OpenCode CLI' },", 'CLI option list should expose OpenCode CLI for the composer and settings');
    expectIncludes(forms, "if (normalized === 'opencode') return 'opencode';", 'default command resolver should return opencode for the OpenCode backend');
    expectIncludes(settingsView, "if (provider === 'opencode') return 'OpenCode';", 'settings view should display the OpenCode backend name');
    expectIncludes(settingsView, "loopForm.agentCliProvider === 'opencode'", 'settings view should branch the command hint on the OpenCode backend');
  });
});

describe('Oh My Pi CLI backend integration', () => {
  it('exposes Oh My Pi CLI across shared labels, settings form, and option data', () => {
    const shared = source('src', 'renderer', 'components', 'shared.tsx');
    const forms = source('src', 'renderer', 'utils', 'workspaceForms.ts');
    const settingsView = source('src', 'renderer', 'components', 'workspace', 'WorkspaceSettingsView.tsx');

    expectIncludes(shared, "if (value === 'oh-my-pi') return 'Oh My Pi';", 'shared label helper should resolve oh-my-pi to Oh My Pi');
    expectIncludes(forms, "{ value: 'oh-my-pi', label: 'Oh My Pi CLI' },", 'CLI option list should expose Oh My Pi CLI for the composer and settings');
    expectIncludes(forms, "if (normalized === 'oh-my-pi') return 'omp';", 'default command resolver should return omp for the Oh My Pi backend');
    expectIncludes(settingsView, "if (provider === 'oh-my-pi') return 'Oh My Pi';", 'settings view should display the Oh My Pi backend name');
    expectIncludes(settingsView, "loopForm.agentCliProvider === 'oh-my-pi'", 'settings view should branch the command hint on the Oh My Pi backend');
  });
});

describe('Workspace composer draft persistence', () => {
  it('makes the Composer a controlled input driven by the draft value', () => {
    const composer = source('src', 'renderer', 'components', 'Composer.tsx');

    expectIncludes(composer, 'value: string;', 'Composer should accept a controlled value prop');
    expectIncludes(composer, 'onValueChange: (next: string) => void;', 'Composer should accept a value change callback');
    expectIncludes(composer, 'value={value}', 'textarea value should be driven by the value prop');
    expectIncludes(composer, 'onValueChange(event.target.value)', 'textarea changes should forward to onValueChange');
    expect(
      !composer.includes("const [body, setBody] = useState('')"),
      'Composer body should no longer be backed by a local useState',
    );
  });

  it('persists composer drafts per project through isolated storage keys', () => {
    const forms = source('src', 'renderer', 'utils', 'workspaceForms.ts');
    const hook = source('src', 'renderer', 'hooks', 'useComposerDrafts.ts');

    expectIncludes(forms, 'composerDraftStorageKey', 'storage key resolver should exist for drafts');
    expectIncludes(forms, 'autoplan.composerDrafts.', 'draft storage key should use the project-scoped prefix');
    expectIncludes(hook, 'useComposerDrafts(projectId)', 'draft hook should be keyed by projectId');
    expectIncludes(hook, 'loadComposerDrafts(projectId)', 'drafts should load from storage keyed by projectId');
    expectIncludes(hook, '}, [projectId]);', 'drafts should reload when projectId changes');
    expectIncludes(hook, 'composerDraftStorageKey(projectId)', 'write key should be scoped by projectId');
    expectIncludes(hook, 'window.localStorage.setItem(storageKey', 'draft changes should persist back to localStorage');
  });

  it('binds requirement and feedback intake panels to separate drafts', () => {
    const page = source('src', 'renderer', 'pages', 'WorkspacePage.tsx');

    expectIncludes(page, 'draftValue={composerDrafts.requirement}', 'requirement panel should read its draft value');
    expectIncludes(page, "onDraftChange={(next) => updateComposerDraft('requirement', next)}", 'requirement panel should update its draft');
    expectIncludes(page, 'draftValue={composerDrafts.feedback}', 'feedback panel should read its draft value');
    expectIncludes(page, "onDraftChange={(next) => updateComposerDraft('feedback', next)}", 'feedback panel should update its draft');
    expectCountAtLeast(page, 'draftValue={composerDrafts.', 2, 'both intake panels should bind a draft value');
  });

  it('clears the composer after a successful submit through the draft chain', () => {
    const composer = source('src', 'renderer', 'components', 'Composer.tsx');
    const controller = source('src', 'renderer', 'hooks', 'useWorkspaceController.ts');

    expectIncludes(composer, "onValueChange('')", 'successful submit should clear the composer via onValueChange');
    expectIncludes(controller, 'useComposerDrafts(projectId)', 'controller should wire the draft hook into the project');
    expectIncludes(controller, 'composerDrafts', 'controller should expose composer drafts');
    expectIncludes(controller, 'updateComposerDraft', 'controller should expose the draft update callback');
  });
});

describe('Script editor name input discoverability', () => {
  it('guides users to fill the script name with guidance copy, new-state autofocus, and a stable style hook', () => {
    const modal = source('src', 'renderer', 'components', 'workspace', 'ScriptEditorModal.tsx');

    // 场景一：占位符已由中性的「未命名脚本」改为明确引导文案。
    expectIncludes(modal, 'placeholder="请输入脚本名称', '脚本名称输入框占位符应包含明确引导文案');
    expect(
      !modal.includes('placeholder="未命名脚本"'),
      '脚本名称输入框占位符不应再使用中性的「未命名脚本」',
    );

    // 场景二：新建态（draft.id == null）自动聚焦脚本名称输入框。
    expectIncludes(modal, 'const nameRef = useRef<HTMLInputElement>(null);', '脚本名称输入框应绑定 ref');
    expectIncludes(modal, 'const isNew = draft.id == null;', '应派生新建态标识（draft.id == null）');
    expectIncludes(modal, 'if (isNew) nameRef.current?.focus();', '新建态应自动聚焦脚本名称输入框');

    // 场景三：名称 input 仍带 mh-title-input 标识类，作为与样式联动的稳定钩子。
    expectIncludes(modal, 'ref={nameRef}', '聚焦目标应指向脚本名称输入框元素');
    expectIncludes(modal, 'className="mh-title-input"', '脚本名称输入框应保留 mh-title-input 标识类');
  });
});

// 反馈 #27 回归测试：覆盖计划倒序、预览 Plan 接线、事件增量加载、文件夹路径链接、脚本导航稳定性五项改动。
describe('Feedback #27 source-level regression', () => {
  it('sorts the plan list by created_at descending in comparePlanOrder (newest first)', () => {
    const planLists = source('src', 'renderer', 'components', 'PlanLists.tsx');

    // 场景一：计划倒序——comparePlanOrder 主键为 created_at 倒序（最新在前），id 倒序兜底保证稳定。
    expectIncludes(
      planLists,
      "String(right.created_at || '').localeCompare(String(left.created_at || ''))",
      'comparePlanOrder 主排序键应为 created_at 倒序（最新在前）',
    );
    expectIncludes(planLists, 'Number(right.id || 0) - Number(left.id || 0)', 'comparePlanOrder 应以 id 倒序兜底，保证相同 created_at 时排序稳定');
    // 不再以 sort_order 升序作为 comparePlanOrder 主键：截取该函数体确认不含 sort_order 比较。
    const comparePlanOrderBody = planLists.slice(
      planLists.indexOf('function comparePlanOrder('),
      planLists.indexOf('function planStatusCounts('),
    );
    expect(comparePlanOrderBody.length > 0, '应能定位到 comparePlanOrder 函数体');
    expect(!comparePlanOrderBody.includes('sort_order'), 'comparePlanOrder 不应以 sort_order 升序作为主键');
  });

  it('wires intake Plan preview through the onPreviewPlan prop with an aligned call signature', () => {
    const page = source('src', 'renderer', 'pages', 'WorkspacePage.tsx');
    const intakePanel = source('src', 'renderer', 'components', 'IntakePanel.tsx');
    const controller = source('src', 'renderer', 'hooks', 'useWorkspaceController.ts');

    // 场景二：预览接线——intakePlanPreviewProps 使用 onPreviewPlan（与 IntakePanel/PlanBindingCard 读取的 prop 名一致）。
    expectIncludes(page, 'const intakePlanPreviewProps = {', 'intake 面板应共享预览 props');
    expectIncludes(page, 'onPreviewPlan: openIntakePlanReader', 'intakePlanPreviewProps 应使用 onPreviewPlan，与 IntakePanel 一致');
    expectIncludes(intakePanel, 'onPreviewPlan?: PlanPreviewHandler;', 'IntakePanel 应声明 onPreviewPlan 回调 prop');
    expectIncludes(intakePanel, '<PlanBindingCard item={item}', 'IntakePanel 应将预览回调透传给 PlanBindingCard');
    expectIncludes(intakePanel, 'onPreviewPlan={onPreviewPlan}', 'PlanBindingCard 应接收 onPreviewPlan');
    expectIncludes(intakePanel, 'onPreviewPlan?.(item)', '点击「预览 Plan」应以 intake item 触发，调用签名与 openIntakePlanReader 对齐');
    expectIncludes(controller, '(item: LinkedPlanIntakeItem, fallbackPlan?', 'openIntakePlanReader 应以 intake item 为首参，对齐预览调用签名');
  });

  it('renders the event list with incremental batches and a load-more control', () => {
    const planLists = source('src', 'renderer', 'components', 'PlanLists.tsx');

    // 场景三：事件增量——EventList 默认仅渲染最近一批，并提供「加载更多」分批展开更早事件。
    expectIncludes(planLists, 'const EVENT_BATCH_SIZE = 30;', 'EventList 应定义初始批次上限常量');
    expectIncludes(planLists, 'const [visibleCount, setVisibleCount] = useState(EVENT_BATCH_SIZE);', 'EventList 应以批次常量初始化可见计数状态');
    expectIncludes(planLists, 'event-list-more', 'EventList 应渲染「加载更多」按钮钩子类');
    expectIncludes(planLists, '加载更多', 'EventList 应展示「加载更多」入口文案');
    expectIncludes(planLists, 'setVisibleCount((current) => current + EVENT_BATCH_SIZE)', '点击「加载更多」应分批增加可见计数');
  });

  it('styles the workspace folder path as a link while keeping the open-folder behavior', () => {
    const sidebar = source('src', 'renderer', 'components', 'workspace', 'WorkspaceSidebar.tsx');
    const css = source('src', 'renderer', 'styles', 'workspace.css');

    // 场景四：路径链接——工作区路径控件带链接样式钩子，点击仍走 openProjectFolder 打开系统文件夹。
    expectIncludes(sidebar, 'project-path project-path-link', '工作区路径控件应带链接样式钩子类');
    expectIncludes(sidebar, 'window.autoplan.openProjectFolder({ projectId })', '路径控件仍应绑定打开系统文件夹的行为');
    expectIncludes(css, '.project-path-link', '样式表应定义路径链接样式');
    expectIncludes(css, 'color: var(--brand-600)', '路径链接应使用主题色文字');
    expectIncludes(css, 'cursor: pointer', '路径链接应为指针光标');
  });

  it('keeps script navigation stable so the just-selected tab is not reset to the default', () => {
    const controller = source('src', 'renderer', 'hooks', 'useWorkspaceController.ts');

    // 反馈 #27 第四项：URL→activeTab 同步副作用保留用户刚选标签，避免点击「脚本」被坍缩回默认 requirement。
    expectIncludes(
      controller,
      'setActiveTab((current) => (current === tabParam ? current : resolveWorkspaceTab(tabParam)))',
      'URL→activeTab 同步应保留用户刚选标签，仅在两者不一致时回填，避免点击「脚本」被回退为 requirement',
    );
  });
});

// 反馈 #31 回归测试：任务列表「分组之间」排序改为纯时间倒序（移除 hasRunningTask 运行中置顶优先键），
// 分组内任务排序保持时间倒序，计划列表倒序不变；运行中分组仍可默认展开（hasRunningTask 字段与排序解耦）。
describe('Feedback #31 task group sort regression', () => {
  it('sorts task plan groups purely by latest activity time descending without a running-on-top override', () => {
    const planTasks = source('src', 'renderer', 'utils', 'planTasks.ts');

    // 截取 groupTasksByPlan 函数体（自 `export function groupTasksByPlan(` 起到下一个 `export function` 止）。
    const groupTasksByPlanBody = planTasks.slice(
      planTasks.indexOf('export function groupTasksByPlan('),
      planTasks.indexOf('export function tasksForPlan('),
    );
    expect(groupTasksByPlanBody.length > 0, '应能定位到 groupTasksByPlan 函数体');

    // 场景一：分组之间排序不再以 hasRunningTask 为优先键——较早创建但「运行中」的分组不再强制置顶，顺序由纯时间倒序决定。
    expect(
      !groupTasksByPlanBody.includes('left.hasRunningTask !== right.hasRunningTask'),
      '任务分组排序不应再以 hasRunningTask 为优先键（运行中置顶已移除）',
    );

    // 场景二：分组之间排序以 sortTime（latestTaskTime，分组内最新活动时间）倒序为主键，firstIndex 兜底保证稳定。
    expectIncludes(
      groupTasksByPlanBody,
      'right.sortTime - left.sortTime',
      '任务分组排序应以 sortTime 倒序（最新活动在前）为主键',
    );

    // 场景三：分组内任务排序仍以 taskSortTime（finished_at ?? started_at ?? updated_at）倒序为主键。
    expectIncludes(
      groupTasksByPlanBody,
      'rightTime - leftTime',
      '分组内任务排序仍应以 taskSortTime 倒序为主键',
    );

    // 场景四：hasRunningTask 字段本身保留——仅供 getDefaultExpandedTaskGroupKeys 默认展开运行中分组，与排序解耦。
    expectIncludes(
      groupTasksByPlanBody,
      'hasRunningTask: sortedTasks.some(',
      'hasRunningTask 字段应保留，仅用于默认展开运行中分组，不再影响排序',
    );
  });

  it('keeps the plan list sorted by created_at descending after the task-side sort change', () => {
    // 复述「计划侧」既有断言：本次改动仅调整任务分组排序，计划列表 comparePlanOrder 仍以 created_at 倒序、不以 sort_order 升序为主键。
    const planLists = source('src', 'renderer', 'components', 'PlanLists.tsx');
    expectIncludes(
      planLists,
      "String(right.created_at || '').localeCompare(String(left.created_at || ''))",
      'comparePlanOrder 主排序键应仍为 created_at 倒序（最新在前），未被任务侧改动破坏',
    );
    const comparePlanOrderBody = planLists.slice(
      planLists.indexOf('function comparePlanOrder('),
      planLists.indexOf('function planStatusCounts('),
    );
    expect(comparePlanOrderBody.length > 0, '应能定位到 comparePlanOrder 函数体');
    expect(!comparePlanOrderBody.includes('sort_order'), 'comparePlanOrder 不应仍以 sort_order 升序作为主键');
  });
});
