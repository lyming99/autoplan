'use strict';

async function openProjectFolderFromRuntime(options) {
  const projectId = Number(options?.projectId || 0);
  if (!Number.isSafeInteger(projectId) || projectId <= 0) {
    return { ok: false, error: '项目不存在' };
  }
  try {
    const project = options.goRuntime
      ? await options.loadGoProject(projectId)
      : options.database.get('SELECT workspace_path FROM projects WHERE id = ?', [projectId]);
    const folder = String(project?.workspace_path || '').trim();
    if (!folder) return { ok: false, error: '项目工作区路径为空' };
    const openError = await options.shell.openPath(folder);
    return { ok: !openError, error: openError || null };
  } catch {
    return { ok: false, error: '无法读取项目工作区路径' };
  }
}

module.exports = { openProjectFolderFromRuntime };
