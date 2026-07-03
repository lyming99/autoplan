'use strict';

/**
 * 共享文件访问策略模块（需求 #35）。
 *
 * 统一收敛散落在 chatTools.js / main.js 的 3 处重复 isInsidePath，集中管理
 * 文件读取类入口（read_file / search_files / workspace:openFile / plans:read）
 * 的访问边界。配置存储于全局 settings 表，键名统一带 fileAccess. 前缀。
 *
 * 安全模型：
 * - 默认 scope=project，仅允许当前项目工作区内部（与历史行为一致）。
 * - scope=custom 或 allowCrossProject=true 时，工作区 ∪ allowedRoots 白名单放行。
 * - scope=all 时不做应用层限制（仍受 OS 权限约束，UI 须显著风险提示）。
 * - 边界判定基于 realpath（符号链接穿透后），避免软链逃逸。
 *
 * 注意：docs/plan 写入路径（workspaceFiles.js 的 resolveSafeAutoPlanIntakePlanPath）
 * 刻意保持工作区锁定，不在本模块放宽范围内。
 */

const fs = require('node:fs');
const path = require('node:path');

/* ------------------------------------------------------------------ 常量与默认值 ------------------------------------------------------------------ */

/** 配置键：访问范围枚举 */
const FILE_ACCESS_SCOPE_KEY = 'fileAccess.scope';
/** 配置键：是否允许跨项目访问（布尔） */
const ALLOW_CROSS_PROJECT_KEY = 'fileAccess.allowCrossProject';
/** 配置键：白名单根目录（JSON 数组字符串） */
const ALLOWED_ROOTS_KEY = 'fileAccess.allowedRoots';

/** 合法的 scope 枚举值 */
const VALID_FILE_ACCESS_SCOPES = Object.freeze(['project', 'workspace', 'custom', 'all']);
const FILE_ACCESS_SCOPE_SET = new Set(VALID_FILE_ACCESS_SCOPES);

/** 默认值（与方案一致：默认安全） */
const DEFAULT_FILE_ACCESS_SCOPE = 'project';
const DEFAULT_ALLOW_CROSS_PROJECT = false;
const DEFAULT_ALLOWED_ROOTS = Object.freeze([]);

/** 越界错误码（统一码；调用方可按需映射回旧 errorCode 以保持前端兼容） */
const FILE_PATH_OUTSIDE_SCOPE_CODE = 'FILE_PATH_OUTSIDE_SCOPE';

/**
 * 返回默认的文件访问设置快照（供 IPC/UI 回填与回退使用）。
 * @returns {{scope:string, allowCrossProject:boolean, allowedRoots:string[]}}
 */
function defaultFileAccessSettings() {
  return {
    scope: DEFAULT_FILE_ACCESS_SCOPE,
    allowCrossProject: DEFAULT_ALLOW_CROSS_PROJECT,
    allowedRoots: [],
  };
}

/* ------------------------------------------------------------------ 路径工具（统一版，消除 chatTools/main.js 重复） ------------------------------------------------------------------ */

/**
 * 平台相关的大小写归一化：Windows 下路径不区分大小写，比较前统一转小写。
 * @param {string} value
 * @returns {string}
 */
function normalizePathForCompare(value) {
  return process.platform === 'win32' ? String(value).toLowerCase() : String(value);
}

/**
 * realpath 容错：成功返回符号链接穿透后的真实路径；失败（不存在/无权限）回退到入参。
 * 保持同步，便于在工具构造期与同步校验路径中使用。
 * @param {string} target
 * @returns {string}
 */
function realpathSafe(target) {
  try {
    return fs.realpathSync(target);
  } catch {
    return target;
  }
}

/**
 * 统一版 isInsidePath：判定 targetPath 是否位于 rootPath 内部（含 rootPath 自身）。
 * 基于 path.resolve / path.relative 的词法边界判定（与历史实现等价）。
 * 调用方如需防软链逃逸，应先对 root/target 做 realpath 再传入，或直接使用 isPathAllowed。
 * @param {string} rootPath
 * @param {string} targetPath
 * @returns {boolean}
 */
