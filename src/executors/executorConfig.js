const EXECUTOR_TYPES = new Set(['shell', 'process', 'plugin']);
/** plugin action 的执行方式：command 执行独立命令；input 向运行中进程 stdin 发送文本 */
const PLUGIN_ACTION_TYPES = new Set(['command', 'input']);
/** plugin 三态生命周期动作名 */
const PLUGIN_ACTION_NAMES = new Set(['start', 'reload', 'stop']);
const DEPENDS_ORDERS = new Set(['parallel', 'sequence']);
const DEBUG_ONLY_FIELDS = [
  'request',
  'program',
  'debugServer',
  'debugAdapterExecutable',
  'miDebuggerPath',
  'stopAtEntry',
  'serverReadyAction',
  'preLaunchTask',
  'postDebugTask',
  'internalConsoleOptions',
];

const PRESENTATION_REVEAL = new Set(['always', 'silent', 'never']);
const PRESENTATION_PANEL = new Set(['shared', 'dedicated', 'new']);
const PRESENTATION_REVEAL_PROBLEMS = new Set(['never', 'onProblem', 'always']);
const ARG_QUOTING = new Set(['escape', 'strong', 'weak']);

class ExecutorConfigError extends Error {
  constructor(error, errors = null) {
    super(error?.message || '执行器配置无效');
    this.name = 'ExecutorConfigError';
    this.code = error?.code || 'invalid_executor_config';
    this.field = error?.field || null;
    this.details = error?.details || null;
    this.errors = errors || [error];
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      field: this.field,
      message: this.message,
      details: this.details,
      errors: this.errors,
    };
  }
}

function normalizeExecutorConfig(input = {}, options = {}) {
  const result = validateExecutorConfig(input, options);
  if (!result.valid) throw new ExecutorConfigError(result.errors[0], result.errors);
  return result.config;
}

function validateExecutorConfig(input = {}, options = {}) {
  const source = isPlainObject(input) ? input : {};
  const current = isPlainObject(options.current) ? options.current : {};
  const errors = [];
  const debugFields = debugOnlyFields(source);
  if (debugFields.length > 0) {
    errors.push(configError(
      'debug_fields_not_supported',
      debugFields[0],
      `执行器不支持 debug 字段：${debugFields.join(', ')}`,
      { fields: debugFields },
    ));
  }

  const label = trimText(firstDefined(
    pick(source, 'label', 'name'),
    pick(current, 'label', 'name'),
  ));
  if (!label) {
    errors.push(configError('missing_label', 'label', '执行器 label 不能为空'));
  }

  let type = trimText(firstDefined(pick(source, 'type'), pick(current, 'type'), 'shell')).toLowerCase();
  if (!type) type = 'shell';
  if (!EXECUTOR_TYPES.has(type)) {
    errors.push(configError('invalid_type', 'type', '执行器 type 仅支持 shell 或 process', { value: type }));
  }

  const actions = type === 'plugin'
    ? validatePluginActions(firstDefined(
        pick(source, 'actions', 'actionsJson', 'actions_json'),
        pick(current, 'actions', 'actionsJson', 'actions_json'),
        {},
      ), errors)
    : null;

  let command = trimText(firstDefined(pick(source, 'command'), pick(current, 'command')));
  let args = normalizeArgs(firstDefined(
    pick(source, 'args', 'argsJson', 'args_json'),
    pick(current, 'args', 'argsJson', 'args_json'),
    [],
  ), errors);

  // plugin：顶层 command/args 默认由 start action 推导，避免在表单中重复输入
  if (type === 'plugin' && actions && actions.start) {
    if (!command) command = actions.start.command || '';
    if (!args.length) args = Array.isArray(actions.start.args) ? actions.start.args : [];
  }

  if (!command) {
    errors.push(configError('missing_command', 'command', '执行器 command 不能为空'));
  }

  const optionsValue = normalizeOptions(firstDefined(
    pick(source, 'options', 'optionsJson', 'options_json'),
    pick(current, 'options', 'optionsJson', 'options_json'),
    {},
  ), errors);

  const group = normalizeGroup(firstDefined(
    pick(source, 'group'),
    groupFromFlatFields(source),
    pick(current, 'group'),
    groupFromFlatFields(current),
    null,
  ), errors);

  const presentation = normalizePresentation(firstDefined(
    pick(source, 'presentation', 'presentationJson', 'presentation_json'),
    pick(current, 'presentation', 'presentationJson', 'presentation_json'),
    {},
  ), errors);

  const problemMatcher = cloneJsonValue(firstDefined(
    pick(source, 'problemMatcher', 'problem_matcher', 'problemMatcherJson', 'problem_matcher_json'),
    pick(current, 'problemMatcher', 'problem_matcher', 'problemMatcherJson', 'problem_matcher_json'),
    null,
  ), 'problemMatcher', errors);

  const dependsOn = normalizeDependsOn(firstDefined(
    pick(source, 'dependsOn', 'depends_on', 'dependsOnJson', 'depends_on_json'),
    pick(current, 'dependsOn', 'depends_on', 'dependsOnJson', 'depends_on_json'),
    [],
  ), errors);

  const dependsOrderRaw = trimText(firstDefined(
    pick(source, 'dependsOrder', 'depends_order'),
    pick(current, 'dependsOrder', 'depends_order'),
    'parallel',
  ));
  const dependsOrder = dependsOrderRaw || 'parallel';
  if (!DEPENDS_ORDERS.has(dependsOrder)) {
    errors.push(configError(
      'invalid_depends_order',
      'dependsOrder',
      'dependsOrder 仅支持 parallel 或 sequence',
      { value: dependsOrder },
    ));
  }

  const enabled = normalizeBoolean(firstDefined(
    pick(source, 'enabled'),
    pick(current, 'enabled'),
    true,
  ));
  const sortOrder = normalizeInteger(firstDefined(
    pick(source, 'sortOrder', 'sort_order'),
    pick(current, 'sortOrder', 'sort_order'),
    options.sortOrder,
    0,
  ), 0);

  let finalLabel = label;
  const existingLabels = labelSet(options.existingLabels);
  if (finalLabel && existingLabels.has(finalLabel)) {
    if (options.dedupeLabel) {
      finalLabel = uniqueExecutorLabel(finalLabel, existingLabels);
    } else {
      errors.push(configError('duplicate_label', 'label', `同一项目内已存在执行器 label：${finalLabel}`, { label: finalLabel }));
    }
  }

  const config = {
    label: finalLabel,
    type,
    command,
    args,
    options: optionsValue,
    group,
    presentation,
    problemMatcher,
    ...(type === 'plugin' && actions ? { actions } : {}),
    dependsOn,
    dependsOrder,
    enabled,
    sortOrder,
  };

  return { valid: errors.length === 0, config: errors.length === 0 ? config : null, errors };
}

