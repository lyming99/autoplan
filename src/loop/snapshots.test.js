const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const snapshots = require('./snapshots');
const { effectiveAgentCliConfig, intakeSnapshotRow } = require('./agentCliConfig');

describe('snapshot executors contract', () => {
  it('keeps empty snapshots compatible with an executors array and executor MCP tools', () => {
    const db = createSnapshotDb();
    const service = createSnapshotService({ db, projects: [] });

    const result = snapshots.snapshot(service, {}, null);

    assert.deepEqual(result.executors, []);
    assert.ok(result.mcp.tools.includes('list_executors'));
    assert.ok(result.mcp.tools.includes('run_executor'));
    assert.ok(result.mcp.tools.includes('stop_executor'));
  });

  it('serializes executor config, recent state, and active operation into project snapshots', () => {
    const activeOperation = {
      operationType: 'executor',
      projectId: 1,
      executorId: 10,
      executorLabel: 'build',
      rootExecutorId: 10,
      rootExecutorLabel: 'build',
      executorRunId: 'run-1',
      label: 'executor-10-build',
      startedAt: '2026-07-03T00:00:00.000Z',
      logBuffer: 'running log tail',
      logFile: 'docs/progress/logs/build.log',
    };
    const db = createSnapshotDb({
      executors: [
        executorRow({
          id: 10,
          label: 'build',
          command: 'npm run build',
          args_json: JSON.stringify(['--watch']),
          options_json: JSON.stringify({ cwd: 'web', env: { CI: '1' } }),
          group_kind: 'build',
          group_is_default: 1,
          depends_on_json: JSON.stringify(['prepare']),
          depends_order: 'sequence',
          last_status: 'ok',
          last_exit_code: 0,
          last_duration_ms: 350,
          last_log: 'previous log',
          last_run_at: '2026-07-02T00:00:00.000Z',
        }),
      ],
    });
    const service = createSnapshotService({
      db,
      runtime: {
        activeOperations: new Map([['op-1', activeOperation]]),
      },
    });

    const result = snapshots.snapshot(service, {}, 1);

    assert.equal(result.executors.length, 1);
    const [executor] = result.executors;
    assert.equal(executor.id, 10);
    assert.equal(executor.projectId, 1);
    assert.equal(executor.project_id, 1);
    assert.equal(executor.label, 'build');
    assert.equal(executor.command, 'npm run build');
    assert.deepEqual(executor.args, ['--watch']);
    assert.deepEqual(executor.options, { cwd: 'web', env: { CI: '1' } });
    assert.deepEqual(executor.group, { kind: 'build', isDefault: true });
    assert.equal(executor.group_kind, 'build');
    assert.equal(executor.group_is_default, 1);
    assert.deepEqual(executor.dependsOn, ['prepare']);
    assert.equal(executor.depends_order, 'sequence');
    assert.equal(executor.lastStatus, 'ok');
    assert.equal(executor.last_status, 'ok');
    assert.equal(executor.lastExitCode, 0);
    assert.equal(executor.last_exit_code, 0);
    assert.equal(executor.running, true);
    assert.equal(executor.runStatus, 'running');
    assert.equal(executor.activeOperation.executorId, 10);
    assert.equal(executor.activeOperation.logTail, 'running log tail');
    assert.equal(result.activeOperations.length, 1);
    assert.equal(result.activeOperations[0].operationType, 'executor');
  });
});

