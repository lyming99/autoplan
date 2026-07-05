const fs = require('node:fs');
const path = require('node:path');
const { nowIso } = require('../database');
const {
  DEFAULT_AGENT_CLI_PROVIDER,
  agentCliContextFields,
  agentCliProviderDisplayName,
  effectiveAgentCliConfig,
} = require('./agentCliConfig');
const {
  BUILTIN_PLAN_GENERATION_ERROR_CODES,
  generateBuiltinPlanSpec,
} = require('./builtinPlanGenerator');
const intakePlanLinks = require('./intakePlanLinks');
const planBackendConfig = require('./planBackendConfig');
const { PlanRenderError, renderPlanSpecMarkdown } = require('./planRenderer');
const {
  PLAN_SPEC_SCHEMA,
  PlanSpecValidationError,
  parsePlanSpecJson,
} = require('./structuredPlanSpec');
const workspaceFiles = require('./workspaceFiles');

const PHASED_PLAN_BODY_LENGTH_THRESHOLD = 3000;
const PHASED_PLAN_HEADING_THRESHOLD = 4;
const PHASED_PLAN_LIST_THRESHOLD = 14;
const PHASED_PLAN_STRUCTURE_THRESHOLD = 18;
const PHASED_PLAN_MAX_PHASES = 6;
const INTAKE_PLAN_GENERATE_ERROR_MAX_LENGTH = 2000;
const PLAN_GENERATION_STRATEGY_EXTERNAL_CLI_MARKDOWN = 'external-cli-markdown';
const PLAN_GENERATION_STRATEGY_EXTERNAL_CLI_STRUCTURED = 'external-cli-structured';
const PLAN_GENERATION_STRATEGY_BUILTIN_LLM_STRUCTURED = 'builtin-llm-structured';
const PHASED_PLAN_SIGNAL_RE = /分阶段|阶段化|阶段性计划|阶段性\s*plan|多阶段|多个计划|多计划|拆成多个计划|拆分为多个计划|拆分成多个|按阶段推进|phase(?:d|s)?|multi[-\s]?plan/i;
const PLAN_TASK_CHECKBOX_LINE_RE = /^[^\S\r\n]*[-*]\s*\[\s*[ xX]?\s*\]\s+(.+)$/;
const PLAN_TASK_LINE_RE = /^[^\S\r\n]*[-*]\s*\[\s*[ xX]?\s*\]\s+P0*(\d+)\s*[:：]\s*(.*?)\s*<!--\s*scope\s*[:=：]\s*([^>]*?)\s*-->\s*$/i;
const FINAL_ACCEPTANCE_RE = /完整验收|整体验收|总体验收|最终验收|完整验证|最终验证|acceptance|validation/i;

async function generatePlan(service, helpers, projectId, workspace, issueScan) {
  const { timestampForPath, readSnippet, normalizeRelative, hashFile } = helpers;
    service.setPhase(projectId, 'generate-plan');
    const projectStatus = service.status(projectId);
    const planGenerationConfig = effectivePlanGenerationConfigForService(service, projectStatus);
    const planExecutionConfig = effectivePlanExecutionConfigForService(service, projectStatus);
    if (isExternalCliStructuredPlanGeneration(planGenerationConfig)) {
      return generateStructuredPlan(service, helpers, projectId, workspace, issueScan, {
        projectStatus,
        planGenerationConfig,
        planExecutionConfig,
      });
    }
    if (isBuiltinLlmStructuredPlanGeneration(planGenerationConfig)) {
      return generateBuiltinStructuredPlan(service, helpers, projectId, workspace, issueScan, {
        projectStatus,
        planGenerationConfig,
        planExecutionConfig,
      });
    }
    if (!isExternalCliMarkdownPlanGeneration(planGenerationConfig)) {
      return recordUnsupportedPlanGenerationStrategy(service, {
        projectId,
        planGenerationConfig,
        planExecutionConfig,
      });
    }
    const planAgentCliOperation = planGenerationAgentCliOperationFieldsForService(service, planGenerationConfig);
    const planAgentCliConfig = effectiveAgentCliConfig({}, planAgentCliOperation);
    const planFile = path.join(
      workspace,
      'docs',
      'plan',
      `plan_${timestampForPath()}_${issueScan.aggregateHash.slice(0, 8)}.md`,
    );
    const issueBundle = issueScan.files
      .map((file) => {
        const full = path.join(workspace, file.path);
        return ['---', `path: ${file.path}`, `hash: ${file.hash}`, 'content:', readSnippet(full, 20000)].join('\n');
      })
      .join('\n');

    const prompt = [
      '你是需求整理与开发计划生成者。',
      '请根据 docs/issues 收集到的反馈和需求，生成一个开发计划和验收标准。',
      '',
      `输出文件：${planFile}`,
      '',
      '格式要求：',
      '- 每个任务必须严格使用固定格式：- [ ] P001: 任务标题 <!-- scope: lib/foo.dart,test/foo_test.dart -->',
      '- scope 必填，表示该任务预计修改的文件或模块；多个 scope 用英文逗号分隔；无法判断时写 <!-- scope: unknown -->，unknown 任务不会并发执行',
      '- 每个任务要有验收要点',
      '- 不要把“运行测试/回归/验收/构建”拆成普通开发任务；每个 plan 的最后一个任务必须是“完整验收”节点，负责对整个 plan 做最终验收',
      '- 最后一个任务必须严格放在任务列表最后，标题建议“完整验收”，scope 写 validation；总体验收标准写明最终验收命令、范围和通过标准',
      '- 如果需求明确要求新增或更新测试文件，可以生成“补充测试代码”的开发任务，但任务验收要点只描述应覆盖的场景，不要求在该任务内运行测试',
      '- 必须包含总体验收标准和进度区',
      '- 只写 plan 文件，不要改业务代码',
      '',
      '需求快照：',
      issueBundle,
    ].join('\n');

    const result = await service.runCodex(workspace, prompt, 'generate-plan', {
      projectId,
      ...planAgentCliOperation,
    });
    const agentContext = agentCliContextFields(result, { defaultProvider: true });
    const planAgentCliSnapshot = effectiveAgentCliConfig(planAgentCliConfig, agentContext);
    const planGenerationSnapshot = planGenerationConfigWithAgentCliSnapshot(
      service,
      planGenerationConfig,
      planAgentCliSnapshot,
    );
    const agentLabel = agentCliProviderDisplayName(agentContext.agentCliProvider);
    if (result.exitCode !== 0 || !fs.existsSync(planFile)) {
      service.addEvent(projectId, 'plan.generate.failed', `${agentLabel} 计划生成失败：${result.logFile}`, {
        ...agentContext,
        ...planBackendEventMeta(planGenerationSnapshot, planExecutionConfig),
      });
      await service.runHookScripts(projectId, 'on:fail', {
        failedStage: 'plan',
        error: result.errorMessage || '计划生成失败',
        log: result.logFile || null,
      });
      return;
    }

    const id = service.insertPlan({
      projectId,
      issueHash: issueScan.aggregateHash,
      filePath: normalizeRelative(workspace, planFile),
      hash: hashFile(planFile),
      status: 'pending',
      agentCliConfig: planAgentCliSnapshot,
      planGenerationConfig: planGenerationSnapshot,
      planExecutionConfig,
    });
    service.syncPlanTasks(id, planFile);
    service.db.run('UPDATE project_states SET last_issue_hash = ?, updated_at = ? WHERE project_id = ?', [
      issueScan.aggregateHash,
      nowIso(),
      projectId,
    ]);
    service.addEvent(projectId, 'plan.generated', `${agentLabel} 生成计划：${normalizeRelative(workspace, planFile)}`, {
      ...agentContext,
      ...planBackendEventMeta(planGenerationSnapshot, planExecutionConfig),
      planId: id,
    });
    await service.runHookScripts(projectId, 'plan:after', {
      planId: id,
      planFilePath: normalizeRelative(workspace, planFile),
    });
  }

