const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { AppDatabase, nowIso } = require('../database');
const { LoopService } = require('../loopService');

describe('LoopService.stopPlan lifecycle', () => {
  it('stops a running plan, interrupts unfinished tasks, and removes it from runnable selection', async () => {
    const fixture = await createFixture('stop-running-plan');
    try {
      const { planId } = createPlan(fixture, 'running');
      const tasks = fixture.db.all('SELECT * FROM plan_tasks WHERE plan_id = ? ORDER BY sort_order ASC', [planId]);
      assert.equal(tasks.length, 3, '测试计划应解析出 3 个任务');
      const startedAt = nowIso();
      fixture.db.run('UPDATE plan_tasks SET status = ?, started_at = ?, updated_at = ? WHERE id = ?', [
        'running',
        startedAt,
        startedAt,
        tasks[0].id,
      ]);
      fixture.db.run('UPDATE plan_tasks SET status = ?, updated_at = ? WHERE id = ?', [
        'completed',
        startedAt,
        tasks[2].id,
      ]);
      const child = attachActiveOperation(fixture, planId, tasks[0].id, startedAt);

      const next = fixture.loop.stopPlan(fixture.projectId, planId);
      const stoppedPlan = fixture.db.get('SELECT * FROM plans WHERE id = ?', [planId]);
      const stoppedTasks = taskStatusByKey(fixture, planId);
      const stopEvent = latestEvent(fixture, 'plan.stopped');
      const stopMeta = JSON.parse(stopEvent.meta);

      assert.equal(child.killed, true, '停止计划应终止运行中子进程');
      assert.equal(child.signal, 'SIGTERM', '运行中子进程应收到 SIGTERM');
      assert.equal(fixture.loop.runtime(fixture.projectId).activeOperations.size, 0, '运行时 active operation 应被清理');
      assert.equal(fixture.loop.runtime(fixture.projectId).activeOperation, null, '运行时 activeOperation 指针应被清理');
      assert.equal(stoppedPlan.status, 'interrupted', '计划状态应变为 interrupted');
      assert.equal(stoppedTasks.P001, 'blocked', '运行中任务应被挂起，避免继续执行');
      assert.equal(stoppedTasks.P002, 'blocked', '待执行任务应被挂起，避免继续执行');
      assert.equal(stoppedTasks.P003, 'completed', '已完成任务不应被回退');
      assert.equal(fixture.loop.nextRunnablePlan(fixture.projectId), null, 'interrupted 计划不应再次被自动选择');
      assert.equal(next.plans.find((plan) => plan.id === planId)?.status, 'interrupted', '返回 snapshot 应包含最新计划状态');
      assert.equal(next.tasks.find((task) => task.id === tasks[0].id)?.status, 'blocked', '返回 snapshot 应包含最新任务状态');
      assert.equal(next.activeOperation, null, '返回 snapshot 不应暴露已停止的 active operation');
      assert.deepEqual(next.activeOperations, [], '返回 snapshot 不应暴露已停止的 active operations');
      assert.equal(stopMeta.planId, planId, '停止事件应记录 planId');
      assert.equal(stopMeta.status, 'interrupted', '停止事件应记录目标状态');
      assert.equal(stopMeta.stoppedOperations, 1, '停止事件应记录被终止的运行时操作数量');
      assert.equal(stopMeta.blockedTasks, 2, '停止事件应记录被挂起的未完成任务数量');
      assert.equal(rowCount(fixture.db, 'events', 'type = ?', ['task.interrupted']), 1, '停止运行中计划应记录任务中断事件');
    } finally {
      fixture.cleanup();
    }
  });

  it('rejects stopping a non-running plan without changing its tasks', async () => {
    const fixture = await createFixture('stop-idle-plan');
    try {
      const { planId } = createPlan(fixture, 'draft');
      assert.throws(
        () => fixture.loop.stopPlan(fixture.projectId, planId),
        /计划未在运行中/,
        '非运行计划不允许停止',
      );

      const plan = fixture.db.get('SELECT * FROM plans WHERE id = ?', [planId]);
      const statuses = Object.values(taskStatusByKey(fixture, planId));
      assert.equal(plan.status, 'draft', '非运行计划停止失败后不应改变计划状态');
      assert.deepEqual(statuses, ['pending', 'pending', 'completed'], '非运行计划停止失败后不应改变任务状态');
      assert.equal(rowCount(fixture.db, 'events', 'type = ?', ['plan.stopped']), 0, '失败的停止请求不应记录成功事件');
    } finally {
      fixture.cleanup();
    }
  });
});

