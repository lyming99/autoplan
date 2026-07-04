const fs = require('node:fs');
const path = require('node:path');
const { nowIso } = require('../database');
const intakeAttachments = require('./intakeAttachments');
const intakePlanLinks = require('./intakePlanLinks');
const {
  resolveSafeAutoPlanIntakePlanPath,
  resolveSafePlanMarkdownPath,
} = require('./workspaceFiles');

function isInsideDirectory(rootPath, targetPath) {
  const resolvedRoot = normalizePathForCompare(path.resolve(rootPath));
  const resolvedTarget = normalizePathForCompare(path.resolve(targetPath));
  const relativePath = path.relative(resolvedRoot, resolvedTarget);
  return relativePath === '' || (!!relativePath && !relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

function normalizePathForCompare(value) {
  return process.platform === 'win32' ? String(value).toLowerCase() : String(value);
}

function uniqueNonEmptyStrings(...values) {
  return Array.from(new Set(values.map((value) => String(value || '').trim()).filter(Boolean)));
}

function uniquePlans(plans = []) {
  const byId = new Map();
  for (const plan of plans) {
    const id = Number(plan?.id || 0);
    if (!id || byId.has(id)) continue;
    byId.set(id, plan);
  }
  return Array.from(byId.values());
}

function deleteIntake(service, projectId, intakeType, intakeId, options = {}) {
  const normalizedType = intakeType === 'feedback' ? 'feedback' : 'requirement';
  const table = normalizedType === 'feedback' ? 'feedback' : 'requirements';
  const ownerTypes = intakeAttachments.intakeAttachmentOwnerTypes(normalizedType);
  const sourceName = normalizedType === 'feedback' ? '反馈' : '需求';
  const intake = service.db.get(`SELECT * FROM ${table} WHERE id = ? AND project_id = ?`, [intakeId, projectId]);
  if (!intake) throw new Error(`${sourceName}不存在`);

  const project = service.project(projectId);
  const attachments = service.db.all(
    `SELECT * FROM attachments
     WHERE project_id = ? AND owner_id = ? AND owner_type IN (${ownerTypes.map(() => '?').join(',')})
     ORDER BY id ASC`,
    [projectId, intakeId, ...ownerTypes],
  );
  const linkedPlanEntries = intakePlanLinks.getPlansForIntake(service, projectId, normalizedType, intakeId);
  const linkedPlans = uniquePlans(linkedPlanEntries.map((entry) => entry.plan).filter(Boolean));
  for (const plan of linkedPlans) {
    service.stopPlanOperations(projectId, plan.id, {
      archive: false,
      errorMessage: `${sourceName} #${intakeId} 已删除，关联计划已停止`,
      addOperationEvent: false,
    });
  }

  const planFileDeletes = linkedPlans.map((plan) => ({
    plan,
    target: safeAutoPlanIntakePlanFileDeleteTarget(project, plan, normalizedType, intakeId),
  }));
  const updatedAt = nowIso();
  const statements = [];
  if (normalizedType === 'requirement') {
    statements.push({
      sql: 'UPDATE feedback SET requirement_id = NULL, updated_at = ? WHERE project_id = ? AND requirement_id = ?',
      params: [updatedAt, projectId, intakeId],
    });
  }
  statements.push(...intakePlanLinks.deleteLinksForIntakeStatements(projectId, normalizedType, intakeId));
  for (const { plan, target } of planFileDeletes) {
    statements.push(
      { sql: 'DELETE FROM plan_tasks WHERE plan_id = ?', params: [plan.id] },
      { sql: 'DELETE FROM plans WHERE id = ? AND project_id = ?', params: [plan.id, projectId] },
    );
    for (const scanPath of uniqueNonEmptyStrings(plan.file_path, target?.relativePath)) {
      statements.push({
        sql: "DELETE FROM scan_files WHERE project_id = ? AND scan_type = 'plan' AND file_path = ?",
        params: [projectId, scanPath],
      });
    }
  }
  statements.push(
    {
      sql: `DELETE FROM attachments
            WHERE project_id = ? AND owner_id = ? AND owner_type IN (${ownerTypes.map(() => '?').join(',')})`,
      params: [projectId, intakeId, ...ownerTypes],
    },
    { sql: `DELETE FROM ${table} WHERE id = ? AND project_id = ?`, params: [intakeId, projectId] },
  );
  service.db.runBatch(statements);
  for (const { plan, target } of planFileDeletes) {
    if (target.safe) deleteResolvedPlanFile(service, plan, target);
    else recordPlanFileDeleteSkipped(service, plan, target);
  }
  const attachmentFiles = deleteAttachmentFiles(attachments, options.attachmentsRoot);
  service.addEvent(projectId, 'intake.deleted', `${sourceName} #${intakeId} 已删除${linkedPlans.length ? '，关联计划和任务已删除' : ''}`, {
    intakeType: normalizedType,
    intakeId,
    planId: linkedPlans[0]?.id || null,
    planIds: linkedPlans.map((plan) => Number(plan.id)),
    planFile: planFileDeletes[0]?.target || null,
    planFiles: planFileDeletes.map(({ target }) => target),
    attachments: {
      total: attachments.length,
      ...attachmentFiles,
    },
  });
  service.emitUpdate(projectId, { immediate: true });
  return service.snapshot(projectId);
}

function deletePlan(service, projectId, planId, options = {}) {
  const normalizedProjectId = Number(projectId || 0);
  const normalizedPlanId = Number(planId || 0);
  if (!normalizedProjectId || !service.project(normalizedProjectId)) throw new Error('项目不存在');
  if (!normalizedPlanId) throw new Error('计划不存在');

  const project = service.project(normalizedProjectId);
  const plan = service.db.get('SELECT * FROM plans WHERE id = ? AND project_id = ?', [
    normalizedPlanId,
    normalizedProjectId,
  ]);
  if (!plan) throw new Error('计划不存在');

  const stopped = service.stopPlanOperations(normalizedProjectId, normalizedPlanId, {
    archive: false,
    errorMessage: `plan #${normalizedPlanId} 已删除，运行已停止`,
    addOperationEvent: false,
  });
  const taskCount = Number(
    service.db.get('SELECT COUNT(*) AS count FROM plan_tasks WHERE plan_id = ?', [normalizedPlanId])?.count || 0,
  );
  const linkedSources = intakePlanLinks.getIntakesForPlan(service, normalizedProjectId, normalizedPlanId);
  const linkedRequirements = linkedSources.filter((source) => source.intakeType === 'requirement');
  const linkedFeedback = linkedSources.filter((source) => source.intakeType === 'feedback');
  const planFileDelete = safePlanFileDeleteTarget(project, plan);
  const deleteReason = String(options.reason || '').trim();
  const updatedAt = nowIso();
  const statements = [
    ...intakePlanLinks.deleteLinksForPlanStatements(normalizedProjectId, normalizedPlanId),
    ...linkedSources.map((source) => intakePlanLinks.syncLegacyLinkedPlanStatement(
      normalizedProjectId,
      source.intakeType,
      source.intakeId,
      updatedAt,
      { onlyWhenLinkedPlanId: normalizedPlanId },
    )),
    { sql: 'DELETE FROM plan_tasks WHERE plan_id = ?', params: [normalizedPlanId] },
    { sql: 'DELETE FROM plans WHERE id = ? AND project_id = ?', params: [normalizedPlanId, normalizedProjectId] },
  ];
  for (const scanPath of uniqueNonEmptyStrings(plan.file_path, planFileDelete?.relativePath)) {
    statements.push({
      sql: "DELETE FROM scan_files WHERE project_id = ? AND scan_type = 'plan' AND file_path = ?",
      params: [normalizedProjectId, scanPath],
    });
  }
  service.db.runBatch(statements);
  if (planFileDelete.safe) deleteResolvedPlanFile(service, plan, planFileDelete);
  else recordPlanFileDeleteSkipped(service, plan, planFileDelete);

  service.addEvent(normalizedProjectId, 'plan.deleted', `plan #${normalizedPlanId} 已删除`, {
    planId: normalizedPlanId,
    filePath: plan.file_path,
    stoppedOperations: stopped.length,
    deletedTasks: taskCount,
    linkedIntakes: {
      requirements: linkedRequirements.length,
      requirementIds: linkedRequirements.map((source) => Number(source.intakeId)),
      feedback: linkedFeedback.length,
      feedbackIds: linkedFeedback.map((source) => Number(source.intakeId)),
    },
    planFile: planFileDelete,
    keepIntakes: true,
    ...(deleteReason ? { reason: deleteReason } : {}),
  });
  service.emitUpdate(normalizedProjectId, { immediate: true });
  return service.snapshot(normalizedProjectId);
}

function deleteAttachmentFiles(attachments = [], attachmentsRoot = '') {
  const root = String(attachmentsRoot || '').trim();
  const result = { deleted: 0, skipped: 0, failed: 0 };
  if (!root) {
    result.skipped = attachments.length;
    return result;
  }
  const rootPath = path.resolve(root);
  for (const attachment of attachments) {
    const storedPath = String(attachment?.stored_path || '').trim();
    const filePath = storedPath
      ? (path.isAbsolute(storedPath) ? path.resolve(storedPath) : path.resolve(rootPath, storedPath))
      : '';
    if (!filePath || !isInsideDirectory(rootPath, filePath)) {
      result.skipped += 1;
      continue;
    }
    try {
      if (fs.existsSync(filePath)) {
        if (!fs.statSync(filePath).isFile()) {
          result.skipped += 1;
          continue;
        }
        fs.unlinkSync(filePath);
        result.deleted += 1;
      } else {
        result.skipped += 1;
      }
    } catch {
      result.failed += 1;
    }
  }
  return result;
}

function safeAutoPlanIntakePlanFileDeleteTarget(project, plan, intakeType, intakeId) {
  const safety = resolveSafeAutoPlanIntakePlanPath(project?.workspace_path, plan?.file_path, intakeType, intakeId);
  const result = {
    safe: safety.safe,
    reason: safety.reason || '',
    relativePath: safety.relativePath || String(plan?.file_path || ''),
    filePath: safety.filePath || '',
    planDir: safety.planDir || '',
    intakeType,
    intakeId,
    deleted: false,
  };
  if (!safety.safe) result.expectedPattern = safety.expectedPattern || '';
  return result;
}

function safePlanFileDeleteTarget(project, plan) {
  const safety = resolveSafePlanMarkdownPath(project?.workspace_path, plan?.file_path);
  return {
    safe: safety.safe,
    reason: safety.reason || '',
    relativePath: safety.relativePath || String(plan?.file_path || ''),
    filePath: safety.filePath || '',
    planDir: safety.planDir || '',
    planId: plan?.id || null,
    deleted: false,
  };
}

function recordPlanFileDeleteSkipped(service, plan, result = {}) {
  if (!plan) return;
  service.addEvent(plan.project_id, 'plan.file.delete.skipped', `关联计划文件未删除：${result.reason || '路径不安全'}`, {
    planId: plan.id,
    intakeType: result.intakeType,
    intakeId: result.intakeId,
    filePath: plan.file_path,
    reason: result.reason,
    expectedPattern: result.expectedPattern,
  });
}

function deleteResolvedPlanFile(service, plan, result) {
  if (!result?.safe || !result.filePath) return result;
  try {
    if (!fs.existsSync(result.filePath)) {
      result.reason = 'file_not_found';
      service.addEvent(plan.project_id, 'plan.file.delete.skipped', '关联计划文件未删除：文件不存在', {
        planId: plan.id,
        filePath: result.relativePath,
        intakeType: result.intakeType,
        intakeId: result.intakeId,
        reason: result.reason,
      });
      return result;
    }
    const realPlanDir = fs.realpathSync(result.planDir);
    const realWorkspaceRoot = fs.realpathSync(path.resolve(result.planDir, '..', '..'));
    if (!isInsideDirectory(realWorkspaceRoot, realPlanDir)) {
      result.safe = false;
      result.reason = 'realpath_plan_dir_outside_workspace';
      service.addEvent(plan.project_id, 'plan.file.delete.skipped', '关联计划文件未删除：真实 docs/plan 超出工作区', {
        planId: plan.id,
        filePath: result.relativePath,
        intakeType: result.intakeType,
        intakeId: result.intakeId,
        reason: result.reason,
      });
      return result;
    }
    const realFilePath = fs.realpathSync(result.filePath);
    if (!isInsideDirectory(realPlanDir, realFilePath)) {
      result.safe = false;
      result.reason = 'realpath_outside_docs_plan';
      service.addEvent(plan.project_id, 'plan.file.delete.skipped', '关联计划文件未删除：真实路径超出 docs/plan', {
        planId: plan.id,
        filePath: result.relativePath,
        intakeType: result.intakeType,
        intakeId: result.intakeId,
        reason: result.reason,
      });
      return result;
    }
    fs.unlinkSync(result.filePath);
    result.deleted = true;
    return result;
  } catch (error) {
    result.reason = error?.message || String(error);
    service.addEvent(plan.project_id, 'plan.file.delete.failed', `关联计划文件删除失败：${result.reason}`, {
      planId: plan.id,
      filePath: result.relativePath,
      intakeType: result.intakeType,
      intakeId: result.intakeId,
      error: result.reason,
    });
    return result;
  }
}

module.exports = {
  deleteIntake,
  deletePlan,
  deleteAttachmentFiles,
  safeAutoPlanIntakePlanFileDeleteTarget,
  safePlanFileDeleteTarget,
  recordPlanFileDeleteSkipped,
  deleteResolvedPlanFile,
  isInsideDirectory,
  normalizePathForCompare,
  uniqueNonEmptyStrings,
};
