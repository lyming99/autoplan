'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  cleanupTemporaryRoot,
  coverageEvidence,
  p07Commands,
  p07PreflightCommand,
  parseArgs,
  parseStructuredOutput,
  runVerification,
  safeEnvironment,
  sanitizeLog,
  testControlViolations,
} = require('./verify');

function fixtureRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autoplan-p07-verify-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'config'), { recursive: true });
  fs.writeFileSync(path.join(root, 'config', 'expectations.json'), JSON.stringify({
    commands: {
      check: { description: 'synthetic check', outcome: 'success', allowedFailureSignatures: [] },
      test: { description: 'synthetic test', outcome: 'success', allowedFailureSignatures: [] },
    },
  }));
  return root;
}

function cleanGitStatus() {
  return { exitCode: 0, entries: [], stderr: '' };
}

function sourceSafety() {
  return {
    ok: true,
    schemaVersion: 1,
    databaseOwnerGuardSha256: 'a'.repeat(64),
    stateMachineSha256: 'b'.repeat(64),
    expectedErrorsSha256: 'c'.repeat(64),
    stateMachineScenarioCount: 16,
    expectedErrorScenarioCount: 8,
    openapiRoutes: [
      '/api/v1/capabilities',
      '/api/v1/plans',
      '/api/v1/plans/actions/run',
      '/api/v1/plans/actions/stop',
      '/api/v1/plans/actions/resume',
      '/api/v1/plans/actions/re-execute',
      '/api/v1/plans/actions/recreate',
      '/api/v1/tasks/actions/run',
      '/api/v1/tasks/actions/run-batches',
      '/api/v1/tasks/actions/stop',
    ],
  };
}

function successfulExecutor(calls) {
  const epoch = Date.parse('2026-07-11T09:00:00.000Z');
  return async (spec) => {
    const index = calls.length;
    calls.push(spec.id);
    const structured = spec.id === 'p07-safety-preflight'
      ? { ok: true, schemaVersion: 1 }
      : (spec.id === 'node-plan-golden' ? { ok: true, scenarios: 16 } : null);
    return {
      exitCode: 0,
      signal: null,
      error: null,
      stdout: structured ? JSON.stringify(structured) + '\n' : '',
      stderr: '',
      startedAt: new Date(epoch + index * 20).toISOString(),
      endedAt: new Date(epoch + index * 20 + 10).toISOString(),
    };
  };
}

test('argument and structured output parsing are strict', () => {
  assert.deepEqual(parseArgs(['verify']), { mode: 'verify' });
  assert.throws(() => parseArgs([]), /usage:/);
  assert.deepEqual(parseStructuredOutput('noise\n{"ok":true}\n'), { ok: true });
  assert.equal(parseStructuredOutput('noise only'), null);
});

test('safe environment removes credential, database and prior-stage control variables', () => {
  const temporaryRoot = path.join(os.tmpdir(), 'autoplan-p07-verify-env');
  const safe = safeEnvironment(temporaryRoot, {
    PATH: 'safe',
    API_TOKEN: 'secret',
    DB_PATH: 'unsafe',
    AUTOPLAN_P06_VERIFY: 'previous',
    AUTOPLAN_P07_DATABASE_ROOT: 'outside',
  });
  assert.equal(safe.environment.PATH, 'safe');
  assert.equal(safe.environment.API_TOKEN, undefined);
  assert.equal(safe.environment.DB_PATH, undefined);
  assert.equal(safe.environment.AUTOPLAN_P06_VERIFY, undefined);
  assert.equal(safe.environment.AUTOPLAN_P07_DATABASE_ROOT, path.join(temporaryRoot, 'database'));
  assert.equal(safe.removedCount, 4);
  assert.equal(safe.environment.AUTOPLAN_P07_VERIFY, '1');
  assert.ok(!sanitizeLog(temporaryRoot, process.cwd(), temporaryRoot).includes(temporaryRoot));
});

