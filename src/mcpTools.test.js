const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { MCP_TOOL_NAMES, callMcpTool } = require('./mcpTools');

describe('MCP intake linkedPlans contract', () => {
  it('list_requirements returns every linked phase plan and keeps linkedPlanId compatibility', async () => {
    const workspace = createTempWorkspace({
      'docs/plan/phase-one.md': '# 阶段一模型\n',
      'docs/plan/phase-two.md': '# 阶段二交付\n',
    });
    try {
      const db = createMcpDbStub({
        projects: [{ id: 1, name: 'P', workspace_path: workspace, updated_at: '2026-01-01' }],
        requirements: [
          { id: 10, project_id: 1, title: '阶段化需求', body: '分阶段推进', status: 'open', linked_plan_id: 101, created_at: '2026-01-01', updated_at: '2026-01-02' },
        ],
        plans: [
          { id: 101, project_id: 1, file_path: 'docs/plan/phase-one.md', status: 'completed', completed_tasks: 2, total_tasks: 2, validation_passed: 1 },
          { id: 102, project_id: 1, file_path: 'docs/plan/phase-two.md', status: 'pending', completed_tasks: 1, total_tasks: 4, validation_passed: 0 },
        ],
        intakePlanLinks: [
          { id: 1001, project_id: 1, intake_type: 'requirement', intake_id: 10, plan_id: 101, phase_index: 1, phase_title: '基础阶段' },
          { id: 1002, project_id: 1, intake_type: 'requirement', intake_id: 10, plan_id: 102, phase_index: 2, phase_title: '交付阶段' },
        ],
      });

      const result = await callMcpTool(
        MCP_TOOL_NAMES.LIST_REQUIREMENTS,
        { projectId: 1 },
        { db, loop: createLoopStub(db) },
      );

      assert.equal(result.isError, undefined);
      const [requirement] = result.structuredContent.requirements;
      assert.equal(requirement.linkedPlanId, 101, 'legacy linkedPlanId 应保持第一阶段 plan id');
      assert.deepEqual(requirement.linkedPlans.map((plan) => plan.planId), [101, 102]);
      assert.deepEqual(requirement.linkedPlans.map((plan) => plan.phaseIndex), [1, 2]);
      assert.deepEqual(requirement.linkedPlans.map((plan) => plan.phaseTitle), ['基础阶段', '交付阶段']);
      assert.deepEqual(requirement.linkedPlans.map((plan) => plan.title), ['阶段一模型', '阶段二交付']);
      assert.deepEqual(requirement.linkedPlans.map((plan) => plan.current), [false, true], '当前阶段应指向第一个未完成 plan');
      assert.deepEqual(
        requirement.linkedPlans.map((plan) => [plan.status, plan.completedTasks, plan.totalTasks, plan.validationPassed]),
        [['completed', 2, 2, true], ['pending', 1, 4, false]],
      );
    } finally {
      removeTempDir(workspace);
    }
  });

  it('create_requirement returns an empty linkedPlans array for a newly created unplanned intake', async () => {
    const db = createMcpDbStub({
      projects: [{ id: 1, name: 'P', workspace_path: '', updated_at: '2026-01-01' }],
    });
    const intakeService = {
      createRequirement(input) {
        const now = '2026-01-03T00:00:00.000Z';
        db._requirements.push({
          id: 200,
          project_id: input.projectId,
          title: input.title,
          body: input.body,
          status: input.status || 'open',
          linked_plan_id: null,
          created_at: now,
          updated_at: now,
        });
        return {
          activeProjectId: input.projectId,
          requirements: db._requirements,
          feedback: [],
          plans: [],
          tasks: [],
          events: [],
        };
      },
    };

    const result = await callMcpTool(
      MCP_TOOL_NAMES.CREATE_REQUIREMENT,
      { projectId: 1, title: '新需求', body: '先记录需求' },
      { db, intakeService },
    );

    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent.requirementId, 200);
    assert.equal(result.structuredContent.requirement.linkedPlanId, null);
    assert.deepEqual(result.structuredContent.requirement.linkedPlans, []);
    assert.equal(result.structuredContent.openable.type, 'requirement');
    assert.equal(result.structuredContent.openable.id, 200);
  });
});