async function generatePlanForIntake(service, helpers, projectId, workspace, intake) {
  const { timestampForPath, readSnippet, normalizeRelative, hashFile, hashText } = helpers;
    const table = intake.__type === 'feedback' ? 'feedback' : 'requirements';
    const sourceName = intake.__type === 'feedback' ? '反馈' : '需求';
    service.setPhase(projectId, 'generate-plan');
    const projectStatus = service.status(projectId);
    const planGenerationConfig = effectivePlanGenerationConfigForService(service, projectStatus, intake);
    const planExecutionConfig = effectivePlanExecutionConfigForService(service, projectStatus);
    if (isExternalCliStructuredPlanGeneration(planGenerationConfig)) {
      return generateStructuredPlanForIntake(service, helpers, projectId, workspace, intake, {
        projectStatus,
        table,
        sourceName,
        planGenerationConfig,
        planExecutionConfig,
      });
    }
    if (isBuiltinLlmStructuredPlanGeneration(planGenerationConfig)) {
      return generateBuiltinStructuredPlanForIntake(service, helpers, projectId, workspace, intake, {
        projectStatus,
        table,
        sourceName,
        planGenerationConfig,
        planExecutionConfig,
      });
    }
    if (!isExternalCliMarkdownPlanGeneration(planGenerationConfig)) {
      return recordUnsupportedIntakePlanGenerationStrategy(service, {
        projectId,
        table,
        intake,
        sourceName,
        planGenerationConfig,
        planExecutionConfig,
      });
    }
    const planAgentCliOperation = planGenerationAgentCliOperationFieldsForService(service, planGenerationConfig);
    const planAgentCliConfig = effectiveAgentCliConfig({}, planAgentCliOperation);
    // provider 判定复用 effectiveAgentCliConfig，与 P002 runCodex 的计划生成判定保持一致，避免漂移。
    // OpenCode 是完全 agentic 后端，倾向主动通读整仓“自行发挥”而忽略反馈正文与格式约束，故需在 prompt
    // 层弱化“自主阅读源码”措辞、并跳过短正文自动注入的 README/目录概览（既膨胀 prompt 易触发 spillover，
    // 又强化“读项目”倾向）。claude/codex/oh-my-pi 行为不变。
    const isOpenCodeProvider = planAgentCliConfig.provider === 'opencode';
    const phasing = analyzeIntakePlanPhasing(intake);
    if (phasing.enabled) {
      return generatePhasedPlansForIntake(service, helpers, projectId, workspace, intake, {
        table,
        sourceName,
        planGenerationConfig,
        planExecutionConfig,
        planAgentCliOperation,
        planAgentCliConfig,
        isOpenCodeProvider,
        phasing,
      });
    }
    const safeId = String(intake.id).replace(/[^0-9a-zA-Z_-]/g, '');
    const planFile = path.join(
      workspace,
      'docs',
      'plan',
      `plan_${intake.__type}_${safeId}_${timestampForPath()}.md`,
    );
    const attachmentPrompt = service.intakeAttachmentPrompt(projectId, workspace, intake, sourceName);
    // OpenCode 后端弱化“自主阅读源码/README/目录树”措辞，改为“优先依据反馈正文；仅可为推断 scope
    // 读取少量明确文件”，避免把 agentic 后端引向整仓探索。其余后端保留原有鼓励结合项目代码的措辞。
    const explorationGuidance = isOpenCodeProvider
      ? [
          '无论需求描述多么简短或模糊，都必须优先依据给定的需求/反馈正文直接产出开发计划；禁止反问用户、禁止请求补充信息、禁止输出“请告诉我…/需要更多信息”之类的话。需求不明确时，按最合理的解释推进。',
          '按最优工程方案推进，无需征求确认。仅可为推断某个任务的 scope 而读取少量明确文件；禁止通读整仓（README、目录树、源码全量浏览）后再“自行发挥”，也不要主动联网检索。',
        ]
      : [
          '无论需求描述多么简短或模糊，都必须基于项目实际代码独立分析，直接产出开发计划；禁止反问用户、禁止请求补充信息、禁止输出“请告诉我…/需要更多信息”之类的话。需求不明确时，按最合理的解释推进并自行从代码中推断影响范围。',
          '按最优工程方案推进，无需征求确认。需求简短时，先阅读相关模块源码（README、目录树、相关文件）再给出针对该项目的具体任务，而不是泛泛而谈。',
        ];
    const promptParts = [
      '你是需求整理与开发计划生成者。',
      `请根据以下${sourceName}，生成一个开发计划和验收标准。`,
      '',
      `输出文件：${planFile}`,
      '你必须使用文件写入工具把完整 plan 内容写入上面指定的输出文件路径；不要只把 plan 内容打印在回复里。只有写入该文件才算成功。',
      '',
      '格式要求：',
      '- 每个任务必须严格使用固定格式：- [ ] P001: 任务标题 <!-- scope: lib/foo.dart,test/foo_test.dart -->',
      '- scope 必填，表示该任务预计修改的文件或模块；多个 scope 用英文逗号分隔；无法判断时写 <!-- scope: unknown -->，unknown 任务不会并发执行',
      '- 每个任务要有验收要点',
      '- 不要把“运行测试/回归/验收/构建”拆成普通开发任务；每个 plan 的最后一个任务必须是“完整验收”节点，负责对整个 plan 做最终验收',
      '- 最后一个任务必须严格放在任务列表最后，标题建议“完整验收”，scope 写 validation；总体验收标准写明最终验收命令、范围和通过标准',
      '- 如果需求明确要求新增或更新测试文件，可以生成“补充测试代码”的开发任务，但任务验收要点只描述应覆盖的场景，不要求在该任务内运行测试',
      '- 必须包含总体验收标准和进度区',
      '- 只写 plan 文件，不要改业务代码',
      '',
      ...explorationGuidance,
      '',
      `${sourceName} #${intake.id} 内容：`,
      String(intake.body || '').trim() || '（正文为空）',
    ];
    // 短正文时注入项目上下文，帮助模型判断需求涉及范围。OpenCode 后端跳过该注入：既膨胀 prompt
    // 易触发 spillover，又强化“读项目”倾向而偏离反馈正文（claude/codex/oh-my-pi 行为不变）。
    if (!isOpenCodeProvider && String(intake.body || '').trim().length < 20) {
      const ctx = [];
      try {
        const readmePath = path.join(workspace, 'README.md');
        if (fs.existsSync(readmePath)) {
          const snippet = readSnippet(readmePath, 8000);
          if (snippet && snippet.trim()) {
            ctx.push('## 项目 README 摘要：', snippet);
          }
        }
      } catch (_) { /* 读取 README 失败，静默跳过 */ }
      try {
        const entries = fs.readdirSync(workspace, { withFileTypes: true });
        const lines = [];
        for (const e of entries) {
          if (lines.length >= 20) break;
          lines.push(`- ${e.name}${e.isDirectory() ? '/' : ''}`);
        }
        if (lines.length > 0) {
          ctx.push('## 项目根目录概览：', ...lines);
        }
      } catch (_) { /* 读取目录失败，静默跳过 */ }
      if (ctx.length > 0) {
        promptParts.push('', '以下是项目自动收集的上下文，供你判断需求涉及范围：', '', ...ctx);
      } else {
        // 短正文且无任何可收集的上下文时，也要显式标注"已走过收集步骤"，
        // 让模型知道 prompt 已经过 context 收集（即便没东西可附加），符合设计意图。
        promptParts.push('', '以下是项目自动收集的上下文，供你判断需求涉及范围：', '');
      }
    }
    promptParts.push(
      '',
      '必须包含 ## 任务拆解 章节标题，其下列出所有开发任务。',
    );
    if (attachmentPrompt) promptParts.push('', attachmentPrompt);
    const prompt = promptParts.join('\n');

    const result = await service.runCodex(workspace, prompt, `gen-${intake.__type}-${intake.id}`, {
      projectId,
      intakeType: intake.__type,
      intakeId: intake.id,
      ...planAgentCliOperation,
    });
    const agentContext = agentCliContextFields(result, { defaultProvider: true });
    const planAgentCliSnapshot = effectiveAgentCliConfig(planAgentCliConfig, agentContext);
    const planGenerationSnapshot = planGenerationConfigWithAgentCliSnapshot(
      service,
      planGenerationConfig,
      planAgentCliSnapshot,
    );
    const agentLabel = agentCliProviderDisplayName(agentContext.agentCliProvider);
    // 兜底：exitCode=0 但未落盘时，尝试从 stdout 提取 plan 内容
    if (result.exitCode === 0 && !fs.existsSync(planFile)) {
      if (recoverPlanFromStdout(planFile, result.output)) {
        service.addEvent(projectId, 'plan.stdout.recovered', `已从 stdout 兜底落盘：${normalizeRelative(workspace, planFile)}`, agentContext);
      }
    }
    if (result.exitCode !== 0 || !fs.existsSync(planFile)) {
      const planFilePath = normalizeRelative(workspace, planFile);
      const failedBecauseMissingPlan = result.exitCode === 0 && !fs.existsSync(planFile);
      return recordIntakePlanGenerationFailure(service, {
        projectId,
        table,
        intake,
        sourceName,
        agentLabel,
        agentContext,
        agentCliConfig: planAgentCliSnapshot,
        result,
        eventType: 'plan.generate.failed',
        message: `${agentLabel} 生成${sourceName} #${intake.id} 计划失败：${result.logFile}`,
        error: intakePlanGenerationFailureError({
          result,
          sourceName,
          intake,
          agentLabel,
          missingArtifactPath: failedBecauseMissingPlan ? planFilePath : '',
          missingArtifactLabel: '计划文件',
        }),
        meta: {
          ...planBackendEventMeta(planGenerationSnapshot, planExecutionConfig),
          planFilePath,
          planFileExists: fs.existsSync(planFile),
        },
      });
    }

    // 校验产物格式（stdout 兜底落盘与 opencode 直接写盘两条路径均经此）：必须含 `## 任务拆解`
    // 二级标题与至少一行 `- [ ] P0NN: ... <!-- scope: ... -->`。畸形 plan 不落库（不 insertPlan/syncPlanTasks），
    // 记录 plan.format.invalid 事件并按既有计划生成失败链路处理（on:fail + generate_fail_count 自增）。
    const contentValidation = validatePlanContent(fs.readFileSync(planFile, 'utf8'));
    if (!contentValidation.valid) {
      const planFilePath = normalizeRelative(workspace, planFile);
      return recordIntakePlanGenerationFailure(service, {
        projectId,
        table,
        intake,
        sourceName,
        agentLabel,
        agentContext,
        agentCliConfig: planAgentCliSnapshot,
        result,
        eventType: 'plan.format.invalid',
        message: `${agentLabel} 生成${sourceName} #${intake.id} 的计划格式不合规（${contentValidation.reason}）：${result.logFile}`,
        error: `生成${sourceName} #${intake.id} 的计划格式不合规：${contentValidation.reason}`,
        meta: {
          ...planBackendEventMeta(planGenerationSnapshot, planExecutionConfig),
          planFilePath,
          planFileExists: true,
          reason: contentValidation.reason,
        },
      });
    }

    const issueHash = `${intake.__type}-${intake.id}-${hashText(String(intake.body || '')).slice(0, 16)}`;
    const planStatus = draftPlanRequested(intake) ? 'draft' : 'pending';
    const id = service.insertPlan({
      projectId,
      issueHash,
      filePath: normalizeRelative(workspace, planFile),
      hash: hashFile(planFile),
      status: planStatus,
      agentCliConfig: planAgentCliSnapshot,
      planGenerationConfig: planGenerationSnapshot,
      planExecutionConfig,
    });
    service.syncPlanTasks(id, planFile);
    if (planStatus === 'draft') {
      service.db.run('UPDATE plans SET status = ?, updated_at = ? WHERE id = ?', ['draft', nowIso(), id]);
    }
    // 回写关联
    service.db.run(`UPDATE ${table} SET linked_plan_id = ?, updated_at = ? WHERE id = ?`, [id, nowIso(), intake.id]);
    // 生成成功，清理旧失败状态，避免卡片继续显示历史错误。
    clearIntakePlanGenerationFailure(service, table, intake.id);
    service.addEvent(projectId, 'plan.generated', `${agentLabel} 为${sourceName} #${intake.id} 生成计划：${normalizeRelative(workspace, planFile)}`, {
      ...agentContext,
      ...planBackendEventMeta(planGenerationSnapshot, planExecutionConfig),
      planId: id,
      intakeType: intake.__type,
      intakeId: intake.id,
    });
    await service.runHookScripts(projectId, 'plan:after', {
      planId: id,
      planFilePath: normalizeRelative(workspace, planFile),
      intakeType: intake.__type,
      intakeId: intake.id,
    });
    return id;
  }

