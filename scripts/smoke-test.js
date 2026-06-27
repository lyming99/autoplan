const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { saveAttachments } = require('../src/attachments');
const { AppDatabase, nowIso } = require('../src/database');
const { createIntakeService } = require('../src/intakeService');
const { LoopService } = require('../src/loopService');
const { MCP_TOOL_NAMES, callMcpTool } = require('../src/mcpTools');

async function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autoplan-smoke-'));
  const dbPath = path.join(tempRoot, 'data', 'autoplan.sqlite');
  const workspace = path.join(tempRoot, 'workspace');
  const otherWorkspace = path.join(tempRoot, 'other-workspace');

  try {
    const db = new AppDatabase(dbPath);
    await db.init();
    const defaultState = db.get('SELECT project_id FROM project_states ORDER BY project_id ASC LIMIT 1');
    db.run('UPDATE project_states SET running = 1, phase = ?, updated_at = ? WHERE project_id = ?', [
      'execute-task',
      nowIso(),
      defaultState.project_id,
    ]);
    const loop = new LoopService(db);
    const projectId = loop.defaultProjectId();
    const otherProjectId = insertProject(db, loop, 'Other Project', otherWorkspace);

    assert.ok(projectId, '启动后应存在默认项目');
    assert.equal(loop.snapshot(projectId).state.running, 0, '重启后不应继承旧的 running 状态');
    assert.equal(loop.snapshot(projectId).state.phase, 'stopped', '重启后执行中阶段应复位为 stopped');
    db.run('UPDATE project_states SET running = 1, phase = ?, updated_at = ? WHERE project_id = ?', [
      'execute-task',
      nowIso(),
      projectId,
    ]);
    assert.equal(loop.snapshot(projectId).state.running, 0, '快照不应盲信 SQLite 残留 running 状态');
    assert.equal(loop.snapshot(projectId).state.phase, 'stopped', '空闲时快照不应显示残留执行阶段');
    assert.equal(loop.snapshot().activeProjectId, null, '未选择项目时快照应停留在项目列表');
    assert.ok(loop.snapshot().projects.length >= 2, '项目列表应包含默认项目和新增项目');

    const requirementId = insertRequirement(db, projectId);
    insertFeedback(db, projectId);
    insertRequirement(db, otherProjectId);

    const imageFile = path.join(tempRoot, 'smoke.png');
    fs.writeFileSync(
      imageFile,
      Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lZl0WQAAAABJRU5ErkJggg==', 'base64'),
    );
    saveAttachments(db, path.join(tempRoot, 'attachments'), 'requirement', requirementId, [
      { path: imageFile, name: 'smoke.png', type: 'image/png' },
    ], projectId);

    let snapshot = loop.snapshot(projectId);
    assert.equal(snapshot.requirements.length, 1, '当前项目只应显示自己的需求');
    assert.equal(loop.snapshot(otherProjectId).requirements.length, 1, '另一个项目应保留独立需求');
    assert.equal(snapshot.feedback.length, 1, '反馈模块应按项目读取列表');
    assert.match(snapshot.requirements[0].body, /普通文本验收/, '需求正文应保留普通文本内容');
    assert.equal(snapshot.attachments.length, 1, '附件应写入 SQLite 并绑定项目');
    assert.equal(snapshot.attachments[0].project_id, projectId, '附件应记录 project_id');
    assert.equal(snapshot.attachments[0].mime_type, 'image/png', '图片附件应保留 MIME 类型');
    assert.ok(fs.existsSync(snapshot.attachments[0].stored_path), '附件文件应复制到持久化目录');
    await assertAttachmentPersistenceSmoke(db, loop, tempRoot);
    await assertLoopConfigPersistenceSmoke(db, loop, tempRoot);
    await assertMcpToolsSmoke(db, loop, tempRoot);

    loop.configure(projectId, {
      workspacePath: workspace,
      intervalSeconds: 5,
      validationCommand: 'node -e "process.exit(0)"',
    });
    snapshot = loop.snapshot(projectId);
    assert.equal(snapshot.state.workspace_path, workspace, '项目应能保存工作区路径');
    assert.equal(snapshot.state.interval_seconds, 5, '项目应能保存循环间隔');

    loop.ensureWorkspaceDirs(workspace);
    const issueFile = path.join(workspace, 'docs', 'issues', 'smoke.md');
    fs.writeFileSync(issueFile, '# Smoke 需求\n\n- [ ] 支持普通文本输入和附件\n', 'utf8');
    const issueScan = loop.scanDirectory(path.join(workspace, 'docs', 'issues'), workspace, ['.md']);
    loop.saveScan(projectId, 'issue', issueScan);
    assert.equal(issueScan.files.length, 1, '扫描模块应发现 docs/issues 文件');
    assert.equal(loop.snapshot(projectId).scans.length, 1, '扫描记录应按项目写入 SQLite');
    assert.equal(loop.snapshot(otherProjectId).scans.length, 0, '其它项目不应看到当前项目扫描记录');

    const planId = writeSmokePlan(db, loop, workspace, projectId);
    snapshot = loop.snapshot(projectId);
    assert.equal(snapshot.plans.length, 1, '确认后应加入当前项目任务系统');
    assert.equal(snapshot.plans[0].project_id, projectId, 'plan 应绑定项目');
    assertPlanCliSnapshot(snapshot.plans[0], {
      provider: 'codex',
      command: '',
      effort: 'medium',
    }, '历史 plan 快照');
    assert.equal(snapshot.tasks.length, 6, '任务模块应同步 plan 中的 checkbox 为任务列表');
    assert.ok(
      snapshot.tasks.every((task) => hasTaskDurationShape(task)),
      '任务快照应包含符合前端类型预期的耗时字段',
    );
    assert.equal(snapshot.plans[0].total_tasks, 6, 'plan 应记录总任务数');
    assert.ok(
      snapshot.tasks.every((task) => task.raw_line.includes('scope:')),
      '入库任务应保留固定格式 scope 注释',
    );
    assert.ok(
      snapshot.tasks.filter((task) => task.task_key !== 'P006').every((task) => task.scope === 'unknown') &&
        taskByKey(snapshot, 'P006')?.scope === 'validation',
      '普通任务 scope 应保持 unknown，最终验收任务 scope 应为 validation',
    );
    assertPlanTaskParsingRegression(db, loop, workspace, projectId);
    assert.deepEqual(
      loop.parallelTaskBatch([
        { task_key: 'P001', title: 'A', raw_line: '- [ ] P001: A <!-- scope: lib/a.dart -->' },
        { task_key: 'P002', title: 'B', raw_line: '- [ ] P002: B <!-- scope: lib/b.dart -->' },
        { task_key: 'P003', title: 'C', raw_line: '- [ ] P003: C <!-- scope: lib/a.dart -->' },
      ]).map((task) => task.task_key),
      ['P001', 'P002'],
      '互不重叠 scope 的任务应允许进入同一并发批次',
    );
    assert.deepEqual(
      loop.parallelTaskBatch([
        { task_key: 'P001', title: 'A', raw_line: '- [ ] P001: A <!-- scope: unknown -->' },
        { task_key: 'P002', title: 'B', raw_line: '- [ ] P002: B <!-- scope: lib/b.dart -->' },
      ]).map((task) => task.task_key),
      ['P001'],
      'unknown scope 任务应保持串行',
    );
    assert.deepEqual(
      loop.parallelTaskBatch([
        { task_key: 'P009', title: '补充自动化回归测试', raw_line: '- [ ] P009: 补充自动化回归测试 <!-- scope: test/a.dart -->' },
        { task_key: 'P010', title: '执行回归验证', raw_line: '- [ ] P010: 执行回归验证 <!-- scope: test/b.dart -->' },
      ]).map((task) => task.task_key),
      ['P009'],
      '测试/验证类任务应保持串行',
    );

    const plan = db.get('SELECT * FROM plans WHERE id = ?', [planId]);
    plan.agent_cli_provider = 'codex';
    plan.codex_reasoning_effort = 'xhigh';
    const planFile = path.join(workspace, plan.file_path);
    const executableTask = db.get('SELECT * FROM plan_tasks WHERE plan_id = ? AND task_key = ?', [planId, 'P001']);
    const fakeLogFile = path.join(workspace, 'docs', 'progress', 'logs', 'fake-execute.log');
    fs.writeFileSync(fakeLogFile, 'fake ok', 'utf8');
    const originalRunCodex = loop.runCodex.bind(loop);
    const originalPlanText = fs.readFileSync(planFile, 'utf8');
    await assertPlanReadRegression(db, loop, {
      projectId,
      otherProjectId,
      otherWorkspace,
      planId,
      plan,
      planFile,
      originalPlanText,
    });
    loop.runCodex = async (_workspace, prompt, _label, operation = {}) => {
      assert.equal(operation.codexReasoningEffort, 'xhigh', '任务执行应保留 plan 级 xhigh 思考深度');
      assert.match(prompt, /只执行指定任务 P001/, '执行 prompt 应锁定指定任务');
      assert.match(prompt, /不要修改 plan 文件/, '执行 prompt 应禁止 Codex 写 plan');
      assert.match(prompt, /不运行测试、回归、验收、构建/, '执行 prompt 应把测试和验收推迟到最终节点');
      await sleep(20);
      const runningTask = db.get('SELECT * FROM plan_tasks WHERE id = ?', [executableTask.id]);
      assert.equal(runningTask.status, 'running', '任务开始后应写入 running 状态');
      assertIsoString(runningTask.started_at, '任务开始后应写入 started_at');
      assert.equal(runningTask.finished_at, null, '任务运行中不应写入 finished_at');
      assert.equal(runningTask.duration_ms, 0, '首次运行中累计耗时应保持 0');
      const runningSnapshotTask = taskByKey(loop.snapshot(projectId), 'P001');
      assertTaskDurationShape(runningSnapshotTask, '运行中任务快照');
      assert.equal(typeof runningSnapshotTask.run_duration_ms, 'number', '运行中任务快照应包含实时耗时');
      fs.writeFileSync(planFile, originalPlanText.replace('P002', 'P999'), 'utf8');
      return { exitCode: 0, logFile: fakeLogFile, lastFile: path.join(workspace, 'fake-last.txt') };
    };
    const executeResult = await loop.executeTask(workspace, plan, executableTask);
    loop.runCodex = originalRunCodex;
    assert.equal(executeResult.exitCode, 0, '模拟执行应成功');
    loop.completeTask(workspace, plan, executableTask, executeResult);
    const guardedPlanText = fs.readFileSync(planFile, 'utf8');
    assert.match(guardedPlanText, /- \[x\] P001:/, '系统应在任务成功后勾选 checkbox');
    assert.match(guardedPlanText, /P001 AutoPlan 完成/, '系统应在进度区写入完成记录');
    assert.doesNotMatch(guardedPlanText, /P999/, 'Codex 对 plan 的写入应被恢复');
    const completedTask = db.get('SELECT * FROM plan_tasks WHERE id = ?', [executableTask.id]);
    assert.equal(
      completedTask.status,
      'completed',
      '系统应更新任务入库状态',
    );
    assertIsoString(completedTask.started_at, '任务完成后应保留 started_at');
    assertIsoString(completedTask.finished_at, '任务完成后应写入 finished_at');
    assert.ok(completedTask.duration_ms > 0, '任务完成后应写入正数 duration_ms');
    const completedSnapshotTask = taskByKey(loop.snapshot(projectId), 'P001');
    assertTaskDurationShape(completedSnapshotTask, '已完成任务快照');
    assert.ok(completedSnapshotTask.duration_ms > 0, '已完成任务快照应包含累计耗时');
    const completedTaskEvents = taskEventsByKey(loop.snapshot(projectId), 'P001');
    assertTaskEventOrder(completedTaskEvents, ['task.succeeded', 'task.started'], '成功任务事件');
    assertTaskEventMeta(completedTaskEvents[0], executableTask, 'completed', '成功结束任务事件');
    assert.equal(completedTaskEvents[0].meta.log, fakeLogFile, '成功结束事件 meta 应包含日志路径');
    assert.equal(completedTaskEvents[0].meta.exitCode, 0, '成功结束事件 meta 应包含退出码');
    assertTaskEventMeta(completedTaskEvents[1], executableTask, 'running', '开始任务事件');
    assert.equal(
      db.get('SELECT completed_tasks FROM plans WHERE id = ?', [planId]).completed_tasks,
      1,
      '系统应更新 plan 完成计数',
    );

    const retryTask = db.get('SELECT * FROM plan_tasks WHERE plan_id = ? AND task_key = ?', [planId, 'P002']);
    loop.runCodex = async (_workspace, prompt) => {
      assert.match(prompt, /只执行指定任务 P002/, '重试任务首次执行 prompt 应锁定指定任务');
      await sleep(20);
      const runningRetryTask = db.get('SELECT * FROM plan_tasks WHERE id = ?', [retryTask.id]);
      assert.equal(runningRetryTask.status, 'running', '失败前任务应处于 running 状态');
      assertIsoString(runningRetryTask.started_at, '失败前任务应写入 started_at');
      assert.equal(runningRetryTask.finished_at, null, '失败前任务运行中不应写入 finished_at');
      assertTaskDurationShape(taskByKey(loop.snapshot(projectId), 'P002'), '失败前任务快照');
      return {
        exitCode: 1,
        logFile: fakeLogFile,
        lastFile: path.join(workspace, 'fake-failed.txt'),
        output: 'PathAccessException: Permission denied while reading .dart_tool',
        errorMessage: 'PathAccessException: Permission denied while reading .dart_tool',
      };
    };
    const failedResult = await loop.executeTask(workspace, plan, retryTask);
    loop.runCodex = originalRunCodex;
    assert.equal(failedResult.exitCode, 1, '模拟失败应返回非 0 exitCode');
    const failedTask = db.get('SELECT * FROM plan_tasks WHERE id = ?', [retryTask.id]);
    assert.equal(failedTask.status, 'pending', '任务失败后应回退为 pending');
    assertIsoString(failedTask.started_at, '任务失败后应保留 started_at');
    assertIsoString(failedTask.finished_at, '任务失败后应写入 finished_at');
    assert.ok(failedTask.duration_ms > 0, '任务失败后应累计正数 duration_ms');
    const failedTaskEvents = taskEventsByKey(loop.snapshot(projectId), 'P002');
    assertTaskEventOrder(failedTaskEvents, ['task.failed', 'task.started'], '失败任务事件');
    assertTaskEventMeta(failedTaskEvents[0], retryTask, 'failed', '失败任务事件');
    assert.equal(failedTaskEvents[0].meta.log, fakeLogFile, '失败事件 meta 应包含日志路径');
    assert.equal(failedTaskEvents[0].meta.exitCode, 1, '失败事件 meta 应包含退出码');
    assert.equal(failedTaskEvents[0].meta.failureKind, 'environment_permission', 'failed task event should classify permission blockers');
    assert.equal(failedTaskEvents[0].meta.environmentBlocked, true, 'failed task event should mark environment blockers');
    assertTaskEventMeta(failedTaskEvents[1], retryTask, 'running', '失败前开始任务事件');

    const firstAttemptDurationMs = failedTask.duration_ms;
    const retryAttemptTask = db.get('SELECT * FROM plan_tasks WHERE id = ?', [retryTask.id]);
    loop.runCodex = async (_workspace, prompt) => {
      assert.match(prompt, /只执行指定任务 P002/, '重试任务再次执行 prompt 应锁定指定任务');
      await sleep(20);
      const runningRetryTask = db.get('SELECT * FROM plan_tasks WHERE id = ?', [retryTask.id]);
      assert.equal(runningRetryTask.status, 'running', '重试时任务应重新进入 running 状态');
      assertIsoString(runningRetryTask.started_at, '重试时任务应刷新 started_at');
      assert.equal(runningRetryTask.finished_at, null, '重试运行中应清空 finished_at');
      assert.equal(runningRetryTask.duration_ms, firstAttemptDurationMs, '重试运行中不应丢失历史累计耗时');
      return { exitCode: 0, logFile: fakeLogFile, lastFile: path.join(workspace, 'fake-retry.txt') };
    };
    const retryResult = await loop.executeTask(workspace, plan, retryAttemptTask);
    loop.runCodex = originalRunCodex;
    assert.equal(retryResult.exitCode, 0, '模拟重试应成功');
    loop.completeTask(workspace, plan, retryAttemptTask, retryResult);
    const retriedTask = db.get('SELECT * FROM plan_tasks WHERE id = ?', [retryTask.id]);
    assert.equal(retriedTask.status, 'completed', '重试成功后任务应完成');
    assertIsoString(retriedTask.finished_at, '重试成功后应写入 finished_at');
    assert.ok(retriedTask.duration_ms > firstAttemptDurationMs, '重试成功后应继续累加 duration_ms');
    assertTaskDurationShape(taskByKey(loop.snapshot(projectId), 'P002'), '重试完成任务快照');

    const stoppableTask = db.get('SELECT * FROM plan_tasks WHERE plan_id = ? AND task_key = ?', [planId, 'P003']);
    loop.startTaskRun(stoppableTask.id, nowIso());
    await sleep(20);
    loop.stopTask(projectId, stoppableTask.id);
    const stoppedTask = db.get('SELECT * FROM plan_tasks WHERE id = ?', [stoppableTask.id]);
    assert.equal(stoppedTask.status, 'pending', '手动停止后任务应回到 pending 以便重试');
    assertIsoString(stoppedTask.finished_at, '手动停止后应写入 finished_at');
    assert.ok(stoppedTask.duration_ms > 0, '手动停止后应累计耗时');
    const stoppedTaskEvents = taskEventsByKey(loop.snapshot(projectId), 'P003');
    assertTaskEventOrder(stoppedTaskEvents, ['task.stop.requested'], '手动停止任务事件');
    assertTaskEventMeta(stoppedTaskEvents[0], stoppableTask, 'stopping', '手动停止任务事件');

    const stoppedDurationMs = stoppedTask.duration_ms;
    const retryStoppedTask = db.get('SELECT * FROM plan_tasks WHERE id = ?', [stoppableTask.id]);
    loop.runCodex = async (_workspace, prompt) => {
      assert.match(prompt, /只执行指定任务 P003/, '停止后重试任务 prompt 应锁定指定任务');
      await sleep(20);
      const runningStoppedRetryTask = db.get('SELECT * FROM plan_tasks WHERE id = ?', [stoppableTask.id]);
      assert.equal(runningStoppedRetryTask.status, 'running', '停止后重试应重新进入 running 状态');
      assert.equal(runningStoppedRetryTask.duration_ms, stoppedDurationMs, '停止后重试不应丢失停止前耗时');
      return { exitCode: 0, logFile: fakeLogFile, lastFile: path.join(workspace, 'fake-stopped-retry.txt') };
    };
    const stoppedRetryResult = await loop.executeTask(workspace, plan, retryStoppedTask);
    loop.runCodex = originalRunCodex;
    assert.equal(stoppedRetryResult.exitCode, 0, '手动停止后的重试应成功');
    loop.completeTask(workspace, plan, retryStoppedTask, stoppedRetryResult);
    const stoppedRetriedTask = db.get('SELECT * FROM plan_tasks WHERE id = ?', [stoppableTask.id]);
    assert.equal(stoppedRetriedTask.status, 'completed', '手动停止后任务应可重试完成');
    assert.ok(stoppedRetriedTask.duration_ms > stoppedDurationMs, '手动停止后重试应继续累加耗时');
    assertTaskDurationShape(taskByKey(loop.snapshot(projectId), 'P003'), '停止后重试完成任务快照');

    fs.writeFileSync(planFile, fs.readFileSync(planFile, 'utf8').replaceAll('- [ ]', '- [x]'), 'utf8');
    loop.syncPlanTasks(planId, planFile);
    await loop.validatePlan(workspace, db.get('SELECT * FROM plans WHERE id = ?', [planId]));
    snapshot = loop.snapshot(projectId);
    assert.equal(snapshot.plans[0].status, 'completed', '验收通过后 plan 应标记 completed');
    assert.equal(snapshot.plans[0].validation_passed, 1, '验收通过后 validation_passed 应为 1');
    assertWorkspaceSearchRegression(snapshot);
    assertFrontendInteractionSourceSmoke();
    assertMarkdownPlanReaderSourceSmoke();
    assertEventPresentationCopyRegression();
    await assertFinalAcceptanceTaskSmoke(db, loop, workspace, projectId);

    await assertScopeConcurrencySmoke(db, loop, workspace, projectId);

    await assertWorkspaceOpenFileIpcSmoke(db, loop, workspace, projectId);

    await assertCodexSessionReuseSmoke(db, loop, projectId, workspace);

    await assertAgentCliBackendSmoke(db, loop, projectId, workspace);

    await assertFeedback10RegressionSmoke(db, loop, tempRoot);

    const multiWorkspaceA = path.join(tempRoot, 'multi-a');
    const multiWorkspaceB = path.join(tempRoot, 'multi-b');
    const multiProjectA = insertProject(db, loop, 'Multi Project A', multiWorkspaceA);
    const multiProjectB = insertProject(db, loop, 'Multi Project B', multiWorkspaceB);
    const sameWorkspaceProject = insertProject(db, loop, 'Same Workspace Project', multiWorkspaceB);
    loop.configure(multiProjectA, { workspacePath: multiWorkspaceA, intervalSeconds: 60, validationCommand: '' });
    loop.configure(multiProjectB, { workspacePath: multiWorkspaceB, intervalSeconds: 60, validationCommand: '' });
    loop.configure(sameWorkspaceProject, { workspacePath: multiWorkspaceB, intervalSeconds: 60, validationCommand: '' });

    loop.start(multiProjectA);
    loop.start(multiProjectB);
    assert.equal(loop.snapshot(multiProjectA).state.running, 1, '项目 A 循环应保持运行中');
    assert.equal(loop.snapshot(multiProjectB).state.running, 1, '项目 B 循环应保持运行中');
    assert.ok(
      loop.snapshot().projects.filter((project) => project.running).length >= 2,
      '项目列表应能显示多个运行中项目',
    );
    assert.throws(
      () => loop.start(sameWorkspaceProject),
      /工作区正在被项目/,
      '同一工作区不应被两个项目循环同时占用',
    );
    loop.stop(multiProjectA);
    assert.equal(loop.snapshot(multiProjectA).state.running, 0, '停止项目 A 后 A 应停止');
    assert.equal(loop.snapshot(multiProjectB).state.running, 1, '停止项目 A 不应影响项目 B');
    loop.stop(multiProjectB);
    assert.equal(loop.snapshot(multiProjectB).state.running, 0, '项目 B 应可独立停止');

    console.log('smoke ok: projects, scoped snapshots, attachments, attachment prompts, plan reader, markdown reader, config persistence, scope concurrency, scope file open, search, frontend interactions, task acceptance, task events, scan, validation, duration stats, codex session reuse, multi-backend, multi-loop');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function assertWorkspaceSearchRegression(snapshot) {
  const { searchWorkspaceSnapshot } = loadRendererTsModule(
    path.join(__dirname, '..', 'src', 'renderer', 'utils', 'search.ts'),
  );

  const requirementResult = assertSearchHit(
    searchWorkspaceSnapshot(snapshot, '普通文本需求'),
    'requirement',
    'title',
    /普通文本需求/,
    '搜索应支持需求标题命中',
  );
  assertSearchLocation(requirementResult, {
    anchorId: `workspace-requirement-${requirementResult.recordId}`,
    targetTab: 'requirement',
    targetType: 'requirement',
  }, '需求搜索结果应携带定位锚点');

  const feedbackResult = assertSearchHit(
    searchWorkspaceSnapshot(snapshot, '重点内容'),
    'feedback',
    'body',
    /重点内容/,
    '搜索应支持反馈正文命中',
  );
  assertSearchLocation(feedbackResult, {
    anchorId: `workspace-feedback-${feedbackResult.recordId}`,
    targetTab: 'feedback',
    targetType: 'feedback',
  }, '反馈搜索结果应携带定位锚点');

  const taskResult = assertSearchHit(
    searchWorkspaceSnapshot(snapshot, 'P002'),
    'task',
    'taskKey',
    /P002/,
    '搜索应支持任务 key 命中',
  );
  assertSearchLocation(taskResult, {
    anchorId: `workspace-task-${taskResult.recordId}`,
    targetTab: 'tasks',
    targetType: 'task',
  }, '任务搜索结果应携带任务定位锚点');
  assert.equal(taskResult.taskId, taskResult.recordId, '任务搜索结果应携带 taskId');
  assert.equal(taskResult.taskKey, 'P002', '任务搜索结果应携带 taskKey');
  assert.ok(taskResult.planId, '任务搜索结果应携带 planId');
  assert.match(taskResult.filePath, /smoke-plan\.md$/, '任务搜索结果应携带 Plan 文件路径');

  const taskPlanTitleResult = assertSearchHit(
    searchWorkspaceSnapshot(snapshot, 'Smoke 开发计划'),
    'task',
    'title',
    /Smoke 开发计划/,
    '搜索应支持任务所属 Plan 标题命中',
  );
  assert.equal(taskPlanTitleResult.planId, taskResult.planId, 'Plan 标题命中的任务结果应保留 planId');

  const planResult = assertSearchHit(
    searchWorkspaceSnapshot(snapshot, 'smoke-plan.md'),
    'plan',
    'filePath',
    /smoke-plan\.md/,
    '搜索应支持 Plan 文件路径命中',
  );
  assertSearchLocation(planResult, {
    anchorId: `workspace-plan-${planResult.recordId}`,
    targetTab: 'tasks',
    targetType: 'plan',
  }, 'Plan 搜索结果应携带 Plan 定位锚点');
  assert.equal(planResult.planId, planResult.recordId, 'Plan 搜索结果应携带 planId');
  assert.match(planResult.filePath, /smoke-plan\.md$/, 'Plan 搜索结果应携带文件路径');

  const eventResult = assertSearchHit(
    searchWorkspaceSnapshot(snapshot, 'fake-execute.log'),
    'event',
    'eventMeta',
    /fake-execute\.log/,
    '搜索应支持事件元信息命中',
  );
  assertSearchLocation(eventResult, {
    anchorId: `workspace-event-${eventResult.recordId}`,
    targetTab: 'events',
    targetType: 'event',
  }, '事件搜索结果应携带事件定位锚点');

  const emptySearch = searchWorkspaceSnapshot(snapshot, '没有任何匹配的搜索词');
  assert.equal(emptySearch.total, 0, '搜索无结果时 total 应为 0');
  assert.ok(emptySearch.groups.every((group) => group.count === 0), '搜索无结果时各分组计数应为 0');
}

async function assertFinalAcceptanceTaskSmoke(db, loop, workspace, projectId) {
  const planRel = path.join('docs', 'plan', 'final-acceptance-smoke.md');
  const planFile = path.join(workspace, planRel);
  fs.mkdirSync(path.dirname(planFile), { recursive: true });
  fs.writeFileSync(
    planFile,
    [
      '# Final acceptance smoke',
      '',
      '## 任务计划',
      '- [x] P001: 完成开发修改 <!-- scope: smoke/dev.js -->',
      '- [ ] P002: 完整验收 <!-- scope: validation -->',
      '',
      '## 总体验收标准',
      '- 最后节点执行完整验收命令。',
      '',
    ].join('\n'),
    'utf8',
  );
  const planId = insertPlan(db, projectId, planRel, 'final-acceptance-smoke');
  loop.syncPlanTasks(planId, planFile);
  const acceptanceTask = db.get('SELECT * FROM plan_tasks WHERE plan_id = ? AND task_key = ?', [planId, 'P002']);
  assert.equal(acceptanceTask.scope, 'validation', 'final acceptance task should use validation scope');

  const originalRunCodex = loop.runCodex.bind(loop);
  let codexCalled = false;
  try {
    loop.runCodex = async () => {
      codexCalled = true;
      return { exitCode: 1, output: 'unexpected codex execution' };
    };
    await loop.processPlan(workspace, db.get('SELECT * FROM plans WHERE id = ?', [planId]));
  } finally {
    loop.runCodex = originalRunCodex;
  }

  assert.equal(codexCalled, false, 'final acceptance task should run validation directly instead of Codex');
  const acceptedPlan = db.get('SELECT * FROM plans WHERE id = ?', [planId]);
  const acceptedTask = db.get('SELECT * FROM plan_tasks WHERE id = ?', [acceptanceTask.id]);
  assert.equal(acceptedPlan.status, 'completed', 'final acceptance task should complete the plan');
  assert.equal(acceptedPlan.validation_passed, 1, 'final acceptance task should mark validation_passed');
  assert.equal(acceptedTask.status, 'completed', 'final acceptance task should be completed');
  assert.match(fs.readFileSync(planFile, 'utf8'), /- \[x\] P002: 完整验收/, 'final acceptance checkbox should be checked');
  const acceptanceEvents = taskEventsByKey(loop.snapshot(projectId), 'P002');
  assertTaskEventOrder(acceptanceEvents, ['task.succeeded', 'task.started'], 'final acceptance task events');
  assert.equal(acceptanceEvents[0].meta.acceptanceTask, true, 'final acceptance success event should be marked');
}

function assertSearchHit(searchState, source, field, valuePattern, label) {
  assert.ok(searchState.total > 0, `${label}：应返回搜索结果`);
  const result = searchState.results.find(
    (item) => item.source === source && item.matches.some((match) => match.field === field),
  );
  assert.ok(result, `${label}：应包含 ${source}/${field} 命中`);
  const match = result.matches.find((item) => item.field === field);
  assert.match(match.value, valuePattern, `${label}：命中值应包含关键字`);
  assert.match(match.snippet, valuePattern, `${label}：摘要片段应包含关键字`);
  assert.ok(
    searchState.groups.some((group) => group.source === source && group.count > 0),
    `${label}：来源分组应统计命中数量`,
  );
  return result;
}

function assertSearchLocation(result, expected, label) {
  assert.equal(result.targetTab, expected.targetTab, `${label}：targetTab 应正确`);
  assert.equal(result.targetType, expected.targetType, `${label}：targetType 应正确`);
  assert.equal(result.targetId, result.recordId, `${label}：targetId 应指向当前记录`);
  assert.equal(result.anchorId, expected.anchorId, `${label}：顶层 anchorId 应正确`);
  assert.equal(result.location.anchorId, expected.anchorId, `${label}：location.anchorId 应正确`);
  assert.equal(result.location.highlightMs, 2400, `${label}：应携带高亮时长`);
  assert.equal(result.location.scrollBehavior, 'smooth', `${label}：应携带滚动行为`);
}

function assertFrontendInteractionSourceSmoke() {
  const workspacePageSource = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'renderer', 'pages', 'WorkspacePage.tsx'),
    'utf8',
  );
  const planListsSource = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'renderer', 'components', 'PlanLists.tsx'),
    'utf8',
  );
  const searchResultsSource = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'renderer', 'components', 'SearchResults.tsx'),
    'utf8',
  );
  const overviewSource = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'renderer', 'components', 'workspace', 'WorkspaceOverviewView.tsx'),
    'utf8',
  );
  const mainSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8'), mcpAuthSource = `${fs.readFileSync(path.join(__dirname, '..', 'src', 'mcpServer.js'), 'utf8')}\n${fs.readFileSync(path.join(__dirname, '..', 'src', 'database.js'), 'utf8')}`;

  assert.match(planListsSource, /aria-expanded=\{expanded\}/, '任务分组应暴露展开状态');
  assert.match(planListsSource, /setExpandedOverrides/, '任务分组折叠状态应保存在前端会话内');
  assert.match(planListsSource, /workspace-task-\$\{task\.id\}/, '任务卡片应提供搜索定位锚点');
  assert.match(planListsSource, /workspace-event-\$\{event\.id\}/, '事件卡片应提供搜索定位锚点');
  assert.match(planListsSource, /data-testid="plan-select-toggle"/, 'Plan 列表应暴露选择按钮测试标识');
  assert.match(planListsSource, /aria-pressed=\{selected\}/, 'Plan 选择按钮应暴露 pressed 状态');
  assert.doesNotMatch(planListsSource, /data-testid="plan-task-filter-banner"/, '任务列表不应显示 Plan 过滤提示标识');
  assert.doesNotMatch(planListsSource, /data-testid="plan-task-filter-clear"/, '任务列表不应显示 Plan 过滤清空入口');
  assert.match(workspacePageSource, /isTaskAssociatedWithPlan/, 'WorkspacePage 应使用统一 Plan-Task 关联规则过滤任务');
  assert.match(workspacePageSource, /planFilter=\{selectedPlanTaskFilter\}/, 'TaskList 应接收 Plan 过滤上下文');
  assert.match(workspacePageSource, /onSelectPlan=\{planSelectionState\.selectPlan\}/, 'PlanList 应接收受控选择回调');
  assert.match(workspacePageSource, /data-testid="workspace-task-main"/, '任务与计划区域应暴露测试定位标识');
  assert.match(searchResultsSource, /role="dialog"/, '搜索结果应以 dialog popup 呈现');
  assert.match(searchResultsSource, /role="listbox"/, '搜索结果列表应提供 listbox 语义');
  assert.match(searchResultsSource, /onClose\(\)/, '搜索结果选择或清空后应关闭 popup');
  assert.match(overviewSource, /startsWith\('scan\.'\)[\s\S]*<EventList events=\{recentEvents\}/, '概览近期事件应使用过滤后的事件列表');
  assert.match(mainSource, /await loadRenderer\(mainWindow\);\s+scheduleMcpServerStart\(\);[\s\S]*function scheduleMcpServerStart\(\) \{ setTimeout\(\(\) => startMcpServer\(\)\.catch\(\(error\) => recordMcpStartupError\(error\)\), 0\); \}/, 'MCP 应在 renderer 加载后后台启动，失败只记录错误');
  assert.match(mcpAuthSource, /Authorization Bearer[\s\S]*WWW-Authenticate[\s\S]*Bearer realm="AutoPlan MCP"[\s\S]*'mcp\.authToken': generateSecretToken\(\)/, 'MCP HTTP 应使用标准 Bearer 校验并自动生成默认密钥');
}

