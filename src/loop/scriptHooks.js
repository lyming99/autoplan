const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { nowIso } = require('../database');
const { findRuntimeOperation, killChildProcess } = require('./runtime');

const TEMP_SCRIPT_DIR = path.join(os.tmpdir(), 'autoplan-scripts');
const LAST_LOG_MAX_CHARS = 24000;
const MANUAL_STAGE = 'manual';

/**
 * 执行某个阶段（hook_stage）下所有"已启用 + 触发型 + 匹配阶段"的脚本。
 * 单条脚本异常/超时被捕获并记为失败事件，绝不向上冒泡中断循环。
 * 返回 { ran, aborted, results }：aborted 仅在 validation:before 且 fail_aborts=1 且退出码非零时为 true。
 */
async function runHookScripts(service, projectId, stage, context = {}) {
  try {
    const scripts = service.db.all(
      `SELECT * FROM scripts
       WHERE project_id = ? AND hook_stage = ? AND enabled = 1 AND trigger_mode = 'hook'
       ORDER BY sort_order ASC, id ASC`,
      [projectId, stage],
    );
    if (!scripts.length) return { ran: false, aborted: false, results: [] };

    let aborted = false;
    const results = [];
    for (const script of scripts) {
      let run;
      try {
        run = await runScriptOnce(service, script, stage, { ...context, trigger: 'hook' });
      } catch (error) {
        run = recordRunFailure(service, script, stage, { ...context, trigger: 'hook' }, error);
      }
      results.push(run);
      // 仅前置阶段（validation:before）在 fail_aborts=1 且退出码非零时中断当前阶段
      if (stage === 'validation:before' && Number(script.fail_aborts) === 1 && run.exitCode !== 0) {
        aborted = true;
        break;
      }
    }
    return { ran: true, aborted, results };
  } catch (error) {
    // 任何意外异常（查询失败等）都不得中断循环，记一条失败事件后安全返回
    try {
      service.addEvent(projectId, 'script.hook.error', `${stage} 钩子执行异常：${error?.message || error}`);
    } catch { /* 忽略事件写入失败 */ }
    return { ran: false, aborted: false, results: [], error: error?.message || String(error) };
  }
}

/**
 * 手动运行单个脚本，复用 runScriptOnce，构造最小上下文。
 * 返回 ScriptRunResult（含 snapshot/退出码/耗时/日志）供弹窗展示。
 */
async function runScriptManually(service, projectId, scriptId) {
  const script = service.db.get('SELECT * FROM scripts WHERE id = ? AND project_id = ?', [scriptId, projectId]);
  if (!script) throw new Error('脚本不存在');
  const stage = script.hook_stage || MANUAL_STAGE;
  const project = service.project(projectId);
  const workspace = String(project?.workspace_path || '');
  let run;
  try {
    run = await runScriptOnce(service, script, stage, { trigger: 'manual', workspace });
  } catch (error) {
    run = recordRunFailure(service, script, stage, { trigger: 'manual', workspace }, error);
  }
  return {
    snapshot: service.snapshot(projectId),
    status: run.status,
    exitCode: run.exitCode,
    durationMs: run.durationMs,
    log: run.log,
    timedOut: run.timedOut,
    error: run.errorMessage || null,
  };
}

/**
 * 停止运行中的脚本：复用 runShell 的 operation 取消能力，按 scriptId 找到子进程并杀掉。
 */
function stopScript(service, projectId, scriptId) {
  const runtime = service.existingRuntime(projectId);
  if (!runtime) return;
  const entry = findRuntimeOperation(runtime, (operation) => Number(operation?.scriptId) === Number(scriptId));
  if (!entry) return;
  killChildProcess(entry.child);
}

/** 运行单条脚本一次：置 running → 经 runShell 执行 → 回写 last_* → 写事件 */
async function runScriptOnce(service, script, stage, context = {}) {
  const projectId = Number(script.project_id);
  const project = service.project(projectId);
  const workspace = String(project?.workspace_path || '');
  const startedAt = Date.now();

  service.db.run(
    `UPDATE scripts SET last_status = 'running', last_run_at = ?, updated_at = ? WHERE id = ?`,
    [nowIso(), nowIso(), script.id],
  );
  service.emitUpdate(projectId);

  const result = await executeScriptProcess(service, script, stage, context, workspace);
  const durationMs = Date.now() - startedAt;
  const exitCode = typeof result.exitCode === 'number' ? result.exitCode : -1;
  const status = exitCode === 0 ? 'ok' : 'bad';
  const log = combineLog(result);
  const timedOut = Boolean(result.timedOut);
  const errorMessage = result.errorMessage || '';

  recordScriptRun(service, script, stage, { ...context, workspace }, {
    exitCode, durationMs, status, log, timedOut, errorMessage, logFile: result.logFile || null,
  });

  return { scriptId: script.id, exitCode, durationMs, status, log, timedOut, errorMessage };
}

