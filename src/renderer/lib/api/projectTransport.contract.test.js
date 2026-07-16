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

function transpiledModule(file, runtimeImports = {}) {
  const compiled = ts.transpileModule(source(...file.split('/')), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: file,
  }).outputText;
  const module = { exports: {} };
  const wrapper = vm.runInThisContext(`(function (require, module, exports) { ${compiled}\n})`);
  wrapper((id) => {
    if (Object.prototype.hasOwnProperty.call(runtimeImports, id)) return runtimeImports[id];
    throw new Error(`unexpected runtime import: ${id}`);
  }, module, module.exports);
  return module.exports;
}

function client(fetchImpl) {
  const { UnavailableAutoplanClient } = transpiledModule('src/renderer/lib/api/ipcClient.ts', {
    './client': { AUTOPLAN_CLIENT_OPERATION_KEYS: operationKeys },
  });
  const { HttpAutoplanClient } = transpiledModule('src/renderer/lib/api/httpClient.ts', {
    './client': { AUTOPLAN_CLIENT_OPERATION_KEYS: operationKeys },
    './events': {
      AUTOPLAN_CLIENT_EVENT_KEYS: eventKeys,
      consumeProjectEventPlaceholder: async () => {},
      createResumableChatEventStream: () => () => {},
      createResumableEventStream: () => () => {},
      isTerminalOperationEvent: () => false,
    },
    './terminalTransport': {
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
    },
  });
  const unavailable = new UnavailableAutoplanClient();
  let intentSequence = 0;
  const http = new HttpAutoplanClient({
    baseUrl: 'http://127.0.0.1:43123',
    sessionCredential: 'A'.repeat(43),
    timeoutMs: 1_000,
    fetchImpl,
    idempotencyKeyFactory: () => `renderer:contract-${++intentSequence}`,
    delegate: unavailable,
  });
  return http;
}

function project(id) {
  return {
    id, name: `Synthetic ${id}`, workspace_path: `<fixture-workspace>/project-${id}`,
    description: '', created_at: '2026-01-02T03:04:05.000Z',
    updated_at: `2026-01-02T03:04:${String(10 - id).padStart(2, '0')}.000Z`,
    running: 0, phase: 'idle', interval_seconds: 5,
  };
}

function snapshot(projects, active = null) {
  return {
    activeProjectId: active?.id ?? null, activeProject: active, projects, mcp: {},
    state: active ? { project_id: active.id, workspace_path: active.workspace_path, version: 1 } : null,
    requirements: [], feedback: [], attachments: [], plans: [], tasks: [], events: [], scans: [],
    scanSummary: {}, scripts: [], executors: [], terminals: [], activeOperation: null,
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
      'X-Request-ID': body.request_id,
    }),
    text: async () => text,
  };
}

function httpFixture(projects, captures) {
  return async (target, init) => {
    const url = new URL(target);
    captures.push({
      path: `${url.pathname}${url.search}`,
      method: init.method,
      headerNames: Object.keys(init.headers).sort(),
      aborted: init.signal.aborted,
    });
    if (url.pathname === '/api/v1/projects') {
      const page = Number(url.searchParams.get('page'));
      const pageSize = Number(url.searchParams.get('page_size'));
      const start = (page - 1) * pageSize;
      const data = projects.slice(start, start + pageSize);
      return response({
        data,
        pagination: {
          page, page_size: pageSize, total: projects.length,
          next_page: start + data.length < projects.length ? page + 1 : null,
        },
        request_id: 'req_transport_contract',
      });
    }
    const match = url.pathname.match(/^\/api\/v1\/projects\/(\d+)\/snapshot$/);
    if (match) {
      const active = projects.find((item) => item.id === Number(match[1]));
      return response({ data: snapshot(projects, active), request_id: 'req_transport_contract' });
    }
    throw new Error('unexpected HTTP contract path');
  };
}

