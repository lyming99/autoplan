'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  GO_WRITER_COMMANDS,
  SafetyError,
  inspectEvidenceSummary,
  inspectP05Evidence,
  inspectP06Evidence,
  inspectSourceSafety,
  inspectWriterTimeline,
  isOwnedTemporaryRoot,
  parseArgs,
  scanSensitiveText,
} = require('./check-safety');

const ROOT = path.resolve(__dirname, '../..');

function accepted(id, start, end) {
  return {
    id,
    command: id,
    startedAt: new Date(start).toISOString(),
    endedAt: new Date(end).toISOString(),
    failureSignatures: [],
    structuredOutput: null,
    evaluation: { accepted: true, reason: 'exit code 0' },
  };
}

function safeTimeline() {
  const ids = [
    'p05-gate',
    'p06-gate',
    'p07-safety-preflight',
    'node-plan-golden',
    ...GO_WRITER_COMMANDS,
    'renderer-plan-transport',
    'p07-orchestration-tests',
    'check',
    'test',
  ];
  const epoch = Date.parse('2026-07-11T08:00:00.000Z');
  return ids.map((id, index) => accepted(id, epoch + index * 20, epoch + index * 20 + 10));
}

function safeSummary() {
  return {
    schemaVersion: 1,
    status: 'completed',
    environment: {
      electronUserDataAccessed: false,
      productionDatabaseOpened: false,
      databaseContentCaptured: false,
      attachmentContentCaptured: false,
      temporaryRootsOnly: true,
    },
    databaseOwnership: {
      p05GateAccepted: true,
      p06GateAccepted: true,
      p05EvidenceAccepted: true,
      p06EvidenceAccepted: true,
      authorizedCopiesOnly: true,
      goWriteRequiresOwnerProof: true,
      ownerGuardSha256: 'a'.repeat(64),
    },
    sourceHashesStable: true,
    commandResults: safeTimeline(),
  };
}

function writeEvidence(root, stage, runId, summaryPatch = {}) {
  const run = path.join(root, `docs/migration/${stage}/evidence/runs/${runId}`);
  fs.mkdirSync(run, { recursive: true });
  const summaryBytes = Buffer.from(JSON.stringify({
    schemaVersion: 1,
    status: 'completed',
    ok: true,
    sourceHashesStable: true,
    ...summaryPatch,
  }) + '\n');
  fs.writeFileSync(path.join(run, 'summary.json'), summaryBytes);
  const digest = crypto.createHash('sha256').update(summaryBytes).digest('hex');
  const manifestBytes = Buffer.from(JSON.stringify({
    schemaVersion: 1,
    immutableRunDirectory: true,
    artifacts: [{ path: 'summary.json', sha256: digest }],
  }) + '\n');
  fs.writeFileSync(path.join(run, 'evidence-manifest.json'), manifestBytes);
  return { digest, run };
}

test('argument parser accepts only explicit P07 safety modes', () => {
  assert.deepEqual(parseArgs(['preflight']), { mode: 'preflight' });
  assert.deepEqual(parseArgs(['evidence', 'summary.json']), { mode: 'evidence', summary: 'summary.json' });
  assert.throws(() => parseArgs([]), /usage:/);
  assert.throws(() => parseArgs(['evidence']), /usage:/);
});

test('P07 temporary ownership is constrained to its verifier prefix', () => {
  assert.equal(isOwnedTemporaryRoot(path.join(os.tmpdir(), 'autoplan-p07-verify-safe')), true);
  assert.equal(isOwnedTemporaryRoot(path.join(os.tmpdir(), 'autoplan-p06-verify-safe')), false);
  assert.equal(isOwnedTemporaryRoot(ROOT), false);
});

test('sensitive material scanner rejects reusable credentials and unsafe local surfaces', () => {
  assert.deepEqual(scanSensitiveText('status=ok'), []);
  assert.ok(scanSensitiveText('Bearer abcdefghijklmnop').includes('usable-bearer'));
  assert.ok(scanSensitiveText('app.getPath("userData")').includes('electron-userdata'));
  assert.ok(scanSensitiveText('file:///private/fixture.txt').includes('local-file-url'));
  assert.ok(scanSensitiveText('"stored_path":"/tmp/raw"').includes('stored-path-field'));
});

test('writer timeline enforces P05, P06, P07 safety, one Node writer and all Go writers', () => {
  const result = inspectWriterTimeline(safeTimeline());
  assert.equal(result.sequential, true);
  assert.equal(result.simultaneousNodeGoWriter, false);
  assert.equal(result.nodeClosedBeforeGo, true);
  assert.deepEqual(new Set(result.goWriterCommands), GO_WRITER_COMMANDS);

  const overlap = safeTimeline();
  overlap[4].startedAt = overlap[3].startedAt;
  assert.throws(() => inspectWriterTimeline(overlap), (error) =>
    error instanceof SafetyError && error.code === 'command_timeline_overlap');
});

test('evidence requires accepted commands, P05/P06 gates and temporary-only safety declarations', () => {
  assert.equal(inspectEvidenceSummary(safeSummary()).ok, true);

  const rejected = safeSummary();
  rejected.commandResults[4].evaluation.accepted = false;
  assert.throws(() => inspectEvidenceSummary(rejected), (error) =>
    error instanceof SafetyError && error.code === 'command_not_accepted');

  const unsafe = safeSummary();
  unsafe.databaseOwnership.p06GateAccepted = false;
  assert.throws(() => inspectEvidenceSummary(unsafe), (error) =>
    error instanceof SafetyError && error.code === 'evidence_summary_invalid');
});

test('P05 and P06 evidence must be immutable, completed and hash-linked', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autoplan-p07-safety-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const p05 = writeEvidence(root, 'p05', '20260711-p05');
  const p06 = writeEvidence(root, 'p06', '20260711-p06');
  assert.equal(inspectP05Evidence(root).summarySha256, p05.digest);
  assert.equal(inspectP06Evidence(root).summarySha256, p06.digest);
  fs.writeFileSync(path.join(p06.run, 'summary.json'), '{}');
  assert.throws(() => inspectP06Evidence(root), (error) =>
    error instanceof SafetyError && error.code === 'p06_evidence_invalid');
});

test('checked P07 sources retain fixtures, action routes, owner guard and transport boundaries', () => {
  const result = inspectSourceSafety(ROOT);
  assert.equal(result.ok, true);
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.stateMachineScenarioCount, 16);
  assert.ok(result.openapiRoutes.includes('/api/v1/plans'));
  assert.ok(result.openapiRoutes.includes('/api/v1/plans/actions/run'));
  assert.match(result.databaseOwnerGuardSha256, /^[a-f0-9]{64}$/);
});