function normalizeTasksJson(input = {}, options = {}) {
  const parsed = parseTasksJsonDocument(input);
  if (!parsed.valid) {
    return {
      version: null,
      executors: [],
      skipped: [],
      errors: [parsed.error],
    };
  }

  const root = parsed.value;
  const version = root.version === undefined || root.version === null ? '' : String(root.version);
  if (!Array.isArray(root.tasks)) {
    if (Array.isArray(root.configurations) && !Object.prototype.hasOwnProperty.call(root, 'tasks')) {
      return {
        version,
        executors: [],
        skipped: [{
          index: null,
          label: null,
          code: 'launch_json_ignored',
          message: 'launch.json 配置已忽略，执行器只导入 .vscode/tasks.json 的 tasks[]',
          fields: ['configurations'],
        }],
        errors: [],
      };
    }
    return {
      version,
      executors: [],
      skipped: [],
      errors: [configError('missing_tasks', 'tasks', '.vscode/tasks.json 需要包含 tasks 数组')],
    };
  }

  const executors = [];
  const skipped = [];
  const errors = [];
  const usedLabels = labelSet(options.existingLabels);
  const startSortOrder = normalizeInteger(options.startSortOrder, 0);

  root.tasks.forEach((task, index) => {
    if (!isPlainObject(task)) {
      errors.push(importError(index, null, configError('invalid_task', 'tasks', 'tasks[] 项必须是对象')));
      return;
    }

    const label = trimText(task.label || task.name || '');
    const debugFields = debugOnlyFields(task);
    if (debugFields.length > 0) {
      skipped.push({
        index,
        label: label || null,
        code: 'debug_task_ignored',
        message: `已跳过包含 debug 字段的任务：${debugFields.join(', ')}`,
        fields: debugFields,
      });
      return;
    }

    const result = validateExecutorConfig(task, {
      ...options,
      existingLabels: usedLabels,
      dedupeLabel: options.dedupeLabel !== false,
      sortOrder: startSortOrder + executors.length + 1,
    });
    if (!result.valid) {
      for (const error of result.errors) errors.push(importError(index, label || null, error));
      return;
    }

    executors.push(result.config);
    usedLabels.add(result.config.label);
  });

  return { version, executors, skipped, errors };
}

