const MCP_TOOL_NAMES = Object.freeze({
  LIST_PROJECTS: 'list_projects',
  GET_PROJECT: 'get_project',
  CREATE_PROJECT: 'create_project',
  LIST_REQUIREMENTS: 'list_requirements',
  CREATE_REQUIREMENT: 'create_requirement',
  LIST_FEEDBACK: 'list_feedback',
  CREATE_FEEDBACK: 'create_feedback',
  LIST_PLANS: 'list_plans',
  GET_PLAN: 'get_plan',
  LIST_TASKS: 'list_tasks',
  START_LOOP: 'start_loop',
  STOP_LOOP: 'stop_loop',
});

const AGENT_CLI_PROVIDERS = Object.freeze(['codex', 'claude', 'opencode', 'oh-my-pi']);
const CODEX_REASONING_EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh']);
const INTAKE_STATUSES = Object.freeze(['open', 'completed', 'closed']);
const PLAN_STATUSES = Object.freeze(['pending', 'running', 'ready_for_validation', 'completed', 'interrupted', 'draft']);
const TASK_STATUSES = Object.freeze(['pending', 'running', 'completed', 'blocked', 'failed', 'stopping', 'stopped', 'interrupted']);

const LIMITS = Object.freeze({
  name: 120,
  title: 200,
  body: 100000,
  description: 5000,
  workspacePath: 1000,
  command: 1000,
  query: 200,
  rows: 200,
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

const PROJECT_ID_SCHEMA = Object.freeze({ projectId: { type: 'integer', minimum: 1 } });
const LIMIT_SCHEMA = Object.freeze({ limit: { type: 'integer', minimum: 1, maximum: LIMITS.rows } });

const MCP_TOOL_DEFINITIONS = Object.freeze([
  {
    name: MCP_TOOL_NAMES.LIST_PROJECTS,
    title: 'List AutoPlan projects',
    description: 'List projects with runtime state summaries.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', maxLength: LIMITS.query },
        ...LIMIT_SCHEMA,
      },
    },
  },
  {
    name: MCP_TOOL_NAMES.GET_PROJECT,
    title: 'Get AutoPlan project',
    description: 'Get one project and its snapshot summary.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['projectId'],
      properties: PROJECT_ID_SCHEMA,
    },
  },
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
    name: MCP_TOOL_NAMES.LIST_REQUIREMENTS,
    title: 'List AutoPlan requirements',
    description: 'List requirements for a project.',
    inputSchema: intakeListSchema(INTAKE_STATUSES),
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
        ...PROJECT_ID_SCHEMA,
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
    name: MCP_TOOL_NAMES.LIST_FEEDBACK,
    title: 'List AutoPlan feedback',
    description: 'List feedback for a project.',
    inputSchema: intakeListSchema(INTAKE_STATUSES),
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
        ...PROJECT_ID_SCHEMA,
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
  {
    name: MCP_TOOL_NAMES.LIST_PLANS,
    title: 'List AutoPlan plans',
    description: 'List plans for a project.',
    inputSchema: intakeListSchema(PLAN_STATUSES),
  },
  {
    name: MCP_TOOL_NAMES.GET_PLAN,
    title: 'Get AutoPlan plan',
    description: 'Get one plan and its tasks.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['projectId', 'planId'],
      properties: {
        ...PROJECT_ID_SCHEMA,
        planId: { type: 'integer', minimum: 1 },
      },
    },
  },
  {
    name: MCP_TOOL_NAMES.LIST_TASKS,
    title: 'List AutoPlan tasks',
    description: 'List tasks for a project, optionally filtered by plan or status.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['projectId'],
      properties: {
        ...PROJECT_ID_SCHEMA,
        planId: { type: 'integer', minimum: 1 },
        status: { type: 'string', enum: TASK_STATUSES },
        ...LIMIT_SCHEMA,
      },
    },
  },
  {
    name: MCP_TOOL_NAMES.START_LOOP,
    title: 'Start AutoPlan loop',
    description: 'Start the project loop.',
    inputSchema: projectActionSchema(),
  },
  {
    name: MCP_TOOL_NAMES.STOP_LOOP,
    title: 'Stop AutoPlan loop',
    description: 'Stop the project loop.',
    inputSchema: projectActionSchema(),
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
  if (!tool) throw new Error(`Unknown MCP tool: ${name || ''}`);

  try {
    const validated = validateToolInput(tool.name, input);
    const result = await runTool(tool.name, validated, context);
    return toolResult(result);
  } catch (error) {
    return toolError(error);
  }
}

