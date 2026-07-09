const { saveAttachments } = require('./attachments');
const { nowIso } = require('./database');
const { nextIntakeAgentCliConfig, nextIntakePlanGenerationConfig } = require('./loopService');

class IntakeService {
  constructor(options = {}) {
    this.db = options.db;
    this.loop = options.loop;
    this.attachmentsRoot = options.attachmentsRoot;
  }

  createProject(input = {}) {
    this.ensureReady();
    const now = nowIso();
    const name = String(input.name || '').trim() || titleFromBody(input.workspacePath, '未命名项目');
    const id = this.db.insert(
      `INSERT INTO projects (name, workspace_path, description, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
      [name, input.workspacePath || '', input.description || '', now, now],
    );
    this.loop.ensureProjectState(id);
    if (this.loop.hasRuntimeConfigInput(input)) {
      this.loop.configure(id, input);
    }
    this.startIfRequested(id, input);
    return this.loop.snapshot(id);
  }

  createRequirement(input = {}) {
    this.ensureReady();
    const projectId = this.requiredProjectId(input);
    const now = nowIso();
    const title = titleFromInput(input.title, input.body, '未命名需求');
    const body = input.body || '';
    this.rejectDuplicateRequirement(projectId, title, body);
    const projectState = this.loop.status(projectId) || {};
    const agentCliConfig = nextIntakeAgentCliConfig({}, input);
    const planGenerationConfig = nextIntakePlanGenerationConfig(projectState, input);
    const id = this.db.insert(
      `INSERT INTO requirements (
         project_id, title, body, status,
         agent_cli_provider, agent_cli_command, codex_reasoning_effort,
         plan_generation_strategy, plan_generation_provider, plan_generation_command,
         plan_generation_model, plan_generation_codex_reasoning_effort,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        projectId,
        title,
        body,
        input.status || 'open',
        agentCliConfig.provider,
        agentCliConfig.command,
        agentCliConfig.codexReasoningEffort,
        planGenerationConfig.strategy,
        planGenerationConfig.provider,
        planGenerationConfig.command,
        planGenerationConfig.model,
        planGenerationConfig.codexReasoningEffort,
        now,
        now,
      ],
    );
    saveAttachments(this.db, this.resolveAttachmentsRoot(), 'requirement', id, input.attachments, projectId);
    this.loop.addEvent(projectId, 'requirement.created', `需求 #${id} 已创建，等待循环扫描生成计划`);
    this.startIfRequested(projectId, input);
    return this.loop.snapshot(projectId);
  }