function parseTasksJsonDocument(input) {
  if (typeof input === 'string') {
    const text = input.trim();
    if (!text) return { valid: false, error: configError('empty_tasks_json', null, 'tasks.json 内容不能为空') };
    try {
      const parsed = JSON.parse(text);
      return isPlainObject(parsed)
        ? { valid: true, value: parsed }
        : { valid: false, error: configError('invalid_tasks_json', null, 'tasks.json 根节点必须是对象') };
    } catch (error) {
      return {
        valid: false,
        error: configError('invalid_json', null, `tasks.json 不是有效 JSON：${error?.message || error}`),
      };
    }
  }
  if (!isPlainObject(input)) {
    return { valid: false, error: configError('invalid_tasks_json', null, 'tasks.json 根节点必须是对象') };
  }
  return { valid: true, value: input };
}

function debugOnlyFields(task) {
  if (!isPlainObject(task)) return [];
  return DEBUG_ONLY_FIELDS.filter((field) => Object.prototype.hasOwnProperty.call(task, field));
}

function uniqueExecutorLabel(label, existingLabels = new Set()) {
  const base = trimText(label);
  if (!base) return '';
  const labels = labelSet(existingLabels);
  if (!labels.has(base)) return base;
  let index = 2;
  while (labels.has(`${base} (${index})`)) index += 1;
  return `${base} (${index})`;
}

function normalizeArgs(value, errors) {
  const parsed = parseJsonMaybe(value, []);
  if (parsed === undefined || parsed === null || parsed === '') return [];
  if (!Array.isArray(parsed)) {
    errors.push(configError('invalid_args', 'args', 'args 必须是数组'));
    return [];
  }

  const args = [];
  parsed.forEach((entry, index) => {
    if (entry === undefined || entry === null) {
      args.push('');
      return;
    }
    if (typeof entry === 'string' || typeof entry === 'number' || typeof entry === 'boolean') {
      args.push(String(entry));
      return;
    }
    if (isPlainObject(entry) && Object.prototype.hasOwnProperty.call(entry, 'value')) {
      const normalized = { value: String(entry.value ?? '') };
      if (entry.quoting !== undefined && entry.quoting !== null && entry.quoting !== '') {
        const quoting = String(entry.quoting);
        if (!ARG_QUOTING.has(quoting)) {
          errors.push(configError('invalid_arg_quoting', `args[${index}].quoting`, 'args[].quoting 仅支持 escape/strong/weak', { value: quoting }));
        } else {
          normalized.quoting = quoting;
        }
      }
      args.push(normalized);
      return;
    }
    errors.push(configError('invalid_arg', `args[${index}]`, 'args[] 仅支持字符串、数字、布尔值或 { value, quoting } 对象'));
  });
  return args;
}

/**
 * 规范化单个 plugin action（start/reload/stop）。
 * 返回 { type, command, args, input? }；入参为空（undefined/null/''）时返回 null 表示「未配置」。
 * type 缺省按 'command' 处理；args 校验复用 normalizeArgs。
 */
function normalizePluginAction(value, field, errors) {
  if (value === undefined || value === null || value === '') return null;
  if (!isPlainObject(value)) {
    errors.push(configError('invalid_plugin_action', field, `${field} 必须是对象`));
    return null;
  }

  let type = 'command';
  const typeRaw = trimText(pick(value, 'type'));
  if (typeRaw) {
    if (!PLUGIN_ACTION_TYPES.has(typeRaw)) {
      errors.push(configError('invalid_plugin_action_type', `${field}.type`, `${field}.type 仅支持 command 或 input`, { value: typeRaw }));
    } else {
      type = typeRaw;
    }
  }

  const action = {
    type,
    command: trimText(firstDefined(pick(value, 'command', 'cmd'), '')),
    args: normalizeArgs(firstDefined(pick(value, 'args', 'argsJson', 'args_json'), []), errors),
  };

  if (Object.prototype.hasOwnProperty.call(value, 'input')) {
    action.input = trimText(value.input);
  }
  return action;
}

