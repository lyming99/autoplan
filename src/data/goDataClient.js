'use strict';

const crypto = require('node:crypto');

const RUNTIME_COMMAND_PATH = '/api/v1/runtime/commands';
const PROJECTS_PATH = '/api/v1/projects';
const CONTRACT_VERSION = 'v1';
const RUNTIME_COMMANDS = Object.freeze({
  LOOP_START: 'loop.start', LOOP_STOP: 'loop.stop', LOOP_RUN_ONCE: 'loop.run_once',
  PLAN_GENERATE: 'plan.generate', PLAN_PARSE: 'plan.parse', PLAN_RUN: 'plan.run',
  PLAN_STOP: 'plan.stop', PLAN_RESUME: 'plan.resume', PLAN_REEXECUTE: 'plan.reexecute', PLAN_RECREATE: 'plan.recreate', PLAN_VALIDATE: 'plan.validate',
  TASK_RUN: 'task.run', TASK_RUN_BATCHES: 'task.run_batches', TASK_STOP: 'task.stop',
  ACCEPTANCE_ACCEPT: 'acceptance.accept', ACCEPTANCE_UNACCEPT: 'acceptance.unaccept', ACCEPTANCE_REDO: 'acceptance.redo',
  ACCEPTANCE_ACCEPT_BATCH: 'acceptance.accept_batch', ACCEPTANCE_UNACCEPT_BATCH: 'acceptance.unaccept_batch',
  INTAKE_RETRY_PLAN_GENERATION: 'intake.retry_plan_generation',
  CHAT_SEND: 'chat.send', CHAT_STOP: 'chat.stop', CHAT_PUMP: 'chat.pump', CHAT_GENERATE_TITLE: 'chat.generate_title', CHAT_CLEAR: 'chat.clear',
  SCRIPT_RUN: 'script.run', SCRIPT_STOP: 'script.stop',
  EXECUTOR_RUN: 'executor.run', EXECUTOR_STOP: 'executor.stop', EXECUTOR_ACTION: 'executor.action',
  MCP_START: 'mcp.start', MCP_STOP: 'mcp.stop', TERMINAL_CONFIGURE: 'terminal.configure', UPDATE_CONFIGURE: 'update.configure',
});

const STABLE_ERROR_CODES = new Set([
  'invalid_runtime_command', 'precondition_failed', 'operation_cancelled',
  'service_unavailable', 'request_timeout', 'unauthorized', 'origin_forbidden',
  'idempotency_key_reused', 'request_in_progress', 'automation_not_found',
  'invalid_automation', 'operation_state_conflict', 'legacy_adapter_disabled', 'internal_error',
]);

class GoDataClientError extends Error {
  constructor(code, options = {}) {
    super(code);
    this.name = 'GoDataClientError';
    this.code = STABLE_ERROR_CODES.has(code) ? code : 'service_unavailable';
    this.status = Number.isInteger(options.status) ? options.status : null;
    this.requestId = safeIdentifier(options.requestId, 64);
    this.retryable = options.retryable === true;
  }
}

/**
 * The Node-to-Go compatibility client intentionally has only typed methods.
 * It has no query/run/insert/table API and never falls back to IPC or sql.js.
 */
