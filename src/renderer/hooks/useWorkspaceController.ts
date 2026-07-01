import { FormEvent, useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { DEFAULT_WORKSPACE_TAB, getPlanTaskAssociationSource } from '../types';
import type {
  AgentCliProvider,
  AppSnapshot,
  CodexReasoningEffort,
  IntakeType,
  PendingAttachment,
  Plan,
  PlanTask,
  WorkspacePlanReadState,
  WorkspaceSearchResult,
  WorkspaceTab,
} from '../types';
import { useComposerDrafts } from './useComposerDrafts';
import { useSnapshot } from './useSnapshot';
import { searchWorkspaceSnapshot } from '../utils/search';
import {
  createUnavailableLinkedPlan,
  findLinkedPlanInSnapshot,
  matchFallbackPlan,
  normalizeLinkedPlanId,
  type LinkedPlanIntakeItem,
} from '../utils/linkedPlan';
import {
  appendPendingAttachments,
  agentCliOptions,
  codexReasoningOptions,
  createEmptyPlanReadState,
  createPendingClipboardImageAttachment,
  createPendingPathAttachment,
  defaultCodexReasoningEffort,
  defaultComposerCliProviders,
  defaultComposerCodexReasoning,
  defaultScopeFileOpenSettings,
  emptyPendingAttachments,
  getErrorMessage,
  loopConfigurePayloadFromForm,
  loopFormFromProjectState,
  loopFormsEqual,
  mcpConfigFormToPayload,
  normalizeCodexReasoningEffort,
  resolveWorkspaceTab,
  useMcpConfigForm,
  type LoopFormState,
  type ScopeFileOpenSettings,
} from '../utils/workspaceForms';
import {
  createFilteredWorkspaceItems,
  searchNoMatchText,
  withTaskCliProviderTitle,
} from '../utils/workspaceSearch';
import {
  buildAcceptanceGroups,
  buildAcceptedGroups,
  buildRecentAccepted,
} from '../utils/planTasks';

export function useWorkspaceController() {
  const params = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const projectId = Number(params.projectId);
  const { snapshot, setSnapshot, error, setError } = useSnapshot(Number.isFinite(projectId) ? projectId : null);
  const { drafts: composerDrafts, updateDraft: updateComposerDraft } = useComposerDrafts(projectId);
  const tabParam = searchParams.get('tab');
  const [activeTab, setActiveTab] = useState<WorkspaceTab>(() => resolveWorkspaceTab(tabParam));
  const [pendingAttachments, setPendingAttachments] =
    useState<Record<IntakeType, PendingAttachment[]>>(emptyPendingAttachments);
  const [composerCliProviders, setComposerCliProviders] =
    useState<Record<IntakeType, AgentCliProvider>>(defaultComposerCliProviders);
  const [composerCodexReasoning, setComposerCodexReasoning] =
    useState<Record<IntakeType, CodexReasoningEffort>>(defaultComposerCodexReasoning);
  const [loopForm, setLoopForm] = useState<LoopFormState>({
    workspacePath: '',
    intervalSeconds: '5',
    validationCommand: '',
    agentCliProvider: 'codex',
    agentCliCommand: '',
    codexReasoningEffort: defaultCodexReasoningEffort,
    envVars: [],
  });
  const [loopFormDirty, setLoopFormDirty] = useState(false);
  const { mcpForm, mcpAuthTokenTouched, setMcpForm, resetMcpForm } = useMcpConfigForm(snapshot?.mcp, projectId);
  const [scopeFileOpenSettings, setScopeFileOpenSettings] = useState<ScopeFileOpenSettings>(() => {
    try {
      const parsed = JSON.parse(window.localStorage.getItem('autoplan.scopeFileOpenSettings') || 'null');
      const mode = parsed?.mode === 'folder' || parsed?.mode === 'vscode' || parsed?.mode === 'command'
        ? parsed.mode
        : 'system';
      return { mode, command: String(parsed?.command || '') };
    } catch {
      return defaultScopeFileOpenSettings;
    }
  });
  const [searchQuery, setSearchQuery] = useState('');
  const [planReadState, setPlanReadState] = useState<WorkspacePlanReadState>(() => createEmptyPlanReadState());
  const planReadRequestRef = useRef(0);

  const project = snapshot?.activeProject || null;
  const state = snapshot?.state || null;
  const projects = snapshot?.projects || [];
  const workspaceSearch = useMemo(() => searchWorkspaceSnapshot(snapshot, searchQuery), [snapshot, searchQuery]);
  const searchHitCount = workspaceSearch.total;
  const isSearching = !workspaceSearch.query.isEmpty;
  const filteredItems = useMemo(
    () => createFilteredWorkspaceItems(snapshot, workspaceSearch),
    [snapshot, workspaceSearch],
  );
  const displayTasks = useMemo(
    () => filteredItems.tasks.map((task) => withTaskCliProviderTitle(task, state?.agent_cli_provider)),
    [filteredItems.tasks, state?.agent_cli_provider],
  );
  const filteredEmptyText = isSearching ? searchNoMatchText : undefined;
  const acceptanceGroups = useMemo(
    () => buildAcceptanceGroups(
      (snapshot?.plans || []).filter((plan) => Number(plan.project_id) === projectId),
      snapshot?.tasks || [],
    ),
    [snapshot?.plans, snapshot?.tasks, projectId],
  );
  const recentAccepted = useMemo(
    () => buildRecentAccepted(
      (snapshot?.plans || []).filter((plan) => Number(plan.project_id) === projectId),
      snapshot?.tasks || [],
    ),
    [snapshot?.plans, snapshot?.tasks, projectId],
  );
  const acceptedGroups = useMemo(
    () => buildAcceptedGroups(
      (snapshot?.plans || []).filter((plan) => Number(plan.project_id) === projectId),
      snapshot?.tasks || [],
    ),
    [snapshot?.plans, snapshot?.tasks, projectId],
  );
  const latestReadingPlan = useMemo(() => {
    if (!planReadState.plan) return null;
    return (
      snapshot?.plans.find(
        (plan) => plan.id === planReadState.plan?.id && plan.project_id === planReadState.plan?.project_id,
      ) || planReadState.plan
    );
  }, [planReadState.plan, snapshot?.plans]);

  const showError = useCallback((e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e);
    setError(msg);
    window.alert(msg);
  }, [setError]);

  const resetPlanReaderState = useCallback(() => {
    planReadRequestRef.current += 1;
    setPlanReadState(createEmptyPlanReadState());
  }, []);

  const clearDeletedPlanReader = useCallback((next: AppSnapshot) => {
    const readingPlan = planReadState.plan;
    if (!readingPlan || Number(readingPlan.id) <= 0) return;

    const readingPlanId = Number(readingPlan.id);
    const readingProjectId = Number(readingPlan.project_id);
    const stillExists = next.plans.some(
      (plan) => Number(plan.id) === readingPlanId && Number(plan.project_id) === readingProjectId,
    );
    if (!stillExists) resetPlanReaderState();
  }, [planReadState.plan, resetPlanReaderState]);

  const updateLoopForm: Dispatch<SetStateAction<LoopFormState>> = useCallback((action) => {
    setLoopFormDirty(true);
    setLoopForm(action);
  }, []);

  useEffect(() => {
    if (!state || Number(state.project_id) !== Number(projectId)) return;
    const nextForm = loopFormFromProjectState(state);
    setLoopForm((current) => (loopFormDirty || loopFormsEqual(current, nextForm) ? current : nextForm));
  }, [projectId, loopFormDirty, state?.project_id, state?.workspace_path, state?.interval_seconds, state?.validation_command, state?.agent_cli_provider, state?.agent_cli_command, state?.codex_reasoning_effort, state?.env_vars, state]);

  useEffect(() => {
    setLoopFormDirty(false);
  }, [projectId]);

  useEffect(() => {
    const defaultProvider = state?.agent_cli_provider || 'codex';
    const defaultReasoning = normalizeCodexReasoningEffort(state?.codex_reasoning_effort);
    setComposerCliProviders({
      requirement: defaultProvider,
      feedback: defaultProvider,
    });
    setComposerCodexReasoning({
      requirement: defaultReasoning,
      feedback: defaultReasoning,
    });
  }, [projectId, state?.agent_cli_provider, state?.codex_reasoning_effort]);

  const composerCliSelection = useMemo(
    () => ({
      options: agentCliOptions,
      selectedByType: composerCliProviders,
      reasoningOptions: codexReasoningOptions,
      reasoningByType: composerCodexReasoning,
      onProviderChange: (type: IntakeType, provider: AgentCliProvider) => {
        setComposerCliProviders((current) => ({ ...current, [type]: provider }));
      },
      onReasoningChange: (type: IntakeType, effort: CodexReasoningEffort) => {
        setComposerCodexReasoning((current) => ({ ...current, [type]: normalizeCodexReasoningEffort(effort) }));
      },
    }),
    [composerCliProviders, composerCodexReasoning],
  );

  useEffect(() => {
    setSearchQuery('');
  }, [projectId]);

  useEffect(() => {
    window.localStorage.setItem('autoplan.scopeFileOpenSettings', JSON.stringify(scopeFileOpenSettings));
  }, [scopeFileOpenSettings]);

  // URL 的 tab 已等于当前激活标签时保持该选择（防止用户刚点击的 scripts 等被
  // resolveWorkspaceTab 当作未知值坍缩回默认 requirement）；仅在两者不一致时按 URL 回填。
  useEffect(() => {
    setActiveTab((current) => (current === tabParam ? current : resolveWorkspaceTab(tabParam)));
  }, [tabParam]);

  useEffect(() => {
    resetPlanReaderState();
    return () => {
      planReadRequestRef.current += 1;
    };
  }, [projectId, resetPlanReaderState]);

  const addPendingFiles = useCallback((type: IntakeType, files: FileList | File[] | null) => {
    const selectedFiles = Array.from(files || []);
    const pathAttachments: PendingAttachment[] = [];
    const clipboardImageFiles: File[] = [];

    for (const file of selectedFiles) {
      const pathAttachment = createPendingPathAttachment(file);
      if (pathAttachment) {
        pathAttachments.push(pathAttachment);
      } else if (file.type.startsWith('image/')) {
        clipboardImageFiles.push(file);
      }
    }

    appendPendingAttachments(setPendingAttachments, type, pathAttachments);
    if (!clipboardImageFiles.length) return;

    void Promise.allSettled(
      clipboardImageFiles.map((file, index) => createPendingClipboardImageAttachment(file, index)),
    ).then((results) => {
      const clipboardAttachments = results
        .filter((result): result is PromiseFulfilledResult<PendingAttachment | null> => result.status === 'fulfilled')
        .map((result) => result.value)
        .filter((attachment): attachment is PendingAttachment => Boolean(attachment));
      appendPendingAttachments(setPendingAttachments, type, clipboardAttachments);
    });
  }, []);

  const removePendingAttachment = useCallback((type: IntakeType, index: number) => {
    setPendingAttachments((current) => ({
      ...current,
      [type]: current[type].filter((_, itemIndex) => itemIndex !== index),
    }));
  }, []);

  const createIntake = useCallback(
    async (type: IntakeType, body: string) => {
      if (!projectId) return false;
      try {
        const provider = composerCliProviders[type];
        const next = await window.autoplan[type === 'requirement' ? 'createRequirement' : 'createFeedback']({
          projectId,
          body,
          attachments: pendingAttachments[type],
          agentCliProvider: provider,
          ...(provider === 'claude' ? {} : { codexReasoningEffort: composerCodexReasoning[type] }),
        });
        setSnapshot(next);
        setPendingAttachments((current) => ({ ...current, [type]: [] }));
        setError(null);
        return true;
      } catch (e) {
        showError(e);
        return false;
      }
    },
    [composerCliProviders, composerCodexReasoning, pendingAttachments, projectId, setSnapshot, setError, showError],
  );

  const createRequirement = useCallback((body: string) => createIntake('requirement', body), [createIntake]);
  const createFeedback = useCallback((body: string) => createIntake('feedback', body), [createIntake]);

  const updateRequirement = useCallback(
    async (id: number, input: { title?: string; body?: string; status?: string }) => {
      if (!projectId) return false;
      try {
        const next = await window.autoplan.updateRequirement({ projectId, id, ...input });
        setSnapshot(next);
        setError(null);
        return true;
      } catch (e) {
        showError(e);
        return false;
      }
    },
    [projectId, setSnapshot, setError, showError],
  );

  const deleteRequirement = useCallback(
    async (id: number) => {
      if (!projectId) return false;
      try {
        const next = await window.autoplan.deleteRequirement({ projectId, id });
        setSnapshot(next);
        clearDeletedPlanReader(next);
        setError(null);
        return true;
      } catch (e) {
        showError(e);
        return false;
      }
    },
    [clearDeletedPlanReader, projectId, setSnapshot, setError, showError],
  );

  const updateFeedback = useCallback(
    async (id: number, input: { title?: string; body?: string; status?: string }) => {
      if (!projectId) return false;
      try {
        const next = await window.autoplan.updateFeedback({ projectId, id, ...input });
        setSnapshot(next);
        setError(null);
        return true;
      } catch (e) {
        showError(e);
        return false;
      }
    },
    [projectId, setSnapshot, setError, showError],
  );

  const deleteFeedback = useCallback(
    async (id: number) => {
      if (!projectId) return false;
      try {
        const next = await window.autoplan.deleteFeedback({ projectId, id });
        setSnapshot(next);
        clearDeletedPlanReader(next);
        setError(null);
        return true;
      } catch (e) {
        showError(e);
        return false;
      }
    },
    [clearDeletedPlanReader, projectId, setSnapshot, setError, showError],
  );

  const submitLoopConfig = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    try {
      const next = await window.autoplan.configureLoop(loopConfigurePayloadFromForm(projectId, loopForm));
      if (next.state && Number(next.state.project_id) === Number(projectId)) {
        setLoopForm(loopFormFromProjectState(next.state));
      }
      setLoopFormDirty(false);
      setSnapshot(next);
      setError(null);
    } catch (e) {
      showError(e);
    }
  };

  const runLoopAction = async (action: () => Promise<AppSnapshot>) => {
    try {
      const next = await action();
      setSnapshot(next);
      setError(null);
    } catch (e) {
      showError(e);
    }
  };

  const startMcp = () => runLoopAction(() => window.autoplan.startMcp({ projectId }));
  const stopMcp = () => runLoopAction(() => window.autoplan.stopMcp({ projectId }));
  const saveMcpConfig = async () => {
    if (!projectId) return;
    try {
      const next = await window.autoplan.saveMcpConfig(mcpConfigFormToPayload(projectId, mcpForm, mcpAuthTokenTouched));
      resetMcpForm(next.mcp);
      setSnapshot(next);
      setError(null);
    } catch (e) { showError(e); }
  };

  const acceptItem = (targetType: 'plan' | 'task', id: number) =>
    runLoopAction(() => window.autoplan.acceptItem({ projectId, targetType, id }));
  const unacceptItem = (targetType: 'plan' | 'task', id: number) =>
    runLoopAction(() => window.autoplan.unacceptItem({ projectId, targetType, id }));

  const acceptItems = (targets: { targetType: 'plan' | 'task'; id: number }[]) => {
    if (!targets || targets.length === 0) return; // 空列表短路，不发 IPC（后端亦拒绝）
    return runLoopAction(() => window.autoplan.acceptItems({
      projectId,
      targets: targets.map((t) => ({ projectId, targetType: t.targetType, id: t.id })),
    }));
  };
  const unacceptItems = (targets: { targetType: 'plan' | 'task'; id: number }[]) => {
    if (!targets || targets.length === 0) return; // 空列表短路，不发 IPC（后端亦拒绝）
    return runLoopAction(() => window.autoplan.unacceptItems({
      projectId,
      targets: targets.map((t) => ({ projectId, targetType: t.targetType, id: t.id })),
    }));
  };

  const interruptIntake = useCallback(
    async (type: IntakeType, id: number) => {
      try {
        const next = await window.autoplan.interruptIntake({ projectId, type, id });
        setSnapshot(next);
        setError(null);
      } catch (e) {
        showError(e);
      }
    },
    [projectId, setSnapshot, setError, showError],
  );

  const resumeIntake = useCallback(
    async (type: IntakeType, id: number) => {
      try {
        const next = await window.autoplan.resumeIntake({ projectId, type, id });
        setSnapshot(next);
        setError(null);
      } catch (e) {
        showError(e);
      }
    },
    [projectId, setSnapshot, setError, showError],
  );

  const appendIntakeTask = useCallback(
    async (type: IntakeType, id: number, title: string) => {
      try {
        const next = await window.autoplan.appendIntakeTask({ projectId, type, id, title });
        setSnapshot(next);
        setError(null);
      } catch (e) {
        showError(e);
      }
    },
    [projectId, setSnapshot, setError, showError],
  );

  const readPlanForReader = useCallback(async (plan: Plan) => {
    const requestId = planReadRequestRef.current + 1;
    planReadRequestRef.current = requestId;
    setPlanReadState({ plan, result: null, loading: true, error: null });

    try {
      const result = await window.autoplan.readPlan({ projectId: plan.project_id, planId: plan.id });
      if (planReadRequestRef.current !== requestId) return;

      setPlanReadState({
        plan: {
          ...plan,
          file_path: result.file_path || plan.file_path,
          hash: result.hash || plan.hash,
          updated_at: result.updated_at || plan.updated_at,
        },
        result,
        loading: false,
        error: result.ok ? null : result.error || '读取 Plan 全文失败',
      });
    } catch (e) {
      if (planReadRequestRef.current !== requestId) return;
      setPlanReadState({
        plan,
        result: null,
        loading: false,
        error: getErrorMessage(e, '读取 Plan 全文失败'),
      });
    }
  }, []);

  const openPlanReader = useCallback(
    (plan: Plan) => {
      const currentPlan = planReadState.plan;
      if (planReadState.loading && currentPlan && currentPlan.id === plan.id && currentPlan.project_id === plan.project_id) {
        return;
      }
      void readPlanForReader(plan);
    },
    [planReadState.loading, planReadState.plan?.id, planReadState.plan?.project_id, readPlanForReader],
  );

  const showUnavailableLinkedPlanReader = useCallback(
    (item: LinkedPlanIntakeItem, message: string, planId: number | null = normalizeLinkedPlanId(item.linked_plan_id)) => {
      planReadRequestRef.current += 1;
      setPlanReadState({
        plan: createUnavailableLinkedPlan(projectId, item, planId),
        result: null,
        loading: false,
        error: message,
      });
    },
    [projectId],
  );

  const openIntakePlanReader = useCallback(
    (item: LinkedPlanIntakeItem, fallbackPlan?: Plan | null) => {
      const planId = normalizeLinkedPlanId(item.linked_plan_id);
      if (planId === null) {
        if (fallbackPlan) {
          openPlanReader(fallbackPlan);
          return;
        }
        showUnavailableLinkedPlanReader(item, '绑定 Plan ID 无效，暂无法预览。', null);
        return;
      }

      const plan = findLinkedPlanInSnapshot(snapshot?.plans || [], planId, projectId) || matchFallbackPlan(fallbackPlan, planId);
      if (!plan) {
        showUnavailableLinkedPlanReader(
          item,
          `绑定 Plan #${planId} 当前不可用，可能尚未同步、已删除或不属于当前项目。`,
          planId,
        );
        return;
      }

      openPlanReader(plan);
    },
    [openPlanReader, projectId, showUnavailableLinkedPlanReader, snapshot?.plans],
  );

  const closePlanReader = useCallback(() => {
    resetPlanReaderState();
  }, [resetPlanReaderState]);

  const refreshPlanReader = useCallback(() => {
    if (planReadState.loading) return;
    const plan = latestReadingPlan || planReadState.plan;
    if (!plan) return;
    if (Number(plan.id) <= 0) {
      setPlanReadState((current) => ({
        ...current,
        error: current.error || '绑定 Plan ID 无效，暂无法预览。',
      }));
      return;
    }
    void readPlanForReader(plan);
  }, [latestReadingPlan, planReadState.loading, planReadState.plan, readPlanForReader]);

  const openTaskPlanReader = useCallback(
    (task: PlanTask) => {
      const plan = snapshot?.plans.find((item) => getPlanTaskAssociationSource(task, item) !== null);
      if (plan) openPlanReader(plan);
    },
    [openPlanReader, snapshot?.plans],
  );

  const switchProject = (nextId: number) => {
    if (nextId && nextId !== projectId) {
      navigate(`/projects/${nextId}${activeTab === DEFAULT_WORKSPACE_TAB ? '' : `?tab=${activeTab}`}`);
    }
  };

  const selectTab = useCallback(
    (tab: WorkspaceTab) => {
      setActiveTab(tab);
      setSearchParams(tab === DEFAULT_WORKSPACE_TAB ? {} : { tab }, { replace: true });
    },
    [setSearchParams],
  );

  const selectSearchResult = useCallback(
    (result: WorkspaceSearchResult) => {
      selectTab(result.location.targetTab);
    },
    [selectTab],
  );

  return {
    activeTab,
    acceptanceGroups,
    acceptedGroups,
    acceptItem,
    acceptItems,
    addPendingFiles,
    appendIntakeTask,
    closePlanReader,
    composerCliSelection,
    composerDrafts,
    createFeedback,
    createRequirement,
    deleteFeedback,
    deleteRequirement,
    displayTasks,
    error,
    filteredEmptyText,
    filteredItems,
    interruptIntake,
    isSearching,
    latestReadingPlan,
    loopForm,
    mcpForm,
    navigate,
    openIntakePlanReader,
    openPlanReader,
    openTaskPlanReader,
    pendingAttachments,
    planReadState,
    project,
    projectId,
    projects,
    recentAccepted,
    refreshPlanReader,
    removePendingAttachment,
    resumeIntake,
    runLoopAction,
    saveMcpConfig,
    scopeFileOpenSettings,
    searchHitCount,
    searchQuery,
    selectSearchResult,
    selectTab,
    setMcpForm,
    setScopeFileOpenSettings,
    setSearchQuery,
    snapshot,
    startMcp,
    state,
    stopMcp,
    submitLoopConfig,
    switchProject,
    unacceptItem,
    unacceptItems,
    updateComposerDraft,
    updateFeedback,
    updateLoopForm,
    updateRequirement,
    workspaceSearch,
  };
}
