'use strict';

/**
 * Chat 工具层（需求 #26）：白名单工具注册表与处理器。
 *
 * 安全边界：
 * - 仅注册 5 个只读/安全创建工具，不含 write_file/edit_file/delete_* /run_command/run_script
 * - read_file 经 isInsidePath 校验 + 256KB 截断
 * - search_files 结果上限 50 条 + 5s 超时保护
 * - create_requirement/create_feedback 走 IntakeService（autoRun=true）
 * - create_script 仅 INSERT 落库，不调用 runScript
 */

const fs = require('node:fs');
const path = require('node:path');
const { nowIso } = require('../database');

const READ_FILE_MAX_BYTES = 256 * 1024; // 256KB
const SEARCH_MAX_RESULTS = 50;
const SEARCH_TIMEOUT_MS = 5000;
const SEARCH_CONTENT_SCAN_LIMIT = 200;

/**
 * 获取白名单 Chat 工具定义列表。
 * 外部无法注册额外工具——工具注册表在此函数内闭合。
 *
 * @param {{db:object, projectId:number, workspacePath:string, intakeService:object}} deps
 * @returns {Array<{name:string, description:string, input_schema:object, handler:Function}>}
 */
function getChatToolDefinitions({ db, projectId, workspacePath, intakeService }) {
  if (!workspacePath || !String(workspacePath).trim()) {
    throw new Error('工作区路径为空，无法初始化 Chat 工具');
  }

  return Object.freeze([
    {
      name: 'read_file',
      description:
        '读取项目工作区内的文件内容。返回文件全文（最大 256KB），超出部分自动截断并提示。',
      input_schema: {
        type: 'object',
        properties: {
          filePath: { type: 'string', description: '相对于工作区根目录的文件路径' },
        },
        required: ['filePath'],
      },
      handler: (args) => handleReadFile(workspacePath, args),
    },
    {
      name: 'search_files',
      description:
        '在项目文件中搜索关键词。同时匹配文件路径和文件内容，返回最多 50 条结果，5 秒超时保护。',
      input_schema: {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: '搜索关键词' },
        },
        required: ['keyword'],
      },
      handler: (args) => handleSearchFiles(db, projectId, workspacePath, args),
    },
    {
      name: 'create_requirement',
      description:
        '创建新需求并自动触发计划生成（autoRun=true）。需求将进入循环扫描队列，由 AutoPlan 自动生成执行计划。',
      input_schema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '需求标题（必填）' },
          body: { type: 'string', description: '需求详细描述，支持 Markdown 格式' },
        },
        required: ['title', 'body'],
      },
      handler: (args) => handleCreateRequirement(projectId, intakeService, args),
    },
    {
      name: 'create_feedback',
      description:
        '创建新反馈并自动触发计划生成（autoRun=true）。反馈将进入循环扫描队列，由 AutoPlan 自动生成执行计划。',
      input_schema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '反馈标题（必填）' },
          body: { type: 'string', description: '反馈详细描述，支持 Markdown 格式' },
        },
        required: ['title', 'body'],
      },
      handler: (args) => handleCreateFeedback(projectId, intakeService, args),
    },
    {
      name: 'create_script',
      description:
        '创建新脚本（仅保存到脚本库，不执行）。脚本创建后可在工作区"脚本"页面手动运行或配置定时/钩子触发。',
      input_schema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '脚本名称（必填）' },
          body: { type: 'string', description: '脚本内容（必填）' },
          runtime: {
            type: 'string',
            description: '运行时环境：node（默认）、python、bash、sh',
          },
          description: { type: 'string', description: '脚本描述（可选）' },
        },
        required: ['name', 'body'],
      },
      handler: (args) => handleCreateScript(db, projectId, args),
    },
  ]);
}

/* ------------------------------------------------------------------ read_file ------------------------------------------------------------------ */

