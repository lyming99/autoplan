const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { describe, it } = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

function source(...parts) {
  return readFileSync(join(process.cwd(), ...parts), 'utf8');
}

function tupleKeys(text, name) {
  const match = text.match(new RegExp(`export const ${name} = \\[([\\s\\S]*?)\\] as const`));
  assert.ok(match, `missing ${name}`);
  return [...match[1].matchAll(/'([^']+)'/g)].map((item) => item[1]);
}

const operationKeys = tupleKeys(source('src/renderer/lib/api/client.ts'), 'AUTOPLAN_CLIENT_OPERATION_KEYS');
const eventKeys = tupleKeys(source('src/renderer/lib/api/events.ts'), 'AUTOPLAN_CLIENT_EVENT_KEYS');

function loadHttpClient() {
  const compiled = ts.transpileModule(source('src/renderer/lib/api/httpClient.ts'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: 'httpClient.ts',
  }).outputText;
  const module = { exports: {} };
  const wrapper = vm.runInThisContext(`(function (require, module, exports) { ${compiled}\n})`);
  wrapper((id) => {
    if (id === './client') return { AUTOPLAN_CLIENT_OPERATION_KEYS: operationKeys };
    if (id === './events') return { AUTOPLAN_CLIENT_EVENT_KEYS: eventKeys, consumeProjectEventPlaceholder: async () => {} };
    if (id === './terminalTransport') {
      return { TerminalTransport: class { constructor(options) { this.legacy = options.legacy; } } };
    }
    throw new Error(`unexpected runtime import: ${id}`);
  }, module, module.exports);
  return module.exports;
}

function plan() {
  return {
    id: 12, project_id: 7, issue_hash: 'issue', file_path: 'docs/plan/p.md', hash: 'digest',
    status: 'completed', sort_order: 1, total_tasks: 1, completed_tasks: 1, validation_passed: 1,
    plan_generation_duration_ms: 0, created_at: '2026-01-02T03:04:05.000Z',
    updated_at: '2026-01-02T03:04:08.000Z', accepted_at: null, title: 'Plan',
  };
}

function task() {
  return {
    id: 21, project_id: 7, plan_id: 12, task_key: 'P001', title: 'Persist', raw_line: '- [ ] P001',
    scope: 'backend', status: 'completed', sort_order: 1, started_at: null, finished_at: null,
    duration_ms: 0, updated_at: '2026-01-02T03:04:08.000Z', accepted_at: null,
    file_path: 'docs/plan/p.md', plan_title: 'Plan',
  };
}

function snapshot() {
  const project = {
    id: 7, name: 'Synthetic', workspace_path: '<fixture-workspace>/p7', description: '',
    created_at: '2026-01-02T03:04:05.000Z', updated_at: '2026-01-02T03:04:08.000Z',
  };
  return {
    activeProjectId: 7, activeProject: project, projects: [project], mcp: {},
    state: { project_id: 7, workspace_path: project.workspace_path, version: 1 },
    requirements: [], feedback: [], attachments: [], plans: [plan()], tasks: [task()],
    events: [{ id: 31, project_id: 7, type: 'plan.accepted', message: 'accepted', meta: null,
      created_at: '2026-01-02T03:04:09.000Z' }],
    scans: [], scanSummary: {}, scripts: [], executors: [], terminals: [], activeOperation: null,
    activeOperations: [], lastOperation: null,
  };
}

function response(body, status = 200) {
  const text = JSON.stringify(body);
  return {
    status, ok: status >= 200 && status < 300, body: null,
    headers: new Headers({
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': String(Buffer.byteLength(text)),
      'X-Request-ID': body.request_id || 'req_plan_contract',
    }),
    text: async () => text,
  };
}

