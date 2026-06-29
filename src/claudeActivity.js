/**
 * ClaudeStreamJsonPrinter —— Claude Code `--output-format stream-json` 的活动解析器。
 *
 * Claude 在 `-p --output-format stream-json --verbose` 下以 NDJSON（每行一个 JSON 对象）
 * 实时流式输出 system / assistant / user(tool_result) / result 等事件。本类把事件流
 * 增量解析成「人类可读的活动时间线」，API 仿 CodexActivityPrinter（src/codexActivity.js）：
 * - offer(rawChunk)   喂入原始流（可能含多行、可能跨 chunk 拆断）
 * - flush()           处理尾部残行（仿 codexActivity.js:43-59）
 * - getLines()        返回最近约 120 条活动行 { role, text, at }[]（内部上限 maxLines）
 * - getResultText()   返回最终文本（优先 result 事件，回退累计助手文本，再回退空串）
 * - getSessionId()    返回 result 事件中的 session_id（非法/缺失返回空串）
 *
 * 非 JSON 行（stderr 噪声 / 分片 / 进度行）静默跳过，不抛错。不引入新的运行时依赖。
 */

// 单条活动行最大字符数（超出截断并加省略号）
const LINE_LIMIT = 200;
// 工具入参 / 结果等摘要的最大字符数
const SUMMARY_LIMIT = 120;
// getLines 返回最近多少条活动行
const RETURN_TAIL = 120;
// session_id 最大长度（与 normalizeAgentCliSessionId 保持一致）
const SESSION_MAX_LEN = 256;

// tool_use 的 input 里最常带有有用信息的字段，按优先级提取摘要
const TOOL_INPUT_PRIORITY = [
  'file_path', 'path', 'command', 'pattern', 'query', 'url', 'prompt', 'content', 'note',
];

/**
 * 沿用 normalizeAgentCliSessionId 的长度/字符校验风格：空或超长返回空串，
 * 仅允许字母、数字及 . _ : - 组成的 id。
 */
function normalizeSessionId(value) {
  const text = String(value || '').trim();
  if (!text || text.length > SESSION_MAX_LEN) return '';
  return /^[A-Za-z0-9._:-]+$/.test(text) ? text : '';
}

/** 折叠空白（含换行）为单个空格，便于活动行单行展示 */
function compactText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