class GoDataClient {
  constructor(options = {}) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl || options.goApiUrl);
    this.fetch = options.fetch || globalThis.fetch;
    if (typeof this.fetch !== 'function') throw new GoDataClientError('service_unavailable');
    this.origin = normalizeOrigin(options.origin);
    this.sessionHeaderName = normalizeHeaderName(options.sessionHeaderName);
    this.sessionToken = typeof options.sessionToken === 'string' ? options.sessionToken : '';
    this.callerScope = safeIdentifier(options.callerScope || 'node-runtime', 128) || 'node-runtime';
    // Retries preserve the exact request and idempotency key. They can never
    // select sql.js or a second Node execution owner.
    this.retryAttempts = normalizeRetryAttempts(options.retryAttempts);
    this.retryDelayMs = normalizeRetryDelay(options.retryDelayMs);
    this.logger = options.logger || null;
    this.snapshots = new Map();
    this.operationOwners = new Map();
  }

  snapshot(projectId) {
    return this.snapshots.get(Number(projectId)) || null;
  }

  operationOwner(operationId) {
    return this.operationOwners.get(String(operationId || '')) || null;
  }

  async executeRuntimeCommand(command, input = {}, options = {}) {
    const payload = buildCommand(command, input);
    const requestId = safeIdentifier(options.requestId, 64) || createIdentifier('node');
    const idempotencyKey = safeIdentifier(options.idempotencyKey, 128) || createIdentifier('intent');
    const callerScope = safeIdentifier(options.callerScope, 128) || this.callerScope;
    const retryAttempts = options.retryAttempts === undefined ? this.retryAttempts : normalizeRetryAttempts(options.retryAttempts);
    let attempt = 0;
    while (true) {
      try {
        const result = await this.#request(payload, { requestId, idempotencyKey, callerScope, signal: options.signal, timeoutMs: options.timeoutMs });
        if (result.snapshot && payload.project_id > 0) this.snapshots.set(payload.project_id, result.snapshot);
        if (result.operation?.operation_id) this.operationOwners.set(result.operation.operation_id, 'go');
        return result;
      } catch (error) {
        const stable = asGoDataClientError(error);
        if (!stable.retryable || attempt >= retryAttempts || options.signal?.aborted) throw stable;
        this.#logRetry(stable, attempt + 1);
        await waitForRetry(this.retryDelayMs, options.signal);
        attempt += 1;
      }
    }
  }

  startLoop(projectId, options) { return this.executeRuntimeCommand(RUNTIME_COMMANDS.LOOP_START, { projectId }, options); }
  stopLoop(projectId, options) { return this.executeRuntimeCommand(RUNTIME_COMMANDS.LOOP_STOP, { projectId }, options); }
  runLoopOnce(projectId, options) { return this.executeRuntimeCommand(RUNTIME_COMMANDS.LOOP_RUN_ONCE, { projectId }, options); }
  generatePlan(projectId, intakeId, options) { return this.executeRuntimeCommand(RUNTIME_COMMANDS.PLAN_GENERATE, { projectId, intakeId }, options); }
  parsePlan(projectId, planId, options) { return this.executeRuntimeCommand(RUNTIME_COMMANDS.PLAN_PARSE, { projectId, planId }, options); }
  runPlan(projectId, planId, options) { return this.executeRuntimeCommand(RUNTIME_COMMANDS.PLAN_RUN, { projectId, planId }, options); }
  stopPlan(projectId, planId, options) { return this.executeRuntimeCommand(RUNTIME_COMMANDS.PLAN_STOP, { projectId, planId }, options); }
  resumePlan(projectId, planId, options) { return this.executeRuntimeCommand(RUNTIME_COMMANDS.PLAN_RESUME, { projectId, planId }, options); }
  reexecutePlan(projectId, planId, options) { return this.executeRuntimeCommand(RUNTIME_COMMANDS.PLAN_REEXECUTE, { projectId, planId }, options); }
  recreatePlan(projectId, planId, options) { return this.executeRuntimeCommand(RUNTIME_COMMANDS.PLAN_RECREATE, { projectId, planId }, options); }
  validatePlan(projectId, planId, options) { return this.executeRuntimeCommand(RUNTIME_COMMANDS.PLAN_VALIDATE, { projectId, planId }, options); }
  runTask(projectId, planId, taskId, options) { return this.executeRuntimeCommand(RUNTIME_COMMANDS.TASK_RUN, { projectId, planId, taskId }, options); }
  runTaskBatches(projectId, planId, batches, options) { return this.executeRuntimeCommand(RUNTIME_COMMANDS.TASK_RUN_BATCHES, { projectId, planId, batches }, options); }
  stopTask(projectId, planId, taskId, options) { return this.executeRuntimeCommand(RUNTIME_COMMANDS.TASK_STOP, { projectId, planId, taskId }, options); }
  acceptItem(projectId, targetType, targetId, options) { return this.#acceptance(RUNTIME_COMMANDS.ACCEPTANCE_ACCEPT, projectId, targetType, targetId, options); }
  unacceptItem(projectId, targetType, targetId, options) { return this.#acceptance(RUNTIME_COMMANDS.ACCEPTANCE_UNACCEPT, projectId, targetType, targetId, options); }
  redoAcceptanceItem(projectId, targetType, targetId, options) { return this.#acceptance(RUNTIME_COMMANDS.ACCEPTANCE_REDO, projectId, targetType, targetId, options); }
  acceptItems(projectId, targets, options) { return this.#acceptanceBatch(RUNTIME_COMMANDS.ACCEPTANCE_ACCEPT_BATCH, projectId, targets, options); }
  unacceptItems(projectId, targets, options) { return this.#acceptanceBatch(RUNTIME_COMMANDS.ACCEPTANCE_UNACCEPT_BATCH, projectId, targets, options); }
  async retryIntakePlanGeneration(projectId, intakeType, intakeId, options = {}) {
    if (intakeType !== 'requirement' && intakeType !== 'feedback') throw new GoDataClientError('invalid_runtime_command');
    const project = positiveProcessIdentifier(projectId);
    const id = positiveProcessIdentifier(intakeId);
    const requestId = safeIdentifier(options.requestId, 64) || createIdentifier('node');
    const idempotencyKey = safeIdentifier(options.idempotencyKey, 128) || createIdentifier('intent');
    const callerScope = safeIdentifier(options.callerScope, 128) || this.callerScope;
    const metadata = { requestId, idempotencyKey, callerScope, signal: options.signal, timeoutMs: options.timeoutMs };
    const response = await this.#processRequest(
      `${PROJECTS_PATH}/${project}/intake/${intakeType}/${id}/actions/retry-plan-generation`, metadata,
    );
    const snapshot = response?.data?.snapshot;
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) throw new GoDataClientError('service_unavailable');
    this.snapshots.set(project, snapshot);
    // Do not wait for the next interval after an explicit retry. Admission is
    // still owned by the typed Loop command; an already active cycle is a safe
    // no-op and the reset snapshot remains the successful retry result.
    try {
      const run = await this.runLoopOnce(project, {
        ...options,
        requestId: createIdentifier('retry'),
        idempotencyKey: createIdentifier('retry-run'),
      });
      return { ...run, snapshot };
    } catch (error) {
      const stable = asGoDataClientError(error);
      if (stable.code !== 'precondition_failed') throw stable;
      return { snapshot };
    }
  }
  sendChat(projectId, conversationId, content, options) { return this.executeRuntimeCommand(RUNTIME_COMMANDS.CHAT_SEND, { projectId, conversationId, chat: { content } }, options); }
  stopChat(projectId, conversationId, options) { return this.executeRuntimeCommand(RUNTIME_COMMANDS.CHAT_STOP, { projectId, conversationId }, options); }
  pumpChat(projectId, conversationId, options) { return this.executeRuntimeCommand(RUNTIME_COMMANDS.CHAT_PUMP, { projectId, conversationId }, options); }
  generateChatTitle(projectId, conversationId, options) { return this.executeRuntimeCommand(RUNTIME_COMMANDS.CHAT_GENERATE_TITLE, { projectId, conversationId }, options); }
  clearChat(projectId, conversationId, options) { return this.executeRuntimeCommand(RUNTIME_COMMANDS.CHAT_CLEAR, { projectId, conversationId }, options); }
  // Process ownership is selected by the renderer feature gate, but legacy
  // IPC fallback still reaches the Go-owned data only through these fixed
  // resource routes. No SQL, command, cwd, env, PID or generic runtime body
  // can cross this compatibility boundary.
  runScript(projectId, scriptId, options) {
    return this.#processAction(projectId, scriptId, 'scripts', 'run', ['script.run'], options);
  }
  stopScript(projectId, scriptId, options) {
    return this.#processAction(projectId, scriptId, 'scripts', 'stop', ['script.run'], options);
  }
  runExecutor(projectId, executorId, options) {
    return this.#processAction(projectId, executorId, 'executors', 'run', ['executor.run'], options);
  }
  stopExecutor(projectId, executorId, options) {
    return this.#processAction(projectId, executorId, 'executors', 'stop', ['executor.run', 'executor.action'], options);
  }
  async runExecutorAction(projectId, executorId, action, options) {
    if (action === 'stop') return this.stopExecutor(projectId, executorId, options);
    if (action !== 'start' && action !== 'reload') throw new GoDataClientError('invalid_runtime_command');
    return this.#processAction(projectId, executorId, 'executors', action, ['executor.run', 'executor.action'], options);
  }
  // MCP lifecycle remains a typed Go command. It never starts the historical
  // Node HTTP/stdio server as a retry or rollback fallback.
  startMcp(options) { return this.executeRuntimeCommand(RUNTIME_COMMANDS.MCP_START, { projectId: 0 }, options); }
  stopMcp(options) { return this.executeRuntimeCommand(RUNTIME_COMMANDS.MCP_STOP, { projectId: 0 }, options); }
  configureTerminal(terminal, options) { return this.executeRuntimeCommand(RUNTIME_COMMANDS.TERMINAL_CONFIGURE, { projectId: 0, terminal }, options); }
  configureUpdates(updates, options) { return this.executeRuntimeCommand(RUNTIME_COMMANDS.UPDATE_CONFIGURE, { projectId: 0, updates }, options); }

  #acceptance(command, projectId, targetType, targetId, options) {
    if (targetType !== 'plan' && targetType !== 'task') throw new GoDataClientError('invalid_runtime_command');
    return this.executeRuntimeCommand(command, {
      projectId,
      acceptance: {
        targets: [{ targetType, id: positiveProcessIdentifier(targetId) }],
        ...(command === RUNTIME_COMMANDS.ACCEPTANCE_REDO && typeof options?.supplement === 'string'
          ? { supplement: options.supplement } : {}),
      },
    }, options);
  }

  #acceptanceBatch(command, projectId, targets, options) {
    return this.executeRuntimeCommand(command, { projectId, acceptance: { targets } }, options);
  }

  #logRetry(error, attempt) {
    try {
      this.logger?.warn?.('[go-data-client] retry', { code: error.code, status: error.status, attempt });
    } catch {
      // Logging is best effort and deliberately excludes endpoint, headers,
      // request data, chat content, and server-supplied error text.
    }
  }

  async #processAction(projectId, resourceId, resource, action, operationTypes, options = {}) {
    const project = positiveProcessIdentifier(projectId);
    const id = positiveProcessIdentifier(resourceId);
    const requestId = safeIdentifier(options.requestId, 64) || createIdentifier('node');
    const idempotencyKey = safeIdentifier(options.idempotencyKey, 128) || createIdentifier('intent');
    const callerScope = safeIdentifier(options.callerScope, 128) || this.callerScope;
    const path = `${PROJECTS_PATH}/${project}/${resource}/${id}/actions/${action}`;
    const response = await this.#processRequest(path, { requestId, idempotencyKey, callerScope, signal: options.signal, timeoutMs: options.timeoutMs });
    const data = response?.data;
    const operation = action === 'stop' ? processStopOperation(data, requestId, operationTypes) : processOperation(data, requestId, operationTypes);
    if (operation?.operation_id) this.operationOwners.set(operation.operation_id, 'go');
    const snapshot = await this.#projectSnapshot(project, { requestId, callerScope, signal: options.signal, timeoutMs: options.timeoutMs });
    this.snapshots.set(project, snapshot);
    return { ...(operation ? { operation } : {}), snapshot };
  }

  async #projectSnapshot(projectId, metadata) {
    const response = await this.#processRequest(`${PROJECTS_PATH}/${projectId}/snapshot`, metadata, 'GET', undefined, false);
    if (!response?.data || typeof response.data !== 'object' || Array.isArray(response.data)) {
      throw new GoDataClientError('service_unavailable');
    }
    return response.data;
  }

  async #processRequest(path, metadata, method = 'POST', payload = {}, includeIdempotency = true) {
    const controller = new AbortController();
    const timeout = setAbortTimeout(controller, metadata.timeoutMs);
    const onAbort = () => controller.abort();
    metadata.signal?.addEventListener?.('abort', onAbort, { once: true });
    try {
      const headers = {
        accept: 'application/json',
        'x-request-id': metadata.requestId,
        'x-autoplan-caller-scope': metadata.callerScope,
      };
      if (method !== 'GET') {
        headers['content-type'] = 'application/json';
        if (includeIdempotency) headers['idempotency-key'] = metadata.idempotencyKey;
      }
      if (this.origin) headers.origin = this.origin;
      if (this.sessionHeaderName && this.sessionToken) headers[this.sessionHeaderName] = this.sessionToken;
      const response = await this.fetch(`${this.baseUrl}${path}`, {
        method, headers, ...(method === 'GET' ? {} : { body: JSON.stringify(payload) }), signal: controller.signal,
      });
      const body = await parseJsonResponse(response);
      if (!response?.ok) throw responseError(response, body);
      if (!body || typeof body !== 'object' || Array.isArray(body) ||
          !safeIdentifier(body.request_id || response?.headers?.get?.('x-request-id'), 64)) {
        throw new GoDataClientError('service_unavailable');
      }
      return body;
    } catch (error) {
      if (metadata.signal?.aborted || error?.name === 'AbortError') throw new GoDataClientError('operation_cancelled');
      throw asGoDataClientError(error);
    } finally {
      clearAbortTimeout(timeout);
      metadata.signal?.removeEventListener?.('abort', onAbort);
    }
  }

  async #request(payload, metadata) {
    const controller = new AbortController();
    const timeout = setAbortTimeout(controller, metadata.timeoutMs);
    const onAbort = () => controller.abort();
    metadata.signal?.addEventListener?.('abort', onAbort, { once: true });
    try {
      const headers = {
        accept: 'application/json',
        'content-type': 'application/json',
        'x-request-id': metadata.requestId,
        'idempotency-key': metadata.idempotencyKey,
        'x-autoplan-caller-scope': metadata.callerScope,
      };
      if (this.origin) headers.origin = this.origin;
      if (this.sessionHeaderName && this.sessionToken) headers[this.sessionHeaderName] = this.sessionToken;
      const response = await this.fetch(`${this.baseUrl}${RUNTIME_COMMAND_PATH}`, {
        method: 'POST', headers, body: JSON.stringify(payload), signal: controller.signal,
      });
      const body = await parseJsonResponse(response);
      if (!response?.ok) throw responseError(response, body);
      const result = body?.data;
      if (!isRuntimeResult(result, metadata.requestId, payload.command)) throw new GoDataClientError('service_unavailable');
      return result;
    } catch (error) {
      if (metadata.signal?.aborted || error?.name === 'AbortError') {
        throw new GoDataClientError('operation_cancelled');
      }
      throw asGoDataClientError(error);
    } finally {
      clearAbortTimeout(timeout);
      metadata.signal?.removeEventListener?.('abort', onAbort);
    }
  }

}