function assertMarkdownPlanReaderSourceSmoke() {
  const markdownReaderSource = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'renderer', 'components', 'MarkdownReader.tsx'),
    'utf8',
  );
  const planListSource = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'renderer', 'components', 'plans', 'PlanList.tsx'),
    'utf8',
  );
  const autoplanTaskMarkdown = [
    '## 任务拆解',
    '- [ ] P001: 标准任务 <!-- scope: src/renderer/components/MarkdownReader.tsx -->',
    '- [x] P002: 已完成任务 <!-- scope: src/renderer/components/plans/PlanList.tsx -->',
    '  - 验收要点：嵌套 bullet 应保持普通列表',
    '```',
    '- [ ] 代码块里的 checkbox 文本不应被预处理',
    '```',
  ].join('\n');

  assert.match(autoplanTaskMarkdown, /- \[ \] P001: 标准任务 <!-- scope:/, '阅读 smoke fixture 应覆盖标准任务行和 scope 注释');
  assert.match(autoplanTaskMarkdown, /- \[x\] P002: 已完成任务 <!-- scope:/, '阅读 smoke fixture 应覆盖已完成任务行');
  assert.match(markdownReaderSource, /remarkPlugins=\{\[remarkGfm\]\}/, 'MarkdownReader 应启用 GFM 任务列表解析');
  assert.match(markdownReaderSource, /skipHtml/, 'MarkdownReader 应隐藏 scope HTML 注释而不是展示到预览');
  assert.doesNotMatch(markdownReaderSource, /exposeHtmlComments|renderScopeCommentParts|markdown-scope-/, 'MarkdownReader 不应把 scope 注释转换为可见 chip');
  assert.match(markdownReaderSource, /type="checkbox"[\s\S]*readOnly[\s\S]*disabled[\s\S]*tabIndex=\{-1\}/, 'MarkdownReader checkbox 应保持只读且不可聚焦');
  assert.match(planListSource, /<MarkdownReader[\s\S]*markdown=\{planReadResult\?\.markdown \?\? ''\}/, 'Plan 阅读弹窗应继续通过 Markdown 正文展示任务拆解');
  assert.doesNotMatch(planListSource, /plan-reader-task-summary|任务拆解解析结果|已解析任务列表|task_parse_message/, 'Plan 阅读弹窗不应在 Markdown 前展示独立任务拆解摘要');
}

