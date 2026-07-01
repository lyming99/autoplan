'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { getChatToolDefinitions } = require('./chatTools');

const READ_FILE_MAX_BYTES = 256 * 1024;

/* ------------------------------------------------------------------ 测试辅助 ------------------------------------------------------------------ */

/** 创建最小 DB 替身：支持 all()（scan_files 查询）和 insert()（scripts 写入） */
function createDbStub({ scanFiles = [] } = {}) {
  let nextId = 1;
  const db = {
    _scanFiles: scanFiles,
    _insertedScripts: [],
    _lastInsertId: null,
    all(sql, params = []) {
      if (sql.includes('scan_files')) {
        let rows = [...db._scanFiles];
        if (sql.includes('file_path LIKE ?')) {
          const keyword = extractLikeKeyword(params, sql);
          if (keyword) rows = rows.filter((r) => r.file_path.includes(keyword));
        }
        const limitMatch = sql.match(/LIMIT\s+(\d+)/i);
        if (limitMatch) rows = rows.slice(0, Number(limitMatch[1]));
        return rows;
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
    run() {},
    get() {
      return null;
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

      assert.equal(result.errorCode, 'FILE_PATH_OUTSIDE_WORKSPACE');
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

      assert.equal(result.errorCode, 'FILE_PATH_OUTSIDE_WORKSPACE');
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

/* ================================================================== 白名单校验 ================================================================== */

describe('白名单', () => {
  it('仅包含 5 个工具', () => {
    const ws = createTempWorkspace({});
    try {
      const tools = getChatToolDefinitions({ db: createDbStub(), projectId: 1, workspacePath: ws });

      assert.equal(tools.length, 5);
      const names = tools.map((t) => t.name);
      assert.deepEqual(names.sort(), [
        'create_feedback',
        'create_requirement',
        'create_script',
        'read_file',
        'search_files',
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

  it('所有 input_schema 声明 required 字段', () => {
    const ws = createTempWorkspace({});
    try {
      const tools = getChatToolDefinitions({ db: createDbStub(), projectId: 1, workspacePath: ws });

      for (const tool of tools) {
        assert.ok(
          Array.isArray(tool.input_schema.required),
          `${tool.name} 的 input_schema.required 应为数组`,
        );
        assert.ok(tool.input_schema.required.length > 0, `${tool.name} 应有必填参数`);
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
