'use strict';

/**
 * Chat 工具层（需求 #26）：白名单工具注册表与处理器。
 *
 * 安全边界：
 * - 仅注册白名单只读/安全创建工具，不含 write_file/edit_file/delete_* /run_command/run_script
 * - read_file 经共享访问策略（fileAccess/policy）校验 + 256KB 截断
 * - search_files 结果上限 50 条 + 5s 超时保护
 * - create_requirement/create_feedback 走 IntakeService（autoRun=true）
 * - create_plan 只接受结构化 JSON，由后端渲染为固定 AutoPlan markdown 格式
 * - create_script 仅 INSERT 落库，不调用 runScript
 * - executor 工具只运行/停止当前项目内已保存执行器，不接收任意命令或 launch/debug 参数
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { nowIso } = require('../database');
const { executorFromRow } = require('../executors/executorStore');
const { resolveFileAccessPolicy, isPathAllowed, assertPathAllowed } = require('../fileAccess/policy');
const { isPlanContentValid } = require('../loop/planGeneration');
const intakePlanLinks = require('../loop/intakePlanLinks');
const {
  CREATE_PLAN_TOOL_SCHEMA,
  CREATE_PLAN_TOOL_STRICT,
  renderCreatePlanMarkdown,
} = require('./chatPlanTools');

const READ_FILE_MAX_BYTES = 256 * 1024; // 256KB
const SEARCH_MAX_RESULTS = 50;
const SEARCH_TIMEOUT_MS = 5000;
const SEARCH_CONTENT_SCAN_LIMIT = 200;
const EXECUTOR_LOG_TAIL_MAX_CHARS = 3000;
const EXECUTOR_STATUSES = Object.freeze(['idle', 'running', 'ok', 'bad', 'stopped']);

/**
 * 获取白名单 Chat 工具定义列表。
 * 外部无法注册额外工具——工具注册表在此函数内闭合。
 *
 * @param {{db:object, projectId:number, workspacePath:string, intakeService:object, planService?:object, loopService?:object, conversationId?:number}} deps
 * @returns {Array<{name:string, description:string, input_schema:object, strict?:boolean, handler:Function}>}
 */
function getChatToolDefinitions({ db, projectId, workspacePath, intakeService, planService, loopService, conversationId }) {
  if (!workspacePath || !String(workspacePath).trim()) {
    throw new Error('工作区路径为空，无法初始化 Chat 工具');
  }
  const planLifecycleService = planService || loopService || null;

  return Object.freeze(
    [
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
      name: 'create_plan',
      description:
        '直接创建 AutoPlan 执行计划的结构化输入工具。必须提交 JSON 对象，不接收任意 markdown 全文；后端会统一渲染 ## 任务拆解、连续 P001 编号、scope 注释、缩进验收要点和最后的完整验收任务。',
      input_schema: CREATE_PLAN_TOOL_SCHEMA,
      strict: CREATE_PLAN_TOOL_STRICT,
      handler: (args) => handleCreatePlan(db, projectId, workspacePath, planLifecycleService, conversationId, args),
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
      name: 'list_executors',
      description:
        '查询当前项目的工作区执行器列表和最近运行状态。只返回已保存执行器配置、状态和日志尾部；不运行临时命令，不支持 launch/debug 配置。',
      input_schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          scope: {
            type: 'string',
            enum: ['current_project'],
            description: '固定为 current_project；Chat 执行器工具只作用于当前项目。',
          },
          label: { type: 'string', description: '按执行器 label 关键词过滤（可选）' },
          group: { type: 'string', description: '按 group kind 精确过滤，例如 build/test/custom（可选）' },
          status: { type: 'string', enum: EXECUTOR_STATUSES, description: '按当前或最近状态过滤（可选）' },
          enabled: { type: 'boolean', description: '按启用状态过滤（可选）' },
          limit: { type: 'integer', minimum: 1, maximum: 50, description: '返回数量上限（默认 20，最多 50）' },
        },
        required: ['scope'],
      },
      handler: (args) => handleListExecutors(db, projectId, loopService, args),
    },
    {
      name: 'run_executor',
      description:
        '运行当前项目内已有执行器。只能按 id 或精确 label 选择已保存执行器，不接受 command、launch 或 debug 参数；返回状态、退出码、耗时和日志尾部。',
      input_schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'integer', minimum: 1, description: '执行器 ID。若未知可改用 label。' },
          label: { type: 'string', description: '执行器精确 label。id 与 label 至少二选一。' },
        },
        required: ['id'],
      },
      handler: (args) => handleRunExecutor(projectId, db, loopService, args),
    },
    {
      name: 'stop_executor',
      description:
        '停止当前项目内正在运行的已有执行器。只能按 id 或精确 label 定位，不影响脚本、计划任务或循环；不支持 launch/debug 配置。',
      input_schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'integer', minimum: 1, description: '执行器 ID。若未知可改用 label。' },
          label: { type: 'string', description: '执行器精确 label。id 与 label 至少二选一。' },
        },
        required: ['id'],
      },
      handler: (args) => handleStopExecutor(projectId, db, loopService, args),
    },
    {
      name: 'open_executor',
      description:
        '定位当前项目内已有执行器，并返回可打开的执行器 tab/card 锚点。不存在或已删除时返回结构化不可用结果。',
      input_schema: {
        type: 'object',
        additionalProperties: false,
        description: 'id 与 label 至少二选一。',
        properties: {
          id: { type: 'integer', minimum: 1, description: '执行器 ID（精确匹配）' },
          label: { type: 'string', description: '执行器精确 label' },
        },
      },
      handler: (args) => handleOpenExecutor(projectId, db, loopService, args),
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
  ].map(Object.freeze));
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