describe('snapshot intake effective CLI resolution', () => {
  it('falls back to state default provider when intake agent_cli_provider is null', () => {
    const state = { agent_cli_provider: 'claude' };
    const row = {
      id: 1,
      project_id: 1,
      agent_cli_provider: null,
      agent_cli_command: null,
      codex_reasoning_effort: null,
      linked_plan_id: null,
      title: '',
      body: '',
      status: 'open',
    };

    const normalized = intakeSnapshotRow(row);
    const effective = effectiveAgentCliConfig(state, normalized);

    assert.equal(effective.provider, 'claude');
    assert.equal(effective.command, 'claude');
  });

  it('prioritises intake explicit provider over state default', () => {
    const state = { agent_cli_provider: 'claude' };
    const row = {
      id: 2,
      project_id: 1,
      agent_cli_provider: 'opencode',
      agent_cli_command: 'opencode',
      codex_reasoning_effort: null,
      linked_plan_id: null,
      title: '',
      body: '',
      status: 'open',
    };

    const normalized = intakeSnapshotRow(row);
    const effective = effectiveAgentCliConfig(state, normalized);

    assert.equal(effective.provider, 'opencode');
    assert.equal(effective.command, 'opencode');
  });

  it('falls back codex_reasoning_effort to state default when intake does not specify', () => {
    const state = { agent_cli_provider: 'codex', codex_reasoning_effort: 'high' };
    const row = {
      id: 3,
      project_id: 1,
      agent_cli_provider: null,
      agent_cli_command: null,
      codex_reasoning_effort: null,
      linked_plan_id: null,
      title: '',
      body: '',
      status: 'open',
    };

    const normalized = intakeSnapshotRow(row);
    const effective = effectiveAgentCliConfig(state, normalized);

    assert.equal(effective.provider, 'codex');
    assert.equal(effective.codexReasoningEffort, 'high');
  });

  it('overrides effort when intake specifies a different codex_reasoning_effort', () => {
    const state = { agent_cli_provider: 'codex', codex_reasoning_effort: 'medium' };
    const row = {
      id: 4,
      project_id: 1,
      agent_cli_provider: 'codex',
      agent_cli_command: null,
      codex_reasoning_effort: 'xhigh',
      linked_plan_id: null,
      title: '',
      body: '',
      status: 'open',
    };

    const normalized = intakeSnapshotRow(row);
    const effective = effectiveAgentCliConfig(state, normalized);

    assert.equal(effective.provider, 'codex');
    assert.equal(effective.codexReasoningEffort, 'xhigh');
  });

  it('sets codex_reasoning_effort to null for non-codex providers', () => {
    const state = { agent_cli_provider: 'codex', codex_reasoning_effort: 'high' };
    const row = {
      id: 5,
      project_id: 1,
      agent_cli_provider: 'claude',
      agent_cli_command: 'claude',
      codex_reasoning_effort: null,
      linked_plan_id: null,
      title: '',
      body: '',
      status: 'open',
    };

    const normalized = intakeSnapshotRow(row);
    const effective = effectiveAgentCliConfig(state, normalized);

    assert.equal(effective.provider, 'claude');
    assert.equal(effective.codexReasoningEffort, null);
  });
});

