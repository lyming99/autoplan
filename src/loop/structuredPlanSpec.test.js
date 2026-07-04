const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { renderPlanSpecMarkdown } = require('./planRenderer');
const {
  FINAL_ACCEPTANCE_TITLE,
  PlanSpecValidationError,
  UNKNOWN_SCOPE,
  VALIDATION_SCOPE,
  assertValidPlanSpec,
  normalizePlanSpec,
  normalizePlanSpecResult,
  parsePlanSpecJson,
} = require('./structuredPlanSpec');

describe('structuredPlanSpec normalization and rendering', () => {
  it('normalizes a valid spec, strips manual task numbers, appends final acceptance, and renders deterministic Markdown', () => {
    const spec = validPlanSpec({
      tasks: [
        {
          title: 'P007: 编写核心实现',
          scope: ['src/core.js'],
          acceptance: ['核心流程可用'],
        },
        {
          title: '接入调用方',
          scope: ['src/service.js', 'src/controller.js'],
          acceptance: ['调用链保持兼容'],
        },
      ],
    });

    const normalized = normalizePlanSpec(spec);
    assert.equal(normalized.tasks.length, 3, '应追加完整验收任务');
    assert.equal(normalized.tasks[0].title, '编写核心实现');
    assert.equal(normalized.tasks[2].title, FINAL_ACCEPTANCE_TITLE);
    assert.deepEqual(normalized.tasks[2].scope, [VALIDATION_SCOPE]);
    assert.ok(normalized.tasks[2].acceptance.some((item) => item.includes('npm test')));

    const markdown = renderPlanSpecMarkdown(normalized, { normalized: true });
    assert.match(markdown, /- \[ \] P001: 编写核心实现 <!-- scope: src\/core\.js -->/);
    assert.match(markdown, /- \[ \] P002: 接入调用方 <!-- scope: src\/service\.js,src\/controller\.js -->/);
    assert.match(markdown, new RegExp(`- \\[ \\] P003: ${FINAL_ACCEPTANCE_TITLE} <!-- scope: ${VALIDATION_SCOPE} -->`));
    assert.doesNotMatch(markdown, /P007:/);
    assert.ok(markdown.includes('npm test'), '渲染结果应包含最终验收命令');
  });

  it('normalizes an existing final acceptance task instead of duplicating it', () => {
    const normalized = normalizePlanSpec(validPlanSpec({
      tasks: [
        {
          title: '实现业务逻辑',
          scope: ['src/service.js'],
          acceptance: ['业务逻辑完成'],
        },
        {
          title: '完整验收',
          scope: ['docs/plan.md'],
          acceptance: ['保留人工补充的验收说明'],
        },
      ],
    }));

    assert.equal(normalized.tasks.length, 2);
    assert.equal(normalized.tasks[1].title, '完整验收');
    assert.deepEqual(normalized.tasks[1].scope, ['docs/plan.md', VALIDATION_SCOPE]);
    assert.ok(normalized.tasks[1].acceptance.includes('保留人工补充的验收说明'));
    assert.ok(normalized.tasks[1].acceptance.some((item) => item.includes('npm test')));
  });

  it('fills unknown scope for ordinary tasks and validation scope for final acceptance', () => {
    const normalized = normalizePlanSpec(validPlanSpec({
      tasks: [
        {
          title: '梳理影响范围',
          acceptance: ['无法判断时使用 unknown'],
        },
      ],
    }));

    assert.deepEqual(normalized.tasks[0].scope, [UNKNOWN_SCOPE]);
    assert.deepEqual(normalized.tasks[1].scope, [VALIDATION_SCOPE]);
  });

  it('reports malformed specs with path-specific errors and throws PlanSpecValidationError', () => {
    const result = normalizePlanSpecResult({
      title: '',
      summary: '缺少合法任务和最终验收',
      tasks: [
        {
          title: '坏任务',
          scope: 'src/bad.js',
          acceptance: ['x'],
        },
      ],
      finalValidation: {
        command: '',
        criteria: [],
      },
    });

    assert.equal(result.ok, false);
    assert.ok(result.errors.some((message) => message.includes('$.title')));
    assert.ok(result.errors.some((message) => message.includes('$.tasks[0].scope')));
    assert.ok(result.errors.some((message) => message.includes('$.finalValidation.command')));
    assert.throws(
      () => assertValidPlanSpec(result.spec),
      PlanSpecValidationError,
    );
  });

  it('parses fenced or balanced JSON and rejects malformed JSON', () => {
    const spec = validPlanSpec();
    const fenced = [
      '生成结果如下：',
      '```json',
      JSON.stringify(spec),
      '```',
    ].join('\n');
    const balanced = `prefix ${JSON.stringify(spec)} suffix`;

    assert.equal(parsePlanSpecJson(fenced).title, spec.title);
    assert.equal(parsePlanSpecJson(balanced).finalValidation.command, 'npm test');
    assert.throws(
      () => parsePlanSpecJson('```json\n{ bad json }\n```'),
      PlanSpecValidationError,
    );
  });
});

function validPlanSpec(overrides = {}) {
  return {
    title: '结构化计划',
    summary: '覆盖结构化计划生成链路',
    tasks: [
      {
        title: '扩展数据结构',
        scope: ['src/database.js'],
        acceptance: ['新字段可保存'],
      },
    ],
    finalValidation: {
      command: 'npm test',
      criteria: ['所有后端测试通过'],
    },
    ...overrides,
  };
}