describe('MCP plan backend config inputs', () => {
  it('create_project forwards generation and execution defaults to intake service', async () => {
    const calls = [];
    const intakeService = {
      createProject(input) {
        calls.push(input);
        return {
          activeProjectId: 7,
          activeProject: { id: 7, name: input.name, workspace_path: input.workspacePath, description: input.description },
          projects: [{ id: 7, name: input.name, workspace_path: input.workspacePath, description: input.description }],
          requirements: [],
          feedback: [],
          plans: [],
          tasks: [],
          executors: [],
          events: [],
          state: {
            project_id: 7,
            plan_generation_strategy: input.planGenerationStrategy,
            plan_generation_provider: input.planGenerationProvider,
            plan_generation_model: input.planGenerationModel,
            plan_execution_strategy: input.planExecutionStrategy,
            plan_execution_provider: input.planExecutionProvider,
            plan_execution_command: input.planExecutionCommand,
          },
        };
      },
    };

    const result = await callMcpTool(
      MCP_TOOL_NAMES.CREATE_PROJECT,
      {
        name: 'Backend Project',
        workspacePath: '/tmp/backend-project',
        description: 'plan backend defaults',
        planGenerationStrategy: 'builtin-llm-structured',
        planGenerationProvider: 'openai',
        planGenerationModel: 'gpt-4o',
        planExecutionStrategy: 'external-cli',
        planExecutionProvider: 'claude',
        planExecutionCommand: 'claude-exec',
      },
      { intakeService },
    );

    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent.projectId, 7);
    assert.deepEqual(calls, [{
      name: 'Backend Project',
      workspacePath: '/tmp/backend-project',
      description: 'plan backend defaults',
      planGenerationStrategy: 'builtin-llm-structured',
      planGenerationProvider: 'openai',
      planGenerationModel: 'gpt-4o',
      planExecutionStrategy: 'external-cli',
      planExecutionProvider: 'claude',
      planExecutionCommand: 'claude-exec',
    }]);
    assert.equal(result.structuredContent.snapshot.state.planGenerationStrategy, 'builtin-llm-structured');
    assert.equal(result.structuredContent.snapshot.state.planExecutionProvider, 'claude');
  });

  it('create_requirement and create_feedback accept generation overrides only', async () => {
    const db = createMcpDbStub({
      projects: [{ id: 1, name: 'P', workspace_path: '', updated_at: '2026-01-01' }],
    });
    const calls = [];
    const intakeService = {
      createRequirement(input) {
        calls.push({ type: 'requirement', input });
        const row = intakeRow(input, {
          id: 301,
          plan_generation_strategy: input.planGenerationStrategy,
          plan_generation_provider: input.planGenerationProvider,
          plan_generation_command: input.planGenerationCommand,
          plan_generation_model: input.planGenerationModel,
          plan_generation_codex_reasoning_effort: input.planGenerationCodexReasoningEffort,
        });
        db._requirements.push(row);
        return createLoopStub(db).snapshot(input.projectId);
      },
      createFeedback(input) {
        calls.push({ type: 'feedback', input });
        const row = intakeRow(input, {
          id: 401,
          requirement_id: input.requirementId,
          plan_generation_strategy: input.planGenerationStrategy,
          plan_generation_provider: input.planGenerationProvider,
          plan_generation_command: input.planGenerationCommand,
          plan_generation_model: input.planGenerationModel,
          plan_generation_codex_reasoning_effort: input.planGenerationCodexReasoningEffort,
        });
        db._feedback.push(row);
        return createLoopStub(db).snapshot(input.projectId);
      },
    };

    const requirement = await callMcpTool(
      MCP_TOOL_NAMES.CREATE_REQUIREMENT,
      {
        projectId: 1,
        title: '结构化需求',
        body: '生成 PlanSpec',
        planGenerationStrategy: 'external-cli-structured',
        planGenerationProvider: 'codex',
        planGenerationCommand: 'codex-plan',
        planGenerationCodexReasoningEffort: 'xhigh',
      },
      { db, intakeService },
    );
    const feedback = await callMcpTool(
      MCP_TOOL_NAMES.CREATE_FEEDBACK,
      {
        projectId: 1,
        requirementId: 301,
        title: '内置反馈',
        body: '使用内置 LLM',
        planGenerationStrategy: 'builtin-llm-structured',
        planGenerationProvider: 'deepseek',
        planGenerationModel: 'deepseek-reasoner',
      },
      { db, intakeService },
    );

    assert.equal(requirement.isError, undefined);
    assert.equal(feedback.isError, undefined);
    assert.equal(calls[0].input.planGenerationStrategy, 'external-cli-structured');
    assert.equal(calls[0].input.planGenerationCodexReasoningEffort, 'xhigh');
    assert.equal(calls[1].input.planGenerationStrategy, 'builtin-llm-structured');
    assert.equal(calls[1].input.planGenerationProvider, 'deepseek');
    assert.equal(requirement.structuredContent.requirement.planGenerationStrategy, 'external-cli-structured');
    assert.equal(requirement.structuredContent.requirement.planGenerationCommand, 'codex-plan');
    assert.equal(feedback.structuredContent.feedback.planGenerationStrategy, 'builtin-llm-structured');
    assert.equal(feedback.structuredContent.feedback.planGenerationModel, 'deepseek-reasoner');

    const rejected = await callMcpTool(
      MCP_TOOL_NAMES.CREATE_REQUIREMENT,
      {
        projectId: 1,
        title: '非法执行覆盖',
        body: '单条 intake 不应覆盖执行后端',
        planExecutionProvider: 'claude',
      },
      { db, intakeService },
    );

    assert.equal(rejected.isError, true);
    assert.match(rejected.structuredContent.error, /Plan execution overrides are not supported/);
    assert.match(rejected.structuredContent.error, /planExecutionProvider/);
  });

  it('keeps legacy agentCli fields compatible while validating new enum values', async () => {
    const db = createMcpDbStub({
      projects: [{ id: 1, name: 'P', workspace_path: '', updated_at: '2026-01-01' }],
    });
    const calls = [];
    const intakeService = {
      createRequirement(input) {
        calls.push(input);
        db._requirements.push(intakeRow(input, {
          id: 501,
          agent_cli_provider: input.agentCliProvider,
          agent_cli_command: input.agentCliCommand,
          codex_reasoning_effort: input.codexReasoningEffort,
        }));
        return createLoopStub(db).snapshot(input.projectId);
      },
    };

    const legacy = await callMcpTool(
      MCP_TOOL_NAMES.CREATE_REQUIREMENT,
      {
        projectId: 1,
        title: '旧字段需求',
        body: '沿用 agentCli* 覆盖',
        agentCliProvider: 'claude',
        agentCliCommand: 'claude-plan',
        codexReasoningEffort: 'xhigh',
      },
      { db, intakeService },
    );
    const badGeneration = await callMcpTool(
      MCP_TOOL_NAMES.CREATE_PROJECT,
      { name: 'Bad', workspacePath: '/tmp/bad', planGenerationStrategy: 'agentic-json' },
      { intakeService: { createProject() { throw new Error('should not call service'); } } },
    );
    const badExecution = await callMcpTool(
      MCP_TOOL_NAMES.CREATE_PROJECT,
      { name: 'Bad', workspacePath: '/tmp/bad', planExecutionProvider: 'local-llm' },
      { intakeService: { createProject() { throw new Error('should not call service'); } } },
    );

    assert.equal(legacy.isError, undefined);
    assert.equal(calls[0].agentCliProvider, 'claude');
    assert.equal(calls[0].agentCliCommand, 'claude-plan');
    assert.equal(calls[0].codexReasoningEffort, 'xhigh');
    assert.equal(legacy.structuredContent.requirement.agentCliProvider, 'claude');
    assert.equal(legacy.structuredContent.requirement.agentCliCommand, 'claude-plan');

    assert.equal(badGeneration.isError, true);
    assert.match(badGeneration.structuredContent.error, /planGenerationStrategy must be one of: external-cli-markdown, external-cli-structured, builtin-llm-structured/);
    assert.equal(badExecution.isError, true);
    assert.match(badExecution.structuredContent.error, /planExecutionProvider must be one of:/);
  });
});

