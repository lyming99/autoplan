import { useEffect, useState } from 'react';
import type { AppSnapshot } from '../types';

/**
 * Subscribe to main-process snapshots.
 * Project pages ignore updates for other projects while keeping the project list fresh.
 */
export function useSnapshot(projectId: number | null) {
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    let frameId = 0;
    let queuedSnapshot: AppSnapshot | null = null;
    const showError = (e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      if (!disposed) setError(msg);
    };
    const applySnapshot = (next: AppSnapshot) => {
      if (projectId === null || Number(next.activeProjectId) === Number(projectId)) {
        setSnapshot(next);
        return;
      }
      setSnapshot((current) => (current ? { ...current, projects: next.projects } : current));
    };
    const scheduleSnapshot = (next: AppSnapshot) => {
      queuedSnapshot = next;
      if (frameId) return;
      frameId = window.requestAnimationFrame(() => {
        frameId = 0;
        const latest = queuedSnapshot;
        queuedSnapshot = null;
        if (!disposed && latest) applySnapshot(latest);
      });
    };

    const unsubscribe = window.autoplan.onLoopUpdate((next) => {
      if (disposed) return;
      scheduleSnapshot(next);
    });

    window.autoplan
      .snapshot(projectId)
      .then((next) => {
        if (!disposed) setSnapshot(next);
      })
      .catch(showError);

    return () => {
      disposed = true;
      if (frameId) window.cancelAnimationFrame(frameId);
      unsubscribe();
    };
  }, [projectId]);

  return { snapshot, setSnapshot, error, setError };
}
