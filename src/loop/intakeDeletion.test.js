const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { saveAttachments } = require('../attachments');
const { AppDatabase, nowIso } = require('../database');
const { LoopService } = require('../loopService');

describe('LoopService.deleteIntake cascade deletion', () => {
  it('deletes a bound requirement, its plan, tasks, attachments, and clears related feedback references', async () => {
    const fixture = await createFixture('requirement-bound');
    try {
      const requirementId = insertRequirement(fixture.db, fixture.projectId);
      const feedbackId = insertFeedback(fixture.db, fixture.projectId, requirementId);
      const attachment = saveIntakeAttachment(fixture, 'requirement', requirementId);
      const { planId, planFile, planRel } = createPlanForIntake(fixture, 'requirement', requirementId);
      fixture.db.run('UPDATE requirements SET linked_plan_id = ?, updated_at = ? WHERE id = ?', [
        planId,
        nowIso(),
        requirementId,
      ]);

      const next = fixture.loop.deleteIntake(fixture.projectId, 'requirement', requirementId, {
        attachmentsRoot: fixture.attachmentsRoot,
      });

      assert.equal(rowCount(fixture.db, 'requirements', 'id = ?', [requirementId]), 0, '需求记录应删除');
      assert.equal(rowCount(fixture.db, 'plans', 'id = ?', [planId]), 0, '关联 plan 应删除');
      assert.equal(rowCount(fixture.db, 'plan_tasks', 'plan_id = ?', [planId]), 0, '关联任务应删除');
      assert.equal(rowCount(fixture.db, 'attachments', 'id = ?', [attachment.id]), 0, '需求附件记录应删除');
      assert.equal(fs.existsSync(attachment.stored_path), false, '需求附件文件应删除');
      assert.equal(fs.existsSync(planFile), false, '安全路径内的需求计划文件应删除');
      assert.equal(rowCount(fixture.db, 'scan_files', 'project_id = ? AND scan_type = ? AND file_path = ?', [
        fixture.projectId,
        'plan',
        planRel,
      ]), 0, '需求计划扫描缓存应删除');
      assert.equal(
        fixture.db.get('SELECT requirement_id FROM feedback WHERE id = ?', [feedbackId]).requirement_id,
        null,
        '删除需求时相关反馈 requirement_id 应置空',
      );
      assert.equal(next.requirements.some((item) => item.id === requirementId), false, '快照中不应再有被删需求');
      assert.equal(next.plans.some((plan) => plan.id === planId), false, '快照中不应再有被删 plan');
      assert.equal(next.tasks.some((task) => task.plan_id === planId), false, '快照中不应再有被删任务');
    } finally {
      fixture.cleanup();
    }
  });

  it('deletes a bound feedback, its plan, tasks, and attachments without deleting the requirement', async () => {
    const fixture = await createFixture('feedback-bound');
    try {
      const requirementId = insertRequirement(fixture.db, fixture.projectId);
      const feedbackId = insertFeedback(fixture.db, fixture.projectId, requirementId);
      const attachment = saveIntakeAttachment(fixture, 'feedback', feedbackId);
      const { planId } = createPlanForIntake(fixture, 'feedback', feedbackId);
      fixture.db.run('UPDATE feedback SET linked_plan_id = ?, updated_at = ? WHERE id = ?', [
        planId,
        nowIso(),
        feedbackId,
      ]);

      const next = fixture.loop.deleteIntake(fixture.projectId, 'feedback', feedbackId, {
        attachmentsRoot: fixture.attachmentsRoot,
      });

      assert.equal(rowCount(fixture.db, 'feedback', 'id = ?', [feedbackId]), 0, '反馈记录应删除');
      assert.equal(rowCount(fixture.db, 'requirements', 'id = ?', [requirementId]), 1, '需求记录不应被误删');
      assert.equal(rowCount(fixture.db, 'plans', 'id = ?', [planId]), 0, '反馈关联 plan 应删除');
      assert.equal(rowCount(fixture.db, 'plan_tasks', 'plan_id = ?', [planId]), 0, '反馈关联任务应删除');
      assert.equal(rowCount(fixture.db, 'attachments', 'id = ?', [attachment.id]), 0, '反馈附件记录应删除');
      assert.equal(fs.existsSync(attachment.stored_path), false, '反馈附件文件应删除');
      assert.equal(next.feedback.some((item) => item.id === feedbackId), false, '快照中不应再有被删反馈');
      assert.equal(next.requirements.some((item) => item.id === requirementId), true, '快照中应保留原需求');
      assert.equal(next.plans.some((plan) => plan.id === planId), false, '快照中不应再有反馈关联 plan');
      assert.equal(next.tasks.some((task) => task.plan_id === planId), false, '快照中不应再有反馈关联任务');
    } finally {
      fixture.cleanup();
    }
  });

  it('deletes unbound requirement and feedback without touching unrelated plans or tasks', async () => {
    const fixture = await createFixture('unbound');
    try {
      const requirementId = insertRequirement(fixture.db, fixture.projectId);
      const feedbackId = insertFeedback(fixture.db, fixture.projectId);
      const otherRequirementId = insertRequirement(fixture.db, fixture.projectId);
      const { planId } = createPlanForIntake(fixture, 'requirement', otherRequirementId, 'unrelated');
      const originalTaskCount = rowCount(fixture.db, 'plan_tasks', 'plan_id = ?', [planId]);

      fixture.loop.deleteIntake(fixture.projectId, 'requirement', requirementId);
      const next = fixture.loop.deleteIntake(fixture.projectId, 'feedback', feedbackId);

      assert.equal(rowCount(fixture.db, 'requirements', 'id = ?', [requirementId]), 0, '无绑定需求应删除');
      assert.equal(rowCount(fixture.db, 'feedback', 'id = ?', [feedbackId]), 0, '无绑定反馈应删除');
      assert.equal(rowCount(fixture.db, 'plans', 'id = ?', [planId]), 1, '无绑定删除不应误删其它 plan');
      assert.equal(rowCount(fixture.db, 'plan_tasks', 'plan_id = ?', [planId]), originalTaskCount, '无绑定删除不应误删其它任务');
      assert.equal(next.plans.some((plan) => plan.id === planId), true, '快照中应保留无关 plan');
      assert.equal(next.tasks.filter((task) => task.plan_id === planId).length, originalTaskCount, '快照中应保留无关任务');
    } finally {
      fixture.cleanup();
    }
  });

  it('stops active operations for the linked plan and removes the deleted plan and tasks from the snapshot', async () => {
    const fixture = await createFixture('active-operation');
    try {
      const requirementId = insertRequirement(fixture.db, fixture.projectId);
      const { planId } = createPlanForIntake(fixture, 'requirement', requirementId);
      fixture.db.run('UPDATE requirements SET linked_plan_id = ?, updated_at = ? WHERE id = ?', [
        planId,
        nowIso(),
        requirementId,
      ]);
      const task = fixture.db.get('SELECT * FROM plan_tasks WHERE plan_id = ? ORDER BY sort_order ASC LIMIT 1', [planId]);
      const startedAt = nowIso();
      fixture.db.run('UPDATE plan_tasks SET status = ?, started_at = ?, updated_at = ? WHERE id = ?', [
        'running',
        startedAt,
        startedAt,
        task.id,
      ]);
      const runtime = fixture.loop.runtime(fixture.projectId);
      const activeOperation = {
        projectId: fixture.projectId,
        planId,
        taskId: task.id,
        label: 'cascade delete active task',
        startedAt,
      };
      const child = {
        killed: false,
        signal: '',
        kill(signal) {
          this.killed = true;
          this.signal = signal;
        },
      };
      runtime.activeOperations.set('cascade-delete-op', activeOperation);
      runtime.activeChildren.set('cascade-delete-op', child);
      runtime.activeOperation = activeOperation;
      runtime.activeChild = child;

      const next = fixture.loop.deleteIntake(fixture.projectId, 'requirement', requirementId);

      assert.equal(child.killed, true, '删除 intake 应终止关联 plan 的运行中子进程');
      assert.equal(child.signal, 'SIGTERM', '运行中子进程应收到 SIGTERM');
      assert.equal(runtime.activeOperations.size, 0, '关联 active operation 应从运行时移除');
      assert.equal(runtime.activeChildren.size, 0, '关联 active child 应从运行时移除');
      assert.equal(next.activeOperation, null, '快照不应再暴露已删除 plan 的 active operation');
      assert.deepEqual(next.activeOperations, [], '快照不应再暴露已删除 plan 的 active operations');
      assert.equal(next.plans.some((plan) => plan.id === planId), false, '运行中删除后快照不应再有 plan');
      assert.equal(next.tasks.some((item) => item.plan_id === planId), false, '运行中删除后快照不应再有任务');
      assert.equal(rowCount(fixture.db, 'plans', 'id = ?', [planId]), 0, '运行中删除后数据库 plan 应删除');
      assert.equal(rowCount(fixture.db, 'plan_tasks', 'plan_id = ?', [planId]), 0, '运行中删除后数据库任务应删除');
    } finally {
      fixture.cleanup();
    }
  });
});

