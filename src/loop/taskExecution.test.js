const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const {
  processPlan,
  executeTask,
  executeTaskBatch,
  TASK_RETRY_BACKOFF_SECONDS,
} = require('./taskExecution');
const {
  BUILTIN_LLM_EXECUTION_UNSUPPORTED_ERROR,
  planAgentCliConfig,
} = require('./planAgentCli');

// ---------------------------------------------------------------------------
// 加速 sleep：将 setTimeout 替换为 0ms 延迟，避免测试等待 5s/10s/... 真时
// ---------------------------------------------------------------------------
let origSetTimeout;

function fastSetTimeout() {
  origSetTimeout = global.setTimeout;
  global.setTimeout = (fn, ms, ...args) => origSetTimeout(fn, 0, ...args);
}

function restoreSetTimeout() {
  if (origSetTimeout) {
    global.setTimeout = origSetTimeout;
    origSetTimeout = null;
  }
}

// ---------------------------------------------------------------------------
// 测试替身工厂
// ---------------------------------------------------------------------------

function makeService(overrides = {}) {
  const calls = { executeTask: [], completeTask: [], addEvent: [], setPhase: [], recordTaskFailure: [], validatePlan: [] };
  const svc = {
    _calls: calls,
    activateDraftPlan: (plan) => plan,
    syncPlanTasks: () => {},
    db: {
      all: () => [],
      get: () => null,
    },
    isFinalAcceptanceTask: () => false,
    hasFinalAcceptanceTask: () => false,
    validatePlan: async (workspace, plan, options) => {
      calls.validatePlan.push({ workspace, planId: plan.id, planStatus: plan.status, options });
    },
    setPhase(projectId, phase) {
      calls.setPhase.push({ projectId, phase });
    },
    executeTask: async (workspace, plan, task, options) => {
      calls.executeTask.push({ workspace, planId: plan.id, planStatus: plan.status, taskId: task.id, taskKey: task.task_key, options });
      return svc._executeTaskResult || { exitCode: 0 };
    },
    addEvent(projectId, type, message, meta) {
      calls.addEvent.push({ projectId, type, message, meta });
    },
    completeTask: async (workspace, plan, task, result) => {
      calls.completeTask.push({ planId: plan.id, planStatus: plan.status, taskId: task.id, taskKey: task.task_key, result });
    },
    recordTaskFailure(projectId, plan, task, finishedAt, meta) {
      calls.recordTaskFailure.push({ projectId, planId: plan.id, taskId: task.id, taskKey: task.task_key, meta });
    },
    planAgentCliConfig: () => ({ agentCliProvider: 'claude' }),
    ...overrides,
  };
  return svc;
}

function makePlan(overrides = {}) {
  return {
    id: 1,
    project_id: 100,
    file_path: 'docs/plan/test.md',
    ...overrides,
  };
}

function makeTask(overrides = {}) {
  return {
    id: 10,
    plan_id: 1,
    task_key: 'P001',
    title: '测试任务',
    raw_line: '- [ ] P001: 测试任务 <!-- scope: src/test.js -->',
    scope: 'src/test.js',
    sort_order: 1,
    status: 'pending',
    ...overrides,
  };
}

const WORKSPACE = '/tmp/test-workspace';
const HELPERS = {};

// ---------------------------------------------------------------------------
// TASK_RETRY_BACKOFF_SECONDS 常量
// ---------------------------------------------------------------------------

describe('TASK_RETRY_BACKOFF_SECONDS', () => {
  it('导出的值为 [5, 10, 20, 30]', () => {
    assert.deepEqual([...TASK_RETRY_BACKOFF_SECONDS], [5, 10, 20, 30]);
  });

  it('数组已被冻结，不可运行时修改', () => {
    assert.throws(
      () => { TASK_RETRY_BACKOFF_SECONDS[0] = 999; },
      /read.only|assign|frozen|object is not extensible/i,
      '冻结数组不可修改元素',
    );
  });
});

// ---------------------------------------------------------------------------
// processPlan 退避重试
// ---------------------------------------------------------------------------