async function generatePhasedPlansForIntake(service, helpers, projectId, workspace, intake, context) {
  const { timestampForPath, readSnippet, normalizeRelative, hashFile, hashText } = helpers;
  const {
    table,
    sourceName,
    planGenerationConfig,
    planExecutionConfig,
    planAgentCliOperation,
    planAgentCliConfig,
    isOpenCodeProvider,
    phasing,
  } = context;
  const safeId = String(intake.id).replace(/[^0-9a-zA-Z_-]/g, '');
  const timestamp = timestampForPath();
  const planDir = path.join(workspace, 'docs', 'plan');
  const phaseFilePrefix = `plan_requirement_${safeId}_${timestamp}`;
  const manifestFile = path.join(planDir, `${phaseFilePrefix}_manifest.json`);
  const attachmentPrompt = service.intakeAttachmentPrompt(projectId, workspace, intake, sourceName);
  const prompt = buildPhasedPlanPrompt({
    workspace,
    intake,
    sourceName,
    manifestFile,
    phaseFilePrefix,
    phasing,
    attachmentPrompt,
    readSnippet,
    isOpenCodeProvider,
  });

  const result = await service.runCodex(workspace, prompt, `gen-${intake.__type}-${intake.id}`, {
    projectId,
    intakeType: intake.__type,
    intakeId: intake.id,
    phasedPlan: true,
    ...planAgentCliOperation,
  });
  const agentContext = agentCliContextFields(result, { defaultProvider: true });
  const planAgentCliSnapshot = effectiveAgentCliConfig(planAgentCliConfig, agentContext);
  const planGenerationSnapshot = planGenerationConfigWithAgentCliSnapshot(
    service,
    planGenerationConfig,
    planAgentCliSnapshot,
  );
  const agentLabel = agentCliProviderDisplayName(agentContext.agentCliProvider);
  if (result.exitCode !== 0 || !fs.existsSync(manifestFile)) {
    return recordIntakePlanGenerationFailure(service, {
      projectId,
      table,
      intake,
      sourceName,
      agentLabel,
      agentContext,
      agentCliConfig: planAgentCliSnapshot,
      result,
      eventType: 'plan.generate.failed',
      message: `${agentLabel} 生成${sourceName} #${intake.id} 阶段计划失败：${result.logFile}`,
      error: intakePlanGenerationFailureError({
        result,
        sourceName,
        intake,
        agentLabel,
        missingArtifactPath: result.exitCode === 0 && !fs.existsSync(manifestFile)
          ? normalizeRelative(workspace, manifestFile)
          : '',
        missingArtifactLabel: 'manifest 文件',
      }),
      meta: {
        ...planBackendEventMeta(planGenerationSnapshot, planExecutionConfig),
        manifestFilePath: normalizeRelative(workspace, manifestFile),
        manifestFileExists: fs.existsSync(manifestFile),
        phasedPlan: true,
      },
    });
  }

  let validated;
  try {
    validated = validatePhaseManifestFile({
      workspace,
      manifestFile,
      intake,
      phaseFilePrefix,
      helpers,
    });
  } catch (error) {
    return recordIntakePlanGenerationFailure(service, {
      projectId,
      table,
      intake,
      sourceName,
      agentLabel,
      agentContext,
      agentCliConfig: planAgentCliSnapshot,
      result,
      eventType: 'plan.format.invalid',
      message: `${agentLabel} 生成${sourceName} #${intake.id} 的阶段计划格式不合规：${error.message}`,
      error: `生成${sourceName} #${intake.id} 的阶段计划格式不合规：${error.message}`,
      meta: {
        ...planBackendEventMeta(planGenerationSnapshot, planExecutionConfig),
        manifestFilePath: normalizeRelative(workspace, manifestFile),
        phasedPlan: true,
        reason: error.message,
      },
    });
  }

  const issueHashBase = `${intake.__type}-${intake.id}-${hashText(String(intake.body || '')).slice(0, 16)}`;
  const sortOrderStart = service.nextPlanSortOrder(projectId);
  const insertedPlans = [];
  validated.phases.forEach((phase, index) => {
    const phaseKey = `phase${String(phase.phaseIndex).padStart(2, '0')}`;
    const planId = service.insertPlan({
      projectId,
      issueHash: `${issueHashBase}-${phaseKey}`,
      filePath: phase.relativePath,
      hash: hashFile(phase.filePath),
      status: 'pending',
      sortOrder: sortOrderStart + index,
      agentCliConfig: planAgentCliSnapshot,
      planGenerationConfig: planGenerationSnapshot,
      planExecutionConfig,
    });
    insertedPlans.push({ ...phase, planId });
  });
  for (const phase of insertedPlans) {
    service.syncPlanTasks(phase.planId, phase.filePath);
  }
  intakePlanLinks.writeIntakePlanLinks(
    service,
    projectId,
    'requirement',
    intake.id,
    insertedPlans.map((phase) => ({
      planId: phase.planId,
      phaseIndex: phase.phaseIndex,
      phaseTitle: phase.phaseTitle,
    })),
    { clearExisting: true },
  );
  clearIntakePlanGenerationFailure(service, table, intake.id);

  const planIds = insertedPlans.map((phase) => phase.planId);
  service.addEvent(projectId, 'plan.generated', `${agentLabel} 为${sourceName} #${intake.id} 生成 ${planIds.length} 个阶段计划`, {
    ...agentContext,
    ...planBackendEventMeta(planGenerationSnapshot, planExecutionConfig),
    planId: planIds[0] || null,
    planIds,
    generatedPlanIds: planIds,
    intakeType: intake.__type,
    intakeId: intake.id,
    phasedPlan: true,
    phases: insertedPlans.map((phase) => ({
      phaseIndex: phase.phaseIndex,
      phaseTitle: phase.phaseTitle,
      planId: phase.planId,
      planFilePath: phase.relativePath,
    })),
    manifestFilePath: normalizeRelative(workspace, manifestFile),
  });
  for (const phase of insertedPlans) {
    await service.runHookScripts(projectId, 'plan:after', {
      planId: phase.planId,
      planFilePath: phase.relativePath,
      intakeType: intake.__type,
      intakeId: intake.id,
      phasedPlan: true,
      phaseIndex: phase.phaseIndex,
      phaseTitle: phase.phaseTitle,
      generatedPlanIds: planIds,
    });
  }
  return planIds[0] || null;
}

async function generateStructuredPlan(service, helpers, projectId, workspace, issueScan, context) {
  const { timestampForPath, readSnippet, normalizeRelative, hashFile } = helpers;
  const {
    projectStatus,
    planGenerationConfig,
    planExecutionConfig,
  } = context;
  const planAgentCliOperation = planGenerationAgentCliOperationFieldsForService(service, planGenerationConfig);
  const planAgentCliConfig = effectiveAgentCliConfig({}, planAgentCliOperation);
  const timestamp = timestampForPath();
  const suffix = issueScan.aggregateHash.slice(0, 8);
  const planSpecFile = path.join(workspace, 'docs', 'plan', `plan_spec_${timestamp}_${suffix}.json`);
  const planFile = path.join(workspace, 'docs', 'plan', `plan_${timestamp}_${suffix}.md`);
  const issueBundle = issueScan.files
    .map((file) => {
      const full = path.join(workspace, file.path);
      return ['---', `path: ${file.path}`, `hash: ${file.hash}`, 'content:', readSnippet(full, 20000)].join('\n');
    })
    .join('\n');
  const prompt = buildStructuredIssuePlanPrompt({
    planSpecFile,
    planFile,
    issueBundle,
    projectStatus,
  });

  const result = await service.runCodex(workspace, prompt, 'generate-plan', {
    projectId,
    structuredPlan: true,
    ...planAgentCliOperation,
  });
  const agentContext = agentCliContextFields(result, { defaultProvider: true });
  const planAgentCliSnapshot = effectiveAgentCliConfig(planAgentCliConfig, agentContext);
  const planGenerationSnapshot = planGenerationConfigWithAgentCliSnapshot(
    service,
    planGenerationConfig,
    planAgentCliSnapshot,
  );
  const agentLabel = agentCliProviderDisplayName(agentContext.agentCliProvider);
  const backendMeta = planBackendEventMeta(planGenerationSnapshot, planExecutionConfig);

  if (result.exitCode === 0 && !fs.existsSync(planSpecFile)) {
    if (recoverPlanSpecFromStdout(planSpecFile, result.output)) {
      service.addEvent(projectId, 'plan.spec.stdout.recovered', `已从 stdout 兜底落盘 PlanSpec：${normalizeRelative(workspace, planSpecFile)}`, {
        ...agentContext,
        ...backendMeta,
        planSpecFilePath: normalizeRelative(workspace, planSpecFile),
      });
    }
  }
  if (result.exitCode !== 0 || !fs.existsSync(planSpecFile)) {
    const missingArtifactPath = result.exitCode === 0 && !fs.existsSync(planSpecFile)
      ? normalizeRelative(workspace, planSpecFile)
      : '';
    return recordIssuePlanGenerationFailure(service, {
      projectId,
      agentLabel,
      agentContext,
      result,
      eventType: 'plan.generate.failed',
      message: `${agentLabel} 结构化计划生成失败：${result.logFile}`,
      error: planGenerationFailureError({
        result,
        agentLabel,
        missingArtifactPath,
        missingArtifactLabel: 'PlanSpec JSON 文件',
      }),
      meta: {
        ...backendMeta,
        planSpecFilePath: normalizeRelative(workspace, planSpecFile),
        planSpecFileExists: fs.existsSync(planSpecFile),
      },
    });
  }

  let rendered;
  try {
    rendered = renderPlanSpecFileToMarkdown({
      workspace,
      planSpecFile,
      planFile,
      helpers,
    });
  } catch (error) {
    return recordIssuePlanGenerationFailure(service, {
      projectId,
      agentLabel,
      agentContext,
      result,
      eventType: 'plan.format.invalid',
      message: `${agentLabel} 生成的 PlanSpec 不合规（${structuredPlanErrorMessage(error)}）：${result.logFile}`,
      error: `生成的 PlanSpec 不合规：${structuredPlanErrorMessage(error)}`,
      meta: {
        ...backendMeta,
        planSpecFilePath: normalizeRelative(workspace, planSpecFile),
        planFilePath: normalizeRelative(workspace, planFile),
        reason: structuredPlanErrorMessage(error),
      },
    });
  }

  const id = service.insertPlan({
    projectId,
    issueHash: issueScan.aggregateHash,
    filePath: rendered.planFileRelativePath,
    hash: hashFile(rendered.planFilePath),
    status: 'pending',
    agentCliConfig: planAgentCliSnapshot,
    planGenerationConfig: planGenerationSnapshot,
    planExecutionConfig,
  });
  service.syncPlanTasks(id, rendered.planFilePath);
  service.db.run('UPDATE project_states SET last_issue_hash = ?, updated_at = ? WHERE project_id = ?', [
    issueScan.aggregateHash,
    nowIso(),
    projectId,
  ]);
  service.addEvent(projectId, 'plan.generated', `${agentLabel} 生成结构化计划：${rendered.planFileRelativePath}`, {
    ...agentContext,
    ...backendMeta,
    planId: id,
    planSpecFilePath: rendered.planSpecRelativePath,
  });
  await service.runHookScripts(projectId, 'plan:after', {
    planId: id,
    planFilePath: rendered.planFileRelativePath,
  });
  return id;
}

