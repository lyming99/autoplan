const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { describe, it } = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

const root = process.cwd();
const credential = 'A'.repeat(43);
const requestId = 'req_http_fixture';

function source(...parts) {
  return readFileSync(join(root, ...parts), 'utf8');
}

function tupleKeys(sourceText, exportName) {
  const pattern = new RegExp(`export const ${exportName} = \\[([\\s\\S]*?)\\] as const`);
  const match = sourceText.match(pattern);
  assert.ok(match, `missing ${exportName}`);
  return [...match[1].matchAll(/'([^']+)'/g)].map((item) => item[1]);
}

const operationKeys = tupleKeys(
  source('src', 'renderer', 'lib', 'api', 'client.ts'),
  'AUTOPLAN_CLIENT_OPERATION_KEYS',
);
const eventKeys = tupleKeys(
  source('src', 'renderer', 'lib', 'api', 'events.ts'),
  'AUTOPLAN_CLIENT_EVENT_KEYS',
);

function loadHttpClient(eventOverrides = {}) {
  const compiled = ts.transpileModule(
    source('src', 'renderer', 'lib', 'api', 'httpClient.ts'),
    {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
      fileName: 'httpClient.ts',
    },
  ).outputText;
  const module = { exports: {} };
  const wrapper = vm.runInThisContext(`(function (require, module, exports) { ${compiled}\n})`);
  wrapper(
    (id) => {
      if (id === './client') return { AUTOPLAN_CLIENT_OPERATION_KEYS: operationKeys };
      if (id === './events') {
        return {
          AUTOPLAN_CLIENT_EVENT_KEYS: eventKeys,
          consumeProjectEventPlaceholder: async () => {},
          ...eventOverrides,
        };
      }
      if (id === './terminalTransport') {
        return {
          TerminalTransport: class {
            constructor(options) { this.legacy = options.legacy; }
            create(input) { return this.legacy.createTerminal(input); }
            list(input) { return this.legacy.listTerminals(input); }
            write(input) { return this.legacy.writeTerminal(input); }
            resize(input) { return this.legacy.resizeTerminal(input); }
            kill(input) { return this.legacy.killTerminal(input); }
            close(input) { return this.legacy.closeTerminal(input); }
            rename(input) { return this.legacy.renameTerminal(input); }
            replay(input) { return this.legacy.replayTerminal(input); }
            clear(input) { return this.legacy.clearTerminal(input); }
            connect(...args) { return this.legacy.connectTerminal(...args); }
          },
        };
      }
      throw new Error(`unexpected runtime import: ${id}`);
    },
    module,
    module.exports,
  );
  return module.exports;
}

function project(id = 1) {
  return {
    id,
    name: `Project ${id}`,
    workspace_path: `<fixture-workspace>/project-${id}`,
    description: 'Synthetic project.',
    created_at: '2026-01-02T03:04:05.000Z',
    updated_at: '2026-01-02T03:04:08.000Z',
  };
}

function modelUsage(totalTokens = 0) {
  const totals = (overrides = {}) => ({
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    ...overrides,
  });
  return {
    cumulative: totals({ inputTokens: totalTokens, totalTokens }),
    today: totals({ inputTokens: totalTokens, totalTokens }),
    byProvider: [],
  };
}

function snapshot(activeProject = project(1)) {
  return {
    activeProjectId: activeProject?.id ?? null,
    activeProject,
    projects: activeProject ? [activeProject] : [],
    mcp: {},
    state: activeProject ? {
      project_id: activeProject.id,
      workspace_path: activeProject.workspace_path,
      version: 1,
    } : null,
    requirements: [],
    feedback: [],
    attachments: [],
    plans: [],
    tasks: [],
    events: [],
    scans: [],
    scanSummary: {},
    scripts: [],
    executors: [],
    terminals: [],
    activeOperation: null,
    activeOperations: [],
    lastOperation: null,
    modelUsage: modelUsage(),
  };
}

function intake(type, id, requirementId = null) {
  return {
    id,
    project_id: 7,
    intake_type: type,
    requirement_id: requirementId,
    title: `${type} ${id}`,
    body: `Synthetic ${type} body.`,
    status: 'open',
    accepted_at: null,
    linked_plan_id: null,
    linked_plans: [],
    created_at: '2026-01-02T03:04:05.000Z',
    updated_at: '2026-01-02T03:04:08.000Z',
    agent_cli_provider: null,
    agent_cli_command: '',
    codex_reasoning_effort: null,
    plan_generation_strategy: null,
    plan_generation_provider: null,
    plan_generation_command: '',
    plan_generation_model: '',
    plan_generation_codex_reasoning_effort: null,
    plan_generation_claude_base_url: '',
    plan_generation_claude_model: '',
    plan_generation_claude_config_id: 0,
    plan_generation_has_claude_auth_token: false,
    generate_fail_count: 0,
    last_generate_fail_at: null,
    last_generate_error: null,
    last_generate_agent_cli_provider: null,
    last_generate_codex_reasoning_effort: null,
  };
}

function intakeMutation(snapshotValue) {
  return { snapshot: snapshotValue };
}

function safeAttachment(id = 91) {
  return {
    id,
    display_name: 'spec.png',
    size: 4,
    mime_type: 'image/png',
    download_url: `/api/v1/attachments/${id}/content`,
  };
}

function response(status, body, contentType = 'application/json; charset=utf-8') {
  const headers = new Headers({
    'Content-Type': contentType,
    'X-Request-ID': body?.request_id || requestId,
  });
  const text = JSON.stringify(body);
  headers.set('Content-Length', String(Buffer.byteLength(text)));
  return {
    status,
    ok: status >= 200 && status < 300,
    headers,
    body: null,
    text: async () => text,
  };
}

function success(data) {
  return response(200, { data, request_id: requestId });
}

