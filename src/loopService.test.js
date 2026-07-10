const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { AppDatabase, nowIso } = require('./database');
const { IntakeService } = require('./intakeService');
const { LoopService } = require('./loopService');
const { MCP_TOOL_NAMES, callMcpTool } = require('./mcpTools');
const scriptHooks = require('./loop/scriptHooks');

describe('LoopService.retryIntakePlanGeneration', () => {
  it('清理需求失败状态、保存非 Codex CLI 覆盖并触发一次生成调度', async () => {
    const fixture = await createRetryFixture('requirement-claude');
    try {
      const requirementId = insertFailedRequirement(fixture, {
        agentCliProvider: 'codex',
        codexReasoningEffort: 'high',
      });
      const calls = stubRunOnce(fixture.loop);

      const snapshot = await fixture.loop.retryIntakePlanGeneration(fixture.projectId, 'requirement', requirementId, {
        agentCliProvider: 'claude',
        agentCliCommand: 'claude-custom',
        codexReasoningEffort: 'xhigh',
      });

      assert.deepEqual(calls, [fixture.projectId], '应触发一次 runOnce 调度');
      const row = fixture.db.get('SELECT * FROM requirements WHERE id = ?', [requirementId]);
      assert.equal(row.agent_cli_provider, 'claude');
      assert.equal(row.agent_cli_command, 'claude-custom');
      assert.equal(row.codex_reasoning_effort, null, '非 Codex 重试应清空 Codex 思考深度');
      assertClearedFailureState(row);

      const eventMeta = latestRetryEventMeta(fixture, 'plan.generate.retry.requested');
      assert.equal(eventMeta.intakeType, 'requirement');
      assert.equal(eventMeta.intakeId, requirementId);
      assert.equal(eventMeta.agentCliProvider, 'claude');
      assert.equal(eventMeta.agentCliCommand, 'claude-custom');
      assert.equal(eventMeta.codexReasoningEffort, null);
      assert.equal(eventMeta.runtimeBusy, false);

      const snapshotRequirement = snapshot.requirements.find((item) => item.id === requirementId);
      assert.ok(snapshotRequirement, '返回 snapshot 应包含重试需求');
      assert.equal(snapshotRequirement.generate_fail_count, 0);
      assert.equal(snapshotRequirement.last_generate_error, null);
      assert.equal(snapshotRequirement.last_generate_log_file, null);
      assert.equal(snapshotRequirement.agent_cli_provider, 'claude');
      assert.equal(snapshotRequirement.codex_reasoning_effort, null);
    } finally {
      fixture.cleanup();
    }
  });

  it('清理反馈失败状态、保存 Codex 思考深度覆盖并返回刷新后的快照', async () => {
    const fixture = await createRetryFixture('feedback-codex');
    try {
      const feedbackId = insertFailedFeedback(fixture, {
        agentCliProvider: 'opencode',
        codexReasoningEffort: null,
      });
      const calls = stubRunOnce(fixture.loop);

      const snapshot = await fixture.loop.retryIntakePlanGeneration(fixture.projectId, 'feedback', feedbackId, {
        agentCliProvider: 'codex',
        agentCliCommand: 'codex-next',
        codexReasoningEffort: 'xhigh',
      });

      assert.deepEqual(calls, [fixture.projectId], '反馈重试也应触发一次 runOnce');
      const row = fixture.db.get('SELECT * FROM feedback WHERE id = ?', [feedbackId]);
      assert.equal(row.agent_cli_provider, 'codex');
      assert.equal(row.agent_cli_command, 'codex-next');
      assert.equal(row.codex_reasoning_effort, 'xhigh');
      assertClearedFailureState(row);

      const eventMeta = latestRetryEventMeta(fixture, 'plan.generate.retry.requested');
      assert.equal(eventMeta.intakeType, 'feedback');
      assert.equal(eventMeta.intakeId, feedbackId);
      assert.equal(eventMeta.agentCliProvider, 'codex');
      assert.equal(eventMeta.agentCliCommand, 'codex-next');
      assert.equal(eventMeta.codexReasoningEffort, 'xhigh');

      const snapshotFeedback = snapshot.feedback.find((item) => item.id === feedbackId);
      assert.ok(snapshotFeedback, '返回 snapshot 应包含重试反馈');
      assert.equal(snapshotFeedback.generate_fail_count, 0);
      assert.equal(snapshotFeedback.last_generate_error, null);
      assert.equal(snapshotFeedback.last_generate_log_file, null);
      assert.equal(snapshotFeedback.agent_cli_provider, 'codex');
      assert.equal(snapshotFeedback.codex_reasoning_effort, 'xhigh');
    } finally {
      fixture.cleanup();
    }
  });

  it('已绑定 Plan 的 intake 禁止重试且不清理既有失败状态', async () => {
    const fixture = await createRetryFixture('bound-intake');
    try {
      const requirementId = insertFailedRequirement(fixture, {
        agentCliProvider: 'codex',
        codexReasoningEffort: 'medium',
      });
      const planId = insertPlan(fixture);
      fixture.db.run('UPDATE requirements SET linked_plan_id = ?, updated_at = ? WHERE id = ?', [
        planId,
        nowIso(),
        requirementId,
      ]);
      const calls = stubRunOnce(fixture.loop);

      await assert.rejects(
        () => fixture.loop.retryIntakePlanGeneration(fixture.projectId, 'requirement', requirementId, {
          agentCliProvider: 'claude',
        }),
        /需求已绑定 Plan，不能重复生成/,
      );

      assert.deepEqual(calls, [], '拒绝重试时不应触发 runOnce');
      const row = fixture.db.get('SELECT * FROM requirements WHERE id = ?', [requirementId]);
      assert.equal(row.generate_fail_count, 3, '拒绝重试不应清理失败计数');
      assert.equal(row.last_generate_error, '旧失败原因');
      assert.equal(row.agent_cli_provider, 'codex', '拒绝重试不应保存新的 CLI 覆盖');
      assert.equal(row.codex_reasoning_effort, 'medium');
      assert.equal(eventCount(fixture, 'plan.generate.retry.requested'), 0, '拒绝重试不应写入成功请求事件');
    } finally {
      fixture.cleanup();
    }
  });
});