/** 按 source_type 分流：inline（缺省）把 body 写入临时文件执行；file 直接运行用户选定原文件。
 *  沿用既有超时/日志文件/operation 取消机制，仅替换命令来源。 */
async function executeScriptProcess(service, script, stage, context, workspace) {
  const planDir = path.join(workspace, 'docs', 'plan');
  const workDir = resolveWorkDir(script.work_dir, { workspace, planDir });
  const timeoutMs = Math.max(1, Number(script.timeout_seconds || 60)) * 1000;
  const ctx = buildScriptContext(stage, { ...context, workspace });
  const inject = String(script.context_inject || 'none');

  let tempFile = null;
  try {
    let fileToRun;
    if (String(script.source_type || 'inline') === 'file') {
      // 文件来源：直接运行用户选定原文件，不写临时副本（文件改动即时生效）
      const resolved = resolveScriptFile(script.path, { workspace, planDir });
      if (!resolved || !fs.existsSync(resolved)) {
        return { exitCode: -1, output: '', errorMessage: `脚本文件不存在：${script.path || resolved}`, timedOut: false, logFile: null };
      }
      fileToRun = resolved;
    } else {
      // 内联来源：维持现状，把 body 写入临时文件再运行
      tempFile = writeTempScript(script.runtime, script.body);
      fileToRun = tempFile;
    }
    const command = buildScriptCommand(script.runtime, fileToRun);
    const operation = {
      projectId: Number(script.project_id),
      scriptId: script.id,
      stage,
      timeoutMs,
      ...(workDir ? { cwd: workDir } : {}),
      ...(inject === 'env' ? { extraEnv: contextEnvVars(ctx) } : {}),
      ...(inject === 'stdin' ? { stdin: safeJson(ctx) } : {}),
    };
    return await service.runShell(workspace, command, `script-${script.id}`, operation);
  } catch (error) {
    return { exitCode: -1, output: '', errorMessage: error?.message || String(error), timedOut: false, logFile: null };
  } finally {
    if (tempFile) {
      try { fs.unlinkSync(tempFile); } catch { /* 临时文件清理失败忽略 */ }
    }
  }
}

function writeTempScript(runtime, body) {
  fs.mkdirSync(TEMP_SCRIPT_DIR, { recursive: true });
  const ext = scriptFileExtension(runtime);
  const file = path.join(TEMP_SCRIPT_DIR, `script-${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`);
  fs.writeFileSync(file, String(body || ''), 'utf8');
  return file;
}

function scriptFileExtension(runtime) {
  switch (runtime) {
    case 'bash': return '.sh';
    case 'ps': return '.ps1';
    case 'cmd': return '.bat';
    case 'node':
    default:
      return '.cjs';
  }
}

function buildScriptCommand(runtime, file) {
  const quoted = quoteShellArg(file);
  switch (runtime) {
    case 'bash':
      return `bash ${quoted}`;
    case 'ps':
      return process.platform === 'win32'
        ? `powershell -NoProfile -ExecutionPolicy Bypass -File ${quoted}`
        : `pwsh -NoProfile -File ${quoted}`;
    case 'cmd':
      return `cmd /c ${quoted}`;
    case 'node':
    default:
      return `node ${quoted}`;
  }
}

