const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AppDatabase, nowIso } = require('../database');
const { LoopService } = require('../loopService');

async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autoplan-intake-acceptance-'));
  const db = new AppDatabase(path.join(root, 'autoplan.sqlite'));
  await db.init();
  const loop = new LoopService(db);
  return {
    db,
    loop,
    projectId: loop.defaultProjectId(),
    close() {
      loop.flushPendingUpdates();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function addPlan(test, projectId, name) {
  const at = nowIso();
  return test.db.insert(
    `INSERT INTO plans
       (project_id, issue_hash, file_path, hash, status, sort_order, total_tasks,
        completed_tasks, validation_passed, agent_cli_command, created_at, updated_at)
     VALUES (?, ?, ?, '', 'completed', 1, 1, 1, 1, '', ?, ?)`,
    [projectId, `issue-${name}`, `docs/plan/${name}.md`, at, at],
  );
}

function addTask(test, planId, key = 'P001') {
  return test.db.insert(
    `INSERT INTO plan_tasks
       (plan_id, task_key, title, raw_line, scope, status, sort_order, duration_ms, updated_at)
     VALUES (?, ?, ?, ?, 'test', 'completed', 1, 0, ?)`,
    [planId, key, key, `- [x] ${key}`, nowIso()],
  );
}

function addIntake(test, projectId, type, title) {
  const table = type === 'feedback' ? 'feedback' : 'requirements';
  const at = nowIso();
  if (type === 'feedback') {
    return test.db.insert(
      `INSERT INTO feedback
         (project_id, requirement_id, title, body, status, created_at, updated_at)
       VALUES (?, NULL, ?, '', 'open', ?, ?)`,
      [projectId, title, at, at],
    );
  }
  return test.db.insert(
    `INSERT INTO requirements (project_id, title, body, status, created_at, updated_at)
     VALUES (?, ?, '', 'open', ?, ?)`,
    [projectId, title, at, at],
  );
}

function link(test, projectId, type, intakeId, planId, phaseIndex) {
  const at = nowIso();
  test.db.run(
    `INSERT INTO intake_plan_links
       (project_id, intake_type, intake_id, plan_id, phase_index, phase_title, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [projectId, type, intakeId, planId, phaseIndex, `phase ${phaseIndex}`, at, at],
  );
}

function acceptedAt(test, type, id) {
  const table = type === 'feedback' ? 'feedback' : 'requirements';
  return test.db.get(`SELECT accepted_at FROM ${table} WHERE id = ?`, [id]).accepted_at;
}

describe('linked intake acceptance regression', () => {
  it('waits for every normalized phase, ignores ordinary task acceptance, and clears on unaccept/redo', async () => {
    const test = await fixture();
    try {
      const first = addPlan(test, test.projectId, 'phase-1');
      const second = addPlan(test, test.projectId, 'phase-2');
      const task = addTask(test, first);
      const requirement = addIntake(test, test.projectId, 'requirement', 'phased requirement');
      link(test, test.projectId, 'requirement', requirement, first, 1);
      link(test, test.projectId, 'requirement', requirement, second, 2);

      test.loop.acceptItem(test.projectId, { targetType: 'task', id: task });
      assert.equal(acceptedAt(test, 'requirement', requirement), null,
        'ordinary task acceptance must not accept its intake');

      test.loop.acceptItem(test.projectId, { targetType: 'plan', id: first });
      assert.equal(acceptedAt(test, 'requirement', requirement), null,
        'one accepted phase must leave the intake waiting');

      test.loop.acceptItem(test.projectId, { targetType: 'plan', id: second });
      assert.ok(acceptedAt(test, 'requirement', requirement),
        'all phases accepted must remove the intake from its waiting state');

      test.loop.acceptItem(test.projectId, { targetType: 'plan', id: second });
      assert.equal(test.db.get(
        "SELECT COUNT(*) AS count FROM events WHERE project_id = ? AND type = 'requirement.accepted'",
        [test.projectId],
      ).count, 1, 'repeated acceptance must not duplicate the derived intake event');

      test.loop.unacceptItem(test.projectId, { targetType: 'plan', id: first });
      assert.equal(acceptedAt(test, 'requirement', requirement), null);
      test.loop.acceptItem(test.projectId, { targetType: 'plan', id: first });
      assert.ok(acceptedAt(test, 'requirement', requirement));
      test.loop.redoAcceptanceItem(test.projectId, { targetType: 'task', id: task, supplement: 'regression' });
      assert.equal(acceptedAt(test, 'requirement', requirement), null,
        'task redo invalidates the parent plan and linked intake');
    } finally {
      test.close();
    }
  });

  it('supports batch acceptance, feedback, legacy links, and project isolation', async () => {
    const test = await fixture();
    try {
      const first = addPlan(test, test.projectId, 'batch-1');
      const second = addPlan(test, test.projectId, 'batch-2');
      const feedback = addIntake(test, test.projectId, 'feedback', 'normalized feedback');
      link(test, test.projectId, 'feedback', feedback, first, 1);
      link(test, test.projectId, 'feedback', feedback, second, 2);

      const legacy = addIntake(test, test.projectId, 'requirement', 'legacy requirement');
      test.db.run('UPDATE requirements SET linked_plan_id = ? WHERE id = ?', [first, legacy]);

      const otherProject = test.db.insert(
        'INSERT INTO projects (name, workspace_path, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
        ['isolated', '', '', nowIso(), nowIso()],
      );
      const isolated = addIntake(test, otherProject, 'requirement', 'other project');
      test.db.run('UPDATE requirements SET linked_plan_id = ? WHERE id = ?', [first, isolated]);

      const result = test.loop.acceptItems(test.projectId, [
        { targetType: 'plan', id: first },
        { targetType: 'plan', id: second },
        { targetType: 'plan', id: second },
      ]);
      assert.equal(result.accepted, 2, 'batch targets are deduplicated');
      assert.ok(acceptedAt(test, 'feedback', feedback));
      assert.ok(acceptedAt(test, 'requirement', legacy), 'legacy linked_plan_id remains supported');
      assert.equal(acceptedAt(test, 'requirement', isolated), null, 'another project is never mutated');

      test.loop.unacceptItems(test.projectId, [
        { targetType: 'plan', id: first },
        { targetType: 'plan', id: second },
      ]);
      assert.equal(acceptedAt(test, 'feedback', feedback), null);
      assert.equal(acceptedAt(test, 'requirement', legacy), null);
    } finally {
      test.close();
    }
  });
});