describe('LoopService plan backend config persistence（P011）', () => {
  it('configure persists split generation and execution backend settings', async () => {
    const fixture = await createRetryFixture('backend-config-configure');
    try {
      fixture.loop.configure(fixture.projectId, {
        workspacePath: fixture.workspace,
        intervalSeconds: 7,
        validationCommand: 'npm test',
        planGenerationStrategy: 'external-cli-structured',
        planGenerationProvider: 'claude',
        planGenerationCommand: 'claude-plan',
        planGenerationCodexReasoningEffort: 'xhigh',
        planExecutionStrategy: 'external-cli',
        planExecutionProvider: 'codex',
        planExecutionCommand: 'codex-exec',
        planExecutionCodexReasoningEffort: 'high',
      });

      const state = fixture.loop.status(fixture.projectId);
      assert.equal(state.interval_seconds, 7);
      assert.equal(state.validation_command, 'npm test');
      assert.equal(state.plan_generation_strategy, 'external-cli-structured');
      assert.equal(state.plan_generation_provider, 'claude');
      assert.equal(state.plan_generation_command, 'claude-plan');
      assert.equal(state.plan_generation_codex_reasoning_effort, null);
      assert.equal(state.plan_execution_strategy, 'external-cli');
      assert.equal(state.plan_execution_provider, 'codex');
      assert.equal(state.plan_execution_command, 'codex-exec');
      assert.equal(state.plan_execution_codex_reasoning_effort, 'high');

      const snapshot = fixture.loop.snapshot(fixture.projectId);
      assert.equal(snapshot.state.plan_generation_provider, 'claude');
      assert.equal(snapshot.state.plan_execution_provider, 'codex');
    } finally {
      fixture.cleanup();
    }
  });

  it('retryIntakePlanGeneration persists plan generation overrides and emits them in event meta', async () => {
    const fixture = await createRetryFixture('backend-config-retry');
    try {
      const requirementId = insertFailedRequirement(fixture, {
        agentCliProvider: 'codex',
        codexReasoningEffort: 'medium',
      });
      const calls = stubRunOnce(fixture.loop);

      const snapshot = await fixture.loop.retryIntakePlanGeneration(
        fixture.projectId,
        'requirement',
        requirementId,
        {
          planGenerationStrategy: 'builtin-llm-structured',
          planGenerationProvider: 'openai',
          planGenerationModel: 'gpt-4o',
          planGenerationCodexReasoningEffort: 'xhigh',
        },
      );

      assert.deepEqual(calls, [fixture.projectId]);
      const row = fixture.db.get('SELECT * FROM requirements WHERE id = ?', [requirementId]);
      assert.equal(row.plan_generation_strategy, 'builtin-llm-structured');
      assert.equal(row.plan_generation_provider, 'openai');
      assert.equal(row.plan_generation_model, 'gpt-4o');
      assert.equal(row.plan_generation_codex_reasoning_effort, null);
      assertClearedFailureState(row);

      const eventMeta = latestRetryEventMeta(fixture, 'plan.generate.retry.requested');
      assert.equal(eventMeta.planGenerationStrategy, 'builtin-llm-structured');
      assert.equal(eventMeta.planGenerationProvider, 'openai');
      assert.equal(eventMeta.planGenerationModel, 'gpt-4o');
      assert.equal(eventMeta.planGenerationCodexReasoningEffort, null);

      const snapshotRequirement = snapshot.requirements.find((item) => item.id === requirementId);
      assert.ok(snapshotRequirement, 'snapshot should include retried requirement');
      assert.equal(snapshotRequirement.plan_generation_strategy, 'builtin-llm-structured');
      assert.equal(snapshotRequirement.plan_generation_provider, 'openai');
      assert.equal(snapshotRequirement.plan_generation_model, 'gpt-4o');
    } finally {
      fixture.cleanup();
    }
  });
});

