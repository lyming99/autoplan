const fs = require('node:fs');
const path = require('node:path');
const { nowIso } = require('../database');
const intakeAttachments = require('./intakeAttachments');
const { resolveSafeAutoPlanIntakePlanPath } = require('./workspaceFiles');

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
  const planId = Number(intake.linked_plan_id || 0) || null;
  const plan = planId
    ? service.db.get('SELECT * FROM plans WHERE id = ? AND project_id = ?', [planId, projectId])
    : null;
  if (planId) {
    service.stopPlanOperations(projectId, planId, {
      archive: false,
      errorMessage: `${sourceName} #${intakeId} 已删除，关联计划已停止`,
      addOperationEvent: false,
    });
  }

  const planFileDelete = plan
    ? safeAutoPlanIntakePlanFileDeleteTarget(project, plan, normalizedType, intakeId)
    : null;
  const updatedAt = nowIso();
  const statements = [];
  if (normalizedType === 'requirement') {
    statements.push({
      sql: 'UPDATE feedback SET requirement_id = NULL, updated_at = ? WHERE project_id = ? AND requirement_id = ?',
      params: [updatedAt, projectId, intakeId],
    });
  }
  if (plan) {
    statements.push(
      { sql: 'DELETE FROM plan_tasks WHERE plan_id = ?', params: [plan.id] },
      { sql: 'DELETE FROM plans WHERE id = ? AND project_id = ?', params: [plan.id, projectId] },
    );
    for (const scanPath of uniqueNonEmptyStrings(plan.file_path, planFileDelete?.relativePath)) {
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
  if (planFileDelete) {
    if (planFileDelete.safe) deleteResolvedPlanFile(service, plan, planFileDelete);
    else recordPlanFileDeleteSkipped(service, plan, planFileDelete);
  }
  const attachmentFiles = deleteAttachmentFiles(attachments, options.attachmentsRoot);
  service.addEvent(projectId, 'intake.deleted', `${sourceName} #${intakeId} 已删除${plan ? '，关联计划和任务已删除' : ''}`, {
    intakeType: normalizedType,
    intakeId,
    planId: plan?.id || null,
    planFile: planFileDelete,
    attachments: {
      total: attachments.length,
      ...attachmentFiles,
    },
  });
  service.emitUpdate(projectId, { immediate: true });
  return service.snapshot(projectId);
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
    if (fs.existsSync(result.filePath)) {
      const realPlanDir = fs.realpathSync(result.planDir);
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
    }
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
  deleteAttachmentFiles,
  safeAutoPlanIntakePlanFileDeleteTarget,
  recordPlanFileDeleteSkipped,
  deleteResolvedPlanFile,
  isInsideDirectory,
  normalizePathForCompare,
  uniqueNonEmptyStrings,
};
