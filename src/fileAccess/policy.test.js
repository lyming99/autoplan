'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {
  resolveFileAccessPolicy,
  isPathAllowed,
  assertPathAllowed,
  parseAllowedRoots,
  FILE_ACCESS_SCOPE_KEY,
  ALLOW_CROSS_PROJECT_KEY,
  ALLOWED_ROOTS_KEY,
  FILE_PATH_OUTSIDE_SCOPE_CODE,
} = require('./policy');

/* ------------------------------------------------------------------ 测试辅助 ------------------------------------------------------------------ */

/**
 * 内存 settings 替身：与 updateChecker.test.js 同口径（getSetting 命中返回字符串，否则 fallback）。
 * resolveFileAccessPolicy 仅依赖 getSetting，故此处提供最小实现。
 */
function createSettingsDb(settings = {}) {
  const store = new Map();
  for (const [key, value] of Object.entries(settings)) store.set(key, String(value));
  return {
    getSetting(key, fallback = null) {
      return store.has(key) ? store.get(key) : fallback;
    },
    setSetting(key, value) {
      store.set(key, String(value));
    },
  };
}

/** 创建临时目录（可选写入若干文件），返回目录路径 */
function createTempWorkspace(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoplan-policy-'));
  for (const [name, content] of Object.entries(files)) {
    const filePath = path.join(dir, name);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
  }
  return dir;
}

function removeTempDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* 清理失败不阻塞 */
  }
}

/* ================================================================== resolveFileAccessPolicy ================================================================== */

describe('resolveFileAccessPolicy', () => {
  it('无配置时使用默认值（默认安全）', () => {
    const ws = createTempWorkspace({});
    try {
      const policy = resolveFileAccessPolicy({ db: createSettingsDb(), workspacePath: ws });
      assert.equal(policy.scope, 'project');
      assert.equal(policy.allowCrossProject, false);
      assert.deepEqual(policy.allowedRoots, []);
      assert.equal(policy.unrestricted, false);
      assert.ok(policy.effectiveRoots.length >= 1, 'effectiveRoots 至少含工作区');
      assert.ok(policy.effectiveRoots.includes(fs.realpathSync(ws)), 'effectiveRoots 应含工作区 realpath');
    } finally {
      removeTempDir(ws);
    }
  });

  it('db 未注入 getSetting 时回退默认值（容错）', () => {
    const ws = createTempWorkspace({});
    try {
      const policy = resolveFileAccessPolicy({ db: {}, workspacePath: ws });
      assert.equal(policy.scope, 'project');
      assert.equal(policy.unrestricted, false);
    } finally {
      removeTempDir(ws);
    }
  });

  it('db 为空时回退默认值（容错）', () => {
    const ws = createTempWorkspace({});
    try {
      const policy = resolveFileAccessPolicy({ workspacePath: ws });
      assert.equal(policy.scope, 'project');
      assert.equal(policy.allowCrossProject, false);
    } finally {
      removeTempDir(ws);
    }
  });

  it('scope=all 时 unrestricted=true', () => {
    const ws = createTempWorkspace({});
    try {
      const policy = resolveFileAccessPolicy({
        db: createSettingsDb({ [FILE_ACCESS_SCOPE_KEY]: 'all' }),
        workspacePath: ws,
      });
      assert.equal(policy.scope, 'all');
      assert.equal(policy.unrestricted, true);
    } finally {
      removeTempDir(ws);
    }
  });

  it('custom + allowedRoots：effectiveRoots 含工作区与白名单', () => {
    const ws = createTempWorkspace({});
    const root = createTempWorkspace({});
    try {
      const policy = resolveFileAccessPolicy({
        db: createSettingsDb({
          [FILE_ACCESS_SCOPE_KEY]: 'custom',
          [ALLOWED_ROOTS_KEY]: JSON.stringify([root]),
        }),
        workspacePath: ws,
      });
      assert.equal(policy.scope, 'custom');
      assert.ok(policy.effectiveRoots.includes(fs.realpathSync(ws)), 'effectiveRoots 应含工作区 realpath');
      assert.ok(policy.effectiveRoots.includes(fs.realpathSync(root)), 'effectiveRoots 应含白名单 realpath');
    } finally {
      removeTempDir(ws);
      removeTempDir(root);
    }
  });

  it('allowCrossProject=true 等效 custom：effectiveRoots 含白名单', () => {
    const ws = createTempWorkspace({});
    const root = createTempWorkspace({});
    try {
      const policy = resolveFileAccessPolicy({
        db: createSettingsDb({
          [ALLOW_CROSS_PROJECT_KEY]: 'true',
          [ALLOWED_ROOTS_KEY]: JSON.stringify([root]),
        }),
        workspacePath: ws,
      });
      // scope 仍为默认 project，但 allowCrossProject 生效 → 白名单纳入 effectiveRoots
      assert.equal(policy.scope, 'project');
      assert.equal(policy.allowCrossProject, true);
      assert.equal(policy.unrestricted, false);
      assert.ok(policy.effectiveRoots.includes(fs.realpathSync(root)), 'effectiveRoots 应含白名单 realpath');
    } finally {
      removeTempDir(ws);
      removeTempDir(root);
    }
  });

  it('非法 scope 回退 project', () => {
    const ws = createTempWorkspace({});
    try {
      const policy = resolveFileAccessPolicy({
        db: createSettingsDb({ [FILE_ACCESS_SCOPE_KEY]: 'universe' }),
        workspacePath: ws,
      });
      assert.equal(policy.scope, 'project');
      assert.equal(policy.unrestricted, false);
    } finally {
      removeTempDir(ws);
    }
  });
});