/* ------------------------------------------------------------------ create_plan ------------------------------------------------------------------ */

function handleCreatePlan(db, projectId, workspacePath, planService, conversationId, args) {
  if (!planService || typeof planService.insertPlan !== 'function' || typeof planService.syncPlanTasks !== 'function') {
    return { error: '计划生命周期服务未注入，无法创建计划', errorCode: 'SERVICE_UNAVAILABLE' };
  }

  let planFile = '';
  let planId = null;
  try {
    const rendered = renderCreatePlanMarkdown(args);
    const workspaceRoot = resolveExistingWorkspace(workspacePath);
    const planDir = ensurePlanOutputDir(planService, workspaceRoot);
    planFile = nextChatPlanFilePath(planDir, conversationId);
    const relativePath = normalizeRelativePath(workspaceRoot, planFile);

    fs.writeFileSync(planFile, rendered.markdown, 'utf8');

    const persistedContent = fs.readFileSync(planFile, 'utf8');
    if (!isPlanContentValid(persistedContent)) {
      cleanupCreatedPlanFile(planFile);
      return {
        error: '生成的计划格式不合规：缺少 ## 任务拆解 或合规任务行',
        errorCode: 'PLAN_FORMAT_INVALID',
      };
    }

    const issueHash = stableChatPlanIssueHash(projectId, conversationId, rendered.markdown);
    planId = planService.insertPlan({
      projectId,
      issueHash,
      filePath: relativePath,
      hash: hashFile(planFile),
      status: rendered.status,
    });
    if (!Number.isInteger(Number(planId)) || Number(planId) <= 0) {
      const err = new Error('计划记录插入失败');
      err.code = 'PLAN_INSERT_FAILED';
      throw err;
    }
    planService.syncPlanTasks(planId, planFile);
    forcePlanStatus(db, planId, rendered.status);
    recordChatPlanCreated(planService, projectId, planId, relativePath, rendered);

    return {
      id: planId,
      type: 'plan',
      title: rendered.title,
      status: rendered.status,
      totalTasks: rendered.totalTasks,
      filePath: relativePath,
      projectId,
      openable: true,
    };
  } catch (err) {
    cleanupPartialCreatePlan(db, planId, planFile);
    return { error: `创建计划失败：${err.message}`, errorCode: err.code || 'CREATE_PLAN_FAILED' };
  }
}