function assertEventPresentationCopyRegression() {
  const { formatEvent, getEventSearchText } = loadRendererTsModule(
    path.join(__dirname, '..', 'src', 'renderer', 'components', 'PlanLists.tsx'),
  );
  const event = (type, message = '') => ({
    id: 9000,
    project_id: 1,
    type,
    message,
    meta: null,
    created_at: '2026-06-27T00:00:00.000Z',
  });

  assert.equal(formatEvent(event('scan.done', '扫描发现 1 条需求')).title, '扫描完成', 'scan.done 应显示中文标题');
  assert.equal(formatEvent(event('feedback.created', '收到反馈')).title, '反馈已创建', 'feedback.created 应显示中文标题');
  assert.equal(formatEvent(event('plan.generated', '计划文件已生成')).title, '计划已生成', 'plan.generated 应显示中文标题');
  assert.equal(formatEvent(event('system.unknown')).title, 'system.unknown', '未知事件类型应保留原始 key');

  const scanSearchText = getEventSearchText(event('scan.done'));
  assert.match(scanSearchText, /扫描完成/, '事件搜索文本应包含中文展示标题');
  assert.match(scanSearchText, /scan\.done/, '事件搜索文本应保留原始事件 key');
}

async function assertPlanReadRegression(
  db,
  loop,
  { projectId, otherProjectId, otherWorkspace, planId, plan, planFile, originalPlanText },
) {
  const readPlan = loadMainPlanReadHandler(db, loop);

  const existingRead = await readPlan(null, { projectId, planId });
  assert.equal(existingRead.ok, true, '读取存在的 Plan 文件应成功');
  assert.equal(existingRead.id, planId, '读取存在的 Plan 应返回 plan id');
  assert.equal(existingRead.project_id, projectId, '读取存在的 Plan 应返回项目 id');
  assert.equal(existingRead.file_path, plan.file_path, '读取存在的 Plan 应返回相对路径');
  assert.equal(existingRead.markdown, originalPlanText, '读取存在的 Plan 应返回完整 Markdown');
  assert.equal(existingRead.error, null, '读取存在的 Plan 不应返回错误');
  assert.equal(existingRead.task_total, 6, '读取 Plan 应返回已同步任务总数');
  assert.equal(existingRead.task_completed, 0, '读取 Plan 应返回已完成任务数');
  assert.equal(existingRead.task_parse_status, 'parsed', '读取 Plan 应返回解析成功状态');
  assert.equal(existingRead.tasks.length, 6, '读取 Plan 应返回任务摘要列表');
  assert.equal(existingRead.tasks[0].task_key, 'P001', '任务摘要应保留任务编号');
  assert.equal(existingRead.tasks[0].title, '明确范围与影响面', '任务摘要应保留任务标题');
  assert.deepEqual(Array.from(existingRead.tasks[0].scopes), ['unknown'], '任务摘要应返回 scope 列表');
  assert.deepEqual(Array.from(existingRead.tasks[5].scopes), ['validation'], '完整验收任务摘要应保留 validation scope');

  const malformedPlanRel = path.join('docs', 'plan', 'malformed-task-section.md');
  const malformedPlanFile = path.join(path.dirname(path.dirname(path.dirname(planFile))), malformedPlanRel);
  fs.mkdirSync(path.dirname(malformedPlanFile), { recursive: true });
  fs.writeFileSync(
    malformedPlanFile,
    ['# Malformed Task Section', '', '## 任务拆解', '', 'P001: 普通段落任务，不是 checkbox <!-- scope: smoke/malformed.js -->', ''].join('\n'),
    'utf8',
  );
  const malformedPlanId = insertPlan(db, projectId, malformedPlanRel, 'smoke-plan-read-malformed');
  const malformedRead = await readPlan(null, { projectId, planId: malformedPlanId });
  assert.equal(malformedRead.ok, true, '读取格式异常但存在的 Plan 应成功返回正文');
  assert.equal(malformedRead.task_total, 0, '格式异常任务章节不应伪造任务摘要');
  assert.equal(malformedRead.task_parse_status, 'parse_empty', '疑似任务章节但无解析任务时应返回 parse_empty');
  assert.equal(malformedRead.task_parse_has_task_section, true, '疑似任务章节应标记 has_task_section');
  assert.match(malformedRead.task_parse_message, /固定 checkbox 格式/, '解析为空时应提示固定 checkbox 格式');
  db.run('DELETE FROM plans WHERE id = ?', [malformedPlanId]);

  const unknownRead = await readPlan(null, { projectId, planId: planId + 99999 });
  assert.equal(unknownRead.ok, false, '读取不存在的 Plan 应失败');
  assert.equal(unknownRead.markdown, '', '读取不存在的 Plan 不应返回正文');
  assert.equal(unknownRead.error, '计划不存在', '读取不存在的 Plan 应提示计划不存在');

  const otherPlanRel = path.join('docs', 'plan', 'other-project-readable.md');
  const otherPlanFile = path.join(otherWorkspace, otherPlanRel);
  fs.mkdirSync(path.dirname(otherPlanFile), { recursive: true });
  fs.writeFileSync(otherPlanFile, '# Other Project Plan\n\n- [ ] O001: 仅属于其它项目\n', 'utf8');
  const otherPlanId = insertPlan(db, otherProjectId, otherPlanRel, 'smoke-plan-read-other');

  const crossProjectRead = await readPlan(null, { projectId, planId: otherPlanId });
  assert.equal(crossProjectRead.ok, false, '当前项目不应读取其它项目 Plan');
  assert.equal(crossProjectRead.markdown, '', '跨项目读取不应泄漏 Markdown 正文');
  assert.equal(crossProjectRead.error, '计划不存在', '跨项目读取应按当前项目隔离为计划不存在');

  const reverseCrossProjectRead = await readPlan(null, { projectId: otherProjectId, planId });
  assert.equal(reverseCrossProjectRead.ok, false, '其它项目不应读取当前项目 Plan');
  assert.equal(reverseCrossProjectRead.markdown, '', '反向跨项目读取不应泄漏 Markdown 正文');
  assert.equal(reverseCrossProjectRead.error, '计划不存在', '反向跨项目读取应按项目隔离为计划不存在');

  const missingPlanId = insertPlan(
    db,
    otherProjectId,
    path.join('docs', 'plan', 'missing-plan.md'),
    'smoke-plan-read-missing',
  );
  const missingRead = await readPlan(null, { projectId: otherProjectId, planId: missingPlanId });
  assert.equal(missingRead.ok, false, '读取缺失的 Plan 文件应失败');
  assert.equal(missingRead.markdown, '', '读取缺失的 Plan 文件不应返回正文');
  assert.equal(missingRead.error, '计划文件不存在', '读取缺失的 Plan 文件应提示文件不存在');

  const outsidePlanId = insertPlan(
    db,
    otherProjectId,
    path.join('..', 'outside-plan.md'),
    'smoke-plan-read-outside',
  );
  const outsideRead = await readPlan(null, { projectId: otherProjectId, planId: outsidePlanId });
  assert.equal(outsideRead.ok, false, '读取越界 Plan 路径应失败');
  assert.equal(outsideRead.markdown, '', '读取越界 Plan 路径不应返回正文');
  assert.equal(outsideRead.error, '计划文件路径超出项目工作区', '读取越界 Plan 路径应提示越界');

  assert.equal(fs.readFileSync(planFile, 'utf8'), originalPlanText, 'Plan 阅读 smoke 不应修改正式 Plan 文件');
}

async function assertLoopConfigPersistenceSmoke(db, loop, tempRoot) {
  const workspace = path.join(tempRoot, 'config-persistence-workspace');
  const projectId = insertProject(db, loop, 'Config Persistence Smoke Project', workspace);
  const handlers = loadMainIpcHandlers(db, loop);
  const configureLoop = handlers.get('loop:configure');
  const snapshotProject = handlers.get('snapshot');
  assert.equal(typeof configureLoop, 'function', '主进程应注册 loop:configure IPC handler');
  assert.equal(typeof snapshotProject, 'function', '主进程应注册 snapshot IPC handler');

  let configuredSnapshot = configureLoop(null, {
    projectId,
    workspacePath: workspace,
    intervalSeconds: 7,
    validationCommand: 'npm run smoke:config',
    agentCliProvider: 'codex',
    codexReasoningEffort: 'high',
  });
  assertLoopConfigSnapshot(configuredSnapshot, {
    projectId,
    validationCommand: 'npm run smoke:config',
    provider: 'codex',
    effort: 'high',
  }, '非空验收命令与 high 思考深度保存结果');
  assertLoopConfigRow(db, projectId, {
    validationCommand: 'npm run smoke:config',
    provider: 'codex',
    effort: 'high',
  }, '非空验收命令与 high 思考深度数据库记录');
  assertLoopConfigSnapshot(snapshotProject(null, { projectId }), {
    projectId,
    validationCommand: 'npm run smoke:config',
    provider: 'codex',
    effort: 'high',
  }, '非空验收命令与 high 思考深度刷新快照');

  configuredSnapshot = configureLoop(null, {
    projectId,
    validation_command: '',
    agentCliProvider: 'codex',
    codexReasoningEffort: 'low',
  });
  assertLoopConfigSnapshot(configuredSnapshot, {
    projectId,
    validationCommand: '',
    provider: 'codex',
    effort: 'low',
  }, '验收命令从非空保存为空结果');
  assertLoopConfigRow(db, projectId, {
    validationCommand: '',
    provider: 'codex',
    effort: 'low',
  }, '验收命令从非空保存为空数据库记录');
  assertLoopConfigSnapshot(snapshotProject(null, { projectId }), {
    projectId,
    validationCommand: '',
    provider: 'codex',
    effort: 'low',
  }, '验收命令保存为空后的刷新快照');

  const xhighExpected = { projectId, validationCommand: '', provider: 'codex', effort: 'xhigh' };
  configuredSnapshot = configureLoop(null, { projectId, agentCliProvider: 'codex', codexReasoningEffort: 'xhigh' });
  assertLoopConfigSnapshot(configuredSnapshot, xhighExpected, 'xhigh Codex reasoning effort should be preserved in configure result');
  assertLoopConfigRow(db, projectId, xhighExpected, 'xhigh Codex reasoning effort should be persisted');
  assertLoopConfigSnapshot(snapshotProject(null, { projectId }), xhighExpected, 'xhigh Codex reasoning effort should be visible in refreshed snapshot');

  configuredSnapshot = configureLoop(null, {
    projectId,
    validationCommand: 'node scripts/config-validation-smoke.js',
    agentCliProvider: 'codex',
    codexReasoningEffort: 'invalid-depth',
  });
  assertLoopConfigSnapshot(configuredSnapshot, {
    projectId,
    validationCommand: 'node scripts/config-validation-smoke.js',
    provider: 'codex',
    effort: 'medium',
  }, '验收命令从空保存为非空且非法思考深度回退默认结果');
  assertLoopConfigRow(db, projectId, {
    validationCommand: 'node scripts/config-validation-smoke.js',
    provider: 'codex',
    effort: 'medium',
  }, '验收命令从空保存为非空且非法思考深度回退默认数据库记录');

  configureLoop(null, { projectId, agentCliProvider: 'claude', codexReasoningEffort: 'high' });
  assertLoopConfigSnapshot(snapshotProject(null, { projectId }), {
    projectId,
    validationCommand: 'node scripts/config-validation-smoke.js',
    provider: 'claude',
    effort: null,
  }, 'Claude 后端刷新快照不展示 Codex 思考深度');
  configureLoop(null, { projectId, agentCliProvider: 'codex' });
  assertLoopConfigSnapshot(snapshotProject(null, { projectId }), {
    projectId,
    validationCommand: 'node scripts/config-validation-smoke.js',
    provider: 'codex',
    effort: 'medium',
  }, '从 Claude 切回 Codex 后刷新快照使用明确默认思考深度');

  assert.throws(
    () => configureLoop(null, { projectId: -999999, validationCommand: 'should-not-save' }),
    /项目不存在/,
    '配置保存失败应抛出可定位错误',
  );
  assertLoopConfigRow(db, projectId, {
    validationCommand: 'node scripts/config-validation-smoke.js',
    provider: 'codex',
    effort: 'medium',
  }, '失败保存不应把旧值误展示为成功结果');

  for (const effort of ['high', 'low', 'xhigh']) {
    configureLoop(null, { projectId, codexReasoningEffort: effort });
    await assertCodexReasoningExecutionArgSmoke(db, workspace, projectId, effort);
  }
}

