export {};

type TestRegistrar = (name: string, fn: () => void) => void;

declare function require(id: string): unknown;
declare const process: { cwd(): string };

const { describe, it } = require('node:test') as { describe: TestRegistrar; it: TestRegistrar };
const { readFileSync } = require('node:fs') as { readFileSync: (path: string, encoding: string) => string };
const { join } = require('node:path') as { join: (...parts: string[]) => string };

function expect(condition: unknown, message: string) {
  if (!condition) throw new Error(message);
}

function source(...parts: string[]) {
  return readFileSync(join(process.cwd(), ...parts), 'utf8');
}

function expectIncludes(sourceText: string, snippet: string, message: string) {
  expect(sourceText.includes(snippet), message);
}

function expectCountExactly(sourceText: string, snippet: string, expected: number, message: string) {
  const count = sourceText.split(snippet).length - 1;
  expect(count === expected, `${message} (expected ${expected}, got ${count})`);
}

function sliceBetween(sourceText: string, startNeedle: string, endNeedle: string, message: string) {
  const start = sourceText.indexOf(startNeedle);
  expect(start >= 0, message);
  const end = sourceText.indexOf(endNeedle, start);
  expect(end >= 0, message);
  return sourceText.slice(start, end + endNeedle.length);
}

describe('Composer plan generation override contract', () => {
  it('defines submit payload fields for generation overrides only', () => {
    const composer = source('src', 'renderer', 'components', 'Composer.tsx');
    const payload = sliceBetween(
      composer,
      'export interface ComposerSubmitPayload {',
      'function getClipboardImageFiles',
      '应能定位 ComposerSubmitPayload 接口',
    );

    expectIncludes(payload, 'planGenerationStrategy?: PlanGenerationInputFields[\'planGenerationStrategy\'];', '提交 payload 应允许覆盖生成策略');
    expectIncludes(payload, 'planGenerationProvider?: PlanGenerationInputFields[\'planGenerationProvider\'];', '提交 payload 应允许覆盖生成 Provider');
    expectIncludes(payload, 'planGenerationCommand?: PlanGenerationInputFields[\'planGenerationCommand\'];', '提交 payload 应允许覆盖外部生成命令');
    expectIncludes(payload, 'planGenerationModel?: PlanGenerationInputFields[\'planGenerationModel\'];', '提交 payload 应允许覆盖内置生成模型');
    expectIncludes(payload, 'planGenerationCodexReasoningEffort?: PlanGenerationInputFields[\'planGenerationCodexReasoningEffort\'];', '提交 payload 应允许覆盖生成 Codex 思考深度');
    expect(!payload.includes('planExecution'), 'Composer 提交 payload 不应包含任务执行覆盖字段');
  });

  it('submits only planGenerationInputFromComposerSelection output when custom controls are present', () => {
    const composer = source('src', 'renderer', 'components', 'Composer.tsx');
    const submitBlock = sliceBetween(
      composer,
      'const submit = async (event: FormEvent<HTMLFormElement>) => {',
      'const addFiles =',
      '应能定位 Composer submit 逻辑',
    );

    expectIncludes(submitBlock, '...planGenerationInputFromComposerSelection(selectedGeneration),', 'Composer 应只展开生成配置归一化结果');
    expectIncludes(submitBlock, ': createAsDraft ? { body: value, createAsDraft } : value;', '缺少配置上下文时应保持旧字符串/草稿 payload 兼容');
    expect(!submitBlock.includes('planExecution'), 'Composer submit 逻辑不应构造执行覆盖字段');
  });

  it('renders builtin model and external command inputs as a single mutually exclusive control', () => {
    const composer = source('src', 'renderer', 'components', 'Composer.tsx');

    expectIncludes(composer, 'const isBuiltinGeneration = isBuiltinPlanGenerationStrategy(selectedStrategy);', 'Composer 应按生成策略判断内置 LLM');
    expectIncludes(composer, 'const backendValueLabel = isBuiltinGeneration', 'Composer 应以同一后端值摘要切换模型/命令');
    expectIncludes(composer, "aria-label=\"选择计划生成策略\"", 'Composer 应暴露生成策略选择器');
    expectIncludes(composer, "aria-label=\"选择计划生成 Provider\"", 'Composer 应暴露生成 Provider 选择器');
    expectIncludes(composer, "aria-label={isBuiltinGeneration ? '计划生成模型' : '计划生成命令'}", '同一个输入应按策略显示模型或命令标签');
    expectIncludes(composer, 'value={isBuiltinGeneration ? selectedGeneration.model : selectedGeneration.command}', '同一个输入应按策略绑定模型或命令值');
    expectIncludes(composer, '? cliSelection.onModelChange(type, event.target.value)', '内置生成输入应只调用模型变更回调');
    expectIncludes(composer, ': cliSelection.onCommandChange(type, event.target.value)', '外部生成输入应只调用命令变更回调');
    expectIncludes(composer, 'placeholder={isBuiltinGeneration ? planBackendDefaultModel(selectedProvider) : planBackendDefaultCommand(selectedProvider)}', '输入占位符应按策略切换默认模型或默认命令');
    expectCountExactly(composer, "aria-label={isBuiltinGeneration ? '计划生成模型' : '计划生成命令'}", 1, '模型/命令应共用一个互斥输入控件');
  });

  it('keeps Composer context scoped to generation selection handlers', () => {
    const composer = source('src', 'renderer', 'components', 'Composer.tsx');
    const context = sliceBetween(
      composer,
      'interface ComposerCliSelectionValue {',
      'const ComposerCliSelectionContext',
      '应能定位 Composer 配置上下文接口',
    );

    expectIncludes(context, 'selectedByType: Record<IntakeType, ComposerPlanGenerationSelection>;', 'Composer 上下文应保存每类 intake 的生成配置选择');
    expectIncludes(context, 'onStrategyChange: (type: IntakeType, strategy: PlanGenerationStrategy) => void;', 'Composer 上下文应暴露生成策略切换');
    expectIncludes(context, 'onProviderChange: (type: IntakeType, provider: PlanBackendProvider) => void;', 'Composer 上下文应暴露生成 Provider 切换');
    expectIncludes(context, 'onCommandChange: (type: IntakeType, command: string) => void;', 'Composer 上下文应暴露外部生成命令切换');
    expectIncludes(context, 'onModelChange: (type: IntakeType, model: string) => void;', 'Composer 上下文应暴露内置生成模型切换');
    expectIncludes(context, 'onReasoningChange: (type: IntakeType, effort: CodexReasoningEffort) => void;', 'Composer 上下文应暴露生成 Codex 思考深度切换');
    expect(!context.includes('planExecution'), 'Composer 配置上下文不应包含执行方案');
  });
});