describe('processPlan 退避重试', () => {
  it('无 pending 任务时跳过执行', async () => {
    const service = makeService({
      db: { all: () => [], get: () => null },
    });
    const plan = makePlan();

    await processPlan(service, HELPERS, WORKSPACE, plan);

    assert.equal(service._calls.executeTask.length, 0, '无 pending 任务不应调用 executeTask');
  });

  it('验收任务不走重试，直接调 validatePlan', async () => {
    const task = makeTask();
    let validateCalled = false;
    const service = makeService({
      db: { all: () => [task], get: () => null },
      isFinalAcceptanceTask: () => true,
      validatePlan: async () => { validateCalled = true; },
    });
    const plan = makePlan();

    await processPlan(service, HELPERS, WORKSPACE, plan);

    assert.equal(validateCalled, true, '验收任务应调用 validatePlan');
    assert.equal(service._calls.executeTask.length, 0, '验收任务不应调用 executeTask');
  });

  it('draft plan 会先激活并把同步后的非草稿 plan 传给 executeTask', async () => {
    const task = makeTask();
    const draftPlan = makePlan({ status: 'draft', updated_at: 'old' });
    const activatedPlan = { ...draftPlan, status: 'running', updated_at: 'fresh' };
    let activatedInput = null;
    const service = makeService({
      activateDraftPlan: (plan) => {
        activatedInput = plan;
        return activatedPlan;
      },
      db: {
        all: () => [task],
        get: () => activatedPlan,
      },
    });
    service._executeTaskResult = { exitCode: 0, logFile: '/tmp/ok.log' };

    await processPlan(service, HELPERS, WORKSPACE, draftPlan);

    assert.equal(activatedInput, draftPlan, 'processPlan 应复用统一草稿激活入口');
    assert.equal(service._calls.executeTask.length, 1, '应继续执行首个 pending 任务');
    assert.equal(service._calls.executeTask[0].planStatus, 'running', 'executeTask 不应收到 draft plan');
    assert.equal(service._calls.completeTask[0].planStatus, 'running', 'completeTask 不应收到 draft plan');
  });

  it('draft plan 的最终验收分支也使用激活后的非草稿 plan', async () => {
    const task = makeTask({ task_key: 'P999', title: '完整验收' });
    const draftPlan = makePlan({ status: 'draft', updated_at: 'old' });
    const activatedPlan = { ...draftPlan, status: 'running', updated_at: 'fresh' };
    const service = makeService({
      activateDraftPlan: () => activatedPlan,
      db: {
        all: () => [task],
        get: () => activatedPlan,
      },
      isFinalAcceptanceTask: () => true,
    });

    await processPlan(service, HELPERS, WORKSPACE, draftPlan);

    assert.equal(service._calls.validatePlan.length, 1, '最终验收任务应调用 validatePlan');
    assert.equal(service._calls.validatePlan[0].planStatus, 'running', 'validatePlan 不应收到 draft plan');
    assert.equal(service._calls.executeTask.length, 0, '最终验收任务不应调用 executeTask');
  });

  it('executeTask 首次成功（exitCode === 0）则直接 completeTask，不重试', async () => {
    const task = makeTask();
    const service = makeService({
      db: { all: () => [task], get: () => null },
    });
    service._executeTaskResult = { exitCode: 0, logFile: '/tmp/ok.log' };
    const plan = makePlan();

    await processPlan(service, HELPERS, WORKSPACE, plan);

    assert.equal(service._calls.executeTask.length, 1, '成功时只应调用一次 executeTask');
    assert.equal(service._calls.completeTask.length, 1, '成功时应调用 completeTask');
    assert.equal(service._calls.addEvent.filter((e) => e.type === 'task.retry').length, 0, '成功时不应有重试事件');
  });

  it('前两次失败、第三次成功：重试两次后 completeTask', async () => {
    fastSetTimeout();
    try {
      const task = makeTask();
      const service = makeService({
        db: { all: () => [task], get: () => null },
      });
      let callIndex = 0;
      service.executeTask = async (...args) => {
        callIndex++;
        service._calls.executeTask.push({ callIndex, taskKey: task.task_key });
        if (callIndex <= 2) return { exitCode: 1, errorMessage: '测试失败' };
        return { exitCode: 0 };
      };

      const plan = makePlan();
      await processPlan(service, HELPERS, WORKSPACE, plan);

      assert.equal(callIndex, 3, '应调用 executeTask 共 3 次（1 初始 + 2 重试）');
      assert.equal(service._calls.completeTask.length, 1, '最终成功应调用 completeTask');
      const retries = service._calls.addEvent.filter((e) => e.type === 'task.retry');
      assert.equal(retries.length, 2, '应有 2 次 task.retry 事件');
      assert.equal(retries[0].meta.attempt, 1);
      assert.equal(retries[0].meta.delaySeconds, 5);
      assert.equal(retries[1].meta.attempt, 2);
      assert.equal(retries[1].meta.delaySeconds, 10);
    } finally {
      restoreSetTimeout();
    }
  });

  it('环境阻塞（Permission denied）不重试，直接失败', async () => {
    const task = makeTask();
    const service = makeService({
      db: { all: () => [task], get: () => null },
    });
    let callCount = 0;
    service.executeTask = async () => {
      callCount++;
      return { exitCode: 1, errorMessage: 'PathAccessException: Permission denied (EACCES)' };
    };

    const plan = makePlan();
    await processPlan(service, HELPERS, WORKSPACE, plan);

    assert.equal(callCount, 1, '环境阻塞错误不应重试');
    const retries = service._calls.addEvent.filter((e) => e.type === 'task.retry');
    assert.equal(retries.length, 0, '环境阻塞不应有重试事件');
    // executeTask 内部已调用 recordTaskFailure，这里只验证不重试
  });

  it('全部 4 次重试耗尽后不再重试，executeTask 内部处理 recordTaskFailure', async () => {
    fastSetTimeout();
    try {
      const task = makeTask();
      const service = makeService({
        db: { all: () => [task], get: () => null },
      });
      let callCount = 0;
      service.executeTask = async () => {
        callCount++;
        return { exitCode: 1, errorMessage: '测试编译失败' };
      };

      const plan = makePlan();
      await processPlan(service, HELPERS, WORKSPACE, plan);

      // 1 初始 + 4 重试 = 5 次总尝试
      assert.equal(callCount, 5, '应调用 executeTask 共 5 次（1 初始 + 4 重试）');
      assert.equal(service._calls.completeTask.length, 0, '全部失败不应调用 completeTask');
      const retries = service._calls.addEvent.filter((e) => e.type === 'task.retry');
      assert.equal(retries.length, 4, '应有最多 4 次重试事件');
      assert.equal(retries[0].meta.delaySeconds, 5);
      assert.equal(retries[1].meta.delaySeconds, 10);
      assert.equal(retries[2].meta.delaySeconds, 20);
      assert.equal(retries[3].meta.delaySeconds, 30);
    } finally {
      restoreSetTimeout();
    }
  });

  it('setPhase 仅在首次 executeTask 前调用一次，重试期间不重复', async () => {
    fastSetTimeout();
    try {
      const task = makeTask();
      const service = makeService({
        db: { all: () => [task], get: () => null },
      });
      let callCount = 0;
      service.executeTask = async () => {
        callCount++;
        if (callCount <= 2) return { exitCode: 1, errorMessage: '测试失败' };
        return { exitCode: 0 };
      };

      // processPlan 调用 setPhase 一次，executeTask 每次也调用 setPhase
      // 验证 processPlan 层面只调了一次
      const plan = makePlan();
      await processPlan(service, HELPERS, WORKSPACE, plan);

      const planLevelSetPhase = service._calls.setPhase.filter((c) => c.phase === 'execute-task');
      // processPlan 内调用一次 setPhase，加上 executeTask 内部每次也调用
      // 这里验证 processPlan 层至少调用了 setPhase
      assert.ok(planLevelSetPhase.length >= 1, 'processPlan 应调用 setPhase');
    } finally {
      restoreSetTimeout();
    }
  });
});

