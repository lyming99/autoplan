'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { getChatToolDefinitions } = require('./chatTools');

const READ_FILE_MAX_BYTES = 256 * 1024;

/* ------------------------------------------------------------------ 测试辅助 ------------------------------------------------------------------ */

/** 创建最小 DB 替身：支持 all()（scan_files/executors 查询）、insert()（scripts 写入）、
 * get()（open_requirement/open_feedback/open_executor 详情查询）、getSetting()（文件访问策略） */
function createDbStub({ scanFiles = [], settings = {}, requirements = [], feedback = [], plans = [], intakePlanLinks = [], executors = [] } = {}) {
  let nextId = 1;
  const settingsMap = new Map();
  for (const [key, value] of Object.entries(settings)) settingsMap.set(key, String(value));
  const db = {
    _scanFiles: scanFiles,
    _requirements: requirements,
    _feedback: feedback,
    _plans: plans,
    _intakePlanLinks: intakePlanLinks,
    _executors: executors,
    _insertedScripts: [],
    _runs: [],
    _allCalls: [],
    _lastInsertId: null,
    all(sql, params = []) {
      db._allCalls.push({ sql, params });
      if (sql.includes('scan_files')) {
        let rows = [...db._scanFiles];
        let paramIndex = 0;
        if (sql.includes('project_id = ?')) {
          const projectId = Number(params[paramIndex++]);
          rows = rows.filter((r) => Number(r.project_id) === projectId);
        }
        if (sql.includes('file_path LIKE ?')) {
          const keyword = extractLikeKeyword([params[paramIndex++]], sql);
          if (keyword) rows = rows.filter((r) => r.file_path.includes(keyword));
        }
        if (sql.includes('ORDER BY scanned_at DESC')) {
          rows.sort((left, right) => (
            String(right.scanned_at || '').localeCompare(String(left.scanned_at || ''))
              || String(left.file_path || '').localeCompare(String(right.file_path || ''))
          ));
        }
        const limit = readSqlLimit(sql, params, paramIndex);
        if (limit !== null) rows = rows.slice(0, limit);
        return rows;
      }
      if (typeof sql === 'string' && sql.includes('intake_plan_links')) {
        return resolveIntakePlanLinks(db, params);
      }
      if (typeof sql === 'string' && sql.includes('FROM executors')) {
        return resolveExecutorList(db._executors, sql, params);
      }
      return [];
    },
    insert(sql, params = []) {
      db._lastSql = sql;
      db._lastParams = params;
      db._insertedScripts.push({ sql, params });
      db._lastInsertId = nextId;
      return nextId++;
    },
    run(sql, params = []) {
      db._runs.push({ sql, params });
    },
    get(sql, params = []) {
      // open_requirement / open_feedback 详情查询（含 LEFT JOIN plans）
      if (typeof sql === 'string' && sql.includes('requirements')) {
        return resolveIntakeGet(db._requirements, sql, params, db._plans);
      }
      if (typeof sql === 'string' && sql.includes('feedback')) {
        return resolveIntakeGet(db._feedback, sql, params, db._plans);
      }
      if (typeof sql === 'string' && sql.includes('FROM executors')) {
        return resolveExecutorGet(db._executors, sql, params);
      }
      return null;
    },
    // 文件访问策略（需求 #35）：与 updateChecker.test.js 的 settings 替身同口径
    getSetting(key, fallback = null) {
      return settingsMap.has(key) ? settingsMap.get(key) : fallback;
    },
    countAll(predicate) {
      return db._allCalls.filter((entry) => predicate(entry.sql, entry.params)).length;
    },
  };
  return db;
}

/** 从 SQL params 中提取 LIKE 模式的实际关键词 */
function extractLikeKeyword(params, sql) {
  for (const p of params) {
    if (typeof p === 'string' && p.includes('%')) return p.replace(/%/g, '');
  }
  return '';
}

function readSqlLimit(sql, params, nextParamIndex = 0) {
  const limitMatch = String(sql || '').match(/LIMIT\s+(\?|\d+)/i);
  if (!limitMatch) return null;
  if (limitMatch[1] !== '?') return Number(limitMatch[1]);
  const number = Number(params[nextParamIndex]);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

/** 模拟 intake 详情查询（含 LEFT JOIN plans）：
 * 按 projectId + id 精确，或 projectId + title LIKE 模糊取 updated_at DESC/id DESC 第一条；
 * 命中行附带 plan_file_path/plan_status/plan_completed/plan_total 别名列。 */
function resolveIntakeGet(rows, sql, params, plans) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const projectId = params[0];
  const isTitleLike = /\btitle\s+like\s+\?/i.test(sql);
  let candidates = rows.filter((r) => Number(r.project_id) === Number(projectId));
  if (isTitleLike) {
    const keyword = String(params[1] || '').replace(/%/g, '');
    candidates = candidates.filter((r) => String(r.title || '').includes(keyword));
    candidates.sort((a, b) => {
      const ua = String(a.updated_at || '');
      const ub = String(b.updated_at || '');
      if (ua !== ub) return ub.localeCompare(ua);
      return Number(b.id) - Number(a.id);
    });
  } else {
    const id = Number(params[1]);
    candidates = candidates.filter((r) => Number(r.id) === id);
  }
  const row = candidates[0];
  if (!row) return null;
  const planId = Number(row.linked_plan_id);
  const plan = Number.isInteger(planId) && planId > 0
    ? (plans || []).find((p) => Number(p.id) === planId && Number(p.project_id) === Number(row.project_id))
    : null;
  return {
    ...row,
    plan_file_path: plan ? plan.file_path : null,
    plan_status: plan ? plan.status : null,
    plan_completed: plan ? plan.completed_tasks : null,
    plan_total: plan ? plan.total_tasks : null,
  };
}

function resolveIntakePlanLinks(db, params) {
  const [projectId, intakeType, intakeId] = params;
  return (db._intakePlanLinks || [])
    .filter((link) => Number(link.project_id) === Number(projectId))
    .filter((link) => String(link.intake_type) === String(intakeType))
    .filter((link) => Number(link.intake_id) === Number(intakeId))
    .sort((left, right) => Number(left.phase_index || 0) - Number(right.phase_index || 0) || Number(left.plan_id || 0) - Number(right.plan_id || 0))
    .map((link, index) => {
      const plan = (db._plans || []).find((item) => Number(item.id) === Number(link.plan_id) && Number(item.project_id) === Number(link.project_id));
      return {
        link_id: link.id || index + 1,
        link_project_id: link.project_id,
        intake_type: link.intake_type,
        intake_id: link.intake_id,
        linked_plan_id: link.plan_id,
        phase_index: link.phase_index,
        phase_title: link.phase_title,
        link_created_at: link.created_at || null,
        link_updated_at: link.updated_at || null,
        existing_plan_id: plan?.id || null,
        plan_project_id: plan?.project_id || link.project_id,
        plan_issue_hash: plan?.issue_hash || '',
        plan_file_path: plan?.file_path || '',
        plan_hash: plan?.hash || '',
        plan_status: plan?.status || null,
        plan_sort_order: plan?.sort_order || 0,
        plan_total_tasks: plan?.total_tasks ?? null,
        plan_completed_tasks: plan?.completed_tasks ?? null,
        plan_validation_passed: plan?.validation_passed ?? null,
        plan_agent_cli_provider: plan?.agent_cli_provider || null,
        plan_agent_cli_command: plan?.agent_cli_command || '',
        plan_codex_reasoning_effort: plan?.codex_reasoning_effort || null,
        plan_agent_cli_session_id: plan?.agent_cli_session_id || null,
        plan_created_at: plan?.created_at || null,
        plan_updated_at: plan?.updated_at || null,
        plan_accepted_at: plan?.accepted_at || null,
      };
    });
}

function resolveExecutorList(rows, sql, params) {
  const projectId = Number(params[0]);
  let paramIndex = 1;
  let result = rows.filter((row) => Number(row.project_id) === projectId);
  if (sql.includes('label LIKE ?')) {
    const keyword = String(params[paramIndex++] || '').replace(/%/g, '');
    result = result.filter((row) => String(row.label || '').includes(keyword));
  }
  if (sql.includes('group_kind = ?')) {
    const group = params[paramIndex++];
    result = result.filter((row) => String(row.group_kind || '') === String(group));
  }
  if (sql.includes('enabled = ?')) {
    const enabled = Number(params[paramIndex++]);
    result = result.filter((row) => Number(row.enabled || 0) === enabled);
  }
  return result
    .slice()
    .sort((left, right) => Number(left.sort_order || 0) - Number(right.sort_order || 0) || Number(left.id) - Number(right.id));
}