async function createFixture(name) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `autoplan-intake-deletion-${name}-`));
  const workspace = path.join(tempRoot, 'workspace');
  const attachmentsRoot = path.join(tempRoot, 'attachments');
  const db = new AppDatabase(path.join(tempRoot, 'data', 'autoplan.sqlite'));
  await db.init();
  const loop = new LoopService(db);
  const projectId = loop.defaultProjectId();
  loop.configure(projectId, { workspacePath: workspace, intervalSeconds: 5, validationCommand: '' });
  loop.ensureWorkspaceDirs(workspace);
  return {
    attachmentsRoot,
    db,
    loop,
    projectId,
    tempRoot,
    workspace,
    cleanup: () => fs.rmSync(tempRoot, { recursive: true, force: true }),
  };
}

function insertRequirement(db, projectId, title = '级联删除需求') {
  const now = nowIso();
  return db.insert(
    `INSERT INTO requirements (project_id, title, body, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [projectId, title, '删除需求时应级联删除关联计划与任务', 'open', now, now],
  );
}

function insertFeedback(db, projectId, requirementId = null, title = '级联删除反馈') {
  const now = nowIso();
  return db.insert(
    `INSERT INTO feedback (project_id, requirement_id, title, body, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [projectId, requirementId, title, '删除反馈时应级联删除关联计划与任务', 'open', now, now],
  );
}

function createPlanForIntake(fixture, intakeType, intakeId, suffix = 'cascade') {
  const planRel = path.join('docs', 'plan', `plan_${intakeType}_${intakeId}_${suffix}.md`);
  const planFile = path.join(fixture.workspace, planRel);
  fs.mkdirSync(path.dirname(planFile), { recursive: true });
  fs.writeFileSync(
    planFile,
    [
      `# ${intakeType} cascade deletion plan`,
      '',
      `- [ ] P001: 实现 ${intakeType} 级联删除 <!-- scope: src/${intakeType}.js -->`,
      `- [ ] P002: 验证 ${intakeType} 级联删除 <!-- scope: validation -->`,
      '',
    ].join('\n'),
    'utf8',
  );
  const now = nowIso();
  const planId = fixture.db.insert(
    `INSERT INTO plans (project_id, issue_hash, file_path, hash, status, total_tasks, completed_tasks, validation_passed, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 0, 0, 0, ?, ?)`,
    [fixture.projectId, `${intakeType}-${intakeId}-${suffix}`, planRel, `${intakeType}-${intakeId}-hash`, 'running', now, now],
  );
  fixture.loop.syncPlanTasks(planId, planFile);
  fixture.db.run(
    `INSERT OR REPLACE INTO scan_files
     (project_id, scan_type, file_path, hash, size, modified_at, scanned_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [fixture.projectId, 'plan', planRel, 'scan-hash', fs.statSync(planFile).size, now, now],
  );
  return { planId, planFile, planRel };
}

function saveIntakeAttachment(fixture, ownerType, ownerId) {
  const sourceFile = path.join(fixture.tempRoot, `${ownerType}-${ownerId}.txt`);
  fs.writeFileSync(sourceFile, `${ownerType} attachment`, 'utf8');
  const [attachment] = saveAttachments(
    fixture.db,
    fixture.attachmentsRoot,
    ownerType,
    ownerId,
    [{ path: sourceFile, name: `${ownerType}-${ownerId}.txt`, type: 'text/plain' }],
    fixture.projectId,
  );
  assert.ok(attachment, `${ownerType} 附件应保存成功`);
  assert.ok(fs.existsSync(attachment.stored_path), `${ownerType} 附件文件应存在`);
  return attachment;
}

function rowCount(db, table, where = '1 = 1', params = []) {
  return db.get(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`, params).count;
}
