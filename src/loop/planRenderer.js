const { normalizePlanSpec } = require('./structuredPlanSpec');

class PlanRenderError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PlanRenderError';
  }
}

function renderPlanSpecMarkdown(planSpec, options = {}) {
  const spec = options.normalized === true ? planSpec : normalizePlanSpec(planSpec);
  const lines = [
    `# ${markdownLine(spec.title)}`,
    '',
    '## 需求概要',
    '',
    markdownBlock(spec.summary),
    '',
    '## 任务拆解',
    '',
  ];

  spec.tasks.forEach((task, index) => {
    const taskKey = taskKeyForIndex(index);
    const acceptance = task.acceptance.length
      ? task.acceptance
      : ['完成该任务并满足相关需求。'];
    lines.push(`- [ ] ${taskKey}: ${markdownLine(task.title)} <!-- scope: ${scopeText(task.scope)} -->`);
    acceptance.forEach((item) => {
      lines.push(`  - 验收要点：${markdownLine(item)}`);
    });
  });

  lines.push(
    '',
    '## 总体验收标准',
    '',
    `- 最终验收命令：${markdownLine(spec.finalValidation.command)}`,
    `- 验收范围：${finalValidationScopeText(spec)}`,
    `- 通过标准：${finalValidationPassCriteriaText(spec)}`,
  );
  for (const criterion of spec.finalValidation.criteria) {
    lines.push(`- ${markdownLine(criterion)}`);
  }

  lines.push(
    '',
    '## 进度区',
    '',
  );

  const markdown = lines.join('\n');
  if (options.validate !== false) validateRenderedPlanMarkdown(markdown);
  return markdown;
}

function renderPlanSpec(planSpec, options = {}) {
  return renderPlanSpecMarkdown(planSpec, options);
}

function validateRenderedPlanMarkdown(markdown) {
  const {
    validatePlanContent,
    validatePlanTaskSequence,
  } = require('./planGeneration');
  const contentValidation = validatePlanContent(markdown);
  if (!contentValidation.valid) {
    throw new PlanRenderError(`渲染后的 plan Markdown 不合规：${contentValidation.reason}`);
  }
  const taskValidation = validatePlanTaskSequence(markdown);
  if (!taskValidation.valid) {
    throw new PlanRenderError(`渲染后的任务序列不合规：${taskValidation.reason}`);
  }
  return {
    valid: true,
    tasks: taskValidation.tasks,
  };
}

function taskKeyForIndex(index) {
  return `P${String(index + 1).padStart(3, '0')}`;
}

function scopeText(scope) {
  const scopes = Array.isArray(scope) && scope.length ? scope : ['unknown'];
  return scopes.map((item) => markdownLine(item).replace(/,/g, ' ')).join(',');
}

function finalValidationScopeText(spec) {
  const scopes = Array.from(new Set(spec.tasks.flatMap((task) => task.scope || [])));
  return scopes.length ? scopes.join('、') : 'validation';
}

function finalValidationPassCriteriaText(spec) {
  return spec.finalValidation.criteria.length
    ? '所有总体验收标准均满足。'
    : '所有自动化命令退出码为 0。';
}

function markdownLine(value) {
  return String(value || '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function markdownBlock(value) {
  return String(value || '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/\r\n/g, '\n')
    .trim();
}

module.exports = {
  PlanRenderError,
  renderPlanSpec,
  renderPlanSpecMarkdown,
  taskKeyForIndex,
  validateRenderedPlanMarkdown,
};
