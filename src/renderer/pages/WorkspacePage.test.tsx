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

function expectCountExactly(sourceText: string, snippet: string, expected: number, message: string) {
  const count = sourceText.split(snippet).length - 1;
  expect(count === expected, `${message} (expected ${expected}, got ${count})`);
}

function cssRuleBody(sourceText: string, selector: string) {
  const selectorStart = sourceText.indexOf(`${selector} {`);
  expect(selectorStart >= 0, `应能定位到 ${selector} CSS 规则`);
  const blockStart = sourceText.indexOf('{', selectorStart);
  expect(blockStart >= 0, `应能定位到 ${selector} CSS 规则起始花括号`);

  let depth = 0;
  for (let index = blockStart; index < sourceText.length; index += 1) {
    const char = sourceText[index];
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return sourceText.slice(blockStart + 1, index);
    }
  }

  throw new Error(`未能解析 ${selector} CSS 规则体`);
}

describe('Theme provider build chain regression', () => {
  it('keeps the JSX ThemeProvider in a TSX module imported by the renderer entry', () => {
    const themeProvider = source('src', 'renderer', 'hooks', 'useTheme.tsx');
    const main = source('src', 'renderer', 'main.tsx');

    expectIncludes(themeProvider, 'export function ThemeProvider', 'ThemeProvider should remain exported from the TSX hook module');
    expectIncludes(themeProvider, '<ThemeContext.Provider value={value}>', 'ThemeProvider should keep its JSX provider wrapper in a TSX file');
    expectIncludes(themeProvider, 'export function useTheme()', 'useTheme hook API should remain exported with the provider');
    expectIncludes(main, "import { ThemeProvider } from './hooks/useTheme';", 'renderer entry should resolve ThemeProvider through the extensionless TSX import');
    expect(!main.includes("from './hooks/useTheme.ts'"), 'renderer entry should not import the removed .ts hook module explicitly');
  });
});

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

  it('routes draft execution through the parent snapshot refresh action', () => {
    const page = source('src', 'renderer', 'pages', 'WorkspacePage.tsx');
    const wrappedPlanList = source('src', 'renderer', 'components', 'PlanLists.tsx');

    expectIncludes(wrappedPlanList, 'onRunDraft?: (plan: Plan, task: PlanTask) => Promise<void> | void;', 'Plan list should accept a parent draft-run callback');
    expectIncludes(wrappedPlanList, 'await onRunDraft(plan, task);', 'draft single-task execution should delegate to the parent callback');
    expect(!wrappedPlanList.includes('window.autoplan.runTask'), 'Plan list should not call tasks:run directly and drop the returned snapshot');
    expectIncludes(page, 'onRunDraft={(plan, task) =>', 'WorkspacePage should wire the draft-run callback');
    expectIncludes(page, 'runLoopAction(() => window.autoplan.runTask', 'draft execution should reuse runLoopAction');
    expectIncludes(page, 'taskId: task.id', 'draft execution should target the selected pending task');
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

describe('Workspace intake cascade delete wiring', () => {
  it('keeps the delete confirmation explicit about linked plans, tasks, and running executions', () => {
    const intakePanel = source('src', 'renderer', 'components', 'IntakePanel.tsx');

    expectIncludes(intakePanel, 'const linkedPlanId = linkedPlanIdOf(item);', 'delete confirmation should inspect the linked Plan ID');
    expectIncludes(intakePanel, 'const cascadeWarning = linkedPlanId === null', 'delete confirmation should branch on linked Plan presence');
    expectIncludes(
      intakePanel,
      '关联 Plan #${linkedPlanId}、全部任务和运行中执行会一并停止并删除。',
      'linked intake delete confirmation should warn that Plan, tasks, and running executions are stopped and deleted',
    );
    expectIncludes(intakePanel, 'const ok = await onDelete(item.id);', 'delete flow should wait for backend deletion result');
    expectIncludes(intakePanel, 'if (ok && editingId === item.id) setEditingId(null);', 'delete flow should only clear local edit state after success');
  });

  it('clears the Plan reader only after a successful delete snapshot removes the current Plan', () => {
    const controller = source('src', 'renderer', 'hooks', 'useWorkspaceController.ts');

    expectIncludes(controller, 'const resetPlanReaderState = useCallback', 'controller should centralize Plan reader reset');
    expectIncludes(controller, 'const clearDeletedPlanReader = useCallback((next: AppSnapshot) => {', 'controller should compare the returned snapshot before clearing');
    expectIncludes(controller, 'const stillExists = next.plans.some(', 'reader cleanup should check whether the current Plan still exists');
    expectIncludes(controller, 'if (!stillExists) resetPlanReaderState();', 'reader cleanup should close/reset deleted Plan reads');
    expectCountAtLeast(controller, 'clearDeletedPlanReader(next);', 2, 'requirement and feedback delete success paths should both clear deleted readers');
    expectIncludes(
      controller,
      '[clearDeletedPlanReader, projectId, setSnapshot, setError, showError]',
      'delete callbacks should include reader cleanup in their dependency arrays',
    );
    expectIncludes(controller, 'catch (e) {\n        showError(e);\n        return false;', 'delete failures should keep current UI state and surface backend errors');
  });

  it('keeps delete IPC handlers and renderer API declarations aligned with snapshot-returning cascade deletes', () => {
    const main = source('src', 'main.js');
    const types = source('src', 'renderer', 'types.ts');

    expectIncludes(main, "ipcMain.handle('requirements:delete'", 'main process should expose requirement deletion IPC');
    expectIncludes(main, "return loop.deleteIntake(projectId, 'requirement', id, { attachmentsRoot: attachmentsRoot() });", 'requirement deletion IPC should use the unified cascade service');
    expectIncludes(main, "ipcMain.handle('feedback:delete'", 'main process should expose feedback deletion IPC');
    expectIncludes(main, "return loop.deleteIntake(projectId, 'feedback', id, { attachmentsRoot: attachmentsRoot() });", 'feedback deletion IPC should use the unified cascade service');
    expectIncludes(types, 'deleteRequirement: (input: RecordIdInput) => Promise<AppSnapshot>;', 'renderer API should type requirement deletion as snapshot-returning');
    expectIncludes(types, 'deleteFeedback: (input: RecordIdInput) => Promise<AppSnapshot>;', 'renderer API should type feedback deletion as snapshot-returning');
  });
});

describe('Workspace settings page structure', () => {
  it('defines settings panes with navigation metadata', () => {
    const settingsView = source('src', 'renderer', 'components', 'workspace', 'WorkspaceSettingsView.tsx');

    expectIncludes(settingsView, "type SettingsPane = 'loop' | 'cli' | 'appearance' | 'scope' | 'mcp' | 'ai' | 'env' | 'about';", 'settings panes should include the current settings groups');
    expectIncludes(settingsView, 'className="settings-nav"', 'settings view should render the left navigation');
    expectIncludes(settingsView, 'settings-nav-item', 'settings navigation should render selectable items');
    expectIncludes(settingsView, 'className="settings-content"', 'settings view should render independently scrolling content');
    expectIncludes(settingsView, 'className="settings-pane active"', 'settings view should render active pane content');
  });

  it('keeps CLI, scope, and MCP interactions represented in source', () => {
    const composer = source('src', 'renderer', 'components', 'Composer.tsx');
    const settingsView = source('src', 'renderer', 'components', 'workspace', 'WorkspaceSettingsView.tsx');
    const mcpPanel = source('src', 'renderer', 'components', 'workspace', 'McpControlPanel.tsx');
    const snapshots = source('src', 'loop', 'snapshots.js');

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
    expectIncludes(mcpPanel, 'const connectionAddress = mcp?.url || mcp?.connectionExample', 'MCP pane should prefer the live URL over configured defaults');
    expectIncludes(mcpPanel, '<InfoRow label="连接地址"><span className="mono">{connectionAddress}</span></InfoRow>', 'MCP pane should render the resolved connection address');
    expectIncludes(snapshots, '默认端口 ${configuredPort} 被占用，已自动使用可用端口 ${port}。', 'MCP snapshot should describe fallback port usage as a non-error note');
    expectIncludes(snapshots, 'eventMcp && latestEvent?.type === \'mcp.started\' ? eventMcp.url : null', 'MCP snapshot should recover the real URL from started event metadata');
  });
});

describe('Workspace AI config creation regression', () => {
  it('surfaces save failures in the AI settings panel and refreshes the list after successful creation', () => {
    const settingsView = source('src', 'renderer', 'components', 'workspace', 'WorkspaceSettingsView.tsx');

    expectIncludes(settingsView, 'const [aiConfigError, setAiConfigError] = useState<string | null>(null);', 'AI config form should keep a visible error state');
    expectIncludes(settingsView, '<div className="ai-config-error" role="alert">', 'AI config save errors should render inside the settings panel');
    expectIncludes(settingsView, "setAiConfigError(getErrorMessage(error, 'AI 配置保存失败'));", 'AI config save failures should preserve and display Error.message');
    expectIncludes(settingsView, 'await window.autoplan.aiConfigCreate(payload);', 'new AI configs should call the create IPC bridge');
    expectIncludes(settingsView, 'cancelEditAiConfig();\n      await loadAiConfigs();', 'successful saves should close the form and refresh the config list');
    expectIncludes(settingsView, "setAiConfigError('配置名称不能为空');", 'empty AI config names should fail with a readable inline message');
  });

  it('keeps provider-specific draft fields and empty edit API keys out of dirty payloads', () => {
    const settingsView = source('src', 'renderer', 'components', 'workspace', 'WorkspaceSettingsView.tsx');
    const forms = source('src', 'renderer', 'utils', 'workspaceForms.ts');
    const aiConfigInputBody = forms.slice(
      forms.indexOf('export function aiConfigInputFromForm'),
      forms.indexOf('function shouldUseProviderDefault'),
    );

    expectIncludes(settingsView, 'aiConfigFormForProviderChange(current, option.value)', 'provider switching should use the shared field cleanup helper');
    expectIncludes(settingsView, 'const list = await window.autoplan.aiConfigList();', 'AI config list should load global configs without a projectId payload');
    expectIncludes(settingsView, 'const payload = aiConfigInputFromForm(name, aiConfigForm, { preserveEmptyApiKey });', 'AI config saves should serialize through the shared global payload helper');
    expectIncludes(settingsView, '...(payload.apiKey !== undefined ? { apiKey: payload.apiKey } : {})', 'editing with an empty API key should omit apiKey and keep the saved secret');
    expectIncludes(settingsView, 'await window.autoplan.aiConfigDelete({ configId: id });', 'AI config delete should only require the global config id');
    expect(aiConfigInputBody.length > 0, 'should locate aiConfigInputFromForm');
    expect(!aiConfigInputBody.includes('projectId'), 'aiConfigInputFromForm should not include a projectId in global AI config payloads');
    expectIncludes(forms, 'thinkingDepth: providerSupportsThinkingDepth(provider) ? form.thinkingDepth : \'\',', 'provider switching should clear unsupported thinking depth values');
    expectIncludes(forms, 'thinkingBudgetTokens: providerSupportsThinkingBudget(provider) ? form.thinkingBudgetTokens : \'\',', 'provider switching should clear unsupported Anthropic token budgets');
    expectIncludes(forms, 'if (!options.preserveEmptyApiKey || apiKey) {\n    payload.apiKey = apiKey;\n  }', 'create mode should save empty API keys while edit mode omits untouched blanks');
  });
});

describe('Workspace chat AI config state regression', () => {
  it('creates chat state once in the workspace and passes it to sidebar and chat view', () => {
    const page = source('src', 'renderer', 'pages', 'WorkspacePage.tsx');

    expectIncludes(page, 'const chatState = useChat(projectId);', 'WorkspacePage should own the shared chat state');
    expect(page.split('useChat(projectId)').length - 1 === 1, 'WorkspacePage should create chat state exactly once');
    expectCountAtLeast(page, 'chatState={chatState}', 2, 'WorkspacePage should pass chat state into sidebar and ChatView render paths');
    expectIncludes(page, '<ChatView chatState={chatState} />', 'ChatView should consume the shared workspace chat state');
    expectIncludes(page, 'type WorkspaceSidebarWithChatProps = ComponentProps<typeof WorkspaceSidebar> & {', 'WorkspaceSidebar should be typed to receive chat state');
  });

  it('derives useChat config availability from global aiConfigList and config change events', () => {
    const hook = source('src', 'renderer', 'hooks', 'useChat.ts');

    expectIncludes(hook, 'window.autoplan.aiConfigList().catch(() => [] as AiConfig[])', 'useChat should load global AI configs without a projectId payload');
    expectIncludes(
      hook,
      'resolveCurrentAiConfig(aiConfigs, conversations, activeConversationId)',
      'useChat should derive current config from conversations and global AI configs',
    );
    expectIncludes(hook, 'configs.find((c) => c.hasApiKey) ?? configs[0] ?? null', 'global configs with API keys should be preferred');
    expectIncludes(hook, 'return window.autoplan.onAiConfigChanged((event) => {', 'useChat should subscribe to global AI config change events');
    expectIncludes(hook, 'void refreshAiConfigState(Array.isArray(event.configs) ? event.configs : undefined);', 'AI config changes should refresh chat config state');
    expect(!hook.includes('aiConfigList({ projectId })'), 'useChat should not request project-scoped AI configs');
    expect(!hook.includes('.chatGetConfig('), 'useChat should not read legacy chatGetConfig as chat availability state');
  });

  it('keeps chat and conversation IPC payloads project-scoped while AI config calls stay global', () => {
    const hook = source('src', 'renderer', 'hooks', 'useChat.ts');
    const sidebar = source('src', 'renderer', 'components', 'workspace', 'WorkspaceSidebar.tsx');

    expectIncludes(hook, 'window.autoplan.conversationList({ projectId })', 'conversation list should load by project');
    expectIncludes(hook, 'window.autoplan.aiConfigList().catch(() => [] as AiConfig[])', 'conversation load should read global AI configs without projectId');
    expectIncludes(hook, 'const history = await window.autoplan.chatHistory({ projectId: loadingProjectId, conversationId: cid });', 'history load should include the active projectId');
    expectIncludes(hook, '.chatHistory({ projectId: historyProjectId, conversationId: cid })', 'chat:done history refresh should retain the originating projectId');
    expectIncludes(hook, 'await window.autoplan.chatSend({\n          projectId,\n          conversationId: cid,', 'chat send should include projectId and conversationId');
    expectIncludes(hook, 'await window.autoplan.chatStop({ projectId: pid, conversationId: cid });', 'manual stop should include projectId');
    expectIncludes(hook, 'await window.autoplan.chatClear({ projectId: pid, conversationId: cid });', 'clear should include projectId');
    expectIncludes(hook, 'await window.autoplan.conversationDelete({ projectId, conversationId: cid });', 'delete should include projectId');
    expectIncludes(hook, 'await window.autoplan.conversationUpdate({ projectId, conversationId: cid, title });', 'rename should include projectId');
    expectIncludes(hook, 'const updated = await window.autoplan.conversationUpdate({\n      projectId,\n      conversationId: cid,\n      aiConfigId: configId,', 'AI config binding should update the project-scoped conversation');
    expectIncludes(sidebar, 'await window.autoplan.conversationUpdate({\n        projectId,\n        conversationId: conversation.id,\n        pinned: nextPinned,', 'sidebar pinning should update the project-scoped conversation');
    expectIncludes(sidebar, 'readConversationProjectId(conversation) === projectId', 'sidebar should filter conversation rows by current project');
    expect(!hook.includes('aiConfigList({ projectId'), 'useChat should not pass projectId to global AI config list');
  });

  it('moves conversation navigation into WorkspaceSidebar and keeps it wired for actions', () => {
    const chatView = source('src', 'renderer', 'components', 'workspace', 'ChatView.tsx');
    const sidebar = source('src', 'renderer', 'components', 'workspace', 'WorkspaceSidebar.tsx');
    const hook = source('src', 'renderer', 'hooks', 'useChat.ts');
    const chatViewBody = chatView.slice(
      chatView.indexOf('export function ChatView'),
      chatView.indexOf('export default ChatView'),
    );

    expect(!chatViewBody.includes('<ConversationSidebar'), 'ChatView should not render the old secondary ConversationSidebar');
    expect(!chatViewBody.includes('chat-sidebar'), 'ChatView should not keep old chat-sidebar class hooks');
    expect(!chatViewBody.includes('chat-input-bar'), 'ChatView should not keep the old input bar class hook');
    expectIncludes(sidebar, 'className="nav-chat-block"', 'WorkspaceSidebar should own the nested chat navigation block');
    expectIncludes(sidebar, 'className="nav-subgroup" aria-label="对话列表"', 'WorkspaceSidebar should render the conversation subgroup');
    expectIncludes(sidebar, 'className={`nav-sub-item ${isActive ? \'active\' : \'\'}`}', 'conversation rows should keep selected-state styling');
    expectIncludes(sidebar, 'className="nav-add-btn"', 'WorkspaceSidebar should keep a new-conversation button');
    expectIncludes(sidebar, 'createConversation();', 'new-conversation button should call the sidebar action');
    expectIncludes(sidebar, 'createConversation({ activate: false });', 'sidebar new-conversation action should create list data without activating the chat view');
    expectIncludes(sidebar, 'void chatState?.switchConversation(conversationId);', 'conversation rows should switch the active conversation');
    expectIncludes(hook, 'export type CreateConversationOptions = {', 'useChat should expose explicit create-conversation activation options');
    expectIncludes(hook, 'if (options.activate !== false) {\n        resetActiveConversation(conv.id);\n      }', 'useChat should only activate newly created conversations when callers do not opt out');
    expectIncludes(sidebar, 'await chatState?.renameConversation(conversation.id, title);', 'conversation rows should support rename');
    expectIncludes(sidebar, 'void chatState?.deleteConversation(conversation.id);', 'conversation rows should support delete');
    expectIncludes(sidebar, 'window.autoplan.conversationUpdate({', 'pinning should use the conversation update API');
    expectIncludes(sidebar, 'pinned: nextPinned,', 'pinning should pass the next pinned state');
  });

  it('syncs auto-generated chat titles from chat:done without refreshing the wrong conversation', () => {
    const types = source('src', 'renderer', 'types.ts');
    const hook = source('src', 'renderer', 'hooks', 'useChat.ts');
    const sidebar = source('src', 'renderer', 'components', 'workspace', 'WorkspaceSidebar.tsx');

    expectIncludes(
      types,
      'export interface ChatDoneEvent {\n  status: ChatDoneStatus;\n  error?: string;\n  conversationId?: number;\n  title?: string;\n}',
      'ChatDoneEvent should expose optional conversationId/title fields while keeping status/error',
    );
    expectIncludes(hook, 'function normalizeDoneConversationId(value: unknown): number | null', 'useChat should normalize the done event conversation ID');
    expectIncludes(hook, 'function shouldApplyAutoTitle(currentTitle: string | null | undefined): boolean', 'useChat should only allow placeholder titles to be replaced');
    expectIncludes(hook, 'const syncDoneConversationTitle = useCallback((conversationId: number | null, title: string | null | undefined) => {', 'useChat should centralize done-title state sync');
    expectIncludes(hook, 'syncDoneConversationTitle(doneConversationId ?? cid, event.title);', 'chat:done should sync the generated title from the event payload');
    expectIncludes(hook, 'if (doneConversationId !== null && doneConversationId !== cid) {\n        return;\n      }', 'chat:done from another conversation should not refresh the active message history');
    expectIncludes(hook, '.chatHistory({ projectId: historyProjectId, conversationId: cid })', 'matching chat:done events should still refresh the active project history');
    expectIncludes(sidebar, 'mergeSidebarConversations(current, chatState?.conversations ?? [])', 'sidebar should merge chatState conversation updates into the visible list');
    expectIncludes(sidebar, '<span className="nav-sub-item__title">{conversation.title || \'新对话\'}</span>', 'sidebar should render the updated conversation title without a page reload');
  });

  it('keeps the chat group header as a pure collapse control', () => {
    const sidebar = source('src', 'renderer', 'components', 'workspace', 'WorkspaceSidebar.tsx');
    const headerStart = sidebar.indexOf('className={`nav-item nav-item--chat nav-item--collapsible');
    const headerEnd = sidebar.indexOf('aria-expanded={chatExpanded}', headerStart);
    const headerButton = sidebar.slice(headerStart, headerEnd);

    expect(headerStart >= 0 && headerEnd > headerStart, 'should locate the chat group header button block');
    expectIncludes(headerButton, 'onClick={() => setChatExpanded((value) => !value)}', 'chat group header should only toggle chatExpanded');
    expect(!headerButton.includes("activeTab === tab.id"), 'chat group header should not derive active styling from the current tab');
    expect(!headerButton.includes("? 'active' : ''"), 'chat group header should not append the nav active class');
    expect(!headerButton.includes('onTab(tab.id)'), 'chat group header should not route through the generic tab handler');
    expect(!headerButton.includes("onTab('chat')"), 'chat group header should not open the chat tab directly');
    expectIncludes(sidebar, 'aria-expanded={chatExpanded}', 'chat group header should keep aria-expanded bound to chatExpanded');
    expectIncludes(sidebar, '${chatExpanded ? \'expanded\' : \'\'}', 'chat group header should expose expanded state through the existing class hook');
  });

  it('scopes conversation row active state and aria-current to the chat tab', () => {
    const sidebar = source('src', 'renderer', 'components', 'workspace', 'WorkspaceSidebar.tsx');
    const rowStart = sidebar.indexOf('visibleChatConversations.map((conversation) => {');
    const isActiveStart = sidebar.indexOf('const isActive =', rowStart);
    const isActiveEnd = sidebar.indexOf('const pinned =', isActiveStart);
    const isActiveDeclaration = sidebar.slice(isActiveStart, isActiveEnd);
    const ariaCurrentStart = sidebar.indexOf('aria-current=', isActiveStart);
    const ariaCurrentEnd = sidebar.indexOf('title={metaText}', ariaCurrentStart);
    const ariaCurrentBinding = sidebar.slice(ariaCurrentStart, ariaCurrentEnd);

    expect(rowStart >= 0 && isActiveStart > rowStart && isActiveEnd > isActiveStart, 'should locate the conversation row active-state declaration');
    expectIncludes(
      isActiveDeclaration,
      "const isActive = activeTab === 'chat' && conversation.id === chatState?.activeConversationId;",
      'conversation rows should only be active when ChatView is open and the conversation matches',
    );
    expect(!isActiveDeclaration.includes('const isActive = conversation.id === chatState?.activeConversationId;'), 'conversation rows should not stay active on non-chat tabs');
    expectIncludes(sidebar, 'className={`nav-sub-item ${isActive ? \'active\' : \'\'}`}', 'conversation row visual highlighting should use isActive');
    expect(ariaCurrentStart > isActiveStart && ariaCurrentEnd > ariaCurrentStart, 'should locate the conversation row aria-current binding');
    expectIncludes(ariaCurrentBinding, "aria-current={isActive ? 'page' : undefined}", 'aria-current should use the same isActive condition as visual highlighting');
  });

  it('keeps only the concrete conversation item responsible for opening ChatView', () => {
    const sidebar = source('src', 'renderer', 'components', 'workspace', 'WorkspaceSidebar.tsx');
    const selectStart = sidebar.indexOf('const selectConversation = useCallback(');
    const selectEnd = sidebar.indexOf('const createConversation = useCallback', selectStart);
    const selectConversationBody = sidebar.slice(selectStart, selectEnd);
    const createStart = sidebar.indexOf('const createConversation = useCallback');
    const createEnd = sidebar.indexOf('const deleteConversation = useCallback', createStart);
    const createConversationBody = sidebar.slice(createStart, createEnd);

    expect(selectStart >= 0 && selectEnd > selectStart, 'should locate selectConversation');
    expectIncludes(selectConversationBody, 'setOpenMenuId(null);', 'selectConversation should close any open menu before navigating');
    expectIncludes(selectConversationBody, "onTab('chat');", 'selectConversation should remain the sidebar route into ChatView');
    expectIncludes(selectConversationBody, 'void chatState?.switchConversation(conversationId);', 'selectConversation should load the requested conversation');
    expectCountExactly(sidebar, "onTab('chat')", 1, 'only selectConversation should call onTab(chat) in the sidebar');
    expectCountExactly(sidebar, 'selectConversation(conversation.id)', 1, 'only the concrete conversation main button should call selectConversation');
    expectIncludes(sidebar, 'className="nav-sub-item__main"\n                                    onClick={() => selectConversation(conversation.id)}', 'conversation main button should be the concrete opening entry');

    expect(createStart >= 0 && createEnd > createStart, 'should locate createConversation');
    expectIncludes(createConversationBody, 'createConversation({ activate: false });', 'sidebar new-conversation action should opt out of activating the new conversation');
    expect(!createConversationBody.includes("onTab('chat')"), 'sidebar new-conversation action should not open ChatView');
    expect(!createConversationBody.includes('switchConversation'), 'sidebar new-conversation action should not switch conversations');

    expectIncludes(sidebar, 'event.stopPropagation();\n                                      void togglePinnedConversation(conversation);', 'pin button should stay a list-management action');
    expectIncludes(sidebar, 'className="nav-sub-item__actions"\n                                    onClick={(event) => event.stopPropagation()}', 'conversation action menu should not bubble into conversation opening');
    expectIncludes(sidebar, 'onClick={() => beginRenameConversation(conversation)}', 'rename menu item should only enter rename mode');
    expectIncludes(sidebar, 'onClick={() => deleteConversation(conversation)}', 'delete menu item should only delete the conversation');
    expectIncludes(sidebar, 'onClick={() => setVisibleConversationCount((count) => count + 5)}', 'load-more should only expand the visible list');
  });

  it('keeps missing API key state inside ChatView without hiding sidebar navigation', () => {
    const chatView = source('src', 'renderer', 'components', 'workspace', 'ChatView.tsx');
    const sidebar = source('src', 'renderer', 'components', 'workspace', 'WorkspaceSidebar.tsx');
    const chatViewBody = chatView.slice(
      chatView.indexOf('export function ChatView'),
      chatView.indexOf('export default ChatView'),
    );

    expectIncludes(chatViewBody, 'const hasAiApiKey = currentAiConfig?.hasApiKey ?? (config?.hasApiKey === true);', 'ChatView should use global config availability');
    expectIncludes(chatViewBody, 'const emptyStateKind: ChatEmptyStateKind = !hasAiApiKey', 'missing API key should select a scoped empty state');
    expectIncludes(chatViewBody, 'kind={emptyStateKind}', 'ChatView should render the missing-key state inside the message area');
    expectIncludes(chatViewBody, '请先在设置中配置全局 AI 接口', 'composer should show a global missing-key placeholder');
    expectIncludes(chatView, '在设置的 AI 对话面板中配置全局 API Key 后即可发送消息。', 'missing-key empty state should mention the global API key');
    expectIncludes(sidebar, 'className="nav-add-btn"', 'missing-key UI should not remove the sidebar new-conversation entry');
    expectIncludes(sidebar, 'aria-label="新建对话"', 'sidebar new-conversation entry should remain accessible');
    expect(!chatViewBody.includes('if (config && !config.hasApiKey)'), 'ChatView should not early-return on missing legacy config');
  });

  it('keeps the floating composer, model controls, and send or stop actions wired', () => {
    const chatView = source('src', 'renderer', 'components', 'workspace', 'ChatView.tsx');

    expectIncludes(chatView, 'className="chat-composer-zone"', 'ChatView should render the floating composer zone');
    expectIncludes(chatView, '<form className="chat-composer" onSubmit={handleComposerSubmit}>', 'composer should submit through the send handler');
    expectIncludes(chatView, 'className="chat-composer__textarea"', 'composer should keep the textarea surface');
    expectIncludes(chatView, 'className="chat-model-select chat-model-select--provider"', 'composer should expose the provider dropdown');
    expectIncludes(chatView, '<label className="chat-model-select" title="选择模型配置">', 'composer should expose the global AI config dropdown');
    expectIncludes(chatView, "className={`chat-model-select${thinkingDepthDisabled ? ' is-disabled' : ''}`}", 'composer should expose thinking depth controls with disabled state');
    expectIncludes(chatView, 'updateConversationAiConfig(nextConfig.id)', 'provider changes should update the active conversation binding');
    expectIncludes(chatView, 'updateConversationAiConfig(nextConfigId)', 'config changes should update the active conversation binding');
    expectIncludes(chatView, 'updateActiveAiConfigThinkingDepth(nextDepth)', 'thinking depth changes should persist through the shared chat action');
    expectIncludes(chatView, 'className="chat-icon-btn"', 'composer should keep the secondary clear icon action');
    expectIncludes(chatView, 'className="stop-button"', 'streaming state should show the stop action');
    expectIncludes(chatView, 'className="send-button"', 'idle state should show the send action');
    expectIncludes(chatView, 'disabled={sendDisabled}', 'send action should keep disabled state wiring');
    expectIncludes(chatView, 'aria-label="停止生成"', 'stop action should remain accessible');
    expectIncludes(chatView, 'aria-label="发送消息"', 'send action should remain accessible');
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
    const layoutCss = source('src', 'renderer', 'styles', 'layout.css');
    const workspaceCss = source('src', 'renderer', 'styles', 'workspace.css');

    // 场景四：路径链接——工作区路径控件带链接样式钩子，点击仍走 openProjectFolder 打开系统文件夹。
    expectIncludes(sidebar, 'project-path project-path-link', '工作区路径控件应带链接样式钩子类');
    expectIncludes(sidebar, 'window.autoplan.openProjectFolder({ projectId })', '路径控件仍应绑定打开系统文件夹的行为');
    expectIncludes(workspaceCss, '.project-switcher .project-path { margin-top: 8px; font-size: 11px; }', 'workspace 侧栏应保留自己的路径间距和字号');
    expectIncludes(layoutCss, '.project-path-link { display: block;', '共享样式表应定义路径链接样式');
    expectIncludes(layoutCss, 'color: var(--brand-600)', '路径链接应使用主题色文字');
    expectIncludes(layoutCss, 'cursor: pointer', '路径链接应为指针光标');
    expectIncludes(layoutCss, '.project-path-link:focus-visible', '路径链接应保留键盘焦点样式');
    expectIncludes(layoutCss, '.project-path-link:disabled', '路径链接禁用态应置灰');
  });

  it('styles the project-card folder path as a shared link without changing its open-folder behavior', () => {
    const projectsPage = source('src', 'renderer', 'pages', 'ProjectsPage.tsx');
    const layoutCss = source('src', 'renderer', 'styles', 'layout.css');

    // 需求 #32：首页项目卡片路径复用 workspace 路径链接钩子，行为仍只打开文件夹，不冒泡进入工作区。
    expectIncludes(projectsPage, 'className="project-path project-path-link mono"', '首页项目路径控件应带共享链接样式钩子和等宽字体类');
    expectIncludes(projectsPage, 'disabled={!project.workspace_path}', '未设置工作区路径时首页路径控件应保持禁用');
    expectIncludes(projectsPage, 'event.stopPropagation();', '首页路径点击应阻止冒泡到项目卡片导航');
    expectIncludes(projectsPage, 'if (project.workspace_path) void openFolder(project);', '首页路径点击仍应通过 openFolder 打开系统文件夹');
    expectIncludes(projectsPage, 'window.autoplan.openProjectFolder({ projectId: project.id })', '首页 openFolder 应调用打开项目文件夹 IPC');
    expect(!projectsPage.includes('pathLinkStyle'), '首页路径按钮不应再依赖 pathLinkStyle 内联样式');
    expectIncludes(layoutCss, '.project-path-link { display: block;', '共享样式表应提供首页和 workspace 可复用的路径链接规则');
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

// 反馈 #21 回归测试：聊天窗口用户气泡需要稳定右对齐，AI/工具左对齐、系统居中语义不被破坏。
describe('Feedback #21 chat bubble alignment regression', () => {
  it('keeps user chat bubbles right aligned without row-reverse inversion', () => {
    const workspaceCss = source('src', 'renderer', 'styles', 'workspace.css');

    const baseMessageRule = cssRuleBody(workspaceCss, '.chat-message');
    const userMessageRule = cssRuleBody(workspaceCss, '.chat-message--user');
    const userContentRule = cssRuleBody(workspaceCss, '.chat-message--user .chat-message__content');
    const userBubbleRule = cssRuleBody(workspaceCss, '.chat-message--user .chat-message__bubble');

    // 场景一：消息行保持整行宽度，用户消息用正常 row 方向 + flex-end 右对齐，避免 row-reverse 翻转视觉落点。
    expectIncludes(baseMessageRule, 'width: 100%;', '消息行应占满 .chat-messages__inner 宽度，用户气泡才能稳定贴右');
    expectIncludes(userMessageRule, 'justify-content: flex-end;', '用户消息行应通过 flex-end 锚定到右侧');
    expectIncludes(userMessageRule, 'flex-direction: row;', '用户消息行应使用正常 row 方向，避免 row-reverse 与 flex-end 组合反向');
    expect(!userMessageRule.includes('row-reverse'), '用户消息行不应再使用 row-reverse');
    expect(
      !(userMessageRule.includes('justify-content: flex-end') && userMessageRule.includes('flex-direction: row-reverse')),
      '用户消息行不应重新引入 flex-end + row-reverse 的偏左组合',
    );

    // 场景二：内容容器继续作为右侧锚点，气泡内部文字不被强制右对齐，长文本保持自然阅读方向。
    expectIncludes(userContentRule, 'margin-left: auto;', '用户消息内容容器应通过 margin-left:auto 贴近消息列右侧');
    expectIncludes(userContentRule, 'justify-content: flex-end;', '用户消息内容容器应把气泡锚定到自身右侧');
    expect(!userContentRule.includes('text-align: right'), '用户消息内容不应强制右对齐文本');
    expect(!userBubbleRule.includes('text-align'), '用户气泡本体不应覆盖文本自然对齐');
  });

  it('keeps assistant, tool, system, and streaming cursor alignment semantics intact', () => {
    const workspaceCss = source('src', 'renderer', 'styles', 'workspace.css');

    const assistantRule = cssRuleBody(workspaceCss, '.chat-message--assistant');
    const toolRule = cssRuleBody(workspaceCss, '.chat-message--tool');
    const systemRule = cssRuleBody(workspaceCss, '.chat-message--system');
    const cursorRule = cssRuleBody(workspaceCss, '.chat-message__cursor');

    expectIncludes(assistantRule, 'justify-content: flex-start;', 'AI 消息应继续左对齐');
    expectIncludes(assistantRule, 'flex-direction: row;', 'AI 消息应保持正常行方向');
    expectIncludes(toolRule, 'justify-content: flex-start;', '工具调用卡片应继续左对齐');
    expectIncludes(systemRule, 'justify-content: center;', '系统消息应继续居中');
    expectIncludes(cursorRule, 'align-self: flex-end;', '流式光标应继续贴随 AI 气泡底部显示');
  });
});

// 反馈 #24 回归测试：聊天窗口 AI 回复与工具调用去卡片化，工具详情只能通过 dialog 查看。
describe('Feedback #24 chat message simplification regression', () => {
  it('keeps tool call details in the shared dialog instead of inline message-flow expansion', () => {
    const chatView = source('src', 'renderer', 'components', 'workspace', 'ChatView.tsx');
    const modal = source('src', 'renderer', 'components', 'Modal.tsx');
    const toolCardStart = chatView.indexOf('/** 工具调用摘要与详情弹窗 */');
    const toolCardEnd = chatView.indexOf('function hasDisplayableToolValue', toolCardStart);
    const toolCard = chatView.slice(toolCardStart, toolCardEnd);

    expect(toolCardStart >= 0 && toolCardEnd > toolCardStart, '应能定位到 ChatToolCard 源码块');
    expectIncludes(chatView, "import { Modal } from '../Modal';", '工具调用详情应复用共享 Modal 组件');
    expectIncludes(toolCard, 'const [detailOpen, setDetailOpen] = useState(false);', '工具调用摘要点击应只控制详情 dialog 开关');
    expectIncludes(toolCard, "const statusKind = isLoading ? 'loading' : isError ? 'error' : 'success';", '工具调用应区分加载中、失败、成功三类状态');
    expectIncludes(toolCard, "const statusLabel = isLoading ? '执行中' : isError ? '执行失败' : '已完成';", '工具调用应保留加载中、失败、成功状态文案');
    expectIncludes(toolCard, "const statusIcon = isLoading ? 'settings' : isError ? 'alert' : 'check';", '工具调用应保留加载中、失败、成功状态图标');
    expectIncludes(toolCard, 'onClick={() => setDetailOpen(true)}', '点击工具调用摘要应打开详情 dialog');
    expectIncludes(toolCard, 'aria-haspopup="dialog"', '工具调用摘要应声明会打开 dialog');
    expectIncludes(toolCard, 'aria-label={`查看工具调用详情：${name}，${statusLabel}`}', '工具调用摘要按钮应有可访问名称');
    expectIncludes(toolCard, '<Modal', '工具调用详情应通过 Modal 渲染');
    expectIncludes(toolCard, 'className="chat-tool-modal"', '工具调用详情 dialog 应带专用外壳样式钩子');
    expectIncludes(toolCard, 'bodyClassName="chat-tool-modal__body"', '工具调用详情 dialog 主体应带可滚动样式钩子');
    expectIncludes(toolCard, '<span className="chat-tool-modal__label">工具名称</span>', 'dialog 应完整展示工具名称');
    expectIncludes(toolCard, '<span className="chat-tool-modal__label">执行状态</span>', 'dialog 应完整展示执行状态');
    expectIncludes(toolCard, '<div className="chat-tool-modal__section-title">参数</div>', 'dialog 应完整展示参数区');
    expectIncludes(toolCard, '<div className="chat-tool-modal__section-title">结果</div>', 'dialog 应完整展示结果区');
    expectIncludes(toolCard, '<div className="chat-tool-modal__empty">等待结果...</div>', 'dialog 应展示加载中状态');
    expectIncludes(toolCard, '<div className="chat-tool-modal__empty">无返回内容</div>', 'dialog 应展示无返回内容状态');
    expectIncludes(modal, 'role="dialog"', '共享 Modal 应保留 dialog 角色');
    expectIncludes(modal, 'aria-modal="true"', '共享 Modal 应声明模态语义');
    expectIncludes(modal, 'aria-labelledby={titleId}', '共享 Modal 标题应作为可访问名称');
    expectIncludes(modal, 'className="modal-close"', '共享 Modal 应保留关闭按钮');
    expectIncludes(modal, 'aria-label={closeAriaLabel}', '共享 Modal 关闭按钮应保留可访问名称');
    expect(!toolCard.includes('chat-tool-card__body'), '工具调用详情不应再以内联 body 展开在消息流中');
    expect(!toolCard.includes('chat-tool-card__section'), '工具调用参数/结果不应继续使用旧内联 section 结构');
    expect(!toolCard.includes('chat-tool-card__toggle'), '工具调用摘要不应继续暴露展开/折叠 toggle');
    expect(!toolCard.includes('aria-expanded'), '工具调用摘要不应再声明内联展开态');
  });

  it('keeps tool call summaries visually minimal and leaves long details to the dialog body', () => {
    const workspaceCss = source('src', 'renderer', 'styles', 'workspace.css');
    const toolStyles = workspaceCss.slice(
      workspaceCss.indexOf('/* ---- 工具调用摘要与详情 ---- */'),
      workspaceCss.indexOf('/* ---- 空状态 ---- */'),
    );

    const toolCardRule = cssRuleBody(workspaceCss, '.chat-tool-card');
    const toolHeaderRule = cssRuleBody(workspaceCss, '.chat-tool-card__header');
    const toolModalBodyRule = cssRuleBody(workspaceCss, '.chat-tool-modal__body');
    const toolModalCodeRule = cssRuleBody(workspaceCss, '.chat-tool-modal__code');

    expect(toolStyles.length > 0, '应能定位到工具调用样式区');
    expectIncludes(toolCardRule, 'width: 100%;', '工具摘要应占满聊天列内可用宽度');
    expectIncludes(toolCardRule, 'max-width: 100%;', '工具摘要不应再受旧 760px 卡片宽度限制');
    expect(!toolCardRule.includes('border'), '工具摘要外壳不应带卡片边框');
    expect(!toolCardRule.includes('background'), '工具摘要外壳不应带大面积底色');
    expect(!toolStyles.includes('border-left'), '工具摘要不应保留左侧强调边框');
    expect(!toolStyles.includes('chat-tool-card__body'), '工具样式不应保留旧内联详情 body 钩子');
    expect(!toolStyles.includes('chat-tool-card__toggle'), '工具样式不应保留旧展开 toggle 钩子');
    expectIncludes(toolHeaderRule, 'border: 0;', '工具摘要按钮自身应保持无边框');
    expectIncludes(toolHeaderRule, 'background: transparent;', '工具摘要按钮默认应无卡片底色');
    expectIncludes(toolHeaderRule, 'box-shadow 0.14s', '工具摘要应保留键盘焦点过渡');
    expectIncludes(toolStyles, '.chat-tool-card__status--loading', '工具摘要应保留加载中状态样式');
    expectIncludes(toolStyles, '.chat-tool-card__status--error', '工具摘要应保留失败状态样式');
    expectIncludes(toolStyles, '.chat-tool-card__status--success', '工具摘要应保留成功状态样式');
    expectIncludes(toolModalBodyRule, 'overflow: auto;', '工具详情 dialog 主体应可滚动');
    expectIncludes(toolModalCodeRule, 'overflow: auto;', '工具详情长 JSON 应在自身区域滚动');
    expectIncludes(toolModalCodeRule, 'overflow-wrap: anywhere;', '工具详情长 JSON 不应撑破布局');
    expectIncludes(toolModalCodeRule, 'word-break: break-word;', '工具详情长 JSON 应允许断词换行');
  });

  it('keeps assistant messages full-width and borderless while preserving the user bubble', () => {
    const chatView = source('src', 'renderer', 'components', 'workspace', 'ChatView.tsx');
    const workspaceCss = source('src', 'renderer', 'styles', 'workspace.css');

    const contentRule = cssRuleBody(workspaceCss, '.chat-message__content');
    const assistantContentRule = cssRuleBody(workspaceCss, '.chat-message--assistant .chat-message__content');
    const assistantBodyRule = cssRuleBody(workspaceCss, '.chat-message--assistant .chat-message__body');
    const userContentRule = cssRuleBody(workspaceCss, '.chat-message--user .chat-message__content');
    const userBubbleRule = cssRuleBody(workspaceCss, '.chat-message--user .chat-message__bubble');

    expectIncludes(chatView, 'className="chat-message__body chat-message__body--markdown"', 'AI 回复应使用无气泡正文容器');
    expect(!chatView.includes('chat-message__bubble chat-message__bubble--markdown'), 'AI 回复不应继续使用 markdown 气泡容器');
    expectIncludes(chatView, 'className="chat-message__bubble chat-message__bubble--plain"', '用户消息应继续使用明确气泡容器');
    expectIncludes(contentRule, 'width: 100%;', '默认消息内容列应占满聊天列宽度');
    expectIncludes(assistantContentRule, 'width: 100%;', 'AI 消息内容容器应占满聊天列宽度');
    expectIncludes(assistantContentRule, 'justify-content: flex-start;', 'AI 消息内容应左对齐');
    expectIncludes(assistantBodyRule, 'width: 100%;', 'AI 正文容器应占满可用宽度');
    expectIncludes(assistantBodyRule, 'text-align: left;', 'AI 正文应保持左对齐阅读方向');
    expect(!workspaceCss.includes('.chat-message--assistant .chat-message__bubble'), 'AI 消息不应重新引入灰底边框气泡样式');
    expectIncludes(userContentRule, 'max-width: min(680px, 76%);', '用户消息应继续限制气泡宽度');
    expectIncludes(userContentRule, 'margin-left: auto;', '用户消息应继续贴右');
    expectIncludes(userBubbleRule, 'background: var(--brand-600);', '用户气泡应保留明确背景色');
    expectIncludes(userBubbleRule, 'color: #fff;', '用户气泡应保留反白文字');
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

// 反馈 #26 回归测试：搜索结果弹层 Portal 化后，WorkspacePage 需向 SearchResults 传入锚点坐标、
// 修复 Portal 后外部点击关闭判定，并在滚动 / 缩放时刷新坐标。
describe('Feedback #26 search popup Portal wiring', () => {
  it('computes anchor rect coordinates and passes them as anchorRect to SearchResults', () => {
    const page = source('src', 'renderer', 'pages', 'WorkspacePage.tsx');

    // 场景一：导入锚点坐标类型并持有坐标状态，弹层打开时基于锚点 ref 读取 getBoundingClientRect。
    expectIncludes(page, "import { SearchResults, type SearchResultsAnchorRect } from '../components/SearchResults';", 'WorkspacePage 应导入 SearchResults 的锚点坐标类型');
    expectIncludes(page, 'const [searchPopupRect, setSearchPopupRect] = useState<SearchResultsAnchorRect | null>(null);', 'WorkspacePage 应持有锚点视口坐标状态');
    expectIncludes(page, 'anchorRect={searchPopupRect}', 'WorkspacePage 应将锚点坐标作为 anchorRect 传入 SearchResults');
    expectIncludes(page, 'const rect = node.getBoundingClientRect();', '应基于锚点 ref 读取 getBoundingClientRect');
    expectIncludes(page, 'top: rect.top,', '坐标状态应携带锚点 top');
    expectIncludes(page, 'right: rect.right,', '坐标状态应携带锚点 right');
    expectIncludes(page, 'bottom: rect.bottom,', '坐标状态应携带锚点 bottom');
    expectIncludes(page, 'left: rect.left,', '坐标状态应携带锚点 left');
    expectIncludes(page, 'width: rect.width,', '坐标状态应携带锚点 width');
    expectIncludes(page, 'height: rect.height,', '坐标状态应携带锚点 height');
  });

  it('refreshes anchor coordinates on window scroll and resize while the popup is open', () => {
    const page = source('src', 'renderer', 'pages', 'WorkspacePage.tsx');

    // 场景五：弹层打开时立即测量，并在 scroll（capture，覆盖嵌套滚动容器）/ resize 时刷新坐标，卸载时移除监听。
    expectIncludes(page, 'updatePopupRect();', '弹层打开时应立即测量一次锚点坐标');
    expectIncludes(page, "window.addEventListener('scroll', updatePopupRect, true);", '应在 capture 阶段监听 scroll 以捕获 .workspace-main 等嵌套滚动容器');
    expectIncludes(page, "window.addEventListener('resize', updatePopupRect);", '应监听 resize 以在窗口缩放时刷新坐标');
    expectIncludes(page, "window.removeEventListener('scroll', updatePopupRect, true);", '卸载时应移除 scroll 监听，避免泄漏');
    expectIncludes(page, "window.removeEventListener('resize', updatePopupRect);", '卸载时应移除 resize 监听，避免泄漏');
  });

  it('keeps clicks inside the portaled popup from being treated as outside clicks and preserves Esc close', () => {
    const page = source('src', 'renderer', 'pages', 'WorkspacePage.tsx');

    // 场景三：Portal 后弹层脱离锚点子树，外部点击判定需同时排除弹层自身（稳定 class），点击弹层内部不应被提前关闭。
    expectIncludes(page, 'const insideAnchor = anchor ? anchor.contains(event.target) : false;', '应保留对锚点子树的内部点击判定');
    expectIncludes(page, "event.target instanceof Element && event.target.closest('.search-results-popup') !== null", '应通过稳定 class 排除 Portal 弹层自身的点击');
    expectIncludes(page, 'if (!insideAnchor && !insidePopup) {', '点击锚点或弹层内部不应被判定为外部点击而提前关闭');

    // 场景四：点击左侧导航 / 主区空白会关闭；Esc 仍会关闭。
    expectIncludes(page, 'if (event.key === \'Escape\') {', '应保留 Esc 关闭逻辑');
  });
});
