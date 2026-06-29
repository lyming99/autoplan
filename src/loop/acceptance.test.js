const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AppDatabase, nowIso } = require('../database');
const { LoopService } = require('../loopService');

/**
 * 验收模块（人工逐项验收）行为测试：内存 db + 最小 LoopService fixture。
 * 覆盖 acceptItem/unacceptItem 的落库（accepted_at）、执行态 status 正交、幂等、
 * 未完成项拒绝，以及 plan.accepted/task.accepted/plan.unaccepted/task.unaccepted 事件流。
 * 风格与 src/agentCli.test.js / src/mcpConfig.test.js / src/loop/scriptHooks.test.js 一致（node:test）。
 */

function assertIsoString(value, label) {
  assert.equal(typeof value, 'string', `${label} 应为字符串`);
  assert.ok(Number.isFinite(Date.parse(value)), `${label} 应为合法 ISO 时间`);
}

/** 插入一条计划，覆盖 plans 表必填字段；默认已完成态（可验收），status 可按用例覆盖。 */
function insertPlan(db, projectId, status = 'completed') {
  const now = nowIso();
  return db.insert(
    `INSERT INTO plans
       (project_id, issue_hash, file_path, hash, status, sort_order, total_tasks, completed_tasks, validation_passed, agent_cli_command, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [projectId, 'acceptance-plan', 'docs/plan/acceptance.md', '', status, 1, 4, 4, 0, '', now, now],
  );
}

/** 插入一条任务，覆盖 plan_tasks 表必填字段；status 由调用方指定。 */
function insertTask(db, planId, taskKey, status) {
  const now = nowIso();
  return db.insert(
    `INSERT INTO plan_tasks
       (plan_id, task_key, title, raw_line, scope, status, sort_order, duration_ms, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      planId,
      taskKey,
      `任务 ${taskKey}`,
      `- [ ] ${taskKey}: 任务 ${taskKey} <!-- scope: unknown -->`,
      'unknown',
      status,
      Number(taskKey.replace(/\D/g, '')) || 1,
      0,
      now,
    ],
  );
}

/**
 * 最小验收 fixture：在临时目录建一个新 AppDatabase（内存语义、用完即弃），
 * 起一个真实 LoopService，并种入一个项目、一条计划与多条不同执行态的任务。
 */
async function createAcceptanceFixture({ planStatus = 'completed' } = {}) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autoplan-acceptance-'));
  const dbPath = path.join(tempRoot, 'autoplan.sqlite');
  const db = new AppDatabase(dbPath);
  await db.init();
  const loop = new LoopService(db);
  const projectId = loop.defaultProjectId();
  const planId = insertPlan(db, projectId, planStatus);
  const completedTaskId = insertTask(db, planId, 'P001', 'completed');
  const doneTaskId = insertTask(db, planId, 'P002', 'done');
  const passedTaskId = insertTask(db, planId, 'P003', 'passed');
  const pendingTaskId = insertTask(db, planId, 'P004', 'pending');
  return {
    db,
    loop,
    projectId,
    planId,
    completedTaskId,
    doneTaskId,
    passedTaskId,
    pendingTaskId,
    destroy() {
      loop.flushPendingUpdates();
      fs.rmSync(tempRoot, { recursive: true, force: true });
    },
  };
}

function latestEvent(db, projectId, type) {
  return db.get(
    'SELECT * FROM events WHERE project_id = ? AND type = ? ORDER BY id DESC LIMIT 1',
    [projectId, type],
  );
}