/* ================================================================== isPathAllowed ================================================================== */

describe('isPathAllowed', () => {
  it('默认 project：放行工作区内文件', () => {
    const ws = createTempWorkspace({ 'a.txt': 'x' });
    try {
      const policy = resolveFileAccessPolicy({ db: createSettingsDb(), workspacePath: ws });
      assert.equal(isPathAllowed(path.join(ws, 'a.txt'), policy), true);
    } finally {
      removeTempDir(ws);
    }
  });

  it('默认 project：拒绝 ../etc/passwd 越界', () => {
    const ws = createTempWorkspace({});
    try {
      const policy = resolveFileAccessPolicy({ db: createSettingsDb(), workspacePath: ws });
      assert.equal(isPathAllowed(path.resolve(ws, '../etc/passwd'), policy), false);
    } finally {
      removeTempDir(ws);
    }
  });

  it('默认 project：拒绝系统临时目录（工作区之外）', () => {
    const ws = createTempWorkspace({});
    try {
      const policy = resolveFileAccessPolicy({ db: createSettingsDb(), workspacePath: ws });
      assert.equal(isPathAllowed(os.tmpdir(), policy), false);
    } finally {
      removeTempDir(ws);
    }
  });

  it('custom + allowedRoots：放行白名单内文件', () => {
    const ws = createTempWorkspace({});
    const root = createTempWorkspace({ 'shared.txt': 's' });
    try {
      const policy = resolveFileAccessPolicy({
        db: createSettingsDb({
          [FILE_ACCESS_SCOPE_KEY]: 'custom',
          [ALLOWED_ROOTS_KEY]: JSON.stringify([root]),
        }),
        workspacePath: ws,
      });
      assert.equal(isPathAllowed(path.join(root, 'shared.txt'), policy), true);
    } finally {
      removeTempDir(ws);
      removeTempDir(root);
    }
  });

  it('custom + allowedRoots：拒绝白名单外的路径', () => {
    const ws = createTempWorkspace({});
    const root = createTempWorkspace({});
    const outside = createTempWorkspace({ 'secret.txt': 'x' });
    try {
      const policy = resolveFileAccessPolicy({
        db: createSettingsDb({
          [FILE_ACCESS_SCOPE_KEY]: 'custom',
          [ALLOWED_ROOTS_KEY]: JSON.stringify([root]),
        }),
        workspacePath: ws,
      });
      assert.equal(isPathAllowed(path.join(outside, 'secret.txt'), policy), false);
    } finally {
      removeTempDir(ws);
      removeTempDir(root);
      removeTempDir(outside);
    }
  });

  it('allowCrossProject=true 等效 custom：放行白名单内、拒绝外', () => {
    const ws = createTempWorkspace({});
    const root = createTempWorkspace({ 'shared.txt': 's' });
    const outside = createTempWorkspace({ 'secret.txt': 'x' });
    try {
      const policy = resolveFileAccessPolicy({
        db: createSettingsDb({
          [ALLOW_CROSS_PROJECT_KEY]: 'true',
          [ALLOWED_ROOTS_KEY]: JSON.stringify([root]),
        }),
        workspacePath: ws,
      });
      assert.equal(isPathAllowed(path.join(root, 'shared.txt'), policy), true);
      assert.equal(isPathAllowed(path.join(outside, 'secret.txt'), policy), false);
    } finally {
      removeTempDir(ws);
      removeTempDir(root);
      removeTempDir(outside);
    }
  });

  it('all：放行任意路径（不受应用层限制）', () => {
    const ws = createTempWorkspace({});
    const outside = createTempWorkspace({});
    try {
      const policy = resolveFileAccessPolicy({
        db: createSettingsDb({ [FILE_ACCESS_SCOPE_KEY]: 'all' }),
        workspacePath: ws,
      });
      assert.equal(isPathAllowed(path.join(outside, 'whatever.txt'), policy), true);
      assert.equal(isPathAllowed(os.tmpdir(), policy), true);
    } finally {
      removeTempDir(ws);
      removeTempDir(outside);
    }
  });

  it('有效根为空且非 unrestricted 时恒为 false（安全默认）', () => {
    const policy = { unrestricted: false, effectiveRoots: [] };
    assert.equal(isPathAllowed('/any/path', policy), false);
  });

  it('符号链接穿透逃逸被拦截（默认 project）', (t) => {
    const ws = createTempWorkspace({});
    const outside = createTempWorkspace({ 'secret.txt': 'top secret' });
    const linkPath = path.join(ws, 'link.txt');
    try {
      try {
        fs.symlinkSync(path.join(outside, 'secret.txt'), linkPath);
      } catch (err) {
        // Windows 等环境无创建符号链接权限时跳过，不视为失败
        t.skip(`当前环境无法创建符号链接：${err.code || err.message}`);
        return;
      }
      const policy = resolveFileAccessPolicy({ db: createSettingsDb(), workspacePath: ws });
      assert.equal(isPathAllowed(linkPath, policy), false, '软链指向工作区外应被拒绝');
    } finally {
      removeTempDir(ws);
      removeTempDir(outside);
    }
  });
});

