const { describe, it } = require('node:test');

const { ClaudeStreamJsonPrinter } = require('./claudeActivity');

function expectEqual(actual, expected) {
  if (actual !== expected) {
    throw new Error(`Expected ${JSON.stringify(actual)} to equal ${JSON.stringify(expected)}`);
  }
}

function expectIncludes(items, expected) {
  if (!items.includes(expected)) {
    throw new Error(`Expected ${JSON.stringify(items)} to include ${JSON.stringify(expected)}`);
  }
}

function expectTrue(value, message) {
  if (!value) throw new Error(message || `Expected truthy, got ${JSON.stringify(value)}`);
}

// 活动行是 { role, text, at } 对象，提供按角色+片段断言的辅助方法
function hasLineWith(lines, role, fragment) {
  return lines.some((line) => line.role === role && line.text.includes(fragment));
}

function roleTexts(lines, role) {
  return lines.filter((line) => line.role === role).map((line) => line.text);
}

// 一份覆盖「助手文本 / 工具调用 / 工具结果 / 最终结果」并夹杂非 JSON 噪声的模拟 NDJSON
function sampleStream() {
  return [
    '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Let me read the file first."}]}}',
    'this line is not json noise from stderr',
    '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"Read","input":{"file_path":"src/index.js"}}]}}',
    '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"42 lines read"}]}}',
    '{"type":"result","subtype":"success","result":"Done. All files updated.","session_id":"abc-123-def","is_error":false}',
  ].join('\n') + '\n';
}

describe('ClaudeStreamJsonPrinter', () => {
  it('parses assistant text, tool_use, tool_result and result into activity lines', () => {
    const printer = new ClaudeStreamJsonPrinter();
    printer.offer(sampleStream());
    printer.flush();
    const lines = printer.getLines();

    expectTrue(hasLineWith(lines, 'codex', 'Let me read the file first.'), 'missing assistant text line');
    expectTrue(hasLineWith(lines, 'exec', 'Read'), 'missing tool_use exec line');
    expectTrue(hasLineWith(lines, 'exec', 'src/index.js'), 'exec line should carry tool input summary');
    expectTrue(hasLineWith(lines, 'info', '42 lines read'), 'missing tool_result line');
    expectTrue(hasLineWith(lines, 'info', '任务完成'), 'missing result completion line');
  });

  it('extracts final result text and session id from the result event', () => {
    const printer = new ClaudeStreamJsonPrinter();
    printer.offer(sampleStream());
    printer.flush();

    expectEqual(printer.getResultText(), 'Done. All files updated.');
    expectEqual(printer.getSessionId(), 'abc-123-def');
  });

  it('skips non-JSON lines without throwing', () => {
    const printer = new ClaudeStreamJsonPrinter();
    printer.offer('totally not json line\n{ broken json\n');
    printer.flush();

    expectEqual(printer.getLines().length, 0);
    expectEqual(printer.getResultText(), '');
    expectEqual(printer.getSessionId(), '');
  });

  it('reassembles a single NDJSON line split across chunks', () => {
    const printer = new ClaudeStreamJsonPrinter();
    const line = '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"cross chunk works"}]}}\n';
    const mid = Math.floor(line.length / 2);

    printer.offer(line.slice(0, mid));
    expectEqual(printer.getLines().length, 0);

    printer.offer(line.slice(mid));
    printer.flush();
    expectTrue(hasLineWith(printer.getLines(), 'codex', 'cross chunk works'), 'half-line should parse after reassembly');
  });

  it('falls back to accumulated assistant text when no result event arrives', () => {
    const printer = new ClaudeStreamJsonPrinter();
    printer.offer('{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"no result event here"}]}}\n');
    printer.flush();

    expectEqual(printer.getResultText(), 'no result event here');
    expectEqual(printer.getSessionId(), '');
  });

  it('returns empty session id for invalid result session ids', () => {
    const printer = new ClaudeStreamJsonPrinter();
    printer.offer('{"type":"result","result":"ok","session_id":"bad id with spaces"}\n');
    printer.flush();

    expectEqual(printer.getSessionId(), '');
  });

  it('truncates long activity lines and marks failed tool results', () => {
    const printer = new ClaudeStreamJsonPrinter();
    const long = 'x'.repeat(500);
    printer.offer(`{"type":"user","message":{"role":"user","content":[{"type":"tool_result","is_error":true,"content":"${long}"}]}}\n`);
    printer.flush();
    const lines = printer.getLines();

    expectTrue(lines.some((line) => line.role === 'info' && line.text.startsWith('[失败]')), 'failed tool result should be marked');
    expectTrue(lines.every((line) => line.text.length <= 200), 'lines should be truncated to the line limit');
  });

  it('keeps only the recent tail via getLines', () => {
    const printer = new ClaudeStreamJsonPrinter(4);
    for (let i = 0; i < 10; i += 1) {
      printer.offer(`{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"message ${i}"}]}}\n`);
    }
    printer.flush();
    const texts = roleTexts(printer.getLines(), 'codex');

    expectIncludes(texts, 'message 9');
    expectTrue(!texts.includes('message 0'), 'older lines should be evicted once maxLines is exceeded');
  });
});
