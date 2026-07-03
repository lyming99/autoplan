'use strict';

/**
 * Chat 工具层（需求 #26）：白名单工具注册表与处理器。
 *
 * 安全边界：
 * - 仅注册 5 个只读/安全创建工具，不含 write_file/edit_file/delete_* /run_command/run_script
 * - read_file 经共享访问策略（fileAccess/policy）校验 + 256KB 截断
 * - search_files 结果上限 50 条 + 5s 超时保护
 * - create_requirement/create_feedback 走 IntakeService（autoRun=true）
 * - create_script 仅 INSERT 落库，不调用 runScript
 */

const fs = require('node:fs');
const path = require('node:path');
const { nowIso } = require('../database');
const { resolveFileAccessPolicy, isPathAllowed, assertPathAllowed } = require('../fileAccess/policy');

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
      handler: (args) => handleReadFile(db, workspacePath, args),
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
    {
      name: 'open_requirement',
      description:
        '打开/查看指定需求并返回详情（标题、正文、状态、绑定执行计划）。可按 id（精确）或 title（模糊包含）定位；多命中时返回最近更新的一条。结果含 openable 入口，供对话直接查看或在卡片打开。',
      input_schema: {
        type: 'object',
        description: 'id 与 title 至少二选一。',
        properties: {
          id: { type: 'integer', description: '需求 ID（精确匹配，正整数）' },
          title: { type: 'string', description: '需求标题关键词（模糊包含，title LIKE %keyword%）' },
        },
      },
      handler: (args) => handleOpenRequirement(projectId, db, workspacePath, args),
    },
    {
      name: 'open_feedback',
      description:
        '打开/查看指定反馈并返回详情（标题、正文、状态、绑定执行计划）。可按 id（精确）或 title（模糊包含）定位；多命中时返回最近更新的一条。结果含 openable 入口，供对话直接查看或在卡片打开。',
      input_schema: {
        type: 'object',
        description: 'id 与 title 至少二选一。',
        properties: {
          id: { type: 'integer', description: '反馈 ID（精确匹配，正整数）' },
          title: { type: 'string', description: '反馈标题关键词（模糊包含，title LIKE %keyword%）' },
        },
      },
      handler: (args) => handleOpenFeedback(projectId, db, workspacePath, args),
    },
  ]);
}

/* ------------------------------------------------------------------ read_file ------------------------------------------------------------------ */

function handleReadFile(db, workspacePath, args) {
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

  // 统一访问策略：调用期解析以保证读到最新配置；默认 project 仅允许工作区内部
  const policy = resolveFileAccessPolicy({ db, workspacePath });
  try {
    assertPathAllowed(resolvedPath, policy);
  } catch (err) {
    return { error: err.message, errorCode: err.code || 'FILE_PATH_OUTSIDE_SCOPE' };
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

  // 调用期解析访问策略，保证读到最新配置
  const policy = resolveFileAccessPolicy({ db, workspacePath });
  try {
    return await doSearch(db, projectId, workspacePath, keyword, () => timedOut, policy);
  } finally {
    clearTimeout(timer);
  }
}

async function doSearch(db, projectId, workspacePath, keyword, isTimedOut, policy) {
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
    // 访问策略守卫：内容读取前确认 absPath 在允许范围内（默认仅工作区；跨项目开启后含白名单根）
    if (!isPathAllowed(absPath, policy)) continue;

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
      // 富化工具结果：附带可打开引用，供渲染层识别「可打开卡片」（id 为正整数即可定位）
      return {
        id: created.id,
        title: created.title,
        status: created.status,
        type: 'requirement',
        projectId,
        openable: true,
      };
    }
    // 快照未取到确认记录（note 分支）：仍输出可打开引用契约，id 为 null
    return {
      id: null,
      title,
      status: 'open',
      type: 'requirement',
      projectId,
      openable: true,
      note: '需求已创建，但未在快照中找到确认记录。',
    };
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
      // 富化工具结果：附带可打开引用，供渲染层识别「可打开卡片」（id 为正整数即可定位）
      return {
        id: created.id,
        title: created.title,
        status: created.status,
        type: 'feedback',
        projectId,
        openable: true,
      };
    }
    // 快照未取到确认记录（note 分支）：仍输出可打开引用契约，id 为 null
    return {
      id: null,
      title,
      status: 'open',
      type: 'feedback',
      projectId,
      openable: true,
      note: '反馈已创建，但未在快照中找到确认记录。',
    };
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

/* ------------------------------------------------------------------ open_requirement / open_feedback ------------------------------------------------------------------ */

function handleOpenRequirement(projectId, db, workspacePath, args) {
  return openIntakeDetail('requirement', 'requirements', '需求', projectId, db, workspacePath, args);
}

function handleOpenFeedback(projectId, db, workspacePath, args) {
  return openIntakeDetail('feedback', 'feedback', '反馈', projectId, db, workspacePath, args);
}