describe('P010 LoopService lightweight runtime patch payload', () => {
  it('builds runtime patch payloads without full intake, attachment, scan, or plan arrays', async () => {
    const fixture = await createRetryFixture('runtime-patch-payload');
    try {
      const planId = insertPlan(fixture);
      const taskId = insertPlanTask(fixture, planId, { status: 'running' });
      insertHeavySnapshotRows(fixture);
      fixture.loop.addTaskLifecycleEvent(fixture.projectId, 'task.updated', {
        id: taskId,
        plan_id: planId,
        task_key: 'P010',
        title: 'runtime patch task',
        status: 'running',
      });

      const patch = fixture.loop.snapshotPatch(fixture.projectId);

      assertLightweightPatchPayload(patch);
      assert.equal(patch.projectId, fixture.projectId);
      assert.equal(patch.activeProjectId, fixture.projectId);
      assert.ok(patch.state, 'patch should include current runtime state');
      assert.ok(patch.tasks.some((task) => task.id === taskId), 'patch should include task status rows');
      assert.ok(patch.events.some((event) => event.type === 'task.updated'), 'patch should include recent runtime events');
    } finally {
      fixture.cleanup();
    }
  });

  it('emits task lifecycle refreshes on the patch channel with the same bounded payload shape', async () => {
    const fixture = await createRetryFixture('runtime-patch-event');
    try {
      const planId = insertPlan(fixture);
      const taskId = insertPlanTask(fixture, planId, { status: 'running' });
      insertHeavySnapshotRows(fixture);
      fixture.loop.flushPendingUpdates();
      const patches = [];
      const fullUpdates = [];
      fixture.loop.on('patch', (patch) => patches.push(patch));
      fixture.loop.on('update', (snapshot) => fullUpdates.push(snapshot));

      fixture.loop.addTaskLifecycleEvent(fixture.projectId, 'task.updated', {
        id: taskId,
        plan_id: planId,
        task_key: 'P010',
        title: 'runtime patch task',
        status: 'running',
      });
      fixture.loop.flushPendingUpdates();

      assert.equal(fullUpdates.length, 0, 'lightweight task lifecycle event should not emit a full snapshot');
      assert.equal(patches.length, 1);
      assertLightweightPatchPayload(patches[0]);
      assert.ok(patches[0].tasks.some((task) => task.id === taskId));
      assert.ok(patches[0].events.some((event) => event.type === 'task.updated'));
    } finally {
      fixture.cleanup();
    }
  });
});

describe('LoopService scheduler lifecycle', () => {
  it('startScheduler 创建单个全局调度器，stopScheduler 幂等清理', async () => {
    const fixture = await createRetryFixture('scheduler-lifecycle');
    try {
      assert.equal(fixture.loop.scheduleTimer, null);

      fixture.loop.startScheduler();
      const timer = fixture.loop.scheduleTimer;
      assert.ok(timer, 'startScheduler 应创建定时器句柄');

      fixture.loop.startScheduler();
      assert.equal(fixture.loop.scheduleTimer, timer, '重复 startScheduler 不应创建第二个定时器');

      fixture.loop.stopScheduler();
      assert.equal(fixture.loop.scheduleTimer, null, 'stopScheduler 应清理定时器句柄');

      fixture.loop.stopScheduler();
      assert.equal(fixture.loop.scheduleTimer, null, '重复 stopScheduler 应保持空状态');
    } finally {
      fixture.loop.stopScheduler();
      fixture.cleanup();
    }
  });
});

describe('LoopService.runScheduledScripts', () => {
  it('执行到期脚本，跳过禁用、未到期、同分钟已运行脚本，并隔离失败与非法 cron', async () => {
    const fixture = await createRetryFixture('scheduled-scripts');
    const originalRunScriptOnce = scriptHooks.runScriptOnce;
    const originalRecordRunFailure = scriptHooks.recordRunFailure;
    const runCalls = [];
    const failureCalls = [];

    scriptHooks.runScriptOnce = async (_service, script, stage, context) => {
      runCalls.push({
        id: script.id,
        name: script.name,
        stage,
        trigger: context.trigger,
        workspace: context.workspace,
      });
      if (script.name === 'due failure') throw new Error('scheduled failure');
      return { scriptId: script.id, exitCode: 0, durationMs: 0, status: 'ok', log: '' };
    };
    scriptHooks.recordRunFailure = (_service, script, stage, context, error) => {
      failureCalls.push({
        id: script.id,
        stage,
        trigger: context.trigger,
        error: error?.message || String(error),
      });
      return { scriptId: script.id, exitCode: -1, durationMs: 0, status: 'bad', log: '' };
    };

    try {
      const now = new Date();
      const nextMonth = ((now.getMonth() + 1) % 12) + 1;
      const dueOk = insertScript(fixture, { name: 'due ok', hookStage: 'task:after' });
      const dueFailure = insertScript(fixture, { name: 'due failure', hookStage: 'plan:after' });
      const dueAfterFailure = insertScript(fixture, { name: 'due after failure' });
      const disabled = insertScript(fixture, { name: 'disabled', enabled: 0 });
      const notDue = insertScript(fixture, { name: 'not due', scheduleCron: `* * * ${nextMonth} *` });
      const alreadyRan = insertScript(fixture, {
        name: 'already ran',
        lastRunAt: sameMinuteIso(now),
      });
      const invalidCron = insertScript(fixture, { name: 'invalid cron', scheduleCron: 'bad cron' });
      const emptyCron = insertScript(fixture, { name: 'empty cron', scheduleCron: '' });

      await fixture.loop.runScheduledScripts();

      assert.deepEqual(
        runCalls.map((call) => call.id).sort((a, b) => a - b),
        [dueOk, dueFailure, dueAfterFailure].sort((a, b) => a - b),
      );
      assert.equal(runCalls.every((call) => call.stage === 'schedule'), true, '定时脚本应固定使用 schedule 阶段');
      assert.equal(runCalls.every((call) => call.trigger === 'schedule'), true);
      assert.equal(runCalls.every((call) => call.workspace === fixture.workspace), true);
      assert.deepEqual(failureCalls.map((call) => call.id), [dueFailure]);
      assert.equal(failureCalls[0].error, 'scheduled failure');

      for (const skippedId of [disabled, notDue, alreadyRan, invalidCron, emptyCron]) {
        assert.equal(runCalls.some((call) => call.id === skippedId), false, `脚本 ${skippedId} 不应被执行`);
      }

      assertBadScheduleCron(fixture, invalidCron, /cron 表达式格式无效/);
      assertBadScheduleCron(fixture, emptyCron, /不能为空/);
      assert.equal(eventCount(fixture, 'script.schedule.error'), 2, '空 cron 和非法 cron 都应写入可见事件');
    } finally {
      scriptHooks.runScriptOnce = originalRunScriptOnce;
      scriptHooks.recordRunFailure = originalRecordRunFailure;
      fixture.cleanup();
    }
  });
});