async function generateStructuredPlanForIntake(service, helpers, projectId, workspace, intake, context) {
  const { timestampForPath, readSnippet, normalizeRelative, hashFile, hashText } = helpers;
  const {
    projectStatus,
    table,
    sourceName,
    planGenerationConfig,
    planExecutionConfig,
  } = context;
  const planAgentCliOperation = planGenerationAgentCliOperationFieldsForService(service, planGenerationConfig);
  const planAgentCliConfig = effectiveAgentCliConfig({}, planAgentCliOperation);
  const isOpenCodeProvider = planAgentCliConfig.provider === 'opencode';
  const safeId = String(intake.id).replace(/[^0-9a-zA-Z_-]/g, '');
  const timestamp = timestampForPath();
  const planSpecFile = path.join(workspace, 'docs', 'plan', `plan_spec_${intake.__type}_${safeId}_${timestamp}.json`);
  const planFile = path.join(workspace, 'docs', 'plan', `plan_${intake.__type}_${safeId}_${timestamp}.md`);
  const attachmentPrompt = service.intakeAttachmentPrompt(projectId, workspace, intake, sourceName);
  const prompt = buildStructuredIntakePlanPrompt({
    workspace,
    intake,
    sourceName,
    planSpecFile,
    planFile,
    projectStatus,
    attachmentPrompt,
    readSnippet,
    isOpenCodeProvider,
  });

  const result = await service.runCodex(workspace, prompt, `gen-${intake.__type}-${intake.id}`, {
    projectId,
    intakeType: intake.__type,
    intakeId: intake.id,
    structuredPlan: true,
    ...planAgentCliOperation,
  });
  const agentContext = agentCliContextFields(result, { defaultProvider: true });
  const planAgentCliSnapshot = effectiveAgentCliConfig(planAgentCliConfig, agentContext);
  const planGenerationSnapshot = planGenerationConfigWithAgentCliSnapshot(
    service,
    planGenerationConfig,
    planAgentCliSnapshot,
  );
  const agentLabel = agentCliProviderDisplayName(agentContext.agentCliProvider);
  const backendMeta = planBackendEventMeta(planGenerationSnapshot, planExecutionConfig);

  if (result.exitCode === 0 && !fs.existsSync(planSpecFile)) {
    if (recoverPlanSpecFromStdout(planSpecFile, result.output)) {
      service.addEvent(projectId, 'plan.spec.stdout.recovered', `已从 stdout 兜底落盘 PlanSpec：${normalizeRelative(workspace, planSpecFile)}`, {
        ...agentContext,
        ...backendMeta,
        planSpecFilePath: normalizeRelative(workspace, planSpecFile),
        intakeType: intake.__type,
        intakeId: intake.id,
      });
    }
  }
  if (result.exitCode !== 0 || !fs.existsSync(planSpecFile)) {
    const missingArtifactPath = result.exitCode === 0 && !fs.existsSync(planSpecFile)
      ? normalizeRelative(workspace, planSpecFile)
      : '';
    return recordIntakePlanGenerationFailure(service, {
      projectId,
      table,
      intake,
      sourceName,
      agentLabel,
      agentContext,
      agentCliConfig: planAgentCliSnapshot,
      result,
      eventType: 'plan.generate.failed',
      message: `${agentLabel} 生成${sourceName} #${intake.id} 结构化计划失败：${result.logFile}`,
      error: intakePlanGenerationFailureError({
        result,
        sourceName,
        intake,
        agentLabel,
        missingArtifactPath,
        missingArtifactLabel: 'PlanSpec JSON 文件',
      }),
      meta: {
        ...backendMeta,
        planSpecFilePath: normalizeRelative(workspace, planSpecFile),
        planSpecFileExists: fs.existsSync(planSpecFile),
      },
    });
  }

  let rendered;
  try {
    rendered = renderPlanSpecFileToMarkdown({
      workspace,
      planSpecFile,
      planFile,
      helpers,
    });
  } catch (error) {
    return recordIntakePlanGenerationFailure(service, {
      projectId,
      table,
      intake,
      sourceName,
      agentLabel,
      agentContext,
      agentCliConfig: planAgentCliSnapshot,
      result,
      eventType: 'plan.format.invalid',
      message: `${agentLabel} 生成${sourceName} #${intake.id} 的 PlanSpec 不合规（${structuredPlanErrorMessage(error)}）：${result.logFile}`,
      error: `生成${sourceName} #${intake.id} 的 PlanSpec 不合规：${structuredPlanErrorMessage(error)}`,
      meta: {
        ...backendMeta,
        planSpecFilePath: normalizeRelative(workspace, planSpecFile),
        planFilePath: normalizeRelative(workspace, planFile),
        reason: structuredPlanErrorMessage(error),
      },
    });
  }

  const issueHash = `${intake.__type}-${intake.id}-${hashText(String(intake.body || '')).slice(0, 16)}`;
  const planStatus = draftPlanRequested(intake) ? 'draft' : 'pending';
  const id = service.insertPlan({
    projectId,
    issueHash,
    filePath: rendered.planFileRelativePath,
    hash: hashFile(rendered.planFilePath),
    status: planStatus,
    agentCliConfig: planAgentCliSnapshot,
    planGenerationConfig: planGenerationSnapshot,
    planExecutionConfig,
  });
  service.syncPlanTasks(id, rendered.planFilePath);
  if (planStatus === 'draft') {
    service.db.run('UPDATE plans SET status = ?, updated_at = ? WHERE id = ?', ['draft', nowIso(), id]);
  }
  service.db.run(`UPDATE ${table} SET linked_plan_id = ?, updated_at = ? WHERE id = ?`, [id, nowIso(), intake.id]);
  clearIntakePlanGenerationFailure(service, table, intake.id);
  service.addEvent(projectId, 'plan.generated', `${agentLabel} 为${sourceName} #${intake.id} 生成结构化计划：${rendered.planFileRelativePath}`, {
    ...agentContext,
    ...backendMeta,
    planId: id,
    intakeType: intake.__type,
    intakeId: intake.id,
    planSpecFilePath: rendered.planSpecRelativePath,
  });
  await service.runHookScripts(projectId, 'plan:after', {
    planId: id,
    planFilePath: rendered.planFileRelativePath,
    intakeType: intake.__type,
    intakeId: intake.id,
  });
  return id;
}

async function generateBuiltinStructuredPlan(service, helpers, projectId, workspace, issueScan, context) {
  const { timestampForPath, readSnippet, normalizeRelative, hashFile } = helpers;
  const {
    projectStatus,
    planGenerationConfig,
    planExecutionConfig,
  } = context;
  const timestamp = timestampForPath();
  const suffix = issueScan.aggregateHash.slice(0, 8);
  const planSpecFile = path.join(workspace, 'docs', 'plan', `plan_spec_${timestamp}_${suffix}.json`);
  const planFile = path.join(workspace, 'docs', 'plan', `plan_${timestamp}_${suffix}.md`);
  const issueBundle = issueScan.files
    .map((file) => {
      const full = path.join(workspace, file.path);
      return ['---', `path: ${file.path}`, `hash: ${file.hash}`, 'content:', readSnippet(full, 20000)].join('\n');
    })
    .join('\n');
  const prompt = buildBuiltinStructuredIssuePlanPrompt({
    issueBundle,
    projectStatus,
  });

  let builtinResult;
  try {
    builtinResult = await runBuiltinPlanSpecGenerationForService(service, {
      planGenerationConfig,
      prompt,
    });
  } catch (error) {
    const failureContext = builtinPlanGenerationContext(
      service,
      planGenerationConfig,
      planExecutionConfig,
      error?.aiConfig,
    );
    const result = builtinFailureResult(error);
    return recordIssuePlanGenerationFailure(service, {
      projectId,
      agentLabel: failureContext.agentLabel,
      agentContext: failureContext.agentContext,
      result,
      eventType: builtinFailureEventType(error),
      message: `${failureContext.agentLabel} 内置结构化计划生成失败：${result.errorMessage}`,
      error: result.errorMessage,
      meta: {
        ...failureContext.backendMeta,
        planSpecFilePath: normalizeRelative(workspace, planSpecFile),
        planSpecFileExists: fs.existsSync(planSpecFile),
      },
    });
  }

  const successContext = builtinPlanGenerationContext(
    service,
    planGenerationConfig,
    planExecutionConfig,
    builtinResult.aiConfig,
  );
  const result = builtinSuccessResult(builtinResult);
  try {
    writeBuiltinPlanSpecFile({
      workspace,
      planSpecFile,
      planSpec: builtinResult.planSpec,
      helpers,
    });
  } catch (error) {
    return recordIssuePlanGenerationFailure(service, {
      projectId,
      agentLabel: successContext.agentLabel,
      agentContext: successContext.agentContext,
      result: {
        ...result,
        errorMessage: `写入 PlanSpec 失败：${error?.message || String(error)}`,
      },
      eventType: 'plan.generate.failed',
      message: `${successContext.agentLabel} 写入内置 PlanSpec 失败：${error?.message || String(error)}`,
      error: `写入 PlanSpec 失败：${error?.message || String(error)}`,
      meta: {
        ...successContext.backendMeta,
        planSpecFilePath: normalizeRelative(workspace, planSpecFile),
      },
    });
  }

  let rendered;
  try {
    rendered = renderPlanSpecFileToMarkdown({
      workspace,
      planSpecFile,
      planFile,
      helpers,
    });
  } catch (error) {
    return recordIssuePlanGenerationFailure(service, {
      projectId,
      agentLabel: successContext.agentLabel,
      agentContext: successContext.agentContext,
      result,
      eventType: 'plan.format.invalid',
      message: `${successContext.agentLabel} 生成的 PlanSpec 不合规（${structuredPlanErrorMessage(error)}）`,
      error: `生成的 PlanSpec 不合规：${structuredPlanErrorMessage(error)}`,
      meta: {
        ...successContext.backendMeta,
        planSpecFilePath: normalizeRelative(workspace, planSpecFile),
        planFilePath: normalizeRelative(workspace, planFile),
        reason: structuredPlanErrorMessage(error),
      },
    });
  }

  const id = service.insertPlan({
    projectId,
    issueHash: issueScan.aggregateHash,
    filePath: rendered.planFileRelativePath,
    hash: hashFile(rendered.planFilePath),
    status: 'pending',
    agentCliConfig: null,
    planGenerationConfig: successContext.planGenerationSnapshot,
    planExecutionConfig,
  });
  service.syncPlanTasks(id, rendered.planFilePath);
  service.db.run('UPDATE project_states SET last_issue_hash = ?, updated_at = ? WHERE project_id = ?', [
    issueScan.aggregateHash,
    nowIso(),
    projectId,
  ]);
  service.addEvent(projectId, 'plan.generated', `${successContext.agentLabel} 生成内置结构化计划：${rendered.planFileRelativePath}`, {
    ...successContext.agentContext,
    ...successContext.backendMeta,
    planId: id,
    planSpecFilePath: rendered.planSpecRelativePath,
  });
  await service.runHookScripts(projectId, 'plan:after', {
    planId: id,
    planFilePath: rendered.planFileRelativePath,
  });
  return id;
}

async function generateBuiltinStructuredPlanForIntake(service, helpers, projectId, workspace, intake, context) {
  const { timestampForPath, readSnippet, normalizeRelative, hashFile, hashText } = helpers;
  const {
    projectStatus,
    table,
    sourceName,
    planGenerationConfig,
    planExecutionConfig,
  } = context;
  const safeId = String(intake.id).replace(/[^0-9a-zA-Z_-]/g, '');
  const timestamp = timestampForPath();
  const planSpecFile = path.join(workspace, 'docs', 'plan', `plan_spec_${intake.__type}_${safeId}_${timestamp}.json`);
  const planFile = path.join(workspace, 'docs', 'plan', `plan_${intake.__type}_${safeId}_${timestamp}.md`);
  const attachmentPrompt = service.intakeAttachmentPrompt(projectId, workspace, intake, sourceName);
  const prompt = buildBuiltinStructuredIntakePlanPrompt({
    workspace,
    intake,
    sourceName,
    projectStatus,
    attachmentPrompt,
    readSnippet,
  });

  let builtinResult;
  try {
    builtinResult = await runBuiltinPlanSpecGenerationForService(service, {
      planGenerationConfig,
      prompt,
    });
  } catch (error) {
    const failureContext = builtinPlanGenerationContext(
      service,
      planGenerationConfig,
      planExecutionConfig,
      error?.aiConfig,
    );
    const result = builtinFailureResult(error);
    return recordIntakePlanGenerationFailure(service, {
      projectId,
      table,
      intake,
      sourceName,
      agentLabel: failureContext.agentLabel,
      agentContext: failureContext.agentContext,
      agentCliConfig: null,
      result,
      eventType: builtinFailureEventType(error),
      message: `${failureContext.agentLabel} 生成${sourceName} #${intake.id} 内置结构化计划失败：${result.errorMessage}`,
      error: result.errorMessage,
      meta: {
        ...failureContext.backendMeta,
        planSpecFilePath: normalizeRelative(workspace, planSpecFile),
        planSpecFileExists: fs.existsSync(planSpecFile),
      },
    });
  }

  const successContext = builtinPlanGenerationContext(
    service,
    planGenerationConfig,
    planExecutionConfig,
    builtinResult.aiConfig,
  );
  const result = builtinSuccessResult(builtinResult);
  try {
    writeBuiltinPlanSpecFile({
      workspace,
      planSpecFile,
      planSpec: builtinResult.planSpec,
      helpers,
    });
  } catch (error) {
    return recordIntakePlanGenerationFailure(service, {
      projectId,
      table,
      intake,
      sourceName,
      agentLabel: successContext.agentLabel,
      agentContext: successContext.agentContext,
      agentCliConfig: null,
      result: {
        ...result,
        errorMessage: `写入 PlanSpec 失败：${error?.message || String(error)}`,
      },
      eventType: 'plan.generate.failed',
      message: `${successContext.agentLabel} 写入${sourceName} #${intake.id} 内置 PlanSpec 失败：${error?.message || String(error)}`,
      error: `写入 PlanSpec 失败：${error?.message || String(error)}`,
      meta: {
        ...successContext.backendMeta,
        planSpecFilePath: normalizeRelative(workspace, planSpecFile),
      },
    });
  }

  let rendered;
  try {
    rendered = renderPlanSpecFileToMarkdown({
      workspace,
      planSpecFile,
      planFile,
      helpers,
    });
  } catch (error) {
    return recordIntakePlanGenerationFailure(service, {
      projectId,
      table,
      intake,
      sourceName,
      agentLabel: successContext.agentLabel,
      agentContext: successContext.agentContext,
      agentCliConfig: null,
      result,
      eventType: 'plan.format.invalid',
      message: `${successContext.agentLabel} 生成${sourceName} #${intake.id} 的 PlanSpec 不合规（${structuredPlanErrorMessage(error)}）`,
      error: `生成${sourceName} #${intake.id} 的 PlanSpec 不合规：${structuredPlanErrorMessage(error)}`,
      meta: {
        ...successContext.backendMeta,
        planSpecFilePath: normalizeRelative(workspace, planSpecFile),
        planFilePath: normalizeRelative(workspace, planFile),
        reason: structuredPlanErrorMessage(error),
      },
    });
  }

  const issueHash = `${intake.__type}-${intake.id}-${hashText(String(intake.body || '')).slice(0, 16)}`;
  const planStatus = draftPlanRequested(intake) ? 'draft' : 'pending';
  const id = service.insertPlan({
    projectId,
    issueHash,
    filePath: rendered.planFileRelativePath,
    hash: hashFile(rendered.planFilePath),
    status: planStatus,
    agentCliConfig: null,
    planGenerationConfig: successContext.planGenerationSnapshot,
    planExecutionConfig,
  });
  service.syncPlanTasks(id, rendered.planFilePath);
  if (planStatus === 'draft') {
    service.db.run('UPDATE plans SET status = ?, updated_at = ? WHERE id = ?', ['draft', nowIso(), id]);
  }
  service.db.run(`UPDATE ${table} SET linked_plan_id = ?, updated_at = ? WHERE id = ?`, [id, nowIso(), intake.id]);
  clearIntakePlanGenerationFailure(service, table, intake.id);
  service.addEvent(projectId, 'plan.generated', `${successContext.agentLabel} 为${sourceName} #${intake.id} 生成内置结构化计划：${rendered.planFileRelativePath}`, {
    ...successContext.agentContext,
    ...successContext.backendMeta,
    planId: id,
    intakeType: intake.__type,
    intakeId: intake.id,
    planSpecFilePath: rendered.planSpecRelativePath,
  });
  await service.runHookScripts(projectId, 'plan:after', {
    planId: id,
    planFilePath: rendered.planFileRelativePath,
    intakeType: intake.__type,
    intakeId: intake.id,
  });
  return id;
}