describe('MCP executor tools contract', () => {
  it('list_executors returns configured project executors with recent status, log tail, and openable target', async () => {
    const longLog = `${'x'.repeat(4200)}tail`;
    const db = createMcpDbStub({
      projects: [{ id: 1, name: 'P', workspace_path: '', updated_at: '2026-01-01' }],
      executors: [
        executorRow({ id: 1, label: 'build', command: 'npm run build', group_kind: 'build', last_status: 'ok', last_exit_code: 0, last_duration_ms: 99, last_log: longLog }),
        executorRow({ id: 2, label: 'test', command: 'npm test', group_kind: 'test', last_status: 'bad', last_exit_code: 1 }),
      ],
    });

    const result = await callMcpTool(
      MCP_TOOL_NAMES.LIST_EXECUTORS,
      { projectId: 1, group: 'build' },
      { db, loop: createLoopStub(db) },
    );

    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent.projectId, 1);
    assert.equal(result.structuredContent.executors.length, 1);
    const [executor] = result.structuredContent.executors;
    assert.equal(executor.id, 1);
    assert.equal(executor.label, 'build');
    assert.equal(executor.status, 'ok');
    assert.equal(executor.exitCode, 0);
    assert.equal(executor.durationMs, 99);
    assert.equal(executor.logTail.length, 4000);
    assert.ok(executor.logTail.endsWith('tail'));
    assert.equal(executor.openable.anchorId, 'workspace-executor-1');
    assert.equal(executor.openable.link, '#/projects/1?tab=executors&anchor=workspace-executor-1');
  });

  it('run_executor resolves an existing label and returns summarized run output only', async () => {
    const db = createMcpDbStub({
      projects: [{ id: 1, name: 'P', workspace_path: '', updated_at: '2026-01-01' }],
      executors: [
        executorRow({ id: 3, label: 'test', command: 'npm test', group_kind: 'test' }),
      ],
    });
    const loop = createLoopStub(db, {
      runResult: {
        executorId: 3,
        label: 'test',
        status: 'bad',
        exitCode: 1,
        durationMs: 123,
        log: `${'L'.repeat(4100)}END`,
        logFile: 'docs/progress/logs/test.log',
        dependencyResults: [
          { executorId: 1, label: 'prepare', status: 'ok', exitCode: 0, durationMs: 10, log: 'prep ok' },
        ],
        snapshot: { activeProjectId: 1, projects: db._projects, executors: db._executors, events: [] },
      },
    });

    const result = await callMcpTool(
      MCP_TOOL_NAMES.RUN_EXECUTOR,
      { projectId: 1, label: 'test' },
      { db, loop },
    );

    assert.equal(result.isError, undefined);
    assert.deepEqual(loop.runExecutorCalls, [{ projectId: 1, executorId: 3 }]);
    assert.equal(result.structuredContent.executorId, 3);
    assert.equal(result.structuredContent.label, 'test');
    assert.equal(result.structuredContent.status, 'bad');
    assert.equal(result.structuredContent.exitCode, 1);
    assert.equal(result.structuredContent.durationMs, 123);
    assert.equal(result.structuredContent.logTail.length, 4000);
    assert.ok(result.structuredContent.logTail.endsWith('END'));
    assert.equal(result.structuredContent.log, undefined, 'full long log should not be exposed');
    assert.deepEqual(result.structuredContent.dependencyResults.map((item) => [item.executorId, item.label, item.status]), [
      [1, 'prepare', 'ok'],
    ]);
    assert.equal(result.structuredContent.snapshot.counts.executors, 1);
  });

  it('stop_executor targets an existing executor id and returns stopped count', async () => {
    const db = createMcpDbStub({
      projects: [{ id: 1, name: 'P', workspace_path: '', updated_at: '2026-01-01' }],
      executors: [executorRow({ id: 4, label: 'watch', command: 'npm run watch' })],
    });
    const loop = createLoopStub(db, { stopResult: { stopped: 2, executorId: 4, label: 'watch' } });

    const result = await callMcpTool(
      MCP_TOOL_NAMES.STOP_EXECUTOR,
      { projectId: 1, executorId: 4 },
      { db, loop },
    );

    assert.equal(result.isError, undefined);
    assert.deepEqual(loop.stopExecutorCalls, [{ projectId: 1, executorId: 4 }]);
    assert.equal(result.structuredContent.stopped, 2);
    assert.equal(result.structuredContent.executor.label, 'watch');
  });

  it('run_executor rejects arbitrary command fields and missing executor selectors', async () => {
    const db = createMcpDbStub({
      projects: [{ id: 1, name: 'P', workspace_path: '', updated_at: '2026-01-01' }],
      executors: [executorRow({ id: 5, label: 'safe', command: 'npm test' })],
    });
    const loop = createLoopStub(db);

    const arbitrary = await callMcpTool(
      MCP_TOOL_NAMES.RUN_EXECUTOR,
      { projectId: 1, executorId: 5, command: 'rm -rf .' },
      { db, loop },
    );
    const missing = await callMcpTool(
      MCP_TOOL_NAMES.RUN_EXECUTOR,
      { projectId: 1 },
      { db, loop },
    );

    assert.equal(arbitrary.isError, true);
    assert.match(arbitrary.structuredContent.error, /Unsupported input fields: command/);
    assert.equal(missing.isError, true);
    assert.match(missing.structuredContent.error, /executorId or label is required/);
    assert.deepEqual(loop.runExecutorCalls, []);
  });
});

