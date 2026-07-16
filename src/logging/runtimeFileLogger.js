'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_ARCHIVES = 5;
const MAX_EXTERNAL_LINE_BYTES = 64 * 1024;
const SAFE_TOKEN = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/;
const SAFE_ROUTE = /^\/[a-zA-Z0-9._~!$&'()*+,;=:@%/-]{0,255}$/;
const SAFE_SESSION_FINGERPRINT = /^sha256:[a-f0-9]{64}$/;
const LEVELS = new Set(['debug', 'info', 'warn', 'error']);
const TOKEN_FIELDS = new Set([
  'source', 'error_code', 'request_id', 'channel', 'state', 'method',
  'provider', 'stage', 'operation_id', 'session_mode', 'context_state',
]);
const INTEGER_FIELDS = new Set([
  'status', 'duration_ms', 'project_id', 'intake_id', 'plan_id', 'task_id', 'pid', 'child_pid',
  'exit_code', 'stdout_bytes', 'stderr_bytes', 'stdout_lines', 'stderr_lines',
  'pending_intakes', 'generated_plans', 'processed_plans',
]);
const BOOLEAN_FIELDS = new Set([
  'retryable', 'timed_out', 'cancelled', 'output_truncated', 'redaction_failed',
]);

class RuntimeFileLogger {
  constructor(options = {}) {
    this.directory = validateDirectory(options.directory);
    this.filePath = path.join(this.directory, options.fileName || 'autoplan.log');
    this.maxBytes = boundedInteger(options.maxBytes, DEFAULT_MAX_BYTES, 256, 100 * 1024 * 1024);
    this.archives = boundedInteger(options.archives, DEFAULT_ARCHIVES, 1, 20);
    this.now = typeof options.now === 'function' ? options.now : () => new Date();
    this.externalBuffers = new Map();
    fs.mkdirSync(this.directory, { recursive: true });
  }

  log(level, code, fields = {}) {
    const event = sanitizeEvent({ ...fields, level, code }, this.now, fields.source || 'electron');
    return this.writeEvent(event);
  }

  writeExternalLine(source, line) {
    const safeSource = safeToken(source, 'sidecar');
    const text = Buffer.isBuffer(line) ? line.toString('utf8') : String(line || '');
    if (!text || Buffer.byteLength(text) > MAX_EXTERNAL_LINE_BYTES) {
      return this.log('warn', 'external_diagnostic_redacted', { source: safeSource });
    }
    try {
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid');
      return this.writeEvent(sanitizeEvent(parsed, this.now, safeSource));
    } catch {
      return this.log('warn', 'external_diagnostic_redacted', { source: safeSource });
    }
  }

  writeExternalChunk(source, chunk) {
    const safeSource = safeToken(source, 'sidecar');
    let pending = this.externalBuffers.get(safeSource) || '';
    pending += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk || '');
    if (Buffer.byteLength(pending) > MAX_EXTERNAL_LINE_BYTES * 2) {
      pending = '';
      this.log('warn', 'external_diagnostic_overflow', { source: safeSource });
    }
    const lines = pending.split(/\r?\n/);
    this.externalBuffers.set(safeSource, lines.pop() || '');
    for (const line of lines) {
      if (line) this.writeExternalLine(safeSource, line);
    }
  }

  flushExternal(source) {
    const safeSource = safeToken(source, 'sidecar');
    const pending = this.externalBuffers.get(safeSource) || '';
    this.externalBuffers.delete(safeSource);
    if (pending) this.writeExternalLine(safeSource, pending);
  }

  writeEvent(event) {
    try {
      const line = `${JSON.stringify(event)}\n`;
      this.rotateIfNeeded(Buffer.byteLength(line));
      fs.appendFileSync(this.filePath, line, { encoding: 'utf8', mode: 0o600 });
      return true;
    } catch {
      return false;
    }
  }

  rotateIfNeeded(incomingBytes) {
    const current = fs.statSync(this.filePath, { throwIfNoEntry: false });
    if (!current || current.size + incomingBytes <= this.maxBytes) return;
    for (let index = this.archives; index >= 1; index -= 1) {
      const target = `${this.filePath}.${index}`;
      if (index === this.archives) fs.rmSync(target, { force: true });
      const source = index === 1 ? this.filePath : `${this.filePath}.${index - 1}`;
      if (fs.existsSync(source)) fs.renameSync(source, target);
    }
  }
}

function sanitizeEvent(input, now, fallbackSource) {
  const event = {
    occurred_at: safeTimestamp(input.occurred_at, now),
    source: safeToken(input.source, fallbackSource),
    level: LEVELS.has(String(input.level || '').toLowerCase()) ? String(input.level).toLowerCase() : 'info',
    code: safeToken(input.code, 'invalid_log_code'),
  };
  for (const field of TOKEN_FIELDS) {
    if (field === 'source') continue;
    const value = safeOptionalToken(input[field]);
    if (value) event[field] = value;
  }
  const sessionFingerprint = String(input.session_fingerprint || '').trim();
  if (SAFE_SESSION_FINGERPRINT.test(sessionFingerprint)) {
    event.session_fingerprint = sessionFingerprint;
  }
  if (input.route === 'unmatched' || SAFE_ROUTE.test(String(input.route || ''))) event.route = input.route;
  for (const field of INTEGER_FIELDS) {
    const value = Number(input[field]);
    if (Number.isSafeInteger(value) && value >= (field === 'exit_code' ? -255 : 0)) event[field] = value;
  }
  for (const field of BOOLEAN_FIELDS) {
    if (typeof input[field] === 'boolean') event[field] = input[field];
  }
  return event;
}

function safeTimestamp(value, now) {
  const parsed = new Date(value || '');
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  const current = now();
  return (current instanceof Date && !Number.isNaN(current.getTime()) ? current : new Date()).toISOString();
}

function safeToken(value, fallback) {
  const text = String(value || '').trim();
  return SAFE_TOKEN.test(text) ? text : fallback;
}

function safeOptionalToken(value) {
  const text = String(value || '').trim();
  return text && SAFE_TOKEN.test(text) ? text : (text ? 'redacted' : '');
}

function validateDirectory(value) {
  const directory = String(value || '').trim();
  if (!directory || !path.isAbsolute(directory)) throw new Error('log_directory_invalid');
  return path.resolve(directory);
}

function boundedInteger(value, fallback, minimum, maximum) {
  const number = value === undefined ? fallback : Number(value);
  return Number.isSafeInteger(number) && number >= minimum && number <= maximum ? number : fallback;
}

function safeErrorCode(error, fallback = 'unclassified_error') {
  return safeToken(error?.code || error?.message, fallback);
}

module.exports = { RuntimeFileLogger, safeErrorCode };