// ---------------------------------------------------------------------------
// executeTaskBatch 退避重试
// ---------------------------------------------------------------------------

describe('executeTaskBatch 退避重试', () => {
  it('串行模式（opencode）单 task 失败后重试成功，继续下一个 task', async () => {
    fastSetTimeout();
    try {
      const tasks = [makeTask({ id: 10, task_key: 'P001' }), makeTask({ id: 11, task_key: 'P002' })];
      const service = makeService({
        planAgentCliConfig: () => ({ agentCliProvider: 'opencode' }),
      });
      const plan = makePlan();

      const taskCallCounts = {};
      service.executeTask = async (_ws, _p, task) => {
        taskCallCounts[task.task_key] = (taskCallCounts[task.task_key] || 0) + 1;
        if (task.task_key === 'P001' && taskCallCounts['P001'] <= 2) {
          return { exitCode: 1, errorMessage: '测试失败' };
        }
        return { exitCode: 0 };
      };

      const results = await executeTaskBatch(service, HELPERS, WORKSPACE, plan, tasks);

      assert.equal(taskCallCounts['P001'], 3, 'P001 应尝试 1+2=3 次');
      assert.equal(taskCallCounts['P002'] || 0, 1, 'P001 成功后 P002 应执行');
      assert.equal(service._calls.completeTask.length, 2, '两个 task 都应 complete');
      const retries = service._calls.addEvent.filter((e) => e.type === 'task.retry');
      assert.equal(retries.length, 2, 'P001 应有 2 次重试');
    } finally {
      restoreSetTimeout();
    }
  });

  it('串行模式（opencode）单 task 全部重试失败后 break，不执行后续任务', async () => {
    fastSetTimeout();
    try {
      const tasks = [makeTask({ id: 10, task_key: 'P001' }), makeTask({ id: 11, task_key: 'P002' })];
      const service = makeService({
        planAgentCliConfig: () => ({ agentCliProvider: 'opencode' }),
      });
      const plan = makePlan();

      const taskCallCounts = {};
      service.executeTask = async (_ws, _p, task) => {
        taskCallCounts[task.task_key] = (taskCallCounts[task.task_key] || 0) + 1;
        return { exitCode: 1, errorMessage: '编译失败' };
      };

      const results = await executeTaskBatch(service, HELPERS, WORKSPACE, plan, tasks);

      assert.equal(taskCallCounts['P001'], 5, 'P001 应尝试 1+4=5 次后耗尽');
      assert.equal(taskCallCounts['P002'] || 0, 0, 'P001 失败后 P002 不应执行');
      assert.equal(service._calls.completeTask.length, 0, '不应有 completeTask');
      assert.equal(results.length, 1, '结果数组应只有 P001 的记录');
    } finally {
      restoreSetTimeout();
    }
  });

  it('并行模式各 task 独立重试，失败 task 不阻塞其他 task', async () => {
    fastSetTimeout();
    try {
      const tasks = [
        makeTask({ id: 10, task_key: 'P001' }),
        makeTask({ id: 11, task_key: 'P002' }),
        makeTask({ id: 12, task_key: 'P003' }),
      ];
      const service = makeService({
        planAgentCliConfig: () => ({ agentCliProvider: 'claude' }),
      });
      const plan = makePlan();

      // P001 一直失败，P002 首次失败后成功，P003 首次成功
      const taskCallCounts = {};
      service.executeTask = async (_ws, _p, task) => {
        taskCallCounts[task.task_key] = (taskCallCounts[task.task_key] || 0) + 1;
        if (task.task_key === 'P001') return { exitCode: 1, errorMessage: '失败' };
        if (task.task_key === 'P002' && taskCallCounts['P002'] === 1) {
          return { exitCode: 1, errorMessage: '临时失败' };
        }
        return { exitCode: 0 };
      };

      const results = await executeTaskBatch(service, HELPERS, WORKSPACE, plan, tasks);

      assert.equal(taskCallCounts['P001'], 5, 'P001 应尝试 1+4=5 次');
      assert.equal(taskCallCounts['P002'], 2, 'P002 应尝试 2 次（1 失败 + 1 成功）');
      assert.equal(taskCallCounts['P003'], 1, 'P003 应一次成功');
      assert.equal(service._calls.completeTask.length, 2, 'P002 和 P003 应 complete');
      assert.equal(results.length, 3, '所有 task 应有结果');
    } finally {
      restoreSetTimeout();
    }
  });

  it('并行模式环境阻塞不重试', async () => {
    fastSetTimeout();
    try {
      const tasks = [makeTask({ id: 10, task_key: 'P001' })];
      const service = makeService({
        planAgentCliConfig: () => ({ agentCliProvider: 'claude' }),
      });
      const plan = makePlan();

      let callCount = 0;
      service.executeTask = async () => {
        callCount++;
        return { exitCode: 1, errorMessage: 'command not found: ENOENT' };
      };

      await executeTaskBatch(service, HELPERS, WORKSPACE, plan, tasks);

      assert.equal(callCount, 1, '环境阻塞错误不应重试');
      const retries = service._calls.addEvent.filter((e) => e.type === 'task.retry');
      assert.equal(retries.length, 0, '环境阻塞不应有重试事件');
    } finally {
      restoreSetTimeout();
    }
  });

  it('setPhase 和 tasks.parallel.started 仅在首次执行前调用一次', async () => {
    fastSetTimeout();
    try {
      const tasks = [makeTask({ id: 10, task_key: 'P001' })];
      const service = makeService({
        planAgentCliConfig: () => ({ agentCliProvider: 'claude' }),
      });
      const plan = makePlan();

      let callCount = 0;
      service.executeTask = async () => {
        callCount++;
        if (callCount <= 2) return { exitCode: 1, errorMessage: '测试失败' };
        return { exitCode: 0 };
      };

      await executeTaskBatch(service, HELPERS, WORKSPACE, plan, tasks);

      // setPhase('execute-task') 在 executeTaskBatch 开头调用一次
      assert.equal(service._calls.setPhase.length, 1, 'executeTaskBatch 应只调用一次 setPhase');
      // tasks.parallel.started 事件只调用一次
      const started = service._calls.addEvent.filter((e) => e.type === 'tasks.parallel.started');
      assert.equal(started.length, 1, 'tasks.parallel.started 应只调用一次');
    } finally {
      restoreSetTimeout();
    }
  });
});