function createMcpDbStub({ projects = [], requirements = [], feedback = [], plans = [], intakePlanLinks = [], executors = [] } = {}) {
  return {
    _projects: projects,
    _requirements: requirements,
    _feedback: feedback,
    _plans: plans,
    _intakePlanLinks: intakePlanLinks,
    _executors: executors,
    all(sql, params = []) {
      if (sql.includes('FROM intake_plan_links')) return resolveMcpIntakePlanLinks(this, params);
      if (sql.includes('FROM executors')) return listExecutorRows(this._executors, sql, params);
      if (sql.includes('FROM requirements')) return listRows(this._requirements, params);
      if (sql.includes('FROM feedback')) return listRows(this._feedback, params);
      if (sql.includes('FROM projects')) return this._projects.slice();
      return [];
    },
    get(sql, params = []) {
      if (sql.includes('SELECT workspace_path FROM projects')) {
        return this._projects.find((project) => Number(project.id) === Number(params[0])) || null;
      }
      if (sql.includes('FROM requirements') && sql.includes('ORDER BY id DESC')) {
        return latestRow(this._requirements, params[0]);
      }
      if (sql.includes('FROM feedback') && sql.includes('ORDER BY id DESC')) {
        return latestRow(this._feedback, params[0]);
      }
      if (sql.includes('FROM executors') && sql.includes('label = ?')) {
        const [projectId, label] = params;
        return this._executors.find((executor) => Number(executor.project_id) === Number(projectId) && String(executor.label) === String(label)) || null;
      }
      if (sql.includes('FROM executors')) {
        const [executorId, projectId] = params;
        return this._executors.find((executor) => Number(executor.id) === Number(executorId) && Number(executor.project_id) === Number(projectId)) || null;
      }
      if (sql.includes('FROM plans')) {
        const [planId, projectId] = params;
        return this._plans.find((plan) => Number(plan.id) === Number(planId) && Number(plan.project_id) === Number(projectId)) || null;
      }
      return null;
    },
  };
}