function effectivePlanGenerationConfigForService(service, defaults = {}, intake = {}) {
  if (typeof service.planGenerationConfig === 'function') {
    return service.planGenerationConfig(defaults, intake);
  }
  return planBackendConfig.effectivePlanGenerationConfig(defaults, intake);
}

function effectivePlanExecutionConfigForService(service, defaults = {}, plan = {}) {
  if (typeof service.planExecutionConfig === 'function') {
    return service.planExecutionConfig(defaults, plan);
  }
  return planBackendConfig.effectivePlanExecutionConfig(defaults, plan);
}

function planGenerationAgentCliOperationFieldsForService(service, config = {}) {
  if (typeof service.planGenerationAgentCliOperationFields === 'function') {
    return service.planGenerationAgentCliOperationFields(config);
  }
  return planBackendConfig.planGenerationAgentCliOperationFields(config);
}

function isExternalCliMarkdownPlanGeneration(config = {}) {
  return String(config.strategy || config.planGenerationStrategy || '') === PLAN_GENERATION_STRATEGY_EXTERNAL_CLI_MARKDOWN;
}

function isExternalCliStructuredPlanGeneration(config = {}) {
  return String(config.strategy || config.planGenerationStrategy || '') === PLAN_GENERATION_STRATEGY_EXTERNAL_CLI_STRUCTURED;
}

function isBuiltinLlmStructuredPlanGeneration(config = {}) {
  return String(config.strategy || config.planGenerationStrategy || '') === PLAN_GENERATION_STRATEGY_BUILTIN_LLM_STRUCTURED;
}

async function recordUnsupportedPlanGenerationStrategy(service, input) {
  const { projectId, planGenerationConfig, planExecutionConfig } = input;
  const error = unsupportedPlanGenerationStrategyError(planGenerationConfig);
  service.addEvent(projectId, 'plan.generate.failed', error, {
    ...planBackendEventMeta(planGenerationConfig, planExecutionConfig),
    error,
    unsupportedPlanGenerationStrategy: planGenerationConfig?.strategy || planGenerationConfig?.planGenerationStrategy || null,
  });
  await service.runHookScripts(projectId, 'on:fail', {
    failedStage: 'plan',
    error,
    log: null,
  });
  return null;
}

async function recordUnsupportedIntakePlanGenerationStrategy(service, input) {
  const {
    projectId,
    table,
    intake,
    sourceName,
    planGenerationConfig,
    planExecutionConfig,
  } = input;
  const error = unsupportedPlanGenerationStrategyError(planGenerationConfig);
  const agentCliConfig = safeExternalPlanGenerationAgentCliConfig(service, planGenerationConfig);
  const agentContext = agentCliConfig ? agentCliContextFields(agentCliConfig, { defaultProvider: true }) : {};
  const agentLabel = planGenerationStrategyLabel(planGenerationConfig);
  return recordIntakePlanGenerationFailure(service, {
    projectId,
    table,
    intake,
    sourceName,
    agentLabel,
    agentContext,
    agentCliConfig,
    result: {
      exitCode: null,
      errorMessage: error,
      logFile: null,
    },
    eventType: 'plan.generate.failed',
    message: `${sourceName} #${intake.id} 计划生成失败：${error}`,
    error,
    meta: {
      ...planBackendEventMeta(planGenerationConfig, planExecutionConfig),
      unsupportedPlanGenerationStrategy: planGenerationConfig?.strategy || planGenerationConfig?.planGenerationStrategy || null,
    },
  });
}

function safeExternalPlanGenerationAgentCliConfig(service, planGenerationConfig = {}) {
  try {
    const operationFields = planGenerationAgentCliOperationFieldsForService(service, planGenerationConfig);
    return effectiveAgentCliConfig({}, operationFields);
  } catch (_) {
    return null;
  }
}

function unsupportedPlanGenerationStrategyError(planGenerationConfig = {}) {
  const strategy = planGenerationConfig.strategy || planGenerationConfig.planGenerationStrategy || 'unknown';
  return `计划生成策略 ${strategy} 已完成路由接入，但当前版本尚未实现该结构化生成路径`;
}

function planGenerationStrategyLabel(planGenerationConfig = {}) {
  const strategy = planGenerationConfig.strategy || planGenerationConfig.planGenerationStrategy || 'unknown';
  const provider = planGenerationConfig.provider || planGenerationConfig.planGenerationProvider || '';
  if (provider) return `${provider} ${strategy}`;
  return strategy;
}

function planGenerationConfigWithAgentCliSnapshot(service, planGenerationConfig = {}, agentCliConfig = {}) {
  const provider = agentCliConfig.provider || planGenerationConfig.provider || planGenerationConfig.planGenerationProvider;
  return effectivePlanGenerationConfigForService(service, {}, {
    planGenerationStrategy: planGenerationConfig.strategy || planGenerationConfig.planGenerationStrategy,
    planGenerationProvider: provider,
    planGenerationCommand: agentCliConfig.command || planGenerationConfig.command || planGenerationConfig.planGenerationCommand || '',
    planGenerationModel: planGenerationConfig.model || planGenerationConfig.planGenerationModel || '',
    planGenerationCodexReasoningEffort: provider === DEFAULT_AGENT_CLI_PROVIDER
      ? (agentCliConfig.codexReasoningEffort
        || planGenerationConfig.codexReasoningEffort
        || planGenerationConfig.planGenerationCodexReasoningEffort)
      : null,
  });
}

function planGenerationConfigWithBuiltinAiSnapshot(service, planGenerationConfig = {}, aiConfig = {}) {
  return effectivePlanGenerationConfigForService(service, {}, {
    planGenerationStrategy:
      planGenerationConfig.strategy ||
      planGenerationConfig.planGenerationStrategy ||
      PLAN_GENERATION_STRATEGY_BUILTIN_LLM_STRUCTURED,
    planGenerationProvider:
      aiConfig.provider ||
      planGenerationConfig.provider ||
      planGenerationConfig.planGenerationProvider,
    planGenerationCommand: '',
    planGenerationModel:
      aiConfig.model ||
      planGenerationConfig.model ||
      planGenerationConfig.planGenerationModel ||
      '',
    planGenerationCodexReasoningEffort: null,
  });
}

function builtinPlanGenerationContext(service, planGenerationConfig = {}, planExecutionConfig = {}, aiConfig = {}) {
  const planGenerationSnapshot = planGenerationConfigWithBuiltinAiSnapshot(service, planGenerationConfig, aiConfig);
  const agentContext = builtinPlanGenerationEventContext(aiConfig);
  return {
    agentLabel: builtinPlanGenerationLabel(aiConfig),
    agentContext,
    planGenerationSnapshot,
    backendMeta: {
      ...planBackendEventMeta(planGenerationSnapshot, planExecutionConfig),
      ...agentContext,
    },
  };
}

function builtinPlanGenerationEventContext(aiConfig = {}) {
  return {
    builtinLlmProvider: aiConfig.provider || null,
    builtinLlmModel: aiConfig.model || '',
    builtinLlmBaseUrl: aiConfig.baseUrl || '',
    builtinLlmHasApiKey: Boolean(aiConfig.hasApiKey),
    aiConfigId: aiConfig.id ?? null,
    aiConfigName: aiConfig.name ?? null,
  };
}

function builtinPlanGenerationLabel(aiConfig = {}) {
  const provider = aiConfig.provider || 'unknown';
  const model = aiConfig.model ? `/${aiConfig.model}` : '';
  return `内置 LLM(${provider}${model})`;
}

function planBackendEventMeta(planGenerationConfig = {}, planExecutionConfig = {}) {
  const generation = planBackendSummary('planGeneration', planGenerationConfig);
  const execution = planBackendSummary('planExecution', planExecutionConfig);
  return {
    planGenerationConfig: generation,
    planExecutionConfig: execution,
    planGenerationStrategy: generation.strategy,
    planGenerationProvider: generation.provider,
    planGenerationCommand: generation.command,
    planGenerationModel: generation.model,
    planGenerationCodexReasoningEffort: generation.codexReasoningEffort,
    planExecutionStrategy: execution.strategy,
    planExecutionProvider: execution.provider,
    planExecutionCommand: execution.command,
    planExecutionModel: execution.model,
    planExecutionCodexReasoningEffort: execution.codexReasoningEffort,
  };
}

function planBackendSummary(prefix, config = {}) {
  return {
    strategy: config.strategy ?? config[`${prefix}Strategy`] ?? null,
    provider: config.provider ?? config[`${prefix}Provider`] ?? null,
    command: config.command ?? config[`${prefix}Command`] ?? '',
    model: config.model ?? config[`${prefix}Model`] ?? '',
    codexReasoningEffort: config.codexReasoningEffort ?? config[`${prefix}CodexReasoningEffort`] ?? null,
  };
}

function buildStructuredIssuePlanPrompt(input) {
  const {
    planSpecFile,
    planFile,
    issueBundle,
    projectStatus,
  } = input;
  return [
    '你是需求整理与开发计划生成者。',
    '请根据 docs/issues 收集到的反馈和需求，生成结构化 PlanSpec JSON。',
    '',
    ...structuredPlanSpecPromptContract({ planSpecFile, planFile, projectStatus }),
    '',
    '需求快照：',
    issueBundle,
  ].join('\n');
}

