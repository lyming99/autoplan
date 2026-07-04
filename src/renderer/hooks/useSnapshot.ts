import { useCallback, useEffect, useRef, useState, type SetStateAction } from 'react';
import type { AppSnapshot, WorkspaceSnapshotPatch } from '../types';

const EMPTY_SCAN_SUMMARY = {
  count: 0,
  total_size: 0,
  latest_scanned_at: null,
  latest_modified_at: null,
} as const;

/**
 * Subscribe to main-process snapshots.
 * Project pages ignore updates for other projects while keeping the project list fresh.
 */
export function useSnapshot(projectId: number | null) {
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;

  const commitSnapshot = useCallback((action: SetStateAction<AppSnapshot | null>) => {
    const targetProjectId = projectIdRef.current;
    setSnapshot((current) => {
      const next = typeof action === 'function'
        ? (action as (value: AppSnapshot | null) => AppSnapshot | null)(current)
        : action;
      if (!next) return next;
      return applySnapshotForProject(next, targetProjectId, current);
    });
  }, []);

  useEffect(() => {
    let disposed = false;
    let frameId = 0;
    let queuedSnapshot: AppSnapshot | null = null;
    const queuedPatches = new Map<string, WorkspaceSnapshotPatch>();
    setSnapshot((current) => {
      if (projectId === null || !current || isSnapshotForProject(current, projectId)) return current;
      return createProjectListSnapshot(current);
    });
    const showError = (e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      if (!disposed) setError(msg);
    };
    const flushQueuedUpdate = () => {
      frameId = 0;
      const latestSnapshot = queuedSnapshot;
      const latestPatches = Array.from(queuedPatches.values());
      queuedSnapshot = null;
      queuedPatches.clear();
      if (disposed || (!latestSnapshot && !latestPatches.length)) return;
      setSnapshot((current) => {
        let next = current;
        if (latestSnapshot) next = applySnapshotForProject(latestSnapshot, projectId, current);
        for (const latestPatch of latestPatches) {
          next = applySnapshotPatchForProject(next, latestPatch, projectId);
        }
        return next;
      });
    };
    const scheduleFrame = () => {
      if (frameId) return;
      frameId = window.requestAnimationFrame(flushQueuedUpdate);
    };
    const scheduleSnapshot = (next: AppSnapshot) => {
      queuedSnapshot = next;
      queuedPatches.clear();
      scheduleFrame();
    };
    const schedulePatch = (next: WorkspaceSnapshotPatch) => {
      queuedPatches.set(patchQueueKey(next), next);
      scheduleFrame();
    };

    const unsubscribe = window.autoplan.onLoopUpdate((next) => {
      if (disposed) return;
      scheduleSnapshot(next);
    });
    const unsubscribePatch = typeof window.autoplan.onLoopPatch === 'function'
      ? window.autoplan.onLoopPatch((next) => {
          if (disposed) return;
          schedulePatch(next);
        })
      : () => {};

    window.autoplan
      .snapshot(projectId)
      .then((next) => {
        if (!disposed) setSnapshot((current) => applySnapshotForProject(next, projectId, current));
      })
      .catch(showError);

    return () => {
      disposed = true;
      if (frameId) window.cancelAnimationFrame(frameId);
      unsubscribe();
      unsubscribePatch();
    };
  }, [projectId]);

  return { snapshot, setSnapshot: commitSnapshot, error, setError };
}

function applySnapshotPatchForProject(
  current: AppSnapshot | null,
  patch: WorkspaceSnapshotPatch,
  projectId: number | null,
) {
  if (!current) return current;
  const patchProjectId = readPatchProjectId(patch);
  const projects = mergeProjectStateIntoProjects(current.projects, patchProjectId, patch.state);
  if (!isPatchForProject(patchProjectId, projectId) || !isSnapshotForProject(current, projectId)) {
    return projects === current.projects ? current : { ...current, projects };
  }

  return {
    ...current,
    projects,
    ...(hasOwn(patch, 'state') ? { state: patch.state ?? null } : {}),
    ...(hasOwn(patch, 'tasks') ? { tasks: patch.tasks || [] } : {}),
    ...(hasOwn(patch, 'events') ? { events: patch.events || [] } : {}),
    ...(hasOwn(patch, 'activeOperation') ? { activeOperation: patch.activeOperation ?? null } : {}),
    ...(hasOwn(patch, 'activeOperations') ? { activeOperations: patch.activeOperations || [] } : {}),
    ...(hasOwn(patch, 'lastOperation') ? { lastOperation: patch.lastOperation ?? null } : {}),
  };
}

function applySnapshotForProject(
  next: AppSnapshot,
  projectId: number | null,
  current: AppSnapshot | null,
) {
  if (isSnapshotForProject(next, projectId)) return next;
  if (current && isSnapshotForProject(current, projectId)) {
    return { ...current, projects: next.projects };
  }
  return createProjectListSnapshot(current || next, next.projects);
}

function isPatchForProject(patchProjectId: number | null, projectId: number | null) {
  return projectId !== null && patchProjectId !== null && Number(patchProjectId) === Number(projectId);
}

function isSnapshotForProject(snapshot: AppSnapshot, projectId: number | null) {
  if (projectId === null) return true;
  if (snapshot.activeProjectId === null) return false;
  return Number(snapshot.activeProjectId) === Number(projectId);
}

function readPatchProjectId(patch: WorkspaceSnapshotPatch) {
  const value = patch.projectId ?? patch.activeProjectId ?? null;
  if (value === null || typeof value === 'undefined') return null;
  const id = Number(value);
  return Number.isFinite(id) ? id : null;
}

function patchQueueKey(patch: WorkspaceSnapshotPatch) {
  return String(readPatchProjectId(patch) ?? 'all');
}

function mergeProjectStateIntoProjects(
  projects: AppSnapshot['projects'],
  projectId: number | null,
  state: WorkspaceSnapshotPatch['state'],
) {
  if (projectId === null || !state) return projects;
  let changed = false;
  const nextProjects = projects.map((project) => {
    if (Number(project.id) !== Number(projectId)) return project;
    changed = true;
    return {
      ...project,
      running: state.running,
      phase: state.phase,
      interval_seconds: state.interval_seconds,
      validation_command: state.validation_command,
      agent_cli_provider: state.agent_cli_provider,
      agent_cli_command: state.agent_cli_command,
      codex_reasoning_effort: state.codex_reasoning_effort,
      env_vars: state.env_vars,
      workspace_path: state.workspace_path ?? project.workspace_path,
      updated_at: state.updated_at || project.updated_at,
    };
  });
  return changed ? nextProjects : projects;
}

function hasOwn<T extends object, K extends PropertyKey>(value: T, key: K) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function createProjectListSnapshot(source: AppSnapshot, projects = source.projects): AppSnapshot {
  return {
    ...source,
    activeProjectId: null,
    activeProject: null,
    projects,
    state: null,
    requirements: [],
    feedback: [],
    attachments: [],
    plans: [],
    tasks: [],
    events: [],
    scans: [],
    scanSummary: EMPTY_SCAN_SUMMARY,
    scripts: [],
    executors: [],
    terminals: [],
    activeOperation: null,
    activeOperations: [],
    lastOperation: null,
  };
}
