const { nowIso } = require('../database');
const {
  normalizeExecutorConfig,
  normalizeTasksJson,
} = require('./executorConfig');

const EXECUTOR_CONFIG_COLUMNS = [
  'label',
  'type',
  'command',
  'args_json',
  'actions_json',
  'options_json',
  'group_kind',
  'group_is_default',
  'presentation_json',
  'problem_matcher_json',
  'depends_on_json',
  'depends_order',
  'enabled',
  'sort_order',
];

const LAST_LOG_MAX_CHARS = 24000;

class ExecutorStore {
  constructor(db) {
    this.db = db;
  }

  list(projectId) {
    return listExecutors(this.db, projectId);
  }

  get(projectId, executorId) {
    return getExecutor(this.db, projectId, executorId);
  }

  create(projectId, input = {}) {
    return createExecutor(this.db, projectId, input);
  }

  update(projectId, executorId, input = {}) {
    return updateExecutor(this.db, projectId, executorId, input);
  }

  delete(projectId, executorId) {
    return deleteExecutor(this.db, projectId, executorId);
  }

  toggle(projectId, executorId) {
    return toggleExecutor(this.db, projectId, executorId);
  }

  importTasksJson(projectId, input = {}, options = {}) {
    return importTasksJson(this.db, projectId, input, options);
  }

  updateRunState(projectId, executorId, patch = {}) {
    return updateExecutorRunState(this.db, projectId, executorId, patch);
  }
}

function createExecutorStore(db) {
  return new ExecutorStore(db);
}

function listExecutors(db, projectId) {
  const id = requireProjectId(projectId);
  return db.all(
    'SELECT * FROM executors WHERE project_id = ? ORDER BY sort_order ASC, id ASC',
    [id],
  ).map(executorFromRow);
}

function getExecutor(db, projectId, executorId) {
  const row = db.get(
    'SELECT * FROM executors WHERE id = ? AND project_id = ?',
    [requireRecordId(executorId, 'executorId'), requireProjectId(projectId)],
  );
  return row ? executorFromRow(row) : null;
}

function createExecutor(db, projectId, input = {}) {
  const id = requireProjectId(projectId);
  const config = normalizeExecutorConfig(input, {
    existingLabels: executorLabels(db, id),
    dedupeLabel: false,
  });
  const fields = executorDbFields(config);
  const ts = nowIso();
  const insertedId = db.insert(
    `INSERT INTO executors (project_id, ${EXECUTOR_CONFIG_COLUMNS.join(', ')}, created_at, updated_at)
     VALUES (${placeholders(EXECUTOR_CONFIG_COLUMNS.length + 3)})`,
    [id, ...executorFieldValues(fields), ts, ts],
  );
  return getExecutor(db, id, insertedId);
}

function updateExecutor(db, projectId, executorId, input = {}) {
  const project = requireProjectId(projectId);
  const id = requireRecordId(executorId, 'executorId');
  const current = getExecutor(db, project, id);
  if (!current) throw new Error('执行器不存在');

  const config = normalizeExecutorConfig(input, {
    current,
    existingLabels: executorLabels(db, project, id),
    dedupeLabel: false,
  });
  const fields = executorDbFields(config);
  db.run(
    `UPDATE executors
        SET ${EXECUTOR_CONFIG_COLUMNS.map((column) => `${column} = ?`).join(', ')}, updated_at = ?
      WHERE id = ? AND project_id = ?`,
    [...executorFieldValues(fields), nowIso(), id, project],
  );
  return getExecutor(db, project, id);
}

function deleteExecutor(db, projectId, executorId) {
  const project = requireProjectId(projectId);
  const id = requireRecordId(executorId, 'executorId');
  const current = getExecutor(db, project, id);
  if (!current) throw new Error('执行器不存在');
  db.run('DELETE FROM executors WHERE id = ? AND project_id = ?', [id, project]);
  return current;
}

function toggleExecutor(db, projectId, executorId) {
  const project = requireProjectId(projectId);
  const id = requireRecordId(executorId, 'executorId');
  const current = getExecutor(db, project, id);
  if (!current) throw new Error('执行器不存在');
  db.run(
    'UPDATE executors SET enabled = ?, updated_at = ? WHERE id = ? AND project_id = ?',
    [current.enabled ? 0 : 1, nowIso(), id, project],
  );
  return getExecutor(db, project, id);
}