function resolveExecutorGet(rows, sql, params) {
  if (sql.includes('label = ?')) {
    const [projectId, label] = params;
    return rows.find((row) => Number(row.project_id) === Number(projectId) && String(row.label) === String(label)) || null;
  }
  const [executorId, projectId] = params;
  return rows.find((row) => Number(row.id) === Number(executorId) && Number(row.project_id) === Number(projectId)) || null;
}

/** 创建 IntakeService 替身：记录调用并返回最小快照 */
function createIntakeServiceStub() {
  let nextReqId = 100;
  let nextFbId = 200;
  const svc = {
    createRequirementCalls: [],
    createFeedbackCalls: [],
    createRequirement(input) {
      svc.createRequirementCalls.push(input);
      return {
        requirements: [{ id: nextReqId++, title: input.title, status: 'open', body: input.body }],
        feedback: [],
      };
    },
    createFeedback(input) {
      svc.createFeedbackCalls.push(input);
      return {
        requirements: [],
        feedback: [{ id: nextFbId++, title: input.title, status: 'open', body: input.body }],
      };
    },
  };
  return svc;
}

/** 创建计划生命周期服务替身：记录 insertPlan / syncPlanTasks / addEvent 调用 */
function createPlanServiceStub(options = {}) {
  const svc = {
    ensureWorkspaceDirsCalls: [],
    insertPlanCalls: [],
    syncPlanTasksCalls: [],
    addEventCalls: [],
    ensureWorkspaceDirs(workspace) {
      svc.ensureWorkspaceDirsCalls.push(workspace);
      fs.mkdirSync(path.join(workspace, 'docs', 'plan'), { recursive: true });
    },
    insertPlan(input) {
      svc.insertPlanCalls.push(input);
      if (options.insertThrows) throw options.insertThrows;
      return options.insertResult ?? 301;
    },
    syncPlanTasks(planId, planFile) {
      svc.syncPlanTasksCalls.push({ planId, planFile });
      if (options.syncThrows) throw options.syncThrows;
    },
    addEvent(projectId, type, message, meta) {
      svc.addEventCalls.push({ projectId, type, message, meta });
    },
  };
  return svc;
}

function createExecutorLoopService(options = {}) {
  const svc = {
    runExecutorCalls: [],
    stopExecutorCalls: [],
    existingRuntimeCalls: [],
    existingRuntime(projectId) {
      svc.existingRuntimeCalls.push(projectId);
      return options.runtime || null;
    },
    async runExecutor(projectId, executorId) {
      svc.runExecutorCalls.push({ projectId, executorId });
      return options.runResult || {
        executorId,
        label: 'executor',
        status: 'ok',
        exitCode: 0,
        durationMs: 1,
        log: 'ok',
        logFile: null,
        dependencyResults: [],
      };
    },
    stopExecutor(projectId, executorId) {
      svc.stopExecutorCalls.push({ projectId, executorId });
      return options.stopResult || { stopped: 1, executorId };
    },
  };
  return svc;
}

function validCreatePlanInput(overrides = {}) {
  return {
    title: '对话直接创建计划',
    summary: '通过 create_plan 工具直接生成 AutoPlan 计划。',
    context: '当前对话已经完成需求澄清。',
    tasks: [
      {
        title: 'P999: 实现 create_plan 后端写入',
        scope: 'src/chat/chatTools.js',
        details: '不要信任模型传入编号。',
        acceptancePoints: ['计划文件写入 docs/plan', '调用计划生命周期同步任务'],
      },
    ],
    overallAcceptance: {
      commands: ['npm test'],
      scope: 'create_plan 后端链路',
      passCriteria: ['测试通过', '计划任务编号连续'],
    },
    ...overrides,
  };
}

function executorRow(overrides = {}) {
  return {
    id: overrides.id || 1,
    project_id: overrides.project_id || 1,
    label: overrides.label || 'executor',
    type: overrides.type || 'shell',
    command: overrides.command || 'echo ok',
    args_json: overrides.args_json || '[]',
    options_json: overrides.options_json || '{}',
    group_kind: overrides.group_kind || null,
    group_is_default: overrides.group_is_default || 0,
    presentation_json: overrides.presentation_json || '{}',
    problem_matcher_json: overrides.problem_matcher_json || null,
    depends_on_json: overrides.depends_on_json || '[]',
    depends_order: overrides.depends_order || 'parallel',
    enabled: overrides.enabled ?? 1,
    sort_order: overrides.sort_order || 0,
    last_status: overrides.last_status || null,
    last_exit_code: overrides.last_exit_code ?? null,
    last_duration_ms: overrides.last_duration_ms ?? null,
    last_log: overrides.last_log || null,
    last_run_at: overrides.last_run_at || null,
    created_at: overrides.created_at || '2026-07-03T00:00:00.000Z',
    updated_at: overrides.updated_at || '2026-07-03T00:00:00.000Z',
  };
}

function planMarkdownFiles(workspace) {
  const planDir = path.join(workspace, 'docs', 'plan');
  if (!fs.existsSync(planDir)) return [];
  return fs.readdirSync(planDir).filter((name) => name.endsWith('.md'));
}

/** 创建临时工作区目录并写入指定文件，返回目录路径 */
function createTempWorkspace(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoplan-ct-'));
  for (const [name, content] of Object.entries(files)) {
    const filePath = path.join(dir, name);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
  }
  return dir;
}

/** 清理临时目录 */
function removeTempDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* 清理失败不阻塞 */
  }
}

/** 按 name 查找工具定义 */
function toolByName(tools, name) {
  return tools.find((t) => t.name === name);
}

function normalizeSql(sql) {
  return String(sql || '').replace(/\s+/g, ' ').trim();
}

function isSearchFilesPathQuery(sql) {
  const normalized = normalizeSql(sql);
  return normalized.includes('SELECT file_path FROM scan_files')
    && normalized.includes('file_path LIKE ?')
    && normalized.includes('LIMIT ?');
}

function isSearchFilesContentQuery(sql) {
  const normalized = normalizeSql(sql);
  return normalized.includes('SELECT file_path, size FROM scan_files')
    && normalized.includes('ORDER BY scanned_at DESC')
    && normalized.includes('LIMIT ?');
}

/* ================================================================== read_file ================================================================== */

