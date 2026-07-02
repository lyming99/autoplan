const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const targetDirs = ['src', 'scripts'];
const checkedExtensions = new Set(['.css', '.js', '.ts', '.tsx']);
const defaultMaxLines = 600;

const fileLimits = new Map([
  // scripts/smoke-test.js: agent 后端场景（codex/claude/opencode/oh-my-pi session 复用、反馈回归）集中在此，
  // 与共享 fixture/spawn 断言 helper 深度耦合，跨文件拆分风险高、收益低，暂整体保留并放宽上限。
  // 需求 #24 新增 assertUpdateCheckerIpcSmoke（updates:* IPC 结构/落库 + shell:openExternal 校验）使行数略超 3650。
  // v0.2.3-beta.1 追加聊天/AI 配置 smoke 覆盖后临时放宽。
  ['scripts/smoke-test.js', 3800],
  // src/loopService.js: 验收/需求删除/计划生命周期/agent-CLI 配置等逻辑已抽离到 src/loop/*.js，仅保留调度核心。
  // 反馈 #14：新增 OpenCode 计划生成专用 agent 落盘（ensureOpenCodePlanAgent）与 isOpenCodePlanGenerationOperation 判定，使行数略超 1700。
  ['src/loopService.js', 1740],
  // src/loop/agentCliConfig.js: 新增 oh-my-pi 显示名分支（原 699 已贴近上限）使行数略超 700。
  ['src/loop/agentCliConfig.js', 720],
  // src/agentCli.js: 接入 Claude stream-json（flush 打印机 / 最终文本 / session_id 捕获）使行数略超默认 600；新增 oh-my-pi provider 注册、默认命令映射、ompCliArgs 与 spawn 分支使行数略超 640；
  // 新增 createChunkDecoder（GBK/UTF-8 容错解码）、OpenCode 长 prompt spillover（落盘 + -f 投递，区分 cmd.exe 8191 与 CreateProcess 32767 上限）使行数接近 800。
  // 反馈 #14：新增 OpenCode 计划生成专用 agent 注入（normalizeOpenCodeAgentName + opencodeCliArgs/agentCliSpawnSpec 透传 --agent）与长 prompt spillover 权威指针指令，使行数略超 810。
  ['src/agentCli.js', 840],
  // src/main.js: 新增 scripts:pickFile 文件选择通道与 source_type 归一化使行数略超 800；
  // 需求 #24 新增正式版本更新检查（updates:* IPC 注册 + 调度/退出清理/状态广播辅助）使行数接近 890。
  // v0.2.3-beta.1 新增全局 AI 配置与多会话 IPC 桥接，后续需要继续抽离主进程处理器。
  ['src/main.js', 1300],
  ['src/mcpTools.js', 900],
  // src/renderer/types.ts: 新增 ScriptSourceType 类型与 Script/CreateScriptInput/AutoplanApi 来源字段使行数略超 980；
  // 需求 #24 新增正式版本更新检查类型（UpdateStatus/UpdateLatestRelease/UpdateCheckResult）与 AutoplanApi 方法使行数接近 1050。
  // v0.2.3-beta.1 新增聊天会话、AI 配置与搜索结果类型，暂放宽到当前规模。
  ['src/renderer/types.ts', 1300],
  // src/renderer/hooks/useWorkspaceController.ts: 新增验收分组、composer 草稿、MCP 配置与脚本视图桥接逻辑。
  ['src/renderer/hooks/useWorkspaceController.ts', 650],
  // src/renderer/components/workspace/ScriptEditorModal.tsx: 新增「内联代码 / 选择文件」来源切换与文件选择 UI 使行数略超默认 600。
  ['src/renderer/components/workspace/ScriptEditorModal.tsx', 660],
  // src/renderer/components/workspace/AcceptanceView.tsx: 反馈 #15 验收视图重构为「待验收」「已完成验收」两个同时可见的一级区块，
  // 新增 AcceptedPlanCard 计划卡与已验收任务行（逐项/批量取消验收、多选、折叠），使行数略超默认 600。
  ['src/renderer/components/workspace/AcceptanceView.tsx', 720],
  // src/renderer/styles/workspace.css: 新增验收、脚本、MCP 设置面板样式，当前仍集中复用工作区样式入口。
  // v0.2.3-beta.1 设置页、聊天页、侧栏与搜索弹层样式继续集中在工作区样式入口。
  ['src/renderer/styles/workspace.css', 2400],
  ['src/renderer/utils/search.ts', 650],
  // v0.2.3-beta.1 集中提交聊天多会话、AI 配置与 UI 回归测试，先记录显式上限，避免守卫隐式失败。
  ['src/chat/chatController.test.js', 1600],
  ['src/chat/aiConfigService.test.js', 640],
  ['src/chat/chatTools.test.js', 820],
  ['src/chat/chatController.js', 850],
  ['src/database.js', 780],
  ['src/renderer/components/workspace/WorkspaceSettingsView.tsx', 1050],
  ['src/renderer/components/workspace/ChatView.tsx', 750],
  ['src/renderer/hooks/useChat.ts', 800],
  ['src/renderer/pages/WorkspacePage.test.tsx', 950],
  ['src/renderer/pages/WorkspacePage.tsx', 680],
  ['src/renderer/utils/workspaceForms.ts', 830],
]);

const ignoredDirs = new Set(['.git', 'dist', 'node_modules', 'release']);

function toPosixPath(filePath) {
  return filePath.split(path.sep).join('/');
}

function listFiles(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (ignoredDirs.has(entry.name)) return [];
      return listFiles(fullPath);
    }
    if (!entry.isFile() || !checkedExtensions.has(path.extname(entry.name))) return [];
    return [fullPath];
  });
}

function countLines(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  if (!content) return 0;
  return content.split(/\r?\n/).length - (content.endsWith('\n') ? 1 : 0);
}

const files = targetDirs.flatMap((dir) => listFiles(path.join(rootDir, dir)));
const violations = files
  .map((filePath) => {
    const relativePath = toPosixPath(path.relative(rootDir, filePath));
    const maxLines = fileLimits.get(relativePath) || defaultMaxLines;
    return { relativePath, lines: countLines(filePath), maxLines };
  })
  .filter((item) => item.lines > item.maxLines)
  .sort((left, right) => right.lines - left.lines || left.relativePath.localeCompare(right.relativePath));

if (violations.length) {
  console.error('File length check failed:');
  for (const item of violations) {
    console.error(`- ${item.relativePath}: ${item.lines} lines (limit ${item.maxLines})`);
  }
  process.exit(1);
}

console.log(`File length check passed for ${files.length} files.`);