async function assertMcpToolsSmoke(db, loop, tempRoot) {
  const attachmentsRoot = path.join(tempRoot, 'mcp-attachments');
  const mcpWorkspace = path.join(tempRoot, 'mcp-workspace');
  const guiWorkspace = path.join(tempRoot, 'mcp-gui-workspace');
  const context = {
    db,
    loop,
    intakeService: createIntakeService({
      db,
      loop,
      attachmentsRoot: () => attachmentsRoot,
    }),
  };

  const handlers = loadMainIpcHandlers(db, loop);
  const createProject = handlers.get('projects:create');
  assert.equal(typeof createProject, 'function', '主进程应注册 projects:create IPC handler');

  const mcpProjectResult = assertMcpToolSuccess(await callMcpTool(MCP_TOOL_NAMES.CREATE_PROJECT, {
    name: 'MCP Smoke Project',
    workspacePath: mcpWorkspace,
    description: '通过 MCP 工具创建',
    agentCliProvider: 'codex',
    agentCliCommand: '',
    codexReasoningEffort: 'high',
  }, context), 'MCP create_project');
  const mcpProjectId = mcpProjectResult.projectId;
  assert.ok(mcpProjectId, 'MCP create_project 应返回 projectId');
  assert.equal(mcpProjectResult.snapshot.activeProjectId, mcpProjectId, 'MCP create_project 应返回目标项目快照摘要');
  assertMcpProjectRow(db, mcpProjectId, {
    name: 'MCP Smoke Project',
    workspacePath: mcpWorkspace,
    description: '通过 MCP 工具创建',
  }, 'MCP create_project 数据库记录');
  assert.equal(loop.snapshot(mcpProjectId).state.running, 0, 'MCP 创建项目默认不应启动循环');

  const listedProjects = assertMcpToolData(await callMcpTool(MCP_TOOL_NAMES.LIST_PROJECTS, {
    query: 'MCP Smoke',
  }, context), 'MCP list_projects');
  assert.ok(
    listedProjects.projects.some((project) => Number(project.id) === Number(mcpProjectId)),
    'MCP list_projects should return the created project',
  );
  const fetchedProject = assertMcpToolSuccess(await callMcpTool(MCP_TOOL_NAMES.GET_PROJECT, {
    projectId: mcpProjectId,
  }, context), 'MCP get_project');
  assert.equal(fetchedProject.project.id, mcpProjectId, 'MCP get_project should return the target project');

  const guiSnapshot = createProject(null, {
    name: 'GUI Smoke Project For MCP Compare',
    workspacePath: guiWorkspace,
    description: '通过 GUI IPC 创建',
    agentCliProvider: 'codex',
    codexReasoningEffort: 'high',
  });
  assertMcpProjectRow(db, guiSnapshot.activeProjectId, {
    name: 'GUI Smoke Project For MCP Compare',
    workspacePath: guiWorkspace,
    description: '通过 GUI IPC 创建',
  }, 'GUI create_project 对照数据库记录');
  assert.equal(
    loop.snapshot(guiSnapshot.activeProjectId).state.codex_reasoning_effort,
    loop.snapshot(mcpProjectId).state.codex_reasoning_effort,
    'MCP 与 GUI 创建项目应复用同一 CLI 配置规范化口径',
  );

  const attachmentFile = path.join(tempRoot, 'mcp-attachment.txt');
  fs.writeFileSync(attachmentFile, 'mcp attachment smoke', 'utf8');
  const originalStart = loop.start.bind(loop);
  const autoRunProjectIds = [];
  loop.start = (projectId) => {
    autoRunProjectIds.push(projectId);
    const runtime = loop.runtime(projectId);
    runtime.running = true;
    db.run('UPDATE project_states SET running = 1, phase = ?, updated_at = ? WHERE project_id = ?', [
      'running',
      nowIso(),
      projectId,
    ]);
  };

  let mcpRequirementId = 0;
  let mcpFeedbackId = 0;
  try {
    const requirementResult = assertMcpToolSuccess(await callMcpTool(MCP_TOOL_NAMES.CREATE_REQUIREMENT, {
      projectId: mcpProjectId,
      title: 'MCP Smoke 需求',
      body: 'MCP smoke requirement body',
      attachments: [{ name: 'mcp-attachment.txt', path: attachmentFile, type: 'text/plain' }],
      autoRun: true,
      agentCliProvider: 'codex',
      codexReasoningEffort: 'high',
    }, context), 'MCP create_requirement');
    assert.ok(requirementResult.requirementId, 'MCP create_requirement 应返回 requirementId');
    const requirement = db.get('SELECT * FROM requirements WHERE id = ?', [requirementResult.requirementId]);
    mcpRequirementId = requirement.id;
    assert.equal(requirement.project_id, mcpProjectId, 'MCP 需求应绑定目标项目');
    assert.equal(requirement.title, 'MCP Smoke 需求', 'MCP 需求应保存标题');
    assert.equal(requirement.agent_cli_provider, 'codex', 'MCP 需求应保存 Codex 后端');
    assert.equal(requirement.codex_reasoning_effort, 'high', 'MCP 需求应保存 Codex 思考深度');
    const savedAttachment = db.get('SELECT * FROM attachments WHERE owner_type = ? AND owner_id = ?', [
      'requirement',
      requirement.id,
    ]);
    assert.ok(savedAttachment, 'MCP 需求附件应保存入库');
    assert.equal(savedAttachment.project_id, mcpProjectId, 'MCP 附件应绑定目标项目');
    assert.ok(fs.existsSync(savedAttachment.stored_path), 'MCP 附件应复制到持久化目录');
    assert.ok(autoRunProjectIds.includes(mcpProjectId), 'MCP create_requirement autoRun 应触发 loop.start');
    assert.equal(loop.snapshot(mcpProjectId).state.running, 1, 'MCP autoRun 后快照应显示项目运行中');

    const feedbackResult = assertMcpToolSuccess(await callMcpTool(MCP_TOOL_NAMES.CREATE_FEEDBACK, {
      projectId: mcpProjectId,
      requirementId: requirement.id,
      title: 'MCP Smoke 反馈',
      body: 'MCP smoke feedback body',
      attachments: [{ name: 'placeholder-only.txt', size: 0 }],
      autoRun: true,
      agentCliProvider: 'claude',
      agentCliCommand: '',
      codexReasoningEffort: 'high',
    }, context), 'MCP create_feedback');
    assert.ok(feedbackResult.feedbackId, 'MCP create_feedback 应返回 feedbackId');
    const feedback = db.get('SELECT * FROM feedback WHERE id = ?', [feedbackResult.feedbackId]);
    mcpFeedbackId = feedback.id;
    assert.equal(feedback.requirement_id, requirement.id, 'MCP 反馈应关联同项目需求');
    assert.equal(feedback.agent_cli_provider, 'claude', 'MCP 反馈应保存 Claude 后端');
    assert.equal(feedback.codex_reasoning_effort, null, 'MCP 反馈选择 Claude 时应忽略 Codex 思考深度');
  } finally {
    if (mcpRequirementId && mcpFeedbackId) {
      const listedRequirements = assertMcpToolData(await callMcpTool(MCP_TOOL_NAMES.LIST_REQUIREMENTS, {
        projectId: mcpProjectId,
        status: 'open',
      }, context), 'MCP list_requirements');
      assert.ok(
        listedRequirements.requirements.some((item) => Number(item.id) === Number(mcpRequirementId)),
        'MCP list_requirements should return the created requirement',
      );

      const listedFeedback = assertMcpToolData(await callMcpTool(MCP_TOOL_NAMES.LIST_FEEDBACK, {
        projectId: mcpProjectId,
        status: 'open',
      }, context), 'MCP list_feedback');
      assert.ok(
        listedFeedback.feedback.some((item) => Number(item.id) === Number(mcpFeedbackId)),
        'MCP list_feedback should return the created feedback',
      );
    }
    loop.start = originalStart;
    const runtime = loop.existingRuntime(mcpProjectId);
    if (runtime) runtime.running = false;
    db.run('UPDATE project_states SET running = 0, phase = ?, updated_at = ? WHERE project_id = ?', [
      'stopped',
      nowIso(),
      mcpProjectId,
    ]);
  }

  const mcpPlanId = writeSmokePlan(db, loop, mcpWorkspace, mcpProjectId);
  const listedPlans = assertMcpToolData(await callMcpTool(MCP_TOOL_NAMES.LIST_PLANS, {
    projectId: mcpProjectId,
    status: 'running',
  }, context), 'MCP list_plans');
  assert.ok(
    listedPlans.plans.some((plan) => Number(plan.id) === Number(mcpPlanId)),
    'MCP list_plans should return the synced plan',
  );
  const fetchedPlan = assertMcpToolData(await callMcpTool(MCP_TOOL_NAMES.GET_PLAN, {
    projectId: mcpProjectId,
    planId: mcpPlanId,
  }, context), 'MCP get_plan');
  assert.equal(fetchedPlan.plan.id, mcpPlanId, 'MCP get_plan should return the target plan');
  assert.equal(fetchedPlan.tasks.length, 6, 'MCP get_plan should return plan tasks');
  const listedTasks = assertMcpToolData(await callMcpTool(MCP_TOOL_NAMES.LIST_TASKS, {
    projectId: mcpProjectId,
    planId: mcpPlanId,
    status: 'pending',
  }, context), 'MCP list_tasks');
  assert.equal(listedTasks.tasks.length, 6, 'MCP list_tasks should filter by plan and status');

  const originalStartForControl = loop.start.bind(loop);
  const originalStopForControl = loop.stop.bind(loop);
  loop.start = (projectId) => {
    const runtime = loop.runtime(projectId);
    runtime.running = true;
    db.run('UPDATE project_states SET running = 1, phase = ?, updated_at = ? WHERE project_id = ?', [
      'running',
      nowIso(),
      projectId,
    ]);
  };
  loop.stop = (projectId) => {
    const runtime = loop.runtime(projectId);
    runtime.running = false;
    db.run('UPDATE project_states SET running = 0, phase = ?, updated_at = ? WHERE project_id = ?', [
      'stopped',
      nowIso(),
      projectId,
    ]);
  };
  try {
    const started = assertMcpToolSuccess(await callMcpTool(MCP_TOOL_NAMES.START_LOOP, {
      projectId: mcpProjectId,
    }, context), 'MCP start_loop');
    assert.equal(started.snapshot.state.running, true, 'MCP start_loop should return running state');
    const stopped = assertMcpToolSuccess(await callMcpTool(MCP_TOOL_NAMES.STOP_LOOP, {
      projectId: mcpProjectId,
    }, context), 'MCP stop_loop');
    assert.equal(stopped.snapshot.state.running, false, 'MCP stop_loop should return stopped state');
  } finally {
    loop.start = originalStartForControl;
    loop.stop = originalStopForControl;
  }

  const crossProjectError = await callMcpTool(MCP_TOOL_NAMES.CREATE_FEEDBACK, {
    projectId: mcpProjectId,
    requirementId: insertRequirement(db, guiSnapshot.activeProjectId),
    title: '跨项目反馈',
    body: 'should fail',
  }, context);
  assertMcpToolError(crossProjectError, /关联需求不属于当前项目/, '跨项目 requirementId 应返回明确错误');

  const invalidAutoRunError = await callMcpTool(MCP_TOOL_NAMES.CREATE_REQUIREMENT, {
    projectId: mcpProjectId,
    title: '非法 autoRun',
    body: 'should fail',
    autoRun: 'yes',
  }, context);
  assertMcpToolError(invalidAutoRunError, /autoRun must be a boolean/, '非法 autoRun 应返回可修正错误');
}

function assertMcpToolSuccess(result, label) {
  const parsed = assertMcpToolData(result, label);
  assert.ok(parsed.snapshot, `${label} 应返回快照摘要`);
  return parsed;
}

function assertMcpToolData(result, label) {
  assert.equal(result?.isError, undefined, `${label} 不应返回工具错误`);
  assert.equal(result?.content?.[0]?.type, 'text', `${label} 应返回文本 JSON`);
  const parsed = result.structuredContent || JSON.parse(result.content[0].text);
  return parsed;
}

function assertMcpToolError(result, pattern, label) {
  assert.equal(result?.isError, true, `${label} 应返回工具错误`);
  assert.match(result?.content?.[0]?.text || '', pattern, `${label} 错误信息应可定位`);
}

function assertMcpProjectRow(db, projectId, expected, label) {
  const project = db.get('SELECT * FROM projects WHERE id = ?', [projectId]);
  assert.ok(project, `${label} 应存在项目记录`);
  assert.equal(project.name, expected.name, `${label} 应保存项目名称`);
  assert.equal(project.workspace_path, expected.workspacePath, `${label} 应保存工作区路径`);
  assert.equal(project.description, expected.description, `${label} 应保存描述`);
  const state = db.get('SELECT * FROM project_states WHERE project_id = ?', [projectId]);
  assert.ok(state, `${label} 应创建项目状态行`);
}

function assertLoopConfigSnapshot(snapshot, expected, label) {
  assert.ok(snapshot?.state, `${label} 应返回项目状态`);
  assert.equal(Number(snapshot.state.project_id), Number(expected.projectId), `${label} 应属于目标项目`);
  assert.equal(snapshot.state.validation_command, expected.validationCommand, `${label} 应返回最新验收命令`);
  assert.equal(snapshot.state.agent_cli_provider, expected.provider, `${label} 应返回最新 CLI 后端`);
  assert.equal(snapshot.state.codex_reasoning_effort ?? null, expected.effort, `${label} 应返回最新 Codex 思考深度`);
}

function assertLoopConfigRow(db, projectId, expected, label) {
  const row = db.get('SELECT * FROM project_states WHERE project_id = ?', [projectId]);
  assert.ok(row, `${label} 应存在数据库状态行`);
  assert.equal(row.validation_command, expected.validationCommand, `${label} 应持久化验收命令`);
  assert.equal(row.agent_cli_provider, expected.provider, `${label} 应持久化 CLI 后端`);
  assert.equal(row.codex_reasoning_effort ?? null, expected.effort, `${label} 应持久化 Codex 思考深度`);
}

async function assertCodexReasoningExecutionArgSmoke(db, workspace, projectId, effort) {
  const spawned = [];
  const { LoopService: PatchedLoopService } = loadPatchedLoopService({
    spawnOverride: (command, args, options) => {
      spawned.push({ command, args, options });
      return createFakeChild({ output: 'config persistence smoke ok\n' });
    },
  });
  const patchedLoop = new PatchedLoopService(db);
  const result = await patchedLoop.runCodex(workspace, `执行 Codex ${effort} 思考深度 smoke`, `config-${effort}`, { projectId });
  assert.equal(result.exitCode, 0, `${effort} 思考深度执行 smoke 应成功`);
  assert.equal(spawned.length, 1, `${effort} 思考深度执行 smoke 应只启动一次 agent`);
  assert.equal(commandName(spawned[0].command), 'codex', `${effort} 思考深度执行 smoke 应使用 codex`);
  assertCodexReasoningArg(spawned[0], effort, `${effort} 思考深度执行 smoke`);
}

function loadMainPlanReadHandler(db, loop) {
  const handlers = loadMainIpcHandlers(db, loop);
  const handler = handlers.get('plans:read');
  assert.equal(typeof handler, 'function', '主进程应注册 plans:read IPC handler');
  return handler;
}

function loadMainIpcHandlers(db, loop, options = {}) {
  const mainPath = path.join(__dirname, '..', 'src', 'main.js');
  const handlers = new Map();
  const module = { exports: {} };
  const source = `${fs.readFileSync(mainPath, 'utf8')}\nmodule.exports.__setSmokeState = (state) => { db = state.db; loop = state.loop; };\nmodule.exports.__smokeIpcHandlers = __smokeIpcHandlers;\n`;
  const fakeChildProcess = {
    spawn: options.spawn || (() => createSpawnOnlyChild()),
  };
  const fakeElectron = {
    app: {
      getPath: () => path.join(os.tmpdir(), 'autoplan-smoke-user-data'),
      on: () => {},
      quit: () => {},
      whenReady: () => ({ then: () => undefined }),
    },
    BrowserWindow: function SmokeBrowserWindow() {
      throw new Error('smoke 不应创建 Electron 窗口');
    },
    ipcMain: {
      handle: (channel, handler) => handlers.set(channel, handler),
    },
    Menu: {
      setApplicationMenu: () => {},
    },
    shell: options.shell || {
      openPath: async () => '',
      showItemInFolder: () => {},
    },
  };
  const localRequire = (request) => {
    if (request === 'electron') return fakeElectron;
    if (request === 'node:child_process') return fakeChildProcess;
    if (request.startsWith('./')) return require(path.join(path.dirname(mainPath), request));
    return require(request);
  };

  vm.runInNewContext(
    source,
    {
      require: localRequire,
      module,
      exports: module.exports,
      __dirname: path.dirname(mainPath),
      __filename: mainPath,
      __smokeIpcHandlers: handlers,
      Buffer,
      clearTimeout,
      console,
      process,
      setTimeout,
    },
    { filename: mainPath },
  );
  module.exports.__setSmokeState({ db, loop });
  return handlers;
}

function loadRendererTsModule(modulePath, cache = new Map()) {
  const absolutePath = path.resolve(modulePath);
  const cachedModule = cache.get(absolutePath);
  if (cachedModule) return cachedModule.exports;

  const ts = require('typescript');
  const module = { exports: {} };
  cache.set(absolutePath, module);

  const source = fs.readFileSync(absolutePath, 'utf8');
  const transpiled = ts.transpileModule(source, {
    fileName: absolutePath,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
    },
    reportDiagnostics: true,
  });
  const diagnostics = (transpiled.diagnostics || []).filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  );
  assert.deepEqual(
    diagnostics.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')),
    [],
    `${absolutePath} 应能被 TypeScript 转译`,
  );

  const rendererRoot = path.join(__dirname, '..', 'src', 'renderer');
  const localRequire = (request) => {
    if (request.startsWith('.') || path.isAbsolute(request)) {
      return loadRendererTsModule(resolveRendererModule(path.dirname(absolutePath), request, rendererRoot), cache);
    }
    return require(request);
  };

  const script = new vm.Script(transpiled.outputText, { filename: absolutePath });
  script.runInNewContext({
    require: localRequire,
    module,
    exports: module.exports,
    __dirname: path.dirname(absolutePath),
    __filename: absolutePath,
    console,
  });
  return module.exports;
}

function resolveRendererModule(fromDir, request, rendererRoot) {
  const basePath = path.resolve(fromDir, request);
  const candidates = [
    basePath,
    `${basePath}.ts`,
    `${basePath}.tsx`,
    `${basePath}.js`,
    `${basePath}.jsx`,
    path.join(basePath, 'index.ts'),
    path.join(basePath, 'index.tsx'),
    path.join(basePath, 'index.js'),
  ];
  const resolvedPath = candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
  assert.ok(resolvedPath, `应能解析前端模块 ${request}`);

  const relativePath = path.relative(rendererRoot, resolvedPath);
  assert.ok(
    relativePath && !relativePath.startsWith('..') && !path.isAbsolute(relativePath),
    `前端 smoke 模块应限制在 renderer 目录内：${request}`,
  );
  return resolvedPath;
}

