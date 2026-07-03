export {};

import { parseOpenIntakeIntent, buildIntakeAnchorId } from './chatIntents';

type TestRegistrar = (name: string, fn: () => void) => void;

declare function require(id: string): unknown;

const { describe, it } = require('node:test') as { describe: TestRegistrar; it: TestRegistrar };

type IntakeType = 'requirement' | 'feedback';

function expect(condition: unknown, message: string) {
  if (!condition) throw new Error(message);
}

function expectEqual<T>(actual: T, expected: T, message: string) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

function expectNull(value: unknown, message: string) {
  if (value !== null) throw new Error(`${message}: expected null, got ${JSON.stringify(value)}`);
}

/** 断言文本命中指定 type/id 的打开意图 */
function expectIntent(text: string, type: IntakeType, id: number) {
  const intent = parseOpenIntakeIntent(text);
  expect(intent !== null, `应命中意图: "${text}"`);
  if (!intent) return; // 仅为类型收窄；上面 expect 已在 null 时抛错
  expectEqual(intent.type, type, `"${text}" 的 type`);
  expectEqual(intent.id, id, `"${text}" 的 id`);
}

/** 断言文本不命中任何打开意图（避免误伤普通消息） */
function expectNoIntent(text: string) {
  expectNull(parseOpenIntakeIntent(text), `不应命中意图: "${text}"`);
}

describe('parseOpenIntakeIntent 命中', () => {
  it('打开需求 #35', () => expectIntent('打开需求 #35', 'requirement', 35));
  it('打开反馈#12（# 与数字无空格）', () => expectIntent('打开反馈#12', 'feedback', 12));
  it('查看需求 7（无 #，裸数字）', () => expectIntent('查看需求 7', 'requirement', 7));
  it('全角 ＃', () => expectIntent('打开需求 ＃42', 'requirement', 42));
  it('句末标点', () => expectIntent('打开反馈 #8。', 'feedback', 8));
  it('多余空格', () => expectIntent('打开   需求  #  35', 'requirement', 35));
  it('动词「看一下」', () => expectIntent('看一下需求 #3', 'requirement', 3));
  it('中英混合 requirement', () => expectIntent('打开 requirement #11', 'requirement', 11));
  it('英文 feedback', () => expectIntent('查看 feedback 5', 'feedback', 5));
  it('消息中段命中', () => expectIntent('好的，我帮你打开需求 #50 看看', 'requirement', 50));
});

describe('parseOpenIntakeIntent 不误命中', () => {
  it('无打开动词（需求 #35 怎么样）', () => expectNoIntent('需求 #35 怎么样'));
  it('名词不符（打开计划 #1）', () => expectNoIntent('打开计划 #1'));
  it('名词不符（打开任务 #2）', () => expectNoIntent('打开任务 #2'));
  it('无数字（打开需求）', () => expectNoIntent('打开需求'));
  it('空字符串', () => expectNoIntent(''));
  it('普通消息', () => expectNoIntent('今天天气不错'));
});

describe('buildIntakeAnchorId 与 IntakePanel 口径一致', () => {
  it('requirement 锚点', () => {
    expectEqual(buildIntakeAnchorId('requirement', 35), 'workspace-requirement-35', 'requirement 锚点');
  });
  it('feedback 锚点', () => {
    expectEqual(buildIntakeAnchorId('feedback', 12), 'workspace-feedback-12', 'feedback 锚点');
  });
});