function quoteShellArg(value) {
  const text = String(value || '');
  return process.platform === 'win32' ? `"${text}"` : `'${text.replace(/'/g, `'\\''`)}'`;
}

/** 解析 work_dir 中的 ${workspace} ${planDir} 占位；为空时返回 ''（由 runShell 回退到 workspace） */
function resolveWorkDir(workDir, { workspace, planDir }) {
  const raw = String(workDir || '').trim();
  if (!raw) return '';
  let resolved = raw
    .replace(/\$\{workspace\}/g, workspace || '')
    .replace(/\$\{planDir\}/g, planDir || '');
  if (!resolved.trim()) return '';
  if (!path.isAbsolute(resolved) && workspace) {
    resolved = path.resolve(workspace, resolved);
  }
  return resolved;
}

/** 解析文件来源脚本路径中的 ${workspace} ${planDir} 占位；空串返回 ''。
 *  镜像 resolveWorkDir：非绝对路径且 workspace 存在时按工作区解析，否则原样返回。 */
function resolveScriptFile(rawPath, { workspace, planDir }) {
  const raw = String(rawPath || '').trim();
  if (!raw) return '';
  let resolved = raw
    .replace(/\$\{workspace\}/g, workspace || '')
    .replace(/\$\{planDir\}/g, planDir || '');
  if (!resolved.trim()) return '';
  if (!path.isAbsolute(resolved) && workspace) {
    resolved = path.resolve(workspace, resolved);
  }
  return resolved;
}

function buildScriptContext(stage, context = {}) {
  const scopeFiles = Array.isArray(context.scopeFiles)
    ? context.scopeFiles
    : parseScopeFiles(context.scope);
  return {
    stage,
    workspace: context.workspace || '',
    trigger: context.trigger || 'hook',
    planId: context.planId ?? null,
    planFilePath: context.planFilePath || null,
    taskKey: context.taskKey || null,
    taskId: context.taskId ?? null,
    scopeFiles,
    intakeType: context.intakeType || null,
    intakeId: context.intakeId ?? null,
    validationCommand: context.validationCommand || null,
    error: context.error || null,
    summary: context.summary || null,
  };
}

function contextEnvVars(ctx) {
  const env = {
    AUTOPLAN_STAGE: ctx.stage || '',
    AUTOPLAN_WORKSPACE: ctx.workspace || '',
    AUTOPLAN_CONTEXT: safeJson(ctx),
  };
  if (ctx.planId !== null && ctx.planId !== undefined) env.AUTOPLAN_PLAN_ID = String(ctx.planId);
  if (ctx.taskKey) env.AUTOPLAN_TASK_KEY = ctx.taskKey;
  if (Array.isArray(ctx.scopeFiles) && ctx.scopeFiles.length) env.AUTOPLAN_SCOPE_FILES = ctx.scopeFiles.join(',');
  return env;
}

function parseScopeFiles(scope) {
  return String(scope || '').split(',').map((part) => part.trim()).filter(Boolean);
}

function combineLog(result = {}) {
  const parts = [];
  if (result.output) parts.push(String(result.output));
  if (result.errorMessage) parts.push(`[AutoPlan] ${result.errorMessage}`);
  return parts.join('\n').trim();
}

function truncateLog(text, max = LAST_LOG_MAX_CHARS) {
  const value = String(text || '');
  return value.length > max ? value.slice(value.length - max) : value;
}

function recordScriptRun(service, script, stage, context, outcome) {
  const finishedAt = nowIso();
  service.db.run(
    `UPDATE scripts
     SET last_status = ?, last_exit_code = ?, last_duration_ms = ?, last_log = ?, last_run_at = ?, updated_at = ?
     WHERE id = ?`,
    [outcome.status, outcome.exitCode, outcome.durationMs, truncateLog(outcome.log), finishedAt, finishedAt, script.id],
  );
  const succeeded = outcome.status === 'ok';
  service.addEvent(
    script.project_id,
    succeeded ? 'script.run.succeeded' : 'script.run.failed',
    `${script.name}（${stage}）${succeeded ? '运行成功' : '运行失败'}（退出码 ${outcome.exitCode}）`,
    {
      scriptId: script.id,
      scriptName: script.name,
      stage,
      trigger: context.trigger || 'hook',
      exitCode: outcome.exitCode,
      durationMs: outcome.durationMs,
      timedOut: Boolean(outcome.timedOut),
      log: outcome.logFile || null,
      errorMessage: outcome.errorMessage || '',
    },
  );
}

/** runScriptOnce 抛错兜底：保证返回统一结构并记一次失败事件，绝不向上冒泡 */
function recordRunFailure(service, script, stage, context, error) {
  const outcome = {
    exitCode: -1,
    durationMs: 0,
    status: 'bad',
    log: error?.message || String(error),
    timedOut: false,
    errorMessage: error?.message || String(error),
    logFile: null,
  };
  recordScriptRun(service, script, stage, context, outcome);
  return { scriptId: script.id, ...outcome };
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return '{}';
  }
}

module.exports = {
  runHookScripts,
  runScriptManually,
  stopScript,
  buildScriptContext,
  contextEnvVars,
  resolveWorkDir,
  resolveScriptFile,
};
