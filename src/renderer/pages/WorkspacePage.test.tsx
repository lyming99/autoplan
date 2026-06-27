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
    expectIncludes(planTasks, 'if (left.hasRunningTask !== right.hasRunningTask)', 'running task groups should sort first');
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
    const settingsView = source('src', 'renderer', 'components', 'workspace', 'WorkspaceSettingsView.tsx');

    expectIncludes(settingsView, 'agentCliOptionDetails.map', 'CLI provider should use segmented option data');
    expectIncludes(settingsView, 'codexReasoningOptionDetails.map', 'Codex reasoning should render option cards');
    expectIncludes(settingsView, "loopForm.agentCliProvider === 'claude'", 'Claude should hide Codex-only effort controls');
    expectIncludes(settingsView, 'scopeFileOpenModeOptions.map', 'scope mode should use segmented option data');
    expectIncludes(settingsView, "scopeFileOpenSettings.mode === 'vscode' || scopeFileOpenSettings.mode === 'command'", 'editor command should only expand for command-based modes');
    expectIncludes(settingsView, '<InfoRow label="服务状态">', 'MCP pane should expose service status as readonly info');
    expectIncludes(settingsView, 'value={mcpAuthToken}', 'MCP pane should expose editable auth token');
    expectIncludes(settingsView, '<InfoRow label="请求头">', 'MCP pane should show the standard auth header');
    expectIncludes(settingsView, '<InfoRow label="工具清单">', 'MCP pane should expose tool list as readonly info');
    expectIncludes(settingsView, 'AUTOPLAN_MCP_ENABLED=0', 'MCP pane should keep the disable reminder');
  });
});