/**
 * 校验并规范化 plugin 执行器的 actions 配置块。
 * - start：必填，command 不能为空，仅支持 command 类型
 * - reload：可选；input 类型要求 input 非空，command 类型要求 command 非空
 * - stop：可选，command 不能为空，仅支持 command 类型
 */
function validatePluginActions(actions, errors) {
  const source = isPlainObject(actions) ? actions : {};
  const normalized = {};

  const start = normalizePluginAction(source.start, 'actions.start', errors);
  if (!start) {
    errors.push(configError('missing_plugin_start', 'actions.start', 'plugin 执行器必须配置 start 启动命令'));
  } else {
    if (!start.command) {
      errors.push(configError('missing_plugin_start_command', 'actions.start.command', 'plugin start action 的 command 不能为空'));
    }
    if (start.type !== 'command') {
      errors.push(configError('invalid_plugin_start_type', 'actions.start.type', 'plugin start action 仅支持 command 类型'));
    }
    normalized.start = start;
  }

  const reload = normalizePluginAction(source.reload, 'actions.reload', errors);
  if (reload) {
    if (reload.type === 'input') {
      if (!reload.input) {
        errors.push(configError('missing_plugin_reload_input', 'actions.reload.input', 'plugin reload 的 input 不能为空'));
      }
    } else if (!reload.command) {
      errors.push(configError('missing_plugin_reload_command', 'actions.reload.command', 'plugin reload action 的 command 不能为空'));
    }
    normalized.reload = reload;
  }

  const stop = normalizePluginAction(source.stop, 'actions.stop', errors);
  if (stop) {
    if (!stop.command) {
      errors.push(configError('missing_plugin_stop_command', 'actions.stop.command', 'plugin stop action 的 command 不能为空'));
    }
    if (stop.type !== 'command') {
      errors.push(configError('invalid_plugin_stop_type', 'actions.stop.type', 'plugin stop action 仅支持 command 类型'));
    }
    normalized.stop = stop;
  }

  return normalized;
}

function normalizeOptions(value, errors) {
  const parsed = parseJsonMaybe(value, {});
  if (parsed === undefined || parsed === null || parsed === '') return { cwd: '', env: {} };
  if (!isPlainObject(parsed)) {
    errors.push(configError('invalid_options', 'options', 'options 必须是对象'));
    return { cwd: '', env: {} };
  }

  const options = {
    cwd: trimText(parsed.cwd),
    env: {},
  };

  if (parsed.env !== undefined && parsed.env !== null && parsed.env !== '') {
    if (!isPlainObject(parsed.env)) {
      errors.push(configError('invalid_options_env', 'options.env', 'options.env 必须是键值对象'));
    } else {
      const env = {};
      for (const [key, rawValue] of Object.entries(parsed.env)) {
        const envKey = trimText(key);
        if (!envKey) {
          errors.push(configError('invalid_options_env_key', 'options.env', 'options.env 不能包含空键'));
          continue;
        }
        env[envKey] = rawValue === undefined || rawValue === null ? '' : String(rawValue);
      }
      options.env = env;
    }
  }

  return options;
}

function normalizeGroup(value, errors) {
  const parsed = parseJsonMaybe(value, null);
  if (parsed === undefined || parsed === null || parsed === '') return { kind: null, isDefault: false };
  if (typeof parsed === 'string') {
    const kind = trimText(parsed);
    return { kind: kind || null, isDefault: false };
  }
  if (!isPlainObject(parsed)) {
    errors.push(configError('invalid_group', 'group', 'group 必须是字符串或对象'));
    return { kind: null, isDefault: false };
  }
  const kind = trimText(parsed.kind);
  return {
    kind: kind || null,
    isDefault: normalizeBoolean(parsed.isDefault ?? parsed.is_default ?? false),
  };
}

function normalizePresentation(value, errors) {
  const parsed = parseJsonMaybe(value, {});
  if (parsed === undefined || parsed === null || parsed === '') return {};
  if (!isPlainObject(parsed)) {
    errors.push(configError('invalid_presentation', 'presentation', 'presentation 必须是对象'));
    return {};
  }

  const out = {};
  copyEnum(parsed, out, 'reveal', PRESENTATION_REVEAL, errors, 'presentation.reveal');
  copyEnum(parsed, out, 'panel', PRESENTATION_PANEL, errors, 'presentation.panel');
  copyEnum(parsed, out, 'revealProblems', PRESENTATION_REVEAL_PROBLEMS, errors, 'presentation.revealProblems');
  for (const key of ['echo', 'focus', 'showReuseMessage', 'clear', 'close']) {
    if (Object.prototype.hasOwnProperty.call(parsed, key)) out[key] = normalizeBoolean(parsed[key]);
  }
  return out;
}