function listRows(rows, params) {
  const projectId = params[0];
  const limit = Number(params[params.length - 1] || 100);
  let result = rows.filter((row) => Number(row.project_id) === Number(projectId));
  if (params.length === 3) {
    result = result.filter((row) => row.status === params[1]);
  }
  return result
    .slice()
    .sort((left, right) => String(right.updated_at || '').localeCompare(String(left.updated_at || '')) || Number(right.id) - Number(left.id))
    .slice(0, limit);
}

function listExecutorRows(rows, sql, params) {
  const projectId = params[0];
  let paramIndex = 1;
  let result = rows.filter((row) => Number(row.project_id) === Number(projectId));
  if (sql.includes('label LIKE ?')) {
    const keyword = String(params[paramIndex++] || '').replace(/%/g, '');
    result = result.filter((row) => String(row.label || '').includes(keyword));
  }
  if (sql.includes('group_kind = ?')) {
    const group = params[paramIndex++];
    result = result.filter((row) => String(row.group_kind || '') === String(group));
  }
  if (sql.includes('enabled = ?')) {
    const enabled = Number(params[paramIndex++]);
    result = result.filter((row) => Number(row.enabled || 0) === enabled);
  }
  return result
    .slice()
    .sort((left, right) => Number(left.sort_order || 0) - Number(right.sort_order || 0) || Number(left.id) - Number(right.id));
}

function latestRow(rows, projectId) {
  return listRows(rows, [projectId, 1])[0] || null;
}

