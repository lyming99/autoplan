const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Worker } = require('node:worker_threads');

const WORKSPACE_RUNTIME_DIR = '.autoplan-runtime';

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
            hash: hashFile(full),
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
    const scannedAt = nowIso();
    const statements = [
      {
        sql: 'DELETE FROM scan_files WHERE project_id = ? AND scan_type = ?',
        params: [projectId, type],
      },
      ...scan.files.map((file) => ({
        sql: `INSERT OR REPLACE INTO scan_files
              (project_id, scan_type, file_path, hash, size, modified_at, scanned_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
        params: [projectId, type, file.path, file.hash, file.size, file.modifiedAt, scannedAt],
      })),
    ];
    if (typeof service.db.runBatch === 'function') {
      service.db.runBatch(statements);
      return;
    }
    for (const statement of statements) {
      service.db.run(statement.sql, statement.params);
    }
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
    CI: baseEnv.CI || 'true',
    GRADLE_USER_HOME: baseEnv.GRADLE_USER_HOME || dirs.gradleHome,
    XDG_CACHE_HOME: baseEnv.XDG_CACHE_HOME || dirs.xdgCache,
    XDG_CONFIG_HOME: baseEnv.XDG_CONFIG_HOME || dirs.xdgConfig,
  };
  if (!env.APPDATA) env.APPDATA = dirs.appData;
  if (!env.LOCALAPPDATA) env.LOCALAPPDATA = dirs.localAppData;
  return env;
}

function hashFile(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
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
  const text = fs.readFileSync(filePath, 'utf8');
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n...[truncated]` : text;
}

function tailText(text, maxChars) {
  return text.length > maxChars ? text.slice(text.length - maxChars) : text;
}

function safePart(value) {
  return String(value).replace(/[^A-Za-z0-9_.-]+/g, '_');
}

module.exports = {
  ensureWorkspaceDirs,
  hashFile,
  hashText,
  normalizeRelative,
  readSnippet,
  resolveSafeAutoPlanIntakePlanPath,
  resolveWorkspaceChildPath,
  safePart,
  saveScan,
  scanDirectory,
  scanDirectoryInWorker,
  scanDirectorySync,
  tailText,
  WORKSPACE_RUNTIME_DIR,
  workspaceKey,
  workspaceToolEnv,
};
