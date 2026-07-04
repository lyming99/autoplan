export {};

type TestRegistrar = (name: string, fn: () => void) => void;

declare function require(id: string): unknown;
declare const process: { cwd(): string };

const { describe, it } = require('node:test') as { describe: TestRegistrar; it: TestRegistrar };
const { readFileSync } = require('node:fs') as { readFileSync: (path: string, encoding: string) => string };
const { join } = require('node:path') as { join: (...parts: string[]) => string };

type DependencyManifest = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

type PackageLockEntry = {
  version?: string;
  dependencies?: Record<string, string>;
  dev?: boolean;
};

type PackageLockFile = {
  packages?: Record<string, PackageLockEntry>;
};

const XTERM_RUNTIME_DEPENDENCIES = [
  { name: '@xterm/addon-fit', range: '^0.11.0', lockedVersion: '0.11.0' },
  { name: '@xterm/xterm', range: '^6.0.0', lockedVersion: '6.0.0' },
];

function source(...parts: string[]) {
  return readFileSync(join(process.cwd(), ...parts), 'utf8');
}

function jsonSource<T>(...parts: string[]) {
  return JSON.parse(source(...parts)) as T;
}

function expect(condition: unknown, message: string) {
  if (!condition) throw new Error(message);
}

function expectIncludes(sourceText: string, snippet: string, message: string) {
  expect(sourceText.includes(snippet), message);
}

function expectNotIncludes(sourceText: string, snippet: string, message: string) {
  expect(!sourceText.includes(snippet), message);
}

