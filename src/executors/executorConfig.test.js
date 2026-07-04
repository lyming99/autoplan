const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AppDatabase } = require('../database');
const {
  normalizeExecutorConfig,
  normalizeTasksJson,
  validateExecutorConfig,
} = require('./executorConfig');
const { executorDbFields, executorFromRow } = require('./executorStore');

describe('executor database migration', () => {
  it('creates executors table with the P001 data contract columns', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoplan-executors-db-'));
    try {
      const db = new AppDatabase(path.join(tempDir, 'app.sqlite'));
      await db.init();

      const columns = db.all('PRAGMA table_info(executors)').map((column) => column.name);

      const expectedColumns = [
        'id',
        'project_id',
        'label',
        'type',
        'command',
        'args_json',
        'options_json',
        'group_kind',
        'group_is_default',
        'presentation_json',
        'problem_matcher_json',
        'depends_on_json',
        'depends_order',
        'enabled',
        'sort_order',
        'last_status',
        'last_exit_code',
        'last_duration_ms',
        'last_log',
        'last_run_at',
        'created_at',
        'updated_at',
      ];
      for (const column of expectedColumns) {
        assert.ok(columns.includes(column), `executors table should include ${column}`);
      }
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe('normalizeExecutorConfig', () => {
  it('normalizes the supported VS Code Tasks subset into a stable internal structure', () => {
    const config = normalizeExecutorConfig({
      label: ' build ',
      type: 'shell',
      command: ' npm ',
      args: ['run', 'build', { value: '--flag', quoting: 'strong' }],
      options: {
        cwd: '${workspace}/web',
        env: { NODE_ENV: 'production', EMPTY: null },
      },
      group: { kind: 'build', isDefault: true },
      dependsOn: 'prepare',
      dependsOrder: 'sequence',
      presentation: {
        reveal: 'always',
        panel: 'dedicated',
        clear: true,
        focus: false,
        ignored: 'not persisted',
      },
      problemMatcher: ['$tsc'],
      enabled: 'true',
      sortOrder: '7',
    });

    assert.deepEqual(config, {
      label: 'build',
      type: 'shell',
      command: 'npm',
      args: ['run', 'build', { value: '--flag', quoting: 'strong' }],
      options: {
        cwd: '${workspace}/web',
        env: { NODE_ENV: 'production', EMPTY: '' },
      },
      group: { kind: 'build', isDefault: true },
      presentation: {
        reveal: 'always',
        panel: 'dedicated',
        focus: false,
        clear: true,
      },
      problemMatcher: ['$tsc'],
      dependsOn: ['prepare'],
      dependsOrder: 'sequence',
      enabled: true,
      sortOrder: 7,
    });
  });

  it('returns structured validation errors for required fields and enum values', () => {
    const result = validateExecutorConfig({
      label: '',
      type: 'npm',
      command: '',
      dependsOrder: 'serial',
    });

    assert.equal(result.valid, false);
    assert.deepEqual(result.errors.map((error) => error.code), [
      'missing_label',
      'invalid_type',
      'missing_command',
      'invalid_depends_order',
    ]);
  });

  it('returns a duplicate_label error for manual same-project label collisions', () => {
    const result = validateExecutorConfig(
      { label: 'build', type: 'shell', command: 'npm run build' },
      { existingLabels: ['build'] },
    );

    assert.equal(result.valid, false);
    assert.equal(result.errors[0].code, 'duplicate_label');
    assert.equal(result.errors[0].field, 'label');
  });

  it('rejects debug-only fields with structured errors before persistence', () => {
    const result = validateExecutorConfig({
      label: 'launch app',
      type: 'shell',
      command: 'node app.js',
      request: 'launch',
      debugServer: 4711,
      stopAtEntry: true,
    });

    assert.equal(result.valid, false);
    assert.equal(result.errors[0].code, 'debug_fields_not_supported');
    assert.equal(result.errors[0].field, 'request');
    assert.deepEqual(result.errors[0].details.fields, ['request', 'debugServer', 'stopAtEntry']);
  });
});

describe('normalizeTasksJson', () => {
  it('imports only version and tasks[] while skipping debug-shaped task entries', () => {
    const result = normalizeTasksJson({
      version: '2.0.0',
      configurations: [{ name: 'ignored launch config' }],
      tasks: [
        {
          label: 'debug app',
          type: 'shell',
          command: 'node',
          request: 'launch',
          program: 'app.js',
        },
        {
          label: 'test',
          type: 'process',
          command: 'npm',
          args: ['test'],
        },
      ],
    });

    assert.equal(result.version, '2.0.0');
    assert.equal(result.executors.length, 1);
    assert.equal(result.executors[0].label, 'test');
    assert.equal(result.skipped.length, 1);
    assert.equal(result.skipped[0].code, 'debug_task_ignored');
    assert.deepEqual(result.skipped[0].fields, ['request', 'program']);
    assert.deepEqual(result.errors, []);
  });

  it('ignores launch.json-shaped documents without generating executors', () => {
    const result = normalizeTasksJson({
      version: '0.2.0',
      configurations: [{ name: 'Launch', request: 'launch', program: 'main.js' }],
    });

    assert.equal(result.executors.length, 0);
    assert.equal(result.skipped[0].code, 'launch_json_ignored');
    assert.deepEqual(result.errors, []);
  });

  it('deduplicates imported labels with stable readable suffixes', () => {
    const result = normalizeTasksJson({
      version: '2.0.0',
      tasks: [
        { label: 'build', type: 'shell', command: 'npm run build' },
        { label: 'build', type: 'shell', command: 'npm run build:fast' },
      ],
    }, { existingLabels: ['build'] });

    assert.deepEqual(result.executors.map((executor) => executor.label), ['build (2)', 'build (3)']);
    assert.deepEqual(result.errors, []);
  });

  it('collects invalid task errors without dropping valid imported tasks', () => {
    const result = normalizeTasksJson({
      version: '2.0.0',
      tasks: [
        { label: 'missing command', type: 'shell' },
        { label: 'bad order', type: 'shell', command: 'npm test', dependsOrder: 'serial' },
        { label: 'ok', type: 'shell', command: 'npm run ok', options: { env: { CI: true } } },
      ],
    });

    assert.deepEqual(result.executors.map((executor) => executor.label), ['ok']);
    assert.deepEqual(result.executors[0].options.env, { CI: 'true' });
    assert.deepEqual(result.errors.map((error) => [error.index, error.label, error.code]), [
      [0, 'missing command', 'missing_command'],
      [1, 'bad order', 'invalid_depends_order'],
    ]);
    assert.deepEqual(result.skipped, []);
  });
});

describe('executorStore row mapping', () => {
  it('serializes JSON-backed config fields and maps rows back to camelCase executor objects', () => {
    const config = normalizeExecutorConfig({
      label: 'unit',
      type: 'process',
      command: 'npm',
      args: ['test'],
      options: { cwd: 'packages/app', env: { CI: '1' } },
      group: 'test',
      presentation: { reveal: 'silent', clear: true },
      problemMatcher: '$tsc',
      dependsOn: ['build'],
      enabled: false,
      sortOrder: 5,
    });

    const fields = executorDbFields(config);
    assert.equal(fields.args_json, '["test"]');
    assert.equal(fields.options_json, '{"cwd":"packages/app","env":{"CI":"1"}}');
    assert.equal(fields.problem_matcher_json, '"$tsc"');
    assert.equal(fields.depends_on_json, '["build"]');
    assert.equal(fields.enabled, 0);

    const row = executorFromRow({
      id: 9,
      project_id: 3,
      ...fields,
      last_status: 'ok',
      last_exit_code: 0,
      last_duration_ms: 1200,
      last_log: 'done',
      last_run_at: '2026-07-03T00:00:00.000Z',
      created_at: '2026-07-03T00:00:00.000Z',
      updated_at: '2026-07-03T00:00:00.000Z',
    });

    assert.equal(row.id, 9);
    assert.equal(row.projectId, 3);
    assert.deepEqual(row.args, ['test']);
    assert.deepEqual(row.options, { cwd: 'packages/app', env: { CI: '1' } });
    assert.deepEqual(row.group, { kind: 'test', isDefault: false });
    assert.equal(row.enabled, false);
    assert.equal(row.lastStatus, 'ok');
  });
});

describe('plugin executor actions', () => {
  it('accepts a plugin executor with a required start action and optional reload/stop', () => {
    const config = normalizeExecutorConfig({
      label: 'flutter run',
      type: 'plugin',
      actions: {
        start: { type: 'command', command: 'flutter', args: ['run'] },
        reload: { type: 'input', input: 'r' },
        stop: { type: 'command', command: 'taskkill', args: ['/PID', '$PID'] },
      },
    });

    assert.equal(config.type, 'plugin');
    assert.ok(config.actions, 'plugin 配置应携带规范化后的 actions');
    assert.equal(config.actions.start.type, 'command');
    assert.equal(config.actions.start.command, 'flutter');
    assert.deepEqual(config.actions.start.args, ['run']);
    assert.equal(config.actions.reload.type, 'input');
    assert.equal(config.actions.reload.input, 'r');
    assert.equal(config.actions.stop.command, 'taskkill');
    // 顶层 command 由 start action 推导，避免重复输入
    assert.equal(config.command, 'flutter');
  });

  it('rejects a plugin executor when the start action is missing', () => {
    const result = validateExecutorConfig({
      label: 'no start',
      type: 'plugin',
      actions: { reload: { type: 'input', input: 'r' } },
    });

    assert.equal(result.valid, false);
    assert.ok(
      result.errors.some((error) => error.code === 'missing_plugin_start'),
      '缺少 start 应报 missing_plugin_start',
    );
  });

  it('validates plugin reload action input and command shapes', () => {
    const emptyInput = validateExecutorConfig({
      label: 'reload empty input',
      type: 'plugin',
      actions: {
        start: { type: 'command', command: 'flutter' },
        reload: { type: 'input', input: '   ' },
      },
    });
    assert.equal(emptyInput.valid, false);
    assert.ok(
      emptyInput.errors.some((error) => error.code === 'missing_plugin_reload_input'),
      'input 模式 reload 的 input 为空应报错',
    );

    const emptyCommand = validateExecutorConfig({
      label: 'reload empty command',
      type: 'plugin',
      actions: {
        start: { type: 'command', command: 'flutter' },
        reload: { type: 'command', command: '' },
      },
    });
    assert.equal(emptyCommand.valid, false);
    assert.ok(
      emptyCommand.errors.some((error) => error.code === 'missing_plugin_reload_command'),
      'command 模式 reload 的 command 为空应报错',
    );
  });

  it('ignores actions on non-plugin executor types for backward compatibility', () => {
    const config = normalizeExecutorConfig({
      label: 'shell with actions',
      type: 'shell',
      command: 'npm',
      args: ['test'],
      actions: { start: { type: 'command', command: 'ignored' } },
    });

    assert.equal(config.type, 'shell');
    assert.equal(config.actions, undefined, 'shell 执行器不应携带 actions');
  });

  it('serializes and restores plugin actions through executorDbFields/executorFromRow', () => {
    const config = normalizeExecutorConfig({
      label: 'dev',
      type: 'plugin',
      actions: {
        start: { type: 'command', command: 'npm', args: ['run', 'dev'] },
        reload: { type: 'input', input: 'r' },
      },
    });
    const fields = executorDbFields(config);
    assert.equal(fields.actions_json, JSON.stringify(config.actions));

    const restored = executorFromRow({ id: 1, project_id: 1, ...fields });
    assert.equal(restored.type, 'plugin');
    assert.deepEqual(restored.actions, config.actions);
  });
});