function insertProject(db, loop, name, workspacePath) {
  const now = nowIso();
  const id = db.insert(
    `INSERT INTO projects (name, workspace_path, description, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
    [name, workspacePath, '', now, now],
  );
  loop.ensureProjectState(id);
  return id;
}

function insertPlan(db, projectId, filePath, issueHash) {
  const now = nowIso();
  return db.insert(
    `INSERT INTO plans (project_id, issue_hash, file_path, hash, status, total_tasks, completed_tasks, validation_passed, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [projectId, issueHash, filePath, `${issueHash}-hash`, 'running', 0, 0, 0, now, now],
  );
}

/** 直接写一个 plan markdown 文件并入库同步任务，替代旧的 planDraft 接受流程。 */
function writeSmokePlan(db, loop, workspace, projectId) {
  const planDir = path.join(workspace, 'docs', 'plan');
  fs.mkdirSync(planDir, { recursive: true });
  const planRel = path.join('docs', 'plan', 'smoke-plan.md');
  const planFile = path.join(workspace, planRel);
  fs.writeFileSync(
    planFile,
    [
      '# Smoke 开发计划',
      '',
      '## 任务计划',
      '- [ ] P001: 明确范围与影响面 <!-- scope: unknown -->',
      '- [ ] P002: 完成核心实现 <!-- scope: unknown -->',
      '- [ ] P003: 完成交互与异常状态 <!-- scope: unknown -->',
      '- [ ] P004: 补充验证 <!-- scope: unknown -->',
      '- [ ] P005: 更新文档或进度记录 <!-- scope: unknown -->',
      '- [ ] P006: 完整验收 <!-- scope: validation -->',
      '',
    ].join('\n'),
    'utf8',
  );
  const now = nowIso();
  const planId = db.insert(
    `INSERT INTO plans (project_id, issue_hash, file_path, hash, status, total_tasks, completed_tasks, validation_passed, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 0, 0, 0, ?, ?)`,
    [projectId, 'smoke-plan', planRel, '', 'pending', now, now],
  );
  loop.syncPlanTasks(planId, planFile);
  return planId;
}

function assertPlanTaskParsingRegression(db, loop, workspace, projectId) {
  const planDir = path.join(workspace, 'docs', 'plan');
  fs.mkdirSync(planDir, { recursive: true });
  const planRel = path.join('docs', 'plan', 'parser-regression.md');
  const planFile = path.join(workspace, planRel);
  const original = [
    '# Parser Regression',
    '',
    '## 任务拆解',
    '- [ ] P010: 标准任务 <!-- scope: src/loopService.js,src/main.js -->',
    '- [ ] P011: 缺少 scope 的任务',
    '  - 验收要点：缺少 scope 时标题不能吞掉这一行',
    '  - 验收要点：后续验收要点不能变成任务标题',
    '  - [ ] P012：中文标点与缩进 <!-- scope： src/renderer/components/PlanLists.tsx；src/renderer/components/MarkdownReader.tsx -->',
    '- [x] P013 — 已完成 checkbox <!-- scope: src/main.js -->',
    '- [ ] P014: 完整验收 <!-- scope: validation -->',
    '',
  ].join('\n');
  fs.writeFileSync(planFile, original, 'utf8');
  const planId = insertPlan(db, projectId, planRel, 'parser-regression-smoke');

  loop.syncPlanTasks(planId, planFile);
  const tasks = db.all('SELECT * FROM plan_tasks WHERE plan_id = ? ORDER BY sort_order ASC', [planId]);

  assert.equal(tasks.length, 5, '解析回归应覆盖标准、缺 scope、中文缩进、已完成和完整验收任务');
  assert.equal(tasks[0].task_key, 'P010', '标准任务行应提取 task_key');
  assert.equal(tasks[0].title, '标准任务', '标准任务行应提取标题');
  assert.equal(tasks[0].scope, 'src/loopservice.js, src/main.js', '标准任务行应提取多个 scope');
  assert.equal(tasks[1].task_key, 'P011', '缺少 scope 的任务应保留显式编号');
  assert.equal(tasks[1].title, '缺少 scope 的任务', '缺少 scope 不应吞掉验收要点');
  assert.equal(tasks[1].scope, 'unknown', '缺少 scope 的任务应补 unknown');
  assert.ok(tasks[1].raw_line.includes('scope: unknown'), '缺少 scope 的 raw_line 应补 unknown 注释用于阅读器展示');
  assert.equal(tasks[2].task_key, 'P012', '缩进任务行应提取 task_key');
  assert.equal(tasks[2].status, 'pending', '缩进任务行应保持 pending 状态');
  assert.match(tasks[2].scope, /planlists\.tsx/, '中文 scope 分隔符应被解析');
  assert.equal(tasks[3].task_key, 'P013', '破折号分隔符应提取 task_key');
  assert.equal(tasks[3].title, '已完成 checkbox', '破折号分隔符不应残留到标题');
  assert.equal(tasks[3].status, 'completed', '已完成 checkbox 应同步 completed 状态');
  assert.equal(tasks[4].scope, 'validation', '完整验收任务应保留 validation scope');
  assert.equal(fs.readFileSync(planFile, 'utf8'), original, '解析回归不应改写原始 Plan Markdown');
  db.run('DELETE FROM plan_tasks WHERE plan_id = ?', [planId]);
  db.run('DELETE FROM plans WHERE id = ?', [planId]);
}

function insertRequirement(db, projectId) {
  const now = nowIso();
  return db.insert(
    `INSERT INTO requirements (project_id, title, body, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [projectId, '普通文本需求', '目标：\n普通文本验收\n允许拖拽图片附件', 'open', now, now],
  );
}

function insertFeedback(db, projectId) {
  const now = nowIso();
  return db.insert(
    `INSERT INTO feedback (project_id, requirement_id, title, body, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [projectId, null, '普通文本反馈', '列表展示\n重点内容\n可附加图片', 'open', now, now],
  );
}

async function assertAttachmentPersistenceSmoke(db, loop, tempRoot) {
  const workspace = path.join(tempRoot, 'attachment-workspace');
  const attachmentsRoot = path.join(tempRoot, 'attachment-store');
  const projectId = insertProject(db, loop, 'Attachment Smoke Project', workspace);
  loop.configure(projectId, { workspacePath: workspace, intervalSeconds: 5, validationCommand: '' });
  loop.ensureWorkspaceDirs(workspace);

  const requirementId = insertRequirement(db, projectId);
  const feedbackId = insertFeedback(db, projectId);
  const pathImageBuffer = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lZl0WQAAAABJRU5ErkJggg==',
    'base64',
  );
  const clipboardImageBuffer = Buffer.from('clipboard-image-payload-smoke\n', 'utf8');
  const sourceImagePath = path.join(tempRoot, 'requirement-path-image.png');
  fs.writeFileSync(sourceImagePath, pathImageBuffer);

  const [requirementAttachment] = saveAttachments(
    db,
    attachmentsRoot,
    'requirement',
    requirementId,
    [{ path: sourceImagePath, name: 'requirement-path-image.png', type: 'image/png' }],
    projectId,
  );
  const [feedbackAttachment] = saveAttachments(
    db,
    attachmentsRoot,
    'feedback',
    feedbackId,
    [
      {
        source: 'clipboard-image',
        name: 'feedback-clipboard-image',
        dataUrl: `data:image/png;base64,${clipboardImageBuffer.toString('base64')}`,
      },
    ],
    projectId,
  );

  const requirementAttachmentRow = assertAttachmentRecord(db, requirementAttachment, {
    projectId,
    ownerType: 'requirement',
    ownerId: requirementId,
    expectedMime: 'image/png',
    expectedName: 'requirement-path-image.png',
    expectedBuffer: pathImageBuffer,
    label: '路径需求图片附件',
  });
  const feedbackAttachmentRow = assertAttachmentRecord(db, feedbackAttachment, {
    projectId,
    ownerType: 'feedback',
    ownerId: feedbackId,
    expectedMime: 'image/png',
    expectedName: 'feedback-clipboard-image.png',
    expectedBuffer: clipboardImageBuffer,
    label: '剪贴板反馈图片附件',
  });

  const snapshot = loop.snapshot(projectId);
  assert.equal(snapshot.attachments.length, 2, '附件 smoke 项目快照应包含需求和反馈图片附件');
  assertAttachmentSnapshotBinding(snapshot, requirementAttachmentRow, '需求图片附件快照');
  assertAttachmentSnapshotBinding(snapshot, feedbackAttachmentRow, '反馈图片附件快照');

  const requirement = db.get('SELECT * FROM requirements WHERE id = ?', [requirementId]);
  const feedback = db.get('SELECT * FROM feedback WHERE id = ?', [feedbackId]);
  await assertGeneratedPlanPromptReadsAttachment(loop, {
    projectId,
    workspace,
    intake: { ...requirement, __type: 'requirement' },
    attachment: requirementAttachmentRow,
    expectedBuffer: pathImageBuffer,
    label: '需求图片附件',
  });
  await assertGeneratedPlanPromptReadsAttachment(loop, {
    projectId,
    workspace,
    intake: { ...feedback, __type: 'feedback' },
    attachment: feedbackAttachmentRow,
    expectedBuffer: clipboardImageBuffer,
    label: '反馈图片附件',
  });
}

function assertAttachmentRecord(db, savedAttachment, options) {
  assert.ok(savedAttachment, `${options.label} 应返回保存结果`);
  const row = db.get('SELECT * FROM attachments WHERE id = ?', [savedAttachment.id]);
  const expectedHash = hashBuffer(options.expectedBuffer);
  assert.ok(row, `${options.label} 应写入 SQLite`);
  assert.equal(row.project_id, options.projectId, `${options.label} SQLite 应绑定 project_id`);
  assert.equal(row.owner_type, options.ownerType, `${options.label} SQLite 应记录 owner_type`);
  assert.equal(row.owner_id, options.ownerId, `${options.label} SQLite 应记录 owner_id`);
  assert.equal(row.original_name, options.expectedName, `${options.label} SQLite 应记录文件名`);
  assert.equal(row.mime_type, options.expectedMime, `${options.label} SQLite 应记录 MIME`);
  assert.equal(row.size, options.expectedBuffer.length, `${options.label} SQLite 应记录大小`);
  assert.equal(row.hash, expectedHash, `${options.label} SQLite 应记录 SHA256`);
  assert.ok(fs.existsSync(row.stored_path), `${options.label} 应落盘到持久化路径`);
  assert.deepEqual(fs.readFileSync(row.stored_path), options.expectedBuffer, `${options.label} 落盘内容应一致`);
  assert.equal(savedAttachment.project_id, row.project_id, `${options.label} 保存结果应返回 project_id`);
  assert.equal(savedAttachment.owner_type, row.owner_type, `${options.label} 保存结果应返回 owner_type`);
  assert.equal(savedAttachment.owner_id, row.owner_id, `${options.label} 保存结果应返回 owner_id`);
  assert.equal(savedAttachment.mime_type, row.mime_type, `${options.label} 保存结果应返回 MIME`);
  assert.equal(savedAttachment.size, row.size, `${options.label} 保存结果应返回大小`);
  assert.equal(savedAttachment.hash, row.hash, `${options.label} 保存结果应返回 hash`);
  return row;
}

function assertAttachmentSnapshotBinding(snapshot, attachment, label) {
  const row = snapshot.attachments.find((item) => item.id === attachment.id);
  assert.ok(row, `${label} 应出现在快照附件列表`);
  assert.equal(row.project_id, attachment.project_id, `${label} 应绑定 project_id`);
  assert.equal(row.owner_type, attachment.owner_type, `${label} 应绑定 owner_type`);
  assert.equal(row.owner_id, attachment.owner_id, `${label} 应绑定 owner_id`);
  assert.equal(row.mime_type, attachment.mime_type, `${label} 应保留 MIME`);
  assert.equal(row.size, attachment.size, `${label} 应保留大小`);
  assert.equal(row.hash, attachment.hash, `${label} 应保留 hash`);
}

async function assertGeneratedPlanPromptReadsAttachment(loop, options) {
  const originalRunCodex = loop.runCodex.bind(loop);
  let checkedPrompt = false;
  try {
    loop.runCodex = async (_workspace, prompt, label, operation = {}) => {
      checkedPrompt = true;
      assert.equal(_workspace, options.workspace, `${options.label} plan 生成应使用附件项目工作区`);
      assert.equal(operation.projectId, options.projectId, `${options.label} plan 生成 operation 应绑定项目`);
      assert.match(prompt, /附件清单：/, `${options.label} prompt 应包含附件清单`);
      assert.match(prompt, /最后一个任务必须是“完整验收”节点/, `${options.label} plan prompt 应要求最终验收节点`);
      assert.ok(prompt.includes(options.attachment.original_name), `${options.label} prompt 应包含附件名称`);
      assert.ok(prompt.includes(options.attachment.mime_type), `${options.label} prompt 应包含 MIME`);
      assert.ok(prompt.includes(options.attachment.hash), `${options.label} prompt 应包含 hash`);
      assert.ok(prompt.includes(options.attachment.stored_path), `${options.label} prompt 应包含可读路径`);
      assert.match(prompt, /可读性: 已确认可读/, `${options.label} prompt 应声明附件可读`);
      const promptAttachmentPath = extractPromptAttachmentPath(prompt);
      assert.equal(
        path.normalize(promptAttachmentPath),
        path.normalize(options.attachment.stored_path),
        `${options.label} prompt 中路径应指向持久化附件`,
      );
      assert.deepEqual(
        fs.readFileSync(promptAttachmentPath),
        options.expectedBuffer,
        `${options.label} 测试进程应能按 prompt 路径读取附件内容`,
      );

      const outputMatch = prompt.match(/^输出文件：(.+)$/m);
      assert.ok(outputMatch, `${options.label} prompt 应包含输出文件路径`);
      const planFile = outputMatch[1].trim();
      fs.mkdirSync(path.dirname(planFile), { recursive: true });
      fs.writeFileSync(
        planFile,
        ['# 附件计划 smoke', '', '## 任务计划', '- [ ] P001: 使用附件上下文 <!-- scope: unknown -->', ''].join('\n'),
        'utf8',
      );
      const logFile = path.join(options.workspace, 'docs', 'progress', 'logs', `${label}.log`);
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      fs.writeFileSync(logFile, 'attachment prompt smoke', 'utf8');
      return { exitCode: 0, logFile, lastFile: planFile };
    };

    const planId = await loop.generatePlanForIntake(options.projectId, options.workspace, options.intake);
    assert.ok(planId, `${options.label} 应通过 stub 生成 plan`);
    assert.ok(checkedPrompt, `${options.label} 应执行 prompt 断言 stub`);
  } finally {
    loop.runCodex = originalRunCodex;
  }
}

async function assertScopeConcurrencySmoke(db, loop, workspace, projectId) {
  const planRel = path.join('docs', 'plan', 'scope-concurrency-smoke.md');
  const planFile = path.join(workspace, planRel);
  fs.mkdirSync(path.dirname(planFile), { recursive: true });
  const existingFile = path.join(workspace, 'src', 'existing.js');
  fs.mkdirSync(path.dirname(existingFile), { recursive: true });
  fs.writeFileSync(existingFile, 'module.exports = 1;\n', 'utf8');
  fs.writeFileSync(
    planFile,
    [
      '# Scope concurrency smoke',
      '',
      '- [ ] S001: 多文件归一化 <!-- scope: src/existing.js, src\\missing.js, src/existing.js -->',
      '- [ ] S002: 独立文件 <!-- scope: src/other.js -->',
      '- [ ] S003: 重叠文件 <!-- scope: src/existing.js -->',
      '- [ ] S004: 未知范围 <!-- scope: unknown -->',
      '- [ ] S005: 完整验收 <!-- scope: validation -->',
      '',
    ].join('\n'),
    'utf8',
  );
  const planId = insertPlan(db, projectId, planRel, 'scope-concurrency-smoke');
  loop.syncPlanTasks(planId, planFile);
  const snapshot = loop.snapshot(projectId);
  const plan = snapshot.plans.find((item) => item.id === planId);
  assert.ok(plan, 'scope smoke plan 应进入快照');

  const taskS001 = taskByKey(snapshot, 'S001');
  assert.deepEqual(
    taskS001.scope_files.map((file) => file.path),
    ['src/existing.js', 'src/missing.js'],
    'scope 文件列表应归一化分隔符并去重',
  );
  assert.equal(taskS001.scope_files[0].canOpen, true, '存在的 scope 文件应标记可打开');
  assert.equal(taskS001.scope_files[1].exists, false, '缺失的 scope 文件应保留缺失状态');
  assert.equal(taskByKey(snapshot, 'S004').scope_files[0].isUnknown, true, 'unknown scope 应标记 unknown');
  assert.equal(taskByKey(snapshot, 'S005').scope_files[0].isValidation, true, 'validation scope 应标记 validation');

  assert.equal(plan.concurrency_suggestion.hasSafeParallelBatches, true, '应存在安全并发批次');
  assert.deepEqual(
    plan.concurrency_suggestion.batches[0].tasks.map((task) => task.task_key),
    ['S001', 'S002'],
    'scope 不重叠任务应进入同一建议批次',
  );
  assert.ok(
    plan.concurrency_suggestion.serialTasks.some((task) => task.task_key === 'S004' && /unknown/.test(task.reason)),
    'unknown 任务应出现在串行原因中',
  );
  assert.ok(
    plan.concurrency_suggestion.serialTasks.some((task) => task.task_key === 'S003'),
    'scope 重叠后无法组成安全批次的任务应保持串行',
  );
  assert.ok(
    plan.concurrency_suggestion.serialTasks.some((task) => task.task_key === 'S005' && /validation|验收/.test(task.reason)),
    'validation 任务应出现在串行原因中',
  );
  assert.throws(
    () => loop.validatedParallelTaskBatches(workspace, db.get('SELECT * FROM plans WHERE id = ?', [planId]), [
      { taskIds: [taskByKey(snapshot, 'S001').id, taskByKey(snapshot, 'S003').id] },
    ]),
    /scope 冲突/,
    '手动并发入口应拒绝同批 scope 冲突',
  );

  const smokePlan = db.get('SELECT * FROM plans WHERE id = ?', [planId]);
  const fakeLogFile = path.join(workspace, 'docs', 'progress', 'logs', 'scope-parallel.log');
  fs.mkdirSync(path.dirname(fakeLogFile), { recursive: true });
  fs.writeFileSync(fakeLogFile, 'scope parallel ok', 'utf8');
  const startedTaskKeys = [];
  const originalRunCodex = loop.runCodex.bind(loop);
  try {
    loop.runCodex = async (_workspace, _prompt, _label, operation = {}) => {
      const task = db.get('SELECT task_key FROM plan_tasks WHERE id = ?', [operation.taskId]);
      startedTaskKeys.push(task.task_key);
      return { exitCode: 0, logFile: fakeLogFile, lastFile: path.join(workspace, `${task.task_key}.txt`) };
    };
    await loop.runTaskBatches(projectId, planId, [{ taskIds: plan.concurrency_suggestion.batches[0].tasks.map((task) => task.id) }]);
  } finally {
    loop.runCodex = originalRunCodex;
  }
  assert.deepEqual(startedTaskKeys.sort(), ['S001', 'S002'], '手动确认后应启动安全并发批次');
  const completedSnapshot = loop.snapshot(projectId);
  assert.equal(taskByKey(completedSnapshot, 'S001').status, 'completed', '并发任务 S001 应完成');
  assert.equal(taskByKey(completedSnapshot, 'S002').status, 'completed', '并发任务 S002 应完成');
  assert.ok(
    completedSnapshot.events.some((event) => event.type === 'tasks.parallel.finished' && event.meta?.planId === planId),
    '并发批次完成应记录事件',
  );
  assert.equal(fs.readFileSync(planFile, 'utf8').includes('- [x] S001'), true, '并发完成应写回对应 checkbox');
}

async function assertWorkspaceOpenFileIpcSmoke(db, loop, workspace, projectId) {
  const opened = [];
  const handlers = loadMainIpcHandlers(db, loop, {
    shell: {
      openPath: async (targetPath) => {
        opened.push({ mode: 'system', targetPath });
        return '';
      },
      showItemInFolder: (targetPath) => opened.push({ mode: 'folder', targetPath }),
    },
    spawn: (command, args, options) => {
      opened.push({ mode: 'command', command, args, options });
      return createSpawnOnlyChild();
    },
  });
  const openFile = handlers.get('workspace:openFile');
  assert.equal(typeof openFile, 'function', '主进程应注册 workspace:openFile IPC handler');
  const targetFile = path.join(workspace, 'src', 'open-smoke.js');
  fs.mkdirSync(path.dirname(targetFile), { recursive: true });
  fs.writeFileSync(targetFile, 'console.log("open");\n', 'utf8');
  const targetDir = path.join(workspace, 'src', 'open-dir');
  fs.mkdirSync(targetDir, { recursive: true });

  assert.equal((await openFile(null, { projectId, filePath: 'src/open-smoke.js' })).ok, true, '系统默认打开应成功');
  assert.equal(opened.at(-1).mode, 'system', '默认配置应走系统打开');
  assert.equal((await openFile(null, { projectId, filePath: 'src/open-smoke.js', mode: 'folder' })).ok, true, '文件夹定位应成功');
  assert.equal(opened.at(-1).mode, 'folder', 'folder 配置应定位文件');
  assert.equal((await openFile(null, { projectId, filePath: 'src/open-smoke.js', mode: 'vscode' })).ok, true, 'VSCode 打开应成功');
  assert.equal(opened.at(-1).command, 'code', 'VSCode 默认命令应为 code');
  assert.equal((await openFile(null, { projectId, filePath: 'src/open-smoke.js', mode: 'command', command: 'cursor {file}' })).ok, true, '第三方命令应成功');
  assert.match(opened.at(-1).command, /cursor .*open-smoke\.js/, '第三方命令应替换 {file} 占位');
  assert.equal((await openFile(null, { projectId, filePath: '../outside.js' })).ok, false, '越界路径应被拒绝');
  assert.match((await openFile(null, { projectId, filePath: 'src/missing-open.js' })).error, /不存在/, '缺失文件应给出提示');
  assert.match((await openFile(null, { projectId, filePath: 'src/open-dir' })).error, /目录/, '目录路径应给出提示');
  assert.match((await openFile(null, { projectId, filePath: 'src/open-smoke.js', mode: 'command' })).error, /命令未配置/, '第三方命令缺失应给出提示');
}

function extractPromptAttachmentPath(prompt) {
  const match = prompt.match(/^  - 持久化本地路径: (.+)$/m);
  assert.ok(match, '附件 prompt 应包含持久化本地路径行');
  return match[1].trim();
}

function hashBuffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

async function assertCodexSessionReuseSmoke(db, loop, projectId, workspace) {
  const contextPlanRel = path.join('docs', 'plan', 'context-reuse-smoke.md');
  const contextPlanFile = path.join(workspace, contextPlanRel);
  fs.mkdirSync(path.dirname(contextPlanFile), { recursive: true });
  fs.writeFileSync(
    contextPlanFile,
    [
      '# Context reuse smoke',
      '',
      '- [ ] C001: 失败后复用上下文 <!-- scope: smoke/c001.js -->',
      '- [ ] C002: 并发任务 A <!-- scope: smoke/c002.js -->',
      '- [ ] C003: 并发任务 B <!-- scope: smoke/c003.js -->',
      '- [ ] C004: 同步保留上下文 <!-- scope: smoke/c004.js -->',
      '- [ ] C005: 同步改名旧任务 <!-- scope: smoke/c005.js -->',
      '- [ ] C007: 串行继承 plan 上下文 <!-- scope: smoke/c007.js -->',
      '',
    ].join('\n'),
    'utf8',
  );

  const now = nowIso();
  const contextPlanId = db.insert(
    `INSERT INTO plans (project_id, issue_hash, file_path, hash, status, total_tasks, completed_tasks, validation_passed, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [projectId, 'smoke-context-reuse', contextPlanRel, '', 'running', 0, 0, 0, now, now],
  );
  loop.syncPlanTasks(contextPlanId, contextPlanFile);
  const contextPlan = db.get('SELECT * FROM plans WHERE id = ?', [contextPlanId]);
  const contextTask = (taskKey) => db.get('SELECT * FROM plan_tasks WHERE plan_id = ? AND task_key = ?', [contextPlanId, taskKey]);

  const logDir = path.join(workspace, 'docs', 'progress', 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const fakeLogFile = path.join(logDir, 'context-reuse-smoke.log');
  fs.writeFileSync(fakeLogFile, 'context reuse smoke', 'utf8');

  const retrySessionId = '11111111-1111-4111-8111-111111111111';
  const parallelSessionA = '22222222-2222-4222-8222-222222222222';
  const parallelSessionB = '33333333-3333-4333-8333-333333333333';
  const syncKeptSessionId = '44444444-4444-4444-8444-444444444444';
  const syncRenamedOldSessionId = '55555555-5555-4555-8555-555555555555';
  const originalRunCodex = loop.runCodex.bind(loop);

  try {
    const retryTask = contextTask('C001');
    loop.runCodex = async (_workspace, prompt, label, operation = {}) => {
      assert.equal(_workspace, workspace, '会话复用 smoke 应使用当前工作区');
      assert.match(prompt, /只执行指定任务 C001/, '首次失败执行 prompt 应锁定 C001');
      assert.equal(label, 'execute-C001', '首次失败执行 label 应包含任务 key');
      assert.equal(operation.planId, contextPlanId, '首次失败执行 operation 应绑定 plan');
      assert.equal(operation.taskId, retryTask.id, '首次失败执行 operation 应绑定 task');
      assert.equal(operation.codexSessionId, undefined, '首次执行不应传入已有 session id');
      await sleep(5);
      return {
        exitCode: 1,
        logFile: fakeLogFile,
        lastFile: path.join(logDir, 'context-c001-failed.txt'),
        codexSessionId: retrySessionId,
        codexSessionMode: 'new',
      };
    };
    const failedResult = await loop.executeTask(workspace, contextPlan, retryTask);
    assert.equal(failedResult.exitCode, 1, '会话复用 smoke 首次执行应模拟失败');
    const failedTask = contextTask('C001');
    assert.equal(failedTask.status, 'pending', '失败任务应回到 pending 以便重试');
    assert.equal(failedTask.codex_session_id, retrySessionId, '失败后应保存首次捕获的 session id');

    loop.runCodex = async (_workspace, prompt, label, operation = {}) => {
      assert.equal(_workspace, workspace, '重试执行应使用当前工作区');
      assert.match(prompt, /只执行指定任务 C001/, '重试执行 prompt 应锁定 C001');
      assert.equal(label, 'execute-C001', '重试执行 label 应包含任务 key');
      assert.equal(operation.planId, contextPlanId, '重试执行 operation 应绑定 plan');
      assert.equal(operation.taskId, retryTask.id, '重试执行 operation 应绑定 task');
      assert.equal(operation.codexSessionId, retrySessionId, '失败后再次执行应传入同一个 session id');
      await sleep(5);
      return {
        exitCode: 0,
        logFile: fakeLogFile,
        lastFile: path.join(logDir, 'context-c001-retry.txt'),
        codexSessionId: retrySessionId,
        codexSessionMode: 'resume',
      };
    };
    const retryResult = await loop.executeTask(workspace, contextPlan, failedTask);
    assert.equal(retryResult.exitCode, 0, '会话复用 smoke 重试应成功');
    loop.completeTask(workspace, contextPlan, failedTask, retryResult);
    const retriedTask = contextTask('C001');
    assert.equal(retriedTask.status, 'completed', '重试成功后任务应完成');
    assert.equal(retriedTask.codex_session_id, retrySessionId, '重试成功后应保留同一个 session id');

    const serialTask = contextTask('C007');
    loop.runCodex = async (_workspace, prompt, label, operation = {}) => {
      assert.equal(_workspace, workspace, '串行任务应使用当前工作区');
      assert.match(prompt, /只执行指定任务 C007/, '串行任务 prompt 应锁定当前任务');
      assert.match(prompt, /恢复同一 plan 前序任务的 Codex 会话/, '串行任务 prompt 应说明复用 plan 上下文');
      assert.equal(label, 'execute-C007', '串行任务 label 应包含当前任务 key');
      assert.equal(operation.planId, contextPlanId, '串行任务 operation 应绑定 plan');
      assert.equal(operation.taskId, serialTask.id, '串行任务 operation 应绑定 task');
      assert.equal(operation.codexSessionId, retrySessionId, '同一 plan 后续串行任务应继承前序 session id');
      await sleep(5);
      return {
        exitCode: 0,
        logFile: fakeLogFile,
        lastFile: path.join(logDir, 'context-c007-serial.txt'),
        codexSessionId: retrySessionId,
        codexSessionMode: 'resume',
      };
    };
    const serialResult = await loop.executeTask(workspace, contextPlan, serialTask);
    assert.equal(serialResult.exitCode, 0, '同一 plan 串行上下文 smoke 应成功');
    loop.completeTask(workspace, contextPlan, serialTask, serialResult);
    const completedSerialTask = contextTask('C007');
    assert.equal(completedSerialTask.status, 'completed', '串行继承任务应完成');
    assert.equal(completedSerialTask.codex_session_id, retrySessionId, '串行继承任务应保存同一个 session id');

    const parallelTasks = [contextTask('C002'), contextTask('C003')];
    const parallelSessions = new Map([
      [parallelTasks[0].id, parallelSessionA],
      [parallelTasks[1].id, parallelSessionB],
    ]);
    const seenParallelTaskIds = new Set();
    loop.runCodex = async (_workspace, prompt, label, operation = {}) => {
      const currentTask = parallelTasks.find((task) => task.id === operation.taskId);
      assert.ok(currentTask, '并发执行 operation 应绑定当前任务');
      assert.match(prompt, new RegExp(`只执行指定任务 ${currentTask.task_key}`), '并发执行 prompt 应锁定当前任务');
      assert.equal(label, `execute-${currentTask.task_key}`, '并发执行 label 应包含当前任务 key');
      assert.equal(operation.planId, contextPlanId, '并发执行 operation 应绑定 plan');
      assert.equal(operation.parallel, true, '并发执行 operation 应标记 parallel');
      assert.equal(operation.codexSessionId, undefined, '同一 plan 的不同任务首次执行不应复用其它 session id');
      seenParallelTaskIds.add(operation.taskId);
      await sleep(currentTask.task_key === 'C002' ? 10 : 1);
      return {
        exitCode: 0,
        logFile: fakeLogFile,
        lastFile: path.join(logDir, `context-${currentTask.task_key}.txt`),
        codexSessionId: parallelSessions.get(currentTask.id),
        codexSessionMode: 'new',
      };
    };
    const parallelResults = await loop.executeTaskBatch(workspace, contextPlan, parallelTasks);
    assert.deepEqual(
      parallelResults.map(({ result }) => result.exitCode),
      [0, 0],
      '并发会话 smoke 应全部执行成功',
    );
    assert.equal(seenParallelTaskIds.size, 2, '并发执行应覆盖两个独立任务');
    const parallelTaskA = contextTask('C002');
    const parallelTaskB = contextTask('C003');
    assert.equal(parallelTaskA.codex_session_id, parallelSessionA, '并发任务 A 应保存自己的 session id');
    assert.equal(parallelTaskB.codex_session_id, parallelSessionB, '并发任务 B 应保存自己的 session id');
    assert.notEqual(parallelTaskA.codex_session_id, parallelTaskB.codex_session_id, '并发任务 session id 应彼此独立');
    assert.notEqual(parallelTaskA.codex_session_id, retrySessionId, '并发任务 A 不应复用重试任务 session id');
    assert.notEqual(parallelTaskB.codex_session_id, retrySessionId, '并发任务 B 不应复用重试任务 session id');

    const syncKeptTask = contextTask('C004');
    const syncRenamedTask = contextTask('C005');
    loop.updateTaskCodexSession(syncKeptTask.id, syncKeptSessionId);
    loop.updateTaskCodexSession(syncRenamedTask.id, syncRenamedOldSessionId);
    fs.writeFileSync(
      contextPlanFile,
      [
        '# Context reuse smoke',
        '',
        '- [x] C001: 失败后复用上下文 <!-- scope: smoke/c001.js -->',
        '- [x] C002: 并发任务 A <!-- scope: smoke/c002.js -->',
        '- [x] C003: 并发任务 B <!-- scope: smoke/c003.js -->',
        '- [ ] C004: 同步保留上下文已更新 <!-- scope: smoke/c004-updated.js -->',
        '- [ ] C105: 同步改名新任务 <!-- scope: smoke/c105.js -->',
        '- [ ] C006: 同步新增任务 <!-- scope: smoke/c006.js -->',
        '',
      ].join('\n'),
      'utf8',
    );
    loop.syncPlanTasks(contextPlanId, contextPlanFile);
    const keptAfterSync = contextTask('C004');
    const renamedAfterSync = contextTask('C105');
    const addedAfterSync = contextTask('C006');
    assert.equal(keptAfterSync.id, syncKeptTask.id, 'sync 后同一 task_key 应保留原任务记录');
    assert.equal(keptAfterSync.codex_session_id, syncKeptSessionId, 'sync 后同一 task_key 应保留上下文');
    assert.match(keptAfterSync.raw_line, /c004-updated\.js/, 'sync 后同一 task_key 应更新 raw line');
    assert.equal(contextTask('C005'), null, '改名后的旧任务 key 应被移除');
    assert.ok(renamedAfterSync, '改名后的新任务 key 应入库');
    assert.equal(renamedAfterSync.codex_session_id, null, '改名任务不应继承旧 session id');
    assert.ok(addedAfterSync, '新增任务应入库');
    assert.equal(addedAfterSync.codex_session_id, null, '新增任务不应继承任何 session id');
  } finally {
    loop.runCodex = originalRunCodex;
  }
}

async function assertAgentCliBackendSmoke(db, loop, projectId, workspace) {
  assertRendererAgentCliTypeSmoke();

  const handlers = loadMainIpcHandlers(db, loop);
  const configureLoop = handlers.get('loop:configure');
  const snapshotProject = handlers.get('snapshot');
  assert.equal(typeof configureLoop, 'function', '主进程应注册 loop:configure IPC handler');
  assert.equal(typeof snapshotProject, 'function', '主进程应注册 snapshot IPC handler');

  // 默认后端兼容性：历史项目升级后应为 codex
  const defaultProvider = loop.snapshot(projectId).state.agent_cli_provider;
  assert.equal(defaultProvider, 'codex', '未配置的项目应默认使用 codex 后端');

  // 非法 provider 被规范化为 codex
  loop.configure(projectId, { agentCliProvider: 'zai' });
  assert.equal(loop.snapshot(projectId).state.agent_cli_provider, 'codex', '非法后端应被规范化为 codex');

  // 切到 claude：配置能持久化并通过 snapshot 返回
  loop.configure(projectId, { agentCliProvider: 'claude', agentCliCommand: '' });
  let claudeState = loop.snapshot(projectId).state;
  assert.equal(claudeState.agent_cli_provider, 'claude', '应能切换到 claude 后端');

  const ipcConfiguredSnapshot = configureLoop(null, {
    projectId,
    agentCliProvider: 'claude',
    agentCliCommand: 'claude-smoke',
  });
  assert.equal(ipcConfiguredSnapshot.state.agent_cli_provider, 'claude', 'IPC 配置应保存 claude 后端');
  assert.equal(ipcConfiguredSnapshot.state.agent_cli_command, 'claude-smoke', 'IPC 配置应保存自定义 CLI 命令');
  const ipcReadBackSnapshot = snapshotProject(null, { projectId });
  assert.equal(ipcReadBackSnapshot.state.agent_cli_provider, 'claude', '快照应返回 IPC 保存的后端');
  assert.equal(ipcReadBackSnapshot.state.agent_cli_command, 'claude-smoke', '快照应返回 IPC 保存的 CLI 命令');
  loop.configure(projectId, { agentCliProvider: 'claude', agentCliCommand: '' });

  // 用一个拦截 spawn 的全新 loopService 副本验证 runCodex 的后端路由与会话隔离：
  // - claude 后端即便任务带 codex_session_id，也不会进入 resume 分支，spawn 的是 claude 命令
  // - 切回 codex 后，spawn 的是 codex 命令且会尝试 resume 传入的 session
  const spawned = [];
  const fallbackSessionId = '99999999-9999-4999-8999-999999999999';
  const fallbackNewSessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const freshSessionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const codexFreshSessionIds = [fallbackNewSessionId, freshSessionId];
  const { LoopService: PatchedLoopService } = loadPatchedLoopService({
    spawnOverride: (command, args, options) => {
      const entry = { command, args, options, prompt: '' };
      spawned.push(entry);
      const isCodexResume = commandName(command) === 'codex' && args.includes('resume');
      const isFallbackResume = args.includes(fallbackSessionId);
      const isCodexFresh = commandName(command) === 'codex' && !isCodexResume;
      return createFakeChild({
        exitCode: isFallbackResume ? 1 : 0,
        output: isFallbackResume
          ? 'resume failed: no rollout found\n'
          : isCodexFresh
            ? `Session ID: ${codexFreshSessionIds.shift() || freshSessionId}\n`
            : 'fake agent output\n',
        onPrompt: (prompt) => {
          entry.prompt = prompt;
          const planMatch = prompt.match(/输出文件：(.+)/);
          if (planMatch) {
            const generatedPlanFile = planMatch[1].trim();
            fs.mkdirSync(path.dirname(generatedPlanFile), { recursive: true });
            fs.writeFileSync(
              generatedPlanFile,
              ['# Claude backend smoke', '', '- [ ] B002: Claude 生成后执行 <!-- scope: smoke/b002.js -->', ''].join('\n'),
              'utf8',
            );
          }
        },
      });
    },
  });
  const patchedLoop = new PatchedLoopService(db);

  spawned.length = 0;
  const backendIssueScan = {
    aggregateHash: 'smoke-backend-issue-hash',
    files: [
      {
        path: path.join('docs', 'issues', 'backend-smoke.md'),
        hash: 'smoke-backend-issue-file-hash',
      },
    ],
  };
  fs.mkdirSync(path.join(workspace, 'docs', 'issues'), { recursive: true });
  fs.writeFileSync(
    path.join(workspace, backendIssueScan.files[0].path),
    '# Backend smoke\n\n验证 Claude 后端可生成计划。\n',
    'utf8',
  );
  await patchedLoop.generatePlan(projectId, workspace, backendIssueScan);
  assert.ok(spawned.some((entry) => commandName(entry.command) === 'claude'), 'Claude 计划生成应走 claude 后端');
  assert.equal(
    spawned[0].options.env.PUB_CACHE,
    path.join(workspace, '.autoplan-runtime', 'pub-cache'),
    'agent CLI should receive workspace-local PUB_CACHE',
  );
  assert.ok(
    spawned.every((entry) => commandName(entry.command) === 'claude' && entry.args.includes('--print')),
    'Claude 计划生成不应回退到 codex 命令',
  );
  assertNoSpawnArg(spawned, 'resume', 'Claude 计划生成不应使用 Codex resume 参数');
  const generatedPlan = db.get('SELECT * FROM plans WHERE issue_hash = ?', [backendIssueScan.aggregateHash]);
  assert.ok(generatedPlan, 'Claude 后端应能通过 stub 生成计划并入库');
  assertPlanCliSnapshot(generatedPlan, {
    provider: 'claude',
    command: 'claude',
    effort: null,
  }, 'Claude 生成计划数据库快照');
  const generatedPlanSnapshot = patchedLoop.snapshot(projectId).plans.find((plan) => plan.id === generatedPlan.id);
  assertPlanCliSnapshot(generatedPlanSnapshot, {
    provider: 'claude',
    command: 'claude',
    effort: null,
  }, 'Claude 生成计划前端快照');
  assert.equal(formatPlanCliSummary(generatedPlanSnapshot), 'Claude CLI', 'Claude 计划展示不应包含 Codex 思考深度');
  const generatedTask = db.get('SELECT * FROM plan_tasks WHERE plan_id = ? AND task_key = ?', [
    generatedPlan.id,
    'B002',
  ]);
  assert.ok(generatedTask, 'Claude 生成计划后应同步任务列表');
  patchedLoop.updateTaskCodexSession(generatedTask.id, '00000000-0000-4000-8000-000000000000');

  spawned.length = 0;
  const claudeTaskResult = await patchedLoop.executeTask(workspace, generatedPlan, generatedTask);
  assert.equal(claudeTaskResult.exitCode, 0, 'Claude 后端任务执行应成功');
  assert.ok(spawned.some((entry) => commandName(entry.command) === 'claude'), 'Claude 任务执行应走 claude 后端');
  assert.ok(spawned.every((entry) => commandName(entry.command) === 'claude'), 'Claude 任务执行不应回退到 codex 命令');
  assertNoSpawnArg(spawned, '00000000-0000-4000-8000-000000000000', 'Claude 任务执行不应传入 codexSessionId');
  assertNoSpawnArg(spawned, 'resume', 'Claude 任务执行不应使用 Codex resume 参数');
  assert.equal(claudeTaskResult.codexSessionId, undefined, 'Claude 任务执行结果不应包含 Codex session');

  // 任务预先持有一个 codex session id，模拟历史上下文
  const claudePlanRel = path.join('docs', 'plan', 'backend-claude-smoke.md');
  const claudePlanFile = path.join(workspace, claudePlanRel);
  fs.mkdirSync(path.dirname(claudePlanFile), { recursive: true });
  fs.writeFileSync(claudePlanFile, '- [ ] B001: claude 后端执行 <!-- scope: smoke/b001.js -->\n', 'utf8');
  const claudePlanId = db.insert(
    `INSERT INTO plans (project_id, issue_hash, file_path, hash, status, total_tasks, completed_tasks, validation_passed, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [projectId, 'smoke-backend-claude', claudePlanRel, '', 'running', 0, 0, 0, nowIso(), nowIso()],
  );
  patchedLoop.syncPlanTasks(claudePlanId, claudePlanFile);
  const claudeTask = db.get('SELECT * FROM plan_tasks WHERE plan_id = ? AND task_key = ?', [claudePlanId, 'B001']);
  patchedLoop.updateTaskCodexSession(claudeTask.id, '00000000-0000-4000-8000-000000000000');

  spawned.length = 0;
  const claudeResult = await patchedLoop.runCodex(workspace, '执行 claude 任务', 'execute-B001', {
    projectId,
    planId: claudePlanId,
    taskId: claudeTask.id,
    codexSessionId: '00000000-0000-4000-8000-000000000000',
  });
  assert.equal(claudeResult.exitCode, 0, 'claude 后端执行应成功');
  assert.ok(spawned.length >= 1, 'claude 后端应至少 spawn 一次');
  assert.equal(commandName(spawned[0].command), 'claude', 'claude 后端应调用 claude 命令');
  assert.ok(
    spawned.every((entry) => commandName(entry.command) === 'claude' && entry.args.includes('--print')),
    'claude 后端不应回退到 codex 命令',
  );
  // claude 后端不应返回 codex 会话信息
  assert.equal(claudeResult.codexSessionId, undefined, 'claude 后端不应产出 codex session id');

  // 切回 codex：同一个 session id 应触发 resume（spawn 命令为 codex 且只 spawn 一次）
  loop.configure(projectId, { agentCliProvider: 'codex' });
  assert.equal(loop.snapshot(projectId).state.agent_cli_provider, 'codex', '应能切回 codex 后端');
  spawned.length = 0;
  const codexResult = await patchedLoop.runCodex(workspace, '执行 codex 任务', 'execute-B001', {
    projectId,
    planId: claudePlanId,
    taskId: claudeTask.id,
    codexSessionId: '00000000-0000-4000-8000-000000000000',
  });
  assert.equal(codexResult.exitCode, 0, 'codex 后端执行应成功');
  assert.equal(spawned.length, 1, 'codex 后端带 session id 应只 resume 一次');
  assert.equal(commandName(spawned[0].command), 'codex', 'codex 后端应调用 codex 命令');
  assert.ok(spawned[0].args.includes('resume'), 'codex 后端应使用 resume 参数复用 session');
  assert.equal(codexResult.resumed, true, 'codex 后端应复用传入的 session');

  spawned.length = 0;
  const fallbackResult = await patchedLoop.runCodex(workspace, '执行 codex fallback 任务', 'execute-B002', {
    projectId,
    planId: claudePlanId,
    taskId: claudeTask.id,
    codexSessionId: fallbackSessionId,
  });
  assert.equal(fallbackResult.exitCode, 0, 'codex resume 失败后应回退新建成功');
  assert.equal(spawned.length, 2, 'codex resume 失败后应先 resume 再新建');
  assert.deepEqual(
    spawned.map((entry) => commandName(entry.command)),
    ['codex', 'codex'],
    'codex fallback 全程应使用 codex 命令',
  );
  assert.ok(spawned[0].args.includes('resume'), 'codex fallback 第一次应尝试 resume');
  assert.ok(!spawned[1].args.includes('resume'), 'codex fallback 第二次应新建会话');
  assert.equal(fallbackResult.codexSessionId, fallbackNewSessionId, 'codex fallback 应记录新建 session id');
  assert.equal(fallbackResult.codexSessionFallback, true, 'codex fallback 结果应标记回退新建');

  spawned.length = 0;
  const freshResult = await patchedLoop.runCodex(workspace, '执行 codex new 任务', 'execute-B003', {
    projectId,
    planId: claudePlanId,
    taskId: claudeTask.id,
  });
  assert.equal(freshResult.exitCode, 0, 'codex 无 session 时应新建成功');
  assert.equal(spawned.length, 1, 'codex 无 session 时应只 spawn 一次');
  assert.equal(commandName(spawned[0].command), 'codex', 'codex 新建会话应调用 codex 命令');
  assert.ok(!spawned[0].args.includes('resume'), 'codex 无 session 时不应尝试 resume');
  assert.equal(freshResult.codexSessionId, freshSessionId, 'codex 新建会话应记录新 session id');
  assert.equal(freshResult.codexSessionMode, 'new', 'codex 新建会话应标记 new 模式');
}

async function assertFeedback10RegressionSmoke(db, loop, tempRoot) {
  const regressionWorkspace = path.join(tempRoot, 'feedback10-regression');
  const regressionProjectId = insertProject(db, loop, 'Feedback #10 Regression', regressionWorkspace);
  loop.configure(regressionProjectId, {
    workspacePath: regressionWorkspace,
    intervalSeconds: 5,
    validationCommand: '',
    agentCliProvider: 'codex',
    agentCliCommand: '',
    codexReasoningEffort: 'medium',
  });
  loop.ensureWorkspaceDirs(regressionWorkspace);

  const regressionState = loop.snapshot(regressionProjectId).state;
  assert.equal(regressionState.agent_cli_provider, 'codex', 'P006 回归项目默认后端应为 codex');
  assert.equal(regressionState.validation_command, '', 'P006 回归项目验收命令应保持为空字符串');

  const emptyValidationPlanRel = path.join('docs', 'plan', 'feedback10-empty-validation.md');
  const emptyValidationPlanFile = path.join(regressionWorkspace, emptyValidationPlanRel);
  fs.mkdirSync(path.dirname(emptyValidationPlanFile), { recursive: true });
  fs.writeFileSync(
    emptyValidationPlanFile,
    ['# Feedback 10 空验收 smoke', '', '- [x] V001: 空验收命令跳过外部命令 <!-- scope: smoke/validation.js -->', ''].join('\n'),
    'utf8',
  );
  const emptyValidationPlanId = insertPlan(
    db,
    regressionProjectId,
    emptyValidationPlanRel,
    'feedback10-empty-validation',
  );
  await loop.validatePlan(
    regressionWorkspace,
    db.get('SELECT * FROM plans WHERE id = ?', [emptyValidationPlanId]),
  );
  const emptyValidationPlan = db.get('SELECT * FROM plans WHERE id = ?', [emptyValidationPlanId]);
  assert.equal(emptyValidationPlan.status, 'completed', '空验收命令应直接完成 plan');
  assert.equal(emptyValidationPlan.validation_passed, 1, '空验收命令应标记 validation_passed');
  const emptyValidationEvent = db.get(
    `SELECT * FROM events
     WHERE project_id = ? AND type = 'plan.completed'
     ORDER BY id DESC LIMIT 1`,
    [regressionProjectId],
  );
  assert.match(emptyValidationEvent.message, /验收命令为空/, '空验收命令应记录跳过说明');

  const blockedValidationPlanRel = path.join('docs', 'plan', 'feedback10-blocked-validation.md');
  const blockedValidationPlanFile = path.join(regressionWorkspace, blockedValidationPlanRel);
  fs.mkdirSync(path.dirname(blockedValidationPlanFile), { recursive: true });
  fs.writeFileSync(
    blockedValidationPlanFile,
    ['# Feedback 10 blocked validation smoke', '', '- [x] V002: blocked validation <!-- scope: smoke/validation.js -->', ''].join('\n'),
    'utf8',
  );
  const blockedValidationPlanId = insertPlan(
    db,
    regressionProjectId,
    blockedValidationPlanRel,
    'feedback10-blocked-validation',
  );
  const blockedValidationLog = path.join(regressionWorkspace, 'docs', 'progress', 'logs', 'blocked-validation.log');
  fs.mkdirSync(path.dirname(blockedValidationLog), { recursive: true });
  fs.writeFileSync(blockedValidationLog, 'PathAccessException: Permission denied while reading .dart_tool', 'utf8');
  const originalRunShell = loop.runShell.bind(loop);
  const originalRunCodex = loop.runCodex.bind(loop);
  let repairCalled = false;
  loop.configure(regressionProjectId, { validationCommand: 'flutter test' });
  try {
    loop.runShell = async () => ({
      exitCode: 1,
      output: 'PathAccessException: Permission denied while reading .dart_tool',
      errorMessage: 'PathAccessException: Permission denied while reading .dart_tool',
      logFile: blockedValidationLog,
    });
    loop.runCodex = async () => {
      repairCalled = true;
      return { exitCode: 0, logFile: blockedValidationLog, lastFile: blockedValidationLog };
    };
    await loop.validatePlan(
      regressionWorkspace,
      db.get('SELECT * FROM plans WHERE id = ?', [blockedValidationPlanId]),
    );
  } finally {
    loop.runShell = originalRunShell;
    loop.runCodex = originalRunCodex;
    loop.configure(regressionProjectId, { validationCommand: '' });
  }
  assert.equal(repairCalled, false, 'environment-blocked validation should not launch repair agent');
  const blockedValidationEvent = db.get(
    `SELECT * FROM events
     WHERE project_id = ? AND type = 'validation.blocked'
     ORDER BY id DESC LIMIT 1`,
    [regressionProjectId],
  );
  assert.ok(blockedValidationEvent, 'environment-blocked validation should emit validation.blocked');
  const blockedValidationMeta = JSON.parse(blockedValidationEvent.meta);
  assert.equal(blockedValidationMeta.failureKind, 'environment_permission', 'validation.blocked should classify permission blockers');
  assert.equal(blockedValidationMeta.environmentBlocked, true, 'validation.blocked should mark environment blockers');

  const handlers = loadMainIpcHandlers(db, loop);
  const createRequirement = handlers.get('requirements:create');
  const createFeedback = handlers.get('feedback:create');
  assert.equal(typeof createRequirement, 'function', '主进程应注册 requirements:create IPC handler');
  assert.equal(typeof createFeedback, 'function', '主进程应注册 feedback:create IPC handler');

  const requirementBody = 'P006 回归需求：使用 Codex high 思考深度生成计划';
  createRequirement(null, {
    projectId: regressionProjectId,
    body: requirementBody,
    agentCliProvider: 'codex',
    agentCliCommand: '',
    codexReasoningEffort: 'high',
  });
  const requirement = db.get('SELECT * FROM requirements WHERE project_id = ? AND body = ?', [
    regressionProjectId,
    requirementBody,
  ]);
  assert.equal(requirement.agent_cli_provider, 'codex', '需求单条配置应保存 codex 后端');
  assert.equal(requirement.codex_reasoning_effort, 'high', '需求单条配置应保存 Codex high 思考深度');

  const feedbackBody = 'P006 回归反馈：使用 Claude 生成计划';
  createFeedback(null, {
    projectId: regressionProjectId,
    body: feedbackBody,
    agentCliProvider: 'claude',
    agentCliCommand: '',
    codexReasoningEffort: 'high',
  });
  const feedback = db.get('SELECT * FROM feedback WHERE project_id = ? AND body = ?', [
    regressionProjectId,
    feedbackBody,
  ]);
  assert.equal(feedback.agent_cli_provider, 'claude', '反馈单条配置应保存 claude 后端');
  assert.equal(feedback.codex_reasoning_effort, null, '反馈选择 Claude 时应忽略 Codex 思考深度');

  const spawned = [];
  const codexSessionId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const { LoopService: PatchedLoopService } = loadPatchedLoopService({
    spawnOverride: (command, args, options) => {
      const entry = { command, args, options, prompt: '' };
      spawned.push(entry);
      return createFakeChild({
        output: commandName(command) === 'codex' ? `Session ID: ${codexSessionId}\n` : 'fake claude output\n',
        onPrompt: (prompt) => {
          entry.prompt = prompt;
          const planMatch = prompt.match(/输出文件：(.+)/);
          if (!planMatch) return;
          const generatedPlanFile = planMatch[1].trim();
          const isClaude = commandName(command) === 'claude';
          const taskKey = isClaude ? 'F010' : 'R010';
          fs.mkdirSync(path.dirname(generatedPlanFile), { recursive: true });
          fs.writeFileSync(
            generatedPlanFile,
            [
              isClaude ? '# Feedback Claude override smoke' : '# Requirement Codex high smoke',
              '',
              `- [ ] ${taskKey}: 单条配置生成计划 <!-- scope: smoke/${taskKey.toLowerCase()}.js -->`,
              '',
            ].join('\n'),
            'utf8',
          );
        },
      });
    },
  });
  const patchedLoop = new PatchedLoopService(db);

  spawned.length = 0;
  const requirementPlanId = await patchedLoop.generatePlanForIntake(regressionProjectId, regressionWorkspace, {
    ...requirement,
    __type: 'requirement',
  });
  assert.ok(requirementPlanId, 'Codex high 需求应通过 stub 生成计划');
  assert.equal(spawned.length, 1, 'Codex high 需求生成计划应只 spawn 一次');
  assert.equal(commandName(spawned[0].command), 'codex', 'Codex high 需求应调用 codex 命令');
  assertCodexReasoningArg(spawned[0], 'high', 'Codex high 需求');
  const linkedRequirement = db.get('SELECT linked_plan_id FROM requirements WHERE id = ?', [requirement.id]);
  assert.equal(linkedRequirement.linked_plan_id, requirementPlanId, 'Codex high 需求应回写 linked_plan_id');
  const requirementEventMeta = latestPlanGeneratedMeta(db, regressionProjectId, requirementPlanId);
  assert.equal(requirementEventMeta.agentCliProvider, 'codex', 'Codex high 需求事件应记录 codex 后端');
  assert.equal(requirementEventMeta.codexReasoningEffort, 'high', 'Codex high 需求事件应记录思考深度');
  assertPlanCliSnapshot(db.get('SELECT * FROM plans WHERE id = ?', [requirementPlanId]), {
    provider: 'codex',
    command: 'codex',
    effort: 'high',
  }, 'Codex high 需求计划数据库快照');
  const requirementPlanSnapshot = patchedLoop.snapshot(regressionProjectId).plans.find((plan) => plan.id === requirementPlanId);
  assertPlanCliSnapshot(requirementPlanSnapshot, {
    provider: 'codex',
    command: 'codex',
    effort: 'high',
  }, 'Codex high 需求计划前端快照');
  assert.equal(formatPlanCliSummary(requirementPlanSnapshot), 'Codex CLI · 思考深度 high', 'Codex high 计划展示应包含思考深度');

  spawned.length = 0;
  const feedbackPlanId = await patchedLoop.generatePlanForIntake(regressionProjectId, regressionWorkspace, {
    ...feedback,
    __type: 'feedback',
  });
  assert.ok(feedbackPlanId, 'Claude 反馈应通过 stub 生成计划');
  assert.equal(spawned.length, 1, 'Claude 反馈生成计划应只 spawn 一次');
  assert.equal(commandName(spawned[0].command), 'claude', 'Claude 反馈应调用 claude 命令');
  assert.ok(spawned[0].args.includes('--print'), 'Claude 反馈应使用 print 模式');
  assertNoSpawnArg(spawned, 'model_reasoning_effort', 'Claude 反馈不应携带 Codex 思考深度参数');
  const linkedFeedback = db.get('SELECT linked_plan_id FROM feedback WHERE id = ?', [feedback.id]);
  assert.equal(linkedFeedback.linked_plan_id, feedbackPlanId, 'Claude 反馈应回写 linked_plan_id');
  const feedbackEventMeta = latestPlanGeneratedMeta(db, regressionProjectId, feedbackPlanId);
  assert.equal(feedbackEventMeta.agentCliProvider, 'claude', 'Claude 反馈事件应记录 claude 后端');
  assert.equal(feedbackEventMeta.codexReasoningEffort, undefined, 'Claude 反馈事件不应记录 Codex 思考深度');
  assertPlanCliSnapshot(db.get('SELECT * FROM plans WHERE id = ?', [feedbackPlanId]), {
    provider: 'claude',
    command: 'claude',
    effort: null,
  }, 'Claude 反馈计划数据库快照');
  const feedbackPlanSnapshot = patchedLoop.snapshot(regressionProjectId).plans.find((plan) => plan.id === feedbackPlanId);
  assertPlanCliSnapshot(feedbackPlanSnapshot, {
    provider: 'claude',
    command: 'claude',
    effort: null,
  }, 'Claude 反馈计划前端快照');
  assert.equal(formatPlanCliSummary(feedbackPlanSnapshot), 'Claude CLI', 'Claude 反馈计划展示不应包含 Codex 思考深度');
}

function assertRendererAgentCliTypeSmoke() {
  const typeSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'types.ts'), 'utf8');
  assert.match(typeSource, /interface Project[\s\S]*agent_cli_provider\?: AgentCliProvider;/, 'Project 类型应包含后端字段');
  assert.match(typeSource, /interface Project[\s\S]*codex_reasoning_effort\?: CodexReasoningEffort \| null;/, 'Project 类型应包含 Codex 思考深度字段');
  assert.match(typeSource, /interface ProjectState[\s\S]*agent_cli_provider\?: AgentCliProvider;/, 'ProjectState 类型应包含后端字段');
  assert.match(typeSource, /interface Plan[\s\S]*agent_cli_provider\?: AgentCliProvider \| null;/, 'Plan 类型应包含计划级后端字段');
  assert.match(typeSource, /interface Plan[\s\S]*codex_reasoning_effort\?: CodexReasoningEffort \| null;/, 'Plan 类型应包含计划级 Codex 思考深度字段');
  assert.match(typeSource, /interface AgentCliDisplaySource[\s\S]*agentCliProvider\?: AgentCliProvider \| null;/, '展示格式化输入类型应兼容驼峰字段');
  assert.match(typeSource, /interface CreateIntakeInput[\s\S]*agentCliProvider\?: AgentCliProvider;/, '创建需求/反馈输入类型应允许选择后端');
  assert.match(typeSource, /interface CreateIntakeInput[\s\S]*codexReasoningEffort\?: CodexReasoningEffort;/, '创建需求/反馈输入类型应允许设置 Codex 思考深度');
  assert.match(typeSource, /interface CreateProjectInput[\s\S]*agentCliProvider\?: AgentCliProvider;/, '创建项目输入类型应允许选择后端');
  assert.match(typeSource, /interface LoopConfigInput[\s\S]*agentCliProvider\?: AgentCliProvider;/, '循环配置输入类型应允许选择后端');
  assert.match(typeSource, /interface LoopConfigInput[\s\S]*validation_command\?: string;/, '循环配置输入类型应兼容下划线验收命令字段');
  assert.match(typeSource, /interface LoopConfigInput[\s\S]*codexReasoningEffort\?: CodexReasoningEffort;/, '循环配置输入类型应允许设置 Codex 思考深度');
  assert.equal(formatPlanCliSummary({ agentCliProvider: 'codex', codexReasoningEffort: 'high' }), 'Codex CLI · 思考深度 high', '计划 CLI 文案应兼容驼峰字段');
  assert.equal(formatPlanCliSummary({ agent_cli_provider: 'claude', codex_reasoning_effort: 'high' }), 'Claude CLI', 'Claude 计划 CLI 文案不应展示 Codex 思考深度');
  assert.equal(formatPlanCliSummary({}), 'Codex CLI · 思考深度 medium', '空计划 CLI 字段应按历史默认降级');
}

