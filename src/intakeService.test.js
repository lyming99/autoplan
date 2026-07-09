const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { DuplicateIntakeError, IntakeService } = require('./intakeService');

describe('IntakeService duplicate intake detection', () => {
  it('createRequirement rejects whitespace-normalized duplicates before persistence side effects', () => {
    const db = createIntakeDbStub({
      requirements: [{
        id: 10,
        project_id: 1,
        title: '  Duplicate   requirement  ',
        body: 'First   line\r\n  second line  ',
        status: 'open',
      }],
    });
    const loop = createLoopStub(db);
    const service = new IntakeService({ db, loop, attachmentsRoot: 'D:\\tmp' });

    const error = assert.throws(
      () => service.createRequirement({
        projectId: 1,
        title: 'Duplicate requirement',
        body: 'First line\nsecond   line',
        attachments: [{ name: 'evidence.txt', path: 'D:\\tmp\\evidence.txt' }],
        autoRun: true,
      }),
      DuplicateIntakeError,
    );

    assert.equal(error.code, 'DUPLICATE_INTAKE');
    assert.equal(error.intakeType, 'requirement');
    assert.equal(error.existingId, 10);
    assert.deepEqual(db.inserts, [], 'duplicate requirement should not insert intake or attachment rows');
    assert.deepEqual(loop.events, [], 'duplicate requirement should not add a creation event');
    assert.deepEqual(loop.starts, [], 'duplicate requirement should not start the loop');
  });

  it('createFeedback rejects only duplicates with the same requirement association', () => {
    const db = createIntakeDbStub({
      requirements: [
        { id: 20, project_id: 1, title: 'Requirement A', body: 'A', status: 'open' },
        { id: 21, project_id: 1, title: 'Requirement B', body: 'B', status: 'open' },
      ],
      feedback: [{
        id: 30,
        project_id: 1,
        requirement_id: 20,
        title: ' Feedback   title ',
        body: 'Body   line\r\n  tail',
        status: 'open',
      }],
    });
    const loop = createLoopStub(db);
    const service = new IntakeService({ db, loop, attachmentsRoot: 'D:\\tmp' });

    const error = assert.throws(
      () => service.createFeedback({
        projectId: 1,
        requirementId: 20,
        title: 'Feedback title',
        body: 'Body line\ntail',
        attachments: [{ name: 'feedback.txt', path: 'D:\\tmp\\feedback.txt' }],
        autoRun: true,
      }),
      DuplicateIntakeError,
    );

    assert.equal(error.code, 'DUPLICATE_INTAKE');
    assert.equal(error.intakeType, 'feedback');
    assert.equal(error.existingId, 30);
    assert.deepEqual(db.inserts, [], 'duplicate feedback should not insert intake or attachment rows');
    assert.deepEqual(loop.events, [], 'duplicate feedback should not add a creation event');
    assert.deepEqual(loop.starts, [], 'duplicate feedback should not start the loop');

    service.createFeedback({
      projectId: 1,
      requirementId: 21,
      title: 'Feedback title',
      body: 'Body line\ntail',
    });

    assert.equal(db._feedback.length, 2, 'same title/body under another requirement should be allowed');
    assert.equal(db._feedback[1].requirement_id, 21);
    assert.equal(loop.events.length, 1);
  });

  it('allows closed historical duplicates and genuinely different text', () => {
    const db = createIntakeDbStub({
      requirements: [
        { id: 40, project_id: 1, title: 'Closed duplicate', body: 'same body', status: 'closed' },
        { id: 41, project_id: 1, title: 'Different structure', body: 'line one\nline two', status: 'open' },
      ],
    });
    const loop = createLoopStub(db);
    const service = new IntakeService({ db, loop, attachmentsRoot: 'D:\\tmp' });

    service.createRequirement({ projectId: 1, title: 'Closed duplicate', body: 'same   body' });
    service.createRequirement({ projectId: 1, title: 'Different structure', body: 'line one line two' });

    assert.equal(db._requirements.length, 4);
    assert.equal(db._requirements[2].status, 'open');
    assert.equal(db._requirements[3].body, 'line one line two');
    assert.equal(loop.events.length, 2);
  });
});

function createIntakeDbStub({ projects = [{ id: 1, name: 'P' }], requirements = [], feedback = [] } = {}) {
  return {
    _projects: projects,
    _requirements: requirements.slice(),
    _feedback: feedback.slice(),
    inserts: [],
    all(sql, params = []) {
      if (sql.includes('FROM requirements')) {
        const [projectId] = params;
        return this._requirements
          .filter((row) => Number(row.project_id) === Number(projectId))
          .filter((row) => String(row.status || 'open') !== 'closed')
          .sort((left, right) => Number(left.id) - Number(right.id));
      }
      if (sql.includes('FROM feedback')) {
        const [projectId, requirementId] = params;
        return this._feedback
          .filter((row) => Number(row.project_id) === Number(projectId))
          .filter((row) => String(row.status || 'open') !== 'closed')
          .filter((row) => sameRequirementAssociation(row.requirement_id, requirementId))
          .sort((left, right) => Number(left.id) - Number(right.id));
      }
      return [];
    },
    get(sql, params = []) {
      if (sql.includes('FROM requirements')) {
        const [id] = params;
        return this._requirements.find((row) => Number(row.id) === Number(id)) || null;
      }
      return null;
    },
    insert(sql, params = []) {
      this.inserts.push({ sql, params });
      if (sql.includes('INSERT INTO requirements')) {
        const id = nextId(this._requirements);
        this._requirements.push({
          id,
          project_id: params[0],
          title: params[1],
          body: params[2],
          status: params[3],
          created_at: params[params.length - 2],
          updated_at: params[params.length - 1],
        });
        return id;
      }
      if (sql.includes('INSERT INTO feedback')) {
        const id = nextId(this._feedback);
        this._feedback.push({
          id,
          project_id: params[0],
          requirement_id: params[1],
          title: params[2],
          body: params[3],
          status: params[4],
          created_at: params[params.length - 2],
          updated_at: params[params.length - 1],
        });
        return id;
      }
      return nextId([]);
    },
  };
}

function createLoopStub(db) {
  return {
    events: [],
    starts: [],
    project(projectId) {
      return db._projects.find((project) => Number(project.id) === Number(projectId)) || null;
    },
    addEvent(projectId, type, message) {
      this.events.push({ projectId, type, message });
    },
    start(projectId) {
      this.starts.push(projectId);
    },
    snapshot(projectId) {
      return {
        activeProjectId: projectId,
        activeProject: this.project(projectId),
        requirements: db._requirements,
        feedback: db._feedback,
        plans: [],
        tasks: [],
        events: this.events,
      };
    },
  };
}

function sameRequirementAssociation(left, right) {
  if (left == null && right == null) return true;
  return Number(left) === Number(right);
}

function nextId(rows) {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1;
}