function importTasksJson(db, projectId, input = {}, options = {}) {
  const project = requireProjectId(projectId);
  const parsed = normalizeTasksJson(input, {
    ...options,
    existingLabels: executorLabels(db, project),
    startSortOrder: nextSortOrder(db, project),
    dedupeLabel: options.dedupeLabel !== false,
  });

  const inserted = [];
  for (const config of parsed.executors) {
    inserted.push(createExecutor(db, project, {
      ...config,
      label: config.label,
      sortOrder: config.sortOrder,
    }));
  }

  return {
    version: parsed.version,
    importedCount: inserted.length,
    skippedCount: parsed.skipped.length,
    errorCount: parsed.errors.length,
    executors: inserted,
    skipped: parsed.skipped,
    errors: parsed.errors,
  };
}

function updateExecutorRunState(db, projectId, executorId, patch = {}) {
  const project = requireProjectId(projectId);
  const id = requireRecordId(executorId, 'executorId');
  const current = getExecutor(db, project, id);
  if (!current) throw new Error('执行器不存在');

  const assignments = [];
  const params = [];
  setPatchField(assignments, params, patch, ['lastStatus', 'last_status', 'status'], 'last_status');
  setPatchField(assignments, params, patch, ['lastExitCode', 'last_exit_code', 'exitCode'], 'last_exit_code');
  setPatchField(assignments, params, patch, ['lastDurationMs', 'last_duration_ms', 'durationMs'], 'last_duration_ms');
  setPatchField(assignments, params, patch, ['lastLog', 'last_log', 'log'], 'last_log', truncateLog);
  setPatchField(assignments, params, patch, ['lastRunAt', 'last_run_at', 'runAt'], 'last_run_at');
  setPatchField(
    assignments,
    params,
    patch,
    ['pluginState', 'plugin_state', 'pluginStateJson', 'plugin_state_json'],
    'plugin_state_json',
    (value) => (value === undefined || value === null ? null : stringifyJson(value, null)),
  );

  if (!assignments.length) return current;
  assignments.push('updated_at = ?');
  params.push(nowIso(), id, project);
  db.run(
    `UPDATE executors SET ${assignments.join(', ')} WHERE id = ? AND project_id = ?`,
    params,
  );
  return getExecutor(db, project, id);
}

function terminalCommandShortcutsFromExecutors(executors = []) {
  if (!Array.isArray(executors)) return [];
  return executors
    .map(terminalCommandShortcutFromExecutor)
    .filter(Boolean);
}

function terminalCommandShortcutFromExecutor(executor = {}) {
  if (!executor || typeof executor !== 'object') return null;
  if (!readEnabledFlag(executor.enabled, true)) return null;

  const command = String(executor.command || '').trim();
  if (!command) return null;

  const args = Array.isArray(executor.args) ? executor.args : arrayField(executor.args_json);
  const argsText = args
    .map(executorArgToTerminalText)
    .filter(Boolean)
    .join(' ');
  const options = executor.options && typeof executor.options === 'object'
    ? normalizeStoredOptions(executor.options)
    : normalizeStoredOptions(jsonField(executor.options_json, {}));
  const id = Number(executor.id);
  const label = String(executor.label || command).trim();

  return {
    id: `executor:${Number.isInteger(id) && id > 0 ? id : slugText(label || command)}`,
    source: 'executor',
    label,
    command: [command, argsText].filter(Boolean).join(' '),
    cwd: options.cwd || '',
  };
}