function resolveMcpIntakePlanLinks(db, params) {
  const [projectId, intakeType, intakeId] = params;
  return (db._intakePlanLinks || [])
    .filter((link) => Number(link.project_id) === Number(projectId))
    .filter((link) => String(link.intake_type) === String(intakeType))
    .filter((link) => Number(link.intake_id) === Number(intakeId))
    .sort((left, right) => Number(left.phase_index || 0) - Number(right.phase_index || 0) || Number(left.plan_id || 0) - Number(right.plan_id || 0))
    .map((link, index) => {
      const plan = (db._plans || []).find((item) => Number(item.id) === Number(link.plan_id) && Number(item.project_id) === Number(link.project_id));
      return {
        link_id: link.id || index + 1,
        link_project_id: link.project_id,
        intake_type: link.intake_type,
        intake_id: link.intake_id,
        linked_plan_id: link.plan_id,
        phase_index: link.phase_index,
        phase_title: link.phase_title,
        link_created_at: link.created_at || null,
        link_updated_at: link.updated_at || null,
        existing_plan_id: plan?.id || null,
        plan_project_id: plan?.project_id || link.project_id,
        plan_issue_hash: plan?.issue_hash || '',
        plan_file_path: plan?.file_path || '',
        plan_hash: plan?.hash || '',
        plan_status: plan?.status || null,
        plan_sort_order: plan?.sort_order || 0,
        plan_total_tasks: plan?.total_tasks ?? null,
        plan_completed_tasks: plan?.completed_tasks ?? null,
        plan_validation_passed: plan?.validation_passed ?? null,
        plan_agent_cli_provider: plan?.agent_cli_provider || null,
        plan_agent_cli_command: plan?.agent_cli_command || '',
        plan_codex_reasoning_effort: plan?.codex_reasoning_effort || null,
        plan_agent_cli_session_id: plan?.agent_cli_session_id || null,
        plan_created_at: plan?.created_at || null,
        plan_updated_at: plan?.updated_at || null,
        plan_accepted_at: plan?.accepted_at || null,
      };
    });
}

function createLoopStub(db, options = {}) {
  return {
    runExecutorCalls: [],
    stopExecutorCalls: [],
    project(projectId) {
      return db._projects.find((project) => Number(project.id) === Number(projectId)) || null;
    },
    status() {
      return {};
    },
    existingRuntime() {
      return options.runtime || null;
    },
    async runExecutor(projectId, executorId) {
      this.runExecutorCalls.push({ projectId, executorId });
      return options.runResult || {
        executorId,
        label: db._executors.find((executor) => Number(executor.id) === Number(executorId))?.label || '',
        status: 'ok',
        exitCode: 0,
        durationMs: 1,
        log: 'ok',
        snapshot: this.snapshot(projectId),
      };
    },
    stopExecutor(projectId, executorId) {
      this.stopExecutorCalls.push({ projectId, executorId });
      return options.stopResult || { stopped: 1, executorId };
    },
    snapshot(projectId) {
      return {
        activeProjectId: projectId,
        activeProject: this.project(projectId),
        projects: db._projects,
        requirements: db._requirements,
        feedback: db._feedback,
        plans: db._plans,
        tasks: [],
        executors: db._executors,
        events: [],
        state: {},
      };
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

function intakeRow(input, overrides = {}) {
  const now = '2026-07-04T00:00:00.000Z';
  return {
    id: overrides.id || 1,
    project_id: input.projectId,
    requirement_id: overrides.requirement_id ?? null,
    title: input.title,
    body: input.body,
    status: input.status || 'open',
    linked_plan_id: null,
    agent_cli_provider: overrides.agent_cli_provider || null,
    agent_cli_command: overrides.agent_cli_command || '',
    codex_reasoning_effort: overrides.codex_reasoning_effort || null,
    plan_generation_strategy: overrides.plan_generation_strategy || null,
    plan_generation_provider: overrides.plan_generation_provider || null,
    plan_generation_command: overrides.plan_generation_command || '',
    plan_generation_model: overrides.plan_generation_model || '',
    plan_generation_codex_reasoning_effort: overrides.plan_generation_codex_reasoning_effort || null,
    created_at: now,
    updated_at: now,
  };
}

function createTempWorkspace(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoplan-mcp-tools-'));
  for (const [name, content] of Object.entries(files)) {
    const filePath = path.join(dir, name);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
  }
  return dir;
}

function removeTempDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
}