/**
 * 按 id（精确）或 title（模糊包含）定位当前项目的需求/反馈，返回结构化详情。
 * 只读查询：通过 LEFT JOIN plans 读取绑定执行计划（标题从 plan markdown 文件解析，缺失/不可读则回退 Plan #id）。
 * 未命中或未提供 id/title 时返回 INTAKE_NOT_FOUND，不抛未处理异常。
 */
function openIntakeDetail(type, table, label, projectId, db, workspacePath, args) {
  if (!db) {
    return { error: '数据库未注入，无法查询详情', errorCode: 'SERVICE_UNAVAILABLE' };
  }

  const id = Number((args || {}).id);
  const hasId = Number.isInteger(id) && id > 0;
  const titleKeyword = String((args || {}).title || '').trim();

  if (!hasId && !titleKeyword) {
    return { error: `未指定${label}：请提供 id 或 title`, errorCode: 'INTAKE_NOT_FOUND' };
  }

  // table 为内部硬编码常量（requirements/feedback），非用户输入；id/title 走参数化绑定。
  const joinFrom = `${table}
      LEFT JOIN plans ON plans.id = ${table}.linked_plan_id
        AND plans.project_id = ${table}.project_id`;

  let row;
  try {
    if (hasId) {
      row = db.get(
        `SELECT ${table}.*, plans.file_path AS plan_file_path,
                plans.status AS plan_status,
                plans.completed_tasks AS plan_completed, plans.total_tasks AS plan_total
           FROM ${joinFrom}
          WHERE ${table}.project_id = ? AND ${table}.id = ?
          LIMIT 1`,
        [projectId, id],
      );
    } else {
      row = db.get(
        `SELECT ${table}.*, plans.file_path AS plan_file_path,
                plans.status AS plan_status,
                plans.completed_tasks AS plan_completed, plans.total_tasks AS plan_total
           FROM ${joinFrom}
          WHERE ${table}.project_id = ? AND ${table}.title LIKE ?
          ORDER BY ${table}.updated_at DESC, ${table}.id DESC
          LIMIT 1`,
        [projectId, `%${titleKeyword}%`],
      );
    }
  } catch (err) {
    return { error: `查询${label}失败：${err.message}`, errorCode: 'INTAKE_NOT_FOUND' };
  }

  if (!row) {
    return { error: `未找到${label}（id 或 title 未命中当前项目）`, errorCode: 'INTAKE_NOT_FOUND' };
  }

  return {
    type,
    projectId,
    id: row.id,
    title: row.title,
    body: row.body,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    linkedPlan: buildLinkedPlanDetail(db, workspacePath, row),
    openable: true,
  };
}

/** 从 intake 行（含 LEFT JOIN plans 的 plan_* 列）构造绑定计划详情；无 linked_plan_id 关联返回 null。 */
function buildLinkedPlanDetail(db, workspacePath, row = {}) {
  const planId = Number(row.linked_plan_id);
  if (!Number.isInteger(planId) || planId <= 0) return null;

  const title = readPlanMarkdownTitle(db, workspacePath, row.plan_file_path);
  return {
    id: planId,
    title: title || `Plan #${planId}`,
    filePath: row.plan_file_path || null,
    status: row.plan_status || null,
    completed: Number.isFinite(Number(row.plan_completed)) ? Number(row.plan_completed) : null,
    total: Number.isFinite(Number(row.plan_total)) ? Number(row.plan_total) : null,
  };
}

/** 只读解析 plan markdown 标题（首个 # 标题）；经访问策略校验，文件缺失/越界/不可读时返回 ''，不抛异常。 */
function readPlanMarkdownTitle(db, workspacePath, filePath) {
  if (!workspacePath || !filePath) return '';
  try {
    const workspaceRoot = path.resolve(workspacePath);
    const absPath = path.resolve(workspaceRoot, filePath);
    const policy = resolveFileAccessPolicy({ db, workspacePath });
    if (!isPathAllowed(absPath, policy)) return '';
    if (!fs.existsSync(absPath) || fs.statSync(absPath).isDirectory()) return '';
    const content = fs.readFileSync(absPath, 'utf8').slice(0, 64 * 1024);
    return extractMarkdownHeading(content);
  } catch {
    return '';
  }
}

function extractMarkdownHeading(markdown) {
  let text = String(markdown || '');
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1); // 剥离行首 BOM
  const lines = text.split(/\r?\n/);
  const h1 = lines.find((line) => /^\s*#\s+\S/.test(line) && !/^\s*#{2,}\s+/.test(line));
  if (h1) return h1.replace(/^\s*#\s+/, '').trim();
  const anyHeading = lines.find((line) => /^\s*#{1,6}\s+\S/.test(line));
  return anyHeading ? anyHeading.replace(/^\s*#{1,6}\s+/, '').trim() : '';
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
