const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { saveAttachments } = require('../src/attachments');
const { AppDatabase, nowIso } = require('../src/database');
const { LoopService } = require('../src/loopService');

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
    loop.runCodex = async (_workspace, prompt) => {
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

    console.log('smoke ok: projects, scoped snapshots, attachments, attachment prompts, plan reader, scope concurrency, scope file open, search, task acceptance, task events, scan, validation, duration stats, codex session reuse, multi-backend, multi-loop');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function assertWorkspaceSearchRegression(snapshot) {
  const { searchWorkspaceSnapshot } = loadRendererTsModule(
    path.join(__dirname, '..', 'src', 'renderer', 'utils', 'search.ts'),
  );

  assertSearchHit(
    searchWorkspaceSnapshot(snapshot, '普通文本需求'),
    'requirement',
    'title',
    /普通文本需求/,
    '搜索应支持需求标题命中',
  );
  assertSearchHit(
    searchWorkspaceSnapshot(snapshot, '重点内容'),
    'feedback',
    'body',
    /重点内容/,
    '搜索应支持反馈正文命中',
  );
  assertSearchHit(
    searchWorkspaceSnapshot(snapshot, 'P002'),
    'task',
    'taskKey',
    /P002/,
    '搜索应支持任务 key 命中',
  );
  assertSearchHit(
    searchWorkspaceSnapshot(snapshot, 'fake-execute.log'),
    'event',
    'eventMeta',
    /fake-execute\.log/,
    '搜索应支持事件元信息命中',
  );

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
    if (request === './codexActivity') return require('../src/codexActivity');
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