describe('acceptItem 人工验收', () => {
  it('对已完成的计划置 accepted_at 为非空 ISO 时间，且不改变执行态 status', async () => {
    const fixture = await createAcceptanceFixture();
    try {
      const result = fixture.loop.acceptItem(fixture.projectId, { targetType: 'plan', id: fixture.planId });
      assertIsoString(result.accepted_at, 'acceptItem 返回值 accepted_at');
      const plan = fixture.db.get('SELECT * FROM plans WHERE id = ?', [fixture.planId]);
      assertIsoString(plan.accepted_at, 'plans.accepted_at');
      assert.equal(plan.status, 'completed', '验收不应改变计划执行态 status');
    } finally {
      fixture.destroy();
    }
  });

  it('对已完成任务（completed/done/passed）置 accepted_at，且不改执行态 status', async () => {
    const fixture = await createAcceptanceFixture();
    try {
      for (const taskId of [fixture.completedTaskId, fixture.doneTaskId, fixture.passedTaskId]) {
        const result = fixture.loop.acceptItem(fixture.projectId, { targetType: 'task', id: taskId });
        assertIsoString(result.accepted_at, `acceptItem(task#${taskId}) 返回值 accepted_at`);
        const task = fixture.db.get('SELECT * FROM plan_tasks WHERE id = ?', [taskId]);
        assertIsoString(task.accepted_at, `plan_tasks#${taskId}.accepted_at`);
        assert.ok(
          ['completed', 'done', 'passed'].includes(task.status),
          `验收不应改变任务#${taskId} 执行态 status（当前 ${task.status}）`,
        );
      }
    } finally {
      fixture.destroy();
    }
  });

  it('对未完成项验收抛错：计划非 completed、任务非已完成集合', async () => {
    const pendingPlanFixture = await createAcceptanceFixture({ planStatus: 'pending' });
    try {
      assert.throws(
        () => pendingPlanFixture.loop.acceptItem(pendingPlanFixture.projectId, {
          targetType: 'plan',
          id: pendingPlanFixture.planId,
        }),
        /仅可验收已完成的计划\/任务/,
        '未完成计划不应允许验收',
      );
    } finally {
      pendingPlanFixture.destroy();
    }

    const fixture = await createAcceptanceFixture();
    try {
      assert.throws(
        () => fixture.loop.acceptItem(fixture.projectId, { targetType: 'task', id: fixture.pendingTaskId }),
        /仅可验收已完成的计划\/任务/,
        '未完成任务不应允许验收',
      );
      const task = fixture.db.get('SELECT accepted_at FROM plan_tasks WHERE id = ?', [fixture.pendingTaskId]);
      assert.equal(task.accepted_at, null, '拒绝验收时 accepted_at 应保持 NULL');
    } finally {
      fixture.destroy();
    }
  });

  it('对不存在目标或非法入参抛中文错误', async () => {
    const fixture = await createAcceptanceFixture();
    try {
      assert.throws(
        () => fixture.loop.acceptItem(fixture.projectId, { targetType: 'plan', id: fixture.planId + 9999 }),
        /计划不存在/,
        '验收不存在的计划应提示计划不存在',
      );
      assert.throws(
        () => fixture.loop.acceptItem(fixture.projectId, { targetType: 'task', id: fixture.completedTaskId + 9999 }),
        /任务不存在/,
        '验收不存在的任务应提示任务不存在',
      );
      assert.throws(
        () => fixture.loop.acceptItem(fixture.projectId, { targetType: 'unknown', id: fixture.planId }),
        /验收目标类型无效/,
        '非法 targetType 应提示类型无效',
      );
      assert.throws(
        () => fixture.loop.acceptItem(fixture.projectId, { targetType: 'plan', id: 0 }),
        /验收目标 ID 无效/,
        '非法 id 应提示 ID 无效',
      );
    } finally {
      fixture.destroy();
    }
  });

  it('重复验收幂等：已验收项再次验收不报错并保持 accepted_at 非空、status 不变', async () => {
    const fixture = await createAcceptanceFixture();
    try {
      fixture.loop.acceptItem(fixture.projectId, { targetType: 'plan', id: fixture.planId });
      assert.doesNotThrow(() => fixture.loop.acceptItem(fixture.projectId, { targetType: 'plan', id: fixture.planId }));

      const plan = fixture.db.get('SELECT * FROM plans WHERE id = ?', [fixture.planId]);
      assertIsoString(plan.accepted_at, '重复验收后 accepted_at 应仍为非空 ISO 时间');
      assert.equal(plan.status, 'completed', '重复验收不应改变计划执行态');
    } finally {
      fixture.destroy();
    }
  });
});

