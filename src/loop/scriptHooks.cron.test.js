const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  parseCron,
  isCronDue,
  isRunThisMinute,
  dueScheduledScripts,
} = require('./scriptHooks');

const PROJECT_ID = 42;

let nextScriptId = 1000;

/** 构造一条 scripts 表行，覆盖默认值，允许按用例覆盖字段。 */
function makeScript(overrides = {}) {
  nextScriptId += 1;
  return {
    id: nextScriptId,
    project_id: PROJECT_ID,
    name: `脚本 ${nextScriptId}`,
    path: '',
    runtime: 'node',
    body: 'console.log("ok")',
    description: '',
    trigger_mode: 'hook',
    hook_stage: 'task:after',
    enabled: 1,
    work_dir: '',
    timeout_seconds: 60,
    fail_aborts: 0,
    context_inject: 'none',
    sort_order: 0,
    last_status: null,
    last_exit_code: null,
    last_duration_ms: null,
    last_log: null,
    last_run_at: null,
    ...overrides,
  };
}

/* ==================== 定时任务 cron 求值器 ==================== */

describe('parseCron 校验与解析', () => {
  it('合法 5 字段 cron 表达式返回命中文档', () => {
    const parsed = parseCron('*/5 * * * *');
    assert.ok(parsed, '*/5 * * * * 应解析成功');
    assert.ok(parsed.minute instanceof Set);
    assert.equal(parsed.minute.has(0), false, '每分钟字段 */5 不含 0');
    assert.equal(parsed.minute.has(5), true, '*/5 应命中 5');
    assert.equal(parsed.minute.has(55), true, '*/5 应命中 55');
  });

  it('*/1 等价于 *（每分钟）', () => {
    const parsed = parseCron('*/1 * * * *');
    for (let m = 0; m < 60; m += 1) assert.equal(parsed.minute.has(m), true, `*/1 应命中每分钟 ${m}`);
  });

  it('单值 "0 9 * * 1-5" 解析正确', () => {
    const parsed = parseCron('0 9 * * 1-5');
    assert.equal(parsed.minute.has(0), true);
    assert.equal(parsed.hour.has(9), true);
    assert.equal(parsed.dayOfMonth.size, 31, '* 应展开全部日期');
    assert.equal(parsed.month.size, 12);
    assert.equal(parsed.dayOfWeek.has(1), true, '周一 (1) 应命中');
    assert.equal(parsed.dayOfWeek.has(5), true, '周五 (5) 应命中');
    assert.equal(parsed.dayOfWeek.has(0), false, '周日 (0) 不应命中');
  });

  it('周字段 7 与 0 归一为周日', () => {
    const parsed = parseCron('0 0 * * 7');
    assert.equal(parsed.dayOfWeek.has(0), true, '7 应归一为周日 0');
    assert.equal(parsed.dayOfWeek.has(7), false, '7 不应保留在 Set');
  });

  it('列表 "1,15,30" 解析为多个命中值', () => {
    const parsed = parseCron('1,15,30 * * * *');
    assert.equal(parsed.minute.has(1), true);
    assert.equal(parsed.minute.has(15), true);
    assert.equal(parsed.minute.has(30), true);
    assert.equal(parsed.minute.has(0), false);
  });

  it('带步长的区间 "0-30/10"', () => {
    const parsed = parseCron('0-30/10 * * * *');
    assert.equal(parsed.minute.has(0), true);
    assert.equal(parsed.minute.has(10), true);
    assert.equal(parsed.minute.has(20), true);
    assert.equal(parsed.minute.has(30), true);
    assert.equal(parsed.minute.has(40), false);
  });

  it('非法表达式抛中文错误', () => {
    assert.throws(() => parseCron(''), { message: /cron 表达式格式无效/ });
    assert.throws(() => parseCron('* * * *'), { message: /5 字段/ });
    assert.throws(() => parseCron('abc * * * *'), { message: /cron 表达式格式无效/ });
    assert.throws(() => parseCron('60 * * * *'), { message: /越界/ });
    assert.throws(() => parseCron('*/0 * * * *'), { message: /步长非法/ });
  });
});