describe('LoopService.runOnce plan queue scheduling', () => {
  it('keeps MCP batch creation order through start_loop, plan enqueueing, and execution', async () => {
    const fixture = await createRetryFixture('runonce-mcp-requirement-fifo');
    try {
      const intakeService = new IntakeService({
        db: fixture.db,
        loop: fixture.loop,
        attachmentsRoot: path.join(fixture.workspace, '.attachments'),
      });
      const context = { db: fixture.db, loop: fixture.loop, intakeService };
      const createdRequirementIds = [];
      for (let index = 1; index <= 3; index += 1) {
        const result = await callMcpTool(
          MCP_TOOL_NAMES.CREATE_REQUIREMENT,
          {
            projectId: fixture.projectId,
            title: `MCP 顺序需求 ${index}`,
            body: `第 ${index} 个落库并等待循环的需求`,
          },
          context,
        );
        assert.equal(result.isError, undefined);
        createdRequirementIds.push(result.structuredContent.requirementId);
      }
      assert.deepEqual(
        [...createdRequirementIds].sort((left, right) => left - right),
        createdRequirementIds,
        '连续 MCP 创建应按调用顺序取得递增需求 ID',
      );
      const sharedCreatedAt = '2026-07-11T00:00:00.000Z';
      fixture.db.run(
        `UPDATE requirements
         SET created_at = ?, updated_at = ?
         WHERE id IN (?, ?, ?)`,
        [sharedCreatedAt, sharedCreatedAt, ...createdRequirementIds],
      );

      const generatedRequirementIds = [];
      const executedRequirementIds = [];
      const generatedPlanIds = [];
      const restoreQueue = stubRunOnceQueue(fixture, {
        generatePlanForIntake: async (_projectId, _workspace, intake) => {
          generatedRequirementIds.push(intake.id);
          const planId = insertQueuedPlan(fixture, {
            issueHash: `mcp-fifo-requirement-${intake.id}`,
            sortOrder: fixture.loop.nextPlanSortOrder(fixture.projectId),
            status: 'pending',
          });
          generatedPlanIds.push(planId);
          fixture.db.run('UPDATE requirements SET linked_plan_id = ?, updated_at = ? WHERE id = ?', [
            planId,
            sharedCreatedAt,
            intake.id,
          ]);
          return planId;
        },
        processPlan: async (_workspace, plan) => {
          const requirement = fixture.db.get('SELECT id FROM requirements WHERE linked_plan_id = ?', [plan.id]);
          executedRequirementIds.push(requirement.id);
          fixture.db.run('UPDATE plans SET status = ?, validation_passed = 1, updated_at = ? WHERE id = ?', [
            'completed',
            sharedCreatedAt,
            plan.id,
          ]);
        },
      });
      const originalStart = fixture.loop.start;
      let startPromise = null;
      fixture.loop.start = (projectId) => {
        assert.equal(projectId, fixture.projectId);
        startPromise = (async () => {
          for (let cycle = 0; cycle < createdRequirementIds.length; cycle += 1) {
            await fixture.loop.runOnce(projectId);
          }
        })();
      };

      try {
        const started = await callMcpTool(MCP_TOOL_NAMES.START_LOOP, { projectId: fixture.projectId }, context);
        assert.equal(started.isError, undefined);
        assert.ok(startPromise, 'start_loop 应启动循环扫描');
        await startPromise;
      } finally {
        fixture.loop.start = originalStart;
        restoreQueue();
      }

      assert.deepEqual(generatedRequirementIds, createdRequirementIds, '同毫秒需求应按 MCP 落库 ID 顺序逐轮生成 Plan');
      assert.deepEqual(executedRequirementIds, createdRequirementIds, '执行队列应保持需求创建顺序');
      const generatedPlans = generatedPlanIds.map((planId) => fixture.db.get('SELECT sort_order FROM plans WHERE id = ?', [planId]));
      assert.deepEqual(generatedPlans.map((plan) => plan.sort_order), [1, 2, 3], '后创建需求的 Plan 应依次追加到队尾');
    } finally {
      fixture.cleanup();
    }
  });

  it('keeps a newly generated plan behind an earlier runnable plan until the earlier plan completes', async () => {
    const fixture = await createRetryFixture('runonce-generated-plan-queued');
    try {
      const previousPlanId = insertQueuedPlan(fixture, {
        issueHash: 'previous-runnable-plan',
        sortOrder: 1,
        status: 'pending',
      });
      const previousTaskId = insertPlanTask(fixture, previousPlanId, {
        taskKey: 'P001',
        title: '前序待执行任务',
        status: 'pending',
      });
      fixture.db.run('UPDATE plans SET total_tasks = 1 WHERE id = ?', [previousPlanId]);
      const requirementId = insertOpenRequirement(fixture, '生成新计划时仍应先执行前序计划');
      const processedPlanIds = [];
      let generatedPlanId = null;
      const restore = stubRunOnceQueue(fixture, {
        generatePlanForIntake: async (_projectId, _workspace, intake) => {
          assert.equal(intake.id, requirementId);
          generatedPlanId = insertQueuedPlan(fixture, {
            issueHash: 'newly-generated-plan',
            sortOrder: 2,
            status: 'pending',
          });
          fixture.db.run('UPDATE requirements SET linked_plan_id = ?, updated_at = ? WHERE id = ?', [
            generatedPlanId,
            nowIso(),
            requirementId,
          ]);
          return generatedPlanId;
        },
        processPlan: async (_workspace, plan) => {
          processedPlanIds.push(plan.id);
          if (plan.id === previousPlanId) {
            const task = fixture.db.get('SELECT status FROM plan_tasks WHERE id = ?', [previousTaskId]);
            assert.equal(task.status, 'pending', '前序 Plan 尚有待执行任务时必须保持队首');
            fixture.db.run('UPDATE plan_tasks SET status = ?, finished_at = ?, updated_at = ? WHERE id = ?', [
              'completed',
              nowIso(),
              nowIso(),
              previousTaskId,
            ]);
            fixture.db.run(
              'UPDATE plans SET status = ?, completed_tasks = 1, validation_passed = 1, updated_at = ? WHERE id = ?',
              ['completed', nowIso(), previousPlanId],
            );
          }
        },
      });

      try {
        await fixture.loop.runOnce(fixture.projectId);
        assert.deepEqual(processedPlanIds, [previousPlanId], '前序 Plan 未完成前，新生成 Plan 只能在队尾等待');
        await fixture.loop.runOnce(fixture.projectId);
      } finally {
        restore();
      }

      assert.ok(generatedPlanId, 'runOnce 应先生成新 plan 并入队');
      assert.deepEqual(processedPlanIds, [previousPlanId, generatedPlanId], '前序 Plan 完成后才应推进后序 Plan');
    } finally {
      fixture.cleanup();
    }
  });

  it('selects eligible requirements by created_at and id without changing the queue head on repeated scans', async () => {
    const fixture = await createRetryFixture('runonce-requirement-fifo');
    try {
      const linkedPlanId = insertQueuedPlan(fixture, {
        issueHash: 'already-linked-plan',
        sortOrder: 1,
        status: 'completed',
      });
      const directLinkedId = insertRequirement(fixture, {
        title: '已有 linked_plan_id',
        createdAt: '2026-07-11T00:00:00.000Z',
        linkedPlanId,
      });
      const linkedByTableId = insertRequirement(fixture, {
        title: '已有 intake_plan_links',
        createdAt: '2026-07-11T00:00:00.100Z',
      });
      insertIntakePlanLink(fixture, linkedByTableId, linkedPlanId);
      const completedId = insertRequirement(fixture, {
        title: '已完成需求',
        status: 'completed',
        createdAt: '2026-07-11T00:00:00.200Z',
      });
      const closedId = insertRequirement(fixture, {
        title: '已关闭需求',
        status: 'closed',
        createdAt: '2026-07-11T00:00:00.300Z',
      });
      const backedOffId = insertRequirement(fixture, {
        title: '生成失败退避需求',
        createdAt: '2026-07-11T00:00:00.400Z',
        generateFailCount: 3,
        lastGenerateFailAt: nowIso(),
      });

      const laterId = insertRequirement(fixture, {
        title: '较晚创建需求',
        createdAt: '2026-07-11T00:00:02.000Z',
      });
      const sameTimestampFirstId = insertRequirement(fixture, {
        title: '同毫秒需求一',
        createdAt: '2026-07-11T00:00:01.000Z',
      });
      const sameTimestampSecondId = insertRequirement(fixture, {
        title: '同毫秒需求二',
        createdAt: '2026-07-11T00:00:01.000Z',
      });
      const expectedRequirementIds = [sameTimestampFirstId, sameTimestampSecondId, laterId];
      const generatedRequirementIds = [];
      const generatedPlanIds = [];
      const restore = stubRunOnceQueue(fixture, {
        generatePlanForIntake: async (_projectId, _workspace, intake) => {
          generatedRequirementIds.push(intake.id);
          const planId = insertQueuedPlan(fixture, {
            issueHash: `fifo-requirement-${intake.id}`,
            sortOrder: fixture.loop.nextPlanSortOrder(fixture.projectId),
            status: 'pending',
          });
          generatedPlanIds.push(planId);
          fixture.db.run('UPDATE requirements SET linked_plan_id = ?, updated_at = ? WHERE id = ?', [
            planId,
            nowIso(),
            intake.id,
          ]);
          return planId;
        },
        processPlan: async (_workspace, plan) => {
          fixture.db.run('UPDATE plans SET status = ?, validation_passed = 1, updated_at = ? WHERE id = ?', [
            'completed',
            nowIso(),
            plan.id,
          ]);
        },
      });

      try {
        for (let cycle = 0; cycle < expectedRequirementIds.length + 1; cycle += 1) {
          await fixture.loop.runOnce(fixture.projectId);
        }
      } finally {
        restore();
      }

      assert.deepEqual(generatedRequirementIds, expectedRequirementIds, '可处理需求应按 created_at ASC, id ASC 逐轮生成');
      const generatedPlans = generatedPlanIds.map((planId) => fixture.db.get('SELECT * FROM plans WHERE id = ?', [planId]));
      assert.deepEqual(generatedPlans.map((plan) => plan.sort_order), [2, 3, 4], '后生成 Plan 应持续追加到现有队尾');
      assert.equal(new Set(generatedPlanIds).size, expectedRequirementIds.length, '重复扫描不得为同一需求重复生成 Plan');
      const excludedIds = [directLinkedId, linkedByTableId, completedId, closedId, backedOffId];
      assert.equal(excludedIds.some((id) => generatedRequirementIds.includes(id)), false, '既有过滤条件不得因 FIFO 排序而失效');
    } finally {
      fixture.cleanup();
    }
  });

  it('runs a newly generated non-draft plan in the same cycle when no earlier runnable plan exists', async () => {
    const fixture = await createRetryFixture('runonce-generated-plan-empty-queue');
    try {
      const requirementId = insertOpenRequirement(fixture, '空队列时新生成计划可同轮执行');
      const processedPlanIds = [];
      let generatedPlanId = null;
      const restore = stubRunOnceQueue(fixture, {
        generatePlanForIntake: async (_projectId, _workspace, intake) => {
          assert.equal(intake.id, requirementId);
          generatedPlanId = insertQueuedPlan(fixture, {
            issueHash: 'generated-empty-queue',
            sortOrder: 1,
            status: 'pending',
          });
          fixture.db.run('UPDATE requirements SET linked_plan_id = ?, updated_at = ? WHERE id = ?', [
            generatedPlanId,
            nowIso(),
            requirementId,
          ]);
          return generatedPlanId;
        },
        processPlan: async (_workspace, plan) => {
          processedPlanIds.push(plan.id);
        },
      });

      try {
        await fixture.loop.runOnce(fixture.projectId);
      } finally {
        restore();
      }

      assert.ok(generatedPlanId, 'runOnce 应生成新 plan');
      assert.deepEqual(processedPlanIds, [generatedPlanId], '无前序可运行 plan 时新生成非 draft plan 应可同轮执行');
    } finally {
      fixture.cleanup();
    }
  });

  it('does not auto-run a newly generated draft plan', async () => {
    const fixture = await createRetryFixture('runonce-generated-draft-waits');
    try {
      const requirementId = insertOpenRequirement(fixture, 'draft 计划等待显式执行');
      const processedPlanIds = [];
      let generatedPlanId = null;
      const restore = stubRunOnceQueue(fixture, {
        generatePlanForIntake: async (_projectId, _workspace, intake) => {
          assert.equal(intake.id, requirementId);
          generatedPlanId = insertQueuedPlan(fixture, {
            issueHash: 'generated-draft-plan',
            sortOrder: 1,
            status: 'draft',
          });
          fixture.db.run('UPDATE requirements SET linked_plan_id = ?, updated_at = ? WHERE id = ?', [
            generatedPlanId,
            nowIso(),
            requirementId,
          ]);
          return generatedPlanId;
        },
        processPlan: async (_workspace, plan) => {
          processedPlanIds.push(plan.id);
        },
      });

      try {
        await fixture.loop.runOnce(fixture.projectId);
      } finally {
        restore();
      }

      assert.ok(generatedPlanId, 'runOnce 应生成 draft plan');
      assert.deepEqual(processedPlanIds, [], 'draft plan 不应被自动调度执行');
    } finally {
      fixture.cleanup();
    }
  });
});