describe('read_file', () => {
  it('正常读取文件内容', () => {
    const ws = createTempWorkspace({ 'src/main.js': 'console.log("hello");\n' });
    try {
      const tools = getChatToolDefinitions({ db: createDbStub(), projectId: 1, workspacePath: ws });
      const result = toolByName(tools, 'read_file').handler({ filePath: 'src/main.js' });

      assert.equal(result.content, 'console.log("hello");\n');
      assert.equal(result.filePath, 'src/main.js');
      assert.ok(result.fileSize > 0);
      assert.equal(result.truncated, false);
    } finally {
      removeTempDir(ws);
    }
  });

  it('拒绝越界路径（../ 逃逸）', () => {
    const ws = createTempWorkspace({});
    try {
      const tools = getChatToolDefinitions({ db: createDbStub(), projectId: 1, workspacePath: ws });
      const result = toolByName(tools, 'read_file').handler({ filePath: '../etc/passwd' });

      assert.equal(result.errorCode, 'FILE_PATH_OUTSIDE_SCOPE');
      assert.match(result.error, /超出/);
    } finally {
      removeTempDir(ws);
    }
  });

  it('拒绝指向工作区外的绝对路径', () => {
    const ws = createTempWorkspace({});
    try {
      const tools = getChatToolDefinitions({ db: createDbStub(), projectId: 1, workspacePath: ws });
      const result = toolByName(tools, 'read_file').handler({ filePath: os.tmpdir() });

      assert.equal(result.errorCode, 'FILE_PATH_OUTSIDE_SCOPE');
    } finally {
      removeTempDir(ws);
    }
  });

  it('拒绝不存在的文件', () => {
    const ws = createTempWorkspace({});
    try {
      const tools = getChatToolDefinitions({ db: createDbStub(), projectId: 1, workspacePath: ws });
      const result = toolByName(tools, 'read_file').handler({ filePath: 'nonexistent.txt' });

      assert.equal(result.errorCode, 'FILE_NOT_FOUND');
      assert.match(result.error, /不存在/);
    } finally {
      removeTempDir(ws);
    }
  });

  it('拒绝读取目录路径', () => {
    const ws = createTempWorkspace({ 'subdir/.keep': '' });
    try {
      const tools = getChatToolDefinitions({ db: createDbStub(), projectId: 1, workspacePath: ws });
      const result = toolByName(tools, 'read_file').handler({ filePath: 'subdir' });

      assert.equal(result.errorCode, 'FILE_IS_DIRECTORY');
    } finally {
      removeTempDir(ws);
    }
  });

  it('缺少 filePath 参数', () => {
    const ws = createTempWorkspace({});
    try {
      const tools = getChatToolDefinitions({ db: createDbStub(), projectId: 1, workspacePath: ws });
      const result = toolByName(tools, 'read_file').handler({});

      assert.equal(result.errorCode, 'MISSING_PARAM');
    } finally {
      removeTempDir(ws);
    }
  });

  it('空 filePath 视为缺少参数', () => {
    const ws = createTempWorkspace({});
    try {
      const tools = getChatToolDefinitions({ db: createDbStub(), projectId: 1, workspacePath: ws });
      const result = toolByName(tools, 'read_file').handler({ filePath: '   ' });

      assert.equal(result.errorCode, 'MISSING_PARAM');
    } finally {
      removeTempDir(ws);
    }
  });

  it('256KB 截断：超大文件仅返回前 256KB 并附带截断标记', () => {
    const ws = createTempWorkspace({});
    const bigPath = path.join(ws, 'big.txt');
    try {
      // 创建约 300KB 的文件
      const totalSize = READ_FILE_MAX_BYTES + 50 * 1024; // ~306KB
      const chunk = Buffer.alloc(64 * 1024, 'X'); // 64KB chunks of 'X'
      const fd = fs.openSync(bigPath, 'w');
      try {
        for (let written = 0; written < totalSize; written += chunk.length) {
          fs.writeSync(fd, chunk);
        }
      } finally {
        fs.closeSync(fd);
      }

      const tools = getChatToolDefinitions({ db: createDbStub(), projectId: 1, workspacePath: ws });
      const result = toolByName(tools, 'read_file').handler({ filePath: 'big.txt' });

      assert.equal(result.truncated, true);
      assert.ok(result.content.length <= READ_FILE_MAX_BYTES, '内容应不超过 256KB');
      assert.equal(result.content.length, READ_FILE_MAX_BYTES, '应精确返回 256KB');
      assert.ok(result.fileSize > READ_FILE_MAX_BYTES);
      assert.ok(result.truncationNote, '应包含截断提示');
      assert.match(result.truncationNote, /256KB/);
    } finally {
      removeTempDir(ws);
    }
  });

  it('文件恰好 ≤256KB 时不截断', () => {
    const content = 'x'.repeat(10 * 1024); // 10KB
    const ws = createTempWorkspace({ 'small.txt': content });
    try {
      const tools = getChatToolDefinitions({ db: createDbStub(), projectId: 1, workspacePath: ws });
      const result = toolByName(tools, 'read_file').handler({ filePath: 'small.txt' });

      assert.equal(result.truncated, false);
      assert.equal(result.content, content);
    } finally {
      removeTempDir(ws);
    }
  });

  it('嵌套子目录中的文件正常读取', () => {
    const ws = createTempWorkspace({ 'a/b/c/d.txt': 'deep' });
    try {
      const tools = getChatToolDefinitions({ db: createDbStub(), projectId: 1, workspacePath: ws });
      const result = toolByName(tools, 'read_file').handler({ filePath: 'a/b/c/d.txt' });

      assert.equal(result.content, 'deep');
      assert.equal(result.filePath, 'a/b/c/d.txt');
    } finally {
      removeTempDir(ws);
    }
  });
});

/* ================================================================== read_file 访问策略（需求 #35） ================================================================== */

describe('read_file 访问策略', () => {
  it('custom + 白名单根：可读取白名单根内文件', () => {
    const ws = createTempWorkspace({ 'inside.txt': 'ws-content' });
    const allowedRoot = createTempWorkspace({ 'shared.txt': 'shared-content' });
    try {
      const db = createDbStub({
        settings: {
          'fileAccess.scope': 'custom',
          'fileAccess.allowedRoots': JSON.stringify([allowedRoot]),
        },
      });
      const tools = getChatToolDefinitions({ db, projectId: 1, workspacePath: ws });
      const result = toolByName(tools, 'read_file').handler({ filePath: path.join(allowedRoot, 'shared.txt') });

      assert.equal(result.content, 'shared-content');
    } finally {
      removeTempDir(ws);
      removeTempDir(allowedRoot);
    }
  });

  it('custom + 白名单根：白名单外文件仍被拒', () => {
    const ws = createTempWorkspace({});
    const allowedRoot = createTempWorkspace({});
    const outside = createTempWorkspace({ 'secret.txt': 'secret' });
    try {
      const db = createDbStub({
        settings: {
          'fileAccess.scope': 'custom',
          'fileAccess.allowedRoots': JSON.stringify([allowedRoot]),
        },
      });
      const tools = getChatToolDefinitions({ db, projectId: 1, workspacePath: ws });
      const result = toolByName(tools, 'read_file').handler({ filePath: path.join(outside, 'secret.txt') });

      assert.equal(result.errorCode, 'FILE_PATH_OUTSIDE_SCOPE');
    } finally {
      removeTempDir(ws);
      removeTempDir(allowedRoot);
      removeTempDir(outside);
    }
  });

  it('allowCrossProject=true 等效 custom：可读白名单根内文件', () => {
    const ws = createTempWorkspace({});
    const allowedRoot = createTempWorkspace({ 'shared.txt': 'cross-content' });
    try {
      const db = createDbStub({
        settings: {
          'fileAccess.allowCrossProject': 'true',
          'fileAccess.allowedRoots': JSON.stringify([allowedRoot]),
        },
      });
      const tools = getChatToolDefinitions({ db, projectId: 1, workspacePath: ws });
      const result = toolByName(tools, 'read_file').handler({ filePath: path.join(allowedRoot, 'shared.txt') });

      assert.equal(result.content, 'cross-content');
    } finally {
      removeTempDir(ws);
      removeTempDir(allowedRoot);
    }
  });

  it('默认范围下工作区内文件仍正常读取（策略接入不回归）', () => {
    const ws = createTempWorkspace({ 'src/main.js': 'console.log("hi");\n' });
    try {
      const tools = getChatToolDefinitions({ db: createDbStub(), projectId: 1, workspacePath: ws });
      const result = toolByName(tools, 'read_file').handler({ filePath: 'src/main.js' });

      assert.equal(result.content, 'console.log("hi");\n');
    } finally {
      removeTempDir(ws);
    }
  });
});

/* ================================================================== search_files ================================================================== */