async function runTool(name, input, context) {
  if (name === MCP_TOOL_NAMES.LIST_PROJECTS) {
    const db = requiredDb(context);
    return {
      projects: listProjectRows(db, input).map((project) => projectSummary(project, context.loop)),
    };
  }
  if (name === MCP_TOOL_NAMES.GET_PROJECT) {
    const loop = requiredLoop(context);
    const project = requiredProject(loop, input.projectId);
    return {
      project: projectSummary(project, loop),
      snapshot: snapshotSummary(loop.snapshot(input.projectId)),
    };
  }
  if (name === MCP_TOOL_NAMES.CREATE_PROJECT) {
    const service = requiredIntakeService(context);
    const snapshot = service.createProject(input);
    return {
      projectId: Number(snapshot.activeProjectId || snapshot.activeProject?.id || 0),
      snapshot: snapshotSummary(snapshot),
    };
  }
  if (name === MCP_TOOL_NAMES.LIST_REQUIREMENTS) {
    requiredProject(requiredLoop(context), input.projectId);
    return {
      projectId: input.projectId,
      requirements: listIntakeRows(requiredDb(context), 'requirements', input).map((row) => intakeDetail(row)),
    };
  }
  if (name === MCP_TOOL_NAMES.CREATE_REQUIREMENT) {
    const service = requiredIntakeService(context);
    const snapshot = service.createRequirement(input);
    const requirement = latestIntake(context.db, 'requirements', input.projectId);
    return {
      projectId: input.projectId,
      requirementId: requirement?.id || null,
      requirement: intakeSummary(requirement),
      snapshot: snapshotSummary(snapshot),
    };
  }
  if (name === MCP_TOOL_NAMES.LIST_FEEDBACK) {
    requiredProject(requiredLoop(context), input.projectId);
    return {
      projectId: input.projectId,
      feedback: listIntakeRows(requiredDb(context), 'feedback', input).map((row) => intakeDetail(row)),
    };
  }
  if (name === MCP_TOOL_NAMES.CREATE_FEEDBACK) {
    const service = requiredIntakeService(context);
    const snapshot = service.createFeedback(input);
    const feedback = latestIntake(context.db, 'feedback', input.projectId);
    return {
      projectId: input.projectId,
      feedbackId: feedback?.id || null,
      feedback: intakeSummary(feedback),
      snapshot: snapshotSummary(snapshot),
    };
  }
  if (name === MCP_TOOL_NAMES.LIST_PLANS) {
    requiredProject(requiredLoop(context), input.projectId);
    return {
      projectId: input.projectId,
      plans: listPlanRows(requiredDb(context), input).map((plan) => planSummary(plan)),
    };
  }
  if (name === MCP_TOOL_NAMES.GET_PLAN) {
    requiredProject(requiredLoop(context), input.projectId);
    const db = requiredDb(context);
    const plan = requiredPlan(db, input.projectId, input.planId);
    return {
      projectId: input.projectId,
      plan: planSummary(plan),
      tasks: listTaskRows(db, { projectId: input.projectId, planId: input.planId, limit: LIMITS.rows }).map((task) => taskSummary(task)),
    };
  }
  if (name === MCP_TOOL_NAMES.LIST_TASKS) {
    requiredProject(requiredLoop(context), input.projectId);
    const db = requiredDb(context);
    if (input.planId) requiredPlan(db, input.projectId, input.planId);
    return {
      projectId: input.projectId,
      tasks: listTaskRows(db, input).map((task) => taskSummary(task)),
    };
  }
  if (name === MCP_TOOL_NAMES.START_LOOP) {
    const loop = requiredLoop(context);
    requiredProject(loop, input.projectId);
    loop.start(input.projectId);
    return {
      projectId: input.projectId,
      snapshot: snapshotSummary(loop.snapshot(input.projectId)),
    };
  }
  if (name === MCP_TOOL_NAMES.STOP_LOOP) {
    const loop = requiredLoop(context);
    requiredProject(loop, input.projectId);
    loop.stop(input.projectId);
    return {
      projectId: input.projectId,
      snapshot: snapshotSummary(loop.snapshot(input.projectId)),
    };
  }
  throw new Error(`Unknown MCP tool: ${name}`);
}