describe('unacceptItem 取消验收', () => {
  it('清空 accepted_at 为 NULL，且不改执行态 status', async () => {
    const fixture = await createAcceptanceFixture();
    try {
      fixture.loop.acceptItem(fixture.projectId, { targetType: 'plan', id: fixture.planId });
      fixture.loop.acceptItem(fixture.projectId, { targetType: 'task', id: fixture.completedTaskId });

      const planResult = fixture.loop.unacceptItem(fixture.projectId, { targetType: 'plan', id: fixture.planId });
      assert.equal(planResult.accepted_at, null, 'unacceptItem(plan) 返回值 accepted_at 应为 null');
      const taskResult = fixture.loop.unacceptItem(fixture.projectId, { targetType: 'task', id: fixture.completedTaskId });
      assert.equal(taskResult.accepted_at, null, 'unacceptItem(task) 返回值 accepted_at 应为 null');

      const plan = fixture.db.get('SELECT * FROM plans WHERE id = ?', [fixture.planId]);
      const task = fixture.db.get('SELECT * FROM plan_tasks WHERE id = ?', [fixture.completedTaskId]);
      assert.equal(plan.accepted_at, null, '取消验收后 plans.accepted_at 应为 NULL');
      assert.equal(task.accepted_at, null, '取消验收后 plan_tasks.accepted_at 应为 NULL');
      assert.equal(plan.status, 'completed', '取消验收不应改变计划执行态');
      assert.ok(['completed', 'done', 'passed'].includes(task.status), '取消验收不应改变任务执行态');
    } finally {
      fixture.destroy();
    }
  });

  it('对未验收项取消验收幂等不报错并保持 NULL', async () => {
    const fixture = await createAcceptanceFixture();
    try {
      // 未验收的计划直接取消：unaccept 不要求已完成，能取到行且不报错。
      assert.doesNotThrow(() => fixture.loop.unacceptItem(fixture.projectId, { targetType: 'plan', id: fixture.planId }));
      let plan = fixture.db.get('SELECT accepted_at FROM plans WHERE id = ?', [fixture.planId]);
      assert.equal(plan.accepted_at, null, '未验收计划取消后 accepted_at 仍应为 NULL');

      // 已验收后取消两次：第二次仍不报错，且保持 NULL。
      fixture.loop.acceptItem(fixture.projectId, { targetType: 'task', id: fixture.completedTaskId });
      fixture.loop.unacceptItem(fixture.projectId, { targetType: 'task', id: fixture.completedTaskId });
      assert.doesNotThrow(() => fixture.loop.unacceptItem(fixture.projectId, { targetType: 'task', id: fixture.completedTaskId }));
      const task = fixture.db.get('SELECT accepted_at FROM plan_tasks WHERE id = ?', [fixture.completedTaskId]);
      assert.equal(task.accepted_at, null, '重复取消后 accepted_at 应保持 NULL');
    } finally {
      fixture.destroy();
    }
  });
});

describe('验收事件流', () => {
  it('验收/取消验收计划记录 plan.accepted / plan.unaccepted 事件', async () => {
    const fixture = await createAcceptanceFixture();
    try {
      fixture.loop.acceptItem(fixture.projectId, { targetType: 'plan', id: fixture.planId });
      const accepted = latestEvent(fixture.db, fixture.projectId, 'plan.accepted');
      assert.ok(accepted, '应记录 plan.accepted 事件');
      const acceptedMeta = JSON.parse(accepted.meta);
      assert.equal(acceptedMeta.targetType, 'plan', 'plan.accepted meta 应含 targetType=plan');
      assert.equal(Number(acceptedMeta.id), fixture.planId, 'plan.accepted meta 应含目标计划 id');
      assertIsoString(acceptedMeta.accepted_at, 'plan.accepted meta.accepted_at');

      fixture.loop.unacceptItem(fixture.projectId, { targetType: 'plan', id: fixture.planId });
      const unaccepted = latestEvent(fixture.db, fixture.projectId, 'plan.unaccepted');
      assert.ok(unaccepted, '应记录 plan.unaccepted 事件');
      const unacceptedMeta = JSON.parse(unaccepted.meta);
      assert.equal(unacceptedMeta.targetType, 'plan', 'plan.unaccepted meta 应含 targetType=plan');
      assert.equal(unacceptedMeta.accepted_at, null, 'plan.unaccepted meta.accepted_at 应为 null');
    } finally {
      fixture.destroy();
    }
  });

  it('验收/取消验收任务记录 task.accepted / task.unaccepted 事件', async () => {
    const fixture = await createAcceptanceFixture();
    try {
      fixture.loop.acceptItem(fixture.projectId, { targetType: 'task', id: fixture.completedTaskId });
      const accepted = latestEvent(fixture.db, fixture.projectId, 'task.accepted');
      assert.ok(accepted, '应记录 task.accepted 事件');
      const acceptedMeta = JSON.parse(accepted.meta);
      assert.equal(acceptedMeta.targetType, 'task', 'task.accepted meta 应含 targetType=task');
      assert.equal(Number(acceptedMeta.id), fixture.completedTaskId, 'task.accepted meta 应含目标任务 id');
      assertIsoString(acceptedMeta.accepted_at, 'task.accepted meta.accepted_at');

      fixture.loop.unacceptItem(fixture.projectId, { targetType: 'task', id: fixture.completedTaskId });
      const unaccepted = latestEvent(fixture.db, fixture.projectId, 'task.unaccepted');
      assert.ok(unaccepted, '应记录 task.unaccepted 事件');
      const unacceptedMeta = JSON.parse(unaccepted.meta);
      assert.equal(unacceptedMeta.targetType, 'task', 'task.unaccepted meta 应含 targetType=task');
      assert.equal(unacceptedMeta.accepted_at, null, 'task.unaccepted meta.accepted_at 应为 null');
    } finally {
      fixture.destroy();
    }
  });
});
