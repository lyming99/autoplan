'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');
const TEMPORARY_PREFIX = 'autoplan-p07-verify-';
const PRIOR_EVIDENCE_ROOTS = {
  p05: 'docs/migration/p05/evidence/runs',
  p06: 'docs/migration/p06/evidence/runs',
};
const NODE_WRITER_COMMANDS = new Set(['node-plan-golden']);
const GO_WRITER_COMMANDS = new Set([
  'go-repository',
  'go-plans-application',
  'go-acceptance-application',
  'go-events-application',
  'go-httpapi',
  'go-mcp',
]);
const REQUIRED_HTTP_ROUTES = [
  '/api/v1/capabilities:',
  '/api/v1/plans:',
  '/api/v1/plans/actions/run:',
  '/api/v1/plans/actions/stop:',
  '/api/v1/plans/actions/resume:',
  '/api/v1/plans/actions/re-execute:',
  '/api/v1/plans/actions/recreate:',
  '/api/v1/tasks/actions/run:',
  '/api/v1/tasks/actions/run-batches:',
  '/api/v1/tasks/actions/stop:',
];
const REQUIRED_SCENARIOS = [
  'accept-plan-completed',
  'unaccept-plan-completed',
  'accept-task-done',
  'unaccept-task-passed',
  'redo-completed-plan-with-completed-tasks',
  'redo-completed-task',
  'reorder-complete-project-set',
  'delete-idle-plan-keeps-linked-intakes',
  'accept-pending-plan-rejected',
  'accept-running-task-rejected',
  'duplicate-accept-target-is-idempotent',
  'cross-project-target-rejected',
  'missing-target-rejected',
  'stale-reorder-rejected',
  'delete-running-plan-protected',
  'delete-plan-with-running-task-protected',
];
const REQUIRED_ERROR_SCENARIOS = [
  'accept-pending-plan-rejected',
  'accept-running-task-rejected',
  'cross-project-target-rejected',
  'missing-target-rejected',
  'stale-reorder-rejected',
  'delete-running-plan-protected',
  'delete-plan-with-running-task-protected',
  'long-action-disabled',
];
const FORBIDDEN_OUTPUT = [
  ['usable-key', /\b(?:sk|ghp|xox[baprs])[-_][A-Za-z0-9_-]{12,}\b/i],
  ['usable-bearer', /Bearer\s+(?!<redacted>)[A-Za-z0-9._~+/-]{12,}/i],
  ['private-key', /BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/],
  ['credential-value', /(?:api[_-]?key|auth[_-]?token|session[_-]?credential|password|cookie)[^\r\n]{0,16}[=:][^\r\n]{0,4}["']?[A-Za-z0-9._~+/-]{12,}/i],
  ['electron-userdata', /(?:electron[\\/]user\s*data|app\.getpath\s*\(\s*["']userdata)/i],
  ['production-database', /\bautoplan\.sqlite\b/i],
  ['local-file-url', /(?:file|autoplan-file):\/\//i],
  ['stored-path-field', /\bstored_path\b/i],
];

class SafetyError extends Error {
  constructor(code) {
    super(`P07 safety check failed (${code})`);
    this.name = 'SafetyError';
    this.code = code;
  }
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function toPosix(value) {
  return String(value).replace(/\\/g, '/');
}

function readJson(file) {
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SafetyError('json_root_invalid');
  return value;
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function scanSensitiveText(value) {
  const text = String(value || '');
  return FORBIDDEN_OUTPUT.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
}

function isOwnedTemporaryRoot(value) {
  if (typeof value !== 'string' || !value) return false;
  const resolved = path.resolve(value);
  const temporary = path.resolve(os.tmpdir());
  const relative = path.relative(temporary, resolved);
  return path.basename(resolved).startsWith(TEMPORARY_PREFIX) && relative !== '' &&
    !relative.startsWith('..') && !path.isAbsolute(relative);
}

function requireSource(root, relative, markers, code) {
  const target = path.join(root, relative);
  if (!fs.existsSync(target)) throw new SafetyError(code);
  const source = fs.readFileSync(target, 'utf8');
  if (markers.some((marker) => !source.includes(marker))) throw new SafetyError(code);
  return { source, sha256: sha256(source) };
}

function inspectPriorEvidence(rootDir = ROOT, stage) {
  const root = path.resolve(rootDir);
  const runs = path.join(root, PRIOR_EVIDENCE_ROOTS[stage] || '');
  if (!fs.existsSync(runs)) throw new SafetyError(`${stage}_evidence_missing`);
  const candidates = fs.readdirSync(runs, { withFileTypes: true })
    .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort().reverse();
  if (!candidates.length) throw new SafetyError(`${stage}_evidence_missing`);
  const run = path.join(runs, candidates[0]);
  const summaryBytes = fs.readFileSync(path.join(run, 'summary.json'));
  const manifestBytes = fs.readFileSync(path.join(run, 'evidence-manifest.json'));
  const summary = JSON.parse(summaryBytes);
  const manifest = JSON.parse(manifestBytes);
  const summarySha256 = sha256(summaryBytes);
  const linked = Array.isArray(manifest.artifacts) && manifest.artifacts.some(
    (item) => item.path === 'summary.json' && item.sha256 === summarySha256,
  );
  if (summary.schemaVersion !== 1 || summary.status !== 'completed' || summary.ok !== true ||
      summary.sourceHashesStable !== true || manifest.schemaVersion !== 1 ||
      manifest.immutableRunDirectory !== true || !linked) {
    throw new SafetyError(`${stage}_evidence_invalid`);
  }
  return {
    stage,
    runId: candidates[0],
    summarySha256,
    manifestSha256: sha256(manifestBytes),
    sourceHashesStable: true,
  };
}

function inspectP05Evidence(rootDir = ROOT) {
  return inspectPriorEvidence(rootDir, 'p05');
}

function inspectP06Evidence(rootDir = ROOT) {
  return inspectPriorEvidence(rootDir, 'p06');
}

function validateStateMachine(value) {
  if (!object(value) || value.schemaVersion !== 1 || value.version !== 'p07-node-plan-golden-v1' ||
      value.source !== 'synthetic-node-reference' || !Array.isArray(value.scenarios)) {
    throw new SafetyError('state_machine_fixture_invalid');
  }
  const seen = new Set();
  for (const scenario of value.scenarios) {
    if (!object(scenario) || typeof scenario.id !== 'string' || seen.has(scenario.id) ||
        typeof scenario.action !== 'string' || typeof scenario.target !== 'string' ||
        !object(scenario.prestate) || !object(scenario.response) ||
        typeof scenario.response.ok !== 'boolean') {
      throw new SafetyError('state_machine_fixture_invalid');
    }
    seen.add(scenario.id);
    if (scenario.response.ok === false &&
        (scenario.response.mutation !== false || scenario.response.audit_events !== 0)) {
      throw new SafetyError('state_machine_failure_mutates');
    }
  }
  if (REQUIRED_SCENARIOS.some((id) => !seen.has(id))) throw new SafetyError('state_machine_matrix_incomplete');
  return { scenarioCount: value.scenarios.length, ids: [...seen].sort() };
}

function validateExpectedErrors(value) {
  if (!object(value) || value.schemaVersion !== 1 || value.version !== 'p07-plan-expected-errors-v1' ||
      !object(value.scenarios)) {
    throw new SafetyError('expected_errors_invalid');
  }
  for (const id of REQUIRED_ERROR_SCENARIOS) {
    const mapping = value.scenarios[id];
    if (!object(mapping) || typeof mapping.node !== 'string' || typeof mapping.go !== 'string' ||
        typeof mapping.http !== 'string' || typeof mapping.retryable !== 'boolean') {
      throw new SafetyError('expected_errors_incomplete');
    }
  }
  if (value.scenarios['long-action-disabled'].go !== 'not_implemented' ||
      value.scenarios['long-action-disabled'].http !== 'not_implemented') {
    throw new SafetyError('not_implemented_mapping_drift');
  }
  return { scenarioCount: Object.keys(value.scenarios).length };
}

function inspectSourceSafety(rootDir = ROOT) {
  const root = path.resolve(rootDir);
  const stateMachinePath = path.join(root, 'fixtures/migration/p07/state-machine-cases.json');
  const expectedErrorsPath = path.join(root, 'fixtures/migration/p07/expected-errors.json');
  const stateMachineBytes = fs.readFileSync(stateMachinePath);
  const expectedErrorsBytes = fs.readFileSync(expectedErrorsPath);
  const stateMachine = readJson(stateMachinePath);
  const expectedErrors = readJson(expectedErrorsPath);
  const stateMachineInfo = validateStateMachine(stateMachine);
  const expectedErrorsInfo = validateExpectedErrors(expectedErrors);
  if (scanSensitiveText(stateMachineBytes.toString('utf8') + '\n' + expectedErrorsBytes.toString('utf8')).length) {
    throw new SafetyError('checked_fixture_sensitive');
  }

  const openapi = requireSource(root, 'backend/openapi/openapi.yaml',
    [...REQUIRED_HTTP_ROUTES, 'operationId: deletePlan', 'PlanDeleteRequest', 'PlanMutationEnvelope',
      'CapabilitiesEnvelope', 'ActionAccepted', 'not_implemented'],
    'openapi_p07_surface_drift');
  const capabilitySchema = readJson(path.join(root, 'backend/openapi/schemas/capability.schema.json'));
  const actionSchema = readJson(path.join(root, 'backend/openapi/schemas/action.schema.json'));
  if (capabilitySchema.$defs?.capability_response?.additionalProperties !== false ||
      capabilitySchema.$defs?.capability?.required?.join(',') !== 'id,enabled' ||
      actionSchema.$defs?.plan_action_request?.additionalProperties !== false ||
      actionSchema.$defs?.task_action_request?.additionalProperties !== false ||
      actionSchema.$defs?.run_batches_request?.additionalProperties !== false ||
      !actionSchema.$defs?.operation_reference?.required?.includes('operation_id')) {
    throw new SafetyError('openapi_schema_drift');
  }
  const owner = requireSource(root, 'backend/internal/repository/sqlite/transaction.go',
    ['DatabaseOwnerProof', 'AuthorizedCopy', 'ErrWriterUnauthorized', 'LevelSerializable', 'BeginTx'],
    'database_owner_guard_drift');
  const capabilityService = requireSource(root, 'backend/internal/application/capabilities/service.go',
    ['PlansRun', 'TasksRunBatches', 'Enabled: false', '{ID: PlansDelete, Enabled: true}',
      'ErrNotImplemented', 'options object'],
    'capability_catalog_drift');
  const planActions = requireSource(root, 'backend/internal/httpapi/plan_actions.go',
    ['DisabledActionEndpoint', 'does not decode', 'CodeNotImplemented', 'Capability'],
    'plan_action_boundary_drift');
  requireSource(root, 'backend/internal/httpapi/plans.go',
    ['PlansPath = "/api/v1/plans"', 'http.MethodDelete', 'RegisterPlanMutations', 'planDeleteRequest'],
    'plan_delete_route_drift');
  requireSource(root, 'backend/internal/bootstrap/dependencies.go',
    ['RegisterRuntimeRoutes', 'RegisterCapabilityRoutes(router, securityPolicy)',
      'RegisterPlanMutations(router, securityPolicy, dependencies.Plans)'],
    'plan_delete_runtime_composition_drift');
  const taskActions = requireSource(root, 'backend/internal/httpapi/task_actions.go',
    ['TaskRunBatchesActionPath', 'DisabledActionEndpoint', 'capabilities.TasksRunBatches'],
    'task_action_boundary_drift');
  const renderer = requireSource(root, 'src/renderer/lib/api/httpClient.ts',
    ['#supportsCapabilities', 'return this.#delegate', 'not_implemented', 'plans.reorder',
      "#supportsCapabilities(['plans.delete'])", "'/api/v1/plans'", "'DELETE'",
      'expected_updated_at: plan.updated_at'],
    'renderer_capability_transport_drift');
  requireSource(root, 'src/renderer/lib/api/transport.ts',
    ['Go HTTP/SSE/WebSocket', 'no business IPC fallback', 'new HttpAutoplanClient',
      'delegate: options.unavailableClient'],
    'renderer_transport_owner_drift');
  const comparator = requireSource(root, 'scripts/migration-p07/compare-plan-golden.js',
    ['assertStrictEqual', 'a separately reset Go artifact path is required', 'unknown scenario'],
    'golden_comparator_drift');
  if (/updateGolden|ignoreFields|writeFileSync\s*\([^)]*golden/i.test(comparator.source)) {
    throw new SafetyError('golden_comparator_escape_hatch');
  }
  return {
    ok: true,
    schemaVersion: 1,
    stateMachineSha256: sha256(stateMachineBytes),
    expectedErrorsSha256: sha256(expectedErrorsBytes),
    stateMachineScenarioCount: stateMachineInfo.scenarioCount,
    expectedErrorScenarioCount: expectedErrorsInfo.scenarioCount,
    databaseOwnerGuardSha256: owner.sha256,
    capabilityServiceSha256: capabilityService.sha256,
    planActionBoundarySha256: planActions.sha256,
    taskActionBoundarySha256: taskActions.sha256,
    rendererTransportSha256: renderer.sha256,
    openapiSha256: openapi.sha256,
    capabilitySchemaSha256: sha256(fs.readFileSync(path.join(root, 'backend/openapi/schemas/capability.schema.json'))),
    actionSchemaSha256: sha256(fs.readFileSync(path.join(root, 'backend/openapi/schemas/action.schema.json'))),
    comparatorSha256: comparator.sha256,
    openapiRoutes: REQUIRED_HTTP_ROUTES.map((route) => route.slice(0, -1)),
  };
}

function commandIntervals(commandResults) {
  if (!Array.isArray(commandResults)) throw new SafetyError('command_results_missing');
  return commandResults.map((item) => ({
    id: item.id,
    start: Date.parse(item.startedAt),
    end: Date.parse(item.endedAt),
  }));
}

function inspectWriterTimeline(commandResults) {
  const intervals = commandIntervals(commandResults);
  if (intervals.some((item) => !Number.isFinite(item.start) || !Number.isFinite(item.end) || item.end < item.start)) {
    throw new SafetyError('command_timeline_invalid');
  }
  for (let index = 1; index < intervals.length; index += 1) {
    if (intervals[index].start < intervals[index - 1].end) throw new SafetyError('command_timeline_overlap');
  }
  const node = intervals.filter((item) => NODE_WRITER_COMMANDS.has(item.id));
  const go = intervals.filter((item) => GO_WRITER_COMMANDS.has(item.id));
  if (node.length !== 1 || go.length !== GO_WRITER_COMMANDS.size ||
      new Set(go.map((item) => item.id)).size !== GO_WRITER_COMMANDS.size ||
      go.some((item) => item.start < node[0].end)) {
    throw new SafetyError('node_go_writer_handoff_invalid');
  }
  return {
    sequential: true,
    simultaneousNodeGoWriter: false,
    nodeClosedBeforeGo: true,
    nodeWriterCommands: node.map((item) => item.id),
    goWriterCommands: go.map((item) => item.id),
  };
}

function inspectEvidenceSummary(summary, options = {}) {
  if (!summary || summary.schemaVersion !== 1 || summary.status !== 'completed' || !Array.isArray(summary.commandResults) ||
      summary.environment?.electronUserDataAccessed !== false || summary.environment?.productionDatabaseOpened !== false ||
      summary.environment?.databaseContentCaptured !== false || summary.environment?.attachmentContentCaptured !== false ||
      summary.environment?.temporaryRootsOnly !== true || summary.databaseOwnership?.p05GateAccepted !== true ||
      summary.databaseOwnership?.p06GateAccepted !== true || summary.databaseOwnership?.p05EvidenceAccepted !== true ||
      summary.databaseOwnership?.p06EvidenceAccepted !== true || summary.databaseOwnership?.authorizedCopiesOnly !== true ||
      summary.databaseOwnership?.goWriteRequiresOwnerProof !== true ||
      !/^[a-f0-9]{64}$/.test(summary.databaseOwnership?.ownerGuardSha256 || '') ||
      summary.sourceHashesStable !== true) {
    throw new SafetyError('evidence_summary_invalid');
  }
  if (options.temporaryRoot && !isOwnedTemporaryRoot(options.temporaryRoot)) {
    throw new SafetyError('temporary_root_not_owned');
  }
  if (summary.commandResults[0]?.id !== 'p05-gate') throw new SafetyError('p05_gate_not_first');
  if (summary.commandResults[1]?.id !== 'p06-gate') throw new SafetyError('p06_gate_not_second');
  if (summary.commandResults[2]?.id !== 'p07-safety-preflight') throw new SafetyError('p07_safety_not_third');
  if (summary.commandResults.some((item) => item.evaluation?.accepted !== true)) throw new SafetyError('command_not_accepted');
  const sensitive = scanSensitiveText(JSON.stringify(summary.commandResults.map((item) => [
    item.command,
    item.evaluation?.reason,
    item.failureSignatures,
    item.structuredOutput,
  ])));
  if (sensitive.length) throw new SafetyError('evidence_sensitive');
  return {
    ok: true,
    schemaVersion: 1,
    writerTimeline: inspectWriterTimeline(summary.commandResults),
    sensitiveFindings: [],
    authorizedCopiesOnly: true,
    electronUserDataAccessed: false,
    productionDatabaseOpened: false,
  };
}

function parseArgs(argv) {
  if (argv.length === 1 && argv[0] === 'preflight') return { mode: 'preflight' };
  if (argv.length === 2 && argv[0] === 'evidence') return { mode: 'evidence', summary: argv[1] };
  throw new Error('usage: node scripts/migration-p07/check-safety.js <preflight|evidence summary.json>');
}

if (require.main === module) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = args.mode === 'preflight'
      ? inspectSourceSafety(ROOT)
      : inspectEvidenceSummary(readJson(path.resolve(args.summary)));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const code = error instanceof SafetyError ? error.code : 'safety_internal';
    process.stderr.write(`blocked: ${code}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  GO_WRITER_COMMANDS,
  NODE_WRITER_COMMANDS,
  REQUIRED_HTTP_ROUTES,
  SafetyError,
  inspectEvidenceSummary,
  inspectP05Evidence,
  inspectP06Evidence,
  inspectPriorEvidence,
  inspectSourceSafety,
  inspectWriterTimeline,
  isOwnedTemporaryRoot,
  parseArgs,
  scanSensitiveText,
  sha256,
  toPosix,
};
