const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AppDatabase, nowIso } = require('../database');
const { LoopService } = require('../loopService');
const { MCP_TOOL_NAMES, callMcpTool } = require('../mcpTools');

async function createFixture({ validationCommand = '' } = {}) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autoplan-validation-'));
  const workspace = path.join(tempRoot, 'workspace');
  const db = new AppDatabase(path.join(tempRoot, 'autoplan.sqlite'));
  await db.init();
  const loop = new LoopService(db);
  const projectId = loop.defaultProjectId();
  loop.configure(projectId, { workspacePath: workspace, validationCommand });
  loop.ensureWorkspaceDirs(workspace);
  return {
    db,
    loop,
    projectId,
    workspace,
    destroy() {
      loop.flushPendingUpdates();
      fs.rmSync(tempRoot, { recursive: true, force: true });
    },
  };
}

function insertPlan(fixture, name, taskLines = ['- [x] P001: 完成实现 <!-- scope: src/example.js -->']) {
  const planRel = path.join('docs', 'plan', `${name}.md`);
  const planFile = path.join(fixture.workspace, planRel);
  fs.mkdirSync(path.dirname(planFile), { recursive: true });
  fs.writeFileSync(planFile, ['# Validation regression', '', ...taskLines, ''].join('\n'), 'utf8');
  const now = nowIso();
  const planId = fixture.db.insert(
    `INSERT INTO plans
       (project_id, issue_hash, file_path, hash, status, sort_order, total_tasks, completed_tasks, validation_passed, agent_cli_command, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [fixture.projectId, name, planRel, `${name}-hash`, 'running', 1, 0, 0, 0, '', now, now],
  );
  fixture.loop.syncPlanTasks(planId, planFile);
  return fixture.db.get('SELECT * FROM plans WHERE id = ?', [planId]);
}

function insertIntake(db, table, projectId, linkedPlanId, status = 'open') {
  const now = nowIso();
  if (table === 'requirements') {
    return db.insert(
      `INSERT INTO requirements (project_id, title, body, status, linked_plan_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [projectId, '验证回归需求', '计划完成后需求应同步完成', status, linkedPlanId, now, now],
    );
  }
  return db.insert(
    `INSERT INTO feedback (project_id, requirement_id, title, body, status, linked_plan_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [projectId, null, '验证回归反馈', '计划完成后反馈应同步完成', status, linkedPlanId, now, now],
  );
}

function statusOf(db, table, id) {
  return db.get(`SELECT status FROM ${table} WHERE id = ?`, [id])?.status;
}

function snapshotItem(loop, projectId, collection, id) {
  return loop.snapshot(projectId)[collection].find((item) => Number(item.id) === Number(id));
}

function latestEvent(db, projectId, type) {
  return db.get(
    'SELECT * FROM events WHERE project_id = ? AND type = ? ORDER BY id DESC LIMIT 1',
    [projectId, type],
  );
}

async function mcpData(name, input, context) {
  const result = await callMcpTool(name, input, context);
  assert.equal(result.isError, undefined, `${name} 不应返回错误`);
  return result.structuredContent;
}

describe('validation 完成后关联需求/反馈状态同步', () => {
  it('空验收命令完成计划后，关联需求从 open 变为 completed 并反映到快照', async () => {
    const fixture = await createFixture({ validationCommand: '' });
    try {
      const plan = insertPlan(fixture, 'empty-validation-linked-requirement');
      const requirementId = insertIntake(fixture.db, 'requirements', fixture.projectId, plan.id);

      await fixture.loop.validatePlan(fixture.workspace, plan);

      assert.equal(statusOf(fixture.db, 'requirements', requirementId), 'completed', '关联需求应标记 completed');
      assert.equal(snapshotItem(fixture.loop, fixture.projectId, 'requirements', requirementId).status, 'completed', '需求快照应展示完成态');
      const meta = JSON.parse(latestEvent(fixture.db, fixture.projectId, 'plan.completed').meta);
      assert.equal(meta.linkedIntakes.requirements, 1, 'plan.completed meta 应记录需求完成计数');
    } finally {
      fixture.destroy();
    }
  });

  it('外部验收命令成功后，关联反馈从 open 变为 completed 并支持 MCP 状态过滤', async () => {
    const fixture = await createFixture({ validationCommand: 'npm run smoke:stub' });
    try {
      const plan = insertPlan(fixture, 'shell-validation-linked-feedback');
      const feedbackId = insertIntake(fixture.db, 'feedback', fixture.projectId, plan.id);
      fixture.loop.runShell = async () => ({ exitCode: 0, output: 'ok', logFile: null });

      await fixture.loop.validatePlan(fixture.workspace, plan);

      assert.equal(statusOf(fixture.db, 'feedback', feedbackId), 'completed', '关联反馈应标记 completed');
      assert.equal(snapshotItem(fixture.loop, fixture.projectId, 'feedback', feedbackId).status, 'completed', '反馈快照应展示完成态');
      const context = { db: fixture.db, loop: fixture.loop };
      const open = await mcpData(MCP_TOOL_NAMES.LIST_FEEDBACK, { projectId: fixture.projectId, status: 'open' }, context);
      const completed = await mcpData(MCP_TOOL_NAMES.LIST_FEEDBACK, { projectId: fixture.projectId, status: 'completed' }, context);
      assert.equal(open.feedback.some((item) => Number(item.id) === Number(feedbackId)), false, 'MCP open 反馈列表不应返回已完成反馈');
      assert.equal(completed.feedback.some((item) => Number(item.id) === Number(feedbackId)), true, 'MCP completed 反馈列表应返回已完成反馈');
    } finally {
      fixture.destroy();
    }
  });

  it('最后完整验收任务完成后，同一计划关联需求和反馈都会完成且 MCP 可按 completed 查询', async () => {
    const fixture = await createFixture({ validationCommand: '' });
    try {
      const plan = insertPlan(fixture, 'final-acceptance-linked-intakes', [
        '- [x] P001: 完成开发 <!-- scope: src/example.js -->',
        '- [ ] P002: 完整验收 <!-- scope: validation -->',
      ]);
      const requirementId = insertIntake(fixture.db, 'requirements', fixture.projectId, plan.id);
      const feedbackId = insertIntake(fixture.db, 'feedback', fixture.projectId, plan.id);
      const task = fixture.db.get('SELECT * FROM plan_tasks WHERE plan_id = ? AND task_key = ?', [plan.id, 'P002']);

      fixture.loop.completeAcceptanceTask(fixture.workspace, plan, task, { exitCode: 0, logFile: null, finishedAt: nowIso() });

      assert.equal(statusOf(fixture.db, 'requirements', requirementId), 'completed', '最终验收任务应完成关联需求');
      assert.equal(statusOf(fixture.db, 'feedback', feedbackId), 'completed', '最终验收任务应完成关联反馈');
      const context = { db: fixture.db, loop: fixture.loop };
      const openRequirements = await mcpData(MCP_TOOL_NAMES.LIST_REQUIREMENTS, { projectId: fixture.projectId, status: 'open' }, context);
      const completedRequirements = await mcpData(MCP_TOOL_NAMES.LIST_REQUIREMENTS, { projectId: fixture.projectId, status: 'completed' }, context);
      assert.equal(openRequirements.requirements.some((item) => Number(item.id) === Number(requirementId)), false, 'MCP open 需求列表不应返回已完成需求');
      assert.equal(completedRequirements.requirements.some((item) => Number(item.id) === Number(requirementId)), true, 'MCP completed 需求列表应返回已完成需求');
    } finally {
      fixture.destroy();
    }
  });

  it('验收失败时不会提前完成关联需求或反馈', async () => {
    const fixture = await createFixture({ validationCommand: 'npm run blocked:stub' });
    try {
      const plan = insertPlan(fixture, 'failed-validation-keeps-intakes-open');
      const requirementId = insertIntake(fixture.db, 'requirements', fixture.projectId, plan.id);
      const feedbackId = insertIntake(fixture.db, 'feedback', fixture.projectId, plan.id);
      fixture.loop.runShell = async () => ({
        exitCode: 1,
        output: 'PathAccessException: Permission denied while reading .dart_tool',
        errorMessage: 'PathAccessException: Permission denied while reading .dart_tool',
        logFile: null,
      });

      await fixture.loop.validatePlan(fixture.workspace, plan);

      assert.equal(statusOf(fixture.db, 'requirements', requirementId), 'open', '失败验收不应完成关联需求');
      assert.equal(statusOf(fixture.db, 'feedback', feedbackId), 'open', '失败验收不应完成关联反馈');
    } finally {
      fixture.destroy();
    }
  });
});