function buildCommand(command, input) {
  if (!Object.values(RUNTIME_COMMANDS).includes(command) || !input || typeof input !== 'object' || Array.isArray(input)) {
    throw new GoDataClientError('invalid_runtime_command');
  }
  // P12 process families are intentionally absent from the generic bridge.
  // They have fixed P006 resource routes so a caller cannot add action,
  // command or ownership-shaped fields to a runtime command envelope.
  if ([
    RUNTIME_COMMANDS.SCRIPT_RUN, RUNTIME_COMMANDS.SCRIPT_STOP,
    RUNTIME_COMMANDS.EXECUTOR_RUN, RUNTIME_COMMANDS.EXECUTOR_STOP, RUNTIME_COMMANDS.EXECUTOR_ACTION,
  ].includes(command)) {
    throw new GoDataClientError('invalid_runtime_command');
  }
  const allowed = new Set(['projectId', 'planId', 'taskId', 'intakeId', 'conversationId', 'scriptId', 'executorId', 'expectedVersion', 'expectedUpdatedAt', 'action', 'chat', 'batches', 'acceptance', 'terminal', 'updates']);
  if (Object.keys(input).some((key) => !allowed.has(key))) throw new GoDataClientError('invalid_runtime_command');
  const payload = { version: CONTRACT_VERSION, command, project_id: positiveOrZero(input.projectId) };
  copyPositive(payload, 'plan_id', input.planId);
  copyPositive(payload, 'task_id', input.taskId);
  copyPositive(payload, 'intake_id', input.intakeId);
  copyPositive(payload, 'conversation_id', input.conversationId);
  copyPositive(payload, 'script_id', input.scriptId);
  copyPositive(payload, 'executor_id', input.executorId);
  copyPositive(payload, 'expected_version', input.expectedVersion);
  copyText(payload, 'expected_updated_at', input.expectedUpdatedAt, 64);
  copyText(payload, 'action', input.action, 64);
  if (input.chat !== undefined) payload.chat = validateChat(input.chat);
  if (input.batches !== undefined) payload.batches = validateBatches(input.batches);
  if (input.acceptance !== undefined) payload.acceptance = validateAcceptance(input.acceptance);
  if (input.terminal !== undefined) payload.terminal = validateObject(input.terminal, ['default_profile', 'initial_cwd', 'font_size', 'scrollback_limit', 'retain_on_exit', 'confirm_before_kill']);
  if (input.updates !== undefined) payload.updates = validateObject(input.updates, ['auto_check', 'interval_minutes']);
  return payload;
}