describe('search_files', () => {
  it('缺少 keyword 参数返回错误', async () => {
    const tools = getChatToolDefinitions({
      db: createDbStub(),
      projectId: 1,
      workspacePath: createTempWorkspace({}),
    });
    try {
      const result = await toolByName(tools, 'search_files').handler({});
      assert.equal(result.errorCode, 'MISSING_PARAM');
    } finally {
      removeTempDir(tools[0]?.handler ? '' : ''); // workspace is captured in closure
    }
  });

  it('路径 LIKE 匹配返回结果', async () => {
    const ws = createTempWorkspace({});
    try {
      const db = createDbStub({
        scanFiles: [
          { file_path: 'src/index.js', size: 100, project_id: 1 },
          { file_path: 'src/utils.js', size: 100, project_id: 1 },
          { file_path: 'test/index.test.js', size: 100, project_id: 1 },
        ],
      });
      const tools = getChatToolDefinitions({ db, projectId: 1, workspacePath: ws });
      const result = await toolByName(tools, 'search_files').handler({ keyword: 'utils' });

      assert.ok(Array.isArray(result));
      assert.ok(result.length >= 1, '应至少匹配到 utils.js');
      const match = result.find((r) => r.filePath === 'src/utils.js');
      assert.ok(match);
      assert.equal(match.matchType, 'path');
    } finally {
      removeTempDir(ws);
    }
  });

  it('内容匹配返回结果（关键词在文件内容中）', async () => {
    const ws = createTempWorkspace({
      'src/hello.js': 'const greeting = "hello world";',
      'src/other.js': '// nothing here',
    });
    try {
      const db = createDbStub({
        scanFiles: [
          { file_path: 'src/hello.js', size: 50, project_id: 1 },
          { file_path: 'src/other.js', size: 50, project_id: 1 },
        ],
      });
      const tools = getChatToolDefinitions({ db, projectId: 1, workspacePath: ws });
      const result = await toolByName(tools, 'search_files').handler({ keyword: 'greeting' });

      const match = result.find((r) => r.filePath === 'src/hello.js');
      assert.ok(match, '应找到包含 greeting 的文件');
      assert.equal(match.matchType, 'content');
      assert.ok(match.snippet.includes('greeting'));
    } finally {
      removeTempDir(ws);
    }
  });

  it('内容搜索跳过不存在的文件', async () => {
    const ws = createTempWorkspace({});
    try {
      const db = createDbStub({
        scanFiles: [
          { file_path: 'missing.txt', size: 50, project_id: 1 },
          { file_path: 'also_missing.txt', size: 50, project_id: 1 },
        ],
      });
      const tools = getChatToolDefinitions({ db, projectId: 1, workspacePath: ws });
      const result = await toolByName(tools, 'search_files').handler({ keyword: 'nothing' });

      assert.ok(Array.isArray(result));
      assert.equal(result.length, 0, '不存在文件应跳过，返回空结果');
    } finally {
      removeTempDir(ws);
    }
  });

  it('结果上限 50 条', async () => {
    const ws = createTempWorkspace({});
    // 创建 60 个 scan_files 条目（全部命中路径匹配）
    const scanFiles = [];
    for (let i = 0; i < 60; i += 1) {
      scanFiles.push({ file_path: `src/module_${i}.js`, size: 10, project_id: 1 });
    }
    try {
      const db = createDbStub({ scanFiles });
      const tools = getChatToolDefinitions({ db, projectId: 1, workspacePath: ws });
      const result = await toolByName(tools, 'search_files').handler({ keyword: 'module' });

      assert.ok(result.length <= 50, `结果数 ${result.length} 不应超过 50`);
    } finally {
      removeTempDir(ws);
    }
  });

  it('大 scan_files 表仍通过有界数据库查询提供搜索结果', async () => {
    const scanFiles = Array.from({ length: 250 }, (_, index) => ({
      file_path: `src/file_${String(index).padStart(3, '0')}.txt`,
      size: 20,
      project_id: 1,
      scanned_at: `2026-07-03T00:${String(index % 60).padStart(2, '0')}:00.000Z`,
    }));
    const ws = createTempWorkspace({
      'src/file_199.txt': 'needle inside content scan window',
      'src/file_249.txt': 'needle outside content scan window',
    });
    try {
      const db = createDbStub({ scanFiles });
      const tools = getChatToolDefinitions({ db, projectId: 1, workspacePath: ws });
      const result = await toolByName(tools, 'search_files').handler({ keyword: 'needle' });

      assert.equal(db.countAll((sql) => isSearchFilesPathQuery(sql)), 1);
      assert.equal(db.countAll((sql) => isSearchFilesContentQuery(sql)), 1);
      const pathQuery = db._allCalls.find((entry) => isSearchFilesPathQuery(entry.sql));
      const contentQuery = db._allCalls.find((entry) => isSearchFilesContentQuery(entry.sql));
      assert.deepEqual(pathQuery.params, [1, '%needle%', 50]);
      assert.deepEqual(contentQuery.params, [1, 200]);
      assert.deepEqual(result.map((item) => item.filePath), ['src/file_199.txt']);
      assert.ok(!result.some((item) => item.filePath === 'src/file_249.txt'), '内容扫描应受 200 条上限约束');
    } finally {
      removeTempDir(ws);
    }
  });

  it('搜索超时保护：大量文件内容扫描时不会无限阻塞', async () => {
    const ws = createTempWorkspace({});
    // 创建大量 scan_files 条目指向实际存在的小文件
    const scanFiles = [];
    const files = {};
    for (let i = 0; i < 70; i += 1) {
      const name = `src/file_${i}.txt`;
      scanFiles.push({ file_path: name, size: 20, project_id: 1 });
      files[name] = `content of file ${i}`;
    }
    // 重建带真实文件的 workspace
    removeTempDir(ws);
    const ws2 = createTempWorkspace(files);
    try {
      const db = createDbStub({ scanFiles });
      const tools = getChatToolDefinitions({ db, projectId: 1, workspacePath: ws2 });

      const start = Date.now();
      const result = await toolByName(tools, 'search_files').handler({ keyword: 'content' });
      const elapsed = Date.now() - start;

      // 正常应在数秒内返回（真实超时会由 setTimeout 保护）
      assert.ok(Array.isArray(result));
      assert.ok(elapsed < 6000, `搜索耗时 ${elapsed}ms 不应超过 6s`);
    } finally {
      removeTempDir(ws2);
    }
  }, { timeout: 10000 });

  it('路径与内容去重：同一文件不重复出现', async () => {
    const ws = createTempWorkspace({
      'src/readme.md': '# Readme\n\nThis is about utils and helpers.',
    });
    try {
      const db = createDbStub({
        scanFiles: [{ file_path: 'src/readme.md', size: 100, project_id: 1 }],
      });
      const tools = getChatToolDefinitions({ db, projectId: 1, workspacePath: ws });
      const result = await toolByName(tools, 'search_files').handler({ keyword: 'readme' });

      // 文件名匹配 + 内容匹配同一个文件，应去重
      const readmeHits = result.filter((r) => r.filePath === 'src/readme.md');
      assert.equal(readmeHits.length, 1, '同一文件不应重复出现');
    } finally {
      removeTempDir(ws);
    }
  });

  it('内容搜索跳过 >1MB 的大文件', async () => {
    const ws = createTempWorkspace({});
    try {
      const db = createDbStub({
        scanFiles: [
          { file_path: 'large.bin', size: 2 * 1024 * 1024, project_id: 1 }, // 2MB — 应跳过
          { file_path: 'small.txt', size: 100, project_id: 1 },
        ],
      });
      // 只创建 small.txt（large.bin 不存在也会跳过）
      fs.writeFileSync(path.join(ws, 'small.txt'), 'needle in haystack');
      // 不创建 large.bin——即使 size > 1MB，fs.existsSync 会先返回 false

      const tools = getChatToolDefinitions({ db, projectId: 1, workspacePath: ws });
      const result = await toolByName(tools, 'search_files').handler({ keyword: 'needle' });

      // large.bin 两条防线：1) size>1MB 跳过  2) 不存在时 existsSync 跳过
      const largeHits = result.filter((r) => r.filePath === 'large.bin');
      assert.equal(largeHits.length, 0, '>1MB 文件应被跳过');
    } finally {
      removeTempDir(ws);
    }
  });
});

/* ================================================================== create_requirement ================================================================== */

describe('create_requirement', () => {
  it('调用 IntakeService.createRequirement 且 autoRun=true', () => {
    const intake = createIntakeServiceStub();
    const tools = getChatToolDefinitions({
      db: createDbStub(),
      projectId: 5,
      workspacePath: createTempWorkspace({}),
      intakeService: intake,
    });
    try {
      const result = toolByName(tools, 'create_requirement').handler({
        title: '新功能',
        body: '## 描述\n\n实现新功能',
      });

      assert.equal(intake.createRequirementCalls.length, 1);
      const call = intake.createRequirementCalls[0];
      assert.equal(call.projectId, 5);
      assert.equal(call.title, '新功能');
      assert.equal(call.body, '## 描述\n\n实现新功能');
      assert.equal(call.autoRun, true);

      assert.ok(result.id);
      assert.equal(result.title, '新功能');
      assert.equal(result.status, 'open');
      // 需求 #36：富化工具结果——附带可打开引用
      assert.equal(result.type, 'requirement');
      assert.equal(result.projectId, 5);
      assert.equal(result.openable, true);
    } finally {
      removeTempDir(
        tools.find((t) => t.name === 'read_file')?.handler
          ? '' // handler closure captures ws
          : '',
      );
    }
  });

  it('IntakeService 未注入时返回错误', () => {
    const tools = getChatToolDefinitions({
      db: createDbStub(),
      projectId: 1,
      workspacePath: createTempWorkspace({}),
    });
    try {
      const result = toolByName(tools, 'create_requirement').handler({
        title: 'test',
        body: 'body',
      });

      assert.equal(result.errorCode, 'SERVICE_UNAVAILABLE');
    } finally {
      removeTempDir(
        tools.find((t) => t.name === 'read_file')?.handler ? '' : '',
      );
    }
  });

  it('缺少 title 返回错误', () => {
    const intake = createIntakeServiceStub();
    const ws = createTempWorkspace({});
    try {
      const tools = getChatToolDefinitions({ db: createDbStub(), projectId: 1, workspacePath: ws, intakeService: intake });
      const result = toolByName(tools, 'create_requirement').handler({ body: 'no title' });

      assert.equal(result.errorCode, 'MISSING_PARAM');
      assert.equal(intake.createRequirementCalls.length, 0, '不应调用 IntakeService');
    } finally {
      removeTempDir(ws);
    }
  });

  it('IntakeService 抛错时返回结构化错误', () => {
    const intake = {
      createRequirement() {
        throw new Error('项目不存在');
      },
    };
    const ws = createTempWorkspace({});
    try {
      const tools = getChatToolDefinitions({ db: createDbStub(), projectId: 999, workspacePath: ws, intakeService: intake });
      const result = toolByName(tools, 'create_requirement').handler({ title: 'test', body: 'body' });

      assert.equal(result.errorCode, 'CREATE_FAILED');
      assert.match(result.error, /项目不存在/);
    } finally {
      removeTempDir(ws);
    }
  });
});