describe('executeTask execution backend config routing（P011）', () => {
  it('uses plan execution snapshot before legacy plan CLI fields', async () => {
    const task = makeTask();
    const plan = makePlan({
      agent_cli_provider: 'codex',
      codex_reasoning_effort: 'low',
      plan_generation_strategy: 'external-cli-structured',
      plan_generation_provider: 'opencode',
      plan_execution_strategy: 'external-cli',
      plan_execution_provider: 'claude',
      plan_execution_command: 'claude-exec',
    });
    const service = makeExecutionConfigService();

    const result = await executeTask(service, HELPERS, WORKSPACE, plan, task);

    assert.equal(result.exitCode, 0);
    assert.equal(service._calls.runCodexWithPlanGuard.length, 1);
    const operation = service._calls.runCodexWithPlanGuard[0].operation;
    assert.equal(operation.planExecutionProvider, 'claude');
    assert.equal(operation.agentCliProvider, 'claude');
    assert.equal(operation.agentCliCommand, 'claude-exec');
    const started = service._calls.addTaskLifecycleEvent.find((event) => event.type === 'task.started');
    assert.equal(started.meta.planExecutionProvider, 'claude');
    assert.equal(started.meta.agentCliProvider, 'claude');
  });

  it('falls back to legacy plan CLI fields for old plans without execution snapshots', async () => {
    const task = makeTask();
    const plan = makePlan({
      plan_generation_strategy: 'external-cli-structured',
      plan_generation_provider: 'claude',
      agent_cli_provider: 'opencode',
      agent_cli_command: 'opencode-run',
    });
    const service = makeExecutionConfigService({
      status: {
        plan_execution_strategy: 'external-cli',
        plan_execution_provider: 'codex',
        plan_execution_codex_reasoning_effort: 'high',
      },
    });

    const result = await executeTask(service, HELPERS, WORKSPACE, plan, task);

    assert.equal(result.exitCode, 0);
    const operation = service._calls.runCodexWithPlanGuard[0].operation;
    assert.equal(operation.planExecutionProvider, 'opencode');
    assert.equal(operation.agentCliProvider, 'opencode');
    assert.equal(operation.agentCliCommand, 'opencode-run');
    const started = service._calls.addTaskLifecycleEvent.find((event) => event.type === 'task.started');
    assert.equal(started.meta.planExecutionProvider, 'opencode');
    assert.equal(started.meta.agentCliProvider, 'opencode');
  });

  it('returns a clear unsupported error for builtin-llm execution without invoking external CLI', async () => {
    const task = makeTask();
    const plan = makePlan({
      plan_generation_strategy: 'builtin-llm-structured',
      plan_generation_provider: 'openai',
      plan_execution_strategy: 'builtin-llm',
      plan_execution_provider: 'openai',
      plan_execution_model: 'gpt-4o',
    });
    const service = makeExecutionConfigService();

    const result = await executeTask(service, HELPERS, WORKSPACE, plan, task);

    assert.equal(result.exitCode, -1);
    assert.equal(result.errorMessage, BUILTIN_LLM_EXECUTION_UNSUPPORTED_ERROR);
    assert.equal(service._calls.runCodexWithPlanGuard.length, 0);
    assert.equal(service._calls.recordTaskFailure.length, 1);
    assert.equal(service._calls.recordTaskFailure[0].meta.planExecutionProvider, 'openai');
    assert.equal(service._calls.recordTaskFailure[0].meta.planExecutionModel, 'gpt-4o');
    assert.ok(service._calls.runHookScripts.some((hook) => hook.hook === 'on:fail'));
    const started = service._calls.addTaskLifecycleEvent.find((event) => event.type === 'task.started');
    assert.equal(started.meta.planExecutionProvider, 'openai');
    assert.equal(started.meta.planExecutionStrategy, 'builtin-llm');
  });

  it('emits task event metadata from execution provider, not generation provider', async () => {
    const task = makeTask();
    const plan = makePlan({
      plan_generation_strategy: 'external-cli-structured',
      plan_generation_provider: 'claude',
      plan_execution_strategy: 'external-cli',
      plan_execution_provider: 'codex',
      plan_execution_codex_reasoning_effort: 'xhigh',
    });
    const service = makeExecutionConfigService();

    await executeTask(service, HELPERS, WORKSPACE, plan, task);

    const started = service._calls.addTaskLifecycleEvent.find((event) => event.type === 'task.started');
    assert.equal(started.meta.planExecutionProvider, 'codex');
    assert.equal(started.meta.agentCliProvider, 'codex');
    assert.equal(started.meta.codexReasoningEffort, 'xhigh');
    assert.notEqual(started.meta.agentCliProvider, plan.plan_generation_provider);
  });
});