describe('snapshot linked plan batching', () => {
  it('builds linked plan snapshots from project-level grouped links and legacy fallback', () => {
    const db = createSnapshotDb({
      plans: [
        planRow({ id: 10, file_path: 'docs/plan/single.md', status: 'pending', completed_tasks: 1, total_tasks: 4 }),
        planRow({ id: 20, file_path: 'docs/plan/phase-1.md', status: 'completed', completed_tasks: 3, total_tasks: 3, validation_passed: 1 }),
        planRow({ id: 21, file_path: 'docs/plan/phase-2.md', status: 'running', completed_tasks: 2, total_tasks: 5 }),
        planRow({ id: 30, file_path: 'docs/plan/legacy.md', status: 'pending', completed_tasks: 0, total_tasks: 2 }),
      ],
      requirements: [
        intakeRow({ id: 1, title: 'No linked plan', linked_plan_id: null, updated_at: '2026-07-03T00:00:06.000Z' }),
        intakeRow({ id: 2, title: 'Single linked plan', linked_plan_id: 10, updated_at: '2026-07-03T00:00:05.000Z' }),
        intakeRow({ id: 3, title: 'Phased linked plan', linked_plan_id: 20, updated_at: '2026-07-03T00:00:04.000Z' }),
        intakeRow({ id: 4, title: 'Missing linked plan', linked_plan_id: 999, updated_at: '2026-07-03T00:00:03.000Z' }),
      ],
      feedback: [
        intakeRow({ id: 10, title: 'Legacy linked plan', linked_plan_id: 30, updated_at: '2026-07-03T00:00:02.000Z' }),
        intakeRow({ id: 11, title: 'Legacy missing linked plan', linked_plan_id: 998, updated_at: '2026-07-03T00:00:01.000Z' }),
      ],
      intakePlanLinks: [
        intakePlanLinkRow({ id: 100, intake_id: 2, plan_id: 10, phase_index: 1, phase_title: 'Implementation' }),
        intakePlanLinkRow({ id: 101, intake_id: 3, plan_id: 20, phase_index: 1, phase_title: 'Phase 1' }),
        intakePlanLinkRow({ id: 102, intake_id: 3, plan_id: 21, phase_index: 2, phase_title: 'Phase 2' }),
        intakePlanLinkRow({ id: 103, intake_id: 4, plan_id: 999, phase_index: 1, phase_title: '' }),
      ],
    });
    const service = createSnapshotService({ db });

    const result = snapshots.snapshot(service, {}, 1);

    const noLink = findSnapshotRow(result.requirements, 1);
    assert.deepEqual(noLink.linked_plans, []);
    assert.equal(noLink.plan_title, undefined);

    const single = findSnapshotRow(result.requirements, 2);
    assert.equal(single.linked_plans.length, 1);
    assert.deepEqual(pickLinkedPlanFields(single.linked_plans[0]), {
      link_id: 100,
      plan_id: 10,
      phase_index: 1,
      phase_title: 'Implementation',
      title: 'Implementation',
      file_path: 'docs/plan/single.md',
      status: 'pending',
      completed_tasks: 1,
      total_tasks: 4,
      validation_passed: 0,
      is_current: true,
    });
    assert.equal(single.plan_title, 'Implementation');
    assert.equal(single.linked_plan_file_path, 'docs/plan/single.md');
    assert.equal(single.linked_plan_status, 'pending');
    assert.equal(single.linked_plan_completed_tasks, 1);
    assert.equal(single.linked_plan_total_tasks, 4);

    const phased = findSnapshotRow(result.requirements, 3);
    assert.deepEqual(phased.linked_plans.map((plan) => plan.plan_id), [20, 21]);
    assert.deepEqual(phased.linked_plans.map((plan) => plan.is_current), [false, true]);
    assert.deepEqual(phased.linked_plans.map((plan) => plan.phase_title), ['Phase 1', 'Phase 2']);
    assert.equal(phased.plan_title, 'Phase 2');
    assert.equal(phased.plan_file_path, 'docs/plan/phase-2.md');
    assert.equal(phased.plan_status, 'running');
    assert.equal(phased.plan_completed, 2);
    assert.equal(phased.plan_total, 5);
    assert.equal(phased.linked_plans[0].validation_passed, 1);

    const missing = findSnapshotRow(result.requirements, 4);
    assert.deepEqual(pickLinkedPlanFields(missing.linked_plans[0]), {
      link_id: 103,
      plan_id: 999,
      phase_index: 1,
      phase_title: null,
      title: 'Plan #999',
      file_path: null,
      status: null,
      completed_tasks: null,
      total_tasks: null,
      validation_passed: null,
      is_current: true,
    });
    assert.equal(missing.linked_plan_title, 'Plan #999');

    const legacy = findSnapshotRow(result.feedback, 10);
    assert.deepEqual(pickLinkedPlanFields(legacy.linked_plans[0]), {
      link_id: null,
      plan_id: 30,
      phase_index: 1,
      phase_title: null,
      title: 'docs/plan/legacy.md',
      file_path: 'docs/plan/legacy.md',
      status: 'pending',
      completed_tasks: 0,
      total_tasks: 2,
      validation_passed: 0,
      is_current: true,
    });
    assert.equal(legacy.linked_plan_title, 'docs/plan/legacy.md');
    assert.equal(legacy.linked_plan_status, 'pending');

    const legacyMissing = findSnapshotRow(result.feedback, 11);
    assert.deepEqual(pickLinkedPlanFields(legacyMissing.linked_plans[0]), {
      link_id: null,
      plan_id: 998,
      phase_index: 1,
      phase_title: null,
      title: 'Plan #998',
      file_path: null,
      status: null,
      completed_tasks: null,
      total_tasks: null,
      validation_passed: null,
      is_current: true,
    });

    assert.equal(db.countAll((sql) => isProjectLinkedPlanBatchQuery(sql)), 1);
    assert.equal(db.countAll((sql) => isLegacyLinkedPlanFallbackQuery(sql)), 2);
    assert.equal(db.countAll((sql) => isPerIntakeLinkedPlanQuery(sql)), 0);
  });
});


describe('snapshot plan generation duration', () => {
  it('normalizes plan_generation_duration_ms on plan snapshots', () => {
    const db = createSnapshotDb({
      plans: [
        planRow({ id: 40, plan_generation_duration_ms: 1234.9 }),
        planRow({ id: 41, plan_generation_duration_ms: -10 }),
      ],
    });
    const service = createSnapshotService({ db });

    const result = snapshots.snapshot(service, {}, 1);

    assert.equal(findSnapshotRow(result.plans, 40).plan_generation_duration_ms, 1234);
    assert.equal(findSnapshotRow(result.plans, 41).plan_generation_duration_ms, 0);
  });
});