function handleReadFile(workspacePath, args) {
  const filePath = String(args.filePath || '').trim();
  if (!filePath) {
    return { error: '缺少 filePath 参数', errorCode: 'MISSING_PARAM' };
  }

  const workspaceRoot = path.resolve(workspacePath);
  let resolvedPath;
  try {
    resolvedPath = path.resolve(workspaceRoot, filePath);
  } catch {
    return { error: '文件路径无效', errorCode: 'INVALID_PATH' };
  }

  if (!isInsidePath(workspaceRoot, resolvedPath)) {
    return { error: '文件路径超出项目工作区，拒绝访问', errorCode: 'FILE_PATH_OUTSIDE_WORKSPACE' };
  }

  let stat;
  try {
    stat = fs.statSync(resolvedPath);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') {
      return { error: '文件不存在', errorCode: 'FILE_NOT_FOUND' };
    }
    return { error: `无法访问文件：${err.message}`, errorCode: 'FILE_ACCESS_ERROR' };
  }

  if (stat.isDirectory()) {
    return { error: '路径指向目录，不能作为文件读取', errorCode: 'FILE_IS_DIRECTORY' };
  }
  if (!stat.isFile()) {
    return { error: '路径不是普通文件，无法读取', errorCode: 'FILE_NOT_REGULAR' };
  }

  const fileSize = stat.size;
  let content;
  let truncated = false;

  try {
    if (fileSize > READ_FILE_MAX_BYTES) {
      const buffer = Buffer.alloc(READ_FILE_MAX_BYTES);
      const fd = fs.openSync(resolvedPath, 'r');
      try {
        fs.readSync(fd, buffer, 0, READ_FILE_MAX_BYTES, 0);
      } finally {
        fs.closeSync(fd);
      }
      content = buffer.toString('utf8');
      truncated = true;
    } else {
      content = fs.readFileSync(resolvedPath, 'utf8');
    }
  } catch (err) {
    return { error: `读取文件失败：${err.message}`, errorCode: 'FILE_READ_ERROR' };
  }

  const result = { content, filePath, fileSize, truncated };
  if (truncated) {
    result.truncationNote = `文件超过 ${READ_FILE_MAX_BYTES / 1024}KB 上限，仅返回前 ${READ_FILE_MAX_BYTES / 1024}KB 内容。`;
  }
  return result;
}

/* ------------------------------------------------------------------ search_files ------------------------------------------------------------------ */

async function handleSearchFiles(db, projectId, workspacePath, args) {
  const keyword = String(args.keyword || '').trim();
  if (!keyword) {
    return { error: '缺少 keyword 参数', errorCode: 'MISSING_PARAM' };
  }

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
  }, SEARCH_TIMEOUT_MS);

  try {
    return await doSearch(db, projectId, workspacePath, keyword, () => timedOut);
  } finally {
    clearTimeout(timer);
  }
}

async function doSearch(db, projectId, workspacePath, keyword, isTimedOut) {
  const results = [];
  const seen = new Set();
  const workspaceRoot = path.resolve(workspacePath);

  // 1. 路径 LIKE 匹配（快速，仅查 DB）
  const pathRows = db.all(
    `SELECT file_path FROM scan_files WHERE project_id = ? AND file_path LIKE ? LIMIT ?`,
    [projectId, `%${keyword}%`, SEARCH_MAX_RESULTS],
  );

  for (const row of pathRows) {
    if (isTimedOut()) break;
    if (seen.has(row.file_path)) continue;
    seen.add(row.file_path);
    results.push({
      filePath: row.file_path,
      matchType: 'path',
      snippet: highlightSnippet(row.file_path, keyword),
    });
    if (results.length >= SEARCH_MAX_RESULTS) return results;
  }

  // 2. 文件内容匹配（较慢，需 fs 读取）
  const allFiles = db.all(
    `SELECT file_path, size FROM scan_files WHERE project_id = ? ORDER BY scanned_at DESC LIMIT ?`,
    [projectId, SEARCH_CONTENT_SCAN_LIMIT],
  );

  for (const row of allFiles) {
    if (isTimedOut()) {
      results.push({
        note: `搜索超时（${SEARCH_TIMEOUT_MS / 1000}s），已返回 ${results.length} 条部分结果。`,
      });
      return results;
    }
    if (results.length >= SEARCH_MAX_RESULTS) break;
    if (seen.has(row.file_path)) continue;

    const absPath = path.join(workspaceRoot, row.file_path);
    if (!fs.existsSync(absPath)) continue;

    // 跳过大文件（>1MB）的内容搜索以避免阻塞
    if (Number(row.size) > 1024 * 1024) continue;

    try {
      const content = fs.readFileSync(absPath, 'utf8');
      if (content.includes(keyword)) {
        seen.add(row.file_path);
        results.push({
          filePath: row.file_path,
          matchType: 'content',
          snippet: extractContentSnippet(content, keyword),
        });
      }
    } catch {
      // 跳过不可读文件
    }
  }

  return results;
}

/* ------------------------------------------------------------------ create_requirement ------------------------------------------------------------------ */