function delegateFixture() {
  const calls = [];
  const delegate = {};
  for (const key of operationKeys) {
    if (key === 'mcpToolNames') delegate[key] = [];
    else if (key === 'fileAccess') delegate[key] = { get: async () => ({}), save: async () => ({}) };
    else if (key === 'snapshot') delegate[key] = async () => snapshot();
    else delegate[key] = async (input) => {
      calls.push({ key, input });
      return { key, input };
    };
  }
  for (const key of eventKeys) delegate[key] = () => () => {};
  return { delegate, calls };
}

function client(fetchImpl) {
  const { HttpAutoplanClient } = loadHttpClient();
  const fixture = delegateFixture();
  return {
    calls: fixture.calls,
    client: new HttpAutoplanClient({
      baseUrl: 'http://127.0.0.1:43123', sessionCredential: 'A'.repeat(43), timeoutMs: 1_000,
      idempotencyKeyFactory: () => 'renderer:plan-contract', fetchImpl, delegate: fixture.delegate,
    }),
  };
}

describe('Plan IPC/HTTP capability transport contract', () => {
  it('reads plan Markdown and parsed tasks from the project-scoped Go endpoint without IPC', async () => {
    const markdown = '# Plan\n\n## Tasks\n\n- [x] P001: Persist\n';
    const { client: http, calls } = client(async (target, init) => {
      const url = new URL(target);
      assert.equal(init.method, 'GET');
      assert.equal(url.pathname, '/api/v1/projects/7/plans/12/content');
      return response({
        data: { plan: plan(), tasks: [task()], markdown }, request_id: 'req_plan_contract',
      });
    });

    const result = await http.readPlan({ projectId: 7, planId: 12 });
    assert.equal(result.ok, true);
    assert.equal(result.markdown, markdown);
    assert.equal(result.task_parse_status, 'parsed');
    assert.deepStrictEqual(result.tasks[0].scopes, ['backend']);
    assert.equal(calls.length, 0, 'Go plan preview must not invoke the unavailable IPC reader');
  });

  it('uses enabled Plan, Task, and Event query capabilities without IPC DTO remapping', async () => {
    const captures = [];
    const { client: http, calls } = client(async (target, init) => {
      const url = new URL(target);
      captures.push(`${init.method} ${url.pathname}${url.search}`);
      if (url.pathname === '/api/v1/capabilities') {
        return response({ data: { version: 'v1', capabilities: [
          { id: 'plans.query', enabled: true }, { id: 'tasks.query', enabled: true },
          { id: 'events.query', enabled: true },
        ] }, request_id: 'req_plan_contract' });
      }
      if (url.pathname === '/api/v1/plans') {
        return response({ data: url.searchParams.has('plan_id') ? plan() : [plan()], request_id: 'req_plan_contract' });
      }
      if (url.pathname === '/api/v1/plan-tasks') {
        return response({ data: url.searchParams.has('task_id') ? task() : [task()], request_id: 'req_plan_contract' });
      }
      if (url.pathname === '/api/v1/events') return response({ data: snapshot().events, request_id: 'req_plan_contract' });
      throw new Error(`unexpected HTTP path: ${url.pathname}`);
    });

    assert.equal((await http.getPlan({ projectId: 7, planId: 12 })).id, 12);
    assert.equal((await http.getPlanTask({ projectId: 7, planId: 12, taskId: 21 })).task_key, 'P001');
    assert.equal((await http.listPlanEvents(7)).at(0).type, 'plan.accepted');
    assert.equal(calls.length, 0);
    assert.deepStrictEqual(captures, [
      'GET /api/v1/capabilities',
      'GET /api/v1/plans?project_id=7&plan_id=12',
      'GET /api/v1/plan-tasks?project_id=7&plan_id=12&task_id=21',
      'GET /api/v1/events?project_id=7&limit=80&offset=0',
    ]);
  });

  it('uses HTTP only for an enabled pure persistence mutation and binds a snapshot version precondition', async () => {
    const captures = [];
    const { client: http, calls } = client(async (target, init) => {
      const url = new URL(target);
      captures.push({ path: url.pathname, method: init.method, body: init.body });
      if (url.pathname === '/api/v1/capabilities') {
        return response({ data: { version: 'v1', capabilities: [{ id: 'plans.reorder', enabled: true }] }, request_id: 'req_plan_contract' });
      }
      if (url.pathname === '/api/v1/projects/7/snapshot') return response({ data: snapshot(), request_id: 'req_plan_contract' });
      if (url.pathname === '/api/v1/plans/reorder') return response({ data: { snapshot: snapshot() }, request_id: 'req_plan_contract' });
      throw new Error(`unexpected HTTP path: ${url.pathname}`);
    });

    const result = await http.reorderPlans({ projectId: 7, planIds: [12] });
    assert.equal(result.plans[0].id, 12);
    assert.equal(calls.length, 0, 'an enabled persistence mutation must not invoke IPC');
    assert.deepStrictEqual(captures.map(({ path, method }) => ({ path, method })), [
      { path: '/api/v1/capabilities', method: 'GET' },
      { path: '/api/v1/projects/7/snapshot', method: 'GET' },
      { path: '/api/v1/plans/reorder', method: 'PUT' },
    ]);
    assert.deepStrictEqual(JSON.parse(captures[2].body), {
      project_id: 7, plan_ids: [12], expected_updated_at: { 12: '2026-01-02T03:04:08.000Z' },
    });
  });

  it('keeps disabled persistence capabilities and every long-running action with IPC', async () => {
    const { client: http, calls } = client(async (target) => {
      const url = new URL(target);
      if (url.pathname !== '/api/v1/capabilities') throw new Error('disabled capability must not call a Plan route');
      return response({ data: { version: 'v1', capabilities: [
        { id: 'plans.delete', enabled: false },
        { id: 'tasks.run', enabled: true },
      ] }, request_id: 'req_plan_contract' });
    });

    const deleted = await http.deletePlan({ projectId: 7, planId: 12 });
    const actions = [
      ['stopPlan', { projectId: 7, planId: 12 }],
      ['resumePlan', { projectId: 7, planId: 12 }],
      ['reExecutePlan', { projectId: 7, planId: 12 }],
      ['recreatePlanFromIntake', { projectId: 7, planId: 12 }],
      ['runTask', { projectId: 7, planId: 12, taskId: 21 }],
      ['runTaskBatches', { projectId: 7, planId: 12, batches: [{ taskIds: [21] }] }],
      ['stopTask', { projectId: 7, planId: 12, taskId: 21 }],
    ];
    const results = [];
    for (const [key, input] of actions) results.push(await http[key](input));
    assert.equal(deleted.key, 'deletePlan');
    assert.deepStrictEqual(results.map((result) => result.key), actions.map(([key]) => key));
    assert.deepStrictEqual(calls.map((call) => call.key), ['deletePlan', ...actions.map(([key]) => key)]);
  });

  it('preserves a non-2xx HTTP mutation failure instead of falling back to IPC', async () => {
    const { client: http, calls } = client(async (target) => {
      const url = new URL(target);
      if (url.pathname === '/api/v1/capabilities') {
        return response({ data: { version: 'v1', capabilities: [{ id: 'plans.delete', enabled: true }] }, request_id: 'req_plan_contract' });
      }
      if (url.pathname === '/api/v1/projects/7/snapshot') return response({ data: snapshot(), request_id: 'req_plan_contract' });
      if (url.pathname === '/api/v1/plans') {
        return response({ code: 'not_implemented', message: 'operation is not implemented',
          request_id: 'req_plan_contract', retryable: false, details: { capability: 'plans.delete' } }, 501);
      }
      throw new Error(`unexpected HTTP path: ${url.pathname}`);
    });

    await assert.rejects(http.deletePlan({ projectId: 7, planId: 12 }), (error) =>
      error.code === 'not_implemented' && error.status === 501 && error.request_id === 'req_plan_contract');
    assert.equal(calls.length, 0, 'a selected HTTP mutation failure must never replay through IPC');
  });
});