describe('snapshot plan execution Codex reasoning', () => {
  it('exposes current project state and plan execution effort without leaking other projects', () => {
    const db = createSnapshotDb({
      plans: [
        planRow({
          id: 50,
          project_id: 1,
          plan_execution_provider: 'codex',
          plan_execution_codex_reasoning_effort: 'xhigh',
        }),
        planRow({
          id: 51,
          project_id: 2,
          plan_execution_provider: 'codex',
          plan_execution_codex_reasoning_effort: 'low',
        }),
      ],
    });
    const service = createSnapshotService({
      db,
      projects: [
        { id: 1, name: 'Project A', workspace_path: 'D:/workspace-a', updated_at: '2026-07-03T00:00:00.000Z' },
        { id: 2, name: 'Project B', workspace_path: 'D:/workspace-b', updated_at: '2026-07-03T00:00:00.000Z' },
      ],
      status(projectId) {
        return Number(projectId) === 1
          ? {
              agent_cli_provider: 'codex',
              codex_reasoning_effort: 'medium',
              plan_execution_provider: 'codex',
              plan_execution_codex_reasoning_effort: 'xhigh',
            }
          : {
              agent_cli_provider: 'codex',
              codex_reasoning_effort: 'medium',
              plan_execution_provider: 'codex',
              plan_execution_codex_reasoning_effort: 'low',
            };
      },
    });

    const result = snapshots.snapshot(service, {}, 1);

    assert.equal(result.state.plan_execution_codex_reasoning_effort, 'xhigh');
    assert.equal(findSnapshotRow(result.plans, 50).plan_execution_codex_reasoning_effort, 'xhigh');
    assert.equal(findSnapshotRow(result.plans, 51), undefined);
  });

  it('copies plan execution Codex effort from active operation context', () => {
    const activeOperation = {
      operationType: 'execute-task',
      projectId: 1,
      planId: 50,
      taskId: 500,
      label: 'task-500',
      startedAt: '2026-07-03T00:00:00.000Z',
      planExecutionProvider: 'codex',
      planExecutionCodexReasoningEffort: 'high',
      logBuffer: 'running',
    };
    const db = createSnapshotDb();
    const service = createSnapshotService({
      db,
      runtime: {
        activeOperation,
        activeOperations: new Map([
          ['current', activeOperation],
          ['other', { ...activeOperation, projectId: 2, planExecutionCodexReasoningEffort: 'low' }],
        ]),
      },
    });

    const result = snapshots.snapshot(service, {}, 1);

    assert.equal(result.activeOperation.codexReasoningEffort, 'high');
    assert.equal(result.activeOperations.length, 1);
    assert.equal(result.activeOperations[0].codexReasoningEffort, 'high');
  });
});
describe('snapshot scan_files payload contract', () => {
  it('keeps regular snapshots bounded while exposing a scan summary', () => {
    const baseDb = createSnapshotDb();
    const largeDb = createSnapshotDb({
      scanFiles: Array.from({ length: 5000 }, (_, index) => scanFileRow({
        file_path: `src/generated/file-${String(index).padStart(5, '0')}.js`,
        size: 100 + index,
        scanned_at: `2026-07-03T00:${String(index % 60).padStart(2, '0')}:00.000Z`,
        modified_at: `2026-07-02T00:${String(index % 60).padStart(2, '0')}:00.000Z`,
      })),
    });

    const baseSnapshot = snapshots.snapshot(createSnapshotService({ db: baseDb }), {}, 1);
    const largeSnapshot = snapshots.snapshot(createSnapshotService({ db: largeDb }), {}, 1);

    assert.deepEqual(baseSnapshot.scans, []);
    assert.deepEqual(largeSnapshot.scans, []);
    assert.deepEqual(baseSnapshot.scanSummary, {
      count: 0,
      total_size: 0,
      latest_scanned_at: null,
      latest_modified_at: null,
    });
    assert.equal(largeSnapshot.scanSummary.count, 5000);
    assert.equal(largeSnapshot.scanSummary.total_size, 12997500);
    assert.equal(largeSnapshot.scanSummary.latest_scanned_at, '2026-07-03T00:59:00.000Z');
    assert.equal(largeSnapshot.scanSummary.latest_modified_at, '2026-07-02T00:59:00.000Z');

    const baseSize = JSON.stringify(baseSnapshot).length;
    const largeSize = JSON.stringify(largeSnapshot).length;
    assert.ok(
      largeSize - baseSize < 200,
      `snapshot size should stay bounded; grew by ${largeSize - baseSize} bytes`,
    );
    assert.equal(largeDb.countAll((sql) => isFullScanFilesSnapshotQuery(sql)), 0);
    assert.equal(largeDb.countGet((sql) => isScanSummaryQuery(sql)), 1);
  });
});