function handleCreateRequirement(projectId, intakeService, args) {
  if (!intakeService) {
    return { error: 'IntakeService 未注入，无法创建需求', errorCode: 'SERVICE_UNAVAILABLE' };
  }

  const title = String(args.title || '').trim();
  const body = String(args.body || '').trim();
  if (!title) {
    return { error: '缺少 title 参数', errorCode: 'MISSING_PARAM' };
  }

  try {
    const snapshot = intakeService.createRequirement({
      projectId,
      title,
      body,
      autoRun: true,
    });

    const requirements = snapshot?.requirements || [];
    const created = requirements[0]; // 按 updated_at DESC 排序，第一条为最新
    if (created) {
      return { id: created.id, title: created.title, status: created.status };
    }
    return { id: null, title, status: 'open', note: '需求已创建，但未在快照中找到确认记录。' };
  } catch (err) {
    return { error: `创建需求失败：${err.message}`, errorCode: 'CREATE_FAILED' };
  }
}

/* ------------------------------------------------------------------ create_feedback ------------------------------------------------------------------ */

function handleCreateFeedback(projectId, intakeService, args) {
  if (!intakeService) {
    return { error: 'IntakeService 未注入，无法创建反馈', errorCode: 'SERVICE_UNAVAILABLE' };
  }

  const title = String(args.title || '').trim();
  const body = String(args.body || '').trim();
  if (!title) {
    return { error: '缺少 title 参数', errorCode: 'MISSING_PARAM' };
  }

  try {
    const snapshot = intakeService.createFeedback({
      projectId,
      title,
      body,
      autoRun: true,
    });

    const feedbackList = snapshot?.feedback || [];
    const created = feedbackList[0]; // 按 updated_at DESC 排序，第一条为最新
    if (created) {
      return { id: created.id, title: created.title, status: created.status };
    }
    return { id: null, title, status: 'open', note: '反馈已创建，但未在快照中找到确认记录。' };
  } catch (err) {
    return { error: `创建反馈失败：${err.message}`, errorCode: 'CREATE_FAILED' };
  }
}

/* ------------------------------------------------------------------ create_script ------------------------------------------------------------------ */

function handleCreateScript(db, projectId, args) {
  const name = String(args.name || '').trim();
  if (!name) {
    return { error: '脚本名称不能为空', errorCode: 'MISSING_PARAM' };
  }

  const body = String(args.body || '');
  const runtime = normalizeScriptRuntime(args.runtime);
  const description = String(args.description || '').trim();
  const now = nowIso();

  try {
    const id = db.insert(
      `INSERT INTO scripts
       (project_id, name, path, runtime, body, description, trigger_mode, enabled, work_dir, timeout_seconds, fail_aborts, context_inject, sort_order, source_type, created_at, updated_at)
       VALUES (?, ?, '', ?, ?, ?, 'manual', 1, '', 60, 0, 'none', 0, 'inline', ?, ?)`,
      [projectId, name, runtime, body, description, now, now],
    );
    return { id, name, runtime };
  } catch (err) {
    return { error: `创建脚本失败：${err.message}`, errorCode: 'CREATE_FAILED' };
  }
}

function normalizeScriptRuntime(value) {
  const v = String(value || '').trim().toLowerCase();
  const allowed = ['node', 'python', 'bash', 'sh'];
  return allowed.includes(v) ? v : 'node';
}

/* ------------------------------------------------------------------ 路径校验（与 main.js isInsidePath 同逻辑） ------------------------------------------------------------------ */

function isInsidePath(rootPath, targetPath) {
  const resolvedRoot = normalizePathForCompare(path.resolve(rootPath));
  const resolvedTarget = normalizePathForCompare(path.resolve(targetPath));
  const rel = path.relative(resolvedRoot, resolvedTarget);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

function normalizePathForCompare(value) {
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

/* ------------------------------------------------------------------ search 辅助 ------------------------------------------------------------------ */

function highlightSnippet(filePath, keyword) {
  const lowerPath = filePath.toLowerCase();
  const lowerKeyword = keyword.toLowerCase();
  const idx = lowerPath.indexOf(lowerKeyword);
  if (idx < 0) return filePath.slice(0, 200);
  const start = Math.max(0, idx - 20);
  const prefix = start > 0 ? '…' : '';
  const end = Math.min(filePath.length, idx + keyword.length + 40);
  return prefix + filePath.slice(start, end);
}

function extractContentSnippet(content, keyword) {
  const lowerContent = content.toLowerCase();
  const lowerKeyword = keyword.toLowerCase();
  const lines = content.split('\n');
  const matchLine = lines.find((l) => l.toLowerCase().includes(lowerKeyword));
  if (!matchLine) {
    // 回退：找关键词在全文中的位置
    const idx = lowerContent.indexOf(lowerKeyword);
    if (idx < 0) return '';
    const start = Math.max(0, idx - 50);
    return content.slice(start, idx + keyword.length + 100).replace(/\s+/g, ' ').trim();
  }
  return matchLine.trim().slice(0, 300);
}

module.exports = { getChatToolDefinitions };
