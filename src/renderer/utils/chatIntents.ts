import type { IntakeType } from '../types';

/**
 * 「打开/查看 需求/反馈」意图解析结果。
 * `id` 为正整数，作为工作区定位主键；`type` 决定目标 tab 与锚点。
 */
export type OpenIntakeIntent = { type: IntakeType; id: number };

/**
 * 打开/查看类动词。按长度降序排列，避免「看一下」被「看下」前缀截断。
 * 仅强匹配（动词 + 类型名词 + 数字）才认定为打开意图，规避普通消息误伤。
 */
const OPEN_VERBS = ['打开', '查看', '看一下', '看看', '看下', '定位', '展开', '展示', '显示'];

/** 各类型对应的中英文名词（requirement 在前，避免 req 前缀截断 requirement）。 */
const INTAKE_NOUNS: Record<IntakeType, string[]> = {
  requirement: ['需求', 'requirement', 'req'],
  feedback: ['反馈', 'feedback'],
};

/** 动词 →（最多 12 字间隔）→ 类型名词 → 可选 #/＃与空格 → 数字。i 标志兼容英文大小写。 */
const REQUIREMENT_PATTERN = new RegExp(
  `(?:${OPEN_VERBS.join('|')})[\\s\\S]{0,12}?(?:${INTAKE_NOUNS.requirement.join('|')})\\s*[#＃]?\\s*(\\d+)`,
  'i',
);

const FEEDBACK_PATTERN = new RegExp(
  `(?:${OPEN_VERBS.join('|')})[\\s\\S]{0,12}?(?:${INTAKE_NOUNS.feedback.join('|')})\\s*[#＃]?\\s*(\\d+)`,
  'i',
);

/**
 * 解析「打开/查看 需求/反馈 #N 或 N」意图。
 *
 * 容忍：全角 ＃、半角 #、# 与数字间空格、中英文名词、句末标点、动词与名词间的少量间隔。
 * 仅在出现「打开/查看类动词 + 需求/反馈名词 + 数字」的强匹配时返回结果：
 *   - 「需求 #35 怎么样」无动词 → null
 *   - 「打开计划 #1」名词不符 → null
 * 多类型时按 requirement → feedback 顺序取首个命中。纯函数、无副作用、可单测。
 */
export function parseOpenIntakeIntent(text: string): OpenIntakeIntent | null {
  const input = String(text ?? '');
  if (!input) return null;

  const patterns: ReadonlyArray<readonly [IntakeType, RegExp]> = [
    ['requirement', REQUIREMENT_PATTERN],
    ['feedback', FEEDBACK_PATTERN],
  ];

  for (const [type, pattern] of patterns) {
    const match = input.match(pattern);
    if (match && match[1]) {
      const id = Number(match[1]);
      if (Number.isInteger(id) && id > 0) {
        return { type, id };
      }
    }
  }

  return null;
}

/**
 * 构造与 IntakePanel 一致的 DOM 锚点 id：`workspace-${type}-${id}`。
 * 例如 `workspace-requirement-35` / `workspace-feedback-12`。
 */
export function buildIntakeAnchorId(type: IntakeType, id: number): string {
  return `workspace-${type}-${id}`;
}