/** 把任意值截断成带省略号的短串 */
function truncateText(value, limit = SUMMARY_LIMIT) {
  const text = String(value || '');
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 3))}...`;
}

class ClaudeStreamJsonPrinter {
  constructor(maxLines = 200) {
    this.maxLines = maxLines;
    this.lines = [];
    this.recent = new Set();
    this.pendingLine = '';
    this.resultText = '';
    this.assistantText = '';
    this.sessionId = '';
  }

  /** 喂入一段原始文本（可含多行，可跨 chunk 拆断） */
  offer(rawChunk) {
    const text = String(rawChunk || '').replace(/\r/g, '');
    this.pendingLine += text;
    while (true) {
      const idx = this.pendingLine.indexOf('\n');
      if (idx < 0) break;
      const line = this.pendingLine.slice(0, idx);
      this.pendingLine = this.pendingLine.slice(idx + 1);
      this.processLine(line);
    }
  }

  /** 处理尾部残行（仿 codexActivity.js:43-59） */
  flush() {
    const line = this.pendingLine;
    this.pendingLine = '';
    if (line.trim()) this.processLine(line);
  }

  processLine(rawLine) {
    const trimmed = String(rawLine || '').trim();
    if (!trimmed) return;
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      // 非 JSON 行（stderr 噪声 / 分片 / 进度行）静默跳过，不抛错
      return;
    }
    if (!event || typeof event !== 'object') return;
    this.handleEvent(event);
  }

  handleEvent(event) {
    let type = event.type;
    // 容错：个别事件不带顶层 type 时，按 message.role 推断
    if (!type && event.message && typeof event.message === 'object') {
      type = event.message.role === 'user' ? 'user' : 'assistant';
    }
    switch (type) {
      case 'assistant':
        this.handleAssistant(event);
        break;
      case 'user':
        this.handleUser(event);
        break;
      case 'result':
        this.handleResult(event);
        break;
      default:
        // system / ping 等事件不产生活动行
        break;
    }
  }

  /** assistant 事件：遍历 message.content[]，text→codex 活动行，tool_use→exec 执行行 */
  handleAssistant(event) {
    const content = this.readContent(event);
    if (!Array.isArray(content)) return;
    for (const item of content) {
      if (!item || typeof item !== 'object') continue;
      if (item.type === 'text') {
        const text = compactText(item.text);
        if (!text) continue;
        // 累计原始助手文本，作为 getResultText() 的回退来源
        if (this.assistantText) this.assistantText += '\n';
        this.assistantText += String(item.text || '');
        this.push('codex', text);
      } else if (item.type === 'tool_use') {
        const name = String(item.name || 'tool');
        const summary = this.summarizeToolInput(item.input);
        this.push('exec', summary ? `${name} ${summary}` : name);
      }
    }
  }

  /** user 事件的 tool_result → info 结果行，截断内容并尽量体现成功/失败 */
  handleUser(event) {
    const content = this.readContent(event);
    if (!Array.isArray(content)) return;
    for (const item of content) {
      if (!item || typeof item !== 'object') continue;
      if (item.type !== 'tool_result') continue;
      const failed = item.is_error === true;
      const text = compactText(this.extractToolResultText(item));
      if (text) {
        this.push('info', failed ? `[失败] ${text}` : text);
      } else {
        this.push('info', failed ? '[失败] 工具结果' : '工具结果');
      }
    }
  }

  /** result 事件：记录最终文本与 session_id，并 push 一条完成活动行 */
  handleResult(event) {
    if (typeof event.result === 'string') {
      const result = compactText(event.result);
      if (result) this.resultText = String(event.result);
    }
    const sid = normalizeSessionId(event.session_id);
    if (sid) this.sessionId = sid;
    const failed = event.is_error === true;
    this.push('info', failed ? '任务结束（出错）' : '任务完成');
  }

  readContent(event) {
    const message = event && event.message;
    if (!message || typeof message !== 'object') return null;
    return message.content;
  }

  /** 提取 tool_result 内容（可能是字符串或 content 块数组）并截断 */
  extractToolResultText(item) {
    const raw = item.content;
    if (raw == null) return '';
    if (typeof raw === 'string') return truncateText(raw, SUMMARY_LIMIT);
    if (Array.isArray(raw)) {
      const parts = [];
      for (const block of raw) {
        if (block && typeof block === 'object' && typeof block.text === 'string') {
          parts.push(block.text);
        } else if (typeof block === 'string') {
          parts.push(block);
        }
      }
      return truncateText(parts.join(' '), SUMMARY_LIMIT);
    }
    try {
      return truncateText(JSON.stringify(raw), SUMMARY_LIMIT);
    } catch {
      return '';
    }
  }

  /** 把 tool_use 的 input 摘要成短串：优先提取常用字段，否则整体 JSON 截断 */
  summarizeToolInput(input) {
    if (input == null) return '';
    if (typeof input === 'string') return truncateText(compactText(input), SUMMARY_LIMIT);
    if (typeof input === 'object') {
      for (const key of TOOL_INPUT_PRIORITY) {
        const value = input[key];
        if (value != null && String(value).trim()) {
          return truncateText(compactText(`${key}: ${value}`), SUMMARY_LIMIT);
        }
      }
      try {
        return truncateText(compactText(JSON.stringify(input)), SUMMARY_LIMIT);
      } catch {
        return '';
      }
    }
    return '';
  }

  /** 截断 + 邻近去重后写入活动行（仿 CodexActivityPrinter.push） */
  push(role, line) {
    const text = truncateText(compactText(line), LINE_LIMIT);
    if (!text) return;
    const key = `${role}:${text}`;
    if (this.recent.has(key)) return;
    this.recent.add(key);
    if (this.lines.length >= this.maxLines) {
      this.lines.shift();
      // 限制 recent 集合大小，避免随时间无限增长
      if (this.recent.size > this.maxLines * 2) {
        this.recent = new Set(this.lines.map((l) => `${l.role}:${l.text}`));
      }
    }
    this.lines.push({ role, text, at: new Date().toISOString() });
  }

  /** 返回当前活动行（供 snapshot），取最近约 120 条 */
  getLines() {
    return this.lines.slice(-RETURN_TAIL);
  }

  /** 最终文本：优先 result 事件，回退累计助手文本，再回退空串 */
  getResultText() {
    if (this.resultText && this.resultText.trim()) return this.resultText.trim();
    if (this.assistantText && this.assistantText.trim()) return this.assistantText.trim();
    return '';
  }

  /** result 事件的 session_id（非法/缺失返回空串） */
  getSessionId() {
    return this.sessionId;
  }
}

module.exports = { ClaudeStreamJsonPrinter };
