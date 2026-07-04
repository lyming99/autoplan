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

  it('deletes every phase plan linked to a requirement and records all plan ids', async () => {
    const fixture = await createFixture('requirement-multi-phase');
    try {
      const requirementId = insertRequirement(fixture.db, fixture.projectId, '多阶段删除需求');
      const phaseOne = createPlanForIntake(fixture, 'requirement', requirementId, 'phase-one');
      const phaseTwo = createPlanForIntake(fixture, 'requirement', requirementId, 'phase-two');
      linkIntakePlan(fixture, 'requirement', requirementId, phaseOne.planId, 1, '阶段一');
      linkIntakePlan(fixture, 'requirement', requirementId, phaseTwo.planId, 2, '阶段二');

      const next = fixture.loop.deleteIntake(fixture.projectId, 'requirement', requirementId);
      const deleteEvent = latestEvent(fixture, 'intake.deleted');
      const deleteMeta = JSON.parse(deleteEvent.meta);

      assert.equal(rowCount(fixture.db, 'requirements', 'id = ?', [requirementId]), 0, '需求记录应删除');
      for (const phase of [phaseOne, phaseTwo]) {
        assert.equal(rowCount(fixture.db, 'plans', 'id = ?', [phase.planId]), 0, `阶段 plan #${phase.planId} 应删除`);
        assert.equal(rowCount(fixture.db, 'plan_tasks', 'plan_id = ?', [phase.planId]), 0, `阶段 plan #${phase.planId} 任务应删除`);
        assert.equal(fs.existsSync(phase.planFile), false, `阶段 plan #${phase.planId} 文件应删除`);
        assert.equal(rowCount(fixture.db, 'scan_files', 'project_id = ? AND scan_type = ? AND file_path = ?', [
          fixture.projectId,
          'plan',
          phase.planRel,
        ]), 0, `阶段 plan #${phase.planId} 扫描缓存应删除`);
        assert.equal(next.plans.some((plan) => plan.id === phase.planId), false, `快照不应包含阶段 plan #${phase.planId}`);
        assert.equal(next.tasks.some((task) => task.plan_id === phase.planId), false, `快照不应包含阶段 plan #${phase.planId} 任务`);
      }
      assert.equal(
        rowCount(fixture.db, 'intake_plan_links', 'project_id = ? AND intake_type = ? AND intake_id = ?', [
          fixture.projectId,
          'requirement',
          requirementId,
        ]),
        0,
        '删除 intake 应清空全部阶段链接',
      );
      assert.deepEqual(deleteMeta.planIds, [phaseOne.planId, phaseTwo.planId]);
      assert.equal(deleteMeta.planId, phaseOne.planId, '兼容字段 planId 应保留第一阶段 plan');
      assert.equal(deleteMeta.planFiles.length, 2, '删除事件应记录每个阶段 plan 文件结果');
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

describe('LoopService.deletePlan lifecycle deletion', () => {
  it('deletes a plan, tasks, scan cache, markdown file, and clears linked intakes without deleting them', async () => {
    const fixture = await createFixture('delete-plan');
    try {
      const requirementId = insertRequirement(fixture.db, fixture.projectId, '删除计划保留需求');
      const feedbackId = insertFeedback(fixture.db, fixture.projectId, requirementId, '删除计划保留反馈');
      const { planId, planFile, planRel } = createPlanForIntake(fixture, 'requirement', requirementId, 'direct-delete');
      linkIntakePlan(fixture, 'requirement', requirementId, planId);
      linkIntakePlan(fixture, 'feedback', feedbackId, planId);
      const task = fixture.db.get('SELECT * FROM plan_tasks WHERE plan_id = ? ORDER BY sort_order ASC LIMIT 1', [planId]);
      const startedAt = nowIso();
      fixture.db.run('UPDATE plan_tasks SET status = ?, started_at = ?, updated_at = ? WHERE id = ?', [
        'running',
        startedAt,
        startedAt,
        task.id,
      ]);
      const child = attachActivePlanOperation(fixture, planId, task.id, startedAt);

      const next = fixture.loop.deletePlan(fixture.projectId, planId, { reason: 'plan-card-menu' });
      const requirement = fixture.db.get('SELECT * FROM requirements WHERE id = ?', [requirementId]);
      const feedback = fixture.db.get('SELECT * FROM feedback WHERE id = ?', [feedbackId]);
      const deleteEvent = latestEvent(fixture, 'plan.deleted');
      const deleteMeta = JSON.parse(deleteEvent.meta);

      assert.equal(child.killed, true, '删除运行中计划应先终止 active operation');
      assert.equal(child.signal, 'SIGTERM', '删除运行中计划应向子进程发送 SIGTERM');
      assert.equal(fixture.loop.runtime(fixture.projectId).activeOperations.size, 0, '删除后 active operations 应被清理');
      assert.equal(rowCount(fixture.db, 'plans', 'id = ?', [planId]), 0, '计划记录应删除');
      assert.equal(rowCount(fixture.db, 'plan_tasks', 'plan_id = ?', [planId]), 0, '计划任务应删除');
      assert.equal(rowCount(fixture.db, 'scan_files', 'project_id = ? AND scan_type = ? AND file_path = ?', [
        fixture.projectId,
        'plan',
        planRel,
      ]), 0, '计划扫描缓存应删除');
      assert.equal(fs.existsSync(planFile), false, '安全 docs/plan 内计划文件应删除');
      assert.equal(rowCount(fixture.db, 'intake_plan_links', 'project_id = ? AND plan_id = ?', [fixture.projectId, planId]), 0, '计划 intake 链接应删除');
      assert.equal(requirement.linked_plan_id, null, '需求 linked_plan_id 应清空');
      assert.equal(feedback.linked_plan_id, null, '反馈 linked_plan_id 应清空');
      assert.equal(rowCount(fixture.db, 'requirements', 'id = ?', [requirementId]), 1, '删除计划不应删除需求记录');
      assert.equal(rowCount(fixture.db, 'feedback', 'id = ?', [feedbackId]), 1, '删除计划不应删除反馈记录');
      assert.equal(next.plans.some((plan) => plan.id === planId), false, '返回 snapshot 不应再包含已删除计划');
      assert.equal(next.tasks.some((item) => item.plan_id === planId), false, '返回 snapshot 不应再包含已删除任务');
      assert.equal(next.activeOperation, null, '返回 snapshot 不应暴露已删除计划的 active operation');
      assert.deepEqual(next.activeOperations, [], '返回 snapshot 不应暴露已删除计划的 active operations');
      assert.equal(deleteMeta.planId, planId, '删除事件应记录 planId');
      assert.equal(deleteMeta.stoppedOperations, 1, '删除事件应记录被终止的运行时操作数量');
      assert.equal(deleteMeta.deletedTasks, 2, '删除事件应记录被删除任务数量');
      assert.equal(deleteMeta.keepIntakes, true, '删除事件应说明需求/反馈记录被保留');
      assert.equal(deleteMeta.linkedIntakes.requirements, 1, '删除事件应记录关联需求数量');
      assert.equal(deleteMeta.linkedIntakes.feedback, 1, '删除事件应记录关联反馈数量');
      assert.equal(deleteMeta.reason, 'plan-card-menu', '删除事件应记录调用方原因');
    } finally {
      fixture.cleanup();
    }
  });

  it('does not delete an out-of-bounds plan file path and records a skipped event', async () => {
    const fixture = await createFixture('delete-plan-outside-path');
    try {
      const outsideFile = path.join(fixture.tempRoot, 'outside-plan.md');
      fs.writeFileSync(outsideFile, '# outside plan\n', 'utf8');
      const unsafeRel = path.join('..', 'outside-plan.md');
      const planId = insertPlanRecord(fixture, unsafeRel, 'unsafe-outside');

      fixture.loop.deletePlan(fixture.projectId, planId);
      const skipEvent = latestEvent(fixture, 'plan.file.delete.skipped');
      const skipMeta = JSON.parse(skipEvent.meta);

      assert.equal(fs.existsSync(outsideFile), true, '越界计划路径指向的文件不应被删除');
      assert.equal(rowCount(fixture.db, 'plans', 'id = ?', [planId]), 0, '越界路径不应阻止计划记录删除');
      assert.equal(skipMeta.planId, planId, '跳过事件应记录 planId');
      assert.equal(skipMeta.reason, 'outside_docs_plan', '跳过事件应记录越界原因');
    } finally {
      fixture.cleanup();
    }
  });

  it('does not delete a symlink target that escapes docs/plan and records a skipped event', async (t) => {
    const fixture = await createFixture('delete-plan-symlink-escape');
    try {
      const outsideFile = path.join(fixture.tempRoot, 'symlink-target.md');
      fs.writeFileSync(outsideFile, '# symlink target\n', 'utf8');
      const linkRel = path.join('docs', 'plan', 'plan_symlink_escape.md');
      const linkFile = path.join(fixture.workspace, linkRel);
      try {
        fs.symlinkSync(outsideFile, linkFile, 'file');
      } catch (error) {
        t.skip(`当前环境不能创建文件符号链接：${error?.message || error}`);
        return;
      }
      const planId = insertPlanRecord(fixture, linkRel, 'symlink-escape');

      fixture.loop.deletePlan(fixture.projectId, planId);
      const skipEvent = latestEvent(fixture, 'plan.file.delete.skipped');
      const skipMeta = JSON.parse(skipEvent.meta);

      assert.equal(fs.existsSync(outsideFile), true, '符号链接逃逸目标不应被删除');
      assert.equal(skipMeta.planId, planId, '跳过事件应记录 planId');
      assert.equal(skipMeta.reason, 'realpath_outside_docs_plan', '跳过事件应记录 realpath 逃逸原因');
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

function linkIntakePlan(fixture, intakeType, intakeId, planId, phaseIndex = 1, phaseTitle = '') {
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

function insertPlanRecord(fixture, planRel, hashSuffix = 'unsafe') {
  const now = nowIso();
  const planId = fixture.db.insert(
    `INSERT INTO plans (project_id, issue_hash, file_path, hash, status, total_tasks, completed_tasks, validation_passed, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'running', 0, 0, 0, ?, ?)`,
    [fixture.projectId, `delete-plan-${hashSuffix}`, planRel, `${hashSuffix}-hash`, now, now],
  );
  fixture.db.run(
    `INSERT OR REPLACE INTO scan_files
     (project_id, scan_type, file_path, hash, size, modified_at, scanned_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [fixture.projectId, 'plan', planRel, 'scan-hash', 0, now, now],
  );
  return planId;
}

function attachActivePlanOperation(fixture, planId, taskId, startedAt) {
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
    label: 'delete active plan',
    startedAt,
  };
  runtime.activeOperations.set('delete-plan-op', operation);
  runtime.activeChildren.set('delete-plan-op', child);
  runtime.activeOperation = operation;
  runtime.activeChild = child;
  return child;
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