describe('LoopService linked intake multi-plan lifecycle', () => {
  it('marks an intake completed only after every linked phase plan is completed', async () => {
    const fixture = await createFixture('linked-intake-completion');
    try {
      const requirementId = insertRequirement(fixture, '多阶段完成后关闭需求');
      const phaseOne = createPlan(fixture, 'completed');
      const phaseTwo = createPlan(fixture, 'running');
      linkIntakePlan(fixture, 'requirement', requirementId, phaseOne.planId, 1, '阶段一');
      linkIntakePlan(fixture, 'requirement', requirementId, phaseTwo.planId, 2, '阶段二');

      const firstResult = fixture.loop.completeLinkedIntakesForPlan({
        id: phaseOne.planId,
        project_id: fixture.projectId,
      });
      assert.equal(firstResult.total, 0, '只完成第一阶段时不应关闭 intake');
      assert.equal(
        fixture.db.get('SELECT status FROM requirements WHERE id = ?', [requirementId]).status,
        'open',
        '仍有未完成阶段时需求状态保持 open',
      );

      fixture.db.run('UPDATE plans SET status = ?, updated_at = ? WHERE id = ?', [
        'completed',
        nowIso(),
        phaseTwo.planId,
      ]);
      const finalResult = fixture.loop.completeLinkedIntakesForPlan({
        id: phaseTwo.planId,
        project_id: fixture.projectId,
      });
      const completionEvent = latestEvent(fixture, 'plan.linked_intakes.completed');
      const completionMeta = JSON.parse(completionEvent.meta);

      assert.equal(finalResult.requirements, 1, '所有阶段完成后应关闭关联需求');
      assert.equal(finalResult.feedback, 0);
      assert.deepEqual(finalResult.requirementIds, [requirementId]);
      assert.equal(
        fixture.db.get('SELECT status FROM requirements WHERE id = ?', [requirementId]).status,
        'completed',
        '需求应在最后阶段完成后更新为 completed',
      );
      assert.deepEqual(completionMeta.requirementIds, [requirementId], '完成事件应记录 intake id');
      assert.equal(rowCount(fixture.db, 'events', 'type = ?', ['plan.linked_intakes.completed']), 1);
    } finally {
      fixture.cleanup();
    }
  });

  it('interrupts unfinished linked phase plans and appends tasks to the current unfinished phase', async () => {
    const fixture = await createFixture('linked-intake-actions');
    try {
      const requirementId = insertRequirement(fixture, '多阶段动作');
      const phaseOne = createPlan(fixture, 'completed');
      const phaseTwo = createPlan(fixture, 'running');
      linkIntakePlan(fixture, 'requirement', requirementId, phaseOne.planId, 1, '已完成阶段');
      linkIntakePlan(fixture, 'requirement', requirementId, phaseTwo.planId, 2, '执行阶段');

      const interruptSummary = fixture.loop.interruptIntakePlans(fixture.projectId, 'requirement', requirementId);
      const interruptedPlan = fixture.db.get('SELECT status FROM plans WHERE id = ?', [phaseTwo.planId]);
      const appendSummary = fixture.loop.appendTaskToIntakePlan(
        fixture.projectId,
        'requirement',
        requirementId,
        '补充当前阶段处理',
      );

      assert.deepEqual(interruptSummary.planIds, [phaseOne.planId, phaseTwo.planId]);
      assert.deepEqual(interruptSummary.affectedPlanIds, [phaseTwo.planId], '中断动作应跳过已完成阶段');
      assert.equal(interruptSummary.totalPlans, 2);
      assert.equal(interruptSummary.affectedPlans, 1);
      assert.equal(interruptedPlan.status, 'interrupted', '未完成阶段应被置为 interrupted');
      assert.equal(appendSummary.planId, phaseTwo.planId, '追加任务应选择第一个未完成阶段');
      assert.equal(appendSummary.phaseIndex, 2);
      assert.deepEqual(appendSummary.planIds, [phaseOne.planId, phaseTwo.planId]);
      assert.ok(
        fixture.db.get('SELECT id FROM plan_tasks WHERE plan_id = ? AND title = ?', [
          phaseTwo.planId,
          '补充当前阶段处理',
        ]),
        '追加任务应落在第二阶段 plan',
      );
      assert.ok(latestEvent(fixture, 'intake.plans.interrupted'), '应记录 intake plans 中断事件');
      assert.ok(latestEvent(fixture, 'intake.task.appended'), '应记录 intake 追加任务事件');
    } finally {
      fixture.cleanup();
    }
  });
});