function createSnapshotDb({
  executors = [],
  plans = [],
  requirements = [],
  feedback = [],
  intakePlanLinks = [],
  scanFiles = [],
} = {}) {
  return {
    _executors: executors,
    _plans: plans,
    _requirements: requirements,
    _feedback: feedback,
    _intakePlanLinks: intakePlanLinks,
    _scanFiles: scanFiles,
    _allCalls: [],
    _getCalls: [],
    all(sql, params = []) {
      this._allCalls.push({ sql, params });
      if (isProjectPlanQuery(sql)) {
        return this._plans
          .filter((row) => Number(row.project_id) === Number(params[0]))
          .sort(comparePlanRows)
          .map((row) => ({ ...row }));
      }
      if (isTaskSnapshotQuery(sql)) return [];
      if (isProjectLinkedPlanBatchQuery(sql)) {
        return this._intakePlanLinks
          .filter((row) => Number(row.project_id) === Number(params[0]))
          .sort(compareIntakePlanLinkRows)
          .map((row) => linkedPlanJoinRow(row, this._plans));
      }
      if (isLegacyLinkedPlanFallbackQuery(sql)) {
        const intakeType = params[0];
        const projectId = params[1];
        const sourceRows = intakeType === 'feedback' ? this._feedback : this._requirements;
        return sourceRows
          .filter((row) => Number(row.project_id) === Number(projectId))
          .filter((row) => Number(row.linked_plan_id) > 0)
          .filter((row) => !this._intakePlanLinks.some((link) => (
            Number(link.project_id) === Number(row.project_id)
              && link.intake_type === intakeType
              && Number(link.intake_id) === Number(row.id)
          )))
          .sort((left, right) => Number(left.id) - Number(right.id))
          .map((row) => linkedPlanJoinRow({
            id: null,
            project_id: row.project_id,
            intake_type: intakeType,
            intake_id: row.id,
            plan_id: row.linked_plan_id,
            phase_index: 1,
            phase_title: '',
            created_at: null,
            updated_at: null,
          }, this._plans));
      }
      if (isRequirementSnapshotQuery(sql)) {
        return this._requirements
          .filter((row) => Number(row.project_id) === Number(params[0]))
          .sort(compareUpdatedDesc)
          .map((row) => intakeSnapshotJoinRow(row, this._plans));
      }
      if (isFeedbackSnapshotQuery(sql)) {
        return this._feedback
          .filter((row) => Number(row.project_id) === Number(params[0]))
          .sort(compareUpdatedDesc)
          .map((row) => intakeSnapshotJoinRow(row, this._plans));
      }
      if (sql.includes('FROM executors')) {
        return this._executors
          .filter((row) => Number(row.project_id) === Number(params[0]))
          .sort((left, right) => Number(left.sort_order || 0) - Number(right.sort_order || 0) || Number(left.id) - Number(right.id))
          .map((row) => ({ ...row }));
      }
      return [];
    },
    get(sql, params = []) {
      this._getCalls.push({ sql, params });
      if (isScanSummaryQuery(sql)) return scanSummaryRow(this._scanFiles, params[0]);
      return null;
    },
    getSettings() {
      return {};
    },
    countAll(predicate) {
      return this._allCalls.filter((entry) => predicate(entry.sql, entry.params)).length;
    },
    countGet(predicate) {
      return this._getCalls.filter((entry) => predicate(entry.sql, entry.params)).length;
    },
  };
}

function createSnapshotService({
  db,
  projects = [{ id: 1, name: 'Project', workspace_path: 'D:/workspace', updated_at: '2026-07-03T00:00:00.000Z' }],
  runtime = null,
  status = null,
} = {}) {
  return {
    db,
    projects() {
      return projects;
    },
    project(projectId) {
      return projects.find((project) => Number(project.id) === Number(projectId)) || null;
    },
    status(projectId) {
      const overrides = typeof status === 'function' ? status(projectId) : (status || {});
      return {
        project_id: projectId,
        running: 0,
        phase: 'idle',
        interval_seconds: 5,
        validation_command: '',
        updated_at: '2026-07-03T00:00:00.000Z',
        ...overrides,
      };
    },
    existingRuntime(projectId) {
      return Number(projectId) === 1 ? runtime : null;
    },
    planSnapshotAgentCliConfig() {
      return null;
    },
  };
}