function validateToolInput(name, input) {
  assertPlainObject(input, 'Input must be an object');
  if (name === MCP_TOOL_NAMES.LIST_PROJECTS) return validateListProjectsInput(input);
  if (name === MCP_TOOL_NAMES.GET_PROJECT) return validateProjectIdInput(input);
  if (name === MCP_TOOL_NAMES.CREATE_PROJECT) return validateCreateProjectInput(input);
  if (name === MCP_TOOL_NAMES.LIST_REQUIREMENTS) return validateListIntakesInput(input);
  if (name === MCP_TOOL_NAMES.CREATE_REQUIREMENT) return validateCreateRequirementInput(input);
  if (name === MCP_TOOL_NAMES.LIST_FEEDBACK) return validateListIntakesInput(input);
  if (name === MCP_TOOL_NAMES.CREATE_FEEDBACK) return validateCreateFeedbackInput(input);
  if (name === MCP_TOOL_NAMES.LIST_PLANS) return validateListPlansInput(input);
  if (name === MCP_TOOL_NAMES.GET_PLAN) return validateGetPlanInput(input);
  if (name === MCP_TOOL_NAMES.LIST_TASKS) return validateListTasksInput(input);
  if (name === MCP_TOOL_NAMES.START_LOOP) return validateProjectIdInput(input);
  if (name === MCP_TOOL_NAMES.STOP_LOOP) return validateProjectIdInput(input);
  throw new Error(`Unknown MCP tool: ${name}`);
}

function validateListProjectsInput(input) {
  return stripUndefined({
    query: optionalString(input, 'query', LIMITS.query),
    limit: optionalLimit(input),
  });
}

function validateProjectIdInput(input) {
  return {
    projectId: requiredPositiveInteger(input, 'projectId'),
  };
}

function validateCreateProjectInput(input) {
  return stripUndefined({
    name: requiredString(input, 'name', LIMITS.name),
    workspacePath: requiredString(input, 'workspacePath', LIMITS.workspacePath),
    description: optionalString(input, 'description', LIMITS.description),
    ...validatedAgentCliInput(input),
  });
}