describe('LoopService.insertPlan backend config snapshots', () => {
  it('stores plan generation and execution config columns and exposes them in snapshots', async () => {
    const fixture = await createFixture('backend-config-snapshot');
    try {
      const planRel = path.join('docs', 'plan', 'plan_backend_snapshot.md');
      const planFile = path.join(fixture.workspace, planRel);
      fs.mkdirSync(path.dirname(planFile), { recursive: true });
      fs.writeFileSync(
        planFile,
        [
          '# backend config snapshot',
          '',
          '- [ ] P001: 后端配置快照 <!-- scope: src/loop/planLifecycle.js -->',
          '',
        ].join('\n'),
        'utf8',
      );

      const planId = fixture.loop.insertPlan({
        projectId: fixture.projectId,
        issueHash: 'backend-config-snapshot',
        filePath: planRel,
        hash: 'backend-config-hash',
        status: 'pending',
        agentCliConfig: { provider: 'opencode', command: 'opencode-legacy' },
        planGenerationConfig: {
          strategy: 'external-cli-structured',
          provider: 'claude',
          command: 'claude-plan',
          codexReasoningEffort: 'xhigh',
        },
        planExecutionConfig: {
          strategy: 'external-cli',
          provider: 'codex',
          command: 'codex-exec',
          codexReasoningEffort: 'xhigh',
        },
      });

      const row = fixture.db.get('SELECT * FROM plans WHERE id = ?', [planId]);
      assert.equal(row.plan_generation_strategy, 'external-cli-structured');
      assert.equal(row.plan_generation_provider, 'claude');
      assert.equal(row.plan_generation_command, 'claude-plan');
      assert.equal(row.plan_generation_codex_reasoning_effort, null, 'non-Codex generation should not store reasoning');
      assert.equal(row.plan_execution_strategy, 'external-cli');
      assert.equal(row.plan_execution_provider, 'codex');
      assert.equal(row.plan_execution_command, 'codex-exec');
      assert.equal(row.plan_execution_codex_reasoning_effort, 'xhigh');

      const snapshotPlan = fixture.loop.snapshot(fixture.projectId).plans.find((plan) => plan.id === planId);
      assert.ok(snapshotPlan, 'snapshot should include inserted plan');
      assert.equal(snapshotPlan.plan_generation_strategy, 'external-cli-structured');
      assert.equal(snapshotPlan.plan_generation_provider, 'claude');
      assert.equal(snapshotPlan.plan_execution_provider, 'codex');
      assert.equal(snapshotPlan.plan_execution_codex_reasoning_effort, 'xhigh');
      assert.equal(snapshotPlan.agent_cli_provider, 'codex', 'runtime execution display should use execution config');
    } finally {
      fixture.cleanup();
    }
  });
});