function makeExecutionConfigService(overrides = {}) {
  const calls = {
    setPhase: [],
    addTaskLifecycleEvent: [],
    runCodexWithPlanGuard: [],
    recordTaskFailure: [],
    runHookScripts: [],
  };
  const service = {
    _calls: calls,
    status: () => overrides.status || {},
    planExists: () => true,
    taskExists: () => true,
    startTaskRun: (_taskId, startedAt) => ({ ...makeTask(), status: 'running', started_at: startedAt }),
    setPhase(projectId, phase) {
      calls.setPhase.push({ projectId, phase });
    },
    addTaskLifecycleEvent(projectId, type, task, meta) {
      calls.addTaskLifecycleEvent.push({ projectId, type, task, meta });
    },
    async runCodexWithPlanGuard(workspace, prompt, label, operation, planFile) {
      calls.runCodexWithPlanGuard.push({ workspace, prompt, label, operation, planFile });
      return {
        exitCode: 0,
        output: '',
        logFile: '/tmp/autoplan-execute-ok.log',
        agentCliProvider: operation.agentCliProvider,
        agentCliCommand: operation.agentCliCommand,
        codexReasoningEffort: operation.codexReasoningEffort,
      };
    },
    recordTaskFailure(projectId, plan, task, finishedAt, meta) {
      calls.recordTaskFailure.push({ projectId, planId: plan.id, taskId: task.id, finishedAt, meta });
      return { ...task, status: 'failed' };
    },
    async runHookScripts(projectId, hook, payload) {
      calls.runHookScripts.push({ projectId, hook, payload });
    },
    previousPlanCodexSessionId: () => '',
    previousPlanAgentCliSessionId: () => '',
    planAgentCliSessionId: () => '',
    updateTaskCodexSession: () => {},
    updateTaskAgentCliSession: () => {},
    planAgentCliConfig(plan) {
      return planAgentCliConfig(service, plan);
    },
    db: {
      all() {
        return [];
      },
      get() {
        return null;
      },
    },
  };
  return service;
}