function resolveExistingWorkspace(workspacePath) {
  const workspaceRoot = path.resolve(String(workspacePath || '').trim());
  if (!workspaceRoot || workspaceRoot === path.parse(workspaceRoot).root) {
    const err = new Error('工作区路径无效');
    err.code = 'INVALID_WORKSPACE';
    throw err;
  }
  let stat;
  try {
    stat = fs.statSync(workspaceRoot);
  } catch (err) {
    const wrapped = new Error(`无法访问工作区：${err.message}`);
    wrapped.code = 'WORKSPACE_ACCESS_ERROR';
    throw wrapped;
  }
  if (!stat.isDirectory()) {
    const err = new Error('工作区路径不是目录');
    err.code = 'INVALID_WORKSPACE';
    throw err;
  }
  return workspaceRoot;
}

function ensurePlanOutputDir(planService, workspaceRoot) {
  if (typeof planService.ensureWorkspaceDirs === 'function') {
    planService.ensureWorkspaceDirs(workspaceRoot);
  }

  const planDir = path.resolve(workspaceRoot, 'docs', 'plan');
  const relative = path.relative(workspaceRoot, planDir);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    const err = new Error('计划输出目录不在工作区内');
    err.code = 'PLAN_DIR_OUTSIDE_WORKSPACE';
    throw err;
  }

  try {
    fs.mkdirSync(planDir, { recursive: true });
    if (!fs.statSync(planDir).isDirectory()) throw new Error('目标不是目录');
  } catch (err) {
    const wrapped = new Error(`无法准备计划输出目录：${err.message}`);
    wrapped.code = 'PLAN_DIR_ACCESS_ERROR';
    throw wrapped;
  }
  return planDir;
}

function nextChatPlanFilePath(planDir, conversationId) {
  const safeConversationId = safeFilePart(conversationId || 'unknown');
  const baseName = `plan_chat_${safeConversationId}_${timestampForPath()}`;
  let candidate = path.join(planDir, `${baseName}.md`);
  let suffix = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(planDir, `${baseName}_${suffix}.md`);
    suffix += 1;
  }
  return candidate;
}

function stableChatPlanIssueHash(projectId, conversationId, markdown) {
  return `chat-${safeFilePart(projectId || '0')}-${safeFilePart(conversationId || 'unknown')}-${hashText(markdown).slice(0, 16)}`;
}

