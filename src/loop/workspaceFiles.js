const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Worker } = require('node:worker_threads');

const WORKSPACE_RUNTIME_DIR = '.autoplan-runtime';
const FILE_HASH_CACHE_LIMIT = 1000;
const fileHashCache = new Map();

function ensureWorkspaceDirs(service, helpers, workspace) {
    for (const dir of ['docs/issues', 'docs/plan', 'docs/progress', 'docs/progress/logs']) {
      fs.mkdirSync(path.join(workspace, dir), { recursive: true });
    }
  }

function scanDirectory(service, helpers, root, workspace, extensions) {
    return scanDirectorySync(root, workspace, extensions);
  }

function scanDirectorySync(root, workspace, extensions) {
    if (!fs.existsSync(root)) return { root, aggregateHash: hashText(''), files: [] };
    const files = [];
    const visit = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          visit(full);
        } else if (entry.isFile() && extensions.includes(path.extname(entry.name).toLowerCase())) {
          const stat = fs.statSync(full);
          files.push({
            path: normalizeRelative(workspace, full),
            hash: hashFile(full, stat),
            size: stat.size,
            modifiedAt: stat.mtime.toISOString(),
          });
        }
      }
    };
    visit(root);
    files.sort((a, b) => a.path.localeCompare(b.path));
    return {
      root,
      aggregateHash: hashText(files.map((file) => `${file.path}|${file.hash}|${file.size}`).join('\n')),
      files,
    };
  }

function scanDirectoryInWorker(root, workspace, extensions) {
    return new Promise((resolve, reject) => {
      const worker = new Worker(resolveScanWorkerPath(), {
        workerData: {
          root,
          workspace,
          extensions,
        },
      });
      worker.once('message', (message) => {
        if (message?.ok) {
          resolve(message.scan);
          return;
        }
        const error = new Error(message?.error?.message || 'Scan worker failed');
        error.stack = message?.error?.stack || error.stack;
        error.code = message?.error?.code;
        reject(error);
      });
      worker.once('error', reject);
      worker.once('exit', (code) => {
        if (code !== 0) reject(new Error(`Scan worker exited with code ${code}`));
      });
    });
  }

function resolveScanWorkerPath() {
    const workerPath = path.join(__dirname, 'scanWorker.js');
    const asarSegment = `${path.sep}app.asar${path.sep}`;
    if (!workerPath.includes(asarSegment)) return workerPath;
    const unpackedPath = workerPath.replace(asarSegment, `${path.sep}app.asar.unpacked${path.sep}`);
    return fs.existsSync(unpackedPath) ? unpackedPath : workerPath;
  }