function buildStructuredIntakePlanPrompt(input) {
  const {
    workspace,
    intake,
    sourceName,
    planSpecFile,
    planFile,
    projectStatus,
    attachmentPrompt,
    readSnippet,
    isOpenCodeProvider,
  } = input;
  const explorationGuidance = isOpenCodeProvider
    ? [
        '必须优先依据给定需求/反馈正文生成 PlanSpec；仅可为推断 scope 读取少量明确文件，禁止通读整仓后自行发挥，也不要主动联网检索。',
      ]
    : [
        '必须基于需求/反馈正文和项目实际代码生成 PlanSpec；需求不明确时自行从代码推断影响范围，不要反问或请求补充信息。',
      ];
  const promptParts = [
    '你是需求整理与开发计划生成者。',
    `请根据以下${sourceName}，生成结构化 PlanSpec JSON。`,
    '',
    ...structuredPlanSpecPromptContract({ planSpecFile, planFile, projectStatus }),
    '',
    ...explorationGuidance,
    '',
    `${sourceName} #${intake.id} 内容：`,
    String(intake.body || '').trim() || '（正文为空）',
  ];
  if (!isOpenCodeProvider && typeof readSnippet === 'function' && String(intake.body || '').trim().length < 20) {
    appendProjectContext(promptParts, workspace, readSnippet);
  }
  if (attachmentPrompt) promptParts.push('', attachmentPrompt);
  return promptParts.join('\n');
}

function buildBuiltinStructuredIssuePlanPrompt(input) {
  const {
    issueBundle,
    projectStatus,
  } = input;
  return [
    '你是需求整理与开发计划生成者。',
    '请根据 docs/issues 收集到的反馈和需求，生成结构化 PlanSpec。',
    '',
    ...builtinPlanSpecPromptContract({ projectStatus }),
    '',
    '需求快照：',
    issueBundle,
  ].join('\n');
}

function buildBuiltinStructuredIntakePlanPrompt(input) {
  const {
    workspace,
    intake,
    sourceName,
    projectStatus,
    attachmentPrompt,
    readSnippet,
  } = input;
  const promptParts = [
    '你是需求整理与开发计划生成者。',
    `请根据以下${sourceName}，生成结构化 PlanSpec。`,
    '',
    ...builtinPlanSpecPromptContract({ projectStatus }),
    '',
    '只能依据下方需求/反馈正文、附件说明和自动收集的项目上下文推断任务与 scope；无法判断影响范围时使用 ["unknown"]，不要反问或要求补充信息。',
    '',
    `${sourceName} #${intake.id} 内容：`,
    String(intake.body || '').trim() || '（正文为空）',
  ];
  if (typeof readSnippet === 'function' && String(intake.body || '').trim().length < 20) {
    appendProjectContext(promptParts, workspace, readSnippet);
  }
  if (attachmentPrompt) promptParts.push('', attachmentPrompt);
  return promptParts.join('\n');
}

function builtinPlanSpecPromptContract({ projectStatus }) {
  const validationCommand = normalizeNullableString(projectStatus?.validation_command);
  return [
    '必须通过 submit_plan_spec 结构化工具提交 PlanSpec JSON；不要输出 Markdown，不要写文件，不要改业务代码。',
    'AutoPlan 会校验 PlanSpec、规范化完整验收任务、自动分配 P001/P002 编号，并确定性渲染最终 Markdown plan。',
    '',
    'PlanSpec 契约：',
    '- 输出必须是合法 JSON 对象，不要使用 Markdown 代码块。',
    '- title、summary、tasks、finalValidation 必填且非空。',
    '- tasks 是开发任务数组；每个任务只写 title、scope、acceptance，不要写 P001/P002 等任务编号。',
    '- scope 必须是字符串数组，写预计修改的文件或模块；无法判断时使用 ["unknown"]。',
    '- acceptance 必须是字符串数组，只描述该任务应覆盖的场景，不要求在该任务内运行测试。',
    '- 不要把运行测试/回归/验收/构建拆成普通开发任务；最终验收写入 finalValidation。',
    '- finalValidation.command 必须是最终验收命令字符串；如果项目中无法明确判断，请根据技术栈推断合理命令。',
    '- finalValidation.criteria 必须列出最终验收范围和通过标准。',
    ...(validationCommand ? [`- 当前项目配置的最终验收命令：${validationCommand}`] : []),
    '',
    'JSON Schema：',
    JSON.stringify(PLAN_SPEC_SCHEMA, null, 2),
  ];
}

function structuredPlanSpecPromptContract({ planSpecFile, planFile, projectStatus }) {
  const validationCommand = normalizeNullableString(projectStatus?.validation_command);
  return [
    `PlanSpec JSON 输出文件：${planSpecFile}`,
    `最终 Markdown plan 文件将由 AutoPlan 渲染为：${planFile}`,
    '你必须使用文件写入工具把完整 PlanSpec JSON 写入上面的 JSON 输出文件；不要只把 JSON 打印在回复里。',
    '只写 PlanSpec JSON 文件，不要写最终 Markdown plan 文件，不要改业务代码。',
    '',
    'PlanSpec 契约：',
    '- 输出必须是合法 JSON 对象，不要使用 Markdown 代码块。',
    '- title、summary、tasks、finalValidation 必填且非空。',
    '- tasks 是开发任务数组；每个任务只写 title、scope、acceptance，不要写 P001/P002 等任务编号，AutoPlan 会自动编号。',
    '- scope 必须是字符串数组，写预计修改的文件或模块；无法判断时使用 ["unknown"]。',
    '- acceptance 必须是字符串数组，只描述该任务应覆盖的场景，不要求在该任务内运行测试。',
    '- 不要把运行测试/回归/验收/构建拆成普通开发任务；最终验收写入 finalValidation。',
    '- finalValidation.command 必须是最终验收命令字符串；如果项目中无法明确判断，请根据技术栈推断合理命令。',
    '- finalValidation.criteria 必须列出最终验收范围和通过标准。',
    ...(validationCommand ? [`- 当前项目配置的最终验收命令：${validationCommand}`] : []),
    '',
    'JSON Schema：',
    JSON.stringify(PLAN_SPEC_SCHEMA, null, 2),
  ];
}

function renderPlanSpecFileToMarkdown(input) {
  const {
    workspace,
    planSpecFile,
    planFile,
    helpers,
  } = input;
  const resolveSafePlanSpecPath = helpers.resolveSafePlanSpecPath || workspaceFiles.resolveSafePlanSpecPath;
  const resolveSafePlanMarkdownPath = helpers.resolveSafePlanMarkdownPath || workspaceFiles.resolveSafePlanMarkdownPath;
  const specSafety = resolveSafePlanSpecPath(workspace, planSpecFile);
  if (!specSafety.safe) throw new Error(`PlanSpec 路径不安全：${specSafety.reason}`);
  const markdownSafety = resolveSafePlanMarkdownPath(workspace, planFile);
  if (!markdownSafety.safe) throw new Error(`plan Markdown 路径不安全：${markdownSafety.reason}`);

  const planSpec = parsePlanSpecJson(fs.readFileSync(specSafety.filePath, 'utf8'));
  const markdown = renderPlanSpecMarkdown(planSpec);
  const contentValidation = validatePlanContent(markdown);
  if (!contentValidation.valid) {
    throw new PlanRenderError(`渲染后的 plan Markdown 不合规：${contentValidation.reason}`);
  }
  const taskValidation = validatePlanTaskSequence(markdown);
  if (!taskValidation.valid) {
    throw new PlanRenderError(`渲染后的任务序列不合规：${taskValidation.reason}`);
  }
  fs.mkdirSync(path.dirname(markdownSafety.filePath), { recursive: true });
  fs.writeFileSync(markdownSafety.filePath, markdown, 'utf8');
  return {
    planSpecFilePath: specSafety.filePath,
    planSpecRelativePath: specSafety.relativePath,
    planFilePath: markdownSafety.filePath,
    planFileRelativePath: markdownSafety.relativePath,
  };
}

function recoverPlanSpecFromStdout(planSpecFile, stdout) {
  if (!stdout || typeof stdout !== 'string' || stdout.trim().length === 0) return false;
  try {
    const planSpec = parsePlanSpecJson(stdout);
    fs.mkdirSync(path.dirname(planSpecFile), { recursive: true });
    fs.writeFileSync(planSpecFile, `${JSON.stringify(planSpec, null, 2)}\n`, 'utf8');
    return true;
  } catch (_) {
    return false;
  }
}

async function runBuiltinPlanSpecGenerationForService(service, input = {}) {
  const generator = typeof service.generateBuiltinPlanSpec === 'function'
    ? service.generateBuiltinPlanSpec.bind(service)
    : generateBuiltinPlanSpec;
  return generator({
    db: service.db,
    llmClient: service.llmClient,
    fetch: service.fetch,
    ...input,
  });
}

function writeBuiltinPlanSpecFile(input) {
  const {
    workspace,
    planSpecFile,
    planSpec,
    helpers,
  } = input;
  const resolveSafePlanSpecPath = helpers.resolveSafePlanSpecPath || workspaceFiles.resolveSafePlanSpecPath;
  const specSafety = resolveSafePlanSpecPath(workspace, planSpecFile);
  if (!specSafety.safe) throw new Error(`PlanSpec 路径不安全：${specSafety.reason}`);
  fs.mkdirSync(path.dirname(specSafety.filePath), { recursive: true });
  fs.writeFileSync(specSafety.filePath, `${JSON.stringify(planSpec, null, 2)}\n`, 'utf8');
  return specSafety;
}

function builtinFailureEventType(error) {
  const code = error?.code;
  if (
    code === BUILTIN_PLAN_GENERATION_ERROR_CODES.INVALID_PLAN_SPEC ||
    code === BUILTIN_PLAN_GENERATION_ERROR_CODES.NON_STRUCTURED_RESPONSE
  ) {
    return 'plan.format.invalid';
  }
  return 'plan.generate.failed';
}

function builtinFailureResult(error) {
  return {
    exitCode: null,
    output: '',
    errorMessage: error?.message || '内置 LLM 计划生成失败',
    logFile: null,
  };
}

function builtinSuccessResult(result = {}) {
  return {
    exitCode: 0,
    output: result.output || '',
    logFile: null,
  };
}

async function recordIssuePlanGenerationFailure(service, input) {
  const {
    projectId,
    agentLabel,
    agentContext,
    result,
    eventType,
    message,
    error,
    meta,
  } = input;
  const failureError = normalizeGenerateFailureError(
    error || result?.errorMessage || `${agentLabel} 计划生成失败`,
  );
  const logFile = normalizeNullableString(result?.logFile);
  service.addEvent(projectId, eventType || 'plan.generate.failed', message, {
    ...agentContext,
    ...(meta || {}),
    error: failureError,
    logFile,
  });
  await service.runHookScripts(projectId, 'on:fail', {
    failedStage: 'plan',
    error: failureError,
    log: logFile,
  });
  return null;
}

function planGenerationFailureError(input = {}) {
  const { result, agentLabel, missingArtifactPath, missingArtifactLabel } = input;
  const resultError = normalizeNullableString(result?.errorMessage);
  if (resultError) return resultError;
  if (missingArtifactPath) {
    return `计划生成失败：CLI 成功退出但未写入${missingArtifactLabel || '计划文件'} ${missingArtifactPath}`;
  }
  if (result && result.exitCode !== undefined && result.exitCode !== null) {
    const logFile = normalizeNullableString(result.logFile);
    return `${agentLabel} CLI 退出码 ${result.exitCode}${logFile ? `，日志：${logFile}` : ''}`;
  }
  return '计划生成失败';
}