async function createRetryFixture(name) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `autoplan-loop-retry-${name}-`));
  const workspace = path.join(tempRoot, 'workspace');
  const db = new AppDatabase(path.join(tempRoot, 'autoplan.sqlite'));
  await db.init();
  const loop = new LoopService(db);
  const projectId = loop.defaultProjectId();
  loop.configure(projectId, { workspacePath: workspace, intervalSeconds: 5, validationCommand: '' });
  loop.ensureWorkspaceDirs(workspace);
  return {
    db,
    loop,
    projectId,
    workspace,
    cleanup() {
      loop.flushPendingUpdates();
      fs.rmSync(tempRoot, { recursive: true, force: true });
    },
  };
}

function insertOpenRequirement(fixture, body) {
  return insertRequirement(fixture, { body });
}

function insertRequirement(fixture, options = {}) {
  const createdAt = options.createdAt || nowIso();
  const updatedAt = options.updatedAt || createdAt;
  return fixture.db.insert(
    `INSERT INTO requirements
       (project_id, title, body, status, linked_plan_id, generate_fail_count,
        last_generate_fail_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      fixture.projectId,
      options.title || '队列调度需求',
      options.body || '队列调度回归',
      options.status || 'open',
      options.linkedPlanId || null,
      Number(options.generateFailCount || 0),
      options.lastGenerateFailAt || null,
      createdAt,
      updatedAt,
    ],
  );
}

function insertIntakePlanLink(fixture, requirementId, planId) {
  const now = nowIso();
  return fixture.db.insert(
    `INSERT INTO intake_plan_links
       (project_id, intake_type, intake_id, plan_id, phase_index, phase_title, created_at, updated_at)
     VALUES (?, 'requirement', ?, ?, 1, '', ?, ?)`,
    [fixture.projectId, requirementId, planId, now, now],
  );
}

function insertQueuedPlan(fixture, options = {}) {
  const now = nowIso();
  const issueHash = options.issueHash || `queued-plan-${Date.now()}`;
  const planRel = path.join('docs', 'plan', `${issueHash}.md`);
  const planFile = path.join(fixture.workspace, planRel);
  fs.mkdirSync(path.dirname(planFile), { recursive: true });
  fs.writeFileSync(
    planFile,
    [
      `# ${issueHash}`,
      '',
      '- [ ] P001: 队列调度任务 <!-- scope: src/loopService.js -->',
      '',
    ].join('\n'),
    'utf8',
  );
  return fixture.db.insert(
    `INSERT INTO plans
       (project_id, issue_hash, file_path, hash, status, sort_order, total_tasks, completed_tasks, validation_passed, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      fixture.projectId,
      issueHash,
      planRel,
      `${issueHash}-hash`,
      options.status || 'pending',
      Number(options.sortOrder || 1),
      0,
      0,
      0,
      now,
      now,
    ],
  );
}

function stubRunOnceQueue(fixture, overrides = {}) {
  const originalGeneratePlanForIntake = fixture.loop.generatePlanForIntake;
  const originalProcessPlan = fixture.loop.processPlan;
  const originalScanDirectoryInWorker = fixture.loop.scanDirectoryInWorker;
  fixture.loop.generatePlanForIntake = overrides.generatePlanForIntake;
  fixture.loop.processPlan = overrides.processPlan;
  fixture.loop.scanDirectoryInWorker = async () => ({
    root: path.join(fixture.workspace, 'docs', 'plan'),
    aggregateHash: '',
    files: [],
  });
  return () => {
    fixture.loop.generatePlanForIntake = originalGeneratePlanForIntake;
    fixture.loop.processPlan = originalProcessPlan;
    fixture.loop.scanDirectoryInWorker = originalScanDirectoryInWorker;
  };
}
function insertScript(fixture, overrides = {}) {
  const timestamp = nowIso();
  return fixture.db.insert(
    `INSERT INTO scripts
       (project_id, name, runtime, body, trigger_mode, hook_stage, schedule_cron, enabled,
        timeout_seconds, context_inject, sort_order, source_type, last_run_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      fixture.projectId,
      overrides.name || 'scheduled script',
      overrides.runtime || 'node',
      overrides.body || 'console.log("ok")',
      overrides.triggerMode || 'schedule',
      overrides.hookStage ?? null,
      Object.prototype.hasOwnProperty.call(overrides, 'scheduleCron') ? overrides.scheduleCron : '* * * * *',
      overrides.enabled ?? 1,
      overrides.timeoutSeconds || 60,
      overrides.contextInject || 'none',
      overrides.sortOrder || 0,
      overrides.sourceType || 'inline',
      overrides.lastRunAt || null,
      timestamp,
      timestamp,
    ],
  );
}