function positiveProcessIdentifier(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new GoDataClientError('invalid_runtime_command');
  return number;
}

function processOperation(value, requestId, types) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      !safeIdentifier(value.operation_id, 128) || !types.includes(value.type) ||
      !['queued', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted'].includes(value.status) ||
      value.request_id !== requestId || typeof value.accepted_at !== 'string' || !value.accepted_at) {
    throw new GoDataClientError('service_unavailable');
  }
  return {
    operation_id: value.operation_id,
    type: value.type,
    status: value.status,
    request_id: value.request_id,
    accepted_at: value.accepted_at,
  };
}

function processStopOperation(value, requestId, types) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      typeof value.stopped !== 'boolean' || typeof value.changed !== 'boolean') {
    throw new GoDataClientError('service_unavailable');
  }
  if (value.operation === undefined || value.operation === null) return null;
  return processOperation(value.operation, requestId, types);
}

function positiveOrZero(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new GoDataClientError('invalid_runtime_command');
  return number;
}

function copyPositive(target, key, value) {
  if (value === undefined || value === null) return;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new GoDataClientError('invalid_runtime_command');
  target[key] = number;
}

function copyText(target, key, value, maximum) {
  if (value === undefined || value === null) return;
  if (typeof value !== 'string' || !value || value.length > maximum || /[\r\n\0]/.test(value)) {
    throw new GoDataClientError('invalid_runtime_command');
  }
  target[key] = value;
}

