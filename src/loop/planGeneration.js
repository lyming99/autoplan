const fs = require('node:fs');
const path = require('node:path');
const { nowIso } = require('../database');
const {
  agentCliContextFields,
  agentCliOperationFields,
  agentCliProviderDisplayName,
  effectiveAgentCliConfig,
} = require('./agentCliConfig');

async function generatePlan(service, helpers, projectId, workspace, issueScan) {
  const { timestampForPath, readSnippet, normalizeRelative, hashFile } = helpers;
    service.setPhase(projectId, 'generate-plan');
    const planAgentCliConfig = effectiveAgentCliConfig(service.status(projectId));
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
      ...agentCliOperationFields(planAgentCliConfig),
    });
    const agentContext = agentCliContextFields(result, { defaultProvider: true });
    const planAgentCliSnapshot = effectiveAgentCliConfig(planAgentCliConfig, agentContext);
    const agentLabel = agentCliProviderDisplayName(agentContext.agentCliProvider);
    if (result.exitCode !== 0 || !fs.existsSync(planFile)) {
      service.addEvent(projectId, 'plan.generate.failed', `${agentLabel} 计划生成失败：${result.logFile}`, agentContext);
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
    });
    service.syncPlanTasks(id, planFile);
    service.db.run('UPDATE project_states SET last_issue_hash = ?, updated_at = ? WHERE project_id = ?', [
      issueScan.aggregateHash,
      nowIso(),
      projectId,
    ]);
    service.addEvent(projectId, 'plan.generated', `${agentLabel} 生成计划：${normalizeRelative(workspace, planFile)}`, {
      ...agentContext,
      planId: id,
    });
    await service.runHookScripts(projectId, 'plan:after', {
      planId: id,
      planFilePath: normalizeRelative(workspace, planFile),
    });
  }

async function generatePlanForIntake(service, helpers, projectId, workspace, intake) {
  const { timestampForPath, normalizeRelative, hashFile, hashText } = helpers;
    const table = intake.__type === 'feedback' ? 'feedback' : 'requirements';
    const sourceName = intake.__type === 'feedback' ? '反馈' : '需求';
    service.setPhase(projectId, 'generate-plan');
    const planAgentCliConfig = effectiveAgentCliConfig(service.status(projectId), intake);
    const safeId = String(intake.id).replace(/[^0-9a-zA-Z_-]/g, '');
    const planFile = path.join(
      workspace,
      'docs',
      'plan',
      `plan_${intake.__type}_${safeId}_${timestampForPath()}.md`,
    );
    const attachmentPrompt = service.intakeAttachmentPrompt(projectId, workspace, intake, sourceName);
    const promptParts = [
      '你是需求整理与开发计划生成者。',
      `请根据以下${sourceName}，生成一个开发计划和验收标准。`,
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
      `${sourceName} #${intake.id} 内容：`,
      String(intake.body || '').trim() || '（正文为空）',
    ];
    if (attachmentPrompt) promptParts.push('', attachmentPrompt);
    const prompt = promptParts.join('\n');

    const result = await service.runCodex(workspace, prompt, `gen-${intake.__type}-${intake.id}`, {
      projectId,
      intakeType: intake.__type,
      intakeId: intake.id,
      ...agentCliOperationFields(planAgentCliConfig),
    });
    const agentContext = agentCliContextFields(result, { defaultProvider: true });
    const planAgentCliSnapshot = effectiveAgentCliConfig(planAgentCliConfig, agentContext);
    const agentLabel = agentCliProviderDisplayName(agentContext.agentCliProvider);
    if (result.exitCode !== 0 || !fs.existsSync(planFile)) {
      service.addEvent(projectId, 'plan.generate.failed', `${agentLabel} 生成${sourceName} #${intake.id} 计划失败：${result.logFile}`, agentContext);
      await service.runHookScripts(projectId, 'on:fail', {
        failedStage: 'plan',
        intakeType: intake.__type,
        intakeId: intake.id,
        error: result.errorMessage || `生成${sourceName} #${intake.id} 计划失败`,
        log: result.logFile || null,
      });
      return null;
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
    });
    service.syncPlanTasks(id, planFile);
    if (planStatus === 'draft') {
      service.db.run('UPDATE plans SET status = ?, updated_at = ? WHERE id = ?', ['draft', nowIso(), id]);
    }
    // 回写关联
    service.db.run(`UPDATE ${table} SET linked_plan_id = ?, updated_at = ? WHERE id = ?`, [id, nowIso(), intake.id]);
    service.addEvent(projectId, 'plan.generated', `${agentLabel} 为${sourceName} #${intake.id} 生成计划：${normalizeRelative(workspace, planFile)}`, {
      ...agentContext,
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

function draftPlanRequested(intake = {}) {
  return intake?.createAsDraft === true || intake?.draft === true || String(intake?.status || '') === 'draft';
}

module.exports = {
  generatePlan,
  generatePlanForIntake,
  intakeAttachmentPrompt,
};
