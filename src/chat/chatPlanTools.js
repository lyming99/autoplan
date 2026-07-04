'use strict';

const CREATE_PLAN_TOOL_STRICT = true;

const CREATE_PLAN_RENDERING_SPEC = Object.freeze({
  taskSectionHeading: '## 任务拆解',
  taskLineFormat: '- [ ] P001: 任务标题 <!-- scope: src/file.js -->',
  numbering: '任务编号由后端统一按 P001、P002 连续生成，不使用模型传入的编号。',
  acceptance: '每个任务后必须缩进输出验收要点，验收要点不得使用 checkbox。',
  validation: '最后一个任务必须为“完整验收”，scope 必须为 validation；缺失时自动追加，位置错误时移动到最后。',
});

const TASK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: {
      type: 'string',
      minLength: 1,
      description: '开发任务标题。不要包含 P001 等编号，编号会由后端生成。',
    },
    scope: {
      type: 'string',
      minLength: 1,
      description: '任务预计修改的文件或模块；多个 scope 使用英文逗号分隔。无法判断时填写 unknown。',
    },
    acceptancePoints: {
      type: 'array',
      minItems: 1,
      description: '该任务的验收要点。只写普通文本，不要写 checkbox。',
      items: { type: 'string', minLength: 1 },
    },
    details: {
      type: 'string',
      description: '可选的实现说明或约束。不要包含任务编号。',
    },
  },
  required: ['title', 'scope', 'acceptancePoints'],
};

const OVERALL_ACCEPTANCE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    commands: {
      type: 'array',
      minItems: 1,
      description: '最终验收阶段要执行的命令，例如 npm test、npm run check、npm run build。',
      items: { type: 'string', minLength: 1 },
    },
    scope: {
      type: 'string',
      minLength: 1,
      description: '最终验收覆盖范围。',
    },
    passCriteria: {
      type: 'array',
      minItems: 1,
      description: '最终验收通过标准。',
      items: { type: 'string', minLength: 1 },
    },
  },
  required: ['commands', 'scope', 'passCriteria'],
};

const PROGRESS_ITEM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    label: { type: 'string', minLength: 1, description: '进度项名称。' },
    status: { type: 'string', minLength: 1, description: '进度项状态。' },
  },
  required: ['label', 'status'],
};

const CREATE_PLAN_TOOL_SCHEMA = deepFreeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    title: {
      type: 'string',
      minLength: 1,
      description: '计划标题，会渲染为 markdown 一级标题。',
    },
    summary: {
      type: 'string',
      minLength: 1,
      description: '需求概要或目标说明，会渲染到“需求概述”。',
    },
    context: {
      type: 'string',
      description: '可选的现状分析、约束或背景，会渲染到“现状分析”。',
    },
    tasks: {
      type: 'array',
      minItems: 1,
      description: '至少一个开发任务。可以包含完整验收任务，但后端会规范化到最后。',
      items: TASK_SCHEMA,
    },
    overallAcceptance: OVERALL_ACCEPTANCE_SCHEMA,
    progress: {
      type: 'array',
      description: '可选进度区状态项；未提供时由后端按任务编号生成待执行进度。',
      items: PROGRESS_ITEM_SCHEMA,
    },
    status: {
      type: 'string',
      enum: ['pending', 'draft'],
      description: '计划状态。未提供时默认为 pending。',
    },
  },
  required: ['title', 'summary', 'tasks', 'overallAcceptance'],
});

class CreatePlanRenderError extends Error {
  constructor(message, code = 'INVALID_CREATE_PLAN_INPUT') {
    super(message);
    this.name = 'CreatePlanRenderError';
    this.code = code;
  }
}