function copyEnum(source, target, key, allowed, errors, field) {
  if (!Object.prototype.hasOwnProperty.call(source, key)) return;
  const value = trimText(source[key]);
  if (!allowed.has(value)) {
    errors.push(configError('invalid_presentation_value', field, `${field} 取值无效`, { value }));
    return;
  }
  target[key] = value;
}

function normalizeDependsOn(value, errors) {
  const parsed = parseJsonMaybe(value, []);
  if (parsed === undefined || parsed === null || parsed === '') return [];
  const rawList = Array.isArray(parsed) ? parsed : [parsed];
  const dependsOn = [];
  rawList.forEach((entry, index) => {
    if (typeof entry !== 'string' && typeof entry !== 'number' && typeof entry !== 'boolean') {
      errors.push(configError('invalid_depends_on', `dependsOn[${index}]`, 'dependsOn 只能包含非空 label'));
      return;
    }
    const label = trimText(entry);
    if (!label) {
      errors.push(configError('invalid_depends_on', `dependsOn[${index}]`, 'dependsOn 只能包含非空 label'));
      return;
    }
    if (!dependsOn.includes(label)) dependsOn.push(label);
  });
  return dependsOn;
}

function cloneJsonValue(value, field, errors) {
  const parsed = parseJsonMaybe(value, null);
  if (parsed === undefined) return null;
  try {
    return parsed === null ? null : JSON.parse(JSON.stringify(parsed));
  } catch {
    errors.push(configError('invalid_json_value', field, `${field} 必须是可 JSON 序列化的值`));
    return null;
  }
}

function parseJsonMaybe(value, fallback) {
  if (typeof value !== 'string') return value === undefined ? fallback : value;
  const text = value.trim();
  if (!text) return fallback;
  if (!/^[\[{"]|^-?\d|^(true|false|null)$/i.test(text)) return value;
  try {
    return JSON.parse(text);
  } catch {
    return value;
  }
}

function groupFromFlatFields(source) {
  if (!isPlainObject(source)) return undefined;
  const kind = firstDefined(pick(source, 'groupKind', 'group_kind'), undefined);
  const isDefault = firstDefined(pick(source, 'groupIsDefault', 'group_is_default'), undefined);
  if (kind === undefined && isDefault === undefined) return undefined;
  return { kind, isDefault };
}

function configError(code, field, message, details = null) {
  return { code, field, message, ...(details ? { details } : {}) };
}

function importError(index, label, error) {
  return {
    index,
    label,
    code: error.code,
    field: error.field,
    message: error.message,
    ...(error.details ? { details: error.details } : {}),
  };
}

function pick(source, ...keys) {
  if (!isPlainObject(source)) return undefined;
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(source, key)) return source[key];
  }
  return undefined;
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined);
}

function trimText(value) {
  return typeof value === 'string' ? value.trim() : (value === undefined || value === null ? '' : String(value).trim());
}

function normalizeBoolean(value) {
  if (value === undefined || value === null || value === '') return false;
  if (value === false || value === 0) return false;
  const normalized = String(value).trim().toLowerCase();
  return !['0', 'false', 'off', 'no', 'disabled'].includes(normalized);
}

function normalizeInteger(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.floor(number) : fallback;
}

function labelSet(labels) {
  if (labels instanceof Set) return new Set([...labels].map((label) => String(label)));
  if (Array.isArray(labels)) return new Set(labels.map((label) => String(label)));
  if (labels && typeof labels[Symbol.iterator] === 'function') return new Set([...labels].map((label) => String(label)));
  return new Set();
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

module.exports = {
  DEBUG_ONLY_FIELDS,
  DEPENDS_ORDERS,
  EXECUTOR_TYPES,
  PLUGIN_ACTION_TYPES,
  PLUGIN_ACTION_NAMES,
  ExecutorConfigError,
  debugOnlyFields,
  normalizeExecutorConfig,
  normalizePluginAction,
  normalizeTasksJson,
  uniqueExecutorLabel,
  validateExecutorConfig,
  validatePluginActions,
};