function assertPlanCliSnapshot(plan, expected, label) {
  assert.ok(plan, `${label} 应存在`);
  assert.equal(plan.agent_cli_provider, expected.provider, `${label} 应记录 CLI 后端`);
  assert.equal(plan.agent_cli_command || '', expected.command || '', `${label} 应记录 CLI 命令快照`);
  assert.equal(plan.codex_reasoning_effort ?? null, expected.effort, `${label} 应记录 Codex 思考深度快照`);
}

function formatPlanCliSummary(source) {
  const { planCliSummaryLabel } = loadRendererTsModule(
    path.join(__dirname, '..', 'src', 'renderer', 'components', 'shared.tsx'),
  );
  return planCliSummaryLabel(source);
}

function assertNoSpawnArg(spawned, value, message) {
  assert.ok(
    spawned.every((entry) => !entry.args.some((arg) => String(arg).includes(value))),
    message,
  );
}

function assertCodexReasoningArg(entry, effort, label) {
  const configIndex = entry.args.indexOf('-c');
  assert.notEqual(configIndex, -1, `${label} 应传入 Codex -c 配置参数`);
  assert.equal(
    entry.args[configIndex + 1],
    `model_reasoning_effort="${effort}"`,
    `${label} 应把思考深度转换为 Codex model_reasoning_effort 参数`,
  );
}

