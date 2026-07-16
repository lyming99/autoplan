'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { createSafeEnvironment, inspectEvidenceFile, isWithin, sanitizeText, scanSensitiveText, sha256, validateFixtureRoot } = require('./check-safety');

const ROOT = path.resolve(__dirname, '..', '..');
const EVIDENCE_ROOT = 'docs/migration/p11/evidence/runs';
const TEMPORARY_PREFIX = 'autoplan-p11-verify-';
const SOURCE_FILES = [
  'package.json',
  'backend/internal/application/runtime/golden_test.go',
  'backend/internal/application/runtime/concurrency_test.go',
  'backend/internal/application/runtime/recovery_test.go',
  'backend/internal/runtime/process/process_tree_integration_test.go',
  'backend/internal/runtime/agentcli/contract_test.go',
  'backend/internal/httpapi/runtime_contract_test.go',
  'src/data/goDataClient.runtime.test.js',
  'src/renderer/lib/api/runtimeTransport.contract.test.ts',
  'scripts/migration-p11/check-prerequisites.js',
  'scripts/migration-p11/check-safety.js',
  'scripts/migration-p11/compare-runtime-golden.js',
  'scripts/migration-p11/verify.js',
  'fixtures/migration/p11/state-machine-cases.json',
  'fixtures/migration/p11/process-fixtures/unix-process-tree.json',
  'fixtures/migration/p11/process-fixtures/windows-process-tree.json',
  'docs/migration/p11/README.md',
  'docs/migration/p11/runbook.md',
  'docs/migration/p11/evidence/README.md',
  'docs/migration/p11/evidence/manifest.json',
];

function writeJSON(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
}

function fileHash(root, relative) {
  const target = path.join(root, relative);
  const info = fs.lstatSync(target, { throwIfNoEntry: false });
  if (!info?.isFile() || info.isSymbolicLink()) return { path: relative.replaceAll('\\', '/'), missing: true };
  const bytes = fs.readFileSync(target);
  return { path: relative.replaceAll('\\', '/'), bytes: bytes.length, sha256: sha256(bytes) };
}

function nodeSpec(id, args, description) { return { id, args, description, executable: process.execPath, display: `node ${args.join(' ')}`, cwd: '.' }; }
function goSpec(id, args, description) { return { id, args, description, executable: 'go', display: `go ${args.join(' ')}`, cwd: 'backend' }; }
function npmSpec(id, args, description) {
  if (process.platform === 'win32') return { id, args: ['/d', '/s', '/c', `call npm.cmd ${args.join(' ')}`], description, executable: process.env.ComSpec || 'cmd.exe', display: `npm.cmd ${args.join(' ')}`, cwd: '.' };
  return { id, args, description, executable: 'npm', display: `npm ${args.join(' ')}`, cwd: '.' };
}
function gitSpec(id, args, description) { return { id, args, description, executable: 'git', display: `git ${args.join(' ')}`, cwd: '.' }; }
function worktreeStatusSpec() {
  return gitSpec('p11-worktree-status', ['status', '--short', '--untracked-files=all'], 'Record the final worktree state without deleting, staging, or modifying unrelated files.');
}

function verificationCommands(p00 = {}) {
  const signatures = Array.isArray(p00.check_failure_signatures) ? p00.check_failure_signatures : [];
  return [
    nodeSpec('p11-runtime-golden', ['scripts/migration-p11/compare-runtime-golden.js'], 'Compare the sanitized Node golden, runtime matrix, and frozen P11 contract without updating any artifact.'),
    nodeSpec('p11-node-godata', ['--test', 'src/data/goDataClient.runtime.test.js'], 'Verify typed GoDataClient fallback owner pinning and failure closure.'),
    nodeSpec('p11-renderer-contract', ['scripts/migration-p11/verify.js', 'renderer-contract'], 'Evaluate the renderer Runtime transport contract with a synchronous fake test harness and no Electron process.'),
    goSpec('p11-runtime-state-machine', ['test', './internal/application/runtime', './internal/application/loop', './internal/runtime/scheduler', './internal/runtime/process', './internal/runtime/agentcli', './internal/httpapi', './internal/mcp', '-count=1'], 'Verify state, concurrency, recovery, actor, process-tree, Agent CLI, REST, and MCP contract matrices.'),
    npmSpec('p11-node-suite', ['test'], 'Run the Node runtime suite without starting Electron or a real Agent CLI.'),
    {
      ...npmSpec('p11-static-check', ['run', 'check'], 'Compare static checks with the accepted P00 known-red signature.'),
      accepted_nonzero_signatures: signatures,
    },
    worktreeStatusSpec(),
  ];
}

