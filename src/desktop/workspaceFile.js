'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn: defaultSpawn } = require('node:child_process');
const {
  assertPathAllowed,
  normalizePathForCompare,
  normalizeScope,
  parseAllowedRoots,
  realpathSafe,
} = require('../fileAccess/policy');

async function openWorkspaceFileFromRuntime(options = {}) {
  const projectId = Number(options.projectId || 0);
  const requestedPath = String(options.filePath || options.path || '').trim();
  if (!Number.isSafeInteger(projectId) || projectId <= 0) return openResult(false, '项目不存在');
  if (!requestedPath) return openResult(false, '文件路径为空');

  try {
    if (typeof options.loadProject !== 'function') throw new Error('无法读取项目工作区路径');
    if (typeof options.loadFilePolicy !== 'function') throw new Error('无法读取文件访问策略');

    const project = await options.loadProject(projectId);
    const workspacePath = String(project?.workspace_path || project?.workspacePath || '').trim();
    if (!workspacePath) throw new Error('项目工作区路径为空');

    const loadedPolicy = await options.loadFilePolicy({ projectId, project, workspacePath });
    const policy = materializeFileAccessPolicy(loadedPolicy, workspacePath);
    const filePath = await resolveWorkspaceFilePath(workspacePath, requestedPath, policy);
    const mode = normalizeOpenFileMode(options.mode);
    await openResolvedFilePath(filePath, mode, String(options.command || '').trim(), options);
    return openResult(true, '', { filePath, mode });
  } catch (error) {
    return openResult(false, openFileErrorMessage(error));
  }
}

function materializeFileAccessPolicy(loadedPolicy, workspacePath) {
  if (!loadedPolicy || typeof loadedPolicy !== 'object') {
    throw new Error('无法读取文件访问策略');
  }
  if (Array.isArray(loadedPolicy.effectiveRoots) || loadedPolicy.unrestricted === true) {
    return loadedPolicy;
  }

  const scope = normalizeScope(loadedPolicy.scope);
  const allowCrossProject = loadedPolicy.allowCrossProject === true
    || loadedPolicy.allow_cross_project === true;
  const allowedRoots = parseAllowedRoots(
    loadedPolicy.allowedRoots ?? loadedPolicy.allowed_roots ?? [],
  );
  const workspaceRoot = realpathSafe(path.resolve(workspacePath));
  const candidates = scope === 'custom' || allowCrossProject
    ? [workspaceRoot, ...allowedRoots]
    : [workspaceRoot];
  const seen = new Set();
  const effectiveRoots = candidates.filter((root) => {
    const key = normalizePathForCompare(root);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { scope, allowCrossProject, allowedRoots, effectiveRoots, unrestricted: scope === 'all' };
}

async function resolveWorkspaceFilePath(workspacePath, filePath, policy) {
  const workspaceRoot = path.resolve(workspacePath);
  const requestedPath = path.resolve(workspaceRoot, filePath);
  assertPathAllowed(requestedPath, policy);

  try {
    await fs.promises.realpath(workspaceRoot);
  } catch {
    throw codedError('WORKSPACE_UNAVAILABLE', '项目工作区不存在或无法访问');
  }

  let fileRealPath;
  try {
    fileRealPath = await fs.promises.realpath(requestedPath);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
      throw codedError('FILE_NOT_FOUND', '文件不存在');
    }
    throw error;
  }
  assertPathAllowed(fileRealPath, policy);

  const stat = await fs.promises.stat(fileRealPath);
  if (stat.isDirectory()) throw codedError('FILE_IS_DIRECTORY', '路径指向目录，不能作为文件打开');
  if (!stat.isFile()) throw codedError('FILE_NOT_REGULAR', '路径不是普通文件');
  return fileRealPath;
}

async function openResolvedFilePath(filePath, mode, command, options) {
  const shell = options.shell;
  if (!shell) throw new Error('文件打开服务不可用');
  if (mode === 'folder') {
    if (typeof shell.showItemInFolder !== 'function') throw new Error('文件打开服务不可用');
    shell.showItemInFolder(filePath);
    return;
  }
  if (mode === 'vscode') {
    await runOpenCommand(command || 'code', [filePath], options);
    return;
  }
  if (mode === 'command') {
    if (!command) throw codedError('OPEN_COMMAND_MISSING', '第三方编辑器命令未配置');
    await runOpenCommand(command, [filePath], options, command.includes('{file}'));
    return;
  }
  if (typeof shell.openPath !== 'function') throw new Error('文件打开服务不可用');
  const error = await shell.openPath(filePath);
  if (error) throw codedError('OPEN_FILE_FAILED', error);
}

function runOpenCommand(command, args, options, template = false) {
  const spawn = options.spawn || defaultSpawn;
  const spawnCommand = template ? command.replaceAll('{file}', shellQuote(args[0])) : command;
  const spawnArgs = template ? [] : args;
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(spawnCommand, spawnArgs, {
        detached: true,
        stdio: 'ignore',
        shell: (options.platform || process.platform) === 'win32' || template,
      });
    } catch (error) {
      reject(codedError('OPEN_COMMAND_FAILED', error?.message || '编辑器命令启动失败'));
      return;
    }
    child.once('error', (error) => {
      reject(codedError('OPEN_COMMAND_FAILED', error?.message || '编辑器命令启动失败'));
    });
    child.once('spawn', () => {
      child.unref?.();
      resolve();
    });
  });
}

function normalizeOpenFileMode(value) {
  const mode = String(value || '').trim().toLowerCase();
  return mode === 'folder' || mode === 'vscode' || mode === 'command' ? mode : 'system';
}

function shellQuote(value) {
  return `"${String(value || '').replace(/"/g, '\\"')}"`;
}

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function openFileErrorMessage(error) {
  if (error?.code === 'EACCES' || error?.code === 'EPERM') return '文件无法打开，请检查权限';
  return error?.message || '文件打开失败';
}

function openResult(ok, error, extra = {}) {
  return { ok, error: error || null, ...extra };
}

module.exports = {
  materializeFileAccessPolicy,
  normalizeOpenFileMode,
  openWorkspaceFileFromRuntime,
  resolveWorkspaceFilePath,
};