function isInsidePath(rootPath, targetPath) {
  const resolvedRoot = normalizePathForCompare(path.resolve(rootPath));
  const resolvedTarget = normalizePathForCompare(path.resolve(targetPath));
  const rel = path.relative(resolvedRoot, resolvedTarget);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

/* ------------------------------------------------------------------ 配置解析 ------------------------------------------------------------------ */

/**
 * 将存储中的 scope 值归一化为合法枚举；非法值回退为默认（project）。
 * workspace 在单根 AutoPlan 项目中等同 project，保留枚举以对齐 API 与未来多根。
 * @param {string} raw
 * @returns {string}
 */
function normalizeScope(raw) {
  const value = String(raw || '').trim().toLowerCase();
  return FILE_ACCESS_SCOPE_SET.has(value) ? value : DEFAULT_FILE_ACCESS_SCOPE;
}

/**
 * 将存储中的布尔值字符串解析为布尔。
 * @param {string} raw
 * @returns {boolean}
 */
function parseBooleanSetting(raw) {
  return String(raw || '').trim().toLowerCase() === 'true';
}

/**
 * 安全解析 allowedRoots 白名单。
 * - 接受 JSON 数组字符串或已是数组的值；
 * - 仅保留非空字符串项；
 * - path.resolve 规范化为绝对路径；
 * - realpath 容错（不存在则保留 resolve 后路径）；
 * - 去重（按归一化后的路径）；
 * - 任何非法输入（非数组、JSON 解析失败等）返回 []。
 * @param {string|string[]|null|undefined} rawJson
 * @returns {string[]}
 */
function parseAllowedRoots(rawJson) {
  if (rawJson == null) return [];
  let list;
  if (Array.isArray(rawJson)) {
    list = rawJson;
  } else {
    const text = String(rawJson).trim();
    if (!text) return [];
    try {
      list = JSON.parse(text);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(list)) return [];

  const seen = new Set();
  const roots = [];
  for (const item of list) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (!trimmed) continue;
    const resolved = path.resolve(trimmed);
    const real = realpathSafe(resolved);
    const key = normalizePathForCompare(real);
    if (seen.has(key)) continue;
    seen.add(key);
    roots.push(real);
  }
  return roots;
}

/**
 * 从全局 settings 表解析并归一化出文件访问策略。
 *
 * @param {{db?:object, workspacePath?:string}} deps
 * @returns {{scope:string, allowCrossProject:boolean, allowedRoots:string[], effectiveRoots:string[], unrestricted:boolean}}
 */
function resolveFileAccessPolicy({ db, workspacePath } = {}) {
  // 防御性读取：测试或未注入 db 时回退默认值
  const getSetting = (key, fallback) =>
    db && typeof db.getSetting === 'function' ? db.getSetting(key, fallback) : fallback;

  const scope = normalizeScope(getSetting(FILE_ACCESS_SCOPE_KEY, DEFAULT_FILE_ACCESS_SCOPE));
  const allowCrossProject = parseBooleanSetting(
    getSetting(ALLOW_CROSS_PROJECT_KEY, String(DEFAULT_ALLOW_CROSS_PROJECT)),
  );
  const allowedRoots = parseAllowedRoots(getSetting(ALLOWED_ROOTS_KEY, '[]'));

  const unrestricted = scope === 'all';
  // custom 或显式开启跨项目 → 工作区 ∪ 白名单；否则仅工作区
  const allowExtraRoots = scope === 'custom' || allowCrossProject === true;

  const workspaceRoot = realpathSafe(path.resolve(workspacePath || '.'));

  const candidateRoots = allowExtraRoots ? [workspaceRoot, ...allowedRoots] : [workspaceRoot];
  const seen = new Set();
  const effectiveRoots = [];
  for (const root of candidateRoots) {
    if (!root) continue;
    const key = normalizePathForCompare(root);
    if (seen.has(key)) continue;
    seen.add(key);
    effectiveRoots.push(root);
  }

  return { scope, allowCrossProject, allowedRoots, effectiveRoots, unrestricted };
}

/* ------------------------------------------------------------------ 边界判定 ------------------------------------------------------------------ */

/**
 * 判定目标路径是否在策略允许范围内。
 *
 * 基于 realpath 做边界判定：先尝试 realpathSync 穿透符号链接（target 存在时），
 * 再与 effectiveRoots（已 realpath 容错）逐一做 isInsidePath 比对。
 * target 不存在时回退到 resolve 后的词法路径，仍与 roots 比对（拒绝越界）。
 *
 * - unrestricted（scope=all）恒为 true；
 * - 无有效根时恒为 false（安全默认，不会误放行）。
 *
 * @param {string} targetPath
 * @param {{effectiveRoots?:string[], unrestricted?:boolean}} policy
 * @returns {boolean}
 */
function isPathAllowed(targetPath, policy) {
  if (!policy || policy.unrestricted) return true;
  const roots = Array.isArray(policy.effectiveRoots) ? policy.effectiveRoots : [];
  if (roots.length === 0) return false;

  const resolvedTarget = path.resolve(targetPath);
  const target = realpathSafe(resolvedTarget);
  return roots.some((root) => isInsidePath(root, target));
}

/**
 * 断言目标路径允许访问；否则抛出带 code 的错误对象。
 *
 * @param {string} targetPath
 * @param {{effectiveRoots?:string[], unrestricted?:boolean}} policy
 * @returns {true}
 * @throws {{message:string, code:string}} 越界时抛出 code 为 FILE_PATH_OUTSIDE_SCOPE 的错误
 */
function assertPathAllowed(targetPath, policy) {
  if (isPathAllowed(targetPath, policy)) return true;
  const err = new Error('文件路径超出允许的访问范围，拒绝访问');
  err.code = FILE_PATH_OUTSIDE_SCOPE_CODE;
  throw err;
}

/* ------------------------------------------------------------------ 导出 ------------------------------------------------------------------ */

module.exports = {
  // 配置键与常量
  FILE_ACCESS_SCOPE_KEY,
  ALLOW_CROSS_PROJECT_KEY,
  ALLOWED_ROOTS_KEY,
  VALID_FILE_ACCESS_SCOPES,
  FILE_ACCESS_SCOPE_SET,
  DEFAULT_FILE_ACCESS_SCOPE,
  DEFAULT_ALLOW_CROSS_PROJECT,
  DEFAULT_ALLOWED_ROOTS,
  FILE_PATH_OUTSIDE_SCOPE_CODE,
  // 配置解析
  defaultFileAccessSettings,
  resolveFileAccessPolicy,
  parseAllowedRoots,
  normalizeScope,
  parseBooleanSetting,
  // 路径工具与边界判定
  normalizePathForCompare,
  realpathSafe,
  isInsidePath,
  isPathAllowed,
  assertPathAllowed,
};
