const FINAL_ACCEPTANCE_TITLE = '完整验收';
const UNKNOWN_SCOPE = 'unknown';
const VALIDATION_SCOPE = 'validation';
const FINAL_ACCEPTANCE_RE = /完整验收|整体验收|总体验收|最终验收|完整验证|最终验证|acceptance|validation/i;
const SCOPE_SPLIT_RE = /[,，、;；]+/;
const TASK_KEY_PREFIX_RE = /^\s*(?:[-*]\s+\[[ xX]?\]\s*)?(?:P\d+|[A-Za-z]+[-_]?\d+)\s*[:：.\-\s]+\s*/;

const PLAN_SPEC_SCHEMA = Object.freeze({
  type: 'object',
  required: ['title', 'summary', 'tasks', 'finalValidation'],
  properties: {
    title: { type: 'string', minLength: 1 },
    summary: { type: 'string', minLength: 1 },
    tasks: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['title'],
        properties: {
          title: { type: 'string', minLength: 1 },
          scope: { type: 'array', items: { type: 'string' } },
          acceptance: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    finalValidation: {
      type: 'object',
      required: ['command', 'criteria'],
      properties: {
        command: { type: 'string', minLength: 1 },
        criteria: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } },
      },
    },
  },
});

class PlanSpecValidationError extends Error {
  constructor(errors) {
    const messages = Array.isArray(errors) ? errors : [String(errors || 'PlanSpec 无效')];
    super(messages.join('; '));
    this.name = 'PlanSpecValidationError';
    this.errors = messages;
  }
}

function validatePlanSpec(spec) {
  const errors = collectPlanSpecErrors(spec);
  return {
    valid: errors.length === 0,
    errors,
  };
}

function assertValidPlanSpec(spec) {
  const validation = validatePlanSpec(spec);
  if (!validation.valid) throw new PlanSpecValidationError(validation.errors);
  return true;
}

function normalizePlanSpec(spec) {
  assertValidPlanSpec(spec);
  const finalValidation = normalizeFinalValidation(spec.finalValidation);
  const normalizedTasks = spec.tasks.map((task, index) => normalizePlanSpecTask(task, index));
  return ensureFinalAcceptanceTask({
    title: cleanInlineText(spec.title),
    summary: cleanBlockText(spec.summary),
    tasks: normalizedTasks,
    finalValidation,
  });
}

function normalizePlanSpecResult(spec) {
  try {
    return { ok: true, spec: normalizePlanSpec(spec), errors: [] };
  } catch (error) {
    if (error instanceof PlanSpecValidationError) {
      return { ok: false, spec: null, errors: error.errors };
    }
    return { ok: false, spec: null, errors: [error?.message || String(error)] };
  }
}

function parsePlanSpecJson(content) {
  const text = String(content || '').trim();
  if (!text) throw new PlanSpecValidationError(['$: JSON 内容为空']);
  try {
    return JSON.parse(text);
  } catch (firstError) {
    const jsonText = extractJsonObjectText(text);
    if (!jsonText) throw new PlanSpecValidationError([`$: JSON 无效：${firstError.message}`]);
    try {
      return JSON.parse(jsonText);
    } catch (error) {
      throw new PlanSpecValidationError([`$: JSON 无效：${error.message}`]);
    }
  }
}

