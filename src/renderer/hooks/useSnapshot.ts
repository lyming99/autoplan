import { startTransition, useCallback, useEffect, useRef, useState, type SetStateAction } from 'react';
import { useAutoplanClient } from '../lib/api/provider';
import type { HttpReadonlyOperations } from '../lib/api/client';
import {
  isTerminalOperationEvent,
  type ProjectEventDelivery,
  type ResumableEventSubscription,
} from '../lib/api/events';
import type { AppSnapshot, WorkspaceSnapshotPatch } from '../types';

const EMPTY_SCAN_SUMMARY = {
  count: 0,
  total_size: 0,
  latest_scanned_at: null,
  latest_modified_at: null,
} as const;
const EVENT_BATCH_WINDOW_MS = 50;
const INITIAL_RESYNC_RETRY_MS = 250;
const MAXIMUM_RESYNC_RETRY_MS = 10_000;

/**
 * Subscribe to main-process snapshots.
 * Project pages ignore updates for other projects while keeping the project list fresh.
 */
export function useSnapshot(projectId: number | null) {
  const client = useAutoplanClient();
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const projectIdRef = useRef(projectId);
  const lastContentKeyRef = useRef<string>('');
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
    let eventRefreshTimer: ReturnType<typeof setTimeout> | undefined;
    let eventRefreshController: AbortController | null = null;
    let eventRefreshInFlight = false;
    let eventRefreshPending = false;
    let resyncRequired = false;
    let resyncFailures = 0;
    let snapshotRequestSequence = 0;
    let snapshotAppliedSequence = 0;
    let eventSubscription: ResumableEventSubscription | null = null;
    let queuedSnapshot: AppSnapshot | null = null;
    const queuedPatches = new Map<string, WorkspaceSnapshotPatch>();
    setSnapshot((current) => {
      if (projectId === null || !current || isSnapshotForProject(current, projectId)) return current;
      return createProjectListSnapshot(current);
    });
    const showError = (e: unknown) => {
      const failure = e as { code?: unknown; message?: unknown } | null;
      if (failure?.code === 'request_cancelled') return;
      if (import.meta.env.DEV) {
        const reason = typeof failure?.code === 'string' ? failure.code :
          typeof failure?.message === 'string' ? failure.message : 'unknown_error';
        console.error(`[autoplan] snapshot refresh failed: ${reason}`);
      }
      if (!disposed) setError('snapshot_refresh_failed');
    };
    const flushQueuedUpdate = () => {
      frameId = 0;
      const latestSnapshot = queuedSnapshot;
      const latestPatches = Array.from(queuedPatches.values());
      queuedSnapshot = null;
      queuedPatches.clear();
      if (disposed || (!latestSnapshot && !latestPatches.length)) return;
      // 内容去重：关键字段无变化时跳过渲染
      if (latestSnapshot && !latestPatches.length) {
        const contentKey = snapshotContentKey(latestSnapshot, projectId);
        if (contentKey && contentKey === lastContentKeyRef.current) return;
        lastContentKeyRef.current = contentKey;
      }
      // 用 startTransition 将快照更新标记为非紧急，浏览器可中断渲染以优先处理滚动/输入
      startTransition(() => {
        setSnapshot((current) => {
          let next = current;
          if (latestSnapshot) next = applySnapshotForProject(latestSnapshot, projectId, current);
          for (const latestPatch of latestPatches) {
            next = applySnapshotPatchForProject(next, latestPatch, projectId);
          }
          return next;
        });
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

    const eventClient = projectId === null ? null : asEventClient(client);
    const scheduleEventRefresh = (forceResync: boolean, immediate = false) => {
      if (disposed || !eventClient || projectId === null) return;
      eventRefreshPending = true;
      resyncRequired ||= forceResync;
      if (immediate && eventRefreshTimer !== undefined) {
        clearTimeout(eventRefreshTimer);
        eventRefreshTimer = undefined;
      }
      if (eventRefreshInFlight || eventRefreshTimer !== undefined) return;
      const delay = immediate ? 0 : EVENT_BATCH_WINDOW_MS;
      eventRefreshTimer = setTimeout(() => {
        eventRefreshTimer = undefined;
        void refreshAuthoritativeSnapshot();
      }, delay);
    };
    const refreshAuthoritativeSnapshot = async () => {
      if (disposed || !eventClient || projectId === null || eventRefreshInFlight || !eventRefreshPending) return;
      eventRefreshPending = false;
      const completingResync = resyncRequired;
      resyncRequired = false;
      eventRefreshInFlight = true;
      const controller = new AbortController();
      const requestSequence = ++snapshotRequestSequence;
      eventRefreshController = controller;
      try {
        const next = await eventClient.getProjectSnapshot(projectId, { signal: controller.signal });
        if (disposed || controller.signal.aborted) return;
        if (requestSequence >= snapshotAppliedSequence) {
          snapshotAppliedSequence = requestSequence;
          setSnapshot((current) => applySnapshotForProject(next, projectId, current));
        }
        resyncFailures = 0;
        if (completingResync) eventSubscription?.completeResync();
      } catch (error) {
        if (disposed || controller.signal.aborted) return;
        showError(error);
        resyncRequired ||= completingResync;
        resyncFailures += 1;
        const delay = Math.min(
          MAXIMUM_RESYNC_RETRY_MS,
          INITIAL_RESYNC_RETRY_MS * (2 ** Math.min(resyncFailures - 1, 5)),
        );
        eventRefreshPending = true;
        if (eventRefreshTimer === undefined) {
          eventRefreshTimer = setTimeout(() => {
            eventRefreshTimer = undefined;
            void refreshAuthoritativeSnapshot();
          }, delay);
        }
      } finally {
        if (eventRefreshController === controller) eventRefreshController = null;
        eventRefreshInFlight = false;
        if (!disposed && eventRefreshPending && eventRefreshTimer === undefined) {
          scheduleEventRefresh(resyncRequired, false);
        }
      }
    };
    const onProjectEvent = (delivery: ProjectEventDelivery) => {
      if (disposed || delivery.projectId !== projectId) return;
      if (delivery.kind === 'resync') {
        scheduleEventRefresh(true, true);
        return;
      }
      scheduleEventRefresh(false, isTerminalOperationEvent(delivery.event));
    };

    const unsubscribe = client.onLoopUpdate((next) => {
      if (disposed) return;
      scheduleSnapshot(next);
    });
    const unsubscribePatch = client.onLoopPatch((next) => {
      if (disposed) return;
      schedulePatch(next);
    });
    if (eventClient && projectId !== null) {
      eventSubscription = eventClient.connectProjectEvents(projectId, undefined, onProjectEvent);
    }

    const initialSnapshotSequence = ++snapshotRequestSequence;
    client
      .snapshot(projectId)
      .then((next) => {
        if (!disposed && initialSnapshotSequence >= snapshotAppliedSequence) {
          snapshotAppliedSequence = initialSnapshotSequence;
          setSnapshot((current) => applySnapshotForProject(next, projectId, current));
        }
      })
      .catch(showError);

    return () => {
      disposed = true;
      if (frameId) window.cancelAnimationFrame(frameId);
      if (eventRefreshTimer !== undefined) clearTimeout(eventRefreshTimer);
      eventRefreshController?.abort();
      eventSubscription?.();
      unsubscribe();
      unsubscribePatch();
    };
  }, [client, projectId]);

  return { snapshot, setSnapshot: commitSnapshot, error, setError };
}

function asEventClient(client: unknown): HttpReadonlyOperations | null {
  if (!client || typeof client !== 'object') return null;
  const candidate = client as Partial<HttpReadonlyOperations>;
  return typeof candidate.getProjectSnapshot === 'function' &&
    typeof candidate.connectProjectEvents === 'function'
    ? candidate as HttpReadonlyOperations
    : null;
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
    ...(hasOwn(patch, 'modelUsage') && patch.modelUsage ? { modelUsage: patch.modelUsage } : {}),
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

/** 轻量级内容指纹：仅比较长度和首尾 ID，避免深比较开销 */
function snapshotContentKey(snapshot: AppSnapshot, projectId: number | null): string {
  if (projectId === null || snapshot.activeProjectId === null) return '';
  const op = snapshot.activeOperation || snapshot.lastOperation;
  const activity = op?.activity;
  const tasks = snapshot.tasks || [];
  const events = snapshot.events || [];
  const plans = snapshot.plans || [];
  const usage = snapshot.modelUsage;
  const parts: string[] = [
    `p${plans.length}`,
    `t${tasks.length}`,
    `e${events.length}`,
    `s${snapshot.state?.running ? 1 : 0}`,
    `ph${snapshot.state?.phase || ''}`,
    `op${op?.label ?? ''}|${op?.startedAt ?? ''}`,
    `opst${op?.startedAt ?? ''}`,
    `opex${op?.exitCode ?? ''}`,
    `ac${activity?.length ?? 0}`,
    `mu${usage.cumulative.totalTokens}:${usage.today.totalTokens}:${usage.cumulative.inputTokens}:${usage.cumulative.outputTokens}:${usage.cumulative.cachedTokens}:${usage.cumulative.reasoningTokens}`,
  ];
  if (tasks.length) {
    parts.push(`tf${tasks[0].id}`, `tl${tasks[tasks.length - 1].id}`);
    parts.push(`tcmp${tasks.filter(t => t.status === 'completed').length}`);
    parts.push(`tfl${tasks.filter(t => t.status === 'failed').length}`);
  }
  if (events.length) {
    parts.push(`ef${events[0].id}`, `el${events[events.length - 1].id}`);
  }
  if (plans.length) {
    parts.push(`plf${plans[0].id}`, `pll${plans[plans.length - 1].id}`);
    parts.push(`plst${plans.map(p => p.status).join(',')}`);
  }
  if (activity && activity.length) {
    const last = activity[activity.length - 1];
    parts.push(`al${activity.length}`, `aat${last.at ?? ''}`, `ar${last.role ?? ''}`);
  }
  return parts.join('|');
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