function renderCreatePlanMarkdown(input) {
  const normalized = normalizeCreatePlanForRendering(input);
  const lines = [
    `# ${normalized.title}`,
    '',
    '## 需求概述',
    normalized.summary,
    '',
    '## 现状分析',
    normalized.context || '由对话直接创建计划，未提供额外现状分析。',
    '',
    CREATE_PLAN_RENDERING_SPEC.taskSectionHeading,
    '',
  ];

  normalized.tasks.forEach((task) => {
    lines.push(`- [ ] ${task.key}: ${task.title} <!-- scope: ${task.scope} -->`);
    if (task.details) lines.push(`  - 说明：${task.details}`);
    lines.push('  - 验收要点：');
    task.acceptancePoints.forEach((point) => lines.push(`    - ${point}`));
  });

  lines.push(
    '',
    '## 总体验收标准',
    `最终验收命令为：${normalized.overallAcceptance.commands.join('、')}。`,
    '',
    `验收范围：${normalized.overallAcceptance.scope}`,
    '',
    '通过标准：',
  );
  normalized.overallAcceptance.passCriteria.forEach((criterion, index) => {
    lines.push(`${index + 1}. ${criterion}`);
  });

  lines.push('', '## 进度区');
  normalized.progress.forEach((item) => {
    lines.push(`- ${item.label}：${item.status}`);
  });
  lines.push('');

  return {
    markdown: lines.join('\n'),
    title: normalized.title,
    status: normalized.status,
    tasks: normalized.tasks,
    totalTasks: normalized.tasks.length,
  };
}

function normalizeCreatePlanForRendering(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new CreatePlanRenderError('create_plan 入参必须是对象');
  }

  const title = normalizeInlineText(input.title);
  if (!title) throw new CreatePlanRenderError('缺少 title');

  const summary = normalizeBlockText(input.summary);
  if (!summary) throw new CreatePlanRenderError('缺少 summary');

  const rawTasks = Array.isArray(input.tasks) ? input.tasks : [];
  if (rawTasks.length < 1) throw new CreatePlanRenderError('tasks 至少包含一个开发任务');

  const developmentTasks = [];
  const validationAcceptancePoints = [];
  let validationDetails = '';

  rawTasks.forEach((rawTask, index) => {
    const task = normalizeTask(rawTask, index + 1);
    if (isValidationTask(task)) {
      validationDetails = validationDetails || task.details;
      validationAcceptancePoints.push(...task.acceptancePoints);
      return;
    }
    developmentTasks.push(task);
  });

  if (developmentTasks.length < 1) {
    throw new CreatePlanRenderError('tasks 至少包含一个非完整验收的开发任务');
  }

  const overallAcceptance = normalizeOverallAcceptance(input.overallAcceptance);
  const validationTask = buildValidationTask(overallAcceptance, validationAcceptancePoints, validationDetails);
  const tasks = [...developmentTasks, validationTask].map((task, index) => ({
    ...task,
    key: `P${String(index + 1).padStart(3, '0')}`,
  }));

  return {
    title,
    summary,
    context: normalizeBlockText(input.context),
    status: normalizePlanStatus(input.status),
    overallAcceptance,
    tasks,
    progress: normalizeProgress(input.progress, tasks),
  };
}

function normalizeTask(rawTask, order) {
  if (!rawTask || typeof rawTask !== 'object' || Array.isArray(rawTask)) {
    throw new CreatePlanRenderError(`第 ${order} 个任务必须是对象`);
  }

  const title = normalizeTaskTitle(rawTask.title);
  if (!title) throw new CreatePlanRenderError(`第 ${order} 个任务缺少 title`);

  const scope = normalizeScope(rawTask.scope);
  if (!scope) throw new CreatePlanRenderError(`第 ${order} 个任务缺少 scope`);

  const acceptancePoints = normalizeTextList(rawTask.acceptancePoints);
  if (acceptancePoints.length < 1) {
    throw new CreatePlanRenderError(`第 ${order} 个任务缺少 acceptancePoints`);
  }

  return {
    title,
    scope,
    acceptancePoints,
    details: normalizeInlineText(rawTask.details),
  };
}

