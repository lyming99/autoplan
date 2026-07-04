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

function expectNotIncludes(sourceText: string, snippet: string, message: string) {
  expect(!sourceText.includes(snippet), message);
}

describe('WorkspaceExecutorsView regression', () => {
  it('renders executor filters, search, import, and create controls', () => {
    const view = source('src', 'renderer', 'components', 'workspace', 'WorkspaceExecutorsView.tsx');

    expectIncludes(view, "type ExecutorFilter = 'all' | 'build' | 'test' | 'custom' | 'disabled' | 'recent';", '执行器视图应保留筛选枚举');
    expectIncludes(view, 'aria-label="执行器筛选"', '筛选标签组应有可访问名称');
    expectIncludes(view, "setFilter('build')", '应保留 build 筛选');
    expectIncludes(view, "setFilter('test')", '应保留 test 筛选');
    expectIncludes(view, "setFilter('custom')", '应保留 custom 筛选');
    expectIncludes(view, "setFilter('disabled')", '应保留 disabled 筛选');
    expectIncludes(view, "setFilter('recent')", '应保留 recent 筛选');
    expectIncludes(view, 'placeholder="搜索标签或命令…"', '应支持按 label/command 搜索');
    expectIncludes(view, "await window.autoplan.pickTasksJson();", '导入入口应选择 tasks.json 文件');
    expectIncludes(view, "await window.autoplan.importTasksJson({ projectId, filePath });", '导入入口应调用执行器导入 API');
    expectIncludes(view, '新建执行器', '应保留新建执行器入口');
  });

  it('wires run, stop, toggle, delete, and edit actions through executor IPC APIs', () => {
    const view = source('src', 'renderer', 'components', 'workspace', 'WorkspaceExecutorsView.tsx');

    expectIncludes(view, "const result = await window.autoplan.runExecutor({ projectId, executorId: executor.id });", '运行按钮应调用 runExecutor');
    expectIncludes(view, 'onSync(result.snapshot);', '运行完成应同步返回快照');
    expectIncludes(view, "const snapshot = await window.autoplan.stopExecutor({ projectId, executorId: executor.id });", '停止按钮应调用 stopExecutor');
    expectIncludes(view, "const snapshot = await window.autoplan.toggleExecutor({ projectId, executorId: executor.id });", '启用禁用应调用 toggleExecutor');
    expectIncludes(view, "const snapshot = await window.autoplan.deleteExecutor({ projectId, executorId: executor.id });", '删除应调用 deleteExecutor');
    expectIncludes(view, "setModal({ open: true, executorId: executor.id });", '卡片点击应进入编辑已有执行器');
    expectIncludes(view, '<ExecutorEditorModal', '应通过编辑弹窗维护执行器配置');
    expectIncludes(view, 'onExecutorIdChange={(executorId) => setModal({ open: true, executorId })}', '新建后应能切到已创建执行器');
  });

  it('keeps import feedback and editor save wired to executor APIs', () => {
    const view = source('src', 'renderer', 'components', 'workspace', 'WorkspaceExecutorsView.tsx');
    const modal = source('src', 'renderer', 'components', 'workspace', 'ExecutorEditorModal.tsx');

    expectIncludes(view, 'const summary = `导入 ${result.importedCount} 个，跳过 ${result.skippedCount} 个，错误 ${result.errorCount} 个`;', '导入后应显示成功/跳过/错误数量');
    expectIncludes(view, "setNotice({ tone: result.errorCount > 0 ? 'bad' : 'ok', text: summary });", '导入反馈应按错误数量展示状态');
    expectIncludes(view, "setNotice({ tone: 'bad', text: getErrorMessage(e, '导入 tasks.json 失败') });", '导入异常应展示错误反馈');
    expectIncludes(modal, 'payload = executorInputFromDraft(projectId, draft);', '保存前应从 draft 构造并校验执行器输入');
    expectIncludes(modal, "if (!label) throw new Error('执行器标签不能为空');", '编辑保存应校验 label 必填');
    expectIncludes(modal, "if (!isPlugin && !command) throw new Error('命令不能为空');", '编辑保存应校验非 plugin 的 command 必填');
    expectIncludes(modal, "if (isPlugin) input.actions = buildActionsFromDraft(draft);", 'plugin 类型保存应构造 actions 字段');
    expectIncludes(modal, 'const snapshot = await window.autoplan.createExecutor(payload);', '新建保存应调用 createExecutor');
    expectIncludes(modal, 'const snapshot = await window.autoplan.updateExecutor({ ...payload, executorId: draft.id });', '编辑保存应调用 updateExecutor');
    expectIncludes(modal, 'onSync(snapshot);', '保存后应同步 workspace snapshot');
    expectIncludes(modal, 'onExecutorIdChange(created.id);', '新建成功后应切换到已创建执行器');
    expectNotIncludes(modal.toLowerCase(), 'debug', '执行器编辑弹窗不应暴露 debug 文案或控件');
    expectNotIncludes(modal.toLowerCase(), 'launch', '执行器编辑弹窗不应暴露 launch 文案或控件');
    expectNotIncludes(modal.toLowerCase(), 'breakpoint', '执行器编辑弹窗不应暴露断点能力');
  });

  it('shows executor metadata and recent run status without exposing debug or launch controls', () => {
    const view = source('src', 'renderer', 'components', 'workspace', 'WorkspaceExecutorsView.tsx');

    expectIncludes(view, 'TYPE_LABELS[executor.type] ?? executor.type', '卡片应展示 shell/process type');
    expectIncludes(view, 'readCwd(executor)', '卡片应展示 cwd');
    expectIncludes(view, 'readDependsOn(executor)', '卡片应展示依赖数量');
    expectIncludes(view, "readLastStatus(executor): ExecutorLastStatus | null", '卡片应读取最近状态');
    expectIncludes(view, 'readExitCode(executor)', '卡片应展示退出码');
    expectIncludes(view, 'formatDurationShort(readDuration(executor))', '卡片应展示最近耗时');
    expectIncludes(view, 'formatRelativeTime(readLastRunAt(executor))', '卡片应展示最近运行时间');
    expectIncludes(view, "if (running) return { led: 'running', text: '运行中', tone: 'ok' };", '运行中状态应优先展示');
    expectIncludes(view, "if (status === 'bad') return { led: 'bad', text: `失败${formatExitSuffix(readExitCode(executor))}`, tone: 'bad' };", '失败状态应展示退出码');
    expectNotIncludes(view.toLowerCase(), 'debug', '执行器列表不应暴露 debug 文案或控件');
    expectNotIncludes(view.toLowerCase(), 'launch', '执行器列表不应暴露 launch 文案或控件');
    expectNotIncludes(view, 'breakpoint', '执行器列表不应暴露断点能力');
  });

  it('prevents duplicate runs while an executor is disabled, running, or busy', () => {
    const view = source('src', 'renderer', 'components', 'workspace', 'WorkspaceExecutorsView.tsx');

    expectIncludes(view, 'if (!readEnabled(executor) || isExecutorRunning(executor) || isBusy(executor, busy)) return;', '运行前应检查禁用/运行中/忙状态');
    expectIncludes(view, "const running = isExecutorRunning(executor) || busy === 'run' || busy === 'start';", '运行态应同步本地 busy（含 plugin start）');
    expectIncludes(view, "disabled={running ? stopBusy : !enabled || running || busy === 'run'}", 'shell/process 运行/停止按钮应避免重复点击');
    expectIncludes(view, '|| executor.pluginState?.running,', '运行态应兼容 pluginState.running');
  });

  it('renders plugin three-state action buttons (start/reload/stop) wired to runExecutorAction', () => {
    const view = source('src', 'renderer', 'components', 'workspace', 'WorkspaceExecutorsView.tsx');

    expectIncludes(view, 'className="executor-action-btn start"', 'plugin 行应渲染启动按钮');
    expectIncludes(view, "onClick={() => onPluginAction('start')}", '启动按钮应触发 start 动作');
    expectIncludes(view, 'className="executor-action-btn reload"', 'plugin 行应渲染热刷新按钮');
    expectIncludes(view, "onClick={() => onPluginAction('reload')}", '热刷新按钮应触发 reload 动作');
    expectIncludes(view, 'className="executor-action-btn stop"', 'plugin 行应渲染停止按钮');
    expectIncludes(view, "onClick={() => onPluginAction('stop')}", '停止按钮应触发 stop 动作');
    expectIncludes(view, 'async function handlePluginAction(executor: Executor, action: PluginAction) {', '应定义 plugin 动作处理函数');
    expectIncludes(view, "await window.autoplan.runExecutorAction({ projectId, executorId: executor.id, action });", 'plugin 动作应调用 runExecutorAction IPC');
  });

  it('renders an expandable inline log panel and running-state highlight in the list layout', () => {
    const view = source('src', 'renderer', 'components', 'workspace', 'WorkspaceExecutorsView.tsx');

    expectIncludes(view, 'className="executor-list"', '执行器视图应使用 executor-list 列表容器（替代卡片网格）');
    expectIncludes(view, 'const [expanded, setExpanded] = useState<Set<number>>(new Set());', '应维护展开/折叠状态');
    expectIncludes(view, 'className="executor-log-panel"', '展开后应显示内联日志面板');
    expectIncludes(view, 'className="executor-pulse"', '运行中 plugin 应显示脉冲指示器');
    expectIncludes(view, "pluginRunning ? 'running' : ''", '运行中 plugin 行应加 running 高亮类');
    expectIncludes(view, 'aria-expanded={expanded}', '行头应暴露展开态的可访问属性');
  });

  it('keeps run/stop buttons for shell/process executors alongside the list filter bar', () => {
    const view = source('src', 'renderer', 'components', 'workspace', 'WorkspaceExecutorsView.tsx');

    expectIncludes(view, '{isPlugin ? (', '应按 plugin / shell-process 分支渲染操作按钮');
    expectIncludes(view, "<span>{running ? '停止' : '运行'}</span>", 'shell/process 应保留运行/停止按钮');
    expectIncludes(view, 'filter-tabs', '列表布局应保留筛选栏');
  });
});