function latestPlanGeneratedMeta(db, projectId, planId) {
  const event = db.get(
    `SELECT * FROM events
     WHERE project_id = ? AND type = 'plan.generated'
     ORDER BY id DESC`,
    [projectId],
  );
  assert.ok(event, '应记录 plan.generated 事件');
  const meta = event.meta ? JSON.parse(event.meta) : {};
  assert.equal(meta.planId, planId, 'plan.generated 事件应对应当前 plan');
  return meta;
}

function commandName(command) {
  return path.basename(String(command || '')).replace(/\.(?:cmd|bat|exe)$/i, '').toLowerCase();
}

function loadPatchedLoopService({ spawnOverride }) {
  const loopServicePath = path.join(__dirname, '..', 'src', 'loopService.js');
  const source = fs.readFileSync(loopServicePath, 'utf8');
  const module = { exports: {} };
  const patchedAgentCli = loadPatchedAgentCli({ spawnOverride });
  const fakeChildProcess = {
    spawn: (command, args, options) => spawnOverride(command, args, options),
  };
  const localRequire = (request) => {
    if (request === 'node:child_process') return fakeChildProcess;
    if (request === './database') return { nowIso };
    if (request === './agentCli') return patchedAgentCli;
    if (request === './codexActivity' || request.startsWith('./loop/')) return require(path.join(path.dirname(loopServicePath), request));
    return require(request);
  };
  vm.runInNewContext(
    source,
    {
      require: localRequire,
      module,
      exports: module.exports,
      __dirname: path.dirname(loopServicePath),
      __filename: loopServicePath,
      Buffer,
      clearTimeout,
      console,
      process,
      setTimeout,
      setInterval,
      clearInterval,
    },
    { filename: loopServicePath },
  );
  assert.equal(typeof module.exports.LoopService, 'function', 'patched loopService 应导出 LoopService');
  return module.exports;
}

