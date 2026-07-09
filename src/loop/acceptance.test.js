const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AppDatabase, nowIso } = require('../database');
const { LoopService } = require('../loopService');
const { REDO_SUPPLEMENT_MAX_LENGTH } = require('./acceptance');

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

function insertProject(db, name = '其它项目') {
  const now = nowIso();
  return db.insert(
    'INSERT INTO projects (name, workspace_path, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    [name, '', '', now, now],
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

function rowCount(db, table, where = '1 = 1', params = []) {
  return db.get(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`, params).count;
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

describe('redoAcceptanceItem 验收重做', () => {
  it('计划级重做清空 accepted_at/validation_passed，退回 pending，并记录 plan.redo 事件和补充说明', async () => {
    const fixture = await createAcceptanceFixture();
    try {
      const acceptedAt = nowIso();
      fixture.db.run('UPDATE plans SET accepted_at = ?, validation_passed = 1 WHERE id = ?', [acceptedAt, fixture.planId]);
      fixture.db.run('UPDATE plan_tasks SET status = ? WHERE plan_id = ?', ['completed', fixture.planId]);

      const result = fixture.loop.redoAcceptanceItem(fixture.projectId, {
        targetType: 'plan',
        id: fixture.planId,
        supplement: '  需要补充边界场景\r\n并重新验收  ',
      });

      const plan = fixture.db.get('SELECT * FROM plans WHERE id = ?', [fixture.planId]);
      const tasks = fixture.db.all('SELECT status FROM plan_tasks WHERE plan_id = ?', [fixture.planId]);
      const event = latestEvent(fixture.db, fixture.projectId, 'plan.redo');
      const meta = JSON.parse(event.meta);

      assert.equal(result.targetType, 'plan');
      assert.equal(result.status, 'pending');
      assert.equal(result.accepted_at, null);
      assert.equal(result.supplement, '需要补充边界场景\n并重新验收');
      assert.equal(plan.status, 'pending', '计划应退回 pending');
      assert.equal(plan.accepted_at, null, '计划重做应清空 accepted_at');
      assert.equal(plan.validation_passed, 0, '计划重做应清空 validation_passed');
      assert.ok(tasks.length > 0, '应存在任务');
      tasks.forEach((task) => assert.equal(task.status, 'pending', '已完成任务应被退回 pending'));
      assert.equal(meta.targetType, 'plan');
      assert.equal(meta.id, fixture.planId);
      assert.equal(meta.planId, fixture.planId);
      assert.equal(meta.taskId, null);
      assert.equal(meta.previousStatus, 'completed');
      assert.equal(meta.previousAcceptedAt, acceptedAt);
      assert.equal(meta.supplement, '需要补充边界场景\n并重新验收');
    } finally {
      fixture.destroy();
    }
  });

  it('任务级重做清空任务 accepted_at，目标任务退回 pending，所属计划回到可执行状态', async () => {
    const fixture = await createAcceptanceFixture();
    try {
      const acceptedAt = nowIso();
      fixture.db.run('UPDATE plans SET accepted_at = ?, validation_passed = 1 WHERE id = ?', [acceptedAt, fixture.planId]);
      fixture.db.run('UPDATE plan_tasks SET accepted_at = ? WHERE id = ?', [acceptedAt, fixture.completedTaskId]);

      const result = fixture.loop.redoAcceptanceItem(fixture.projectId, {
        targetType: 'task',
        id: fixture.completedTaskId,
        supplement: '',
      });

      const plan = fixture.db.get('SELECT * FROM plans WHERE id = ?', [fixture.planId]);
      const task = fixture.db.get('SELECT * FROM plan_tasks WHERE id = ?', [fixture.completedTaskId]);
      const untouchedTask = fixture.db.get('SELECT * FROM plan_tasks WHERE id = ?', [fixture.doneTaskId]);
      const event = latestEvent(fixture.db, fixture.projectId, 'task.redo');
      const meta = JSON.parse(event.meta);

      assert.equal(result.targetType, 'task');
      assert.equal(result.status, 'pending');
      assert.equal(result.supplement, '');
      assert.equal(task.status, 'pending', '目标任务应退回 pending');
      assert.equal(task.accepted_at, null, '任务重做应清空任务 accepted_at');
      assert.equal(plan.status, 'pending', '所属计划应回到 pending');
      assert.equal(plan.validation_passed, 0, '所属计划应清空 validation_passed');
      assert.equal(plan.accepted_at, null, '任务重做应清空所属计划人工验收态');
      assert.equal(untouchedTask.status, 'done', '非目标任务执行态不应被改写');
      assert.equal(meta.targetType, 'task');
      assert.equal(meta.id, fixture.completedTaskId);
      assert.equal(meta.taskId, fixture.completedTaskId);
      assert.equal(meta.planId, fixture.planId);
      assert.equal(meta.previousStatus, 'completed');
      assert.equal(meta.previousAcceptedAt, acceptedAt);
      assert.equal(meta.supplement, '');
    } finally {
      fixture.destroy();
    }
  });

  it('补充内容会被截断到上限后写入事件 meta', async () => {
    const fixture = await createAcceptanceFixture();
    try {
      const supplement = `\n${'验'.repeat(REDO_SUPPLEMENT_MAX_LENGTH + 20)}\n`;
      fixture.loop.redoAcceptanceItem(fixture.projectId, {
        targetType: 'task',
        id: fixture.completedTaskId,
        supplement,
      });

      const event = latestEvent(fixture.db, fixture.projectId, 'task.redo');
      const meta = JSON.parse(event.meta);
      assert.equal(Array.from(meta.supplement).length, REDO_SUPPLEMENT_MAX_LENGTH);
      assert.equal(meta.supplement, '验'.repeat(REDO_SUPPLEMENT_MAX_LENGTH));
    } finally {
      fixture.destroy();
    }
  });

  it('拒绝跨项目、未完成和运行中的重做目标，且不修改数据库', async () => {
    const fixture = await createAcceptanceFixture();
    try {
      const otherProjectId = insertProject(fixture.db);
      const otherPlanId = insertPlan(fixture.db, otherProjectId, 'completed');
      const beforePlan = fixture.db.get('SELECT * FROM plans WHERE id = ?', [fixture.planId]);
      const beforePendingTask = fixture.db.get('SELECT * FROM plan_tasks WHERE id = ?', [fixture.pendingTaskId]);

      assert.throws(
        () => fixture.loop.redoAcceptanceItem(fixture.projectId, { targetType: 'plan', id: otherPlanId }),
        /计划不存在/,
        '跨项目计划应按不存在拒绝',
      );
      assert.throws(
        () => fixture.loop.redoAcceptanceItem(fixture.projectId, { targetType: 'task', id: fixture.pendingTaskId }),
        /仅可重做已完成或已验收的计划\/任务/,
        '未完成任务不应允许重做',
      );

      fixture.db.run('UPDATE plan_tasks SET status = ? WHERE id = ?', ['running', fixture.completedTaskId]);
      assert.throws(
        () => fixture.loop.redoAcceptanceItem(fixture.projectId, { targetType: 'task', id: fixture.completedTaskId }),
        /任务正在运行中，不能重做/,
        '运行中任务不应允许重做',
      );

      fixture.db.run('UPDATE plan_tasks SET status = ? WHERE id = ?', ['completed', fixture.completedTaskId]);
      const runtime = fixture.loop.runtime(fixture.projectId);
      runtime.activeOperations.set('acceptance-redo-plan', {
        projectId: fixture.projectId,
        planId: fixture.planId,
        label: 'active redo blocker',
      });
      assert.throws(
        () => fixture.loop.redoAcceptanceItem(fixture.projectId, { targetType: 'plan', id: fixture.planId }),
        /计划正在运行中，不能重做/,
        '存在运行中操作的计划不应允许重做',
      );

      const afterPlan = fixture.db.get('SELECT * FROM plans WHERE id = ?', [fixture.planId]);
      const afterPendingTask = fixture.db.get('SELECT * FROM plan_tasks WHERE id = ?', [fixture.pendingTaskId]);
      assert.equal(afterPlan.status, beforePlan.status, '拒绝重做后计划 status 不应改变');
      assert.equal(afterPlan.accepted_at, beforePlan.accepted_at, '拒绝重做后计划 accepted_at 不应改变');
      assert.equal(afterPendingTask.status, beforePendingTask.status, '拒绝重做后未完成任务 status 不应改变');
      assert.equal(afterPendingTask.accepted_at, beforePendingTask.accepted_at, '拒绝重做后未完成任务 accepted_at 不应改变');
      assert.equal(rowCount(fixture.db, 'events', 'type IN (?, ?)', ['plan.redo', 'task.redo']), 0);
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

describe('acceptItems 批量验收', () => {
  it('批量验收混合 plan+task 目标：全部置 accepted_at 为非空，status 不变', async () => {
    const fixture = await createAcceptanceFixture();
    try {
      const result = fixture.loop.acceptItems(fixture.projectId, [
        { targetType: 'plan', id: fixture.planId },
        { targetType: 'task', id: fixture.completedTaskId },
        { targetType: 'task', id: fixture.doneTaskId },
      ]);
      assert.equal(result.accepted, 3, '应返回 accepted=3');
      assert.equal(result.items.length, 3, 'items 数量应为 3');
      result.items.forEach((item) => assertIsoString(item.accepted_at, `item#${item.id}.accepted_at`));

      const plan = fixture.db.get('SELECT * FROM plans WHERE id = ?', [fixture.planId]);
      assertIsoString(plan.accepted_at, '批量验收后 plan.accepted_at');
      assert.equal(plan.status, 'completed', '批量验收不应改变计划执行态 status');

      for (const taskId of [fixture.completedTaskId, fixture.doneTaskId]) {
        const task = fixture.db.get('SELECT * FROM plan_tasks WHERE id = ?', [taskId]);
        assertIsoString(task.accepted_at, `批量验收后 task#${taskId}.accepted_at`);
        assert.ok(
          ['completed', 'done', 'passed'].includes(task.status),
          `批量验收不应改变任务#${taskId} 执行态 status（当前 ${task.status}）`,
        );
      }

      const passedTask = fixture.db.get('SELECT accepted_at FROM plan_tasks WHERE id = ?', [fixture.passedTaskId]);
      assert.equal(passedTask.accepted_at, null, '批量验收未包含的任务 accepted_at 应为 NULL');
    } finally {
      fixture.destroy();
    }
  });

  it('原子性：含未完成任务时整体抛错且无任何行被写入', async () => {
    const fixture = await createAcceptanceFixture();
    try {
      assert.throws(
        () => fixture.loop.acceptItems(fixture.projectId, [
          { targetType: 'plan', id: fixture.planId },
          { targetType: 'task', id: fixture.pendingTaskId },
        ]),
        /仅可验收已完成的计划\/任务/,
        '含未完成目标应整体抛错',
      );
      const plan = fixture.db.get('SELECT accepted_at FROM plans WHERE id = ?', [fixture.planId]);
      assert.equal(plan.accepted_at, null, '原子性失败后合法目标的 accepted_at 应仍为 NULL');
    } finally {
      fixture.destroy();
    }
  });

  it('原子性：含不存在目标时整体抛错且不写任何行', async () => {
    const fixture = await createAcceptanceFixture();
    try {
      assert.throws(
        () => fixture.loop.acceptItems(fixture.projectId, [
          { targetType: 'task', id: fixture.completedTaskId },
          { targetType: 'plan', id: fixture.planId + 9999 },
        ]),
        /计划不存在/,
        '含不存在计划应整体抛错',
      );
      const task = fixture.db.get('SELECT accepted_at FROM plan_tasks WHERE id = ?', [fixture.completedTaskId]);
      assert.equal(task.accepted_at, null, '原子性失败后合法任务的 accepted_at 应仍为 NULL');
    } finally {
      fixture.destroy();
    }
  });

  it('空数组/非数组入参抛中文错误', async () => {
    const fixture = await createAcceptanceFixture();
    try {
      assert.throws(
        () => fixture.loop.acceptItems(fixture.projectId, []),
        /批量验收目标列表为空/,
        '空数组应抛中文错误',
      );
      assert.throws(
        () => fixture.loop.acceptItems(fixture.projectId, null),
        /验收目标列表无效/,
        'null 应抛验收目标列表无效',
      );
      assert.throws(
        () => fixture.loop.acceptItems(fixture.projectId, 'invalid'),
        /验收目标列表无效/,
        '非数组应抛验收目标列表无效',
      );
    } finally {
      fixture.destroy();
    }
  });

  it('幂等：含已验收项目标不报错（刷新 accepted_at 时间戳）', async () => {
    const fixture = await createAcceptanceFixture();
    try {
      fixture.loop.acceptItem(fixture.projectId, { targetType: 'plan', id: fixture.planId });

      const result = fixture.loop.acceptItems(fixture.projectId, [
        { targetType: 'plan', id: fixture.planId },
        { targetType: 'task', id: fixture.completedTaskId },
      ]);
      assert.equal(result.accepted, 2, '混合幂等应返回 accepted=2');

      const plan = fixture.db.get('SELECT * FROM plans WHERE id = ?', [fixture.planId]);
      assertIsoString(plan.accepted_at, '幂等批量验收后 plan.accepted_at 应仍为非空');
      assert.equal(plan.status, 'completed', '幂等批量验收不应改变计划执行态');

      const task = fixture.db.get('SELECT * FROM plan_tasks WHERE id = ?', [fixture.completedTaskId]);
      assertIsoString(task.accepted_at, '幂等批量验收后 task.accepted_at 应为非空');
    } finally {
      fixture.destroy();
    }
  });

  it('去重：同目标多次出现只处理一次（幂等不报错）', async () => {
    const fixture = await createAcceptanceFixture();
    try {
      const result = fixture.loop.acceptItems(fixture.projectId, [
        { targetType: 'task', id: fixture.completedTaskId },
        { targetType: 'task', id: fixture.completedTaskId },
        { targetType: 'task', id: fixture.completedTaskId },
      ]);
      assert.equal(result.accepted, 1, '去重后应返回 accepted=1');
      assert.equal(result.items.length, 1, '去重后 items 数量应为 1');
      const task = fixture.db.get('SELECT * FROM plan_tasks WHERE id = ?', [fixture.completedTaskId]);
      assertIsoString(task.accepted_at, '去重验收后 task.accepted_at 应非空');
    } finally {
      fixture.destroy();
    }
  });

  it('事件流：批量验收产生对应条数 plan.accepted / task.accepted', async () => {
    const fixture = await createAcceptanceFixture();
    try {
      fixture.loop.acceptItems(fixture.projectId, [
        { targetType: 'plan', id: fixture.planId },
        { targetType: 'task', id: fixture.completedTaskId },
        { targetType: 'task', id: fixture.doneTaskId },
      ]);

      const planAcceptedEvents = fixture.db.all(
        'SELECT * FROM events WHERE project_id = ? AND type = ? ORDER BY id ASC',
        [fixture.projectId, 'plan.accepted'],
      );
      assert.equal(planAcceptedEvents.length, 1, '批量验收应产生 1 条 plan.accepted 事件');
      const planMeta = JSON.parse(planAcceptedEvents[0].meta);
      assert.equal(planMeta.targetType, 'plan', 'plan.accepted meta.targetType');
      assert.equal(Number(planMeta.id), fixture.planId, 'plan.accepted meta.id');
      assertIsoString(planMeta.accepted_at, 'plan.accepted meta.accepted_at');

      const taskAcceptedEvents = fixture.db.all(
        'SELECT * FROM events WHERE project_id = ? AND type = ? ORDER BY id ASC',
        [fixture.projectId, 'task.accepted'],
      );
      assert.equal(taskAcceptedEvents.length, 2, '批量验收应产生 2 条 task.accepted 事件');
      taskAcceptedEvents.forEach((event) => {
        const meta = JSON.parse(event.meta);
        assert.equal(meta.targetType, 'task', 'task.accepted meta.targetType');
        assertIsoString(meta.accepted_at, 'task.accepted meta.accepted_at');
      });
    } finally {
      fixture.destroy();
    }
  });

  it('不执行脚本：acceptItems 绝不调用 validatePlan/runShell', async () => {
    const fixture = await createAcceptanceFixture();
    try {
      let validateCalled = false;
      let shellCalled = false;
      const origValidate = fixture.loop.validatePlan;
      const origRunShell = fixture.loop.runShell;
      fixture.loop.validatePlan = async () => { validateCalled = true; };
      fixture.loop.runShell = async () => { shellCalled = true; return { exitCode: 0 }; };

      fixture.loop.acceptItems(fixture.projectId, [
        { targetType: 'plan', id: fixture.planId },
        { targetType: 'task', id: fixture.completedTaskId },
      ]);

      assert.equal(validateCalled, false, 'acceptItems 不应调用 validatePlan');
      assert.equal(shellCalled, false, 'acceptItems 不应调用 runShell');

      fixture.loop.validatePlan = origValidate;
      fixture.loop.runShell = origRunShell;
    } finally {
      fixture.destroy();
    }
  });
});

