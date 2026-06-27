const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const targetDirs = ['src', 'scripts'];
const checkedExtensions = new Set(['.css', '.js', '.ts', '.tsx']);
const defaultMaxLines = 600;

const fileLimits = new Map([
  ['scripts/smoke-test.js', 2500],
  ['src/loopService.js', 1300],
  ['src/main.js', 650],
  ['src/mcpTools.js', 900],
  ['src/renderer/types.ts', 800],
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