function loadPatchedAgentCli({ spawnOverride }) {
  const agentCliPath = path.join(__dirname, '..', 'src', 'agentCli.js');
  const source = fs.readFileSync(agentCliPath, 'utf8');
  const module = { exports: {} };
  const fakeChildProcess = {
    spawn: (command, args, options) => spawnOverride(command, args, options),
  };
  const localRequire = (request) => {
    if (request === 'node:child_process') return fakeChildProcess;
    return require(request);
  };
  vm.runInNewContext(
    source,
    {
      require: localRequire,
      module,
      exports: module.exports,
      __dirname: path.dirname(agentCliPath),
      __filename: agentCliPath,
      Buffer,
      clearTimeout,
      console,
      process,
      setTimeout,
    },
    { filename: agentCliPath },
  );
  return module.exports;
}

function createFakeChild(options = {}) {
  const { EventEmitter } = require('node:events');
  const child = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdin.setDefaultEncoding = () => {};
  child.stdin.end = (prompt = '') => {
    if (typeof options.onPrompt === 'function') options.onPrompt(String(prompt || ''));
    child.stdout.emit('data', Buffer.from(options.output || 'fake agent output\n', 'utf8'));
    setImmediate(() => child.emit('exit', typeof options.exitCode === 'number' ? options.exitCode : 0));
  };
  child.stdout = new EventEmitter();
  child.stdout.pipe = () => {};
  child.stderr = new EventEmitter();
  child.stderr.pipe = () => {};
  child.killed = false;
  child.kill = () => {};
  child.pid = Math.floor(Math.random() * 1e6);
  return child;
}

function createSpawnOnlyChild() {
  const { EventEmitter } = require('node:events');
  const child = new EventEmitter();
  child.unref = () => {};
  child.kill = () => {};
  child.killed = false;
  child.pid = Math.floor(Math.random() * 1e6);
  setImmediate(() => child.emit('spawn'));
  return child;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function taskByKey(snapshot, taskKey) {
  return snapshot.tasks.find((task) => task.task_key === taskKey);
}

function taskEventsByKey(snapshot, taskKey) {
  return snapshot.events.filter((event) => event.meta?.taskKey === taskKey);
}

function assertTaskEventOrder(events, expectedTypes, label) {
  assert.deepEqual(
    events.slice(0, expectedTypes.length).map((event) => event.type),
    expectedTypes,
    `${label} 应按最新事件在前返回`,
  );
  for (let index = 1; index < expectedTypes.length; index += 1) {
    assert.ok(events[index - 1].id > events[index].id, `${label} 应按事件 id 倒序排列`);
  }
}

function assertTaskEventMeta(event, task, status, label) {
  assert.ok(event, `${label} 应存在`);
  assert.ok(event.meta && typeof event.meta === 'object', `${label} 应包含结构化 meta`);
  assert.equal(event.meta.taskId, task.id, `${label} meta 应包含 taskId`);
  assert.equal(event.meta.taskKey, task.task_key, `${label} meta 应包含 taskKey`);
  assert.equal(event.meta.taskTitle, task.title, `${label} meta 应包含 taskTitle`);
  assert.equal(event.meta.planId, task.plan_id, `${label} meta 应包含 planId`);
  assert.equal(event.meta.status, status, `${label} meta 应包含任务状态`);
  if (event.meta.startedAt) assertIsoString(event.meta.startedAt, `${label} meta startedAt 应为 ISO 时间`);
  if (event.meta.finishedAt) assertIsoString(event.meta.finishedAt, `${label} meta finishedAt 应为 ISO 时间`);
}

function hasTaskDurationShape(task) {
  if (!task) return false;
  const hasStartedAt = task.started_at === null || typeof task.started_at === 'string';
  const hasFinishedAt = task.finished_at === null || typeof task.finished_at === 'string';
  const hasDurationMs = typeof task.duration_ms === 'number' && Number.isFinite(task.duration_ms);
  const hasRunDurationMs =
    !Object.prototype.hasOwnProperty.call(task, 'run_duration_ms') ||
    (typeof task.run_duration_ms === 'number' && Number.isFinite(task.run_duration_ms));
  return hasStartedAt && hasFinishedAt && hasDurationMs && hasRunDurationMs;
}

function assertTaskDurationShape(task, label) {
  assert.ok(task, `${label} 应存在`);
  assert.ok(hasTaskDurationShape(task), `${label} 应包含符合前端类型预期的耗时字段`);
}

function assertIsoString(value, message) {
  assert.equal(typeof value, 'string', message);
  assert.ok(Number.isFinite(Date.parse(value)), message);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