test('test control scan rejects skip and only markers in P07 scoped tests', (t) => {
  const root = fixtureRoot(t);
  const relative = 'backend/internal/application/plans/golden_test.go';
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, ['t.' + 'Skip("hidden test")', 'test.' + 'only("hidden node test", () => {})'].join('\n'));
  assert.deepEqual(testControlViolations(root, [relative]), [relative + ':1', relative + ':2']);
});

test('P07 command plan serializes Node golden before every Go writer', () => {
  const expectations = { commands: {
    check: { outcome: 'success', allowedFailureSignatures: [] },
    test: { outcome: 'success', allowedFailureSignatures: [] },
  } };
  assert.equal(p07PreflightCommand().id, 'p07-safety-preflight');
  assert.deepEqual(p07Commands(expectations).map((item) => item.id), [
    'node-plan-golden',
    'go-repository',
    'go-plans-application',
    'go-acceptance-application',
    'go-events-application',
    'go-httpapi',
    'go-mcp',
    'renderer-plan-transport',
    'p07-orchestration-tests',
    'check',
    'test',
  ]);
});

test('coverage evidence records state, concurrency, HTTP, MCP, renderer and action matrices', () => {
  const expectations = { commands: {
    check: { outcome: 'success', allowedFailureSignatures: [] },
    test: { outcome: 'success', allowedFailureSignatures: [] },
  } };
  const commands = [
    { id: 'p05-gate' },
    { id: 'p06-gate' },
    p07PreflightCommand(),
    ...p07Commands(expectations),
  ].map((item) => ({ id: item.id, evaluation: { accepted: true } }));
  const coverage = coverageEvidence(commands, sourceSafety());
  assert.ok(coverage.matrix.every((item) => item.verified));
  assert.equal(coverage.openapiCoverage.routes.length, 10);
  assert.equal(coverage.longActions.disabledByDefault, true);
});

test('failed P05 gate creates blocked evidence before P06 or P07 writers', async (t) => {
  const root = fixtureRoot(t);
  const calls = [];
  const result = await runVerification({
    rootDir: root,
    expectations: 'config/expectations.json',
    evidenceRoot: 'evidence',
    runId: 'p05-blocked-run',
    sourceFiles: [],
    environment: {},
    gitStatus: cleanGitStatus,
    executeCommand: async (spec) => {
      calls.push(spec.id);
      return {
        exitCode: 7,
        signal: null,
        error: null,
        stdout: '',
        stderr: 'p05 failed',
        startedAt: '2026-07-11T09:00:00.000Z',
        endedAt: '2026-07-11T09:00:00.010Z',
      };
    },
    inspectP05Evidence() { throw new Error('must not inspect evidence'); },
  });
  assert.deepEqual(calls, ['p05-gate']);
  assert.equal(result.summary.status, 'blocked');
  assert.equal(result.summary.commandResults[0].exitCode, 7);
  assert.equal(result.summary.databaseOwnership.authorizedCopiesOnly, false);
  assert.equal(result.summary.temporaryCleanup.cleaned, true);
});

test('failed P06 gate stops before P07 safety and writer commands', async (t) => {
  const root = fixtureRoot(t);
  const calls = [];
  let sequence = 0;
  const result = await runVerification({
    rootDir: root,
    expectations: 'config/expectations.json',
    evidenceRoot: 'evidence',
    runId: 'p06-blocked-run',
    sourceFiles: [],
    environment: {},
    gitStatus: cleanGitStatus,
    executeCommand: async (spec) => {
      calls.push(spec.id);
      const start = Date.parse('2026-07-11T09:10:00.000Z') + sequence++ * 20;
      return {
        exitCode: spec.id === 'p06-gate' ? 6 : 0,
        signal: null,
        error: null,
        stdout: '',
        stderr: '',
        startedAt: new Date(start).toISOString(),
        endedAt: new Date(start + 10).toISOString(),
      };
    },
  });
  assert.deepEqual(calls, ['p05-gate', 'p06-gate']);
  assert.equal(result.summary.status, 'blocked');
  assert.equal(result.summary.blocked, 'p06_gate_failed_no_p07_node_or_go_writer_started');
});