function saveScan(service, helpers, projectId, type, scan) {
    const { nowIso } = require('../database');
    const files = Array.isArray(scan?.files) ? scan.files : [];
    if (scanFilesUnchanged(service, projectId, type, files)) return false;
    const scannedAt = nowIso();
    const statements = [
      {
        sql: 'DELETE FROM scan_files WHERE project_id = ? AND scan_type = ?',
        params: [projectId, type],
      },
      ...files.map((file) => ({
        sql: `INSERT OR REPLACE INTO scan_files
              (project_id, scan_type, file_path, hash, size, modified_at, scanned_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
        params: [projectId, type, file.path, file.hash, file.size, file.modifiedAt, scannedAt],
      })),
    ];
    if (typeof service.db.runBatch === 'function') {
      service.db.runBatch(statements);
      return true;
    }
    for (const statement of statements) {
      service.db.run(statement.sql, statement.params);
    }
    return true;
  }

function scanFilesUnchanged(service, projectId, type, files) {
  if (!service?.db?.all) return false;
  const existing = service.db.all(
    `SELECT file_path, hash, size, modified_at
       FROM scan_files
      WHERE project_id = ? AND scan_type = ?
      ORDER BY file_path ASC`,
    [projectId, type],
  );
  if (existing.length !== files.length) return false;
  const byPath = new Map(existing.map((file) => [String(file.file_path || ''), file]));
  const seenPaths = new Set();
  for (const file of files) {
    const filePath = String(file.path || '');
    if (seenPaths.has(filePath)) return false;
    seenPaths.add(filePath);
    const current = byPath.get(filePath);
    if (!current) return false;
    if (
      String(current.hash || '') !== String(file.hash || '') ||
      Number(current.size || 0) !== Number(file.size || 0) ||
      String(current.modified_at || '') !== String(file.modifiedAt || '')
    ) {
      return false;
    }
  }
  return true;
}

function workspaceToolEnv(workspace, baseEnv = process.env) {
  const root = path.join(path.resolve(workspace), WORKSPACE_RUNTIME_DIR);
  const dirs = {
    pubCache: path.join(root, 'pub-cache'),
    gradleHome: path.join(root, 'gradle'),
    xdgCache: path.join(root, 'xdg-cache'),
    xdgConfig: path.join(root, 'xdg-config'),
    appData: path.join(root, 'appdata'),
    localAppData: path.join(root, 'localappdata'),
  };
  for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true });

  const env = {
    ...baseEnv,
    AUTOPLAN_RUNTIME_ROOT: root,
    PUB_CACHE: dirs.pubCache,
    FLUTTER_SUPPRESS_ANALYTICS: 'true',
    ...(baseEnv.CI ? { CI: baseEnv.CI } : {}),
    GRADLE_USER_HOME: baseEnv.GRADLE_USER_HOME || dirs.gradleHome,
    XDG_CACHE_HOME: baseEnv.XDG_CACHE_HOME || dirs.xdgCache,
    XDG_CONFIG_HOME: baseEnv.XDG_CONFIG_HOME || dirs.xdgConfig,
  };
  if (!env.APPDATA) env.APPDATA = dirs.appData;
  if (!env.LOCALAPPDATA) env.LOCALAPPDATA = dirs.localAppData;
  return env;
}

function hashFile(filePath, statHint = null) {
  const stat = statHint || fs.statSync(filePath);
  const key = `${path.resolve(filePath)}\0${stat.size}\0${stat.mtimeMs}`;
  if (fileHashCache.has(key)) {
    const cached = fileHashCache.get(key);
    fileHashCache.delete(key);
    fileHashCache.set(key, cached);
    return cached;
  }
  const hash = crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  fileHashCache.set(key, hash);
  trimMap(fileHashCache, FILE_HASH_CACHE_LIMIT);
  return hash;
}

function hashText(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function resolveWorkspaceChildPath(workspace, filePath) {
  const workspaceValue = String(workspace || '').trim();
  const filePathValue = String(filePath || '').trim();
  if (!workspaceValue || !filePathValue) return '';

  const workspaceRoot = path.resolve(workspaceValue);
  const requestedPath = path.resolve(workspaceRoot, filePathValue);
  const relativePath = path.relative(workspaceRoot, requestedPath);
  if (relativePath === '' || (!!relativePath && !relativePath.startsWith('..') && !path.isAbsolute(relativePath))) {
    return requestedPath;
  }
  return '';
}

function resolveWorkspaceCwd(workspace, cwd = '') {
  const workspaceValue = String(workspace || '').trim();
  const rawCwd = String(cwd || '').trim();
  const result = {
    safe: false,
    reason: '',
    cwd: '',
    relativePath: '',
  };
  if (!workspaceValue) return { ...result, reason: 'workspace_empty' };

  const workspaceRoot = path.resolve(workspaceValue);
  const expanded = rawCwd
    ? rawCwd
      .replace(/\$\{workspace\}/g, workspaceRoot)
      .replace(/\$\{workspaceFolder\}/g, workspaceRoot)
    : workspaceRoot;
  const resolvedCwd = path.isAbsolute(expanded)
    ? path.resolve(expanded)
    : path.resolve(workspaceRoot, expanded);
  const relativePath = path.relative(workspaceRoot, resolvedCwd);
  const relativeForCompare = normalizePathForCompare(relativePath);
  const parentPrefix = `..${path.sep}`;
  const insideWorkspace =
    relativeForCompare === '' ||
    (!!relativeForCompare &&
      relativeForCompare !== '..' &&
      !relativeForCompare.startsWith(parentPrefix) &&
      !path.isAbsolute(relativePath));

  result.cwd = resolvedCwd;
  result.relativePath = relativeForCompare === '' ? '' : normalizeRelative(workspaceRoot, resolvedCwd);
  if (!insideWorkspace) return { ...result, reason: 'outside_workspace' };
  return { ...result, safe: true, reason: '' };
}

function resolveSafeAutoPlanIntakePlanPath(workspace, filePath, intakeType, intakeId) {
  const workspaceValue = String(workspace || '').trim();
  const filePathValue = String(filePath || '').trim();
  const normalizedType = intakeType === 'feedback' ? 'feedback' : 'requirement';
  const normalizedId = String(intakeId || '').replace(/[^0-9a-zA-Z_-]/g, '');
  const result = {
    safe: false,
    reason: '',
    filePath: '',
    relativePath: '',
    planDir: '',
    expectedPattern: normalizedId ? `plan_${normalizedType}_${normalizedId}_*.md` : '',
  };
  if (!workspaceValue) return { ...result, reason: 'workspace_empty' };
  if (!filePathValue) return { ...result, reason: 'file_path_empty' };
  if (!normalizedId) return { ...result, reason: 'intake_id_invalid' };

  const workspaceRoot = path.resolve(workspaceValue);
  const planDir = path.resolve(workspaceRoot, 'docs', 'plan');
  const resolvedPath = path.resolve(workspaceRoot, filePathValue);
  const relativeToPlanDir = path.relative(planDir, resolvedPath);
  const relativeToPlanDirForCompare = normalizePathForCompare(relativeToPlanDir);
  const insidePlanDir =
    relativeToPlanDirForCompare !== '' &&
    !relativeToPlanDirForCompare.startsWith('..') &&
    !path.isAbsolute(relativeToPlanDirForCompare);

  result.filePath = resolvedPath;
  result.relativePath = normalizeRelative(workspaceRoot, resolvedPath);
  result.planDir = planDir;
  if (!insidePlanDir) return { ...result, reason: 'outside_docs_plan' };

  const expectedName = new RegExp(`^plan_${escapeRegExp(normalizedType)}_${escapeRegExp(normalizedId)}_.+\\.md$`);
  if (!expectedName.test(path.basename(resolvedPath))) {
    return { ...result, reason: 'filename_mismatch' };
  }
  return { ...result, safe: true, reason: '' };
}

function resolveSafePlanMarkdownPath(workspace, filePath) {
  const workspaceValue = String(workspace || '').trim();
  const filePathValue = String(filePath || '').trim();
  const result = {
    safe: false,
    reason: '',
    filePath: '',
    relativePath: filePathValue,
    planDir: '',
  };
  if (!workspaceValue) return { ...result, reason: 'workspace_empty' };
  if (!filePathValue) return { ...result, reason: 'file_path_empty' };

  const workspaceRoot = path.resolve(workspaceValue);
  const planDir = path.resolve(workspaceRoot, 'docs', 'plan');
  const resolvedPath = path.resolve(workspaceRoot, filePathValue);
  const relativeToPlanDir = path.relative(planDir, resolvedPath);
  const relativeToPlanDirForCompare = normalizePathForCompare(relativeToPlanDir);
  const insidePlanDir =
    relativeToPlanDirForCompare !== '' &&
    !relativeToPlanDirForCompare.startsWith('..') &&
    !path.isAbsolute(relativeToPlanDirForCompare);

  result.filePath = resolvedPath;
  result.relativePath = normalizeRelative(workspaceRoot, resolvedPath);
  result.planDir = planDir;
  if (!insidePlanDir) return { ...result, reason: 'outside_docs_plan' };
  if (path.extname(resolvedPath).toLowerCase() !== '.md') {
    return { ...result, reason: 'not_markdown' };
  }
  return { ...result, safe: true, reason: '' };
}

function resolveSafePlanManifestPath(workspace, filePath) {
  const workspaceValue = String(workspace || '').trim();
  const filePathValue = String(filePath || '').trim();
  const result = {
    safe: false,
    reason: '',
    filePath: '',
    relativePath: filePathValue,
    planDir: '',
  };
  if (!workspaceValue) return { ...result, reason: 'workspace_empty' };
  if (!filePathValue) return { ...result, reason: 'file_path_empty' };

  const workspaceRoot = path.resolve(workspaceValue);
  const planDir = path.resolve(workspaceRoot, 'docs', 'plan');
  const resolvedPath = path.resolve(workspaceRoot, filePathValue);
  const relativeToPlanDir = path.relative(planDir, resolvedPath);
  const relativeToPlanDirForCompare = normalizePathForCompare(relativeToPlanDir);
  const insidePlanDir =
    relativeToPlanDirForCompare !== '' &&
    !relativeToPlanDirForCompare.startsWith('..') &&
    !path.isAbsolute(relativeToPlanDirForCompare);

  result.filePath = resolvedPath;
  result.relativePath = normalizeRelative(workspaceRoot, resolvedPath);
  result.planDir = planDir;
  if (!insidePlanDir) return { ...result, reason: 'outside_docs_plan' };
  if (path.extname(resolvedPath).toLowerCase() !== '.json') {
    return { ...result, reason: 'not_json' };
  }
  return { ...result, safe: true, reason: '' };
}

function resolveSafePlanSpecPath(workspace, filePath) {
  const workspaceValue = String(workspace || '').trim();
  const filePathValue = String(filePath || '').trim();
  const result = {
    safe: false,
    reason: '',
    filePath: '',
    relativePath: filePathValue,
    planDir: '',
    logsDir: '',
  };
  if (!workspaceValue) return { ...result, reason: 'workspace_empty' };
  if (!filePathValue) return { ...result, reason: 'file_path_empty' };

  const workspaceRoot = path.resolve(workspaceValue);
  const planDir = path.resolve(workspaceRoot, 'docs', 'plan');
  const logsDir = path.resolve(workspaceRoot, 'docs', 'progress', 'logs');
  const resolvedPath = path.resolve(workspaceRoot, filePathValue);

  result.filePath = resolvedPath;
  result.relativePath = normalizeRelative(workspaceRoot, resolvedPath);
  result.planDir = planDir;
  result.logsDir = logsDir;

  if (!isResolvedPathInsideDir(planDir, resolvedPath) && !isResolvedPathInsideDir(logsDir, resolvedPath)) {
    return { ...result, reason: 'outside_allowed_plan_spec_dirs' };
  }
  if (path.extname(resolvedPath).toLowerCase() !== '.json') {
    return { ...result, reason: 'not_json' };
  }
  return { ...result, safe: true, reason: '' };
}

function isResolvedPathInsideDir(baseDir, filePath) {
  const relativePath = path.relative(baseDir, filePath);
  const relativeForCompare = normalizePathForCompare(relativePath);
  return relativeForCompare !== '' &&
    !relativeForCompare.startsWith('..') &&
    !path.isAbsolute(relativeForCompare);
}

function normalizeRelative(root, fullPath) {
  return path.relative(root, fullPath).replaceAll(path.sep, '/');
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizePathForCompare(value) {
  return process.platform === 'win32' ? String(value).toLowerCase() : String(value);
}

function workspaceKey(workspace) {
  const value = String(workspace || '').trim();
  if (!value) return '';
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function readSnippet(filePath, maxChars) {
  const limit = Number(maxChars);
  if (!Number.isFinite(limit) || limit <= 0) return '';
  const stat = fs.statSync(filePath);
  const maxBytes = Math.min(stat.size, Math.max(Math.ceil(limit * 4), limit));
  const fd = fs.openSync(filePath, 'r');
  let bytesRead = 0;
  try {
    const buffer = Buffer.allocUnsafe(maxBytes);
    bytesRead = fs.readSync(fd, buffer, 0, maxBytes, 0);
    const text = buffer.subarray(0, bytesRead).toString('utf8');
    return text.length > limit ? `${text.slice(0, limit)}\n...[truncated]` : text;
  } finally {
    fs.closeSync(fd);
  }
}

function tailText(text, maxChars) {
  return text.length > maxChars ? text.slice(text.length - maxChars) : text;
}

function safePart(value) {
  return String(value).replace(/[^A-Za-z0-9_.-]+/g, '_');
}

function timestampForPath() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(
    now.getHours(),
  )}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

/** 规范化用户环境变量为 JSON 串：过滤空名、按 name 去重保序、value 强制为字符串，JSON.stringify 入库。 */
function normalizeEnvVarsJson(envVars) {
  const seen = new Set();
  const entries = [];
  for (const entry of Array.isArray(envVars) ? envVars : []) {
    if (!entry || typeof entry !== 'object') continue;
    const name = String(entry.name ?? '').trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    entries.push({ name, value: String(entry.value ?? '') });
  }
  return JSON.stringify(entries);
}

function trimMap(map, limit) {
  while (map.size > limit) map.delete(map.keys().next().value);
}

module.exports = {
  ensureWorkspaceDirs,
  hashFile,
  hashText,
  normalizeEnvVarsJson,
  normalizeRelative,
  readSnippet,
  resolveSafeAutoPlanIntakePlanPath,
  resolveSafePlanMarkdownPath,
  resolveSafePlanManifestPath,
  resolveSafePlanSpecPath,
  resolveWorkspaceCwd,
  resolveWorkspaceChildPath,
  safePart,
  saveScan,
  scanDirectory,
  scanDirectoryInWorker,
  scanDirectorySync,
  tailText,
  timestampForPath,
  WORKSPACE_RUNTIME_DIR,
  workspaceKey,
  workspaceToolEnv,
};
