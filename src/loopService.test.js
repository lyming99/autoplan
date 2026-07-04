const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { AppDatabase, nowIso } = require('./database');
const { LoopService } = require('./loopService');

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
