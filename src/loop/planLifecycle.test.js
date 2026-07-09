const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { AppDatabase, nowIso } = require('../database');
const { LoopService } = require('../loopService');
const planLifecycle = require('./planLifecycle');

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

describe('LoopService validation_failed queue lifecycle', () => {
  it('skips validation_failed plans and selects the next runnable plan in the same project queue', async () => {
    const fixture = await createFixture('validation-failed-skip-queue');
    try {
      const failed = createPlanWithTasks(fixture, {
        status: 'validation_failed',
        sortOrder: 1,
        issueHash: 'validation-failed-first',
        taskLines: [
          '- [x] P001: 已完成实现 <!-- scope: src/done.js -->',
          '- [ ] P002: 完整验收 <!-- scope: validation -->',
        ],
      });
      const nextPending = createPlanWithTasks(fixture, {
        status: 'pending',
        sortOrder: 2,
        issueHash: 'pending-after-validation-failed',
        taskLines: [
          '- [ ] P001: 后续计划任务 <!-- scope: src/next.js -->',
          '- [ ] P002: 完整验收 <!-- scope: validation -->',
        ],
      });

      const runnable = fixture.loop.nextRunnablePlan(fixture.projectId);

      assert.ok(runnable, '同项目仍有后续可运行计划时应返回计划');
      assert.equal(runnable.id, nextPending.planId, 'validation_failed 计划不应阻塞后续 pending 计划');
      assert.notEqual(runnable.id, failed.planId, 'validation_failed 计划不应被自动调度选中');
    } finally {
      fixture.cleanup();
    }
  });

  it('does not call validatePlan again for a validation_failed plan on the next automatic runOnce cycle', async () => {
    const fixture = await createFixture('validation-failed-run-once-skip');
    try {
      const failed = createPlanWithTasks(fixture, {
        status: 'validation_failed',
        sortOrder: 1,
        issueHash: 'runonce-validation-failed',
        taskLines: [
          '- [x] P001: 已完成实现 <!-- scope: src/done.js -->',
          '- [ ] P002: 完整验收 <!-- scope: validation -->',
        ],
      });
      const followUp = createPlanWithTasks(fixture, {
        status: 'pending',
        sortOrder: 2,
        issueHash: 'runonce-follow-up',
        taskLines: [
          '- [x] P001: 后续已完成实现 <!-- scope: src/next.js -->',
          '- [ ] P002: 完整验收 <!-- scope: validation -->',
        ],
      });
      const validateCalls = [];
      const originalValidatePlan = fixture.loop.validatePlan;
      const originalScanDirectoryInWorker = fixture.loop.scanDirectoryInWorker;
      fixture.loop.scanDirectoryInWorker = async () => ({ root: path.join(fixture.workspace, 'docs', 'plan'), aggregateHash: '', files: [] });
      fixture.loop.validatePlan = async (_workspace, plan, options) => {
        validateCalls.push({ planId: plan.id, taskKey: options?.task?.task_key || '' });
        return { exitCode: 0, logFile: null, finishedAt: nowIso() };
      };

      try {
        await fixture.loop.runOnce(fixture.projectId);
      } finally {
        fixture.loop.validatePlan = originalValidatePlan;
        fixture.loop.scanDirectoryInWorker = originalScanDirectoryInWorker;
      }

      assert.deepEqual(
        validateCalls.map((call) => call.planId),
        [followUp.planId],
        '自动 runOnce 应跳过历史 validation_failed 计划，只验收后续可运行计划',
      );
      assert.equal(validateCalls[0]?.taskKey, 'P002', '后续计划仍应走完整验收任务分支');
      assert.equal(
        rowCount(fixture.db, 'events', 'type = ? AND meta LIKE ?', ['task.failed', `%"planId":${failed.planId}%`]),
        0,
        '跳过 validation_failed 计划时不应为同一失败计划追加新的失败任务事件',
      );
    } finally {
      fixture.cleanup();
    }
  });

  it('allows a manually restored validation_failed plan back into the queue without changing completed, interrupted, or draft plans', async () => {
    const fixture = await createFixture('validation-failed-manual-restore');
    try {
      const failed = createPlanWithTasks(fixture, {
        status: 'validation_failed',
        sortOrder: 1,
        issueHash: 'restore-validation-failed',
        taskLines: [
          '- [x] P001: 已完成实现 <!-- scope: src/done.js -->',
          '- [ ] P002: 完整验收 <!-- scope: validation -->',
        ],
      });
      const completed = createPlanWithTasks(fixture, { status: 'completed', sortOrder: 2, issueHash: 'restore-completed' });
      const interrupted = createPlanWithTasks(fixture, { status: 'interrupted', sortOrder: 3, issueHash: 'restore-interrupted' });
      const draft = createPlanWithTasks(fixture, { status: 'draft', sortOrder: 4, issueHash: 'restore-draft' });
      const acceptanceTask = fixture.db.get('SELECT * FROM plan_tasks WHERE plan_id = ? AND task_key = ?', [
        failed.planId,
        'P002',
      ]);
      fixture.db.run('UPDATE plans SET validation_passed = 0 WHERE id = ?', [failed.planId]);
      fixture.db.run('UPDATE plan_tasks SET status = ?, updated_at = ? WHERE id = ?', [
        'failed',
        nowIso(),
        acceptanceTask.id,
      ]);

      const restored = fixture.loop.resumePlan(fixture.projectId, failed.planId);
      const restoredTask = fixture.db.get('SELECT * FROM plan_tasks WHERE id = ?', [acceptanceTask.id]);
      const untouched = fixture.db
        .all('SELECT id, status FROM plans WHERE id IN (?, ?, ?) ORDER BY id ASC', [
          completed.planId,
          interrupted.planId,
          draft.planId,
        ])
        .map((plan) => [plan.id, plan.status]);

      assert.equal(restored.status, 'pending', '人工恢复 validation_failed 后计划应回到 pending');
      assert.equal(restored.validation_passed, 0, '恢复失败验收计划不应误置 validation_passed');
      assert.equal(restoredTask.status, 'pending', '失败的完整验收任务应重置为 pending 以便显式重试');
      assert.deepEqual(untouched, [
        [completed.planId, 'completed'],
        [interrupted.planId, 'interrupted'],
        [draft.planId, 'draft'],
      ], '恢复 validation_failed 不应改变其它终态/草稿计划语义');
      assert.equal(fixture.loop.nextRunnablePlan(fixture.projectId)?.id, failed.planId, '恢复后的计划应重新进入执行队列');
    } finally {
      fixture.cleanup();
    }
  });
});