describe('Project Go HTTP transport contract', () => {
  it('returns project-list and active-project snapshots without DTO remapping', async () => {
    const projects = [project(3), project(2), project(1)];
    const captures = [];
    const http = client(httpFixture(projects, captures));

    const projectList = await http.snapshot(null);
    assert.deepStrictEqual(projectList.projects, projects);
    assert.equal(projectList.activeProjectId, null);
    assert.equal(projectList.activeProject, null);
    assert.deepStrictEqual(await http.snapshot(2), snapshot(projects, projects[1]));
    assert.deepStrictEqual((await http.listProjects({ page: 1, pageSize: 2 })).data, projects.slice(0, 2));
    assert.deepStrictEqual((await http.listProjects({ page: 2, pageSize: 2 })).data, projects.slice(2));
    assert.deepStrictEqual(captures.map((item) => item.path), [
      '/api/v1/projects?page=1&page_size=200&sort=updated_at_desc',
      '/api/v1/projects/2/snapshot',
      '/api/v1/projects?page=1&page_size=2&sort=updated_at_desc',
      '/api/v1/projects?page=2&page_size=2&sort=updated_at_desc',
    ]);
    assert.doesNotMatch(JSON.stringify(captures), /A{20}|env_vars|<fixture-workspace>/);
  });

  it('returns Project/Config mutation snapshots without a business fallback', async () => {
    const projects = [project(1)];
    const expected = snapshot(projects, projects[0]);
    expected.state.version = 2;
    const captures = [];
    const fetchImpl = async (target, init) => {
      const url = new URL(target);
      captures.push({
        path: url.pathname,
        method: init.method,
        body: init.body === undefined ? undefined : JSON.parse(init.body),
        hasIdempotencyKey: typeof init.headers['Idempotency-Key'] === 'string',
      });
      return response({ data: expected, request_id: 'req_transport_contract' });
    };
    const http = client(fetchImpl);
    const createInput = {
      name: 'Synthetic write', workspacePath: '<fixture-workspace>/project-1', description: '',
    };
    const updateInput = { id: 1, ...createInput };
    const deleteInput = { projectId: 1 };
    const configInput = {
      projectId: 1,
      version: 1,
      intervalSeconds: 5,
      validationCommand: 'synthetic-check',
      projectPrompt: '',
      agentCliProvider: 'codex',
      agentCliCommand: 'codex',
      planGenerationStrategy: 'external-cli-markdown',
      planGenerationCommand: 'codex',
      planGenerationModel: '',
      planExecutionStrategy: 'external-cli',
      planExecutionCommand: 'codex',
      planExecutionModel: '',
    };

    for (const [key, input] of [
      ['createProject', createInput],
      ['updateProject', updateInput],
      ['configureLoop', configInput],
      ['deleteProject', deleteInput],
    ]) {
      assert.deepStrictEqual(await http[key](input), expected);
    }

    assert.deepStrictEqual(captures.map(({ path, method }) => ({ path, method })), [
      { path: '/api/v1/projects', method: 'POST' },
      { path: '/api/v1/projects/1', method: 'PATCH' },
      { path: '/api/v1/projects/1/loop-config', method: 'PATCH' },
      { path: '/api/v1/projects/1', method: 'DELETE' },
    ]);
    assert.ok(captures.every((capture) => capture.hasIdempotencyKey));
    assert.deepStrictEqual(captures[0].body, {
      name: createInput.name,
      workspace_path: createInput.workspacePath,
      description: createInput.description,
    });
    assert.equal(captures[2].body.version, 1);
    assert.equal(captures[2].body.validation_command, 'synthetic-check');
  });

  it('makes HTTP mutation cancellation observable without falling back to IPC', async () => {
    let fetches = 0;
    const pendingFetch = (_target, init) => new Promise((resolve, reject) => {
      fetches += 1;
      init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    });
    const http = client(pendingFetch);

    const controller = new AbortController();
    const pending = http.createProject({
      name: 'Cancelled', workspacePath: '<fixture-workspace>/cancelled',
    }, { signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, (error) => error.code === 'request_cancelled');
    assert.equal(fetches, 1);
  });

  it('keeps the sole renderer business transport locked to Go HTTP', () => {
    const transport = source('src/renderer/lib/api/transport.ts');
    assert.match(transport, /DEFAULT_AUTOPLAN_TRANSPORT = 'http'/);
    assert.match(transport, /transport: HTTP_AUTOPLAN_TRANSPORT/);
    assert.match(transport, /fellBackToIpc: false/);
    assert.match(transport, /go_business_transport_unavailable/);
    assert.doesNotMatch(transport, /VITE_.*(?:PROJECT|SNAPSHOT|SSE)/);
  });
});