test('failed P07 safety preflight stops before Node and Go writers', async (t) => {
  const root = fixtureRoot(t);
  const calls = [];
  let sequence = 0;
  const result = await runVerification({
    rootDir: root,
    expectations: 'config/expectations.json',
    evidenceRoot: 'evidence',
    runId: 'p07-safety-blocked-run',
    sourceFiles: [],
    environment: {},
    gitStatus: cleanGitStatus,
    executeCommand: async (spec) => {
      calls.push(spec.id);
      const start = Date.parse('2026-07-11T09:20:00.000Z') + sequence++ * 20;
      return {
        exitCode: spec.id === 'p07-safety-preflight' ? 1 : 0,
        signal: null,
        error: null,
        stdout: '',
        stderr: '',
        startedAt: new Date(start).toISOString(),
        endedAt: new Date(start + 10).toISOString(),
      };
    },
  });
  assert.deepEqual(calls, ['p05-gate', 'p06-gate', 'p07-safety-preflight']);
  assert.equal(result.summary.status, 'blocked');
  assert.equal(result.summary.blocked, 'p07_safety_preflight_failed_no_p07_node_or_go_writer_started');
});

test('failed Node Plan golden command stops before the first Go writer', async (t) => {
  const root = fixtureRoot(t);
  const calls = [];
  let sequence = 0;
  const result = await runVerification({
    rootDir: root,
    expectations: 'config/expectations.json',
    evidenceRoot: 'evidence',
    runId: 'node-failed-run',
    sourceFiles: [],
    environment: {},
    gitStatus: cleanGitStatus,
    executeCommand: async (spec) => {
      calls.push(spec.id);
      const start = Date.parse('2026-07-11T09:30:00.000Z') + sequence++ * 20;
      return {
        exitCode: spec.id === 'node-plan-golden' ? 1 : 0,
        signal: null,
        error: null,
        stdout: '',
        stderr: '',
        startedAt: new Date(start).toISOString(),
        endedAt: new Date(start + 10).toISOString(),
      };
    },
    inspectP05Evidence: () => ({ stage: 'p05', runId: 'accepted', sourceHashesStable: true }),
    inspectP06Evidence: () => ({ stage: 'p06', runId: 'accepted', sourceHashesStable: true }),
    inspectSourceSafety: sourceSafety,
  });
  assert.deepEqual(calls, ['p05-gate', 'p06-gate', 'p07-safety-preflight', 'node-plan-golden']);
  assert.equal(result.summary.status, 'failed');
  assert.equal(result.summary.failure, 'node-plan-golden_failed_stopped_remaining_steps');
});

test('successful verification emits immutable, sanitized and sequential evidence', async (t) => {
  const root = fixtureRoot(t);
  const calls = [];
  const result = await runVerification({
    rootDir: root,
    expectations: 'config/expectations.json',
    evidenceRoot: 'evidence',
    runId: 'completed-run',
    sourceFiles: [],
    environment: { PATH: process.env.PATH || '' },
    gitStatus: cleanGitStatus,
    executeCommand: successfulExecutor(calls),
    inspectP05Evidence: () => ({ stage: 'p05', runId: 'accepted', sourceHashesStable: true }),
    inspectP06Evidence: () => ({ stage: 'p06', runId: 'accepted', sourceHashesStable: true }),
    inspectSourceSafety: sourceSafety,
  });
  assert.deepEqual(calls.slice(0, 4), ['p05-gate', 'p06-gate', 'p07-safety-preflight', 'node-plan-golden']);
  assert.equal(result.summary.status, 'completed');
  assert.equal(result.summary.ok, true);
  assert.equal(result.summary.safety.writerTimeline.nodeClosedBeforeGo, true);
  assert.equal(result.summary.temporaryCleanup.cleaned, true);
  assert.ok(fs.existsSync(path.join(result.runDir, 'summary.json')));
  assert.ok(fs.existsSync(path.join(result.runDir, 'evidence-manifest.json')));
});

test('cleanup refuses any directory not owned by the P07 verifier', (t) => {
  const root = fixtureRoot(t);
  assert.deepEqual(cleanupTemporaryRoot(root), { cleaned: false, error: 'refused_non_owned_cleanup' });
  assert.equal(fs.existsSync(root), true);
});