function validateChat(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1 || typeof value.content !== 'string' || !value.content || value.content.length > 131072) {
    throw new GoDataClientError('invalid_runtime_command');
  }
  return { content: value.content };
}

function validateBatches(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) throw new GoDataClientError('invalid_runtime_command');
  const seen = new Set();
  return value.map((batch) => {
    if (!batch || typeof batch !== 'object' || Array.isArray(batch) || Object.keys(batch).length !== 1 || !Array.isArray(batch.taskIds) || batch.taskIds.length === 0 || batch.taskIds.length > 100) {
      throw new GoDataClientError('invalid_runtime_command');
    }
    const task_ids = batch.taskIds.map((id) => {
      const number = Number(id);
      if (!Number.isSafeInteger(number) || number <= 0 || seen.has(number)) throw new GoDataClientError('invalid_runtime_command');
      seen.add(number);
      return number;
    });
    return { task_ids };
  });
}

function validateAcceptance(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some((key) => !['targets', 'supplement'].includes(key)) ||
      !Array.isArray(value.targets) || value.targets.length === 0 || value.targets.length > 100 ||
      (value.supplement !== undefined && (typeof value.supplement !== 'string' ||
        [...value.supplement].length > 2000 || /[\r\0]/.test(value.supplement)))) {
    throw new GoDataClientError('invalid_runtime_command');
  }
  return {
    targets: value.targets.map((target) => {
      if (!target || typeof target !== 'object' || Array.isArray(target) ||
          Object.keys(target).some((key) => !['targetType', 'target_type', 'id'].includes(key))) {
        throw new GoDataClientError('invalid_runtime_command');
      }
      const targetType = target.targetType ?? target.target_type;
      if (targetType !== 'plan' && targetType !== 'task') throw new GoDataClientError('invalid_runtime_command');
      return { target_type: targetType, id: positiveProcessIdentifier(target.id) };
    }),
    ...(typeof value.supplement === 'string' ? { supplement: value.supplement } : {}),
  };
}