function hashFile(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function hashText(text) {
  return crypto.createHash('sha256').update(String(text || '')).digest('hex');
}

function normalizeRelativePath(root, fullPath) {
  return path.relative(root, fullPath).replaceAll(path.sep, '/');
}

function timestampForPath() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function safeFilePart(value) {
  return String(value).replace(/[^A-Za-z0-9_.-]+/g, '_') || 'unknown';
}

function forcePlanStatus(db, planId, status) {
  if (!db || typeof db.run !== 'function' || !planId || !['pending', 'draft'].includes(status)) return;
  db.run('UPDATE plans SET status = ?, updated_at = ? WHERE id = ?', [status, nowIso(), planId]);
}

function recordChatPlanCreated(planService, projectId, planId, relativePath, rendered) {
  try {
    if (typeof planService.addEvent === 'function') {
      planService.addEvent(projectId, 'plan.generated', `对话创建计划：${relativePath}`, {
        planId,
        source: 'chat',
        title: rendered.title,
        status: rendered.status,
        totalTasks: rendered.totalTasks,
      });
      return;
    }
    if (typeof planService.emitUpdate === 'function') {
      planService.emitUpdate(projectId);
    }
  } catch {
    /* 事件记录失败不影响计划创建结果 */
  }
}

function cleanupPartialCreatePlan(db, planId, planFile) {
  if (planId && db && typeof db.run === 'function') {
    try {
      db.run('DELETE FROM plan_tasks WHERE plan_id = ?', [planId]);
      db.run('DELETE FROM plans WHERE id = ?', [planId]);
    } catch {
      /* 清理失败不覆盖原始错误 */
    }
  }
  cleanupCreatedPlanFile(planFile);
}

function cleanupCreatedPlanFile(planFile) {
  if (!planFile) return;
  try {
    if (fs.existsSync(planFile) && fs.statSync(planFile).isFile()) fs.unlinkSync(planFile);
  } catch {
    /* 清理失败不覆盖原始错误 */
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

/* ------------------------------------------------------------------ executors ------------------------------------------------------------------ */

function handleListExecutors(db, projectId, loopService, args = {}) {
  const invalid = validateExecutorToolArgs(args, ['scope', 'label', 'group', 'status', 'enabled', 'limit']);
  if (invalid) return invalid;
  if (!db || typeof db.all !== 'function') {
    return { error: '数据库未注入，无法查询执行器', errorCode: 'SERVICE_UNAVAILABLE' };
  }
  const scope = String(args.scope || 'current_project').trim();
  if (scope !== 'current_project') {
    return { error: '执行器工具只支持当前项目范围', errorCode: 'EXECUTOR_SCOPE_UNSUPPORTED' };
  }

  const status = String(args.status || '').trim();
  if (status && !EXECUTOR_STATUSES.includes(status)) {
    return { error: `执行器状态无效：${status}`, errorCode: 'INVALID_STATUS' };
  }

  const limit = Math.min(50, normalizePositiveInteger(args.limit) || 20);
  const rows = listChatExecutorRows(db, projectId, {
    label: String(args.label || '').trim(),
    group: String(args.group || '').trim(),
    enabled: typeof args.enabled === 'boolean' ? args.enabled : undefined,
  });
  const executors = rows
    .map((row) => chatExecutorSummary(row, loopService))
    .filter((executor) => !status || executor.status === status)
    .slice(0, limit);

  return {
    type: 'executor_list',
    projectId,
    count: executors.length,
    executors,
  };
}

async function handleRunExecutor(projectId, db, loopService, args = {}) {
  const invalid = validateExecutorToolArgs(args, ['id', 'executorId', 'label']);
  if (invalid) return invalid;
  if (!loopService || typeof loopService.runExecutor !== 'function') {
    return { error: '执行器运行服务未注入', errorCode: 'SERVICE_UNAVAILABLE' };
  }

  const resolved = resolveChatExecutor(db, projectId, args);
  if (!resolved.executor) return resolved.unavailable;

  try {
    const result = await loopService.runExecutor(projectId, resolved.executor.id);
    return chatExecutorRunResult(result, resolved.executor, loopService);
  } catch (err) {
    return {
      ...chatExecutorSummary(resolved.executor, loopService),
      action: 'run',
      error: `运行执行器失败：${err.message}`,
      errorCode: 'EXECUTOR_RUN_FAILED',
    };
  }
}

function handleStopExecutor(projectId, db, loopService, args = {}) {
  const invalid = validateExecutorToolArgs(args, ['id', 'executorId', 'label']);
  if (invalid) return invalid;
  if (!loopService || typeof loopService.stopExecutor !== 'function') {
    return { error: '执行器停止服务未注入', errorCode: 'SERVICE_UNAVAILABLE' };
  }

  const resolved = resolveChatExecutor(db, projectId, args);
  if (!resolved.executor) return resolved.unavailable;

  try {
    const result = loopService.stopExecutor(projectId, resolved.executor.id);
    const latest = getChatExecutorById(db, projectId, resolved.executor.id) || resolved.executor;
    const summary = chatExecutorSummary(latest, loopService);
    return {
      ...summary,
      action: 'stop',
      stopped: Number(result?.stopped || 0),
    };
  } catch (err) {
    return {
      ...chatExecutorSummary(resolved.executor, loopService),
      action: 'stop',
      error: `停止执行器失败：${err.message}`,
      errorCode: 'EXECUTOR_STOP_FAILED',
    };
  }
}

function handleOpenExecutor(projectId, db, loopService, args = {}) {
  const invalid = validateExecutorToolArgs(args, ['id', 'executorId', 'label']);
  if (invalid) return invalid;
  const resolved = resolveChatExecutor(db, projectId, args);
  if (!resolved.executor) return resolved.unavailable;
  return {
    ...chatExecutorSummary(resolved.executor, loopService),
    action: 'open',
  };
}

function validateExecutorToolArgs(args = {}, allowedKeys) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return { error: '执行器工具参数必须是对象', errorCode: 'INVALID_ARGS' };
  }
  const allowed = new Set(allowedKeys);
  const unknown = Object.keys(args).filter((key) => !allowed.has(key));
  if (!unknown.length) return null;
  return {
    error: `执行器工具不接受这些参数：${unknown.join(', ')}`,
    errorCode: 'UNSUPPORTED_EXECUTOR_FIELDS',
    unsupportedFields: unknown,
  };
}

function listChatExecutorRows(db, projectId, filters = {}) {
  const params = [projectId];
  let where = '';
  if (filters.label) {
    where += ' AND label LIKE ?';
    params.push(`%${filters.label}%`);
  }
  if (filters.group) {
    where += ' AND group_kind = ?';
    params.push(filters.group);
  }
  if (filters.enabled !== undefined) {
    where += ' AND enabled = ?';
    params.push(filters.enabled ? 1 : 0);
  }
  return db.all(
    `SELECT * FROM executors
     WHERE project_id = ?${where}
     ORDER BY sort_order ASC, id ASC`,
    params,
  );
}

function resolveChatExecutor(db, projectId, args = {}) {
  const selector = executorSelector(args);
  if (!selector.id && !selector.label) {
    return { executor: null, unavailable: executorUnavailable(projectId, selector, '未指定执行器：请提供 id 或 label') };
  }
  if (!db || typeof db.get !== 'function') {
    return { executor: null, unavailable: executorUnavailable(projectId, selector, '数据库未注入，无法查询执行器', 'SERVICE_UNAVAILABLE') };
  }

  let row = null;
  try {
    if (selector.id) {
      row = db.get('SELECT * FROM executors WHERE id = ? AND project_id = ?', [selector.id, projectId]);
    } else {
      row = db.get(
        `SELECT * FROM executors
         WHERE project_id = ? AND label = ?
         ORDER BY sort_order ASC, id ASC
         LIMIT 1`,
        [projectId, selector.label],
      );
    }
  } catch (err) {
    return { executor: null, unavailable: executorUnavailable(projectId, selector, `查询执行器失败：${err.message}`) };
  }

  if (!row) {
    return { executor: null, unavailable: executorUnavailable(projectId, selector, '未找到执行器（可能不存在、已删除或不属于当前项目）') };
  }
  return { executor: executorFromRow(row), unavailable: null };
}

function getChatExecutorById(db, projectId, executorId) {
  if (!db || typeof db.get !== 'function') return null;
  try {
    const row = db.get('SELECT * FROM executors WHERE id = ? AND project_id = ?', [executorId, projectId]);
    return row ? executorFromRow(row) : null;
  } catch {
    return null;
  }
}

function executorSelector(args = {}) {
  return {
    id: normalizePositiveInteger(args.id) || normalizePositiveInteger(args.executorId),
    label: String(args.label || '').trim(),
  };
}

function executorUnavailable(projectId, selector = {}, message, errorCode = 'EXECUTOR_UNAVAILABLE') {
  return {
    type: 'executor',
    projectId,
    id: selector.id || null,
    label: selector.label || null,
    available: false,
    openable: false,
    error: message,
    errorCode,
  };
}

function chatExecutorSummary(record, loopService = null) {
  const executor = normalizeChatExecutorRecord(record);
  const activeOperation = executor ? activeExecutorOperation(loopService, executor.projectId, executor.id) : null;
  const running = Boolean(activeOperation);
  const status = running ? 'running' : (executor?.lastStatus || 'idle');
  const exitCode = running ? null : executor?.lastExitCode ?? null;
  const durationMs = running ? null : executor?.lastDurationMs ?? null;
  const logTail = executorLogTail(running && activeOperation?.logBuffer ? activeOperation.logBuffer : executor?.lastLog);
  const openRef = executorOpenRef(executor?.projectId, executor);
  return {
    type: 'executor',
    projectId: executor?.projectId || null,
    id: executor?.id || null,
    label: executor?.label || '',
    executorId: executor?.id || null,
    available: Boolean(executor),
    command: executor?.command || '',
    group: executor?.group || { kind: null, isDefault: false },
    enabled: Boolean(executor?.enabled),
    status,
    running,
    exitCode,
    durationMs,
    lastRunAt: executor?.lastRunAt || null,
    logTail,
    openable: Boolean(openRef.id),
    openRef,
  };
}

function normalizeChatExecutorRecord(record) {
  if (!record) return null;
  if (record.projectId !== undefined && record.label !== undefined) return record;
  return executorFromRow(record);
}

function chatExecutorRunResult(result = {}, executor, loopService = null) {
  const mergedExecutor = {
    ...executor,
    lastStatus: result.status || executor.lastStatus,
    lastExitCode: result.exitCode ?? executor.lastExitCode,
    lastDurationMs: result.durationMs ?? executor.lastDurationMs,
    lastLog: result.log || executor.lastLog,
  };
  return {
    ...chatExecutorSummary(mergedExecutor, loopService),
    action: 'run',
    status: result.status || null,
    exitCode: typeof result.exitCode === 'number' ? result.exitCode : null,
    durationMs: typeof result.durationMs === 'number' ? result.durationMs : null,
    logTail: executorLogTail(result.log),
    logFile: result.logFile || null,
    timedOut: Boolean(result.timedOut),
    error: result.error || null,
    dependencyResults: Array.isArray(result.dependencyResults)
      ? result.dependencyResults.map(chatExecutorDependencyResult)
      : [],
  };
}

function chatExecutorDependencyResult(result = {}) {
  return {
    executorId: result.executorId || null,
    label: result.label || result.dependencyLabel || null,
    status: result.status || 'bad',
    exitCode: typeof result.exitCode === 'number' ? result.exitCode : null,
    durationMs: typeof result.durationMs === 'number' ? result.durationMs : null,
    error: result.errorMessage || result.error || null,
    logTail: executorLogTail(result.log, 1200),
  };
}

function activeExecutorOperation(loopService, projectId, executorId) {
  let runtime = null;
  try {
    runtime = typeof loopService?.existingRuntime === 'function' ? loopService.existingRuntime(projectId) : null;
  } catch {
    runtime = null;
  }
  if (!runtime?.activeOperations) return null;
  for (const operation of runtime.activeOperations.values()) {
    if (
      Number(operation?.projectId) === Number(projectId)
      && operation?.operationType === 'executor'
      && Number(operation?.executorId) === Number(executorId)
    ) {
      return operation;
    }
  }
  return null;
}

function executorLogTail(value, maxLength = EXECUTOR_LOG_TAIL_MAX_CHARS) {
  const text = value === undefined || value === null ? '' : String(value);
  if (!text) return '';
  return text.length > maxLength ? text.slice(-maxLength) : text;
}

function executorOpenRef(projectId, executor) {
  const id = normalizePositiveInteger(executor?.id);
  const scopedProjectId = normalizePositiveInteger(projectId);
  const anchorId = id ? `workspace-executor-${id}` : null;
  return {
    type: 'executor',
    projectId: scopedProjectId,
    id,
    label: executor?.label || null,
    tab: 'executors',
    anchorId,
    link: id && scopedProjectId ? `#/projects/${scopedProjectId}?tab=executors&anchor=${anchorId}` : null,
  };
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

  const linkedPlans = buildLinkedPlanDetails(db, workspacePath, type, projectId, row);
  return {
    type,
    projectId,
    id: row.id,
    title: row.title,
    body: row.body,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    linkedPlan: linkedPlanCompatDetail(currentLinkedPlanDetail(linkedPlans)) || buildLinkedPlanDetail(db, workspacePath, row),
    linkedPlans,
    openable: true,
  };
}

function buildLinkedPlanDetails(db, workspacePath, type, projectId, row = {}) {
  let links = [];
  try {
    links = intakePlanLinks.getPlansForIntake({ db }, projectId, type, row.id, {
      includeMissingPlans: true,
    });
  } catch {
    links = [];
  }

  const linkedPlans = links
    .map((link) => buildLinkedPlanDetailFromLink(db, workspacePath, link, row))
    .filter(Boolean);
  if (linkedPlans.length > 0) return markCurrentLinkedPlanDetails(linkedPlans);

  const legacy = buildLegacyLinkedPlanDetail(db, workspacePath, row);
  return legacy ? markCurrentLinkedPlanDetails([legacy]) : [];
}

function buildLinkedPlanDetailFromLink(db, workspacePath, link = {}, row = {}) {
  const planId = normalizePositiveInteger(link.planId ?? link.plan_id ?? link.id);
  if (!planId) return null;
  const phaseTitle = String(link.phaseTitle || link.phase_title || '').trim();
  const plan = link.plan || rowPlanFallback(row, planId) || {};
  const filePath = plan.file_path || '';
  return {
    id: planId,
    planId,
    linkId: normalizePositiveInteger(link.linkId ?? link.link_id),
    phaseIndex: normalizePositiveInteger(link.phaseIndex ?? link.phase_index) || 1,
    phaseTitle,
    title: readPlanMarkdownTitle(db, workspacePath, filePath) || phaseTitle || `Plan #${planId}`,
    filePath: filePath || null,
    status: plan.status || null,
    completed: normalizeNullableNumber(plan.completed_tasks),
    total: normalizeNullableNumber(plan.total_tasks),
    validationPassed: plan.validation_passed ?? null,
    current: false,
  };
}

function buildLegacyLinkedPlanDetail(db, workspacePath, row = {}) {
  const detail = buildLinkedPlanDetail(db, workspacePath, row);
  if (!detail) return null;
  return {
    ...detail,
    planId: detail.id,
    linkId: null,
    phaseIndex: 1,
    phaseTitle: '',
    validationPassed: null,
    current: false,
  };
}

function rowPlanFallback(row = {}, planId) {
  if (Number(row.linked_plan_id) !== Number(planId)) return null;
  return {
    file_path: row.plan_file_path || '',
    status: row.plan_status || null,
    completed_tasks: row.plan_completed,
    total_tasks: row.plan_total,
    validation_passed: row.plan_validation_passed,
  };
}

function markCurrentLinkedPlanDetails(linkedPlans = []) {
  const current = currentLinkedPlanDetail(linkedPlans);
  return linkedPlans.map((linkedPlan) => ({
    ...linkedPlan,
    current: Boolean(
      current
      && Number(linkedPlan.planId) === Number(current.planId)
      && Number(linkedPlan.phaseIndex || 0) === Number(current.phaseIndex || 0),
    ),
  }));
}

function currentLinkedPlanDetail(linkedPlans = []) {
  if (!Array.isArray(linkedPlans) || linkedPlans.length === 0) return null;
  return linkedPlans.find((linkedPlan) => {
    const status = String(linkedPlan.status || '').toLowerCase();
    return status && !['completed', 'interrupted', 'draft'].includes(status);
  }) || linkedPlans.find((linkedPlan) => String(linkedPlan.status || '').toLowerCase() !== 'completed') || linkedPlans[0];
}

function linkedPlanCompatDetail(linkedPlan) {
  if (!linkedPlan) return null;
  return {
    id: linkedPlan.id,
    title: linkedPlan.title,
    filePath: linkedPlan.filePath,
    status: linkedPlan.status,
    completed: linkedPlan.completed,
    total: linkedPlan.total,
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

function normalizePositiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function normalizeNullableNumber(value) {
  if (value === null || typeof value === 'undefined' || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
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