/* ================================================================== create_feedback ================================================================== */

describe('create_feedback', () => {
  it('调用 IntakeService.createFeedback 且 autoRun=true', () => {
    const intake = createIntakeServiceStub();
    const ws = createTempWorkspace({});
    try {
      const tools = getChatToolDefinitions({ db: createDbStub(), projectId: 3, workspacePath: ws, intakeService: intake });
      const result = toolByName(tools, 'create_feedback').handler({
        title: 'Bug 反馈',
        body: '发现一个问题',
      });

      assert.equal(intake.createFeedbackCalls.length, 1);
      const call = intake.createFeedbackCalls[0];
      assert.equal(call.projectId, 3);
      assert.equal(call.title, 'Bug 反馈');
      assert.equal(call.autoRun, true);

      assert.ok(result.id);
      assert.equal(result.title, 'Bug 反馈');
      assert.equal(result.status, 'open');
      // 需求 #36：富化工具结果——附带可打开引用
      assert.equal(result.type, 'feedback');
      assert.equal(result.projectId, 3);
      assert.equal(result.openable, true);
    } finally {
      removeTempDir(ws);
    }
  });

  it('IntakeService 未注入时返回错误', () => {
    const ws = createTempWorkspace({});
    try {
      const tools = getChatToolDefinitions({ db: createDbStub(), projectId: 1, workspacePath: ws });
      const result = toolByName(tools, 'create_feedback').handler({ title: 'test', body: 'body' });

      assert.equal(result.errorCode, 'SERVICE_UNAVAILABLE');
    } finally {
      removeTempDir(ws);
    }
  });

  it('缺少 title 返回错误', () => {
    const intake = createIntakeServiceStub();
    const ws = createTempWorkspace({});
    try {
      const tools = getChatToolDefinitions({ db: createDbStub(), projectId: 1, workspacePath: ws, intakeService: intake });
      const result = toolByName(tools, 'create_feedback').handler({ body: 'body' });

      assert.equal(result.errorCode, 'MISSING_PARAM');
    } finally {
      removeTempDir(ws);
    }
  });
});

/* ================================================================== open_requirement ================================================================== */

describe('open_requirement', () => {
  it('按 id 命中返回详情（含 linkedPlan）', () => {
    const ws = createTempWorkspace({});
    try {
      const db = createDbStub({
        requirements: [
          { id: 10, project_id: 1, title: '登录功能', body: '实现登录', status: 'open', linked_plan_id: 50, created_at: '2026-01-01', updated_at: '2026-01-01' },
        ],
        plans: [
          { id: 50, project_id: 1, file_path: 'docs/plan/p50.md', status: 'in_progress', completed_tasks: 2, total_tasks: 5 },
        ],
      });
      const tools = getChatToolDefinitions({ db, projectId: 1, workspacePath: ws });
      const result = toolByName(tools, 'open_requirement').handler({ id: 10 });

      assert.equal(result.type, 'requirement');
      assert.equal(result.projectId, 1);
      assert.equal(result.id, 10);
      assert.equal(result.title, '登录功能');
      assert.equal(result.body, '实现登录');
      assert.equal(result.status, 'open');
      assert.equal(result.openable, true);
      assert.deepEqual(result.linkedPlan, {
        id: 50,
        title: 'Plan #50', // plan markdown 文件不存在，回退 Plan #id
        filePath: 'docs/plan/p50.md',
        status: 'in_progress',
        completed: 2,
        total: 5,
      });
      assert.equal(result.linkedPlans.length, 1, 'legacy 单计划应归一化为 linkedPlans 数组');
      assert.equal(result.linkedPlans[0].planId, 50);
      assert.equal(result.linkedPlans[0].phaseIndex, 1);
      assert.equal(result.linkedPlans[0].current, true);
    } finally {
      removeTempDir(ws);
    }
  });

  it('按 id 命中返回多个阶段 linkedPlans，linkedPlan 兼容字段指向当前阶段', () => {
    const ws = createTempWorkspace({});
    try {
      const db = createDbStub({
        requirements: [
          { id: 15, project_id: 1, title: '阶段化需求', body: '分阶段实施', status: 'open', linked_plan_id: 70, created_at: '2026-03-01', updated_at: '2026-03-01' },
        ],
        plans: [
          { id: 70, project_id: 1, file_path: 'docs/plan/p70.md', status: 'completed', completed_tasks: 2, total_tasks: 2, validation_passed: 1 },
          { id: 71, project_id: 1, file_path: 'docs/plan/p71.md', status: 'pending', completed_tasks: 1, total_tasks: 4, validation_passed: 0 },
        ],
        intakePlanLinks: [
          { id: 701, project_id: 1, intake_type: 'requirement', intake_id: 15, plan_id: 70, phase_index: 1, phase_title: '基础阶段' },
          { id: 702, project_id: 1, intake_type: 'requirement', intake_id: 15, plan_id: 71, phase_index: 2, phase_title: '交付阶段' },
        ],
      });
      const tools = getChatToolDefinitions({ db, projectId: 1, workspacePath: ws });
      const result = toolByName(tools, 'open_requirement').handler({ id: 15 });

      assert.equal(result.linkedPlan.id, 71, '兼容 linkedPlan 应指向当前未完成阶段');
      assert.deepEqual(result.linkedPlans.map((plan) => plan.planId), [70, 71]);
      assert.deepEqual(result.linkedPlans.map((plan) => plan.phaseIndex), [1, 2]);
      assert.deepEqual(result.linkedPlans.map((plan) => plan.phaseTitle), ['基础阶段', '交付阶段']);
      assert.deepEqual(result.linkedPlans.map((plan) => plan.current), [false, true]);
      assert.deepEqual(
        result.linkedPlans.map((plan) => [plan.status, plan.completed, plan.total, plan.validationPassed]),
        [['completed', 2, 2, 1], ['pending', 1, 4, 0]],
      );
    } finally {
      removeTempDir(ws);
    }
  });

  it('按 id 命中但无关联 Plan 时 linkedPlan 为 null', () => {
    const ws = createTempWorkspace({});
    try {
      const db = createDbStub({
        requirements: [
          { id: 11, project_id: 1, title: '无计划需求', body: 'b', status: 'open', linked_plan_id: null, created_at: '2026-02-01', updated_at: '2026-02-01' },
        ],
      });
      const tools = getChatToolDefinitions({ db, projectId: 1, workspacePath: ws });
      const result = toolByName(tools, 'open_requirement').handler({ id: 11 });

      assert.equal(result.id, 11);
      assert.equal(result.linkedPlan, null);
      assert.deepEqual(result.linkedPlans, []);
      assert.equal(result.openable, true);
    } finally {
      removeTempDir(ws);
    }
  });

  it('按 title 模糊命中取最近更新的一条', () => {
    const ws = createTempWorkspace({});
    try {
      const db = createDbStub({
        requirements: [
          { id: 10, project_id: 1, title: '登录功能', body: 'a', status: 'open', linked_plan_id: null, created_at: '2026-01-01', updated_at: '2026-01-01' },
          { id: 11, project_id: 1, title: '登录优化', body: 'b', status: 'in_progress', linked_plan_id: null, created_at: '2026-02-01', updated_at: '2026-02-02' },
        ],
      });
      const tools = getChatToolDefinitions({ db, projectId: 1, workspacePath: ws });
      const result = toolByName(tools, 'open_requirement').handler({ title: '登录' });

      assert.equal(result.id, 11, '应返回 updated_at 更新的「登录优化」');
      assert.equal(result.title, '登录优化');
    } finally {
      removeTempDir(ws);
    }
  });

  it('id 属于其它项目时返回 INTAKE_NOT_FOUND（项目隔离）', () => {
    const ws = createTempWorkspace({});
    try {
      const db = createDbStub({
        requirements: [
          { id: 12, project_id: 2, title: '其他项目', body: '', status: 'open', linked_plan_id: null, created_at: '', updated_at: '' },
        ],
      });
      const tools = getChatToolDefinitions({ db, projectId: 1, workspacePath: ws });
      const result = toolByName(tools, 'open_requirement').handler({ id: 12 });

      assert.equal(result.errorCode, 'INTAKE_NOT_FOUND');
      assert.match(result.error, /未找到/);
    } finally {
      removeTempDir(ws);
    }
  });

  it('title 未命中返回 INTAKE_NOT_FOUND', () => {
    const ws = createTempWorkspace({});
    try {
      const db = createDbStub({
        requirements: [
          { id: 10, project_id: 1, title: '登录功能', body: '', status: 'open', linked_plan_id: null, created_at: '', updated_at: '' },
        ],
      });
      const tools = getChatToolDefinitions({ db, projectId: 1, workspacePath: ws });
      const result = toolByName(tools, 'open_requirement').handler({ title: '不存在的关键词' });

      assert.equal(result.errorCode, 'INTAKE_NOT_FOUND');
    } finally {
      removeTempDir(ws);
    }
  });

  it('未提供 id 与 title 返回 INTAKE_NOT_FOUND', () => {
    const ws = createTempWorkspace({});
    try {
      const tools = getChatToolDefinitions({ db: createDbStub(), projectId: 1, workspacePath: ws });
      const result = toolByName(tools, 'open_requirement').handler({});

      assert.equal(result.errorCode, 'INTAKE_NOT_FOUND');
    } finally {
      removeTempDir(ws);
    }
  });
});