function executorFromRow(row = {}) {
  return {
    id: Number(row.id),
    projectId: Number(row.project_id),
    label: String(row.label || ''),
    type: String(row.type || 'shell'),
    command: String(row.command || ''),
    args: arrayField(row.args_json),
    ...(row.actions_json ? { actions: objectField(row.actions_json) } : {}),
    options: normalizeStoredOptions(jsonField(row.options_json, {})),
    group: {
      kind: row.group_kind ? String(row.group_kind) : null,
      isDefault: Number(row.group_is_default || 0) === 1,
    },
    presentation: objectField(row.presentation_json),
    problemMatcher: jsonField(row.problem_matcher_json, null),
    dependsOn: arrayField(row.depends_on_json),
    dependsOrder: String(row.depends_order || 'parallel'),
    enabled: Number(row.enabled ?? 1) !== 0,
    sortOrder: normalizeNumber(row.sort_order, 0),
    lastStatus: row.last_status || null,
    lastExitCode: nullableNumber(row.last_exit_code),
    lastDurationMs: nullableNumber(row.last_duration_ms),
    lastLog: row.last_log || null,
    lastRunAt: row.last_run_at || null,
    ...(row.plugin_state_json ? { pluginState: objectField(row.plugin_state_json) } : {}),
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}

function executorDbFields(config = {}) {
  return {
    label: config.label,
    type: config.type,
    command: config.command,
    args_json: stringifyJson(config.args, []),
    actions_json: config.type === 'plugin' && config.actions
      ? stringifyJson(config.actions, null)
      : null,
    options_json: stringifyJson(config.options, { cwd: '', env: {} }),
    group_kind: config.group?.kind || null,
    group_is_default: config.group?.isDefault ? 1 : 0,
    presentation_json: stringifyJson(config.presentation, {}),
    problem_matcher_json: config.problemMatcher === undefined || config.problemMatcher === null
      ? null
      : stringifyJson(config.problemMatcher, null),
    depends_on_json: stringifyJson(config.dependsOn, []),
    depends_order: config.dependsOrder || 'parallel',
    enabled: config.enabled ? 1 : 0,
    sort_order: normalizeNumber(config.sortOrder, 0),
  };
}

function executorFieldValues(fields) {
  return EXECUTOR_CONFIG_COLUMNS.map((column) => fields[column]);
}

function executorLabels(db, projectId, exceptExecutorId = null) {
  return db.all('SELECT id, label FROM executors WHERE project_id = ?', [projectId])
    .filter((row) => exceptExecutorId === null || Number(row.id) !== Number(exceptExecutorId))
    .map((row) => String(row.label || ''));
}

function nextSortOrder(db, projectId) {
  const row = db.get('SELECT COALESCE(MAX(sort_order), 0) AS sort_order FROM executors WHERE project_id = ?', [projectId]);
  return normalizeNumber(row?.sort_order, 0);
}

function setPatchField(assignments, params, patch, keys, column, mapper = (value) => value) {
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
    assignments.push(`${column} = ?`);
    params.push(mapper(patch[key]));
    return;
  }
}

function jsonField(raw, fallback) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function arrayField(raw) {
  const parsed = jsonField(raw, []);
  return Array.isArray(parsed) ? parsed : [];
}

function objectField(raw) {
  const parsed = jsonField(raw, {});
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
}

function stringifyJson(value, fallback) {
  try {
    return JSON.stringify(value === undefined ? fallback : value);
  } catch {
    return JSON.stringify(fallback);
  }
}

function normalizeStoredOptions(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) return { cwd: '', env: {} };
  const env = options.env && typeof options.env === 'object' && !Array.isArray(options.env) ? options.env : {};
  const result = {
    cwd: typeof options.cwd === 'string' ? options.cwd : '',
    env,
  };
  if (Number.isFinite(options.timeoutMs)) result.timeoutMs = options.timeoutMs;
  return result;
}

function truncateLog(value) {
  const text = value === undefined || value === null ? '' : String(value);
  return text.length > LAST_LOG_MAX_CHARS ? text.slice(-LAST_LOG_MAX_CHARS) : text;
}

function executorArgToTerminalText(arg) {
  if (arg === undefined || arg === null) return '';
  if (typeof arg !== 'object' || Array.isArray(arg)) return quoteTerminalArg(String(arg));
  const value = String(arg.value ?? '');
  if (!value) return '';
  if (arg.quoting === 'strong') return `'${value.replace(/'/g, "'\"'\"'")}'`;
  if (arg.quoting === 'weak') return `"${value.replace(/(["\\$`])/g, '\\$1')}"`;
  return quoteTerminalArg(value);
}

function quoteTerminalArg(value) {
  const text = String(value || '');
  if (!text) return '';
  if (!/[\s"'`$&|<>()[\]{};]/.test(text)) return text;
  return `"${text.replace(/(["\\$`])/g, '\\$1')}"`;
}

function slugText(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'command';
}

function readEnabledFlag(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (value === false || value === 0) return false;
  return !['0', 'false', 'off', 'no', 'disabled'].includes(String(value).trim().toLowerCase());
}

function normalizeNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.floor(number) : fallback;
}

function nullableNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function placeholders(count) {
  return Array.from({ length: count }, () => '?').join(', ');
}

function requireProjectId(value) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw new Error('项目不存在');
  return id;
}

function requireRecordId(value, field) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw new Error(`${field} 无效`);
  return id;
}

module.exports = {
  EXECUTOR_CONFIG_COLUMNS,
  ExecutorStore,
  createExecutor,
  createExecutorStore,
  deleteExecutor,
  executorDbFields,
  executorFromRow,
  getExecutor,
  importTasksJson,
  listExecutors,
  terminalCommandShortcutFromExecutor,
  terminalCommandShortcutsFromExecutors,
  toggleExecutor,
  updateExecutor,
  updateExecutorRunState,
};