  createFeedback(input = {}) {
    this.ensureReady();
    const projectId = this.requiredProjectId(input);
    const requirementId = this.validRequirementId(projectId, input.requirementId);
    const now = nowIso();
    const title = titleFromInput(input.title, input.body, '未命名反馈');
    const body = input.body || '';
    this.rejectDuplicateFeedback(projectId, requirementId, title, body);
    const projectState = this.loop.status(projectId) || {};
    const agentCliConfig = nextIntakeAgentCliConfig({}, input);
    const planGenerationConfig = nextIntakePlanGenerationConfig(projectState, input);
    const id = this.db.insert(
      `INSERT INTO feedback (
         project_id, requirement_id, title, body, status,
         agent_cli_provider, agent_cli_command, codex_reasoning_effort,
         plan_generation_strategy, plan_generation_provider, plan_generation_command,
         plan_generation_model, plan_generation_codex_reasoning_effort,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        projectId,
        requirementId,
        title,
        body,
        input.status || 'open',
        agentCliConfig.provider,
        agentCliConfig.command,
        agentCliConfig.codexReasoningEffort,
        planGenerationConfig.strategy,
        planGenerationConfig.provider,
        planGenerationConfig.command,
        planGenerationConfig.model,
        planGenerationConfig.codexReasoningEffort,
        now,
        now,
      ],
    );
    saveAttachments(this.db, this.resolveAttachmentsRoot(), 'feedback', id, input.attachments, projectId);
    this.loop.addEvent(projectId, 'feedback.created', `反馈 #${id} 已创建，等待循环扫描生成计划`);
    this.startIfRequested(projectId, input);
    return this.loop.snapshot(projectId);
  }

  ensureReady() {
    if (!this.db || !this.loop) throw new Error('写入服务尚未初始化');
  }

  requiredProjectId(input = {}) {
    const projectId = Number(input.projectId || input.id || 0);
    if (!projectId || !this.loop.project(projectId)) throw new Error('项目不存在');
    return projectId;
  }

  validRequirementId(projectId, value) {
    const requirementId = Number(value || 0);
    if (!requirementId) return null;
    const requirement = this.db.get('SELECT id, project_id FROM requirements WHERE id = ?', [requirementId]);
    if (!requirement) throw new Error('关联需求不存在');
    if (Number(requirement.project_id) !== Number(projectId)) throw new Error('关联需求不属于当前项目');
    return requirementId;
  }

  rejectDuplicateRequirement(projectId, title, body) {
    const duplicate = this.findDuplicateRequirement(projectId, title, body);
    if (duplicate) {
      throw new DuplicateIntakeError('requirement', duplicate);
    }
  }

  rejectDuplicateFeedback(projectId, requirementId, title, body) {
    const duplicate = this.findDuplicateFeedback(projectId, requirementId, title, body);
    if (duplicate) {
      throw new DuplicateIntakeError('feedback', duplicate);
    }
  }

  findDuplicateRequirement(projectId, title, body) {
    return findDuplicateIntake(
      this.db.all(
        `SELECT id, project_id, title, body, status
         FROM requirements
         WHERE project_id = ?
           AND COALESCE(status, 'open') <> 'closed'
         ORDER BY id ASC`,
        [projectId],
      ),
      title,
      body,
    );
  }

  findDuplicateFeedback(projectId, requirementId, title, body) {
    return findDuplicateIntake(
      this.db.all(
        `SELECT id, project_id, requirement_id, title, body, status
         FROM feedback
         WHERE project_id = ?
           AND COALESCE(status, 'open') <> 'closed'
           AND ((? IS NULL AND requirement_id IS NULL) OR requirement_id = ?)
         ORDER BY id ASC`,
        [projectId, requirementId, requirementId],
      ),
      title,
      body,
    );
  }

  resolveAttachmentsRoot() {
    return typeof this.attachmentsRoot === 'function' ? this.attachmentsRoot() : this.attachmentsRoot;
  }

  startIfRequested(projectId, input = {}) {
    if (input.autoRun === true) {
      this.loop.start(projectId);
    }
  }
}

class DuplicateIntakeError extends Error {
  constructor(intakeType, existing) {
    const label = intakeType === 'feedback' ? '反馈' : '需求';
    super(`${label}已存在：#${existing.id}`);
    this.name = 'DuplicateIntakeError';
    this.code = 'DUPLICATE_INTAKE';
    this.intakeType = intakeType;
    this.existingId = existing.id;
    this.existing = existing;
  }
}

function createIntakeService(options = {}) {
  return new IntakeService(options);
}

function titleFromBody(body, fallback) {
  const firstLine = String(body || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  return firstLine ? firstLine.slice(0, 80) : fallback;
}

function titleFromInput(title, body, fallback) {
  const explicitTitle = String(title ?? '').trim();
  return explicitTitle || titleFromBody(body, fallback);
}

function findDuplicateIntake(rows, title, body) {
  const normalizedTitle = normalizeDuplicateText(title);
  const normalizedBody = normalizeDuplicateText(body);
  return rows.find((row) => (
    normalizeDuplicateText(row.title) === normalizedTitle
    && normalizeDuplicateText(row.body) === normalizedBody
  )) || null;
}

function normalizeDuplicateText(value) {
  return String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[^\S\r\n]+/g, ' ').trim())
    .join('\n')
    .trim();
}

module.exports = {
  DuplicateIntakeError,
  IntakeService,
  createIntakeService,
  titleFromBody,
};