function validateListIntakesInput(input) {
  return stripUndefined({
    projectId: requiredPositiveInteger(input, 'projectId'),
    status: optionalEnum(input, 'status', INTAKE_STATUSES),
    limit: optionalLimit(input),
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

function validateListPlansInput(input) {
  return stripUndefined({
    projectId: requiredPositiveInteger(input, 'projectId'),
    status: optionalEnum(input, 'status', PLAN_STATUSES),
    limit: optionalLimit(input),
  });
}

function validateGetPlanInput(input) {
  return {
    projectId: requiredPositiveInteger(input, 'projectId'),
    planId: requiredPositiveInteger(input, 'planId'),
  };
}

function validateListTasksInput(input) {
  return stripUndefined({
    projectId: requiredPositiveInteger(input, 'projectId'),
    planId: optionalPositiveInteger(input, 'planId'),
    status: optionalEnum(input, 'status', TASK_STATUSES),
    limit: optionalLimit(input),
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
  if (!Array.isArray(input.attachments)) throw new Error('attachments must be an array');
  if (input.attachments.length > LIMITS.attachments) throw new Error(`attachments supports at most ${LIMITS.attachments} items`);
  return input.attachments.map((attachment, index) => validateAttachment(attachment, index));
}

function validateAttachment(attachment, index) {
  assertPlainObject(attachment, `attachments[${index}] must be an object`);
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
    throw new Error(`attachments[${index}] needs name, path, dataUrl, base64, dataBase64, or bytes`);
  }
  return normalized;
}

function requiredString(input, key, maxLength) {
  if (!Object.prototype.hasOwnProperty.call(input, key)) throw new Error(`${key} is required`);
  const value = stringValue(input[key], key, maxLength);
  if (!value) throw new Error(`${key} cannot be empty`);
  return value;
}

function optionalString(input, key, maxLength) {
  if (input[key] === undefined || input[key] === null) return undefined;
  return stringValue(input[key], key, maxLength);
}

function stringValue(value, key, maxLength) {
  if (typeof value !== 'string') throw new Error(`${key} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length > maxLength) throw new Error(`${key} cannot exceed ${maxLength} characters`);
  return trimmed;
}

function requiredPositiveInteger(input, key) {
  const value = positiveIntegerValue(input[key], key);
  if (!value) throw new Error(`${key} must be an integer greater than 0`);
  return value;
}

function optionalPositiveInteger(input, key, options = {}) {
  if (input[key] === undefined) return undefined;
  if (input[key] === null && options.nullable) return null;
  const value = positiveIntegerValue(input[key], key);
  if (!value) throw new Error(`${key} must be an integer greater than 0`);
  return value;
}

function positiveIntegerValue(value, key) {
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new Error(`${key} must be an integer`);
  return value > 0 ? value : 0;
}

function optionalLimit(input) {
  if (input.limit === undefined || input.limit === null) return 100;
  if (typeof input.limit !== 'number' || !Number.isInteger(input.limit) || input.limit < 1 || input.limit > LIMITS.rows) {
    throw new Error(`limit must be an integer from 1 to ${LIMITS.rows}`);
  }
  return input.limit;
}

function optionalBoolean(input, key) {
  if (input[key] === undefined || input[key] === null) return undefined;
  if (typeof input[key] !== 'boolean') throw new Error(`${key} must be a boolean`);
  return input[key];
}

function optionalNonNegativeInteger(input, key) {
  if (input[key] === undefined || input[key] === null) return undefined;
  if (typeof input[key] !== 'number' || !Number.isInteger(input[key]) || input[key] < 0) {
    throw new Error(`${key} must be a non-negative integer`);
  }
  return input[key];
}

function optionalEnum(input, key, values) {
  if (input[key] === undefined || input[key] === null) return undefined;
  if (typeof input[key] !== 'string') throw new Error(`${key} must be a string`);
  if (!values.includes(input[key])) throw new Error(`${key} must be one of: ${values.join(', ')}`);
  return input[key];
}

function optionalByteArray(input, key) {
  if (input[key] === undefined || input[key] === null) return undefined;
  if (!Array.isArray(input[key])) throw new Error(`${key} must be a byte array`);
  if (input[key].length > LIMITS.attachmentData) throw new Error(`${key} cannot exceed ${LIMITS.attachmentData} bytes`);
  for (const value of input[key]) {
    if (!Number.isInteger(value) || value < 0 || value > 255) throw new Error(`${key} items must be integers from 0 to 255`);
  }
  return input[key];
}

function assertPlainObject(value, message) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(message);
}

function stripUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter((entry) => entry[1] !== undefined));
}

function requiredDb(context) {
  if (!context?.db) throw new Error('MCP database is not initialized');
  return context.db;
}

function requiredLoop(context) {
  if (!context?.loop) throw new Error('MCP loop service is not initialized');
  return context.loop;
}

function requiredIntakeService(context) {
  if (!context?.intakeService) throw new Error('MCP intake service is not initialized');
  return context.intakeService;
}

function requiredProject(loop, projectId) {
  if (!loop) throw new Error('MCP loop service is not initialized');
  const project = loop.project(projectId);
  if (!project) throw new Error('Project not found');
  return project;
}

function requiredPlan(db, projectId, planId) {
  const plan = db.get('SELECT * FROM plans WHERE id = ? AND project_id = ?', [planId, projectId]);
  if (!plan) throw new Error('Plan not found');
  return plan;
}

function latestIntake(db, table, projectId) {
  if (!db) return null;
  return db.get(`SELECT * FROM ${table} WHERE project_id = ? ORDER BY id DESC LIMIT 1`, [projectId]);
}

function listProjectRows(db, input) {
  const params = [];
  let where = '';
  if (input.query) {
    where = 'WHERE name LIKE ? OR workspace_path LIKE ? OR description LIKE ?';
    const query = `%${input.query}%`;
    params.push(query, query, query);
  }
  params.push(input.limit || 100);
  return db.all(`SELECT * FROM projects ${where} ORDER BY updated_at DESC, id DESC LIMIT ?`, params);
}

function listIntakeRows(db, table, input) {
  const params = [input.projectId];
  let statusClause = '';
  if (input.status) {
    statusClause = ' AND status = ?';
    params.push(input.status);
  }
  params.push(input.limit || 100);
  return db.all(
    `SELECT * FROM ${table}
     WHERE project_id = ?${statusClause}
     ORDER BY updated_at DESC, id DESC
     LIMIT ?`,
    params,
  );
}

function listPlanRows(db, input) {
  const params = [input.projectId];
  let statusClause = '';
  if (input.status) {
    statusClause = ' AND status = ?';
    params.push(input.status);
  }
  params.push(input.limit || 100);
  return db.all(
    `SELECT * FROM plans
     WHERE project_id = ?${statusClause}
     ORDER BY sort_order ASC, created_at ASC, id ASC
     LIMIT ?`,
    params,
  );
}

function listTaskRows(db, input) {
  const params = [input.projectId];
  let filterClause = '';
  if (input.planId) {
    filterClause += ' AND plan_tasks.plan_id = ?';
    params.push(input.planId);
  }
  if (input.status) {
    filterClause += ' AND plan_tasks.status = ?';
    params.push(input.status);
  }
  params.push(input.limit || 100);
  return db.all(
    `SELECT plan_tasks.*, plans.project_id, plans.file_path AS plan_file_path
     FROM plan_tasks
     JOIN plans ON plans.id = plan_tasks.plan_id
     WHERE plans.project_id = ?${filterClause}
     ORDER BY plans.sort_order ASC, plans.created_at ASC, plans.id ASC,
              plan_tasks.sort_order ASC, plan_tasks.id ASC
     LIMIT ?`,
    params,
  );
}

function projectSummary(project, loop = null) {
  const state = loop?.status ? loop.status(project.id) : null;
  return {
    id: project.id,
    name: project.name,
    workspacePath: project.workspace_path || '',
    description: project.description || '',
    createdAt: project.created_at,
    updatedAt: project.updated_at,
    state: state ? stateSummary(state) : null,
  };
}

function stateSummary(state) {
  return {
    running: Boolean(state.running),
    phase: state.phase || 'idle',
    intervalSeconds: Number(state.interval_seconds || 5),
    validationCommand: state.validation_command || '',
    agentCliProvider: state.agent_cli_provider || null,
    codexReasoningEffort: state.codex_reasoning_effort || null,
  };
}

function intakeSummary(record) {
  if (!record) return null;
  return {
    id: record.id,
    projectId: record.project_id,
    requirementId: record.requirement_id || null,
    linkedPlanId: record.linked_plan_id || null,
    title: record.title,
    status: record.status,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
  };
}

function intakeDetail(record) {
  if (!record) return null;
  return {
    ...intakeSummary(record),
    body: record.body || '',
    agentCliProvider: record.agent_cli_provider || null,
    agentCliCommand: record.agent_cli_command || '',
    codexReasoningEffort: record.codex_reasoning_effort || null,
  };
}

function planSummary(plan) {
  if (!plan) return null;
  return {
    id: plan.id,
    projectId: plan.project_id,
    issueHash: plan.issue_hash || '',
    filePath: plan.file_path || '',
    hash: plan.hash || '',
    status: plan.status || 'pending',
    sortOrder: Number(plan.sort_order || 0),
    totalTasks: Number(plan.total_tasks || 0),
    completedTasks: Number(plan.completed_tasks || 0),
    validationPassed: Boolean(plan.validation_passed),
    agentCliProvider: plan.agent_cli_provider || null,
    agentCliCommand: plan.agent_cli_command || '',
    agentCliSessionId: plan.agent_cli_session_id || null,
    codexReasoningEffort: plan.codex_reasoning_effort || null,
    createdAt: plan.created_at,
    updatedAt: plan.updated_at,
  };
}

function taskSummary(task) {
  if (!task) return null;
  return {
    id: task.id,
    projectId: task.project_id || null,
    planId: task.plan_id,
    planFilePath: task.plan_file_path || task.file_path || '',
    taskKey: task.task_key,
    title: task.title,
    rawLine: task.raw_line,
    scope: task.scope || '',
    status: task.status || 'pending',
    sortOrder: Number(task.sort_order || 0),
    startedAt: task.started_at || null,
    finishedAt: task.finished_at || null,
    durationMs: Number(task.duration_ms || 0),
    codexSessionId: task.codex_session_id || null,
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
    state: snapshot.state ? stateSummary(snapshot.state) : null,
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
  const message = error?.message || String(error || 'Unknown error');
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

function intakeListSchema(statusValues) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['projectId'],
    properties: {
      ...PROJECT_ID_SCHEMA,
      status: { type: 'string', enum: statusValues },
      ...LIMIT_SCHEMA,
    },
  };
}

function projectActionSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['projectId'],
    properties: PROJECT_ID_SCHEMA,
  };
}

module.exports = {
  MCP_TOOL_DEFINITIONS,
  MCP_TOOL_NAMES,
  callMcpTool,
  registerMcpTools,
};