function extractJsonObjectText(text) {
  const source = String(text || '').trim();
  const fenceMatch = source.match(/```(?:json|JSON)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    const fenced = fenceMatch[1].trim();
    try {
      JSON.parse(fenced);
      return fenced;
    } catch (_) {
      // 继续尝试从完整文本中提取平衡 JSON 对象。
    }
  }

  for (let start = source.indexOf('{'); start !== -1; start = source.indexOf('{', start + 1)) {
    const candidate = balancedJsonObjectText(source, start);
    if (!candidate) continue;
    try {
      JSON.parse(candidate);
      return candidate;
    } catch (_) {
      // 当前对象片段不是合法 JSON，继续查找下一个对象起点。
    }
  }
  return '';
}

function balancedJsonObjectText(source, startIndex) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = startIndex; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(startIndex, index + 1);
    }
  }
  return '';
}

function collectPlanSpecErrors(spec) {
  const errors = [];
  if (!isPlainObject(spec)) return ['$: PlanSpec 必须是对象'];

  requireNonEmptyString(spec.title, '$.title', errors);
  requireNonEmptyString(spec.summary, '$.summary', errors);

  if (!Array.isArray(spec.tasks)) {
    errors.push('$.tasks: 必须是数组');
  } else if (spec.tasks.length === 0) {
    errors.push('$.tasks: 至少需要 1 个任务');
  } else {
    spec.tasks.forEach((task, index) => collectTaskErrors(task, index, errors));
  }

  collectFinalValidationErrors(spec.finalValidation, errors);
  return errors;
}

function collectTaskErrors(task, index, errors) {
  const path = `$.tasks[${index}]`;
  if (!isPlainObject(task)) {
    errors.push(`${path}: 必须是对象`);
    return;
  }
  requireNonEmptyString(task.title, `${path}.title`, errors);
  if (task.scope !== undefined && !Array.isArray(task.scope)) {
    errors.push(`${path}.scope: 必须是字符串数组`);
  } else if (Array.isArray(task.scope)) {
    task.scope.forEach((item, itemIndex) => {
      if (typeof item !== 'string') errors.push(`${path}.scope[${itemIndex}]: 必须是字符串`);
    });
  }
  if (task.acceptance !== undefined && !Array.isArray(task.acceptance)) {
    errors.push(`${path}.acceptance: 必须是字符串数组`);
  } else if (Array.isArray(task.acceptance)) {
    task.acceptance.forEach((item, itemIndex) => {
      if (typeof item !== 'string') errors.push(`${path}.acceptance[${itemIndex}]: 必须是字符串`);
    });
  }
}

function collectFinalValidationErrors(finalValidation, errors) {
  if (!isPlainObject(finalValidation)) {
    errors.push('$.finalValidation: 必须是对象');
    return;
  }
  requireNonEmptyString(finalValidation.command, '$.finalValidation.command', errors);
  if (!Array.isArray(finalValidation.criteria)) {
    errors.push('$.finalValidation.criteria: 必须是字符串数组');
  } else if (finalValidation.criteria.length === 0) {
    errors.push('$.finalValidation.criteria: 至少需要 1 条验收标准');
  } else {
    finalValidation.criteria.forEach((item, index) => {
      if (typeof item !== 'string') errors.push(`$.finalValidation.criteria[${index}]: 必须是字符串`);
      else if (!cleanInlineText(item)) errors.push(`$.finalValidation.criteria[${index}]: 不能为空`);
    });
  }
}

function requireNonEmptyString(value, path, errors) {
  if (typeof value !== 'string') {
    errors.push(`${path}: 必须是非空字符串`);
    return;
  }
  if (!cleanInlineText(value)) errors.push(`${path}: 不能为空`);
}

function normalizePlanSpecTask(task, index) {
  const title = cleanTaskTitle(task.title) || `任务 ${index + 1}`;
  return {
    title,
    scope: normalizeScopeList(task.scope),
    acceptance: normalizeAcceptanceList(task.acceptance),
  };
}

function normalizeFinalValidation(finalValidation) {
  return {
    command: cleanInlineText(finalValidation.command),
    criteria: normalizeAcceptanceList(finalValidation.criteria),
  };
}

function ensureFinalAcceptanceTask(spec) {
  const tasks = [];
  let finalTask = null;
  for (const task of spec.tasks) {
    if (isFinalAcceptanceTask(task)) {
      finalTask = task;
    } else {
      tasks.push(task);
    }
  }
  tasks.push(normalizeFinalAcceptanceTask(finalTask, spec.finalValidation));
  return { ...spec, tasks };
}

function normalizeFinalAcceptanceTask(task, finalValidation) {
  const base = task || {};
  const title = isFinalAcceptanceTask(base) ? (cleanTaskTitle(base.title) || FINAL_ACCEPTANCE_TITLE) : FINAL_ACCEPTANCE_TITLE;
  const scope = normalizeScopeList([...(Array.isArray(base.scope) ? base.scope : []), VALIDATION_SCOPE])
    .filter((item, index, items) => item !== UNKNOWN_SCOPE || items.length === 1 || index === items.length - 1);
  const acceptance = normalizeAcceptanceList([
    ...(Array.isArray(base.acceptance) ? base.acceptance : []),
    `最终验收命令为 ${finalValidation.command}`,
    ...finalValidation.criteria,
  ]);
  return {
    title,
    scope: ensureValidationScope(scope),
    acceptance,
  };
}

function ensureValidationScope(scope) {
  const normalized = normalizeScopeList(scope).filter((item) => item !== UNKNOWN_SCOPE);
  if (!normalized.some((item) => item.toLowerCase() === VALIDATION_SCOPE)) normalized.push(VALIDATION_SCOPE);
  return normalized.length ? normalized : [VALIDATION_SCOPE];
}

function normalizeScopeList(scope) {
  const parts = [];
  if (Array.isArray(scope)) {
    for (const item of scope) {
      for (const part of String(item || '').split(SCOPE_SPLIT_RE)) parts.push(normalizeScopeItem(part));
    }
  }
  const unique = uniqueNonEmpty(parts);
  return unique.length ? unique : [UNKNOWN_SCOPE];
}

function normalizeScopeItem(value) {
  const text = cleanInlineText(value)
    .replace(/^["'`[{(]+|["'`\]})]+$/g, '')
    .replaceAll('\\', '/')
    .replace(/\s*--$/, '')
    .trim();
  if (!text || text === '-') return '';
  return text.toLowerCase() === UNKNOWN_SCOPE ? UNKNOWN_SCOPE : text;
}

function normalizeAcceptanceList(values) {
  if (!Array.isArray(values)) return [];
  return uniqueNonEmpty(values.map((item) => cleanInlineText(item)));
}

function cleanTaskTitle(value) {
  return cleanInlineText(value).replace(TASK_KEY_PREFIX_RE, '').trim();
}

function cleanInlineText(value) {
  return String(value || '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanBlockText(value) {
  return String(value || '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

function uniqueNonEmpty(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const text = String(value || '').trim();
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(text);
  }
  return result;
}

function isFinalAcceptanceTask(task) {
  if (!task) return false;
  if (FINAL_ACCEPTANCE_RE.test(String(task.title || ''))) return true;
  return Array.isArray(task.scope) && task.scope.some((scope) => String(scope || '').trim().toLowerCase() === VALIDATION_SCOPE);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

module.exports = {
  FINAL_ACCEPTANCE_RE,
  FINAL_ACCEPTANCE_TITLE,
  PLAN_SPEC_SCHEMA,
  PlanSpecValidationError,
  UNKNOWN_SCOPE,
  VALIDATION_SCOPE,
  assertValidPlanSpec,
  cleanBlockText,
  cleanInlineText,
  cleanTaskTitle,
  isFinalAcceptanceTask,
  normalizePlanSpec,
  normalizePlanSpecResult,
  normalizeScopeList,
  parsePlanSpecJson,
  validatePlanSpec,
};
