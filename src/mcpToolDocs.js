const { MCP_TOOL_DEFINITIONS } = require('./mcpTools');

const MCP_TOOL_DOCS = Object.freeze(MCP_TOOL_DEFINITIONS.map((tool) => Object.freeze({
  name: tool.name,
  title: tool.title,
  description: tool.description,
  markdown: toolMarkdown(tool),
})));

function mcpToolDocs() {
  return MCP_TOOL_DOCS;
}

function toolMarkdown(tool) {
  return [
    `## ${tool.name}`,
    '',
    `**功能**：${tool.description || tool.title || tool.name}`,
    '',
    executorToolNote(tool.name),
    intakeDuplicateNote(tool.name),
    '',
    parameterSection(tool.inputSchema),
  ].filter(Boolean).join('\n');
}

function executorToolNote(name) {
  if (!String(name || '').includes('executor')) return '';
  return '**执行器约束**：仅操作当前项目内已保存的执行器；run/stop 不接受临时 command、launch 或 debug 参数；运行结果只返回状态、退出码、耗时和日志尾部。';
}

function intakeDuplicateNote(name) {
  if (name === 'create_requirement') {
    return '**重复提交**：同项目内 normalized title/body 相同且未 closed 的需求会被拒绝，错误返回 `code=DUPLICATE_INTAKE` 和 `existingRequirementId`。';
  }
  if (name === 'create_feedback') {
    return '**重复提交**：同项目、同 requirement 关联下 normalized title/body 相同且未 closed 的反馈会被拒绝，错误返回 `code=DUPLICATE_INTAKE` 和 `existingFeedbackId`。';
  }
  return '';
}

function parameterSection(schema = {}) {
  const properties = schema.properties || {};
  const rows = Object.keys(properties).flatMap((name) => parameterRows(name, properties[name], schema.required || [], 0));
  if (!rows.length) return '**参数**：无需参数。';
  return ['**参数**', '', '| 参数 | 类型 | 必填 | 说明 |', '| --- | --- | --- | --- |', ...rows].join('\n');
}

function parameterRows(name, schema = {}, required = [], depth = 0) {
  const label = depth ? `${'  '.repeat(depth)}${name}` : name;
  const rows = [`| \`${escapeMarkdown(label)}\` | \`${escapeMarkdown(schemaType(schema))}\` | ${required.includes(name) ? '是' : '否'} | ${escapeMarkdown(schemaNotes(schema))} |`];
  const childProperties = schema.items?.properties || schema.properties;
  if (childProperties && depth < 2) {
    rows.push(...Object.keys(childProperties).flatMap((childName) =>
      parameterRows(childName, childProperties[childName], schema.items?.required || schema.required || [], depth + 1)));
  }
  return rows;
}

function schemaType(schema = {}) {
  const type = Array.isArray(schema.type) ? schema.type.join(' | ') : (schema.type || 'any');
  if (type === 'array' && schema.items) return `array<${schemaType(schema.items)}>`;
  return type;
}

function schemaNotes(schema = {}) {
  const notes = [];
  if (schema.description) notes.push(schema.description);
  if (schema.enum) notes.push(`可选：${schema.enum.map((item) => `\`${item}\``).join(', ')}`);
  if (schema.minLength !== undefined) notes.push(`最短 ${schema.minLength}`);
  if (schema.maxLength !== undefined) notes.push(`最长 ${schema.maxLength}`);
  if (schema.minimum !== undefined) notes.push(`最小 ${schema.minimum}`);
  if (schema.maximum !== undefined) notes.push(`最大 ${schema.maximum}`);
  if (schema.maxItems !== undefined) notes.push(`最多 ${schema.maxItems} 项`);
  return notes.join('；') || '-';
}

function escapeMarkdown(value) {
  return String(value || '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

module.exports = { MCP_TOOL_DOCS, mcpToolDocs };