function structuredPlanErrorMessage(error) {
  if (error instanceof PlanSpecValidationError) return error.errors.join('; ');
  if (error instanceof PlanRenderError) return error.message;
  return error?.message || String(error);
}

function buildPhasedPlanPrompt(input) {
  const {
    workspace,
    intake,
    sourceName,
    manifestFile,
    phaseFilePrefix,
    phasing,
    attachmentPrompt,
    readSnippet,
    isOpenCodeProvider,
  } = input;
  const sampleFiles = [1, 2].map((index) => path.join(
    workspace,
    'docs',
    'plan',
    `${phaseFilePrefix}_phase${String(index).padStart(2, '0')}.md`,
  ));
  const manifestExample = {
    intakeType: 'requirement',
    intakeId: Number(intake.id),
    phases: sampleFiles.map((file, index) => ({
      phaseIndex: index + 1,
      phaseTitle: `阶段 ${index + 1}`,
      file,
    })),
  };
  const explorationGuidance = isOpenCodeProvider
    ? [
        '必须优先依据给定需求正文拆分阶段；仅可为推断 scope 读取少量明确文件，禁止通读整仓后自行发挥，也不要主动联网检索。',
      ]
    : [
        '必须基于需求正文和项目实际代码拆分阶段；需求不明确时自行从代码推断影响范围，不要反问或请求补充信息。',
      ];
  const promptParts = [
    '你是需求整理与开发计划生成者。',
    `以下${sourceName}较长或明确需要分阶段推进，请生成多个阶段性 AutoPlan plan 文件。`,
    '',
    `Phase manifest 输出文件：${manifestFile}`,
    `阶段 plan 文件名必须严格使用：${phaseFilePrefix}_phaseNN.md，其中 NN 从 01 开始连续递增。`,
    '所有输出文件都必须位于当前工作区 docs/plan 目录下。',
    '',
    '输出契约：',
    `- 生成 2 到 ${PHASED_PLAN_MAX_PHASES} 个阶段；阶段编号必须从 1 开始连续。`,
    '- 每个阶段都写入一个独立、标准、可执行的 AutoPlan Markdown plan 文件。',
    '- 同时写入一个 JSON manifest 文件，内容必须是合法 JSON，不要使用 Markdown 代码块。',
    '- manifest 字段必须包含 phases 数组；每项包含 phaseIndex、phaseTitle、file，file 写阶段 plan 的绝对路径或 docs/plan 下相对路径。',
    '- manifest 示例：',
    JSON.stringify(manifestExample, null, 2),
    '',
    '每个阶段 plan 的格式要求：',
    '- 必须包含 `## 任务拆解` 章节标题。',
    '- 每个任务必须严格使用固定格式：- [ ] P001: 任务标题 <!-- scope: lib/foo.dart,test/foo_test.dart -->',
    '- 单个阶段内任务编号必须从 P001 开始连续递增，不能跳号或重复。',
    '- scope 必填，多个 scope 用英文逗号分隔；无法判断时写 <!-- scope: unknown -->。',
    '- 每个任务要有验收要点。',
    '- 每个阶段 plan 的最后一个任务必须是“完整验收”，scope 写 validation。',
    '- 必须包含总体验收标准和进度区。',
    '- 不要把“运行测试/回归/验收/构建”拆成普通开发任务；只在最后的完整验收节点写最终验收命令、范围和通过标准。',
    '- 如果需求明确要求新增或更新测试文件，可以生成“补充测试代码”的开发任务，但任务验收要点只描述应覆盖的场景，不要求在该任务内运行测试。',
    '- 只写 manifest 和阶段 plan 文件，不要改业务代码。',
    '',
    '拆分原则：',
    '- 每个阶段必须能作为独立 AutoPlan plan 进入 plans / plan_tasks 队列。',
    '- 阶段之间按依赖顺序排列，前一阶段应为后一阶段提供必要基础。',
    '- 不要生成一个庞大的总 plan；把需求拆成清晰、可落地、可验收的阶段。',
    `- 触发拆分原因：${phasing.reason}；正文长度=${phasing.bodyLength}，标题数=${phasing.headingCount}，列表项=${phasing.listItemCount}。`,
    '',
    ...explorationGuidance,
    '',
    `${sourceName} #${intake.id} 内容：`,
    String(intake.body || '').trim() || '（正文为空）',
  ];
  if (!isOpenCodeProvider && typeof readSnippet === 'function' && String(intake.body || '').trim().length < 20) {
    appendProjectContext(promptParts, workspace, readSnippet);
  }
  if (attachmentPrompt) promptParts.push('', attachmentPrompt);
  return promptParts.join('\n');
}

function appendProjectContext(promptParts, workspace, readSnippet) {
  const ctx = [];
  try {
    const readmePath = path.join(workspace, 'README.md');
    if (fs.existsSync(readmePath)) {
      const snippet = readSnippet(readmePath, 8000);
      if (snippet && snippet.trim()) ctx.push('## 项目 README 摘要：', snippet);
    }
  } catch (_) { /* 读取 README 失败，静默跳过 */ }
  try {
    const entries = fs.readdirSync(workspace, { withFileTypes: true });
    const lines = [];
    for (const entry of entries) {
      if (lines.length >= 20) break;
      lines.push(`- ${entry.name}${entry.isDirectory() ? '/' : ''}`);
    }
    if (lines.length > 0) ctx.push('## 项目根目录概览：', ...lines);
  } catch (_) { /* 读取目录失败，静默跳过 */ }
  if (ctx.length > 0) {
    promptParts.push('', '以下是项目自动收集的上下文，供你判断需求涉及范围：', '', ...ctx);
  }
}

function validatePhaseManifestFile({ workspace, manifestFile, intake, phaseFilePrefix, helpers }) {
  const resolveSafePlanManifestPath = helpers.resolveSafePlanManifestPath || workspaceFiles.resolveSafePlanManifestPath;
  const resolveSafePlanMarkdownPath = helpers.resolveSafePlanMarkdownPath || workspaceFiles.resolveSafePlanMarkdownPath;
  const manifestSafety = resolveSafePlanManifestPath(workspace, manifestFile);
  if (!manifestSafety.safe) throw new Error(`manifest 路径不安全：${manifestSafety.reason}`);

  let manifest;
  try {
    manifest = parseJsonObject(fs.readFileSync(manifestSafety.filePath, 'utf8'));
  } catch (error) {
    throw new Error(`manifest JSON 无效：${error.message}`);
  }

  if (manifest.intakeType && manifest.intakeType !== 'requirement') {
    throw new Error('manifest intakeType 必须为 requirement');
  }
  if (manifest.intakeId != null && Number(manifest.intakeId) !== Number(intake.id)) {
    throw new Error('manifest intakeId 与需求不一致');
  }
  const rawPhases = Array.isArray(manifest.phases)
    ? manifest.phases
    : (Array.isArray(manifest.plans) ? manifest.plans : []);
  if (rawPhases.length < 2) throw new Error('manifest 至少需要 2 个阶段');
  if (rawPhases.length > PHASED_PLAN_MAX_PHASES) {
    throw new Error(`manifest 阶段数不能超过 ${PHASED_PLAN_MAX_PHASES}`);
  }

  const phases = rawPhases.map((phase, index) => normalizeManifestPhase(phase, index));
  phases.sort((a, b) => a.phaseIndex - b.phaseIndex);
  phases.forEach((phase, index) => {
    const expectedIndex = index + 1;
    if (phase.phaseIndex !== expectedIndex) {
      throw new Error(`阶段编号必须从 1 连续递增，期望 ${expectedIndex}，实际 ${phase.phaseIndex}`);
    }
    const expectedName = `${phaseFilePrefix}_phase${String(expectedIndex).padStart(2, '0')}.md`;
    const phasePathInput = normalizeManifestPlanPathInput(phase.file);
    const phaseSafety = resolveSafePlanMarkdownPath(workspace, phasePathInput);
    if (!phaseSafety.safe) throw new Error(`阶段 ${expectedIndex} plan 路径不安全：${phaseSafety.reason}`);
    if (path.basename(phaseSafety.filePath) !== expectedName) {
      throw new Error(`阶段 ${expectedIndex} plan 文件名必须为 ${expectedName}`);
    }
    if (!fs.existsSync(phaseSafety.filePath)) throw new Error(`阶段 ${expectedIndex} plan 文件不存在`);
    const content = fs.readFileSync(phaseSafety.filePath, 'utf8');
    const contentValidation = validatePhasePlanContent(content);
    if (!contentValidation.valid) {
      throw new Error(`阶段 ${expectedIndex} plan 内容不合规：${contentValidation.reason}`);
    }
    phase.filePath = phaseSafety.filePath;
    phase.relativePath = phaseSafety.relativePath;
    phase.taskCount = contentValidation.taskCount;
  });

  return {
    manifest,
    manifestFile: manifestSafety.filePath,
    manifestRelativePath: manifestSafety.relativePath,
    phases,
  };
}

function normalizeManifestPhase(phase, index) {
  const phaseIndex = Number(
    phase?.phaseIndex ?? phase?.phase_index ?? phase?.index ?? phase?.phase ?? index + 1,
  );
  const phaseTitle = String(
    phase?.phaseTitle ?? phase?.phase_title ?? phase?.title ?? `阶段 ${phaseIndex}`,
  ).trim() || `阶段 ${phaseIndex}`;
  const file = String(
    phase?.file ?? phase?.filePath ?? phase?.file_path ?? phase?.planFile ?? phase?.plan_file ?? phase?.path ?? '',
  ).trim();
  if (!Number.isInteger(phaseIndex) || phaseIndex <= 0) throw new Error('manifest phaseIndex 必须为正整数');
  if (!file) throw new Error(`阶段 ${phaseIndex} 缺少 file`);
  return {
    phaseIndex,
    phaseTitle,
    file,
  };
}

function normalizeManifestPlanPathInput(filePath) {
  const value = String(filePath || '').trim();
  if (!value || path.isAbsolute(value)) return value;
  if (value.includes('/') || value.includes('\\')) return value;
  return path.join('docs', 'plan', value);
}