describe('LoopService nextRunnablePlan queue ordering', () => {
  it('skips completed, interrupted, draft, and validation_failed plans before a ready_for_validation plan', async () => {
    const fixture = await createFixture('next-runnable-terminal-skip-ready');
    try {
      createPlanWithTasks(fixture, { status: 'completed', sortOrder: 1, issueHash: 'queue-completed' });
      createPlanWithTasks(fixture, { status: 'interrupted', sortOrder: 2, issueHash: 'queue-interrupted' });
      createPlanWithTasks(fixture, { status: 'draft', sortOrder: 3, issueHash: 'queue-draft' });
      createPlanWithTasks(fixture, { status: 'validation_failed', sortOrder: 4, issueHash: 'queue-validation-failed' });
      const ready = createPlanWithTasks(fixture, {
        status: 'ready_for_validation',
        sortOrder: 5,
        issueHash: 'queue-ready-for-validation',
        taskLines: [
          '- [x] P001: 实现已完成 <!-- scope: src/done.js -->',
          '- [ ] P002: 完整验收 <!-- scope: validation -->',
        ],
      });
      const pending = createPlanWithTasks(fixture, { status: 'pending', sortOrder: 6, issueHash: 'queue-pending-after-ready' });

      const runnable = fixture.loop.nextRunnablePlan(fixture.projectId);

      assert.ok(runnable, '存在 ready_for_validation 时应返回可运行计划');
      assert.equal(runnable.id, ready.planId, 'ready_for_validation 应先于后续 pending 计划进入自动队列');
      assert.notEqual(runnable.id, pending.planId, '后续 pending 不应越过更早的 ready_for_validation');
    } finally {
      fixture.cleanup();
    }
  });

  it('keeps an earlier pending plan ahead of later ready_for_validation and pending plans', async () => {
    const fixture = await createFixture('next-runnable-earlier-pending-blocks');
    try {
      const firstPending = createPlanWithTasks(fixture, { status: 'pending', sortOrder: 1, issueHash: 'queue-first-pending' });
      createPlanWithTasks(fixture, {
        status: 'ready_for_validation',
        sortOrder: 2,
        issueHash: 'queue-later-ready',
        taskLines: [
          '- [x] P001: 后续实现已完成 <!-- scope: src/done.js -->',
          '- [ ] P002: 完整验收 <!-- scope: validation -->',
        ],
      });
      createPlanWithTasks(fixture, { status: 'pending', sortOrder: 3, issueHash: 'queue-later-pending' });

      const runnable = fixture.loop.nextRunnablePlan(fixture.projectId);

      assert.ok(runnable, '存在 pending 时应返回可运行计划');
      assert.equal(runnable.id, firstPending.planId, '更早 pending 计划应阻止后续计划抢跑');
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

  it('reactivates completed plan and appends task when all linked plans are completed', async () => {
    const fixture = await createFixture('append-completed-reactivate');
    try {
      const requirementId = insertRequirement(fixture, '全部完成时追加任务');
      const { planId } = createPlan(fixture, 'completed');
      linkIntakePlan(fixture, 'requirement', requirementId, planId, 1, '已完成阶段');

      const summary = fixture.loop.appendTaskToIntakePlan(
        fixture.projectId,
        'requirement',
        requirementId,
        '补充任务到已完成计划',
      );

      // Plan should now be pending (reactivated)
      const plan = fixture.db.get('SELECT * FROM plans WHERE id = ?', [planId]);
      assert.equal(plan.status, 'pending', '完成后追加任务应自动重新激活计划');
      assert.equal(plan.validation_passed, 0, '重新激活应清除 validation_passed');

      // Task should exist in plan_tasks
      const task = fixture.db.get(
        'SELECT * FROM plan_tasks WHERE plan_id = ? AND title = ?',
        [planId, '补充任务到已完成计划'],
      );
      assert.ok(task, '追加的任务应存在于 plan_tasks 表');
      assert.equal(summary.planId, planId, 'summary 应指向目标计划');
      assert.equal(summary.reExecuted, true, 'summary 应标记 reExecuted');

      // Verify reexecute event was recorded
      const reexecEvent = latestEvent(fixture, 'plan.reexecuted');
      const reexecMeta = JSON.parse(reexecEvent.meta);
      assert.equal(reexecMeta.planId, planId, '重新执行事件应记录 planId');

      // Verify appended event includes reExecuted
      const appendEvent = latestEvent(fixture, 'intake.task.appended');
      const appendMeta = JSON.parse(appendEvent.meta);
      assert.equal(appendMeta.reExecuted, true, '追加事件应标记 reExecuted');
      assert.equal(appendMeta.planId, planId, '追加事件应记录 planId');
    } finally {
      fixture.cleanup();
    }
  });
});

describe('LoopService.updatePlanExecutionConfig', () => {
  it('updates execution config on an interrupted plan and records an event', async () => {
    const fixture = await createFixture('update-exec-interrupted');
    try {
      const { planId } = createPlan(fixture, 'interrupted');

      const updated = fixture.loop.updatePlanExecutionConfig(fixture.projectId, planId, {
        provider: 'claude',
        command: 'claude-exec',
      });

      const row = fixture.db.get('SELECT * FROM plans WHERE id = ?', [planId]);
      assert.equal(row.plan_execution_provider, 'claude', '应更新 provider');
      assert.equal(row.plan_execution_command, 'claude-exec', '应更新 command');
      assert.equal(updated.plan_execution_provider, 'claude', '返回值应反映最新 provider');
      assert.equal(updated.plan_execution_command, 'claude-exec', '返回值应反映最新 command');

      const event = latestEvent(fixture, 'plan.execution_config.updated');
      const meta = JSON.parse(event.meta);
      assert.equal(meta.planId, planId, '事件应记录 planId');
      assert.equal(meta.provider, 'claude', '事件应记录新 provider');
      assert.equal(meta.command, 'claude-exec', '事件应记录新 command');
    } finally {
      fixture.cleanup();
    }
  });

  it('updates execution config on a stopped plan', async () => {
    const fixture = await createFixture('update-exec-stopped');
    try {
      const { planId } = createPlan(fixture, 'stopped');

      const updated = fixture.loop.updatePlanExecutionConfig(fixture.projectId, planId, {
        provider: 'opencode',
        command: 'opencode-exec',
      });

      const row = fixture.db.get('SELECT * FROM plans WHERE id = ?', [planId]);
      assert.equal(row.plan_execution_provider, 'opencode', 'stopped 计划应允许更新 provider');
      assert.equal(row.plan_execution_command, 'opencode-exec', 'stopped 计划应允许更新 command');
      assert.ok(updated, '应返回更新后的计划');
    } finally {
      fixture.cleanup();
    }
  });

  it('updates execution config on unfinished runnable plans', async () => {
    const fixture = await createFixture('update-exec-unfinished');
    try {
      const statuses = ['running', 'pending', 'ready_for_validation'];

      for (const [index, status] of statuses.entries()) {
        const { planId } = createPlanWithTasks(fixture, {
          status,
          sortOrder: index + 1,
          issueHash: `update-exec-${status}`,
        });

        const updated = fixture.loop.updatePlanExecutionConfig(fixture.projectId, planId, {
          provider: 'codex',
          codexReasoningEffort: 'high',
        });
        const row = fixture.db.get('SELECT * FROM plans WHERE id = ?', [planId]);

        assert.equal(row.status, status, `${status} 计划更新配置后状态不应改变`);
        assert.equal(row.plan_execution_provider, 'codex', `${status} 计划应允许更新 provider`);
        assert.equal(row.plan_execution_codex_reasoning_effort, 'high', `${status} 计划应允许更新 Codex 思考深度`);
        assert.equal(updated.plan_execution_codex_reasoning_effort, 'high', `${status} 计划返回值应包含新思考深度`);
      }
    } finally {
      fixture.cleanup();
    }
  });

  it('rejects updating execution config on a completed plan', async () => {
    const fixture = await createFixture('update-exec-completed');
    try {
      const { planId } = createPlan(fixture, 'completed');

      assert.throws(
        () => fixture.loop.updatePlanExecutionConfig(fixture.projectId, planId, { provider: 'opencode' }),
        /已完成计划不允许修改执行配置/,
        '已完成的计划不允许修改执行配置',
      );
    } finally {
      fixture.cleanup();
    }
  });

  it('updates codex reasoning effort and records previous and next values', async () => {
    const fixture = await createFixture('update-exec-codex-effort');
    try {
      const { planId } = createPlan(fixture, 'running');
      fixture.db.run(
        `UPDATE plans
         SET plan_execution_provider = ?,
             plan_execution_command = ?,
             plan_execution_codex_reasoning_effort = ?,
             agent_cli_session_id = ?
         WHERE id = ?`,
        ['codex', 'codex', 'medium', 'codex-session-123', planId],
      );

      const updated = fixture.loop.updatePlanExecutionConfig(fixture.projectId, planId, {
        codexReasoningEffort: 'xhigh',
      });

      assert.equal(updated.plan_execution_codex_reasoning_effort, 'xhigh', '应更新计划执行 Codex 思考深度');
      assert.equal(updated.agent_cli_session_id, 'codex-session-123', 'provider 仍为 codex 时不应清除已有 session');

      const event = latestEvent(fixture, 'plan.execution_config.updated');
      const meta = JSON.parse(event.meta);
      assert.equal(meta.previousCodexReasoningEffort, 'medium', '事件应记录更新前思考深度');
      assert.equal(meta.codexReasoningEffort, 'xhigh', '事件应记录更新后思考深度');
      assert.equal(meta.agentCliSessionCleared, undefined, '仅更新 Codex 思考深度不应标记清除 session');
    } finally {
      fixture.cleanup();
    }
  });

  it('merges partial input with existing plan config values', async () => {
    const fixture = await createFixture('update-exec-partial');
    try {
      const { planId } = createPlan(fixture, 'interrupted');
      // Pre-set some execution config values
      fixture.db.run(
        `UPDATE plans SET plan_execution_provider = ?, plan_execution_command = ?, plan_execution_model = ? WHERE id = ?`,
        ['codex', 'codex', 'gpt-5', planId],
      );

      // Only update provider — command/model should stay
      fixture.loop.updatePlanExecutionConfig(fixture.projectId, planId, {
        provider: 'claude',
      });

      const row = fixture.db.get('SELECT * FROM plans WHERE id = ?', [planId]);
      assert.equal(row.plan_execution_provider, 'claude', 'provider 应更新为 claude');
      assert.equal(row.plan_execution_command, 'claude', '未提供的 command 应保留原值');
      assert.equal(row.plan_execution_model, 'gpt-5', '未提供的 model 应保留原值');
    } finally {
      fixture.cleanup();
    }
  });

  it('returns the current plan unchanged when no config columns are available', async () => {
    const fixture = await createFixture('update-exec-noop');
    try {
      const { planId } = createPlan(fixture, 'interrupted');

      const result = fixture.loop.updatePlanExecutionConfig(fixture.projectId, planId, {});

      assert.equal(result.id, planId, '空输入应返回当前计划');
      assert.equal(result.status, 'interrupted', '计划状态不应改变');
    } finally {
      fixture.cleanup();
    }
  });

  it('clears plan agent_cli_session_id when provider changes', async () => {
    const fixture = await createFixture('update-exec-clear-session');
    try {
      const { planId } = createPlan(fixture, 'interrupted');
      // Simulate a prior opencode session stored on the plan
      fixture.db.run(
        'UPDATE plans SET plan_execution_provider = ?, agent_cli_session_id = ? WHERE id = ?',
        ['opencode', 'old-opencode-session-123', planId],
      );

      // Switch from opencode to claude
      const updated = fixture.loop.updatePlanExecutionConfig(fixture.projectId, planId, {
        provider: 'claude',
        command: 'claude-exec',
      });

      assert.equal(updated.plan_execution_provider, 'claude', 'provider 应更新为 claude');
      assert.equal(updated.agent_cli_session_id, null, 'provider 变更时 agent_cli_session_id 应被清除');

      const event = latestEvent(fixture, 'plan.execution_config.updated');
      const meta = JSON.parse(event.meta);
      assert.equal(meta.agentCliSessionCleared, true, '事件应标记 session 已清除');
    } finally {
      fixture.cleanup();
    }
  });

  it('preserves agent_cli_session_id when provider does not change', async () => {
    const fixture = await createFixture('update-exec-keep-session');
    try {
      const { planId } = createPlan(fixture, 'interrupted');
      fixture.db.run(
        'UPDATE plans SET plan_execution_provider = ?, agent_cli_session_id = ? WHERE id = ?',
        ['opencode', 'existing-opencode-session', planId],
      );

      // Same provider, different command
      const updated = fixture.loop.updatePlanExecutionConfig(fixture.projectId, planId, {
        provider: 'opencode',
        command: 'opencode-v2',
      });

      assert.equal(updated.plan_execution_provider, 'opencode', 'provider 应保持 opencode');
      assert.equal(updated.plan_execution_command, 'opencode-v2', 'command 应更新');
      assert.equal(updated.agent_cli_session_id, 'existing-opencode-session', '同 provider 未变更时不应清除 session');
    } finally {
      fixture.cleanup();
    }
  });
});

describe('LoopService.configure plan execution config sync', () => {
  it('syncs Codex reasoning effort to unfinished plans without interrupting active work', async () => {
    const fixture = await createFixture('configure-sync-codex-effort');
    try {
      const statuses = ['running', 'pending', 'ready_for_validation', 'interrupted', 'stopped'];
      const unfinishedPlanIds = statuses.map((status, index) => {
        const { planId } = createPlanWithTasks(fixture, {
          status,
          sortOrder: index + 1,
          issueHash: `configure-sync-${status}`,
        });
        fixture.db.run(
          'UPDATE plans SET plan_execution_provider = ?, plan_execution_codex_reasoning_effort = ? WHERE id = ?',
          ['codex', 'medium', planId],
        );
        return planId;
      });
      const { planId: completedPlanId } = createPlanWithTasks(fixture, {
        status: 'completed',
        sortOrder: 99,
        issueHash: 'configure-sync-completed',
      });
      fixture.db.run(
        'UPDATE plans SET plan_execution_provider = ?, plan_execution_codex_reasoning_effort = ? WHERE id = ?',
        ['codex', 'medium', completedPlanId],
      );
      const runtime = fixture.loop.runtime(fixture.projectId);
      const activeOperation = { projectId: fixture.projectId, planId: unfinishedPlanIds[0], taskId: 123, label: 'active task' };
      runtime.activeOperations.set('configure-sync-active-task', activeOperation);
      runtime.activeOperation = activeOperation;

      fixture.loop.configure(fixture.projectId, {
        workspacePath: fixture.workspace,
        planExecutionProvider: 'codex',
        planExecutionCodexReasoningEffort: 'xhigh',
      });

      const state = fixture.loop.status(fixture.projectId);
      assert.equal(state.plan_execution_provider, 'codex', '项目状态应保存 Codex 执行后端');
      assert.equal(state.plan_execution_codex_reasoning_effort, 'xhigh', '项目状态应保存新的执行思考深度');
      for (const planId of unfinishedPlanIds) {
        const row = fixture.db.get('SELECT status, plan_execution_codex_reasoning_effort FROM plans WHERE id = ?', [planId]);
        assert.equal(row.plan_execution_codex_reasoning_effort, 'xhigh', `${row.status} 计划应同步新的执行思考深度`);
      }
      assert.equal(
        fixture.db.get('SELECT plan_execution_codex_reasoning_effort FROM plans WHERE id = ?', [completedPlanId]).plan_execution_codex_reasoning_effort,
        'medium',
        'completed 计划不应被运行期设置同步改写',
      );
      assert.equal(runtime.activeOperations.get('configure-sync-active-task'), activeOperation, '保存设置不应中断正在运行的任务');
      assert.equal(runtime.activeOperation, activeOperation, '保存设置不应清理当前 activeOperation');
    } finally {
      fixture.cleanup();
    }
  });

  it('clears unfinished plan Codex reasoning effort when execution provider is non-Codex', async () => {
    const fixture = await createFixture('configure-sync-non-codex');
    try {
      const { planId: codexPlanId } = createPlanWithTasks(fixture, {
        status: 'pending',
        issueHash: 'configure-sync-non-codex-codex',
      });
      const { planId: claudePlanId } = createPlanWithTasks(fixture, {
        status: 'running',
        sortOrder: 2,
        issueHash: 'configure-sync-non-codex-claude',
      });
      fixture.db.run(
        'UPDATE plans SET plan_execution_provider = ?, plan_execution_codex_reasoning_effort = ? WHERE id = ?',
        ['codex', 'high', codexPlanId],
      );
      fixture.db.run(
        'UPDATE plans SET plan_execution_provider = ?, plan_execution_codex_reasoning_effort = ? WHERE id = ?',
        ['claude', 'high', claudePlanId],
      );

      fixture.loop.configure(fixture.projectId, {
        workspacePath: fixture.workspace,
        planExecutionProvider: 'claude',
        planExecutionCommand: 'claude-exec',
        planExecutionCodexReasoningEffort: 'xhigh',
      });

      const state = fixture.loop.status(fixture.projectId);
      assert.equal(state.plan_execution_provider, 'claude', '项目状态应保存非 Codex 执行后端');
      assert.equal(state.plan_execution_codex_reasoning_effort, null, '非 Codex 执行后端不应在项目状态残留思考深度');
      assert.equal(
        fixture.db.get('SELECT plan_execution_codex_reasoning_effort FROM plans WHERE id = ?', [codexPlanId]).plan_execution_codex_reasoning_effort,
        null,
        '切换为非 Codex 执行后端时应清空未完成 Codex 计划的思考深度快照',
      );
      assert.equal(
        fixture.db.get('SELECT plan_execution_codex_reasoning_effort FROM plans WHERE id = ?', [claudePlanId]).plan_execution_codex_reasoning_effort,
        null,
        '非 Codex 计划不应保留或误写 Codex 思考深度',
      );
    } finally {
      fixture.cleanup();
    }
  });
});

describe('LoopService.reExecutePlan', () => {
  it('re-executes a completed plan: resets tasks, clears validation, and allows re-selection', async () => {
    const fixture = await createFixture('reexecute-completed');
    try {
      const { planId } = createPlan(fixture, 'completed');
      // Set validation_passed to simulate a validated completed plan
      fixture.db.run('UPDATE plans SET validation_passed = 1 WHERE id = ?', [planId]);
      // Mark all tasks as completed
      fixture.db.run('UPDATE plan_tasks SET status = ? WHERE plan_id = ?', ['completed', planId]);

      const updated = fixture.loop.reExecutePlan(fixture.projectId, planId);

      const plan = fixture.db.get('SELECT * FROM plans WHERE id = ?', [planId]);
      assert.equal(plan.status, 'pending', '计划状态应从 completed 变为 pending');
      assert.equal(plan.validation_passed, 0, 'validation_passed 应被清除');

      const tasks = fixture.db.all('SELECT status FROM plan_tasks WHERE plan_id = ?', [planId]);
      assert.ok(tasks.length > 0, '应存在任务');
      for (const task of tasks) {
        assert.equal(task.status, 'pending', `所有任务应重置为 pending，实际为 ${task.status}`);
      }

      assert.equal(updated.status, 'pending', '返回值应反映最新状态');
      assert.equal(updated.validation_passed, 0, '返回值应反映清空的 validation_passed');

      const event = latestEvent(fixture, 'plan.reexecuted');
      const meta = JSON.parse(event.meta);
      assert.equal(meta.planId, planId, '事件应记录 planId');
      assert.equal(meta.previousStatus, 'completed', '事件应记录原状态');
      assert.equal(meta.status, 'pending', '事件应记录新状态');
      assert.equal(meta.resetTasks, tasks.length, '事件应记录重置的任务数');

      const runnable = fixture.loop.nextRunnablePlan(fixture.projectId);
      assert.ok(runnable, '重新执行后计划应可被 nextRunnablePlan 选中');
      assert.equal(runnable.id, planId, '选中的应是重新执行的计划');
    } finally {
      fixture.cleanup();
    }
  });

  it('can clear manual acceptance state and write custom redo event metadata', async () => {
    const fixture = await createFixture('reexecute-clear-acceptance');
    try {
      const { planId } = createPlan(fixture, 'completed');
      const acceptedAt = nowIso();
      fixture.db.run('UPDATE plans SET accepted_at = ?, validation_passed = 1 WHERE id = ?', [acceptedAt, planId]);
      fixture.db.run('UPDATE plan_tasks SET status = ? WHERE plan_id = ?', ['completed', planId]);

      const updated = planLifecycle.reExecutePlan(fixture.loop, fixture.projectId, planId, {
        clearAcceptedAt: true,
        eventType: 'plan.redo',
        eventMessage: `plan #${planId} 已退回重做`,
        eventMeta: {
          targetType: 'plan',
          id: planId,
          supplement: '补充说明',
        },
      });

      const plan = fixture.db.get('SELECT * FROM plans WHERE id = ?', [planId]);
      const event = latestEvent(fixture, 'plan.redo');
      const meta = JSON.parse(event.meta);

      assert.equal(updated.status, 'pending', '返回计划应回到 pending');
      assert.equal(plan.accepted_at, null, 'clearAcceptedAt=true 时应清空 accepted_at');
      assert.equal(plan.validation_passed, 0, '重做应清空 validation_passed');
      assert.equal(meta.targetType, 'plan', '自定义事件 meta 应保留 targetType');
      assert.equal(meta.id, planId, '自定义事件 meta 应保留 id');
      assert.equal(meta.planId, planId, '基础事件 meta 应保留 planId');
      assert.equal(meta.supplement, '补充说明', '自定义事件 meta 应保留补充说明');
    } finally {
      fixture.cleanup();
    }
  });

  it('can clear task acceptance state and write custom task redo event metadata', async () => {
    const fixture = await createFixture('redo-task-clear-acceptance');
    try {
      const { planId } = createPlan(fixture, 'completed');
      const task = fixture.db.get('SELECT * FROM plan_tasks WHERE plan_id = ? AND task_key = ?', [planId, 'P001']);
      const acceptedAt = nowIso();
      fixture.db.run('UPDATE plans SET accepted_at = ?, validation_passed = 1 WHERE id = ?', [acceptedAt, planId]);
      fixture.db.run('UPDATE plan_tasks SET status = ?, accepted_at = ? WHERE id = ?', ['completed', acceptedAt, task.id]);

      const updated = planLifecycle.redoTask(fixture.loop, fixture.projectId, task.id, {
        eventType: 'task.redo',
        eventMessage: `${task.task_key} redo`,
        eventMeta: {
          supplement: 'task supplement',
          previousAcceptedAt: acceptedAt,
        },
      });

      const plan = fixture.db.get('SELECT * FROM plans WHERE id = ?', [planId]);
      const event = latestEvent(fixture, 'task.redo');
      const meta = JSON.parse(event.meta);

      assert.equal(updated.status, 'pending', 'updated task should return to pending');
      assert.equal(updated.accepted_at, null, 'redoTask should clear task accepted_at');
      assert.equal(plan.status, 'pending', 'task redo should return the owning plan to pending');
      assert.equal(plan.accepted_at, null, 'task redo should clear owning plan accepted_at');
      assert.equal(plan.validation_passed, 0, 'task redo should clear owning plan validation_passed');
      assert.equal(meta.targetType, 'task', 'base event meta should record targetType');
      assert.equal(meta.id, task.id, 'base event meta should record id');
      assert.equal(meta.taskId, task.id, 'base event meta should record taskId');
      assert.equal(meta.planId, planId, 'base event meta should record planId');
      assert.equal(meta.previousAcceptedAt, acceptedAt, 'custom event meta should preserve previousAcceptedAt');
      assert.equal(meta.supplement, 'task supplement', 'custom event meta should preserve supplement');
    } finally {
      fixture.cleanup();
    }
  });

  it('rejects re-executing an interrupted plan', async () => {
    const fixture = await createFixture('reexecute-interrupted');
    try {
      const { planId } = createPlan(fixture, 'interrupted');

      assert.throws(
        () => fixture.loop.reExecutePlan(fixture.projectId, planId),
        /仅可重新执行已完成的计划/,
        '非 completed 计划不允许重新执行',
      );

      const plan = fixture.db.get('SELECT * FROM plans WHERE id = ?', [planId]);
      assert.equal(plan.status, 'interrupted', '拒绝后计划状态不应改变');
    } finally {
      fixture.cleanup();
    }
  });

  it('rejects re-executing a running plan', async () => {
    const fixture = await createFixture('reexecute-running');
    try {
      const { planId } = createPlan(fixture, 'running');

      assert.throws(
        () => fixture.loop.reExecutePlan(fixture.projectId, planId),
        /仅可重新执行已完成的计划/,
        '运行中的计划不允许重新执行',
      );
    } finally {
      fixture.cleanup();
    }
  });

  it('handles completed plan with no completed tasks gracefully', async () => {
    const fixture = await createFixture('reexecute-no-tasks');
    try {
      const { planId } = createPlan(fixture, 'completed');
      // Tasks are still pending (not marked completed)
      fixture.db.run('UPDATE plan_tasks SET status = ? WHERE plan_id = ?', ['pending', planId]);

      const updated = fixture.loop.reExecutePlan(fixture.projectId, planId);

      const plan = fixture.db.get('SELECT * FROM plans WHERE id = ?', [planId]);
      assert.equal(plan.status, 'pending', '计划状态应从 completed 变为 pending');

      const event = latestEvent(fixture, 'plan.reexecuted');
      const meta = JSON.parse(event.meta);
      assert.equal(meta.resetTasks, 0, '无已完成任务时 resetTasks 应为 0');
    } finally {
      fixture.cleanup();
    }
  });
});

describe('LoopService.recreatePlanFromIntake', () => {
  it('recreates a plan from a completed plan linked to a requirement', async () => {
    const fixture = await createFixture('recreate-completed');
    try {
      const requirementId = insertRequirement(fixture, '重新创建测试需求');
      const { planId } = createPlan(fixture, 'completed');
      linkIntakePlan(fixture, 'requirement', requirementId, planId, 1, '');

      // Mock generatePlanForIntake to return a fake new plan ID
      const origGenerate = fixture.loop.generatePlanForIntake;
      let capturedIntake = null;
      fixture.loop.generatePlanForIntake = async (pid, ws, intake) => {
        capturedIntake = intake;
        // Simulate insertion of a new plan
        const newPlanRel = path.join('docs', 'plan', 'plan_recreated_test.md');
        const newPlanFile = path.join(fixture.workspace, newPlanRel);
        fs.mkdirSync(path.dirname(newPlanFile), { recursive: true });
        fs.writeFileSync(newPlanFile, '# recreated\n\n- [ ] P001: test <!-- scope: unknown -->\n\n## 总体验收标准\n\n## 进度区\n', 'utf8');
        const newPlanId = fixture.loop.insertPlan({
          projectId: pid,
          issueHash: 'recreate-test',
          filePath: newPlanRel,
          hash: 'recreate-hash',
          status: 'pending',
        });
        fixture.loop.syncPlanTasks(newPlanId, newPlanFile);
        return newPlanId;
      };

      try {
        const newPlanId = await fixture.loop.recreatePlanFromIntake(fixture.projectId, planId);
        assert.ok(newPlanId, '应返回新的计划 ID');
        assert.ok(newPlanId !== planId, '新计划 ID 应与旧计划不同');

        // Old plan should be unchanged
        const oldPlan = fixture.db.get('SELECT * FROM plans WHERE id = ?', [planId]);
        assert.equal(oldPlan.status, 'completed', '旧计划状态应保持不变');

        // New plan should exist and be linked
        const newPlan = fixture.db.get('SELECT * FROM plans WHERE id = ?', [newPlanId]);
        assert.ok(newPlan, '新计划应存在于 plans 表');
        assert.equal(newPlan.status, 'pending', '新计划状态应为 pending');

        // Verify event
        const event = latestEvent(fixture, 'plan.recreated');
        const meta = JSON.parse(event.meta);
        assert.equal(meta.previousPlanId, planId, '事件应记录旧 planId');
        assert.equal(meta.planId, newPlanId, '事件应记录新 planId');
        assert.equal(meta.intakeType, 'requirement', '事件应记录 intake 类型');
        assert.equal(meta.intakeId, requirementId, '事件应记录 intake ID');

        // Verify captured intake has __type
        assert.ok(capturedIntake, '应调用 generatePlanForIntake');
        assert.equal(capturedIntake.__type, 'requirement', 'intake 应标注 __type');
      } finally {
        fixture.loop.generatePlanForIntake = origGenerate;
      }
    } finally {
      fixture.cleanup();
    }
  });

  it('rejects re-creating from a non-completed plan', async () => {
    const fixture = await createFixture('recreate-running');
    try {
      const { planId } = createPlan(fixture, 'running');

      await assert.rejects(
        fixture.loop.recreatePlanFromIntake(fixture.projectId, planId),
        /仅可基于已完成的计划重新创建/,
        '非 completed 计划不允许重新创建',
      );
    } finally {
      fixture.cleanup();
    }
  });

  it('rejects re-creating when plan has no linked intake', async () => {
    const fixture = await createFixture('recreate-no-intake');
    try {
      const { planId } = createPlan(fixture, 'completed');

      await assert.rejects(
        fixture.loop.recreatePlanFromIntake(fixture.projectId, planId),
        /计划未关联需求\/反馈/,
        '无关联需求的计划不允许重新创建',
      );
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
  return createPlanWithTasks(fixture, { status });
}

function createPlanWithTasks(fixture, options = {}) {
  const status = options.status || 'running';
  const planRel = path.join('docs', 'plan', `plan_lifecycle_${Date.now()}_${Math.random().toString(36).slice(2)}.md`);
  const planFile = path.join(fixture.workspace, planRel);
  const taskLines = options.taskLines || [
    '- [ ] P001: 运行中的任务 <!-- scope: src/running.js -->',
    '- [ ] P002: 待执行任务 <!-- scope: src/pending.js -->',
    '- [x] P003: 已完成任务 <!-- scope: src/done.js -->',
  ];
  fs.mkdirSync(path.dirname(planFile), { recursive: true });
  fs.writeFileSync(
    planFile,
    [
      '# lifecycle plan',
      '',
      ...taskLines,
      '',
    ].join('\n'),
    'utf8',
  );
  const now = nowIso();
  const planId = fixture.db.insert(
    `INSERT INTO plans (project_id, issue_hash, file_path, hash, status, sort_order, total_tasks, completed_tasks, validation_passed, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0, ?, ?)`,
    [
      fixture.projectId,
      options.issueHash || `lifecycle-${Date.now()}`,
      planRel,
      options.hash || 'lifecycle-hash',
      status,
      Number(options.sortOrder || 1),
      now,
      now,
    ],
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