/* ================================================================== assertPathAllowed ================================================================== */

describe('assertPathAllowed', () => {
  it('范围内路径不抛错并返回 true', () => {
    const ws = createTempWorkspace({ 'a.txt': 'x' });
    try {
      const policy = resolveFileAccessPolicy({ db: createSettingsDb(), workspacePath: ws });
      assert.equal(assertPathAllowed(path.join(ws, 'a.txt'), policy), true);
    } finally {
      removeTempDir(ws);
    }
  });

  it('越界路径抛出 code=FILE_PATH_OUTSIDE_SCOPE 的错误', () => {
    const ws = createTempWorkspace({});
    try {
      const policy = resolveFileAccessPolicy({ db: createSettingsDb(), workspacePath: ws });
      assert.throws(
        () => assertPathAllowed(path.resolve(ws, '../etc/passwd'), policy),
        (err) => err.code === FILE_PATH_OUTSIDE_SCOPE_CODE && /超出/.test(err.message),
      );
    } finally {
      removeTempDir(ws);
    }
  });

  it('all 范围越界路径不抛错', () => {
    const ws = createTempWorkspace({});
    try {
      const policy = resolveFileAccessPolicy({
        db: createSettingsDb({ [FILE_ACCESS_SCOPE_KEY]: 'all' }),
        workspacePath: ws,
      });
      assert.equal(assertPathAllowed('/anywhere/else.txt', policy), true);
    } finally {
      removeTempDir(ws);
    }
  });
});

/* ================================================================== parseAllowedRoots ================================================================== */

describe('parseAllowedRoots', () => {
  it('合法 JSON 数组：规范化为绝对路径', () => {
    const root = createTempWorkspace({});
    try {
      const result = parseAllowedRoots(JSON.stringify([root]));
      assert.equal(result.length, 1);
      assert.equal(result[0], fs.realpathSync(root));
    } finally {
      removeTempDir(root);
    }
  });

  it('接受已是数组的入参', () => {
    const root = createTempWorkspace({});
    try {
      const result = parseAllowedRoots([root]);
      assert.equal(result.length, 1);
    } finally {
      removeTempDir(root);
    }
  });

  it('非法 JSON 返回空数组', () => {
    assert.deepEqual(parseAllowedRoots('not-json'), []);
    assert.deepEqual(parseAllowedRoots('{bad'), []);
  });

  it('非数组（对象/字符串/数字）返回空数组', () => {
    assert.deepEqual(parseAllowedRoots(JSON.stringify({ a: 1 })), []);
    assert.deepEqual(parseAllowedRoots(JSON.stringify('justastring')), []);
    assert.deepEqual(parseAllowedRoots(JSON.stringify(123)), []);
  });

  it('过滤空字符串与空白串', () => {
    const root = createTempWorkspace({});
    try {
      const result = parseAllowedRoots(JSON.stringify([root, '', '   ']));
      assert.equal(result.length, 1);
    } finally {
      removeTempDir(root);
    }
  });

  it('去重（重复项与等价路径）', () => {
    const root = createTempWorkspace({});
    try {
      // 同一绝对路径 + 带尾部分隔符的等价写法
      const withSep = root + path.sep;
      const result = parseAllowedRoots(JSON.stringify([root, root, withSep]));
      assert.equal(result.length, 1, '应去重为 1 项');
    } finally {
      removeTempDir(root);
    }
  });

  it('过滤非字符串项', () => {
    const root = createTempWorkspace({});
    try {
      const result = parseAllowedRoots(JSON.stringify([root, 123, null, true, { x: 1 }]));
      assert.equal(result.length, 1);
    } finally {
      removeTempDir(root);
    }
  });

  it('null / undefined / 空串返回空数组', () => {
    assert.deepEqual(parseAllowedRoots(null), []);
    assert.deepEqual(parseAllowedRoots(undefined), []);
    assert.deepEqual(parseAllowedRoots(''), []);
  });

  it('不存在的根保留 resolve 后路径（realpath 容错）', () => {
    const ghost = path.join(os.tmpdir(), 'autoplan-policy-ghost-nonexistent');
    const result = parseAllowedRoots(JSON.stringify([ghost]));
    assert.equal(result.length, 1);
    assert.equal(result[0], path.resolve(ghost));
  });
});