function executorRow(overrides = {}) {
  return {
    id: overrides.id || 1,
    project_id: overrides.project_id || 1,
    label: overrides.label || 'executor',
    type: overrides.type || 'shell',
    command: overrides.command || 'echo ok',
    args_json: overrides.args_json || '[]',
    options_json: overrides.options_json || '{}',
    group_kind: overrides.group_kind || null,
    group_is_default: overrides.group_is_default || 0,
    presentation_json: overrides.presentation_json || '{}',
    problem_matcher_json: overrides.problem_matcher_json || null,
    depends_on_json: overrides.depends_on_json || '[]',
    depends_order: overrides.depends_order || 'parallel',
    enabled: overrides.enabled ?? 1,
    sort_order: overrides.sort_order || 0,
    last_status: overrides.last_status || null,
    last_exit_code: overrides.last_exit_code ?? null,
    last_duration_ms: overrides.last_duration_ms ?? null,
    last_log: overrides.last_log || null,
    last_run_at: overrides.last_run_at || null,
    created_at: overrides.created_at || '2026-07-03T00:00:00.000Z',
    updated_at: overrides.updated_at || '2026-07-03T00:00:00.000Z',
  };
}

function planRow(overrides = {}) {
  return {
    id: overrides.id || 1,
    project_id: overrides.project_id || 1,
    issue_hash: overrides.issue_hash || `issue-${overrides.id || 1}`,
    file_path: overrides.file_path || `docs/plan/plan-${overrides.id || 1}.md`,
    hash: overrides.hash || `hash-${overrides.id || 1}`,
    status: overrides.status || 'pending',
    sort_order: overrides.sort_order || 0,
    total_tasks: overrides.total_tasks ?? 0,
    completed_tasks: overrides.completed_tasks ?? 0,
    validation_passed: overrides.validation_passed ?? 0,
    plan_generation_duration_ms: overrides.plan_generation_duration_ms ?? 0,
    plan_execution_strategy: overrides.plan_execution_strategy ?? null,
    plan_execution_provider: overrides.plan_execution_provider ?? null,
    plan_execution_command: overrides.plan_execution_command ?? null,
    plan_execution_model: overrides.plan_execution_model ?? null,
    plan_execution_codex_reasoning_effort: overrides.plan_execution_codex_reasoning_effort ?? null,
    agent_cli_provider: overrides.agent_cli_provider ?? null,
    agent_cli_command: overrides.agent_cli_command || '',
    codex_reasoning_effort: overrides.codex_reasoning_effort ?? null,
    agent_cli_session_id: overrides.agent_cli_session_id ?? null,
    created_at: overrides.created_at || '2026-07-03T00:00:00.000Z',
    updated_at: overrides.updated_at || '2026-07-03T00:00:00.000Z',
    accepted_at: overrides.accepted_at ?? null,
  };
}

function intakeRow(overrides = {}) {
  return {
    id: overrides.id || 1,
    project_id: overrides.project_id || 1,
    title: overrides.title || `Intake ${overrides.id || 1}`,
    body: overrides.body || '',
    status: overrides.status || 'open',
    linked_plan_id: overrides.linked_plan_id ?? null,
    agent_cli_provider: overrides.agent_cli_provider ?? null,
    agent_cli_command: overrides.agent_cli_command ?? null,
    codex_reasoning_effort: overrides.codex_reasoning_effort ?? null,
    generate_fail_count: overrides.generate_fail_count ?? 0,
    last_generate_fail_at: overrides.last_generate_fail_at ?? null,
    last_generate_error: overrides.last_generate_error ?? null,
    last_generate_log_file: overrides.last_generate_log_file ?? null,
    last_generate_agent_cli_provider: overrides.last_generate_agent_cli_provider ?? null,
    last_generate_codex_reasoning_effort: overrides.last_generate_codex_reasoning_effort ?? null,
    created_at: overrides.created_at || '2026-07-03T00:00:00.000Z',
    updated_at: overrides.updated_at || '2026-07-03T00:00:00.000Z',
  };
}

function intakePlanLinkRow(overrides = {}) {
  return {
    id: overrides.id || 1,
    project_id: overrides.project_id || 1,
    intake_type: overrides.intake_type || 'requirement',
    intake_id: overrides.intake_id || 1,
    plan_id: overrides.plan_id || 1,
    phase_index: overrides.phase_index || 1,
    phase_title: overrides.phase_title || '',
    created_at: overrides.created_at || '2026-07-03T00:00:00.000Z',
    updated_at: overrides.updated_at || '2026-07-03T00:00:00.000Z',
  };
}

