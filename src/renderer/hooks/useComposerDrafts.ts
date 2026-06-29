import { useCallback, useEffect, useRef, useState } from 'react';
import type { IntakeType } from '../types';
import { composerDraftStorageKey, loadComposerDrafts, type ComposerDrafts } from '../utils/workspaceForms';

/**
 * Manage composer draft text for the requirement/feedback inputs, persisted per
 * project to `window.localStorage` under `autoplan.composerDrafts.<projectId>`.
 *
 * Drafts reload whenever the project changes so each project shows its own text
 * and never bleeds into another, then persist whenever they change. When the
 * storage key is null (invalid projectId) or localStorage is unavailable, the
 * hook degrades to an in-memory draft without throwing.
 */
export function useComposerDrafts(projectId: number) {
  const [drafts, setDrafts] = useState<ComposerDrafts>(() => loadComposerDrafts(projectId));
  // The render right after a project switch still holds the previous project's
  // drafts, so skip persisting once to avoid writing them under the new key.
  const skipPersist = useRef(false);

  useEffect(() => {
    setDrafts(loadComposerDrafts(projectId));
    skipPersist.current = true;
  }, [projectId]);

  useEffect(() => {
    if (skipPersist.current) {
      skipPersist.current = false;
      return;
    }
    const storageKey = composerDraftStorageKey(projectId);
    if (!storageKey) return;
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        window.localStorage.setItem(storageKey, JSON.stringify(drafts));
      }
    } catch {
      // localStorage unavailable; keep drafts in memory only.
    }
  }, [drafts, projectId]);

  const updateDraft = useCallback((type: IntakeType, value: string) => {
    setDrafts((current) => ({ ...current, [type]: value }));
  }, []);

  const clearDraft = useCallback((type: IntakeType) => {
    setDrafts((current) => ({ ...current, [type]: '' }));
  }, []);

  return { drafts, updateDraft, clearDraft };
}
