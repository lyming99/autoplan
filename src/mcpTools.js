const MCP_TOOL_NAMES = Object.freeze({
  CREATE_PROJECT: 'create_project',
  CREATE_REQUIREMENT: 'create_requirement',
  CREATE_FEEDBACK: 'create_feedback',
});

const AGENT_CLI_PROVIDERS = Object.freeze(['codex', 'claude']);
const CODEX_REASONING_EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh']);
const INTAKE_STATUSES = Object.freeze(['open', 'completed', 'closed']);

const LIMITS = Object.freeze({
  name: 120,
  title: 200,
  body: 100000,
  description: 5000,
  workspacePath: 1000,
  command: 1000,
  attachmentName: 255,
  attachmentPath: 2000,
  attachmentData: 10 * 1024 * 1024,
  attachments: 20,
});

const ATTACHMENT_INPUT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: true,
  properties: {
    name: { type: 'string', minLength: 1, maxLength: LIMITS.attachmentName },
    size: { type: 'integer', minimum: 0 },
    source: { type: 'string', enum: ['path', 'clipboard-image'] },
    path: { type: 'string', minLength: 1, maxLength: LIMITS.attachmentPath },
    type: { type: 'string', minLength: 1, maxLength: 200, description: 'MIME type' },
    dataUrl: { type: 'string', minLength: 1, maxLength: LIMITS.attachmentData },
    base64: { type: 'string', minLength: 1, maxLength: LIMITS.attachmentData },
    dataBase64: { type: 'string', minLength: 1, maxLength: LIMITS.attachmentData },
    bytes: {
      type: 'array',
      maxItems: LIMITS.attachmentData,
      items: { type: 'integer', minimum: 0, maximum: 255 },
    },
  },
});

const COMMON_CLI_PROPERTIES = Object.freeze({
  agentCliProvider: {
    type: 'string',
    enum: AGENT_CLI_PROVIDERS,
    description: 'Optional per-intake agent backend override.',
  },
  agentCliCommand: {
    type: 'string',
    maxLength: LIMITS.command,
    description: 'Optional per-intake agent command override.',
  },
  codexReasoningEffort: {
    type: 'string',
    enum: CODEX_REASONING_EFFORTS,
    description: 'Only applies when agentCliProvider is codex.',
  },
});

const MCP_TOOL_DEFINITIONS = Object.freeze([
  {
    name: MCP_TOOL_NAMES.CREATE_PROJECT,
    title: 'Create AutoPlan project',
    description: 'Create a project and return its id plus a snapshot summary.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'workspacePath'],
      properties: {
        name: { type: 'string', minLength: 1, maxLength: LIMITS.name },
        workspacePath: { type: 'string', minLength: 1, maxLength: LIMITS.workspacePath },
        description: { type: 'string', maxLength: LIMITS.description },
        ...COMMON_CLI_PROPERTIES,
      },
    },
  },
  {
    name: MCP_TOOL_NAMES.CREATE_REQUIREMENT,
    title: 'Create AutoPlan requirement',
    description: 'Create a requirement, optionally save attachments and start the project loop.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['projectId', 'title', 'body'],
      properties: {
        projectId: { type: 'integer', minimum: 1 },
        title: { type: 'string', minLength: 1, maxLength: LIMITS.title },
        body: { type: 'string', minLength: 1, maxLength: LIMITS.body },
        attachments: attachmentArraySchema(),
        autoRun: { type: 'boolean' },
        status: { type: 'string', enum: INTAKE_STATUSES },
        ...COMMON_CLI_PROPERTIES,
      },
    },
  },
  {
    name: MCP_TOOL_NAMES.CREATE_FEEDBACK,
    title: 'Create AutoPlan feedback',
    description: 'Create feedback, optionally associate it with a requirement and start the project loop.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['projectId', 'title', 'body'],
      properties: {
        projectId: { type: 'integer', minimum: 1 },
        requirementId: { type: ['integer', 'null'], minimum: 1 },
        title: { type: 'string', minLength: 1, maxLength: LIMITS.title },
        body: { type: 'string', minLength: 1, maxLength: LIMITS.body },
        attachments: attachmentArraySchema(),
        autoRun: { type: 'boolean' },
        status: { type: 'string', enum: INTAKE_STATUSES },
        ...COMMON_CLI_PROPERTIES,
      },
    },
  },
]);

async function registerMcpTools(server, context = {}) {
  const { CallToolRequestSchema, ListToolsRequestSchema } = await import('@modelcontextprotocol/sdk/types.js');
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: MCP_TOOL_DEFINITIONS.map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => callMcpTool(
    request.params?.name,
    request.params?.arguments || {},
    context,
  ));
}

async function callMcpTool(name, input = {}, context = {}) {
  const tool = MCP_TOOL_DEFINITIONS.find((item) => item.name === name);
  if (!tool) throw new Error(`未知 MCP 工具：${name || ''}`);

  try {
    const validated = validateToolInput(tool.name, input);
    const result = await runTool(tool.name, validated, context);
    return toolResult(result);
  } catch (error) {
    return toolError(error);
  }
}