function scanFileRow(overrides = {}) {
  return {
    project_id: overrides.project_id || 1,
    scan_type: overrides.scan_type || 'workspace',
    file_path: overrides.file_path || 'src/index.js',
    hash: overrides.hash || 'hash',
    size: overrides.size ?? 0,
    modified_at: overrides.modified_at || '2026-07-02T00:00:00.000Z',
    scanned_at: overrides.scanned_at || '2026-07-03T00:00:00.000Z',
  };
}

function scanSummaryRow(scanFiles, projectId) {
  const rows = scanFiles.filter((row) => Number(row.project_id) === Number(projectId));
  return {
    count: rows.length,
    total_size: rows.reduce((total, row) => total + Number(row.size || 0), 0),
    latest_scanned_at: maxText(rows.map((row) => row.scanned_at)),
    latest_modified_at: maxText(rows.map((row) => row.modified_at)),
  };
}

function maxText(values) {
  return values.filter(Boolean).sort().at(-1) || null;
}

function linkedPlanJoinRow(link, plans) {
  const plan = plans.find((row) => (
    Number(row.id) === Number(link.plan_id)
      && Number(row.project_id) === Number(link.project_id)
  ));
  return {
    link_id: link.id,
    link_project_id: link.project_id,
    intake_type: link.intake_type,
    intake_id: link.intake_id,
    linked_plan_id: link.plan_id,
    phase_index: link.phase_index,
    phase_title: link.phase_title,
    link_created_at: link.created_at,
    link_updated_at: link.updated_at,
    ...planAliasFields(plan),
  };
}

function intakeSnapshotJoinRow(row, plans) {
  const plan = plans.find((item) => (
    Number(item.id) === Number(row.linked_plan_id)
      && Number(item.project_id) === Number(row.project_id)
  ));
  return {
    ...row,
    plan_file_path: plan?.file_path ?? null,
    plan_status: plan?.status ?? null,
    plan_completed: plan?.completed_tasks ?? null,
    plan_total: plan?.total_tasks ?? null,
  };
}

function planAliasFields(plan) {
  return {
    existing_plan_id: plan?.id ?? null,
    plan_project_id: plan?.project_id ?? null,
    plan_issue_hash: plan?.issue_hash ?? null,
    plan_file_path: plan?.file_path ?? null,
    plan_hash: plan?.hash ?? null,
    plan_status: plan?.status ?? null,
    plan_sort_order: plan?.sort_order ?? null,
    plan_total_tasks: plan?.total_tasks ?? null,
    plan_completed_tasks: plan?.completed_tasks ?? null,
    plan_validation_passed: plan?.validation_passed ?? null,
    plan_agent_cli_provider: plan?.agent_cli_provider ?? null,
    plan_agent_cli_command: plan?.agent_cli_command ?? null,
    plan_codex_reasoning_effort: plan?.codex_reasoning_effort ?? null,
    plan_agent_cli_session_id: plan?.agent_cli_session_id ?? null,
    plan_created_at: plan?.created_at ?? null,
    plan_updated_at: plan?.updated_at ?? null,
    plan_accepted_at: plan?.accepted_at ?? null,
  };
}

function findSnapshotRow(rows, id) {
  return rows.find((row) => Number(row.id) === Number(id));
}

function pickLinkedPlanFields(plan) {
  return {
    link_id: plan.link_id,
    plan_id: plan.plan_id,
    phase_index: plan.phase_index,
    phase_title: plan.phase_title,
    title: plan.title,
    file_path: plan.file_path,
    status: plan.status,
    completed_tasks: plan.completed_tasks,
    total_tasks: plan.total_tasks,
    validation_passed: plan.validation_passed,
    is_current: plan.is_current,
  };
}

function normalizeSql(sql) {
  return String(sql || '').replace(/\s+/g, ' ').trim();
}

function isProjectPlanQuery(sql) {
  const normalized = normalizeSql(sql);
  return normalized.startsWith('SELECT * FROM plans WHERE project_id = ?');
}

function isTaskSnapshotQuery(sql) {
  return normalizeSql(sql).includes('FROM plan_tasks JOIN plans');
}

function isProjectLinkedPlanBatchQuery(sql) {
  const normalized = normalizeSql(sql);
  return normalized.includes('FROM intake_plan_links links')
    && normalized.includes('WHERE links.project_id = ?')
    && normalized.includes('ORDER BY links.intake_type ASC');
}

function isLegacyLinkedPlanFallbackQuery(sql) {
  const normalized = normalizeSql(sql);
  return normalized.includes('NOT EXISTS')
    && normalized.includes('FROM intake_plan_links links')
    && (normalized.includes('FROM requirements') || normalized.includes('FROM feedback'));
}