function fallbackClient(snapshotValue = snapshot(null)) {
  const calls = [];
  const client = {};
  for (const key of operationKeys) {
    if (key === 'mcpToolNames') client[key] = ['list_projects'];
    else if (key === 'fileAccess') {
      client[key] = {
        get: (...args) => {
          calls.push({ key: 'fileAccess.get', args });
          return { key: 'fileAccess.get', args };
        },
        save: (...args) => {
          calls.push({ key: 'fileAccess.save', args });
          return { key: 'fileAccess.save', args };
        },
      };
    } else if (key === 'snapshot') {
      client[key] = async (...args) => {
        calls.push({ key, args });
        return snapshotValue;
      };
    } else {
      client[key] = (...args) => {
        calls.push({ key, args });
        return { key, args };
      };
    }
  }
  for (const key of eventKeys) {
    client[key] = (handler) => {
      calls.push({ key, handler });
      return () => calls.push({ key: `${key}:unsubscribe` });
    };
  }
  return { client, calls };
}

function createClient(fetchImpl, overrides = {}) {
  const { eventModule, ...clientOverrides } = overrides;
  const { HttpAutoplanClient } = loadHttpClient(eventModule);
  const fallback = fallbackClient(overrides.snapshotValue);
  let idempotencySequence = 0;
  return {
    client: new HttpAutoplanClient({
      baseUrl: 'http://127.0.0.1:43123',
      sessionCredential: credential,
      timeoutMs: 1_000,
      fetchImpl,
      idempotencyKeyFactory: () => `renderer:intent-${++idempotencySequence}`,
      delegate: fallback.client,
      ...clientOverrides,
    }),
    fallback,
  };
}