/* ================================================================== open_feedback ================================================================== */

describe('open_feedback', () => {
  it('按 id 命中返回详情（含 linkedPlan）', () => {
    const ws = createTempWorkspace({});
    try {
      const db = createDbStub({
        feedback: [
          { id: 20, project_id: 1, title: '崩溃反馈', body: '页面崩溃', status: 'open', linked_plan_id: 60, created_at: '2026-01-03', updated_at: '2026-01-03' },
        ],
        plans: [
          { id: 60, project_id: 1, file_path: 'docs/plan/p60.md', status: 'pending', completed_tasks: 0, total_tasks: 3 },
        ],
      });
      const tools = getChatToolDefinitions({ db, projectId: 1, workspacePath: ws });
      const result = toolByName(tools, 'open_feedback').handler({ id: 20 });

      assert.equal(result.type, 'feedback');
      assert.equal(result.projectId, 1);
      assert.equal(result.id, 20);
      assert.equal(result.title, '崩溃反馈');
      assert.equal(result.openable, true);
      assert.deepEqual(result.linkedPlan, {
        id: 60,
        title: 'Plan #60',
        filePath: 'docs/plan/p60.md',
        status: 'pending',
        completed: 0,
        total: 3,
      });
      assert.equal(result.linkedPlans.length, 1);
      assert.equal(result.linkedPlans[0].planId, 60);
      assert.equal(result.linkedPlans[0].current, true);
    } finally {
      removeTempDir(ws);
    }
  });

  it('按 title 模糊命中（无关联 Plan）', () => {
    const ws = createTempWorkspace({});
    try {
      const db = createDbStub({
        feedback: [
          { id: 20, project_id: 1, title: '崩溃反馈', body: '', status: 'open', linked_plan_id: null, created_at: '', updated_at: '2026-01-01' },
        ],
      });
      const tools = getChatToolDefinitions({ db, projectId: 1, workspacePath: ws });
      const result = toolByName(tools, 'open_feedback').handler({ title: '崩溃' });

      assert.equal(result.id, 20);
      assert.equal(result.linkedPlan, null);
      assert.deepEqual(result.linkedPlans, []);
    } finally {
      removeTempDir(ws);
    }
  });

  it('未命中返回 INTAKE_NOT_FOUND', () => {
    const ws = createTempWorkspace({});
    try {
      const tools = getChatToolDefinitions({ db: createDbStub(), projectId: 1, workspacePath: ws });
      const result = toolByName(tools, 'open_feedback').handler({ id: 999 });

      assert.equal(result.errorCode, 'INTAKE_NOT_FOUND');
    } finally {
      removeTempDir(ws);
    }
  });
});

/* ================================================================== create_plan ================================================================== */

