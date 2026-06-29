const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const targetDirs = ['src', 'scripts'];
const checkedExtensions = new Set(['.css', '.js', '.ts', '.tsx']);
const defaultMaxLines = 600;

const fileLimits = new Map([
  // scripts/smoke-test.js: 新增 oh-my-pi 后端 smoke + MCP create_project + 源码断言使行数略超 3000。
  ['scripts/smoke-test.js', 3250],
  // src/loopService.js: 新增脚本 CRUD/运行通道、验收 accept/unaccept 与 MCP 启停配置 IPC 聚合逻辑。
  ['src/loopService.js', 1700],
  // src/loop/agentCliConfig.js: 新增 oh-my-pi 显示名分支（原 699 已贴近上限）使行数略超 700。
  ['src/loop/agentCliConfig.js', 720],
  // src/agentCli.js: 接入 Claude stream-json（flush 打印机 / 最终文本 / session_id 捕获）使行数略超默认 600；新增 oh-my-pi provider 注册、默认命令映射、ompCliArgs 与 spawn 分支使行数略超 640。
  ['src/agentCli.js', 660],
  // src/main.js: 新增 scripts:pickFile 文件选择通道与 source_type 归一化使行数略超 800。
  ['src/main.js', 820],
  ['src/mcpTools.js', 900],
  // src/renderer/types.ts: 新增 ScriptSourceType 类型与 Script/CreateScriptInput/AutoplanApi 来源字段使行数略超 980。
  ['src/renderer/types.ts', 1010],
  // src/renderer/hooks/useWorkspaceController.ts: 新增验收分组、composer 草稿、MCP 配置与脚本视图桥接逻辑。
  ['src/renderer/hooks/useWorkspaceController.ts', 650],
  // src/renderer/components/workspace/ScriptEditorModal.tsx: 新增「内联代码 / 选择文件」来源切换与文件选择 UI 使行数略超默认 600。
  ['src/renderer/components/workspace/ScriptEditorModal.tsx', 660],
  // src/renderer/styles/workspace.css: 新增验收、脚本、MCP 设置面板样式，当前仍集中复用工作区样式入口。
  ['src/renderer/styles/workspace.css', 650],
  ['src/renderer/utils/search.ts', 650],
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