describe('HttpAutoplanClient guarded read transport', () => {
  it('unwraps probes, project pages, projects, and snapshots without renaming DTOs', async () => {
    const calls = [];
    const projectValue = project(7);
    const snapshotValue = snapshot(projectValue);
    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      if (url.endsWith('/healthz')) return response(200, { status: 'ok', request_id: requestId });
      if (url.endsWith('/readyz')) return response(200, { status: 'ready', request_id: requestId });
      if (url.includes('/api/v1/projects?page=')) {
        return response(200, {
          data: [projectValue],
          pagination: { page: 1, page_size: 50, total: 1, next_page: null },
          request_id: requestId,
        });
      }
      if (url.endsWith('/api/v1/projects/7/snapshot')) return success(snapshotValue);
      if (url.endsWith('/api/v1/projects/7')) return success(projectValue);
      throw new Error('unexpected URL');
    };
    const { client } = createClient(fetchImpl);

    assert.deepStrictEqual(await client.health(), { status: 'ok', request_id: requestId });
    assert.deepStrictEqual(await client.ready(), { status: 'ready', request_id: requestId });
    const page = await client.listProjects();
    assert.deepStrictEqual(page.data[0], projectValue);
    assert.deepStrictEqual(await client.getProject(7), projectValue);
    assert.deepStrictEqual(await client.getProjectSnapshot(7), snapshotValue);
    assert.deepStrictEqual(await client.snapshot(7), snapshotValue);

    for (const call of calls) {
      assert.match(call.url, /^http:\/\/127\.0\.0\.1:43123\//);
      assert.doesNotMatch(call.url, new RegExp(credential));
      assert.equal(call.init.headers['X-Autoplan-Session'], credential);
      assert.equal(call.init.credentials, 'include');
      assert.equal(call.init.cache, 'no-store');
      assert.equal(call.init.redirect, 'error');
    }
  });

  it('uses HTTP projects for the list snapshot without requiring an IPC delegate', async () => {
    const first = project(2);
    const second = project(1);
    const { client, fallback } = createClient(
      async () => response(200, {
        data: [first, second],
        pagination: { page: 1, page_size: 200, total: 2, next_page: null },
        request_id: requestId,
      }),
      { snapshotValue: snapshot(null) },
    );
    fallback.client.snapshot = async () => { throw new Error('IPC snapshot must not be used'); };

    const result = await client.snapshot(null);
    assert.deepStrictEqual(result.projects, [first, second]);
    assert.equal(result.mcp.status, 'disabled');
    assert.equal(result.activeProjectId, null);
    assert.equal(fallback.calls.filter((call) => call.key === 'snapshot').length, 0);
  });

  it('strictly maps model usage and falls back to zero for a legacy snapshot', async () => {
    const populated = snapshot(project(7));
    populated.modelUsage = {
      cumulative: {
        inputTokens: 1200, outputTokens: 300, cachedTokens: 400,
        reasoningTokens: 50, totalTokens: 1550,
      },
      today: {
        inputTokens: 200, outputTokens: 30, cachedTokens: 40,
        reasoningTokens: 5, totalTokens: 235,
      },
      byProvider: [{
        provider: 'codex',
        cumulative: {
          inputTokens: 1200, outputTokens: 300, cachedTokens: 400,
          reasoningTokens: 50, totalTokens: 1550,
        },
        today: {
          inputTokens: 200, outputTokens: 30, cachedTokens: 40,
          reasoningTokens: 5, totalTokens: 235,
        },
      }],
    };
    const populatedClient = createClient(async () => success(populated)).client;
    assert.deepStrictEqual((await populatedClient.getProjectSnapshot(7)).modelUsage, populated.modelUsage);

    const legacy = snapshot(project(7));
    delete legacy.modelUsage;
    const legacyClient = createClient(async () => success(legacy)).client;
    assert.deepStrictEqual((await legacyClient.getProjectSnapshot(7)).modelUsage, modelUsage());

    const malformed = snapshot(project(7));
    malformed.modelUsage.cumulative.inputTokens = -1;
    const malformedClient = createClient(async () => success(malformed)).client;
    await assert.rejects(
      malformedClient.getProjectSnapshot(7),
      (error) => error.code === 'invalid_response',
    );

    for (const mutate of [
      (value) => { value.modelUsage.today.totalTokens = null; },
      (value) => { value.modelUsage.cumulative.totalTokens = Number.MAX_SAFE_INTEGER + 1; },
      (value) => { value.modelUsage.byProvider = [{
        provider: 'openai', cumulative: modelUsage().cumulative,
        today: modelUsage().today, unexpected: true,
      }]; },
      (value) => { value.modelUsage.unexpected = true; },
    ]) {
      const invalid = snapshot(project(7));
      mutate(invalid);
      const invalidClient = createClient(async () => success(invalid)).client;
      await assert.rejects(
        invalidClient.getProjectSnapshot(7),
        (error) => error.code === 'invalid_response',
      );
    }
  });

  it('binds the default Window fetch before invoking it later', async () => {
    const originalFetch = globalThis.fetch;
    const { HttpAutoplanClient } = loadHttpClient();
    const fallback = fallbackClient(snapshot(null));
    let receiver;
    globalThis.fetch = function receiverSensitiveFetch() {
      receiver = this;
      return Promise.resolve(response(200, {
        data: [],
        pagination: { page: 1, page_size: 200, total: 0, next_page: null },
        request_id: requestId,
      }));
    };
    try {
      const client = new HttpAutoplanClient({
        baseUrl: 'http://127.0.0.1:43123',
        sessionCredential: credential,
        timeoutMs: 1_000,
        delegate: fallback.client,
      });
      assert.deepStrictEqual((await client.listProjects({ pageSize: 200 })).data, []);
      assert.strictEqual(receiver, globalThis);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('delegates unmigrated mutations and existing events without changing identity', async () => {
    const { client, fallback } = createClient(async () => {
      throw new Error('HTTP should not be used');
    });
    const input = { projectId: 7 };
    const result = await client.startLoop(input);
    assert.strictEqual(result.args[0], input);
    assert.strictEqual(fallback.calls.at(-1).args[0], input);

    const handler = () => {};
    const unsubscribe = client.onLoopUpdate(handler);
    assert.strictEqual(fallback.calls.at(-1).handler, handler);
    unsubscribe();
    assert.equal(fallback.calls.at(-1).key, 'onLoopUpdate:unsubscribe');
  });

  it('owns P06 Intake and multipart attachment operations without IPC fallback', async () => {
    const calls = [];
    const requirement = intake('requirement', 30);
    const feedback = intake('feedback', 31, 30);
    const beforeAttachments = {
      ...snapshot(project(7)), requirements: [requirement], feedback: [feedback],
    };
    const afterAttachments = {
      ...beforeAttachments, attachments: [safeAttachment()],
    };
    const links = [{ link_id: 41, plan_id: 51, phase_index: 1, phase_title: 'Implement' }];
    let attachmentAttempts = 0;
    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      if (url.endsWith('/api/v1/projects/7/snapshot')) return success(afterAttachments);
      if (url.includes('/requirements?')) {
        return response(200, {
          data: [requirement], pagination: { page: 1, page_size: 50, total: 1, next_page: null }, request_id: requestId,
        });
      }
      if (url.includes('/feedback?')) {
        return response(200, {
          data: [feedback], pagination: { page: 1, page_size: 50, total: 1, next_page: null }, request_id: requestId,
        });
      }
      if (url.endsWith('/requirements/30') && init.method === 'GET') return success(requirement);
      if (url.endsWith('/feedback/31') && init.method === 'GET') return success(feedback);
      if (url.endsWith('/requirements/30/plan-links') && init.method === 'GET') return success(links);
      if (url.endsWith('/feedback/31/plan-links') && init.method === 'GET') return success(links);
      if (/\/plan-links$/.test(url) && init.method === 'PUT') return success(intakeMutation(beforeAttachments));
      if (/\/accept$/.test(url) && ['POST', 'DELETE'].includes(init.method)) {
        return success(intakeMutation(beforeAttachments));
      }
      if (url.endsWith('/requirements') && init.method === 'POST') return success(intakeMutation(beforeAttachments));
      if (url.endsWith('/feedback') && init.method === 'POST') return success(intakeMutation(beforeAttachments));
      if ((url.endsWith('/requirements/30') || url.endsWith('/feedback/31')) &&
          ['PATCH', 'DELETE'].includes(init.method)) return success(intakeMutation(beforeAttachments));
      if (/\/attachments$/.test(url) && init.method === 'POST') {
        attachmentAttempts += 1;
        assert.equal(init.headers['Content-Type'], undefined, 'the browser must set the multipart boundary');
        assert.ok(init.body instanceof FormData);
        assert.ok(init.body.get('file') instanceof Blob);
        if (attachmentAttempts === 1) throw new TypeError('synthetic multipart disconnect');
        return response(201, {
          data: { attachment: safeAttachment(91 + attachmentAttempts), state: 'completed', recovery_required: false },
          request_id: requestId,
        });
      }
      if (url.endsWith('/api/v1/attachments/91?project_id=7') && init.method === 'DELETE') {
        return success({ attachment_id: 91, state: 'completed', recovery_required: false });
      }
      throw new Error(`unexpected URL: ${url}`);
    };
    const { client, fallback } = createClient(fetchImpl);
    const blob = new Blob([Uint8Array.from([137, 80, 78, 71])], { type: 'image/png' });
    const progress = [];
    const createInput = {
      projectId: 7,
      title: 'Requirement 30',
      body: 'Synthetic requirement body.',
      attachments: [{
        id: 'browser-file', source: 'clipboard-image', name: 'spec.png', size: 4,
        type: 'image/png', previewUrl: 'blob:preview', blob,
      }],
    };

    const requirementPage = await client.listRequirements({ projectId: 7 });
    const feedbackPage = await client.listFeedback({ projectId: 7 });
    assert.deepStrictEqual(requirementPage.data, [requirement]);
    assert.deepStrictEqual(feedbackPage.data, [feedback]);
    assert.deepStrictEqual(await client.getRequirement(7, 30), requirement);
    assert.deepStrictEqual(await client.getFeedback(7, 31), feedback);
    assert.deepStrictEqual(await client.listRequirementPlanLinks(7, 30), links);
    assert.deepStrictEqual(await client.listFeedbackPlanLinks(7, 31), links);
    await client.replaceRequirementPlanLinks(7, 30, [{ planId: 51, phaseIndex: 1, phaseTitle: 'Implement' }]);
    await client.replaceFeedbackPlanLinks(7, 31, [{ planId: 51, phaseIndex: 1, phaseTitle: 'Implement' }]);
    await client.acceptIntake({ projectId: 7, type: 'requirement', id: 30 });
    await client.unacceptIntake({ projectId: 7, type: 'feedback', id: 31 });
    const created = await client.createRequirement(createInput, { onUploadProgress: (value) => progress.push(value) });
    await client.createFeedback({ ...createInput, attachments: [], requirementId: 30 });
    const updateIntent = { projectId: 7, id: 30, title: 'Updated requirement' };
    await client.updateRequirement(updateIntent);
    await client.updateRequirement(updateIntent);
    await client.updateFeedback({ projectId: 7, id: 31, requirementId: null });
    await client.deleteRequirement({ projectId: 7, id: 30 });
    await client.deleteFeedback({ projectId: 7, id: 31 });
    const explicitUploadInput = {
      ...createInput,
      attachments: [{ ...createInput.attachments[0], id: 'browser-file-explicit' }],
    };
    const uploaded = await client.uploadIntakeAttachment('requirement', explicitUploadInput, 30, 0);
    const deleted = await client.deleteAttachment(7, 91);

    assert.equal(created.attachments[0].download_url, 'http://127.0.0.1:43123/api/v1/attachments/91/content?project_id=7');
    assert.equal(uploaded.attachment.download_url, 'http://127.0.0.1:43123/api/v1/attachments/94/content?project_id=7');
    assert.deepStrictEqual(deleted, { attachment_id: 91, state: 'completed', recovery_required: false });
    assert.deepStrictEqual(progress, [{ loaded: 0, total: 4 }, { loaded: 4, total: 4 }]);
    const uploadCalls = calls.filter((call) => /\/attachments$/.test(call.url));
    assert.equal(uploadCalls.length, 3, 'one transport retry plus one explicit upload are expected');
    assert.equal(uploadCalls[0].init.headers['Idempotency-Key'], uploadCalls[1].init.headers['Idempotency-Key']);
    assert.notEqual(uploadCalls[1].init.headers['Idempotency-Key'], uploadCalls[2].init.headers['Idempotency-Key']);
    const updateCalls = calls.filter((call) => call.url.endsWith('/requirements/30') && call.init.method === 'PATCH');
    assert.equal(updateCalls[0].init.headers['Idempotency-Key'], updateCalls[1].init.headers['Idempotency-Key']);
    assert.equal(fallback.calls.length, 0, 'P06 operations must not silently delegate to IPC');
    assert.doesNotMatch(calls.filter((call) => typeof call.init.body === 'string').map((call) => call.init.body).join('\n'),
      /"(?:path|dataUrl|base64|dataBase64)"/);
  });

  it('rejects a filesystem-backed pending attachment before it reaches fetch', async () => {
    const { client } = createClient(async () => {
      throw new Error('filesystem-backed attachment must never fetch');
    });
    await assert.rejects(
      client.uploadIntakeAttachment('requirement', {
        projectId: 7,
        id: 30,
        attachments: [{
          id: 'local-file', source: 'path', name: 'private.txt', size: 4,
          type: 'text/plain', previewUrl: 'file:///private.txt', path: 'C:\\private.txt',
        }],
      }, 30, 0),
      (error) => error.code === 'invalid_attachment',
    );
  });

  it('maps Project and LoopConfig mutations to snake_case with stable intent keys', async () => {
    const calls = [];
    let createAttempts = 0;
    const configured = snapshot(project(7));
    configured.state.version = 5;
    const fetchImpl = async (url, init) => {
      calls.push({ url, init, body: init.body === undefined ? undefined : JSON.parse(init.body) });
      if (url.endsWith('/api/v1/projects') && init.method === 'POST') {
        createAttempts += 1;
        if (createAttempts === 1) throw new TypeError('synthetic disconnect');
        return success(configured);
      }
      if (url.endsWith('/api/v1/projects/7/loop-config') && init.method === 'GET') {
        const read = snapshot(project(7));
        read.state.version = 4;
        return success(read);
      }
      if (url.endsWith('/api/v1/projects/7/loop-config') && init.method === 'PATCH') {
        return success(configured);
      }
      if (url.endsWith('/api/v1/projects/7') && ['PATCH', 'DELETE'].includes(init.method)) {
        return success(configured);
      }
      throw new Error('unexpected URL');
    };
    const { client, fallback } = createClient(fetchImpl);
    const createInput = { name: 'Fixture', workspacePath: '<fixture-workspace>/p7', description: '' };

    await client.createProject(createInput);
    await client.createProject(createInput);
    await client.createProject({ ...createInput });
    await client.updateProject({ id: 7, ...createInput });
    await client.deleteProject({ projectId: 7 });
    await client.getLoopConfig(7);
    await client.configureLoop({
      projectId: 7,
      intervalSeconds: 5,
      validationCommand: 'synthetic-check',
      projectPrompt: 'Synthetic prompt.',
      agentCliProvider: 'codex',
      agentCliCommand: 'codex',
      planGenerationStrategy: 'external-cli-markdown',
      planGenerationCommand: 'codex',
      planGenerationModel: '',
      planExecutionStrategy: 'external-cli',
      planExecutionCommand: 'codex',
      planExecutionModel: '',
    });

    const createCalls = calls.filter((call) => call.url.endsWith('/api/v1/projects'));
    assert.equal(createCalls.length, 4, 'one transport retry, one explicit retry, and one new intent are expected');
    assert.deepStrictEqual(createCalls.slice(0, 3).map(
      (call) => call.init.headers['Idempotency-Key'],
    ), Array(3).fill(createCalls[0].init.headers['Idempotency-Key']));
    assert.notEqual(
      createCalls[3].init.headers['Idempotency-Key'],
      createCalls[0].init.headers['Idempotency-Key'],
    );
    assert.deepStrictEqual(createCalls[0].body, {
      name: 'Fixture', workspace_path: '<fixture-workspace>/p7', description: '',
    });
    assert.deepStrictEqual(calls.find((call) => call.init.method === 'PATCH' &&
      call.url.endsWith('/api/v1/projects/7')).body, {
      name: 'Fixture', workspace_path: '<fixture-workspace>/p7', description: '',
    });
    const configCall = calls.find((call) => call.url.endsWith('/loop-config') && call.init.method === 'PATCH');
    assert.equal(configCall.body.version, 5);
    assert.equal(configCall.body.interval_seconds, 5);
    assert.equal(configCall.body.validation_command, 'synthetic-check');
    assert.equal(configCall.body.project_id, undefined);
    assert.equal(configCall.init.headers['Content-Type'], 'application/json');
    assert.equal(fallback.calls.some((call) => [
      'createProject', 'updateProject', 'deleteProject', 'configureLoop',
    ].includes(call.key)), false);
    assert.doesNotMatch(calls.map((call) => call.url).join('\n'), /intent-|A{20}/);
  });

  it('reads and saves versioned file policy without leaking transport fields into its body', async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      const data = init.method === 'PATCH'
        ? { scope: 'all', allow_cross_project: false, allowed_roots: [], version: 3, high_risk: true }
        : { scope: 'project', allow_cross_project: false, allowed_roots: [], version: 2, high_risk: false };
      return success(data);
    };
    const { client, fallback } = createClient(fetchImpl);
    assert.deepStrictEqual(await client.fileAccess.get(), {
      scope: 'project', allowCrossProject: false, allowedRoots: [], version: 2, highRisk: false,
    });
    assert.deepStrictEqual(await client.fileAccess.save({ scope: 'all' }), {
      saved: true, warned: true, version: 3,
    });

    assert.deepStrictEqual(JSON.parse(calls[1].init.body), {
      version: 2, scope: 'all', allow_cross_project: false, allowed_roots: [],
    });
    assert.match(calls[1].init.headers['Idempotency-Key'], /^renderer:intent-/);
    assert.equal(fallback.calls.some((call) => call.key?.startsWith('fileAccess')), false);
  });

  it('rejects a late mutation response after a newer intent for the same project', async () => {
    const pending = [];
    const fetchImpl = (url, init) => new Promise((resolve) => pending.push({ url, init, resolve }));
    const { client } = createClient(fetchImpl);
    const first = client.updateProject({
      id: 7, name: 'First', workspacePath: '<fixture-workspace>/p7',
    });
    const second = client.updateProject({
      id: 7, name: 'Second', workspacePath: '<fixture-workspace>/p7',
    });
    await new Promise((resolve) => setImmediate(resolve));

    const newer = snapshot(project(7));
    newer.state.version = 3;
    pending[1].resolve(success(newer));
    assert.deepStrictEqual(await second, newer);

    const older = snapshot(project(7));
    older.state.version = 2;
    pending[0].resolve(success(older));
    await assert.rejects(first, (error) => error.code === 'mutation_response_superseded');
  });

  it('coalesces concurrent deletion requests for the same project', async () => {
    const calls = [];
    let resolveDelete;
    const fetchImpl = (url, init) => new Promise((resolve) => {
      calls.push({ url, init });
      resolveDelete = resolve;
    });
    const { client } = createClient(fetchImpl);

    const first = client.deleteProject({ projectId: 7 });
    const second = client.deleteProject({ projectId: 7 });
    await new Promise((resolve) => setImmediate(resolve));

    assert.strictEqual(second, first);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].init.method, 'DELETE');
    const deleted = snapshot(null);
    resolveDelete(success(deleted));
    assert.deepStrictEqual(await first, deleted);
    assert.deepStrictEqual(await second, deleted);

    const later = client.deleteProject({ projectId: 7 });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.length, 2, 'the completed request must not stay cached');
    resolveDelete(success(deleted));
    assert.deepStrictEqual(await later, deleted);
  });

  it('maps server, content-type, cancellation, and timeout failures to safe codes', async () => {
    const serverMessage = 'sensitive internal failure detail';
    const unauthorized = createClient(async () => response(401, {
      code: 'unauthorized',
      message: serverMessage,
      request_id: requestId,
      retryable: false,
    })).client;
    await assert.rejects(unauthorized.getProject(1), (error) => {
      assert.equal(error.code, 'unauthorized');
      assert.equal(error.status, 401);
      assert.equal(error.request_id, requestId);
      assert.doesNotMatch(error.message, /sensitive|43123|A{10}/);
      return true;
    });

    const conflict = createClient(async () => response(409, {
      code: 'version_conflict',
      message: 'stale version',
      request_id: requestId,
      retryable: false,
    })).client;
    await assert.rejects(
      conflict.configureLoop({ projectId: 1, version: 1 }),
      (error) => error.code === 'version_conflict' && error.status === 409 &&
        error.request_id === requestId,
    );

    const wrongContent = createClient(async () => response(200, {}, 'text/plain')).client;
    await assert.rejects(wrongContent.health(), (error) => error.code === 'invalid_content_type');

    const pendingFetch = (_url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    });
    const cancelled = createClient(pendingFetch).client;
    const controller = new AbortController();
    const request = cancelled.listProjects({ signal: controller.signal });
    controller.abort();
    await assert.rejects(request, (error) => error.code === 'request_cancelled');

    const timedOut = createClient(pendingFetch, { timeoutMs: 1 }).client;
    await assert.rejects(timedOut.ready(), (error) => error.code === 'request_timeout' && error.retryable);
  });

  it('opens the authenticated project SSE route and owns an idempotent cancellation', async () => {
    const calls = [];
    const states = [];
    const { client } = createClient(async (url, init) => {
      calls.push({ url, init });
      return response(501, {
        code: 'not_implemented',
        message: 'operation is not implemented',
        request_id: requestId,
        retryable: false,
      });
    });
    const unsubscribe = client.connectProjectEvents(7, (update) => states.push(update.state));
    await new Promise((resolve) => setImmediate(resolve));
    unsubscribe();
    unsubscribe();

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'http://127.0.0.1:43123/api/v1/projects/7/events');
    assert.equal(calls[0].init.headers.Accept, 'text/event-stream');
    assert.deepStrictEqual(states, ['connecting', 'unavailable', 'closed']);
  });

  it('accepts only the sanitized static automation metadata contract', async () => {
    const staticScript = {
      id: 3, project_id: 7, name: 'Fixture script', runtime: 'node', description: 'Fixture metadata.',
      trigger_mode: 'manual', hook_stage: null, schedule_cron: null, enabled: true, timeout_seconds: 60,
      fail_aborts: false, context_inject: 'none', sort_order: 1, last_status: null, last_exit_code: null,
      last_duration_ms: null, last_run_at: null, source_type: 'inline', has_path: true, has_body: true,
      has_work_dir: true, has_last_log: false, created_at: '2026-07-11T00:00:00.000Z',
      updated_at: '2026-07-11T00:00:01.000Z', version: 1,
    };
    const calls = [];
    const { client } = createClient(async (url, init) => {
      calls.push({ url, init });
      return success([staticScript]);
    });
    assert.deepStrictEqual(await client.listStaticScripts(7), [staticScript]);
    assert.equal(calls[0].url, 'http://127.0.0.1:43123/api/v1/projects/7/scripts?limit=50&offset=0');
    assert.equal(calls[0].init.method, 'GET');

    const unsafe = createClient(async () => success([{ ...staticScript, body: 'private-script-body' }])).client;
    await assert.rejects(unsafe.listStaticScripts(7), (error) => error.code === 'invalid_response');
  });

  it('owns linked-plan actions, script creation, and static AI configuration through Go HTTP', async () => {
    const snapshotValue = snapshot(project(7));
    const staticScript = {
      id: 3, project_id: 7, name: 'Fixture script', runtime: 'node', description: 'Fixture metadata.',
      trigger_mode: 'manual', hook_stage: null, schedule_cron: null, enabled: true, timeout_seconds: 60,
      fail_aborts: false, context_inject: 'none', sort_order: 1, last_status: null, last_exit_code: null,
      last_duration_ms: null, last_run_at: null, source_type: 'inline', has_path: false, has_body: true,
      has_work_dir: false, has_last_log: false, created_at: '2026-07-11T00:00:00.000Z',
      updated_at: '2026-07-11T00:00:01.000Z', version: 1,
    };
    const aiConfig = {
      id: 5, project_id: null, projectId: null, name: 'Codex', provider: 'openai',
      base_url: 'https://api.example.test', baseUrl: 'https://api.example.test',
      has_api_key: true, hasApiKey: true, masked_key: 'sk-***', maskedKey: 'sk-***',
      model: 'gpt-5.5', temperature: '0.3', thinking_depth: 'high', thinkingDepth: 'high',
      thinking_budget_tokens: null, thinkingBudgetTokens: null,
      created_at: '2026-07-11T00:00:00.000Z', createdAt: '2026-07-11T00:00:00.000Z',
      updated_at: '2026-07-11T00:00:01.000Z', updatedAt: '2026-07-11T00:00:01.000Z', version: 2,
    };
    const calls = [];
    const { client, fallback } = createClient(async (target, init) => {
      const url = new URL(target);
      const body = init.body ? JSON.parse(init.body) : undefined;
      calls.push({ path: `${url.pathname}${url.search}`, method: init.method, body });
      if (url.pathname.includes('/intake/') && url.pathname.includes('/actions/')) {
        return success({ snapshot: snapshotValue });
      }
      if (url.pathname === '/api/v1/projects/7/scripts' && init.method === 'POST') return success(staticScript);
      if (url.pathname === '/api/v1/projects/7/snapshot') return success(snapshotValue);
      if (url.pathname === '/api/v1/ai-configs' && init.method === 'GET') return success([aiConfig]);
      if (url.pathname === '/api/v1/ai-configs' && init.method === 'POST') return success(aiConfig);
      if (url.pathname === '/api/v1/ai-configs/5' && init.method === 'GET') return success(aiConfig);
      if (url.pathname === '/api/v1/ai-configs/5' && init.method === 'PATCH') return success({ ...aiConfig, name: body.name ?? aiConfig.name, version: 3 });
      if (url.pathname === '/api/v1/ai-configs/5' && init.method === 'DELETE') return success({ deleted: true });
      throw new Error(`unexpected Go business URL: ${url.pathname}`);
    });

    assert.deepStrictEqual(await client.interruptIntake({ projectId: 7, type: 'requirement', id: 9 }), snapshotValue);
    assert.deepStrictEqual(await client.resumeIntake({ projectId: 7, type: 'requirement', id: 9 }), snapshotValue);
    assert.deepStrictEqual(await client.appendIntakeTask({ projectId: 7, type: 'requirement', id: 9, title: 'Add regression tests' }), snapshotValue);
    assert.deepStrictEqual(await client.createScript({
      projectId: 7, name: 'Fixture script', runtime: 'node', body: 'console.log(1)', enabled: 1,
    }), snapshotValue);
    assert.equal((await client.aiConfigCreate({
      name: 'Codex', provider: 'openai', baseUrl: 'https://api.example.test', apiKey: 'sk-secret',
      model: 'gpt-5.5', temperature: '0.3', thinkingDepth: 'high',
    })).id, 5);
    assert.equal((await client.aiConfigUpdate({ configId: 5, name: 'Codex updated', apiKey: '' })).name, 'Codex updated');
    assert.deepStrictEqual(await client.aiConfigDelete({ configId: 5 }), { deleted: true });
    assert.equal((await client.chatGetConfig()).aiConfigId, 5);
    assert.deepStrictEqual(await client.chatSaveConfig({
      provider: 'openai', baseUrl: 'https://chat.example.test', apiKey: 'chat-secret', model: 'gpt-5.5', temperature: '0.2',
    }), { saved: true });

    const actionCalls = calls.filter((call) => call.path.includes('/intake/'));
    assert.deepStrictEqual(actionCalls.map(({ path, body }) => ({ path, body })), [
      { path: '/api/v1/projects/7/intake/requirement/9/actions/interrupt', body: {} },
      { path: '/api/v1/projects/7/intake/requirement/9/actions/resume', body: {} },
      { path: '/api/v1/projects/7/intake/requirement/9/actions/append-task', body: { title: 'Add regression tests' } },
    ]);
    const scriptCreate = calls.find((call) => call.path === '/api/v1/projects/7/scripts' && call.method === 'POST');
    assert.deepStrictEqual(scriptCreate.body, {
      name: 'Fixture script', runtime: 'node', body: 'console.log(1)', enabled: true,
    });
    const aiCreate = calls.find((call) => call.path === '/api/v1/ai-configs' && call.method === 'POST');
    assert.equal(aiCreate.body.api_key, 'sk-secret');
    const aiPatch = calls.find((call) => call.path === '/api/v1/ai-configs/5' && call.method === 'PATCH');
    assert.deepStrictEqual(aiPatch.body, { name: 'Codex updated', api_key: '', version: 2 });
    const chatPatch = calls.filter((call) => call.path === '/api/v1/ai-configs/5' && call.method === 'PATCH').at(-1);
    assert.deepStrictEqual(chatPatch.body, {
      provider: 'openai', base_url: 'https://chat.example.test', api_key: 'chat-secret',
      model: 'gpt-5.5', temperature: '0.2', version: 2,
    });
    assert.equal(fallback.calls.some((call) => [
      'interruptIntake', 'resumeIntake', 'appendIntakeTask', 'createScript',
      'aiConfigCreate', 'aiConfigUpdate', 'aiConfigDelete', 'chatGetConfig', 'chatSaveConfig',
    ].includes(call.key)), false);
  });

  it('creates the first Go-owned AI config when the compatibility chat form has no saved config', async () => {
    const created = {
      id: 1, project_id: null, projectId: null, name: '默认配置', provider: 'openai',
      base_url: 'https://api.openai.com', baseUrl: 'https://api.openai.com',
      has_api_key: true, hasApiKey: true, masked_key: '····cret', maskedKey: '····cret',
      model: 'gpt-5.5', temperature: '0.3', thinking_depth: null, thinkingDepth: null,
      thinking_budget_tokens: null, thinkingBudgetTokens: null,
      created_at: '2026-07-11T00:00:00.000Z', createdAt: '2026-07-11T00:00:00.000Z',
      updated_at: '2026-07-11T00:00:00.000Z', updatedAt: '2026-07-11T00:00:00.000Z', version: 1,
    };
    const calls = [];
    const { client, fallback } = createClient(async (target, init) => {
      const url = new URL(target);
      const body = init.body ? JSON.parse(init.body) : undefined;
      calls.push({ path: url.pathname, method: init.method, body });
      if (url.pathname === '/api/v1/ai-configs' && init.method === 'GET') return success([]);
      if (url.pathname === '/api/v1/ai-configs' && init.method === 'POST') return success(created);
      throw new Error(`unexpected Go business URL: ${url.pathname}`);
    });

    assert.deepStrictEqual(await client.chatGetConfig(), {
      source: 'go-default', compatibilityOnly: false, provider: 'openai', baseUrl: 'https://api.openai.com',
      hasApiKey: false, maskedKey: '', model: 'gpt-5.5', temperature: '0.3',
      thinkingDepth: null, thinkingBudgetTokens: null,
    });
    assert.deepStrictEqual(await client.chatSaveConfig({ apiKey: 'chat-secret' }), { saved: true });
    assert.deepStrictEqual(calls.at(-1).body, { name: '默认配置', api_key: 'chat-secret' });
    assert.equal(fallback.calls.some((call) => call.key === 'chatGetConfig' || call.key === 'chatSaveConfig'), false);
  });

  it('starts and stops a task through HTTP, follows cancellation, and refreshes the snapshot', async () => {
    const calls = [];
    const streams = [];
    const taskSnapshot = (status) => {
      const value = snapshot(project(7));
      value.tasks = [{
        id: 21, project_id: 7, plan_id: 12, task_key: 'P005', title: 'Desktop task stop smoke',
        raw_line: '- [ ] P005: Desktop task stop smoke', scope: 'src/**', scope_files: [], status,
        sort_order: 5, started_at: '2026-07-15T00:00:00.000Z',
        finished_at: status === 'cancelled' ? '2026-07-15T00:00:01.000Z' : null,
        duration_ms: status === 'cancelled' ? 1000 : 0, codex_session_id: null,
        updated_at: '2026-07-15T00:00:01.000Z', accepted_at: null,
        file_path: 'docs/plan/task-stop.md', plan_title: 'Task stop regression',
      }];
      return value;
    };
    let snapshotStatus = 'running';
    const { client, fallback } = createClient(async (target, init) => {
      const url = new URL(target);
      const body = init.body ? JSON.parse(init.body) : undefined;
      calls.push({ path: `${url.pathname}${url.search}`, method: init.method, body });
      if (url.pathname.endsWith('/tasks/21/actions/run')) {
        snapshotStatus = 'running';
        return success({
          operation_id: 'task.run.21', type: 'task.run', status: 'accepted',
          request_id: requestId, accepted_at: '2026-07-15T00:00:00.000Z',
        });
      }
      if (url.pathname.endsWith('/tasks/21/actions/stop')) {
        snapshotStatus = 'cancelled';
        return success({
          operation_id: 'task.stop.21', type: 'task.stop', status: 'accepted',
          request_id: requestId, accepted_at: '2026-07-15T00:00:01.000Z',
        });
      }
      if (url.pathname === '/api/v1/projects/7/snapshot') return success(taskSnapshot(snapshotStatus));
      if (url.pathname.startsWith('/api/v1/operations/')) return response(200, {}, 'text/event-stream');
      throw new Error(`unexpected task stop smoke URL: ${url.pathname}`);
    }, {
      runtimeFeatures: { go_task_actions: true },
      eventModule: {
        createResumableEventStream: (options) => {
          const record = { options, stopped: false };
          streams.push(record);
          const stop = () => { record.stopped = true; };
          stop.completeResync = () => {};
          return stop;
        },
        isTerminalOperationEvent: (event) => event.type === 'operation.cancelled',
      },
    });

    const running = await client.runTask({ projectId: 7, planId: 12, taskId: 21 });
    const cancelled = await client.stopTask({ projectId: 7, planId: 12, taskId: 21 });

    assert.equal(running.tasks[0].status, 'running');
    assert.equal(cancelled.tasks[0].status, 'cancelled');
    assert.deepStrictEqual(calls.filter((call) => call.path.includes('/tasks/21/actions/')).map(
      ({ path, method, body }) => ({ path, method, body }),
    ), [
      { path: '/api/v1/projects/7/tasks/21/actions/run', method: 'POST', body: { plan_id: 12 } },
      { path: '/api/v1/projects/7/tasks/21/actions/stop', method: 'POST', body: { plan_id: 12 } },
    ]);
    assert.equal(calls.filter((call) => call.path === '/api/v1/projects/7/snapshot').length, 2);
    assert.equal(client.getRuntimeOperationOwner('task.stop.21'), 'go');
    assert.equal(streams.length, 2);
    await streams[1].options.open(null, new AbortController().signal);
    assert.equal(calls.at(-1).path, '/api/v1/operations/task.stop.21/events?project_id=7');
    streams[1].options.onEvent({
      event_class: 'operation', type: 'operation.cancelled', operation_id: 'task.stop.21',
    });
    assert.equal(streams[1].stopped, true, 'the cancellation terminal event must close its Operation stream');
    assert.equal(fallback.calls.some((call) => call.key === 'runTask' || call.key === 'stopTask'), false);
  });

  it('accepts the synchronous retry mutation contract and immediately starts one loop cycle', async () => {
    const resetSnapshot = snapshot(project(7));
    resetSnapshot.requirements = [intake('requirement', 30)];
    const runningSnapshot = snapshot(project(7));
    runningSnapshot.state.phase = 'scan';
    const calls = [];
    const { client, fallback } = createClient(async (target, init) => {
      const url = new URL(target);
      calls.push({ path: `${url.pathname}${url.search}`, method: init.method, body: init.body });
      if (url.pathname.endsWith('/retry-plan-generation')) {
        return success({ snapshot: resetSnapshot });
      }
      if (url.pathname.endsWith('/loop/actions/run-once')) {
        return success({
          operation_id: 'loop.retry.1', type: 'loop.run_once', status: 'accepted',
          request_id: requestId, accepted_at: '2026-07-14T00:00:00.000Z',
        });
      }
      if (url.pathname.endsWith('/snapshot')) return success(runningSnapshot);
      if (url.pathname.includes('/api/v1/operations/')) {
        return response(503, {
          code: 'service_unavailable', message: 'fixture stream unavailable',
          request_id: requestId, retryable: true,
        });
      }
      throw new Error(`unexpected retry URL: ${url.pathname}`);
    }, {
      runtimeFeatures: { go_acceptance_retry_actions: true, go_loop_actions: true },
    });

    assert.deepStrictEqual(await client.retryIntakePlanGeneration({
      projectId: 7, type: 'requirement', id: 30,
    }), runningSnapshot);
    assert.deepStrictEqual(calls.slice(0, 3).map(({ path, method }) => ({ path, method })), [
      { path: '/api/v1/projects/7/intake/requirement/30/actions/retry-plan-generation', method: 'POST' },
      { path: '/api/v1/projects/7/loop/actions/run-once', method: 'POST' },
      { path: '/api/v1/projects/7/snapshot', method: 'GET' },
    ]);
    assert.equal(fallback.calls.some((call) => call.key === 'retryIntakePlanGeneration'), false);
  });
});

describe('HttpAutoplanClient configuration boundary', () => {
  it('rejects non-loopback, credential-in-URL, persistent, or incomplete configuration', () => {
    const { HttpAutoplanClient } = loadHttpClient();
    const delegate = fallbackClient().client;
    for (const baseUrl of [
      'https://127.0.0.1:43123',
      'http://localhost:43123',
      'http://127.0.0.1:43123/api',
      'http://127.0.0.1',
    ]) {
      assert.throws(
        () => new HttpAutoplanClient({ baseUrl, sessionCredential: credential, delegate }),
        (error) => error.code === 'http_configuration_invalid',
      );
    }
    assert.throws(
      () => new HttpAutoplanClient({ baseUrl: 'http://127.0.0.1:43123', delegate }),
      (error) => error.code === 'http_configuration_invalid',
    );
    const httpSource = source('src', 'renderer', 'lib', 'api', 'httpClient.ts');
    assert.doesNotMatch(httpSource, /localStorage|sessionStorage|window\.autoplan/);
  });
});