function sameMinuteIso(date) {
  const value = date instanceof Date ? new Date(date) : new Date();
  value.setSeconds(1, 0);
  return value.toISOString();
}

function assertBadScheduleCron(fixture, scriptId, messagePattern) {
  const row = fixture.db.get('SELECT * FROM scripts WHERE id = ?', [scriptId]);
  assert.equal(row.last_status, 'bad');
  assert.equal(row.last_exit_code, -1);
  assert.equal(row.last_duration_ms, 0);
  assert.match(row.last_log, messagePattern);
  assert.ok(row.last_run_at, '非法定时表达式应更新 last_run_at 用于同分钟去重');
}

function stubRunOnce(loop) {
  const calls = [];
  loop.runOnce = async (projectId) => {
    calls.push(projectId);
  };
  return calls;
}

function insertFailedRequirement(fixture, options = {}) {
  const now = nowIso();
  return fixture.db.insert(
    `INSERT INTO requirements
       (project_id, title, body, status, agent_cli_provider, agent_cli_command, codex_reasoning_effort,
        generate_fail_count, last_generate_fail_at, last_generate_error, last_generate_log_file,
        last_generate_agent_cli_provider, last_generate_codex_reasoning_effort, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      fixture.projectId,
      '失败需求',
      '用于手动重试生成计划的需求',
      'open',
      options.agentCliProvider ?? 'codex',
      options.agentCliCommand ?? '',
      options.codexReasoningEffort ?? 'medium',
      3,
      now,
      '旧失败原因',
      '/tmp/old-requirement.log',
      options.agentCliProvider ?? 'codex',
      options.codexReasoningEffort ?? 'medium',
      now,
      now,
    ],
  );
}

function insertFailedFeedback(fixture, options = {}) {
  const now = nowIso();
  return fixture.db.insert(
    `INSERT INTO feedback
       (project_id, requirement_id, title, body, status, agent_cli_provider, agent_cli_command, codex_reasoning_effort,
        generate_fail_count, last_generate_fail_at, last_generate_error, last_generate_log_file,
        last_generate_agent_cli_provider, last_generate_codex_reasoning_effort, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      fixture.projectId,
      null,
      '失败反馈',
      '用于手动重试生成计划的反馈',
      'open',
      options.agentCliProvider ?? 'codex',
      options.agentCliCommand ?? '',
      options.codexReasoningEffort ?? 'medium',
      4,
      now,
      '旧反馈失败原因',
      '/tmp/old-feedback.log',
      options.agentCliProvider ?? 'codex',
      options.codexReasoningEffort ?? 'medium',
      now,
      now,
    ],
  );
}