function execute(spec, root, environment) {
  return new Promise((resolve) => {
    const startedAt = new Date().toISOString();
    let stdout = '';
    let stderr = '';
    let settled = false;
    let child;
    try {
      child = spawn(spec.executable, spec.args, { cwd: path.join(root, spec.cwd), env: environment, shell: false, windowsHide: true,
        windowsVerbatimArguments: process.platform === 'win32' && spec.executable.endsWith('cmd.exe') });
    } catch (error) {
      resolve({ startedAt, endedAt: new Date().toISOString(), stdout, stderr, exitCode: null, signal: null, error: error?.message || 'spawn_failed' });
      return;
    }
    const timer = setTimeout(() => { if (!settled) child.kill(); }, 30 * 60 * 1000);
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...result, stdout, stderr, startedAt, endedAt: new Date().toISOString() });
    };
    child.stdout?.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => finish({ exitCode: null, signal: null, error: error.message }));
    child.on('close', (exitCode, signal) => finish({ exitCode, signal: signal || null, error: null }));
  });
}

async function runCommand(spec, state) {
  let actual;
  try { actual = await (state.executeCommand || execute)(spec, state.root, state.environment); }
  catch (error) { actual = { stdout: '', stderr: '', exitCode: null, signal: null, error: error?.message || 'command_executor_failed', startedAt: new Date().toISOString(), endedAt: new Date().toISOString() }; }
  const raw = `${actual.stdout || ''}\n${actual.stderr || ''}`;
  const findings = scanSensitiveText(raw);
  const stdout = sanitizeText(actual.stdout || '', state);
  const stderr = sanitizeText(actual.stderr || '', state);
  const prefix = `${String(state.results.length + 1).padStart(2, '0')}-${spec.id}`;
  const stdoutName = `${prefix}.stdout.log`;
  const stderrName = `${prefix}.stderr.log`;
  fs.writeFileSync(path.join(state.runDir, stdoutName), stdout, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  fs.writeFileSync(path.join(state.runDir, stderrName), stderr, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  const acceptedKnownP00Red = acceptsKnownP00Red(spec, actual, raw);
  const accepted = !actual.error && findings.length === 0 && (actual.exitCode === 0 || acceptedKnownP00Red);
  const record = {
    id: spec.id, description: spec.description, command: sanitizeText(spec.display, state),
    input_sha256: sha256(JSON.stringify({ executable: spec.executable, args: spec.args })),
    started_at: actual.startedAt, ended_at: actual.endedAt, exit_code: Number.isInteger(actual.exitCode) ? actual.exitCode : null,
    signal: actual.signal || null, error: actual.error ? sanitizeText(actual.error, state) : null,
    accepted,
    reason: accepted ? (acceptedKnownP00Red ? 'accepted_p00_known_red' : 'accepted') : findings.length ? 'unsafe_output_rejected' : 'nonzero_or_spawn_failure',
    accepted_nonzero_signatures: acceptedKnownP00Red ? spec.accepted_nonzero_signatures : [],
    sensitive_findings: findings,
    logs: { stdout: { path: stdoutName, bytes: Buffer.byteLength(stdout), sha256: sha256(stdout) }, stderr: { path: stderrName, bytes: Buffer.byteLength(stderr), sha256: sha256(stderr) } },
  };
  state.results.push(record);
  return record;
}

function acceptsKnownP00Red(spec, actual, raw) {
  const expected = Array.isArray(spec.accepted_nonzero_signatures) ? [...spec.accepted_nonzero_signatures].sort() : [];
  if (actual.exitCode === 0 || actual.error || expected.length === 0) return false;
  const observed = p00FailureSignatures(raw);
  return JSON.stringify(observed) === JSON.stringify(expected);
}

function p00FailureSignatures(raw) {
  const signatures = [];
  for (const rawLine of String(raw || '').split(/\r?\n/)) {
    const line = rawLine.replace(/\u001b\[[0-9;]*m/g, '').trim().replaceAll('\\', '/');
    if (!line) continue;
    let recognized = false;
    let match = /^-\s+(.+?):\s+\d+ lines \(limit (\d+)\)$/.exec(line);
    if (match) {
      signatures.push(`file-length|${match[1]}|limit=${match[2]}`);
      recognized = true;
    }
    match = /^(.+?)\(\d+,\d+\): error (TS\d+):\s*(.+)$/.exec(line);
    if (match) {
      signatures.push(`typescript|${match[1]}|${match[2]}|${match[3]}`);
      recognized = true;
    }
    if (!recognized && !/^File length check failed:$|^npm (?:error|ERR!)/i.test(line) && /^(?:Error|AssertionError|TypeError|ReferenceError|fatal):/i.test(line)) {
      signatures.push(`diagnostic|${line}`);
    }
  }
  return [...new Set(signatures)].sort();
}

function ownedTemporaryRoot(root) {
  const resolved = path.resolve(root || '');
  const relative = path.relative(path.resolve(os.tmpdir()), resolved);
  return path.basename(resolved).startsWith(TEMPORARY_PREFIX) && relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function cleanupTemporaryRoot(root) {
  if (!ownedTemporaryRoot(root)) return { cleaned: false, code: 'temporary_cleanup_refused' };
  try { fs.rmSync(root, { recursive: true, force: true }); return { cleaned: true, code: 'temporary_cleanup_completed' }; }
  catch { return { cleaned: false, code: 'temporary_cleanup_failed' }; }
}

function listArtifacts(runDir) {
  return fs.readdirSync(runDir, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name !== 'evidence-manifest.json').map((entry) => {
    const bytes = fs.readFileSync(path.join(runDir, entry.name));
    return { path: entry.name, bytes: bytes.length, sha256: sha256(bytes) };
  }).sort((left, right) => left.path.localeCompare(right.path));
}

function parseArgs(argv) {
  if (argv.length !== 3 || argv[0] !== 'verify' || argv[1] !== '--fixture-root' || !argv[2]) {
    throw new Error('usage: node scripts/migration-p11/verify.js verify --fixture-root <authorized-p11-fixture>');
  }
  return { fixtureRoot: argv[2] };
}

function structuredPrerequisite(stdout) {
  for (const line of String(stdout || '').split(/\r?\n/).filter(Boolean).reverse()) {
    try {
      const value = JSON.parse(line);
      if (value && typeof value === 'object' && typeof value.status === 'string' && Array.isArray(value.failures)) return value;
    } catch { /* preceding diagnostics are intentionally ignored */ }
  }
  return null;
}

function runRendererContract(rootDir = ROOT) {
  const sourcePath = path.join(rootDir, 'src', 'renderer', 'lib', 'api', 'runtimeTransport.contract.test.ts');
  const source = fs.readFileSync(sourcePath, 'utf8');
  const nodeTestRegistration = "import { describe, it } from 'node:test';";
  const harnessRegistration = "const describe: TestRegistrar = (_name, run) => run();\nconst it: TestRegistrar = (_name, run) => run();";
  if (!source.includes(nodeTestRegistration)) throw new Error('renderer_contract_harness_anchor_missing');
  const typescript = require('typescript');
  const compiled = typescript.transpileModule(source.replace(nodeTestRegistration, harnessRegistration), {
    compilerOptions: { target: typescript.ScriptTarget.ES2022, module: typescript.ModuleKind.CommonJS },
    fileName: sourcePath,
  });
  const executeContract = new Function('require', 'exports', 'process', compiled.outputText);
  executeContract(require, {}, { cwd: () => rootDir });
  return { ok: true, code: 'renderer_contract_passed' };
}

async function runVerification(options = {}) {
  const root = path.resolve(options.rootDir || ROOT);
  const fixtureRoot = path.resolve(options.fixtureRoot || '');
  const fixture = validateFixtureRoot(fixtureRoot);
  const evidenceRoot = path.resolve(root, options.evidenceRoot || EVIDENCE_ROOT);
  if (!isWithin(evidenceRoot, root)) throw new Error('evidence_root_invalid');
  const runID = options.runId || `p11-${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`;
  if (!/^[A-Za-z0-9._-]{1,160}$/.test(runID)) throw new Error('run_id_invalid');
  const runDir = path.join(evidenceRoot, runID);
  if (fs.existsSync(runDir)) throw new Error('evidence_directory_exists');
  fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), TEMPORARY_PREFIX));
  for (const name of ['home', 'appdata', 'localappdata', 'xdg-config', 'xdg-cache', 'xdg-data', 'go-cache', 'go-mod-cache', 'fixture-work']) {
    fs.mkdirSync(path.join(temporaryRoot, name), { recursive: true, mode: 0o700 });
  }
  const safe = createSafeEnvironment(temporaryRoot, options.environment || process.env);
  Object.assign(safe.environment, {
    GOCACHE: path.join(temporaryRoot, 'go-cache'), GOMODCACHE: path.join(temporaryRoot, 'go-mod-cache'),
    AUTOPLAN_P11_FIXTURE_ROOT: fixtureRoot, AUTOPLAN_P11_WORK_ROOT: path.join(temporaryRoot, 'fixture-work'),
  });
  const summary = {
    schema_version: 1, kind: 'p11-runtime-verification', run_id: runID, status: 'running', started_at: new Date().toISOString(),
    fixture, environment: { temporary_roots_only: true, environment_values_captured: false, removed_sensitive_environment_variable_count: safe.removedCount },
    fixture_artifacts: [
      'fixtures/migration/p11/manifest.json',
      'fixtures/migration/p11/node-runtime.golden.json',
      'docs/migration/p11/runtime-contract.json',
      'fixtures/migration/p11/state-machine-cases.json',
      'fixtures/migration/p11/process-fixtures/unix-process-tree.json',
      'fixtures/migration/p11/process-fixtures/windows-process-tree.json',
    ].map((file) => fileHash(root, file)),
    operation_event_matrix: fileHash(root, 'fixtures/migration/p11/state-machine-cases.json'),
    source_hashes_start: SOURCE_FILES.map((file) => fileHash(root, file)), command_results: [], prerequisite_evidence: null,
    process_cleanup: { fixture_only: true, leaked_children: 0, zombies: 0 }, remaining_risks: [], blocked_exit_code: null,
  };
  const state = { root, rootDir: root, fixtureRoot, temporaryRoot, runDir, environment: safe.environment, results: summary.command_results, executeCommand: options.executeCommand };
  const prerequisite = nodeSpec('prerequisites', ['scripts/migration-p11/check-prerequisites.js', '--fixture-root', fixtureRoot],
    'Validate P00/P10 evidence, explicit fixture authorization, Go-only database ownership, and real userData refusal before any runner test.');
  const gate = await runCommand(prerequisite, state);
  summary.prerequisite_evidence = structuredPrerequisite(fs.readFileSync(path.join(runDir, gate.logs.stdout.path), 'utf8'));
  if (!fixture.ok || !gate.accepted || summary.prerequisite_evidence?.status !== 'ready') {
    summary.status = 'blocked';
    summary.blocked_exit_code = gate.exit_code;
    summary.failure = gate.accepted ? 'prerequisite_output_incomplete' : 'prerequisite_command_failed';
    await runCommand(worktreeStatusSpec(), state);
  } else {
    const commands = verificationCommands(summary.prerequisite_evidence?.p00);
    const statusCommand = commands.pop();
    for (const spec of commands) {
      const result = await runCommand(spec, state);
      if (!result.accepted) {
        summary.status = 'failed';
        summary.failure = `${spec.id}_failed_stopped_remaining_steps`;
        break;
      }
    }
    const statusResult = await runCommand(statusCommand, state);
    if (!statusResult.accepted && summary.status === 'running') {
      summary.status = 'failed';
      summary.failure = 'p11-worktree-status_failed';
    }
    if (summary.status === 'running') summary.status = 'completed';
  }
  summary.source_hashes_end = SOURCE_FILES.map((file) => fileHash(root, file));
  summary.source_hashes_stable = JSON.stringify(summary.source_hashes_start) === JSON.stringify(summary.source_hashes_end);
  const processTreeResult = summary.command_results.find((item) => item.id === 'p11-runtime-state-machine');
  summary.process_cleanup = {
    fixture_only: true,
    asserted_by_command: processTreeResult?.id || null,
    process_tree_assertions_passed: processTreeResult?.accepted === true,
    leaked_children: processTreeResult?.accepted ? 0 : null,
    zombies: processTreeResult?.accepted ? 0 : null,
  };
  summary.temporary_cleanup = cleanupTemporaryRoot(temporaryRoot);
  summary.ended_at = new Date().toISOString();
  if (!summary.fixture.ok) summary.remaining_risks.push(summary.fixture.code);
  if (!summary.source_hashes_stable) summary.remaining_risks.push('verification_source_hash_drift');
  if (!summary.temporary_cleanup.cleaned) summary.remaining_risks.push(summary.temporary_cleanup.code);
  if (summary.status !== 'completed') summary.remaining_risks.push('p11_execution_not_authorized_or_not_completed');
  summary.ok = summary.status === 'completed' && summary.fixture.ok && summary.source_hashes_stable && summary.temporary_cleanup.cleaned &&
    summary.command_results.length === verificationCommands(summary.prerequisite_evidence?.p00).length + 1 && summary.command_results.every((item) => item.accepted);
  writeJSON(path.join(runDir, 'summary.json'), summary);
  writeJSON(path.join(runDir, 'evidence-manifest.json'), { schema_version: 1, kind: 'p11-evidence-manifest', run_id: runID, generated_at: summary.ended_at, immutable_run_directory: true, artifacts: listArtifacts(runDir) });
  return { runDir, summary };
}

if (require.main === module && process.argv[2] === 'renderer-contract') {
  try {
    process.stdout.write(`${JSON.stringify(runRendererContract())}\n`);
  } catch {
    process.stdout.write('{"ok":false,"code":"renderer_contract_failed"}\n');
    process.exitCode = 2;
  }
} else if (require.main === module) {
  try {
    runVerification(parseArgs(process.argv.slice(2))).then(({ summary }) => {
      process.stdout.write(`${JSON.stringify({ status: summary.status, ok: summary.ok, command_count: summary.command_results.length })}\n`);
      process.exitCode = summary.ok ? 0 : 2;
    }).catch(() => {
      process.stdout.write('{"status":"blocked","code":"verification_arguments_or_setup_invalid"}\n');
      process.exitCode = 2;
    });
  } catch {
    process.stdout.write('{"status":"blocked","code":"verification_arguments_invalid"}\n');
    process.exitCode = 2;
  }
}

module.exports = { EVIDENCE_ROOT, SOURCE_FILES, acceptsKnownP00Red, cleanupTemporaryRoot, execute, p00FailureSignatures, parseArgs, runCommand, runRendererContract, runVerification, structuredPrerequisite, verificationCommands, worktreeStatusSpec };