async function runTool(name, input, context) {
  const service = requiredIntakeService(context);
  if (name === MCP_TOOL_NAMES.CREATE_PROJECT) {
    const snapshot = service.createProject(input);
    return {
      projectId: Number(snapshot.activeProjectId || snapshot.activeProject?.id || 0),
      snapshot: snapshotSummary(snapshot),
    };
  }
  if (name === MCP_TOOL_NAMES.CREATE_REQUIREMENT) {
    const snapshot = service.createRequirement(input);
    const requirement = latestIntake(context.db, 'requirements', input.projectId);
    return {
      projectId: input.projectId,
      requirementId: requirement?.id || null,
      requirement: intakeSummary(requirement),
      snapshot: snapshotSummary(snapshot),
    };
  }
  if (name === MCP_TOOL_NAMES.CREATE_FEEDBACK) {
    const snapshot = service.createFeedback(input);
    const feedback = latestIntake(context.db, 'feedback', input.projectId);
    return {
      projectId: input.projectId,
      feedbackId: feedback?.id || null,
      feedback: intakeSummary(feedback),
      snapshot: snapshotSummary(snapshot),
    };
  }
  throw new Error(`未知 MCP 工具：${name}`);
}

function validateToolInput(name, input) {
  assertPlainObject(input, '入参必须是对象');
  if (name === MCP_TOOL_NAMES.CREATE_PROJECT) return validateCreateProjectInput(input);
  if (name === MCP_TOOL_NAMES.CREATE_REQUIREMENT) return validateCreateRequirementInput(input);
  if (name === MCP_TOOL_NAMES.CREATE_FEEDBACK) return validateCreateFeedbackInput(input);
  throw new Error(`未知 MCP 工具：${name}`);
}

function validateCreateProjectInput(input) {
  return stripUndefined({
    name: requiredString(input, 'name', LIMITS.name),
    workspacePath: requiredString(input, 'workspacePath', LIMITS.workspacePath),
    description: optionalString(input, 'description', LIMITS.description),
    ...validatedAgentCliInput(input),
  });
}

function validateCreateRequirementInput(input) {
  return stripUndefined({
    projectId: requiredPositiveInteger(input, 'projectId'),
    title: requiredString(input, 'title', LIMITS.title),
    body: requiredString(input, 'body', LIMITS.body),
    attachments: optionalAttachments(input),
    autoRun: optionalBoolean(input, 'autoRun'),
    status: optionalEnum(input, 'status', INTAKE_STATUSES),
    ...validatedAgentCliInput(input),
  });
}

function validateCreateFeedbackInput(input) {
  return stripUndefined({
    projectId: requiredPositiveInteger(input, 'projectId'),
    requirementId: optionalPositiveInteger(input, 'requirementId', { nullable: true }),
    title: requiredString(input, 'title', LIMITS.title),
    body: requiredString(input, 'body', LIMITS.body),
    attachments: optionalAttachments(input),
    autoRun: optionalBoolean(input, 'autoRun'),
    status: optionalEnum(input, 'status', INTAKE_STATUSES),
    ...validatedAgentCliInput(input),
  });
}

function validatedAgentCliInput(input) {
  return stripUndefined({
    agentCliProvider: optionalEnum(input, 'agentCliProvider', AGENT_CLI_PROVIDERS),
    agentCliCommand: optionalString(input, 'agentCliCommand', LIMITS.command),
    codexReasoningEffort: optionalEnum(input, 'codexReasoningEffort', CODEX_REASONING_EFFORTS),
  });
}

function optionalAttachments(input) {
  if (input.attachments === undefined) return [];
  if (!Array.isArray(input.attachments)) throw new Error('attachments 必须是数组');
  if (input.attachments.length > LIMITS.attachments) throw new Error(`attachments 最多支持 ${LIMITS.attachments} 个`);
  return input.attachments.map((attachment, index) => validateAttachment(attachment, index));
}

function validateAttachment(attachment, index) {
  assertPlainObject(attachment, `attachments[${index}] 必须是对象`);
  const normalized = stripUndefined({
    name: optionalString(attachment, 'name', LIMITS.attachmentName),
    size: optionalNonNegativeInteger(attachment, 'size'),
    source: optionalEnum(attachment, 'source', ['path', 'clipboard-image']),
    path: optionalString(attachment, 'path', LIMITS.attachmentPath),
    type: optionalString(attachment, 'type', 200),
    dataUrl: optionalString(attachment, 'dataUrl', LIMITS.attachmentData),
    base64: optionalString(attachment, 'base64', LIMITS.attachmentData),
    dataBase64: optionalString(attachment, 'dataBase64', LIMITS.attachmentData),
    bytes: optionalByteArray(attachment, 'bytes'),
  });
  if (!normalized.path && !normalized.dataUrl && !normalized.base64 && !normalized.dataBase64 && !normalized.bytes && !normalized.name) {
    throw new Error(`attachments[${index}] 至少需要 name 占位信息，或 path、dataUrl、base64、dataBase64、bytes 之一`);
  }
  return normalized;
}