function buildValidationTask(overallAcceptance, explicitPoints, details) {
  const points = [
    `最终验收命令：${overallAcceptance.commands.join('、')}`,
    `验收范围：${overallAcceptance.scope}`,
    ...overallAcceptance.passCriteria.map((criterion) => `通过标准：${criterion}`),
    ...explicitPoints,
  ];

  return {
    title: '完整验收',
    scope: 'validation',
    acceptancePoints: uniqueNonEmpty(points),
    details: normalizeInlineText(details),
  };
}

function normalizeOverallAcceptance(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CreatePlanRenderError('缺少 overallAcceptance');
  }

  const commands = normalizeTextList(value.commands);
  if (commands.length < 1) throw new CreatePlanRenderError('overallAcceptance.commands 至少包含一条命令');

  const scope = normalizeInlineText(value.scope);
  if (!scope) throw new CreatePlanRenderError('缺少 overallAcceptance.scope');

  const passCriteria = normalizeTextList(value.passCriteria);
  if (passCriteria.length < 1) throw new CreatePlanRenderError('overallAcceptance.passCriteria 至少包含一条标准');

  return { commands, scope, passCriteria };
}

function normalizeProgress(progress, tasks) {
  if (Array.isArray(progress) && progress.length > 0) {
    return progress
      .map((item) => ({
        label: normalizeInlineText(item?.label),
        status: normalizeInlineText(item?.status),
      }))
      .filter((item) => item.label && item.status)
      .map((item) => ({ label: item.label, status: item.status.endsWith('。') ? item.status : `${item.status}。` }));
  }

  const generated = [{ label: '对话创建', status: '已完成。' }];
  tasks.forEach((task) => generated.push({ label: task.key, status: '待执行。' }));
  return generated;
}

function normalizeTextList(value) {
  const source = Array.isArray(value) ? value : [value];
  return uniqueNonEmpty(source.flatMap((item) => splitMultilineText(item).map(normalizeBulletText)));
}

function uniqueNonEmpty(values) {
  const seen = new Set();
  const result = [];
  values.forEach((value) => {
    const text = normalizeInlineText(value);
    if (!text || seen.has(text)) return;
    seen.add(text);
    result.push(text);
  });
  return result;
}

function splitMultilineText(value) {
  return String(value ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function normalizeTaskTitle(value) {
  return normalizeInlineText(value)
    .replace(/\s*<!--[\s\S]*?-->\s*/g, ' ')
    .replace(/^\s*[-*+]\s+\[[ xX]\]\s+/, '')
    .replace(/^\s*P\d+\s*[:：.\-、)]\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeScope(value) {
  const raw = String(value ?? '')
    .replace(/\s*<!--[\s\S]*?-->\s*/g, ' ')
    .replace(/[<>]/g, '')
    .replace(/--+/g, '-')
    .replaceAll('\\', '/');
  const parts = raw
    .split(/[,，、;；]+/)
    .map((part) => normalizeInlineText(part))
    .filter(Boolean);
  return uniqueNonEmpty(parts).join(', ');
}

function normalizeBulletText(value) {
  return normalizeInlineText(value)
    .replace(/^\s*[-*+]\s+\[[ xX]\]\s+/, '')
    .replace(/^\s*[-*+]\s+/, '')
    .replace(/^\s*\d+[.)、]\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeInlineText(value) {
  return String(value ?? '')
    .replace(/\r?\n+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeBlockText(value) {
  return String(value ?? '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

function isValidationTask(task) {
  const scopes = String(task.scope || '').toLowerCase().split(/[,，、;；]+/).map((part) => part.trim());
  return scopes.includes('validation') || /完整验收|整体验收|总体验收|最终验收|完整验证|最终验证|acceptance|validation/i.test(task.title);
}

function normalizePlanStatus(value) {
  return String(value || '').trim() === 'draft' ? 'draft' : 'pending';
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  Object.values(value).forEach(deepFreeze);
  return value;
}

module.exports = {
  CREATE_PLAN_RENDERING_SPEC,
  CREATE_PLAN_TOOL_SCHEMA,
  CREATE_PLAN_TOOL_STRICT,
  CreatePlanRenderError,
  normalizeCreatePlanForRendering,
  renderCreatePlanMarkdown,
};