function validateObject(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new GoDataClientError('invalid_runtime_command');
  }
  return { ...value };
}

function normalizeBaseUrl(value) {
  let parsed;
  try { parsed = new URL(String(value || '')); } catch { throw new GoDataClientError('service_unavailable'); }
  if (parsed.protocol !== 'http:' || parsed.username || parsed.password || parsed.search || parsed.hash ||
      !['127.0.0.1', '[::1]'].includes(parsed.hostname) || !parsed.port) throw new GoDataClientError('service_unavailable');
  return parsed.toString().replace(/\/$/, '');
}

function normalizeOrigin(value) {
  if (value === undefined || value === null || value === '') return '';
  try {
    const parsed = new URL(String(value));
    return parsed.origin === 'null' ? '' : parsed.origin;
  } catch {
    throw new GoDataClientError('service_unavailable');
  }
}

function normalizeHeaderName(value) {
  if (value === undefined || value === null || value === '') return '';
  const name = String(value).trim();
  if (!/^[A-Za-z0-9-]{1,128}$/.test(name)) throw new GoDataClientError('service_unavailable');
  return name;
}

function normalizeRetryAttempts(value) {
  const count = value === undefined ? 0 : Number(value);
  if (!Number.isInteger(count) || count < 0 || count > 2) throw new GoDataClientError('service_unavailable');
  return count;
}

