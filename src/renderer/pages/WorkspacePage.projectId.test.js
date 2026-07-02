const { describe, it } = require('node:test');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

function source(...parts) {
  return readFileSync(join(process.cwd(), ...parts), 'utf8').replace(/\r\n/g, '\n');
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

function expectIncludes(sourceText, snippet, message) {
  expect(sourceText.includes(snippet), message);
}

function expectNotIncludes(sourceText, snippet, message) {
  expect(!sourceText.includes(snippet), message);
}

function sliceBetween(sourceText, startNeedle, endNeedle, message) {
  const start = sourceText.indexOf(startNeedle);
  expect(start >= 0, message);
  const end = sourceText.indexOf(endNeedle, start);
  expect(end >= 0, message);
  return sourceText.slice(start, end + endNeedle.length);
}

describe('Workspace chat project boundary regression', () => {
  it('owns one project-scoped chat state and passes it through the workspace tree', () => {
    const page = source('src', 'renderer', 'pages', 'WorkspacePage.tsx');
    const settingsCall = sliceBetween(
      page,
      '<WorkspaceSettingsView',
      '/>',
      'WorkspacePage should render WorkspaceSettingsView',
    );
    const chatCall = sliceBetween(page, '<ChatView', '/>', 'WorkspacePage should render ChatView');

    expectIncludes(page, 'const chatState = useChat(projectId);', 'WorkspacePage should key chat state by projectId');
    expectIncludes(settingsCall, 'projectId={projectId}', 'settings still receives the current project for non-AI settings');
    expectIncludes(chatCall, 'chatState={chatState}', 'ChatView should consume the shared chat state');
    expectNotIncludes(chatCall, 'projectId={projectId}', 'ChatView should not receive a separate projectId prop');
  });

  it('loads project conversations separately from global AI configs', () => {
    const hook = source('src', 'renderer', 'hooks', 'useChat.ts');

    expectIncludes(hook, 'window.autoplan.conversationList({ projectId })', 'useChat should list conversations by project');
    expectIncludes(hook, 'window.autoplan.aiConfigList().catch(() => [] as AiConfig[])', 'useChat should list global AI configs without projectId');
    expectIncludes(hook, 'normalizeConversationAiConfigBindings(convs, cfgs)', 'conversation bindings should resolve against the global config list');
    expectNotIncludes(hook, 'aiConfigList({ projectId', 'AI config list should not be project-scoped');
    expectNotIncludes(hook, '.chatGetConfig(', 'chat availability should not fall back to legacy global chat config');
  });

  it('sends chat and conversation IPC payloads with projectId', () => {
    const hook = source('src', 'renderer', 'hooks', 'useChat.ts');
    const sidebar = source('src', 'renderer', 'components', 'workspace', 'WorkspaceSidebar.tsx');

    expectIncludes(hook, 'window.autoplan.chatHistory({ projectId: loadingProjectId, conversationId: cid })', 'history load should include projectId');
    expectIncludes(hook, '.chatHistory({ projectId: historyProjectId, conversationId: cid })', 'done refresh should keep projectId');
    expectIncludes(hook, 'await window.autoplan.chatSend({\n          projectId,\n          conversationId: cid,', 'chat send should include projectId');
    expectIncludes(hook, 'await window.autoplan.chatStop({ projectId: pid, conversationId: cid });', 'manual stop should include projectId');
    expectIncludes(hook, 'await window.autoplan.chatClear({ projectId: pid, conversationId: cid });', 'clear should include projectId');
    expectIncludes(hook, 'await window.autoplan.conversationDelete({ projectId, conversationId: cid });', 'delete should include projectId');
    expectIncludes(hook, 'await window.autoplan.conversationUpdate({ projectId, conversationId: cid, title });', 'rename should include projectId');
    expectIncludes(hook, 'const updated = await window.autoplan.conversationUpdate({\n      projectId,\n      conversationId: cid,\n      aiConfigId: configId,', 'AI config binding should update the project-scoped conversation');
    expectIncludes(sidebar, 'readConversationProjectId(conversation) === projectId', 'sidebar should filter visible conversations by project');
    expectIncludes(sidebar, 'await window.autoplan.conversationUpdate({\n        projectId,\n        conversationId: conversation.id,\n        pinned: nextPinned,', 'pinning should include projectId');
  });
});

describe('Workspace global AI config boundary regression', () => {
  it('keeps settings AI config CRUD global and independent of project context', () => {
    const settingsView = source('src', 'renderer', 'components', 'workspace', 'WorkspaceSettingsView.tsx');
    const forms = source('src', 'renderer', 'utils', 'workspaceForms.ts');
    const aiConfigInputBody = sliceBetween(
      forms,
      'export function aiConfigInputFromForm',
      'function shouldUseProviderDefault',
      'workspaceForms should define aiConfigInputFromForm',
    );

    expectIncludes(settingsView, 'const list = await window.autoplan.aiConfigList();', 'settings should load global AI configs');
    expectIncludes(settingsView, 'await window.autoplan.aiConfigCreate(payload);', 'AI config create should send the global payload directly');
    expectIncludes(settingsView, 'await window.autoplan.aiConfigUpdate({\n          configId: editingConfigId,', 'AI config update should target only configId');
    expectIncludes(settingsView, 'await window.autoplan.aiConfigDelete({ configId: id });', 'AI config delete should target only configId');
    expectNotIncludes(settingsView, 'aiConfigList({ projectId', 'settings should not pass projectId to AI config list');
    expectNotIncludes(settingsView, 'aiConfigCreate({ projectId', 'settings should not pass projectId to AI config create');
    expectNotIncludes(settingsView, 'hasValidProjectContext', 'global AI config creation should not be blocked by project context');
    expectNotIncludes(settingsView, 'aiConfigNewDisabled', 'global AI config creation should not use a project-context disabled state');
    expectNotIncludes(aiConfigInputBody, 'projectId', 'AI config form serialization should not include projectId');
  });

  it('keeps preload and renderer types aligned with global AI config IPC', () => {
    const preload = source('src', 'preload.js');
    const types = source('src', 'renderer', 'types.ts');
    const preloadCreatePayload = sliceBetween(
      preload,
      'function aiConfigCreatePayload',
      'function aiConfigUpdatePayload',
      'preload should define aiConfigCreatePayload',
    );
    const preloadUpdatePayload = sliceBetween(
      preload,
      'function aiConfigUpdatePayload',
      'function aiConfigIdPayload',
      'preload should define aiConfigUpdatePayload',
    );
    const aiConfigCreateInput = sliceBetween(
      types,
      'export interface AiConfigCreateInput',
      'export interface AiConfigUpdateInput',
      'types should define AiConfigCreateInput',
    );
    const aiConfigUpdateInput = sliceBetween(
      types,
      'export interface AiConfigUpdateInput',
      'export interface AiConfigDeleteInput',
      'types should define AiConfigUpdateInput',
    );
    const aiConfigDeleteInput = sliceBetween(
      types,
      'export interface AiConfigDeleteInput',
      'export interface AiConfigGetInput',
      'types should define AiConfigDeleteInput',
    );

    expectIncludes(preload, "aiConfigList: () => ipcRenderer.invoke('ai-config:list')", 'preload should expose global aiConfigList without input');
    expectIncludes(preload, "aiConfigCreate: (payload) => ipcRenderer.invoke('ai-config:create', aiConfigCreatePayload(payload))", 'preload create should sanitize only AI config fields');
    expectNotIncludes(preloadCreatePayload, 'projectId', 'preload create sanitizer should not pass projectId');
    expectNotIncludes(preloadUpdatePayload, 'projectId', 'preload update sanitizer should not pass projectId');
    expectIncludes(types, 'export type AiConfigListInput = void;', 'types should model AI config list as global');
    expectIncludes(types, 'aiConfigList: () => Promise<AiConfig[]>;', 'AutoplanApi should expose global aiConfigList');
    expectNotIncludes(aiConfigCreateInput, 'projectId', 'AI config create input should not include projectId');
    expectNotIncludes(aiConfigUpdateInput, 'projectId', 'AI config update input should not include projectId');
    expectNotIncludes(aiConfigDeleteInput, 'projectId', 'AI config delete input should not include projectId');
  });
});