function isPerIntakeLinkedPlanQuery(sql) {
  const normalized = normalizeSql(sql);
  return normalized.includes('FROM intake_plan_links links')
    && normalized.includes('AND links.intake_type = ?')
    && normalized.includes('AND links.intake_id = ?');
}

function isRequirementSnapshotQuery(sql) {
  const normalized = normalizeSql(sql);
  return normalized.includes('FROM requirements')
    && normalized.includes('LEFT JOIN plans')
    && !normalized.includes('NOT EXISTS');
}

function isFeedbackSnapshotQuery(sql) {
  const normalized = normalizeSql(sql);
  return normalized.includes('FROM feedback')
    && normalized.includes('LEFT JOIN plans')
    && !normalized.includes('NOT EXISTS');
}

function isScanSummaryQuery(sql) {
  const normalized = normalizeSql(sql);
  return normalized.includes('COUNT(*) AS count')
    && normalized.includes('FROM scan_files')
    && normalized.includes('WHERE project_id = ?');
}

function isFullScanFilesSnapshotQuery(sql) {
  const normalized = normalizeSql(sql);
  return normalized.includes('SELECT * FROM scan_files')
    && normalized.includes('ORDER BY scanned_at DESC');
}

function comparePlanRows(left, right) {
  return Number(left.sort_order || 0) - Number(right.sort_order || 0)
    || String(left.created_at || '').localeCompare(String(right.created_at || ''))
    || Number(left.id) - Number(right.id);
}

function compareIntakePlanLinkRows(left, right) {
  return String(left.intake_type || '').localeCompare(String(right.intake_type || ''))
    || Number(left.intake_id) - Number(right.intake_id)
    || Number(left.phase_index) - Number(right.phase_index)
    || Number(left.plan_id) - Number(right.plan_id);
}

function compareUpdatedDesc(left, right) {
  return String(right.updated_at || '').localeCompare(String(left.updated_at || ''));
}

describe('planBackendSnapshotFields Claude authToken masking', () => {
  // 直接测 planBackendSnapshotFields 的脱敏逻辑：authToken 列被 mask 成 ····1234，
  // 并新增 *_has_claude_auth_token 布尔位；baseUrl/model 等非敏感字段原样输出。
  const { planBackendSnapshotFields } = snapshots;

  it('masks non-empty authToken to ···· + last 4 and sets has flag true', () => {
    const fields = planBackendSnapshotFields({
      plan_generation_claude_base_url: 'https://plan.example.com',
      plan_generation_claude_auth_token: 'sk-secret-abcd',
      plan_generation_claude_model: 'claude-sonnet-4-5',
      plan_execution_claude_auth_token: 'sk-exec-xyz',
    });

    assert.equal(fields.plan_generation_claude_base_url, 'https://plan.example.com');
    assert.equal(fields.plan_generation_claude_auth_token, '····abcd');
    assert.equal(fields.plan_generation_has_claude_auth_token, true);
    assert.equal(fields.plan_generation_claude_model, 'claude-sonnet-4-5');
    assert.equal(fields.plan_execution_claude_auth_token, '····-xyz');
    assert.equal(fields.plan_execution_has_claude_auth_token, true);
  });

  it('returns empty authToken and has flag false when token absent', () => {
    const fields = planBackendSnapshotFields({
      plan_generation_claude_base_url: '',
      plan_generation_claude_auth_token: '',
    });

    assert.equal(fields.plan_generation_claude_auth_token, '');
    assert.equal(fields.plan_generation_has_claude_auth_token, false);
    // baseUrl 列即使为空也原样输出（非敏感字段，UI 需要回填）。
    assert.equal(fields.plan_generation_claude_base_url, '');
  });

  it('masks short tokens (<=4 chars) fully without leaking tail', () => {
    const fields = planBackendSnapshotFields({
      plan_generation_claude_auth_token: 'abc',
    });
    assert.equal(fields.plan_generation_claude_auth_token, '····');
    assert.equal(fields.plan_generation_has_claude_auth_token, true);
  });

  it('omits plan backend columns when source row has no such keys', () => {
    const fields = planBackendSnapshotFields({ unrelated_column: 'x' });
    assert.ok(!('plan_generation_claude_auth_token' in fields));
    assert.ok(!('plan_generation_has_claude_auth_token' in fields));
    assert.ok(!('plan_generation_claude_base_url' in fields));
  });
});