async function createFixture(name) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `autoplan-plan-lifecycle-${name}-`));
  const workspace = path.join(tempRoot, 'workspace');
  const db = new AppDatabase(path.join(tempRoot, 'data', 'autoplan.sqlite'));
  await db.init();
  const loop = new LoopService(db);
  const projectId = loop.defaultProjectId();
  loop.configure(projectId, { workspacePath: workspace, intervalSeconds: 5, validationCommand: '' });
  loop.ensureWorkspaceDirs(workspace);
  return {
    db,
    loop,
    projectId,
    tempRoot,
    workspace,
    cleanup: () => fs.rmSync(tempRoot, { recursive: true, force: true }),
  };
}

function createPlan(fixture, status = 'running') {
  const planRel = path.join('docs', 'plan', `plan_lifecycle_${Date.now()}_${Math.random().toString(36).slice(2)}.md`);
  const planFile = path.join(fixture.workspace, planRel);
  fs.mkdirSync(path.dirname(planFile), { recursive: true });
  fs.writeFileSync(
    planFile,
    [
      '# lifecycle plan',
      '',
      '- [ ] P001: 运行中的任务 <!-- scope: src/running.js -->',
      '- [ ] P002: 待执行任务 <!-- scope: src/pending.js -->',
      '- [x] P003: 已完成任务 <!-- scope: src/done.js -->',
      '',
    ].join('\n'),
    'utf8',
  );
  const now = nowIso();
  const planId = fixture.db.insert(
    `INSERT INTO plans (project_id, issue_hash, file_path, hash, status, total_tasks, completed_tasks, validation_passed, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 0, 0, 0, ?, ?)`,
    [fixture.projectId, `lifecycle-${Date.now()}`, planRel, 'lifecycle-hash', status, now, now],
  );
  fixture.loop.syncPlanTasks(planId, planFile);
  fixture.db.run('UPDATE plans SET status = ?, updated_at = ? WHERE id = ?', [status, now, planId]);
  return { planId, planFile, planRel };
}

function insertRequirement(fixture, title) {
  const now = nowIso();
  return fixture.db.insert(
    `INSERT INTO requirements (project_id, title, body, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [fixture.projectId, title, '多阶段计划生命周期测试', 'open', now, now],
  );
}

function linkIntakePlan(fixture, intakeType, intakeId, planId, phaseIndex, phaseTitle) {
  const table = intakeType === 'feedback' ? 'feedback' : 'requirements';
  const now = nowIso();
  fixture.db.run(
    `INSERT INTO intake_plan_links
     (project_id, intake_type, intake_id, plan_id, phase_index, phase_title, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [fixture.projectId, intakeType, intakeId, planId, phaseIndex, phaseTitle, now, now],
  );
  fixture.db.run(`UPDATE ${table} SET linked_plan_id = ?, updated_at = ? WHERE id = ?`, [
    planId,
    now,
    intakeId,
  ]);
}

function attachActiveOperation(fixture, planId, taskId, startedAt) {
  const runtime = fixture.loop.runtime(fixture.projectId);
  const child = {
    killed: false,
    signal: '',
    kill(signal) {
      this.killed = true;
      this.signal = signal;
    },
  };
  const operation = {
    projectId: fixture.projectId,
    planId,
    taskId,
    label: 'plan lifecycle stop',
    startedAt,
  };
  runtime.activeOperations.set('plan-lifecycle-stop-op', operation);
  runtime.activeChildren.set('plan-lifecycle-stop-op', child);
  runtime.activeOperation = operation;
  runtime.activeChild = child;
  return child;
}

function taskStatusByKey(fixture, planId) {
  return Object.fromEntries(
    fixture.db
      .all('SELECT task_key, status FROM plan_tasks WHERE plan_id = ? ORDER BY sort_order ASC', [planId])
      .map((task) => [task.task_key, task.status]),
  );
}

function latestEvent(fixture, type) {
  const event = fixture.db.get('SELECT * FROM events WHERE project_id = ? AND type = ? ORDER BY id DESC LIMIT 1', [
    fixture.projectId,
    type,
  ]);
  assert.ok(event, `应记录 ${type} 事件`);
  return event;
}

function rowCount(db, table, where = '1 = 1', params = []) {
  return db.get(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`, params).count;
}