function insertPlan(fixture) {
  const now = nowIso();
  return fixture.db.insert(
    `INSERT INTO plans
       (project_id, issue_hash, file_path, hash, status, sort_order, total_tasks, completed_tasks, validation_passed, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [fixture.projectId, 'retry-bound-plan', 'docs/plan/retry-bound.md', 'hash', 'pending', 1, 0, 0, 0, now, now],
  );
}

function insertPlanTask(fixture, planId, overrides = {}) {
  const now = nowIso();
  return fixture.db.insert(
    `INSERT INTO plan_tasks
       (plan_id, task_key, title, raw_line, scope, status, sort_order, started_at, finished_at, duration_ms, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      planId,
      overrides.taskKey || 'P010',
      overrides.title || 'runtime patch task',
      '- [ ] P010 runtime patch task <!-- scope: src/loopService.test.js -->',
      'src/loopService.test.js',
      overrides.status || 'pending',
      overrides.sortOrder || 1,
      overrides.startedAt || now,
      overrides.finishedAt || null,
      overrides.durationMs || 0,
      now,
    ],
  );
}

function insertHeavySnapshotRows(fixture) {
  const now = nowIso();
  const requirementId = fixture.db.insert(
    `INSERT INTO requirements (project_id, title, body, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [fixture.projectId, 'heavy requirement', 'heavy body', 'open', now, now],
  );
  const feedbackId = fixture.db.insert(
    `INSERT INTO feedback (project_id, requirement_id, title, body, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [fixture.projectId, requirementId, 'heavy feedback', 'heavy feedback body', 'open', now, now],
  );
  fixture.db.run(
    `INSERT INTO attachments (project_id, owner_type, owner_id, original_name, stored_path, size, hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [fixture.projectId, 'requirement', requirementId, 'heavy.txt', 'uploads/heavy.txt', 1, 'hash-heavy', now],
  );
  fixture.db.run(
    `INSERT INTO scan_files (project_id, scan_type, file_path, hash, size, modified_at, scanned_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [fixture.projectId, 'plan', 'docs/plan/heavy.md', 'scan-hash', 1, now, now],
  );
  return { requirementId, feedbackId };
}

function assertLightweightPatchPayload(patch) {
  const allowedKeys = new Set([
    'projectId',
    'activeProjectId',
    'state',
    'tasks',
    'events',
    'activeOperation',
    'activeOperations',
    'lastOperation',
  ]);
  assert.deepEqual(
    Object.keys(patch).filter((key) => !allowedKeys.has(key)),
    [],
    'runtime patch should only contain lightweight runtime fields',
  );
  for (const heavyKey of ['requirements', 'feedback', 'attachments', 'scans', 'scanSummary', 'plans', 'scripts', 'executors', 'terminals']) {
    assert.equal(Object.prototype.hasOwnProperty.call(patch, heavyKey), false, `patch should not include ${heavyKey}`);
  }
}

function assertClearedFailureState(row) {
  assert.equal(row.generate_fail_count, 0);
  assert.equal(row.last_generate_fail_at, null);
  assert.equal(row.last_generate_error, null);
  assert.equal(row.last_generate_log_file, null);
  assert.equal(row.last_generate_agent_cli_provider, null);
  assert.equal(row.last_generate_codex_reasoning_effort, null);
}

function latestRetryEventMeta(fixture, type) {
  const event = fixture.db.get('SELECT * FROM events WHERE project_id = ? AND type = ? ORDER BY id DESC LIMIT 1', [
    fixture.projectId,
    type,
  ]);
  assert.ok(event, `应记录 ${type} 事件`);
  return JSON.parse(event.meta || '{}');
}

function eventCount(fixture, type) {
  return fixture.db.get('SELECT COUNT(*) AS count FROM events WHERE project_id = ? AND type = ?', [
    fixture.projectId,
    type,
  ]).count;
}
