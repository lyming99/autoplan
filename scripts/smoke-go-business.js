'use strict';

const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { GoDaemonSupervisor } = require('../src/daemon/supervisor');

const root = path.resolve(__dirname, '..');

async function main() {
  const mcpPort = await freeLoopbackPort();
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'autoplan-business-smoke-'));
  const dataDir = path.join(temporary, 'data');
  const workspace = path.join(temporary, 'workspace');
  fs.mkdirSync(dataDir);
  fs.mkdirSync(workspace);
  const fakeAgent = path.join(temporary, 'fake-agent.exe');
  const fakeBuild = spawnSync('go', [
    'build', '-o', fakeAgent, './internal/bootstrap/testdata/fake_agent.go',
  ], { cwd: path.join(root, 'backend'), encoding: 'utf8' });
  if (fakeBuild.status !== 0) throw new Error(`fake_agent_build_failed: ${fakeBuild.stderr || fakeBuild.stdout}`);
  const executablePath = path.join(root, 'artifacts', 'sidecar', 'win32', 'x64', 'autoplan-server.exe');
  const enabled = Object.fromEntries([
    'AUTOPLAN_SIDECAR_GO_LOOP_ACTIONS', 'AUTOPLAN_SIDECAR_GO_PLAN_ACTIONS',
    'AUTOPLAN_SIDECAR_GO_TASK_ACTIONS', 'AUTOPLAN_SIDECAR_GO_ACCEPTANCE_RETRY_ACTIONS',
    'AUTOPLAN_SIDECAR_GO_SCRIPTS_API', 'AUTOPLAN_SIDECAR_GO_EXECUTORS_API',
    'AUTOPLAN_SIDECAR_GO_CHAT_API', 'AUTOPLAN_SIDECAR_GO_MCP_API',
    'AUTOPLAN_SIDECAR_GO_TERMINAL_API',
  ].map((name) => [name, true]));
  enabled.AUTOPLAN_SIDECAR_GO_AGENT_CLI_RUNTIME = false;
  const supervisor = new GoDaemonSupervisor({ executablePath, dataDir, runtimeFeatureEnvironment: enabled, mcpPort });
  let eventAbort = null;
  try {
    await supervisor.start();
    const client = supervisor.clientOptions();
    let sequence = 0;
    const request = async (method, route, body, key) => {
      sequence += 1;
      const response = await fetch(`${client.baseUrl}${route}`, {
        method,
        headers: {
          Accept: 'application/json', Origin: client.origin,
          'X-Autoplan-Session': client.sessionToken,
          'X-Request-ID': `req_business_smoke_${sequence}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(key ? { 'Idempotency-Key': key } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const value = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(`${method} ${route}: ${response.status} ${value?.code || 'invalid_response'}`);
      }
      return value?.data;
    };
    const created = await request('POST', '/api/v1/projects', {
      name: 'Business smoke', workspace_path: workspace, description: 'temporary',
    }, 'business-smoke-project');
    const project = created.activeProject || created.active_project || created.projects?.[0];
    if (!project?.id) throw new Error('project_create_response_invalid');

    // The renderer's two AI settings forms converge on these Go-owned static
    // routes. Exercise real SQLite persistence and verify write-only secrets
    // are represented only by presence and masked projections.
    const aiSecret = 'business-smoke-secret-9876';
    const aiConfig = await request('POST', '/api/v1/ai-configs', {
      name: 'Business smoke AI', provider: 'openai', base_url: 'https://api.openai.com',
      api_key: aiSecret, model: 'gpt-5.5', temperature: '0.3', thinking_depth: 'high',
    }, 'business-smoke-ai-create');
    if (!aiConfig?.id || !aiConfig.has_api_key || !String(aiConfig.masked_key || '').endsWith('9876') ||
        JSON.stringify(aiConfig).includes(aiSecret)) {
      throw new Error('go_ai_config_create_or_redaction_failed');
    }
    const aiConfigs = await request('GET', '/api/v1/ai-configs');
    if (!Array.isArray(aiConfigs) || !aiConfigs.some((item) => Number(item.id) === Number(aiConfig.id)) ||
        JSON.stringify(aiConfigs).includes(aiSecret)) {
      throw new Error('go_ai_config_persistence_or_redaction_failed');
    }
    const clearedAIConfig = await request('PATCH', `/api/v1/ai-configs/${aiConfig.id}`, {
      version: aiConfig.version, name: 'Business smoke AI updated', api_key: '',
    }, 'business-smoke-ai-update');
    if (clearedAIConfig?.has_api_key || clearedAIConfig?.name !== 'Business smoke AI updated') {
      throw new Error('go_ai_config_update_failed');
    }
    const deletedAIConfig = await request('DELETE', `/api/v1/ai-configs/${aiConfig.id}?version=${clearedAIConfig.version}`,
      undefined, 'business-smoke-ai-delete');
    if (deletedAIConfig?.deleted !== true) throw new Error('go_ai_config_delete_failed');

    const mcpRequest = async (method, params, id) => {
      const response = await fetch(`http://127.0.0.1:${mcpPort}/mcp`, {
        method: 'POST',
        headers: {
          Accept: 'application/json', 'Content-Type': 'application/json', Origin: client.origin,
          Authorization: `Bearer ${client.sessionToken}`, 'X-Autoplan-Session': client.sessionToken,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }),
      });
      const value = await response.json().catch(() => null);
      if (!response.ok || value?.error) throw new Error(`mcp_${method.replace('/', '_')}_failed:${response.status}`);
      return value?.result;
    };
    const mcpTools = await mcpRequest('tools/list', null, 1);
    if (!Array.isArray(mcpTools?.tools) || !mcpTools.tools.some((tool) => tool.name === 'list_projects')) {
      throw new Error('mcp_tool_catalog_missing');
    }
    const mcpProjects = await mcpRequest('tools/call', { name: 'list_projects', arguments: {} }, 2);
    if (mcpProjects?.isError || !Array.isArray(mcpProjects?.structuredContent?.projects) ||
        !mcpProjects.structuredContent.projects.some((item) => Number(item.id) === Number(project.id))) {
      throw new Error('mcp_go_application_adapter_unavailable');
    }
    eventAbort = new AbortController();
    const eventResponse = await fetch(`${client.baseUrl}/api/v1/projects/${project.id}/events`, {
      headers: {
        Accept: 'text/event-stream', Origin: client.origin,
        'X-Autoplan-Session': client.sessionToken,
        'X-Request-ID': 'req_business_smoke_events',
      },
      signal: eventAbort.signal,
    });
    if (!eventResponse.ok || !eventResponse.body) {
      throw new Error(`project_event_stream_unavailable:${eventResponse.status}`);
    }
    const taskEventPromise = (async () => {
      const reader = eventResponse.body.getReader();
      const decoder = new TextDecoder();
      let received = '';
      const timeout = setTimeout(() => eventAbort.abort(), 30000);
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          received += decoder.decode(value, { stream: true });
          if (received.includes('event: business.task_succeeded') && received.includes('"task_title":"')) return true;
          if (received.length > 131072) received = received.slice(-65536);
        }
      } catch (error) {
        if (!eventAbort.signal.aborted) throw error;
      } finally {
        clearTimeout(timeout);
        await reader.cancel().catch(() => undefined);
      }
      return false;
    })();
    await request('POST', `/api/v1/projects/${project.id}/requirements`, {
      title: 'Business smoke requirement', body: 'Create the smoke marker in this workspace.',
      status: 'open',
      agent_cli: { provider: 'codex', command: fakeAgent, codex_reasoning_effort: 'medium' },
    }, 'business-smoke-requirement');
    const loop = await request('POST', `/api/v1/projects/${project.id}/loop/actions/start`, {}, 'business-smoke-loop');
    let requirementId = null;
    let requirementStatus = '';
    let linkedPlanId = null;
    let generatedTaskCount = 0;
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const requirements = await request('GET', `/api/v1/projects/${project.id}/requirements?page=1&page_size=50`);
      const items = Array.isArray(requirements) ? requirements : requirements?.items || [];
      requirementId = Number(items[0]?.id || 0) || null;
      requirementStatus = String(items[0]?.status || '');
      linkedPlanId = Number(items[0]?.linked_plan_id || 0) || null;
      if (linkedPlanId) {
        const snapshot = await request('GET', `/api/v1/projects/${project.id}/snapshot`);
        generatedTaskCount = Array.isArray(snapshot?.tasks) ? snapshot.tasks.length : 0;
      }
      if (requirementStatus === 'open' && linkedPlanId && generatedTaskCount === 3) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!requirementId || requirementStatus !== 'open' || !linkedPlanId || generatedTaskCount !== 3) {
      throw new Error(`loop_plan_not_generated: ${requirementStatus || 'missing'}:${linkedPlanId || 0}:${generatedTaskCount}`);
    }

    let planStatus = '';
    let completedTaskCount = 0;
    let completedTasks = [];
    let executionLogVisible = false;
    const completionDeadline = Date.now() + 30000;
    while (Date.now() < completionDeadline) {
      const snapshot = await request('GET', `/api/v1/projects/${project.id}/snapshot`);
      const plan = (snapshot?.plans || []).find((item) => Number(item.id) === linkedPlanId);
      const tasks = (snapshot?.tasks || []).filter((item) => Number(item.plan_id) === linkedPlanId);
      completedTasks = tasks;
      planStatus = String(plan?.status || '');
      completedTaskCount = tasks.filter((item) => item.status === 'completed').length;
      executionLogVisible = snapshot?.lastOperation?.operationType === 'loop.run_once'
        && String(snapshot.lastOperation.logTail || '').length > 0;
      const requirements = await request('GET', `/api/v1/projects/${project.id}/requirements?page=1&page_size=50`);
      const items = Array.isArray(requirements) ? requirements : requirements?.items || [];
      requirementStatus = String(items[0]?.status || '');
      if (planStatus === 'completed' && completedTaskCount === 3 && requirementStatus === 'completed' && executionLogVisible) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const realtimeTaskEvent = await taskEventPromise;
    eventAbort.abort();
    if (planStatus !== 'completed' || completedTaskCount !== 3 || requirementStatus !== 'completed') {
      throw new Error(`loop_tasks_not_completed:${planStatus || 'missing'}:${completedTaskCount}:${requirementStatus || 'missing'}`);
    }
    if (!executionLogVisible) throw new Error('loop_execution_log_not_projected');
    if (!realtimeTaskEvent) throw new Error('loop_realtime_event_not_received');
    if (!fs.existsSync(path.join(workspace, 'autoplan-task-executed.txt'))) {
      throw new Error('loop_agent_task_not_executed');
    }

    await request('POST', `/api/v1/projects/${project.id}/acceptance/actions/accept`, {
      target_type: 'plan', id: linkedPlanId,
    }, 'business-smoke-accept-plan');
    let acceptanceSnapshot = await waitForSnapshot(request, project.id, (snapshot) =>
      Boolean((snapshot?.plans || []).find((item) => Number(item.id) === linkedPlanId)?.accepted_at));
    if (!acceptanceSnapshot) throw new Error('go_acceptance_plan_not_persisted');
    await request('POST', `/api/v1/projects/${project.id}/acceptance/actions/unaccept`, {
      target_type: 'plan', id: linkedPlanId,
    }, 'business-smoke-unaccept-plan');
    acceptanceSnapshot = await waitForSnapshot(request, project.id, (snapshot) =>
      (snapshot?.plans || []).find((item) => Number(item.id) === linkedPlanId)?.accepted_at === null);
    if (!acceptanceSnapshot) throw new Error('go_unacceptance_plan_not_persisted');
    const acceptanceTargets = completedTasks.slice(0, 2).map((task) => ({ target_type: 'task', id: Number(task.id) }));
    if (acceptanceTargets.length !== 2 || acceptanceTargets.some((target) => !target.id)) {
      throw new Error('go_acceptance_task_targets_missing');
    }
    await request('POST', `/api/v1/projects/${project.id}/acceptance/actions/accept-batch`, {
      targets: acceptanceTargets,
    }, 'business-smoke-accept-task-batch');
    acceptanceSnapshot = await waitForSnapshot(request, project.id, (snapshot) => {
      const accepted = new Map((snapshot?.tasks || []).map((task) => [Number(task.id), task.accepted_at]));
      return acceptanceTargets.every((target) => Boolean(accepted.get(target.id)));
    });
    if (!acceptanceSnapshot) throw new Error('go_acceptance_batch_not_persisted');
    await request('POST', `/api/v1/projects/${project.id}/acceptance/actions/unaccept-batch`, {
      targets: acceptanceTargets,
    }, 'business-smoke-unaccept-task-batch');
    acceptanceSnapshot = await waitForSnapshot(request, project.id, (snapshot) => {
      const accepted = new Map((snapshot?.tasks || []).map((task) => [Number(task.id), task.accepted_at]));
      return acceptanceTargets.every((target) => accepted.get(target.id) === null);
    });
    if (!acceptanceSnapshot) throw new Error('go_unacceptance_batch_not_persisted');

    // A draft intake may generate a preview plan, but repeated automatic or
    // explicit loop cycles must not claim its tasks until the user activates
    // it through the task action.
    const draftTitle = 'Business smoke draft requirement';
    const executionMarker = path.join(workspace, 'autoplan-task-executed.txt');
    const markerBeforeDraft = fs.statSync(executionMarker).mtimeMs;
    await request('POST', `/api/v1/projects/${project.id}/requirements`, {
      title: draftTitle, body: 'Generate this plan as a draft and wait for explicit execution.', status: 'draft',
      agent_cli: { provider: 'codex', command: fakeAgent, codex_reasoning_effort: 'medium' },
    }, 'business-smoke-draft-requirement');
    let draftIntakeId = null;
    let draftPlanId = null;
    let draftTasks = [];
    const draftDeadline = Date.now() + 15000;
    while (Date.now() < draftDeadline) {
      const requirements = await request('GET', `/api/v1/projects/${project.id}/requirements?page=1&page_size=50`);
      const items = Array.isArray(requirements) ? requirements : requirements?.items || [];
      const draft = items.find((item) => item.title === draftTitle);
      draftIntakeId = Number(draft?.id || 0) || null;
      draftPlanId = Number(draft?.linked_plan_id || 0) || null;
      if (draftPlanId) {
        const snapshot = await request('GET', `/api/v1/projects/${project.id}/snapshot`);
        draftTasks = (snapshot?.tasks || []).filter((item) => Number(item.plan_id) === draftPlanId);
        const plan = (snapshot?.plans || []).find((item) => Number(item.id) === draftPlanId);
        if (plan?.status === 'draft' && draftTasks.length === 3) break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!draftIntakeId || !draftPlanId || draftTasks.length !== 3) throw new Error('draft_plan_not_generated');
    await request('POST', `/api/v1/projects/${project.id}/loop/actions/run-once`, {}, 'business-smoke-draft-skip-1');
    await request('POST', `/api/v1/projects/${project.id}/loop/actions/run-once`, {}, 'business-smoke-draft-skip-2');
    await new Promise((resolve) => setTimeout(resolve, 500));
    let draftSnapshot = await request('GET', `/api/v1/projects/${project.id}/snapshot`);
    let draftPlan = (draftSnapshot?.plans || []).find((item) => Number(item.id) === draftPlanId);
    draftTasks = (draftSnapshot?.tasks || []).filter((item) => Number(item.plan_id) === draftPlanId);
    if (draftPlan?.status !== 'draft' || draftTasks.some((task) => task.status !== 'pending') ||
        fs.statSync(executionMarker).mtimeMs !== markerBeforeDraft) {
      throw new Error('draft_plan_was_executed_automatically');
    }
    await request('POST', `/api/v1/projects/${project.id}/loop/actions/stop`, {}, 'business-smoke-loop-pause-for-intake-actions');
    await request('POST', `/api/v1/projects/${project.id}/intake/requirement/${draftIntakeId}/actions/interrupt`, {},
      'business-smoke-intake-interrupt');
    let intakeActionSnapshot = await waitForSnapshot(request, project.id, (snapshot) => {
      const plan = (snapshot?.plans || []).find((item) => Number(item.id) === draftPlanId);
      const tasks = (snapshot?.tasks || []).filter((item) => Number(item.plan_id) === draftPlanId);
      return plan?.status === 'interrupted' && tasks.length === 3 && tasks.every((task) => task.status === 'blocked');
    });
    if (!intakeActionSnapshot) throw new Error('go_intake_interrupt_not_persisted');
    await request('POST', `/api/v1/projects/${project.id}/intake/requirement/${draftIntakeId}/actions/resume`, {},
      'business-smoke-intake-resume');
    intakeActionSnapshot = await waitForSnapshot(request, project.id, (snapshot) => {
      const plan = (snapshot?.plans || []).find((item) => Number(item.id) === draftPlanId);
      const tasks = (snapshot?.tasks || []).filter((item) => Number(item.plan_id) === draftPlanId);
      return plan?.status === 'pending' && tasks.length === 3 && tasks.every((task) => task.status === 'pending');
    });
    if (!intakeActionSnapshot) throw new Error('go_intake_resume_not_persisted');
    // Keep the background timer stopped until the explicit task intent is
    // admitted. Starting it first can let a fast runner claim this pending
    // task between the resume snapshot and the manual action.
    await request('POST', `/api/v1/projects/${project.id}/tasks/${draftTasks[0].id}/actions/run`, {
      plan_id: draftPlanId,
    }, 'business-smoke-draft-activate');
    await request('POST', `/api/v1/projects/${project.id}/loop/actions/start`, {}, 'business-smoke-loop-resume-after-intake-actions');
    const draftCompletionDeadline = Date.now() + 30000;
    while (Date.now() < draftCompletionDeadline) {
      draftSnapshot = await request('GET', `/api/v1/projects/${project.id}/snapshot`);
      draftPlan = (draftSnapshot?.plans || []).find((item) => Number(item.id) === draftPlanId);
      draftTasks = (draftSnapshot?.tasks || []).filter((item) => Number(item.plan_id) === draftPlanId);
      if (draftPlan?.status === 'completed' && draftTasks.every((task) => task.status === 'completed')) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (draftPlan?.status !== 'completed' || !draftTasks.every((task) => task.status === 'completed')) {
      throw new Error(`draft_manual_execution_failed:${draftPlan?.status || 'missing'}`);
    }

    // Persist and execute a Script exclusively through the Go application,
    // process runner, scheduler and atomic last_log archive.
    const script = await request('POST', `/api/v1/projects/${project.id}/scripts`, {
      name: 'Go script smoke', runtime: 'node', source_type: 'inline', trigger_mode: 'manual', enabled: true,
      body: "require('node:fs').writeFileSync('go-script-marker.txt','go-owned'); console.log('go script completed')",
      work_dir: '.', timeout_seconds: 30, context_inject: 'none', fail_aborts: true,
    }, 'business-smoke-script-create');
    if (!script?.id) throw new Error('go_script_create_failed');
    const scriptRun = await request('POST', `/api/v1/projects/${project.id}/scripts/${script.id}/actions/run`, {}, 'business-smoke-script-run');
    if (scriptRun?.type !== 'script.run' || !scriptRun?.operation_id) throw new Error('go_script_operation_missing');
    let scriptSnapshot = null;
    let scriptState = null;
    const scriptDeadline = Date.now() + 15000;
    while (Date.now() < scriptDeadline) {
      scriptSnapshot = await request('GET', `/api/v1/projects/${project.id}/snapshot`);
      scriptState = (scriptSnapshot?.scripts || []).find((item) => Number(item.id) === Number(script.id));
      if (scriptState?.last_status === 'ok' && fs.existsSync(path.join(workspace, 'go-script-marker.txt'))) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (scriptState?.last_status !== 'ok' || !String(scriptState?.last_log || '').includes('go script completed') ||
        fs.readFileSync(path.join(workspace, 'go-script-marker.txt'), 'utf8') !== 'go-owned') {
      throw new Error(`go_script_execution_or_archive_failed:${scriptState?.last_status || 'missing'}:${String(scriptState?.last_log || '').slice(0, 512)}`);
    }

    // Exercise the installed retry route end to end: first force three Agent
    // start failures, repair the intake configuration, reset its failure
    // state through the public action, and verify a new plan is generated.
    const retryTitle = 'Business smoke retry requirement';
    await request('POST', `/api/v1/projects/${project.id}/requirements`, {
      title: retryTitle, body: 'Verify failed plan generation can be retried.', status: 'draft',
      agent_cli: { provider: 'codex', command: `${fakeAgent}.missing`, codex_reasoning_effort: 'medium' },
    }, 'business-smoke-retry-requirement');
    let retryItem = null;
    const failureDeadline = Date.now() + 20000;
    while (Date.now() < failureDeadline) {
      const requirements = await request('GET', `/api/v1/projects/${project.id}/requirements?page=1&page_size=50`);
      const items = Array.isArray(requirements) ? requirements : requirements?.items || [];
      retryItem = items.find((item) => item.title === retryTitle) || null;
      if (Number(retryItem?.generate_fail_count || 0) >= 3) break;
      await request('POST', `/api/v1/projects/${project.id}/loop/actions/run-once`, {}, `business-smoke-fail-${sequence}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!retryItem?.id || Number(retryItem.generate_fail_count || 0) !== 3) {
      throw new Error(`retry_failure_state_missing:${retryItem?.generate_fail_count || 0}`);
    }
    await request('PATCH', `/api/v1/projects/${project.id}/requirements/${retryItem.id}`, {
      expected_updated_at: retryItem.updated_at,
      agent_cli: { provider: 'codex', command: fakeAgent, codex_reasoning_effort: 'medium' },
    }, 'business-smoke-retry-config');
    const retried = await request('POST', `/api/v1/projects/${project.id}/intake/requirement/${retryItem.id}/actions/retry-plan-generation`, {}, 'business-smoke-retry-action');
    const resetItem = retried?.snapshot?.requirements?.find((item) => Number(item.id) === Number(retryItem.id));
    if (!resetItem || Number(resetItem.generate_fail_count || 0) !== 0) {
      throw new Error(`retry_failure_state_not_reset:${resetItem?.generate_fail_count ?? 'missing'}`);
    }
    await request('POST', `/api/v1/projects/${project.id}/loop/actions/run-once`, {}, 'business-smoke-retry-run');
    let retryLinkedPlanId = null;
    const retryDeadline = Date.now() + 15000;
    while (Date.now() < retryDeadline) {
      const requirements = await request('GET', `/api/v1/projects/${project.id}/requirements?page=1&page_size=50`);
      const items = Array.isArray(requirements) ? requirements : requirements?.items || [];
      retryItem = items.find((item) => Number(item.id) === Number(retryItem.id));
      retryLinkedPlanId = Number(retryItem?.linked_plan_id || 0) || null;
      if (retryLinkedPlanId) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!retryLinkedPlanId) throw new Error('retry_plan_not_generated');

    const terminal = await request('POST', `/api/v1/projects/${project.id}/terminals`, {
      cwd: workspace, profile: { id: 'default' }, cols: 80, rows: 24,
    }, 'business-smoke-terminal');
    await request('POST', `/api/v1/terminals/${terminal.id}/actions/close?project_id=${project.id}`, {}, 'business-smoke-terminal-close');
    await request('POST', `/api/v1/projects/${project.id}/loop/actions/stop`, {}, 'business-smoke-loop-stop');
    const appendedTitle = 'Business smoke appended Go task';
    await request('POST', `/api/v1/projects/${project.id}/intake/requirement/${requirementId}/actions/append-task`, {
      title: appendedTitle,
    }, 'business-smoke-intake-append');
    const appendedSnapshot = await waitForSnapshot(request, project.id, (snapshot) => {
      const plan = (snapshot?.plans || []).find((item) => Number(item.id) === linkedPlanId);
      const tasks = (snapshot?.tasks || []).filter((item) => Number(item.plan_id) === linkedPlanId);
      return plan?.status === 'pending' && tasks.length === 4 && tasks.some((task) => task.title === appendedTitle && task.status === 'pending');
    });
    if (!appendedSnapshot) throw new Error('go_intake_append_task_not_persisted');
    process.stdout.write(`${JSON.stringify({
      status: 'verified', project_id: project.id,
      loop_operation: loop.operation_id, terminal_id: terminal.id, terminal_status: terminal.status,
      requirement_status: requirementStatus, linked_plan_id: linkedPlanId, generated_task_count: generatedTaskCount,
      plan_status: planStatus, completed_task_count: completedTaskCount,
      execution_log_visible: executionLogVisible, realtime_task_event: realtimeTaskEvent,
      mcp_list_projects: true, draft_auto_skipped: true, draft_manual_status: draftPlan.status,
      script_status: scriptState.last_status, script_log_archived: true,
      retry_failure_count: 3, retry_reset_count: 0, retry_linked_plan_id: retryLinkedPlanId,
      ai_config_crud: true, acceptance_single_and_batch: true,
      intake_interrupt_resume_append: true, appended_task_count: 4,
    })}\n`);
  } finally {
    eventAbort?.abort();
    await supervisor.stop().catch(() => undefined);
    if (process.env.AUTOPLAN_KEEP_SMOKE_TEMP === 'true') {
      process.stderr.write(`business_smoke_temp=${temporary}\n`);
    } else {
      try { fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
      catch { /* Windows may retain a short-lived ConPTY handle; the OS temp root is disposable. */ }
    }
  }
}

async function waitForSnapshot(request, projectId, predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snapshot = await request('GET', `/api/v1/projects/${projectId}/snapshot`);
    if (predicate(snapshot)) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return null;
}

function freeLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      server.close((error) => {
        if (error) reject(error);
        else if (!Number.isSafeInteger(port) || port <= 0) reject(new Error('mcp_smoke_port_unavailable'));
        else resolve(port);
      });
    });
  });
}

main().catch((error) => {
  process.stderr.write(`${String(error?.message || 'business_smoke_failed')}\n`);
  process.exitCode = 1;
});