function validatePhasePlanContent(content) {
  const planValidation = validatePlanContent(content);
  if (!planValidation.valid) return planValidation;
  if (!/^##\s+总体验收标准/m.test(content)) return { valid: false, reason: '缺少 ## 总体验收标准' };
  if (!/^##\s+进度区/m.test(content)) return { valid: false, reason: '缺少 ## 进度区' };
  const taskValidation = validatePlanTaskSequence(content);
  if (!taskValidation.valid) return taskValidation;
  const lastTask = taskValidation.tasks[taskValidation.tasks.length - 1];
  if (!FINAL_ACCEPTANCE_RE.test(lastTask.title)) return { valid: false, reason: '最后一个任务必须是完整验收' };
  if (!String(lastTask.scope || '').split(/[,\s，、;；]+/).some((scope) => scope.trim().toLowerCase() === 'validation')) {
    return { valid: false, reason: '完整验收任务 scope 必须包含 validation' };
  }
  return { valid: true, taskCount: taskValidation.tasks.length };
}

function validatePlanTaskSequence(content) {
  const lines = planTaskSectionText(content).split(/\r?\n/);
  const taskLines = lines.filter((line) => PLAN_TASK_CHECKBOX_LINE_RE.test(line));
  if (taskLines.length === 0) return { valid: false, reason: '未找到任务行' };
  const tasks = [];
  for (let index = 0; index < taskLines.length; index += 1) {
    const line = taskLines[index];
    const match = line.match(PLAN_TASK_LINE_RE);
    if (!match) return { valid: false, reason: `第 ${index + 1} 个任务行格式不合规` };
    const taskNumber = Number(match[1]);
    const expectedNumber = index + 1;
    if (taskNumber !== expectedNumber) {
      return { valid: false, reason: `任务编号必须连续，期望 P${String(expectedNumber).padStart(3, '0')}` };
    }
    tasks.push({
      key: `P${String(taskNumber).padStart(3, '0')}`,
      title: String(match[2] || '').trim(),
      scope: String(match[3] || '').trim(),
    });
  }
  return { valid: true, tasks };
}

function planTaskSectionText(content) {
  const text = String(content || '');
  const sectionMatch = /^##\s+任务拆解.*$/m.exec(text);
  if (!sectionMatch) return text;
  const start = sectionMatch.index + sectionMatch[0].length;
  const rest = text.slice(start);
  const nextSection = /^##\s+\S.*$/m.exec(rest);
  return nextSection ? rest.slice(0, nextSection.index) : rest;
}

function parseJsonObject(content) {
  const text = String(content || '').trim();
  if (!text) throw new Error('内容为空');
  try {
    return JSON.parse(text);
  } catch (firstError) {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw firstError;
    return JSON.parse(match[0]);
  }
}

async function recordIntakePlanGenerationFailure(service, input) {
  const {
    projectId,
    table,
    intake,
    sourceName,
    agentLabel,
    agentContext,
    agentCliConfig,
    result,
    eventType,
    message,
    error,
    meta,
  } = input;
  const failureError = normalizeGenerateFailureError(
    error || result?.errorMessage || `${agentLabel} 生成${sourceName} #${intake.id} 计划失败`,
  );
  const logFile = normalizeNullableString(result?.logFile);
  const failedAt = nowIso();
  // agentContext 可能为空（agentCliContextFields 不再默认 'codex'），所以从 agentCliConfig 兜底补 provider/command，
  // 让事件 meta 始终带 agentCliProvider 字段供下游消费。
  const cliFallback = agentCliConfig && (agentCliConfig.agentCliProvider || agentCliConfig.provider)
    ? {
        agentCliProvider: agentCliConfig.agentCliProvider ?? agentCliConfig.provider,
        agentCliCommand: agentCliConfig.agentCliCommand ?? agentCliConfig.command,
      }
    : {};
  service.addEvent(projectId, eventType || 'plan.generate.failed', message, {
    ...cliFallback,
    ...agentContext,
    ...(meta || {}),
    error: failureError,
    logFile,
  });
  await service.runHookScripts(projectId, 'on:fail', {
    failedStage: 'plan',
    intakeType: intake.__type,
    intakeId: intake.id,
    error: failureError,
    log: logFile,
  });
  const failureCli = normalizeFailureAgentCliConfig(agentCliConfig || agentContext);
  service.db.run(
    `UPDATE ${table}
        SET generate_fail_count = COALESCE(generate_fail_count, 0) + 1,
            last_generate_fail_at = ?,
            last_generate_error = ?,
            last_generate_log_file = ?,
            last_generate_agent_cli_provider = ?,
            last_generate_codex_reasoning_effort = ?,
            updated_at = ?
      WHERE id = ?`,
    [
      failedAt,
      failureError,
      logFile,
      failureCli.provider,
      failureCli.codexReasoningEffort,
      failedAt,
      intake.id,
    ],
  );
  return null;
}

function clearIntakePlanGenerationFailure(service, table, intakeId) {
  service.db.run(
    `UPDATE ${table}
        SET generate_fail_count = 0,
            last_generate_fail_at = NULL,
            last_generate_error = NULL,
            last_generate_log_file = NULL,
            last_generate_agent_cli_provider = NULL,
            last_generate_codex_reasoning_effort = NULL,
            updated_at = ?
      WHERE id = ?`,
    [nowIso(), intakeId],
  );
}

function normalizeFailureAgentCliConfig(config = {}) {
  const providerInput = config.provider ?? config.agent_cli_provider ?? config.agentCliProvider;
  if (normalizeNullableString(providerInput) === null) {
    return {
      provider: null,
      codexReasoningEffort: null,
    };
  }
  const effective = effectiveAgentCliConfig({}, {
    agent_cli_provider: providerInput,
    agent_cli_command: config.command ?? config.agent_cli_command ?? config.agentCliCommand,
    codex_reasoning_effort: config.codexReasoningEffort ?? config.codex_reasoning_effort,
  });
  return {
    provider: effective.provider,
    codexReasoningEffort: effective.provider === DEFAULT_AGENT_CLI_PROVIDER ? effective.codexReasoningEffort : null,
  };
}

function intakePlanGenerationFailureError(input = {}) {
  const { result, sourceName, intake, agentLabel, missingArtifactPath, missingArtifactLabel } = input;
  const resultError = normalizeNullableString(result?.errorMessage);
  if (resultError) return resultError;
  if (missingArtifactPath) {
    return `生成${sourceName} #${intake.id} 计划失败：CLI 成功退出但未写入${missingArtifactLabel || '计划文件'} ${missingArtifactPath}`;
  }
  if (result && result.exitCode !== undefined && result.exitCode !== null) {
    const logFile = normalizeNullableString(result.logFile);
    return `${agentLabel} CLI 退出码 ${result.exitCode}${logFile ? `，日志：${logFile}` : ''}`;
  }
  return `生成${sourceName} #${intake.id} 计划失败`;
}

function normalizeGenerateFailureError(error) {
  const normalized = normalizeNullableString(error) || '计划生成失败';
  if (normalized.length <= INTAKE_PLAN_GENERATE_ERROR_MAX_LENGTH) return normalized;
  return `${normalized.slice(0, INTAKE_PLAN_GENERATE_ERROR_MAX_LENGTH - 1)}…`;
}

function normalizeNullableString(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text || null;
}

function intakeAttachmentPrompt(service, helpers, projectId, workspace, intake, sourceName) {
  const { intakeAttachmentOwnerTypes, describeIntakeAttachment, formatIntakeAttachmentEntry } = helpers;
    const ownerTypes = intakeAttachmentOwnerTypes(intake.__type);
    const placeholders = ownerTypes.map(() => '?').join(', ');
    const attachments = service.db.all(
      `SELECT * FROM attachments
       WHERE project_id = ? AND owner_id = ? AND owner_type IN (${placeholders})
       ORDER BY created_at ASC, id ASC`,
      [projectId, intake.id, ...ownerTypes],
    );
    if (!attachments.length) return '';

    const entries = attachments.map((attachment, index) => describeIntakeAttachment(workspace, attachment, index));
    const failed = entries.filter((entry) => !entry.readable);
    if (failed.length) {
      service.addEvent(
        projectId,
        'attachment.read.failed',
        `${sourceName} #${intake.id} 存在不可读附件：${failed.map((entry) => `${entry.name}（${entry.readError}）`).join('；')}`,
        {
          intakeType: intake.__type,
          intakeId: intake.id,
          attachments: failed.map((entry) => ({
            id: entry.id,
            name: entry.name,
            path: entry.path,
            error: entry.readError,
          })),
        },
      );
    }

    return [
      '附件清单：',
      '以下附件已持久化到本地文件系统；不要将图片二进制内联进 plan，工具可以通过“持久化本地路径”读取附件内容。',
      '生成 plan 时，如任务理解或后续执行依赖附件内容，请在计划、验收要点或任务说明中保留必要的附件路径或引用。',
      ...entries.flatMap((entry) => formatIntakeAttachmentEntry(entry)),
    ].join('\n');
}

function recoverPlanFromStdout(planFile, stdout) {
  if (!stdout || typeof stdout !== 'string' || stdout.trim().length === 0) {
    return false;
  }

  // 优先取 stdout 中首个 ## 二级标题到结尾的内容（去掉前面对话式寒暄）
  const headingMatch = stdout.match(/^## /m);
  if (headingMatch) {
    const content = stdout.slice(headingMatch.index).trim();
    if (content.length > 0) {
      fs.writeFileSync(planFile, content, 'utf-8');
      return true;
    }
  }

  // 无 ## 标题则视为无法提取有效 plan 内容，不落盘
  return false;
}

// 校验落盘/恢复的 plan 内容是否同时满足：
//  1) 含 `## 任务拆解` 二级标题；
//  2) 至少一行匹配 `- [ ] P0NN: ... <!-- scope: ... -->` 的合规任务行。
// 编号连续性、scope 合法性等由 syncPlanTasks 后续处理；本处仅校验格式存在性，
// 用于拦截 OpenCode 等 agentic 后端产出/截断导致的畸形 plan（反馈 #14）。
function isPlanContentValid(content) {
  return validatePlanContent(content).valid;
}

function validatePlanContent(content) {
  const text = typeof content === 'string' ? content : '';
  if (!text.trim()) return { valid: false, reason: '计划内容为空' };
  // 二级标题 `## 任务拆解`（容忍其后紧跟冒号/空白；不匹配 ### 等更深层级）
  if (!/^##\s+任务拆解/m.test(text)) return { valid: false, reason: '缺少 ## 任务拆解' };
  const taskValidation = validatePlanTaskSequence(text);
  if (!taskValidation.valid) return { valid: false, reason: taskValidation.reason || '缺少合规任务行' };
  return { valid: true, reason: '', taskCount: taskValidation.tasks.length, tasks: taskValidation.tasks };
}

function shouldGeneratePhasedPlans(intake = {}) {
  return analyzeIntakePlanPhasing(intake).enabled;
}

function analyzeIntakePlanPhasing(intake = {}) {
  const intakeType = intake.__type === 'feedback' ? 'feedback' : 'requirement';
  const body = String(intake.body || '');
  const text = `${String(intake.title || '')}\n${body}`;
  const bodyLength = body.trim().length;
  const headingCount = (body.match(/^\s{0,3}#{1,6}\s+\S/gm) || []).length;
  const listItemCount = (body.match(/^\s{0,6}(?:[-*+]|\d+[.)、])\s+\S/gm) || []).length;
  const explicitSignal = PHASED_PLAN_SIGNAL_RE.test(text);
  const longByLength = bodyLength >= PHASED_PLAN_BODY_LENGTH_THRESHOLD;
  const longByStructure =
    headingCount >= PHASED_PLAN_HEADING_THRESHOLD ||
    listItemCount >= PHASED_PLAN_LIST_THRESHOLD ||
    headingCount + listItemCount >= PHASED_PLAN_STRUCTURE_THRESHOLD;

  if (intakeType !== 'requirement') {
    return {
      enabled: false,
      reason: 'feedback_single_plan',
      bodyLength,
      headingCount,
      listItemCount,
      explicitSignal,
      longByLength,
      longByStructure,
    };
  }
  if (draftPlanRequested(intake)) {
    return {
      enabled: false,
      reason: 'draft_single_plan',
      bodyLength,
      headingCount,
      listItemCount,
      explicitSignal,
      longByLength,
      longByStructure,
    };
  }

  const enabled = explicitSignal || longByLength || longByStructure;
  const reason = explicitSignal
    ? 'explicit_phase_signal'
    : (longByLength ? 'long_body' : (longByStructure ? 'structured_long_body' : 'single_plan'));
  return {
    enabled,
    reason,
    bodyLength,
    headingCount,
    listItemCount,
    explicitSignal,
    longByLength,
    longByStructure,
  };
}

function draftPlanRequested(intake = {}) {
  return intake?.createAsDraft === true || intake?.draft === true || String(intake?.status || '') === 'draft';
}

module.exports = {
  generatePlan,
  generatePlanForIntake,
  intakeAttachmentPrompt,
  shouldGeneratePhasedPlans,
  analyzeIntakePlanPhasing,
  isPlanContentValid,
  validatePlanContent,
  validatePhasePlanContent,
  validatePlanTaskSequence,
  recoverPlanFromStdout,
  recoverPlanSpecFromStdout,
};