describe('WorkspaceTerminalView regression', () => {
  it('keeps xterm.js rendering wired to the terminal hook and project sessions', () => {
    const view = source('src', 'renderer', 'components', 'workspace', 'WorkspaceTerminalView.tsx');

    expectIncludes(view, "import { FitAddon } from '@xterm/addon-fit';", '终端视图应加载 xterm fit addon');
    expectIncludes(view, "import { Terminal as XTerm } from '@xterm/xterm';", '终端视图应使用 xterm.js');
    expectIncludes(view, "import type { IDisposable } from '@xterm/xterm';", 'xterm 类型导入应保持 type-only');
    expectIncludes(view, "import '@xterm/xterm/css/xterm.css';", '终端视图应引入 xterm CSS');
    expectIncludes(view, 'const terminal = useTerminalSessions({ projectId, initialSessions: terminals, autoRefresh });', '终端视图应通过 hook 管理会话');
    expectIncludes(view, 'const dataDisposable: IDisposable = xterm.onData((data) => {', 'xterm 输入应接入终端写入');
    expectIncludes(view, 'void terminalRef.current.write(activeSession.id, data);', 'xterm 输入应写入当前 PTY 会话');
    expectIncludes(view, 'const unsubscribeData = terminalRef.current.subscribeData(activeSession.id, (data) => {', '后端输出应订阅到当前 xterm');
    expectIncludes(view, 'if (!disposed) xterm.write(data);', '终端输出应写入 xterm 屏幕');
    expectIncludes(view, 'void terminalRef.current.resize(activeSession.id, xterm.cols, xterm.rows);', 'fit 后尺寸应同步到 PTY');
    expectIncludes(view, 'void terminalRef.current.replay(activeSession.id).then((result) => {', '切换会话后应回放历史输出');
  });

  it('keeps xterm runtime dependencies aligned across manifest and lockfile', () => {
    const manifest = jsonSource<DependencyManifest>('package.json');
    const lockfile = jsonSource<PackageLockFile>('package-lock.json');
    const lockRoot = lockfile.packages?.[''];

    expect(lockRoot, 'package-lock 应包含根 package 条目');
    for (const dependency of XTERM_RUNTIME_DEPENDENCIES) {
      expect(
        manifest.dependencies?.[dependency.name] === dependency.range,
        `${dependency.name} 应保留在 dependencies 中`,
      );
      expect(
        manifest.devDependencies?.[dependency.name] === undefined,
        `${dependency.name} 不应移动到 devDependencies`,
      );
      expect(
        lockRoot?.dependencies?.[dependency.name] === dependency.range,
        `${dependency.name} 的 package-lock 根依赖应与 package.json 一致`,
      );

      const lockEntry = lockfile.packages?.[`node_modules/${dependency.name}`];
      expect(lockEntry, `${dependency.name} 应存在 node_modules 锁文件条目`);
      expect(
        lockEntry?.version === dependency.lockedVersion,
        `${dependency.name} 锁文件版本应为 ${dependency.lockedVersion}`,
      );
      expect(lockEntry?.dev !== true, `${dependency.name} 不应被锁定为 dev-only 依赖`);
    }
  });

  it('keeps Vite optimizeDeps configured for xterm imports', () => {
    const viteConfig = source('vite.config.ts');

    expectIncludes(viteConfig, 'optimizeDeps: {', 'Vite 应保留 optimizeDeps 配置');
    expectIncludes(
      viteConfig,
      "include: ['@xterm/xterm', '@xterm/addon-fit'],",
      'Vite optimizeDeps.include 应包含 xterm runtime 包',
    );
  });

  it('persists minimal terminal settings and applies them to creation, rendering, and kill confirmation', () => {
    const view = source('src', 'renderer', 'components', 'workspace', 'WorkspaceTerminalView.tsx');

    expectIncludes(view, 'loadTerminalSettings', '终端视图应读取终端设置');
    expectIncludes(view, 'saveTerminalSettings(projectId, next)', '终端视图应保存终端设置');
    expectIncludes(view, 'terminalCreateInputFromSettings(projectId, terminalSettings, {', '新建终端应通过设置合并 create payload');
    expectIncludes(view, 'cwd: (input.cwd ?? cwdDraft.trim()) || undefined,', '初始 cwd draft 应参与创建终端');
    expectIncludes(view, "profileId: profile.id === 'default' ? undefined : profile.id,", '默认 profile 不应强行传 custom profileId');
    expectIncludes(view, 'fontSize: Number(settings.fontSize || 13)', 'xterm 字号应来自终端设置');
    expectIncludes(view, 'scrollback: Number(settings.scrollbackLimit || 10000)', 'xterm scrollback 应来自终端设置');
    expectIncludes(view, "updateTerminalSettings({ fontSize: event.target.value })", '视图应提供字号设置入口');
    expectIncludes(view, "updateTerminalSettings({ scrollbackLimit: event.target.value })", '视图应提供 scrollback 设置入口');
    expectIncludes(view, "updateTerminalSettings({ retainOnExit: event.target.checked })", '视图应提供退出保留设置入口');
    expectIncludes(view, "updateTerminalSettings({ confirmBeforeKill: event.target.checked })", '视图应提供停止前确认设置入口');
    expectIncludes(view, "if (terminalSettings.confirmBeforeKill && !window.confirm('停止当前终端会话？')) return;", '停止终端应尊重确认设置');
    expectIncludes(view, 'onClose={() => { void terminal.close(session.id); }}', '关闭终端标签应调用后端 close 而不是仅本地隐藏');
    expectIncludes(view, 'title="关闭终端" aria-label="关闭终端"', '关闭按钮文案应说明会关闭终端');
  });

  it('builds visible command shortcuts from package scripts, scripts, and executors without hidden execution', () => {
    const view = source('src', 'renderer', 'components', 'workspace', 'WorkspaceTerminalView.tsx');
    const forms = source('src', 'renderer', 'utils', 'workspaceForms.ts');

    expectIncludes(view, 'scripts?: Script[];', '终端视图 props 应接收 scripts');
    expectIncludes(view, 'executors?: Executor[];', '终端视图 props 应接收 executors');
    expectIncludes(view, 'packageScripts?: TerminalPackageScriptsInput;', '终端视图 props 应接收 package scripts');
    expectIncludes(view, 'const commandShortcuts = useMemo(() => buildTerminalCommandShortcuts({', '终端视图应从当前项目数据构建快捷命令');
    expectIncludes(view, 'packageScripts,', '快捷命令应接入 package scripts');
    expectIncludes(view, 'scripts,', '快捷命令应接入脚本模块');
    expectIncludes(view, 'executors,', '快捷命令应接入执行器模块');
    expectIncludes(view, 'if (shortcut) setCommandDraft(terminalShortcutCommandText(shortcut));', '选择快捷入口应把可见命令写入命令输入框');
    expectIncludes(view, 'await terminal.write(target.id, command);', '插入快捷命令应通过当前终端写入可见文本');
    expectNotIncludes(view, "await terminal.write(target.id, `${command}\\r`);", '插入快捷命令不应隐式回车执行');
    expectNotIncludes(view, 'runExecutor', '终端快捷入口不应调用执行器运行接口');
    expectNotIncludes(view, 'lastStatus', '终端快捷入口不应修改执行器最近状态');

    expectIncludes(forms, 'export function buildTerminalCommandShortcuts(input: {', 'workspaceForms 应提供独立终端快捷命令构造器');
    expectIncludes(forms, '...terminalCommandShortcutsFromPackageScripts(input.packageScripts, input.workspacePath),', '快捷命令应包含 package scripts 来源');
    expectIncludes(forms, '...terminalCommandShortcutsFromScripts(input.scripts, input.workspacePath),', '快捷命令应包含 scripts 来源');
    expectIncludes(forms, '...terminalCommandShortcutsFromExecutors(input.executors, input.workspacePath),', '快捷命令应包含 executors 来源');
    expectIncludes(forms, "if (sourceType !== 'file' || !scriptPath) return null;", '脚本快捷入口应跳过内联脚本，避免隐藏 body 命令');
    expectIncludes(forms, 'command: `npm run ${quoteTerminalArg(item.name)}`', 'package script 快捷入口应生成可见 npm run 命令');
    expectIncludes(forms, 'command: [command, argsText].filter(Boolean).join(\' \')', '执行器快捷入口应拼接可见 command/args');
  });

  it('keeps terminal setting helpers isolated from loop, MCP, and file-access forms', () => {
    const forms = source('src', 'renderer', 'utils', 'workspaceForms.ts');
    const terminalBlockStart = forms.indexOf('/* ===================== 终端配置与快捷命令');
    const terminalBlockEnd = forms.indexOf('/* ===================== 文件访问范围', terminalBlockStart);
    const terminalBlock = forms.slice(terminalBlockStart, terminalBlockEnd);

    expect(terminalBlockStart >= 0 && terminalBlockEnd > terminalBlockStart, '应能定位终端设置独立表单块');
    expectIncludes(terminalBlock, 'export type TerminalSettingsFormState', '终端设置应有独立表单状态');
    expectIncludes(terminalBlock, "export const TERMINAL_SETTINGS_STORAGE_PREFIX = 'autoplan.terminalSettings.';", '终端设置应使用独立 localStorage key 前缀');
    expectIncludes(terminalBlock, 'export function normalizeTerminalSettingsForm', '终端设置应有独立归一化函数');
    expectIncludes(terminalBlock, 'export function terminalCreateInputFromSettings', '终端设置应有独立 create input 合并函数');
    expectNotIncludes(terminalBlock, 'LoopFormState', '终端设置不应污染 loop 表单');
    expectNotIncludes(terminalBlock, 'McpConfigFormState', '终端设置不应污染 MCP 表单');
    expectNotIncludes(terminalBlock, 'FileAccessFormState', '终端设置不应污染文件访问表单');
  });
});