function normalizeRetryDelay(value) {
  const delay = value === undefined ? 25 : Number(value);
  if (!Number.isInteger(delay) || delay < 0 || delay > 1000) throw new GoDataClientError('service_unavailable');
  return delay;
}

function safeIdentifier(value, maximum) {
  const text = typeof value === 'string' ? value : '';
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(text) && text.length <= maximum ? text : '';
}

function createIdentifier(prefix) {
  const random = typeof crypto.randomUUID === 'function' ? crypto.randomUUID().replace(/-/g, '') : crypto.randomBytes(16).toString('hex');
  return `${prefix}-${random}`;
}

function setAbortTimeout(controller, timeoutMs) {
  if (timeoutMs === undefined || timeoutMs === null) return null;
  const value = Number(timeoutMs);
  if (!Number.isInteger(value) || value < 1 || value > 120000) throw new GoDataClientError('request_timeout');
  return setTimeout(() => controller.abort(), value);
}

function clearAbortTimeout(timeout) { if (timeout) clearTimeout(timeout); }

function waitForRetry(delay, signal) {
  if (signal?.aborted) return Promise.reject(new GoDataClientError('operation_cancelled'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, delay);
    const onAbort = () => { clearTimeout(timer); reject(new GoDataClientError('operation_cancelled')); };
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

async function parseJsonResponse(response) {
  try { return await response?.json?.(); } catch { return null; }
}

function responseError(response, body) {
  const failure = body?.error || body;
  const code = String(failure?.code || 'service_unavailable');
  return new GoDataClientError(code, {
    status: Number(response?.status), requestId: failure?.request_id || response?.headers?.get?.('x-request-id'), retryable: failure?.retryable === true || response?.status === 503 || response?.status === 504,
  });
}

function asGoDataClientError(error) {
  if (error instanceof GoDataClientError) return error;
  return new GoDataClientError('service_unavailable', { retryable: true });
}

function isRuntimeResult(value, requestId, command) {
  const operation = value?.operation;
  return Boolean(operation && typeof operation === 'object' && typeof operation.operation_id === 'string' && operation.operation_id &&
    operation.type === command && ['accepted', 'queued', 'running', 'completed', 'cancelled'].includes(operation.status) &&
    operation.request_id === requestId && typeof operation.accepted_at === 'string' && operation.accepted_at);
}

module.exports = { CONTRACT_VERSION, GoDataClient, GoDataClientError, RUNTIME_COMMAND_PATH, RUNTIME_COMMANDS };