describe('isCronDue 命中判定', () => {
  it('目标时间命中已解析 cron 返回 true', () => {
    const parsed = parseCron('*/5 * * * *');
    // 2026-06-29 12:05:00 → minute=5
    const date = new Date(2026, 5, 29, 12, 5, 0);
    assert.equal(isCronDue(parsed, date), true, '分钟 5 应命中 */5');
  });

  it('目标时间不命中返回 false', () => {
    const parsed = parseCron('*/5 * * * *');
    const date = new Date(2026, 5, 29, 12, 3, 0); // minute=3, not in */5
    assert.equal(isCronDue(parsed, date), false);
  });

  it('parsed 为 null/falsy 返回 false', () => {
    assert.equal(isCronDue(null, new Date()), false);
  });
});

describe('isRunThisMinute 同分钟去重', () => {
  it('同一分钟内返回 true', () => {
    const now = new Date(2026, 5, 29, 12, 5, 30);
    const lastRun = '2026-06-29T12:05:10.000Z';
    assert.equal(isRunThisMinute(lastRun, now), true);
  });

  it('不同分钟返回 false', () => {
    const now = new Date(2026, 5, 29, 12, 6, 0);
    const lastRun = '2026-06-29T12:05:10.000Z';
    assert.equal(isRunThisMinute(lastRun, now), false);
  });

  it('last_run_at 为空或非法返回 false', () => {
    assert.equal(isRunThisMinute(null, new Date()), false);
    assert.equal(isRunThisMinute('invalid', new Date()), false);
  });
});

describe('dueScheduledScripts 综合筛选', () => {
  function makeSchedScript(overrides = {}) {
    return makeScript({
      trigger_mode: 'schedule',
      schedule_cron: '*/5 * * * *',
      ...overrides,
    });
  }

  it('命中当前分钟且未在本分钟运行过的脚本入选', () => {
    const now = new Date(2026, 5, 29, 12, 5, 0); // minute=5, */5 hits
    const script = makeSchedScript();
    const due = dueScheduledScripts([script], now);
    assert.equal(due.length, 1, '分钟 5 命中 */5 应入选');
  });

  it('未到点的脚本不入选', () => {
    const now = new Date(2026, 5, 29, 12, 3, 0); // minute=3, */5 misses
    const script = makeSchedScript();
    const due = dueScheduledScripts([script], now);
    assert.equal(due.length, 0, '分钟 3 不命中 */5 应排除');
  });

  it('本分钟已运行过的脚本不入选（同分钟去重）', () => {
    const now = new Date(2026, 5, 29, 12, 5, 30);
    const script = makeSchedScript({ last_run_at: '2026-06-29T12:05:01.000Z' }); // same minute
    const due = dueScheduledScripts([script], now);
    assert.equal(due.length, 0, '本分钟已运行应排除');
  });

  it('禁用的脚本不入选', () => {
    const now = new Date(2026, 5, 29, 12, 5, 0);
    const script = makeSchedScript({ enabled: 0 });
    const due = dueScheduledScripts([script], now);
    assert.equal(due.length, 0, '禁用脚本应排除');
  });

  it('非 schedule 触发模式的脚本不入选', () => {
    const now = new Date(2026, 5, 29, 12, 5, 0);
    const script = makeSchedScript({ trigger_mode: 'hook' });
    const due = dueScheduledScripts([script], now);
    assert.equal(due.length, 0, 'hook 模式应排除');
  });

  it('非法 cron 表达式不入选且不抛错', () => {
    const now = new Date(2026, 5, 29, 12, 5, 0);
    const script = makeSchedScript({ schedule_cron: 'bad cron' });
    assert.doesNotThrow(() => {
      const due = dueScheduledScripts([script], now);
      assert.equal(due.length, 0, '非法 cron 应排除不抛错');
    });
  });
});