describe('create_plan', () => {
  it('注册严格 input_schema：必填字段、数组 item 约束和 additionalProperties=false', () => {
    const ws = createTempWorkspace({});
    try {
      const tools = getChatToolDefinitions({ db: createDbStub(), projectId: 1, workspacePath: ws });
      const tool = toolByName(tools, 'create_plan');

      assert.ok(tool, '应注册 create_plan 工具');
      assert.equal(tool.strict, true);
      assert.equal(tool.input_schema.additionalProperties, false);
      assert.deepEqual(tool.input_schema.required, ['title', 'summary', 'tasks', 'overallAcceptance']);
      assert.equal(tool.input_schema.properties.tasks.type, 'array');
      assert.equal(tool.input_schema.properties.tasks.minItems, 1);
      const taskSchema = tool.input_schema.properties.tasks.items;
      assert.equal(taskSchema.additionalProperties, false);
      assert.deepEqual(taskSchema.required, ['title', 'scope', 'acceptancePoints']);
      assert.equal(taskSchema.properties.acceptancePoints.type, 'array');
      assert.equal(taskSchema.properties.acceptancePoints.minItems, 1);
      assert.equal(taskSchema.properties.acceptancePoints.items.type, 'string');
      const acceptanceSchema = tool.input_schema.properties.overallAcceptance;
      assert.equal(acceptanceSchema.additionalProperties, false);
      assert.deepEqual(acceptanceSchema.required, ['commands', 'scope', 'passCriteria']);
    } finally {
      removeTempDir(ws);
    }
  });

  it('合法 JSON 入参生成合规 markdown，写入 docs/plan，调用 insertPlan 和 syncPlanTasks', () => {
    const ws = createTempWorkspace({});
    const db = createDbStub();
    const planService = createPlanServiceStub({ insertResult: 77 });
    try {
      const tools = getChatToolDefinitions({
        db,
        projectId: 9,
        workspacePath: ws,
        loopService: planService,
        conversationId: 42,
      });
      const result = toolByName(tools, 'create_plan').handler(validCreatePlanInput());

      assert.equal(result.errorCode, undefined);
      assert.equal(result.id, 77);
      assert.equal(result.type, 'plan');
      assert.equal(result.title, '对话直接创建计划');
      assert.equal(result.status, 'pending');
      assert.equal(result.totalTasks, 2);
      assert.equal(result.openable, true);
      assert.match(result.filePath, /^docs\/plan\/plan_chat_42_\d{8}-\d{6}\.md$/);

      const planFile = path.join(ws, result.filePath);
      assert.equal(fs.existsSync(planFile), true, '应写入计划文件');
      const markdown = fs.readFileSync(planFile, 'utf8');
      assert.match(markdown, /^## 任务拆解/m);
      assert.match(markdown, /^- \[ \] P001: 实现 create_plan 后端写入 <!-- scope: src\/chat\/chatTools\.js -->$/m);
      assert.match(markdown, /^- \[ \] P002: 完整验收 <!-- scope: validation -->$/m);
      assert.ok(!markdown.includes('P999'), '不应信任模型传入编号');
      assert.ok(markdown.includes('  - 验收要点：'));
      assert.ok(!/^\s+- \[[ xX]\]/m.test(markdown.split('## 总体验收标准')[0].replace(/^- \[ \].*$/gm, '')));

      assert.equal(planService.insertPlanCalls.length, 1);
      assert.equal(planService.insertPlanCalls[0].projectId, 9);
      assert.equal(planService.insertPlanCalls[0].filePath, result.filePath);
      assert.equal(planService.insertPlanCalls[0].status, 'pending');
      assert.match(planService.insertPlanCalls[0].issueHash, /^chat-9-42-[0-9a-f]{16}$/);
      assert.match(planService.insertPlanCalls[0].hash, /^[0-9a-f]{64}$/);
      assert.deepEqual(planService.syncPlanTasksCalls, [{ planId: 77, planFile }]);
      assert.equal(planService.addEventCalls[0].type, 'plan.generated');
    } finally {
      removeTempDir(ws);
    }
  });

  it('完整验收任务缺失或位置错误时规范化到最后，scope=validation', () => {
    const ws = createTempWorkspace({});
    const planService = createPlanServiceStub({ insertResult: 78 });
    try {
      const tools = getChatToolDefinitions({
        db: createDbStub(),
        projectId: 1,
        workspacePath: ws,
        loopService: planService,
        conversationId: 1,
      });
      const result = toolByName(tools, 'create_plan').handler(validCreatePlanInput({
        tasks: [
          {
            title: '完整验收',
            scope: 'validation',
            acceptancePoints: ['最终命令全部通过'],
          },
          {
            title: '开发任务',
            scope: 'src/foo.js',
            acceptancePoints: ['完成实现'],
          },
        ],
      }));

      const markdown = fs.readFileSync(path.join(ws, result.filePath), 'utf8');
      const taskLines = markdown.split(/\r?\n/).filter((line) => line.startsWith('- [ ] P'));
      assert.deepEqual(taskLines, [
        '- [ ] P001: 开发任务 <!-- scope: src/foo.js -->',
        '- [ ] P002: 完整验收 <!-- scope: validation -->',
      ]);
      assert.ok(markdown.includes('最终命令全部通过'));
    } finally {
      removeTempDir(ws);
    }
  });

  it('缺少任务、scope 或验收要点时返回结构化错误且不写入计划', () => {
    const cases = [
      { name: 'missing tasks', input: validCreatePlanInput({ tasks: [] }) },
      { name: 'missing scope', input: validCreatePlanInput({ tasks: [{ title: '任务', acceptancePoints: ['验收'] }] }) },
      { name: 'missing acceptancePoints', input: validCreatePlanInput({ tasks: [{ title: '任务', scope: 'src/foo.js' }] }) },
    ];

    for (const item of cases) {
      const ws = createTempWorkspace({});
      const planService = createPlanServiceStub();
      try {
        const tools = getChatToolDefinitions({
          db: createDbStub(),
          projectId: 1,
          workspacePath: ws,
          loopService: planService,
          conversationId: 1,
        });
        const result = toolByName(tools, 'create_plan').handler(item.input);

        assert.equal(result.errorCode, 'INVALID_CREATE_PLAN_INPUT', item.name);
        assert.equal(planService.insertPlanCalls.length, 0, item.name);
        assert.equal(planService.syncPlanTasksCalls.length, 0, item.name);
        assert.equal(planMarkdownFiles(ws).length, 0, item.name);
      } finally {
        removeTempDir(ws);
      }
    }
  });

  it('计划格式校验失败时删除产物，不落库且不同步任务', () => {
    const chatToolsPath = require.resolve('./chatTools');
    const planGenerationPath = require.resolve('../loop/planGeneration');
    const planGeneration = require(planGenerationPath);
    const originalValidator = planGeneration.isPlanContentValid;
    delete require.cache[chatToolsPath];
    planGeneration.isPlanContentValid = () => false;
    const { getChatToolDefinitions: getFreshTools } = require('./chatTools');

    const ws = createTempWorkspace({});
    const planService = createPlanServiceStub();
    try {
      const tools = getFreshTools({
        db: createDbStub(),
        projectId: 1,
        workspacePath: ws,
        loopService: planService,
        conversationId: 1,
      });
      const result = toolByName(tools, 'create_plan').handler(validCreatePlanInput());

      assert.equal(result.errorCode, 'PLAN_FORMAT_INVALID');
      assert.equal(planService.insertPlanCalls.length, 0);
      assert.equal(planService.syncPlanTasksCalls.length, 0);
      assert.equal(planMarkdownFiles(ws).length, 0);
    } finally {
      planGeneration.isPlanContentValid = originalValidator;
      delete require.cache[chatToolsPath];
      require('./chatTools');
      removeTempDir(ws);
    }
  });
});

/* ================================================================== create_script ================================================================== */

describe('create_script', () => {
  it('INSERT 落库且仅落库不执行（无 runScript 调用）', () => {
    const db = createDbStub();
    const ws = createTempWorkspace({});
    try {
      const tools = getChatToolDefinitions({ db, projectId: 1, workspacePath: ws });
      const result = toolByName(tools, 'create_script').handler({
        name: 'my-script',
        body: 'console.log("hello")',
        runtime: 'node',
        description: '测试脚本',
      });

      assert.equal(db._insertedScripts.length, 1);
      const inserted = db._insertedScripts[0];
      assert.ok(inserted.sql.includes('INSERT INTO scripts'));
      assert.equal(inserted.params[0], 1); // project_id
      assert.equal(inserted.params[1], 'my-script'); // name
      assert.equal(inserted.params[3], 'node'); // runtime (index 3 because path='' at index 2)

      assert.equal(result.id, 1);
      assert.equal(result.name, 'my-script');
      assert.equal(result.runtime, 'node');

      // 验证无 runScript 调用：仅检查 INSERT SQL，不含有任何 "run" 相关操作
      assert.ok(!inserted.sql.toLowerCase().includes('run'), '不应包含任何执行操作');
    } finally {
      removeTempDir(ws);
    }
  });

  it('缺少 name 返回错误', () => {
    const ws = createTempWorkspace({});
    try {
      const tools = getChatToolDefinitions({ db: createDbStub(), projectId: 1, workspacePath: ws });
      const result = toolByName(tools, 'create_script').handler({ body: 'code', runtime: 'bash' });

      assert.equal(result.errorCode, 'MISSING_PARAM');
    } finally {
      removeTempDir(ws);
    }
  });

  it('非法 runtime 回退为 node', () => {
    const db = createDbStub();
    const ws = createTempWorkspace({});
    try {
      const tools = getChatToolDefinitions({ db, projectId: 1, workspacePath: ws });
      const result = toolByName(tools, 'create_script').handler({
        name: 's',
        body: 'echo hi',
        runtime: 'ruby',
      });

      assert.equal(result.runtime, 'node');
    } finally {
      removeTempDir(ws);
    }
  });

  it('合法 runtime（python/bash/sh）正确保留', () => {
    const db = createDbStub();
    const ws = createTempWorkspace({});
    try {
      for (const rt of ['python', 'bash', 'sh']) {
        const tools = getChatToolDefinitions({ db, projectId: 1, workspacePath: ws });
        const result = toolByName(tools, 'create_script').handler({
          name: `script-${rt}`,
          body: 'pass',
          runtime: rt,
        });
        assert.equal(result.runtime, rt);
      }
    } finally {
      removeTempDir(ws);
    }
  });

  it('INSERT 失败时返回结构化错误', () => {
    const db = {
      all: () => [],
      insert() {
        throw new Error('DB write error');
      },
      run() {},
      get() {
        return null;
      },
    };
    const ws = createTempWorkspace({});
    try {
      const tools = getChatToolDefinitions({ db, projectId: 1, workspacePath: ws });
      const result = toolByName(tools, 'create_script').handler({ name: 'x', body: 'x' });

      assert.equal(result.errorCode, 'CREATE_FAILED');
      assert.match(result.error, /DB write error/);
    } finally {
      removeTempDir(ws);
    }
  });
});

/* ================================================================== executors ================================================================== */

describe('executor chat tools', () => {
  it('list_executors returns current-project executors with recent status and log tails', () => {
    const ws = createTempWorkspace({});
    try {
      const longLog = `${'x'.repeat(3200)}tail`;
      const db = createDbStub({
        executors: [
          executorRow({ id: 1, label: 'build', command: 'npm run build', group_kind: 'build', last_status: 'ok', last_exit_code: 0, last_duration_ms: 80, last_log: longLog }),
          executorRow({ id: 2, label: 'test', command: 'npm test', group_kind: 'test', enabled: 0, last_status: 'bad', last_exit_code: 1 }),
          executorRow({ id: 3, project_id: 2, label: 'other project', command: 'npm run other' }),
        ],
      });
      const tools = getChatToolDefinitions({
        db,
        projectId: 1,
        workspacePath: ws,
        loopService: createExecutorLoopService(),
      });

      const result = toolByName(tools, 'list_executors').handler({ scope: 'current_project', group: 'build' });

      assert.equal(result.type, 'executor_list');
      assert.equal(result.projectId, 1);
      assert.equal(result.count, 1);
      const [executor] = result.executors;
      assert.equal(executor.type, 'executor');
      assert.equal(executor.id, 1);
      assert.equal(executor.label, 'build');
      assert.equal(executor.status, 'ok');
      assert.equal(executor.exitCode, 0);
      assert.equal(executor.durationMs, 80);
      assert.equal(executor.logTail.length, 3000);
      assert.ok(executor.logTail.endsWith('tail'));
      assert.equal(executor.openRef.anchorId, 'workspace-executor-1');
      assert.equal(executor.openRef.link, '#/projects/1?tab=executors&anchor=workspace-executor-1');
    } finally {
      removeTempDir(ws);
    }
  });

  it('run_executor resolves an existing executor and returns a summarized run result', async () => {
    const ws = createTempWorkspace({});
    try {
      const db = createDbStub({
        executors: [executorRow({ id: 4, label: 'test', command: 'npm test', group_kind: 'test' })],
      });
      const loopService = createExecutorLoopService({
        runResult: {
          executorId: 4,
          label: 'test',
          status: 'bad',
          exitCode: 1,
          durationMs: 123,
          log: `${'L'.repeat(3100)}END`,
          logFile: 'docs/progress/logs/test.log',
          dependencyResults: [
            { executorId: 3, label: 'prepare', status: 'ok', exitCode: 0, durationMs: 20, log: 'prepare ok' },
          ],
        },
      });
      const tools = getChatToolDefinitions({ db, projectId: 1, workspacePath: ws, loopService });

      const result = await toolByName(tools, 'run_executor').handler({ label: 'test' });

      assert.deepEqual(loopService.runExecutorCalls, [{ projectId: 1, executorId: 4 }]);
      assert.equal(result.id, 4);
      assert.equal(result.label, 'test');
      assert.equal(result.status, 'bad');
      assert.equal(result.exitCode, 1);
      assert.equal(result.durationMs, 123);
      assert.equal(result.logTail.length, 3000);
      assert.ok(result.logTail.endsWith('END'));
      assert.equal(result.log, undefined, 'full long log should not be returned');
      assert.deepEqual(result.dependencyResults.map((item) => [item.executorId, item.label, item.status]), [
        [3, 'prepare', 'ok'],
      ]);
    } finally {
      removeTempDir(ws);
    }
  });

  it('stop_executor stops an existing executor without accepting arbitrary command fields', () => {
    const ws = createTempWorkspace({});
    try {
      const db = createDbStub({
        executors: [executorRow({ id: 5, label: 'watch', command: 'npm run watch', last_status: 'running' })],
      });
      const loopService = createExecutorLoopService({ stopResult: { stopped: 2, executorId: 5, label: 'watch' } });
      const tools = getChatToolDefinitions({ db, projectId: 1, workspacePath: ws, loopService });

      const stopped = toolByName(tools, 'stop_executor').handler({ id: 5 });
      const rejected = toolByName(tools, 'stop_executor').handler({ id: 5, command: 'npm run anything' });

      assert.deepEqual(loopService.stopExecutorCalls, [{ projectId: 1, executorId: 5 }]);
      assert.equal(stopped.stopped, 2);
      assert.equal(stopped.label, 'watch');
      assert.equal(rejected.errorCode, 'UNSUPPORTED_EXECUTOR_FIELDS');
      assert.deepEqual(rejected.unsupportedFields, ['command']);
    } finally {
      removeTempDir(ws);
    }
  });

  it('open_executor returns structured unavailable results for missing or deleted executors', () => {
    const ws = createTempWorkspace({});
    try {
      const tools = getChatToolDefinitions({
        db: createDbStub({ executors: [executorRow({ id: 7, label: 'build', command: 'npm run build' })] }),
        projectId: 1,
        workspacePath: ws,
        loopService: createExecutorLoopService(),
      });

      const found = toolByName(tools, 'open_executor').handler({ id: 7 });
      const missing = toolByName(tools, 'open_executor').handler({ id: 99 });

      assert.equal(found.action, 'open');
      assert.equal(found.openable, true);
      assert.equal(found.openRef.anchorId, 'workspace-executor-7');
      assert.equal(missing.available, false);
      assert.equal(missing.openable, false);
      assert.equal(missing.errorCode, 'EXECUTOR_UNAVAILABLE');
      assert.match(missing.error, /未找到执行器/);
    } finally {
      removeTempDir(ws);
    }
  });

  it('executor tools reject launch/debug adapter shaped parameters', () => {
    const ws = createTempWorkspace({});
    try {
      const tools = getChatToolDefinitions({
        db: createDbStub({ executors: [executorRow({ id: 8, label: 'safe', command: 'npm test' })] }),
        projectId: 1,
        workspacePath: ws,
        loopService: createExecutorLoopService(),
      });

      const result = toolByName(tools, 'run_executor').handler({ id: 8, request: 'launch', debugServer: 4711 });

      assert.equal(result.errorCode, 'UNSUPPORTED_EXECUTOR_FIELDS');
      assert.deepEqual(result.unsupportedFields, ['request', 'debugServer']);
    } finally {
      removeTempDir(ws);
    }
  });
});

/* ================================================================== 白名单校验 ================================================================== */

describe('白名单', () => {
  it('仅包含安全工具（含执行器受限工具，不含通用文件编辑/命令执行）', () => {
    const ws = createTempWorkspace({});
    try {
      const tools = getChatToolDefinitions({ db: createDbStub(), projectId: 1, workspacePath: ws });

      assert.equal(tools.length, 12);
      const names = tools.map((t) => t.name);
      assert.deepEqual(names.sort(), [
        'create_feedback',
        'create_plan',
        'create_requirement',
        'create_script',
        'list_executors',
        'open_feedback',
        'open_executor',
        'open_requirement',
        'read_file',
        'run_executor',
        'search_files',
        'stop_executor',
      ].sort());
    } finally {
      removeTempDir(ws);
    }
  });

  it('不含 write_file/edit_file/delete/run_command/run_script', () => {
    const ws = createTempWorkspace({});
    try {
      const tools = getChatToolDefinitions({ db: createDbStub(), projectId: 1, workspacePath: ws });
      const forbidden = ['write_file', 'edit_file', 'delete', 'run_command', 'run_script'];

      for (const tool of tools) {
        const nameLower = tool.name.toLowerCase();
        for (const word of forbidden) {
          assert.ok(
            !nameLower.includes(word.toLowerCase()),
            `工具名 "${tool.name}" 不应包含被禁关键词 "${word}"`,
          );
        }
        // 也检查 description 不含这些操作
        const desc = (tool.description || '').toLowerCase();
        assert.ok(!desc.includes('write file'), `${tool.name} 描述不应包含 "write file"`);
        assert.ok(!desc.includes('edit file'), `${tool.name} 描述不应包含 "edit file"`);
        assert.ok(!desc.includes('delete'), `${tool.name} 描述不应包含 "delete"`);
        assert.ok(!desc.includes('run command'), `${tool.name} 描述不应包含 "run command"`);
      }
    } finally {
      removeTempDir(ws);
    }
  });

  it('工具列表已 Object.freeze 不可变', () => {
    const ws = createTempWorkspace({});
    try {
      const tools = getChatToolDefinitions({ db: createDbStub(), projectId: 1, workspacePath: ws });

      assert.throws(() => {
        tools.push({ name: 'evil_tool', handler: () => {} });
      }, '冻结数组不应允许 push');

      assert.throws(() => {
        tools[0].name = 'hacked';
      }, '冻结数组元素不应允许修改');
    } finally {
      removeTempDir(ws);
    }
  });

  it('所有工具均含 name/description/input_schema/handler 字段', () => {
    const ws = createTempWorkspace({});
    try {
      const tools = getChatToolDefinitions({ db: createDbStub(), projectId: 1, workspacePath: ws });

      for (const tool of tools) {
        assert.ok(tool.name, `${tool.name} 应有 name`);
        assert.ok(tool.description, `${tool.name} 应有 description`);
        assert.ok(tool.input_schema, `${tool.name} 应有 input_schema`);
        assert.equal(typeof tool.handler, 'function', `${tool.name} 应有 handler 函数`);
      }
    } finally {
      removeTempDir(ws);
    }
  });

  it('create/script/list 工具声明必填字段，open_* 工具 id/title 或 id/label 均可选', () => {
    const ws = createTempWorkspace({});
    try {
      const tools = getChatToolDefinitions({ db: createDbStub(), projectId: 1, workspacePath: ws });
      const optionalOpenTools = new Set(['open_requirement', 'open_feedback', 'open_executor']);

      for (const tool of tools) {
        if (optionalOpenTools.has(tool.name)) {
          // open_* 按 id/title 或 id/label 至少二选一（由 handler 校验），schema 中均可选
          assert.ok(tool.input_schema.properties.id, `${tool.name} 应暴露 id 属性`);
          assert.ok(tool.input_schema.properties.title || tool.input_schema.properties.label, `${tool.name} 应暴露 title 或 label 属性`);
          assert.ok(
            !Array.isArray(tool.input_schema.required) || tool.input_schema.required.length === 0,
            `${tool.name} 的定位参数均应可选`,
          );
        } else {
          assert.ok(
            Array.isArray(tool.input_schema.required),
            `${tool.name} 的 input_schema.required 应为数组`,
          );
          assert.ok(tool.input_schema.required.length > 0, `${tool.name} 应有必填参数`);
        }
      }
    } finally {
      removeTempDir(ws);
    }
  });
});

/* ================================================================== getChatToolDefinitions 工厂 ================================================================== */

describe('getChatToolDefinitions 工厂', () => {
  it('工作区路径为空时抛出错误', () => {
    assert.throws(
      () => {
        getChatToolDefinitions({ db: createDbStub(), projectId: 1, workspacePath: '' });
      },
      /工作区路径为空/,
    );
  });

  it('工作区路径为空白时抛出错误', () => {
    assert.throws(
      () => {
        getChatToolDefinitions({ db: createDbStub(), projectId: 1, workspacePath: '   ' });
      },
      /工作区路径为空/,
    );
  });
});