describe('unacceptItems 批量取消验收', () => {
  it('批量取消验收置 accepted_at 为 NULL，status 不变', async () => {
    const fixture = await createAcceptanceFixture();
    try {
      fixture.loop.acceptItem(fixture.projectId, { targetType: 'plan', id: fixture.planId });
      fixture.loop.acceptItem(fixture.projectId, { targetType: 'task', id: fixture.completedTaskId });
      fixture.loop.acceptItem(fixture.projectId, { targetType: 'task', id: fixture.doneTaskId });

      const result = fixture.loop.unacceptItems(fixture.projectId, [
        { targetType: 'plan', id: fixture.planId },
        { targetType: 'task', id: fixture.completedTaskId },
      ]);
      assert.equal(result.unaccepted, 2, '应返回 unaccepted=2');
      assert.equal(result.items.length, 2, 'items 数量应为 2');
      result.items.forEach((item) => assert.equal(item.accepted_at, null, `item#${item.id}.accepted_at 应为 null`));

      const plan = fixture.db.get('SELECT * FROM plans WHERE id = ?', [fixture.planId]);
      assert.equal(plan.accepted_at, null, '取消验收后 plan.accepted_at 应为 NULL');
      assert.equal(plan.status, 'completed', '取消验收不应改变计划执行态');

      const task = fixture.db.get('SELECT * FROM plan_tasks WHERE id = ?', [fixture.completedTaskId]);
      assert.equal(task.accepted_at, null, '取消验收后 task.accepted_at 应为 NULL');
      assert.equal(task.status, 'completed', '取消验收不应改变任务执行态');

      const doneTask = fixture.db.get('SELECT accepted_at FROM plan_tasks WHERE id = ?', [fixture.doneTaskId]);
      assertIsoString(doneTask.accepted_at, '批量取消未包含的已验收任务 accepted_at 应保持非空');
    } finally {
      fixture.destroy();
    }
  });

  it('幂等：含未验收项不报错（保持 NULL）', async () => {
    const fixture = await createAcceptanceFixture();
    try {
      fixture.loop.acceptItem(fixture.projectId, { targetType: 'task', id: fixture.completedTaskId });

      const result = fixture.loop.unacceptItems(fixture.projectId, [
        { targetType: 'task', id: fixture.completedTaskId },
        { targetType: 'plan', id: fixture.planId },
      ]);
      assert.equal(result.unaccepted, 2, '混合幂等应返回 unaccepted=2');

      const task = fixture.db.get('SELECT accepted_at FROM plan_tasks WHERE id = ?', [fixture.completedTaskId]);
      assert.equal(task.accepted_at, null, '已验收任务取消后 accepted_at 应为 NULL');

      const plan = fixture.db.get('SELECT accepted_at FROM plans WHERE id = ?', [fixture.planId]);
      assert.equal(plan.accepted_at, null, '未验收计划取消后 accepted_at 仍为 NULL');
    } finally {
      fixture.destroy();
    }
  });

  it('事件流：批量取消验收产生 plan.unaccepted / task.unaccepted', async () => {
    const fixture = await createAcceptanceFixture();
    try {
      fixture.loop.acceptItem(fixture.projectId, { targetType: 'plan', id: fixture.planId });
      fixture.loop.acceptItem(fixture.projectId, { targetType: 'task', id: fixture.completedTaskId });

      fixture.loop.unacceptItems(fixture.projectId, [
        { targetType: 'plan', id: fixture.planId },
        { targetType: 'task', id: fixture.completedTaskId },
      ]);

      const planUnaccepted = fixture.db.all(
        'SELECT * FROM events WHERE project_id = ? AND type = ?',
        [fixture.projectId, 'plan.unaccepted'],
      );
      assert.equal(planUnaccepted.length, 1, '批量取消验收应产生 1 条 plan.unaccepted 事件');
      const planMeta = JSON.parse(planUnaccepted[0].meta);
      assert.equal(planMeta.accepted_at, null, 'plan.unaccepted meta.accepted_at 应为 null');

      const taskUnaccepted = fixture.db.all(
        'SELECT * FROM events WHERE project_id = ? AND type = ?',
        [fixture.projectId, 'task.unaccepted'],
      );
      assert.equal(taskUnaccepted.length, 1, '批量取消验收应产生 1 条 task.unaccepted 事件');
      const taskMeta = JSON.parse(taskUnaccepted[0].meta);
      assert.equal(taskMeta.accepted_at, null, 'task.unaccepted meta.accepted_at 应为 null');
    } finally {
      fixture.destroy();
    }
  });

  it('不执行脚本：unacceptItems 绝不调用 validatePlan/runShell', async () => {
    const fixture = await createAcceptanceFixture();
    try {
      fixture.loop.acceptItem(fixture.projectId, { targetType: 'plan', id: fixture.planId });

      let validateCalled = false;
      let shellCalled = false;
      const origValidate = fixture.loop.validatePlan;
      const origRunShell = fixture.loop.runShell;
      fixture.loop.validatePlan = async () => { validateCalled = true; };
      fixture.loop.runShell = async () => { shellCalled = true; return { exitCode: 0 }; };

      fixture.loop.unacceptItems(fixture.projectId, [{ targetType: 'plan', id: fixture.planId }]);

      assert.equal(validateCalled, false, 'unacceptItems 不应调用 validatePlan');
      assert.equal(shellCalled, false, 'unacceptItems 不应调用 runShell');

      fixture.loop.validatePlan = origValidate;
      fixture.loop.runShell = origRunShell;
    } finally {
      fixture.destroy();
    }
  });
});