function requiredString(input, key, maxLength) {
  if (!Object.prototype.hasOwnProperty.call(input, key)) throw new Error(`${key} 为必填字符串`);
  const value = stringValue(input[key], key, maxLength);
  if (!value) throw new Error(`${key} 不能为空`);
  return value;
}

function optionalString(input, key, maxLength) {
  if (input[key] === undefined || input[key] === null) return undefined;
  return stringValue(input[key], key, maxLength);
}

function stringValue(value, key, maxLength) {
  if (typeof value !== 'string') throw new Error(`${key} 必须是字符串`);
  const trimmed = value.trim();
  if (trimmed.length > maxLength) throw new Error(`${key} 长度不能超过 ${maxLength} 个字符`);
  return trimmed;
}

function requiredPositiveInteger(input, key) {
  const value = positiveIntegerValue(input[key], key);
  if (!value) throw new Error(`${key} 必须是大于 0 的整数`);
  return value;
}

function optionalPositiveInteger(input, key, options = {}) {
  if (input[key] === undefined || (options.nullable && input[key] === null)) return null;
  const value = positiveIntegerValue(input[key], key);
  if (!value) throw new Error(`${key} 必须是大于 0 的整数`);
  return value;
}

function positiveIntegerValue(value, key) {
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new Error(`${key} 必须是整数`);
  return value > 0 ? value : 0;
}

function optionalBoolean(input, key) {
  if (input[key] === undefined || input[key] === null) return undefined;
  if (typeof input[key] !== 'boolean') throw new Error(`${key} 必须是布尔值`);
  return input[key];
}

function optionalNonNegativeInteger(input, key) {
  if (input[key] === undefined || input[key] === null) return undefined;
  if (typeof input[key] !== 'number' || !Number.isInteger(input[key]) || input[key] < 0) {
    throw new Error(`${key} 必须是大于等于 0 的整数`);
  }
  return input[key];
}

function optionalEnum(input, key, values) {
  if (input[key] === undefined || input[key] === null) return undefined;
  if (typeof input[key] !== 'string') throw new Error(`${key} 必须是字符串`);
  if (!values.includes(input[key])) throw new Error(`${key} 必须是以下值之一：${values.join(', ')}`);
  return input[key];
}

function optionalByteArray(input, key) {
  if (input[key] === undefined || input[key] === null) return undefined;
  if (!Array.isArray(input[key])) throw new Error(`${key} 必须是字节数组`);
  if (input[key].length > LIMITS.attachmentData) throw new Error(`${key} 长度不能超过 ${LIMITS.attachmentData}`);
  for (const value of input[key]) {
    if (!Number.isInteger(value) || value < 0 || value > 255) throw new Error(`${key} 每一项必须是 0-255 的整数`);
  }
  return input[key];
}

function assertPlainObject(value, message) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(message);
}

function stripUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter((entry) => entry[1] !== undefined));
}

function requiredIntakeService(context) {
  if (!context?.intakeService) throw new Error('MCP 工具服务尚未初始化');
  return context.intakeService;
}

function latestIntake(db, table, projectId) {
  if (!db) return null;
  return db.get(`SELECT * FROM ${table} WHERE project_id = ? ORDER BY id DESC LIMIT 1`, [projectId]);
}

function intakeSummary(record) {
  if (!record) return null;
  return {
    id: record.id,
    projectId: record.project_id,
    requirementId: record.requirement_id || null,
    title: record.title,
    status: record.status,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
  };
}

function snapshotSummary(snapshot = {}) {
  return {
    activeProjectId: snapshot.activeProjectId || null,
    activeProject: snapshot.activeProject ? {
      id: snapshot.activeProject.id,
      name: snapshot.activeProject.name,
      workspacePath: snapshot.activeProject.workspace_path || '',
      description: snapshot.activeProject.description || '',
    } : null,
    state: snapshot.state ? {
      running: Boolean(snapshot.state.running),
      phase: snapshot.state.phase || 'idle',
      validationCommand: snapshot.state.validation_command || '',
      agentCliProvider: snapshot.state.agent_cli_provider || null,
      codexReasoningEffort: snapshot.state.codex_reasoning_effort || null,
    } : null,
    counts: {
      projects: countOf(snapshot.projects),
      requirements: countOf(snapshot.requirements),
      feedback: countOf(snapshot.feedback),
      plans: countOf(snapshot.plans),
      tasks: countOf(snapshot.tasks),
      events: countOf(snapshot.events),
    },
  };
}

function countOf(value) {
  return Array.isArray(value) ? value.length : 0;
}

function toolResult(result) {
  return {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    structuredContent: result,
  };
}

function toolError(error) {
  const message = error?.message || String(error || '未知错误');
  return {
    isError: true,
    content: [{ type: 'text', text: message }],
    structuredContent: { error: message },
  };
}

function attachmentArraySchema() {
  return {
    type: 'array',
    maxItems: LIMITS.attachments,
    items: ATTACHMENT_INPUT_SCHEMA,
  };
}

module.exports = {
  MCP_TOOL_DEFINITIONS,
  MCP_TOOL_NAMES,
  callMcpTool,
  registerMcpTools,
};
