import { FormEvent, useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { DEFAULT_WORKSPACE_TAB, PLAN_GENERATION_STRATEGIES, WORKSPACE_SEARCH_SOURCE_TYPES, getPlanTaskAssociationSource } from '../types';
import type {
  AppSnapshot,
  CodexReasoningEffort,
  IntakeAcceptanceHandler,
  IntakeMentionCandidate,
  IntakeType,
  LinkedPlanSummary,
  PendingAttachment,
  PlanBackendProvider,
  PlanGenerationInputFields,
  Plan,
  PlanTask,
  RetryIntakePlanGenerationOptions,
  WorkspacePlanReadState,
  WorkspaceSearchResult,
  WorkspaceTab,
} from '../types';
import { useComposerDrafts } from './useComposerDrafts';
import { useSnapshot } from './useSnapshot';
import { useAutoplanClient, useDesktopBridge } from '../lib/api/provider';
import { searchWorkspaceSnapshot } from '../utils/search';
import { buildIntakeMentionCandidates } from '../utils/intakeMentions';
import {
  createUnavailableLinkedPlan,
  createUnavailableLinkedPlanFromSummary,
  currentLinkedPlanSummary,
  findPreviewableLinkedPlan,
  matchFallbackPlan,
  normalizeLinkedPlanId,
  normalizeLinkedPlans,
  type LinkedPlanIntakeItem,
} from '../utils/linkedPlan';
import {
  appendPendingAttachments,
  agentCliOptions,
  codexReasoningOptions,
  composerPlanGenerationSelectionFromProjectState,
  createEmptyPlanReadState,
  createPendingClipboardImageAttachment,
  createPendingPathAttachment,
  defaultCodexReasoningEffort,
  defaultComposerPlanGenerationSelections,
  defaultScopeFileOpenSettings,
  emptyPendingAttachments,
  getErrorMessage,
  isExternalPlanGenerationStrategy,
  loopConfigurePayloadFromForm,
  loopFormFromProjectState,
  loopFormsEqual,
  mcpConfigFormToPayload,
  normalizeCodexReasoningEffort,
  normalizePlanBackendProvider,
  normalizePlanGenerationStrategy,
  planGenerationInputFromComposerSelection,
  resolveWorkspaceTab,
  useMcpConfigForm,
  type ComposerPlanGenerationSelection,
  type LoopFormState,
  type ScopeFileOpenSettings,
} from '../utils/workspaceForms';
import {
  EMPTY_WORKSPACE_FILTERABLE_ITEMS,
  filterItemsByWorkspaceSearch,
  filterTasksByWorkspaceSearch,
  searchNoMatchText,
  withTaskCliProviderTitle,
} from '../utils/workspaceSearch';
import {
  buildAcceptanceGroups,
  buildAcceptedGroups,
  buildRecentAccepted,
} from '../utils/planTasks';

export function useWorkspaceController() {
  const client = useAutoplanClient();
  const desktopBridge = useDesktopBridge();
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
  const [composerPlanGeneration, setComposerPlanGeneration] =
    useState<Record<IntakeType, ComposerPlanGenerationSelection>>(defaultComposerPlanGenerationSelections);
  const [loopForm, setLoopForm] = useState<LoopFormState>({
    workspacePath: '',
    intervalSeconds: '5',
    validationCommand: '',
    projectPrompt: '',
    agentCliProvider: 'codex',
    agentCliCommand: '',
    codexReasoningEffort: defaultCodexReasoningEffort,
    planGenerationStrategy: 'external-cli-markdown',
    planGenerationProvider: 'codex',
    planGenerationCommand: '',
    planGenerationModel: '',
    planGenerationCodexReasoningEffort: defaultCodexReasoningEffort,
    planGenerationClaudeBaseUrl: '',
    planGenerationClaudeAuthToken: '',
    planGenerationClaudeModel: '',
    planGenerationHasClaudeAuthToken: false,
    planGenerationClaudeConfigId: 0,
    planExecutionStrategy: 'external-cli',
    planExecutionProvider: 'codex',
    planExecutionCommand: '',
    planExecutionModel: '',
    planExecutionCodexReasoningEffort: defaultCodexReasoningEffort,
    planExecutionClaudeBaseUrl: '',
    planExecutionClaudeAuthToken: '',
    planExecutionClaudeModel: '',
    planExecutionHasClaudeAuthToken: false,
    planExecutionClaudeConfigId: 0,
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
  const searchableSnapshot = searchQuery.trim() ? snapshot : null;
  const workspaceSearch = useMemo(
    () => searchWorkspaceSnapshot(searchableSnapshot, searchQuery),
    [searchableSnapshot, searchQuery],
  );
  const searchHitCount = workspaceSearch.total;
  const isSearching = !workspaceSearch.query.isEmpty;
  const intakeMentionCandidates: IntakeMentionCandidate[] = useMemo(
    () => buildIntakeMentionCandidates(snapshot, projectId),
    [snapshot, projectId],
  );

  const requirementItems = activeTab === 'requirement'
    ? snapshot?.requirements ?? EMPTY_WORKSPACE_FILTERABLE_ITEMS.requirements
    : EMPTY_WORKSPACE_FILTERABLE_ITEMS.requirements;
  const feedbackItems = activeTab === 'feedback'
    ? snapshot?.feedback ?? EMPTY_WORKSPACE_FILTERABLE_ITEMS.feedback
    : EMPTY_WORKSPACE_FILTERABLE_ITEMS.feedback;
  const planItems = activeTab === 'tasks'
    ? snapshot?.plans ?? EMPTY_WORKSPACE_FILTERABLE_ITEMS.plans
    : EMPTY_WORKSPACE_FILTERABLE_ITEMS.plans;
  const taskItems = activeTab === 'tasks'
    ? snapshot?.tasks ?? EMPTY_WORKSPACE_FILTERABLE_ITEMS.tasks
    : EMPTY_WORKSPACE_FILTERABLE_ITEMS.tasks;
  const eventItems = activeTab === 'events'
    ? snapshot?.events ?? EMPTY_WORKSPACE_FILTERABLE_ITEMS.events
    : EMPTY_WORKSPACE_FILTERABLE_ITEMS.events;

  const filteredRequirements = useMemo(
    () => (activeTab === 'requirement'
      ? filterItemsByWorkspaceSearch(requirementItems, workspaceSearch, WORKSPACE_SEARCH_SOURCE_TYPES.REQUIREMENT)
      : EMPTY_WORKSPACE_FILTERABLE_ITEMS.requirements),
    [activeTab, requirementItems, workspaceSearch],
  );
  const filteredFeedback = useMemo(
    () => (activeTab === 'feedback'
      ? filterItemsByWorkspaceSearch(feedbackItems, workspaceSearch, WORKSPACE_SEARCH_SOURCE_TYPES.FEEDBACK)
      : EMPTY_WORKSPACE_FILTERABLE_ITEMS.feedback),
    [activeTab, feedbackItems, workspaceSearch],
  );
  const filteredPlans = useMemo(
    () => (activeTab === 'tasks'
      ? filterItemsByWorkspaceSearch(planItems, workspaceSearch, WORKSPACE_SEARCH_SOURCE_TYPES.PLAN)
      : EMPTY_WORKSPACE_FILTERABLE_ITEMS.plans),
    [activeTab, planItems, workspaceSearch],
  );
  const filteredTasks = useMemo(
    () => (activeTab === 'tasks'
      ? filterTasksByWorkspaceSearch(taskItems, filteredPlans, workspaceSearch)
      : EMPTY_WORKSPACE_FILTERABLE_ITEMS.tasks),
    [activeTab, filteredPlans, taskItems, workspaceSearch],
  );
  const filteredEvents = useMemo(
    () => (activeTab === 'events'
      ? filterItemsByWorkspaceSearch(eventItems, workspaceSearch, WORKSPACE_SEARCH_SOURCE_TYPES.EVENT)
      : EMPTY_WORKSPACE_FILTERABLE_ITEMS.events),
    [activeTab, eventItems, workspaceSearch],
  );
  const filteredItems = useMemo(
    () => ({
      requirements: filteredRequirements,
      feedback: filteredFeedback,
      plans: filteredPlans,
      tasks: filteredTasks,
      events: filteredEvents,
    }),
    [filteredRequirements, filteredFeedback, filteredPlans, filteredTasks, filteredEvents],
  );
  const taskCliProvider = activeTab === 'tasks' ? state?.agent_cli_provider : null;
  const displayTasks = useMemo(
    () => (activeTab === 'tasks'
      ? filteredTasks.map((task) => withTaskCliProviderTitle(task, taskCliProvider))
      : EMPTY_WORKSPACE_FILTERABLE_ITEMS.tasks),
    [activeTab, filteredTasks, taskCliProvider],
  );
  const filteredEmptyText = isSearching ? searchNoMatchText : undefined;
  const acceptancePlanItems = activeTab === 'acceptance'
    ? snapshot?.plans ?? EMPTY_WORKSPACE_FILTERABLE_ITEMS.plans
    : EMPTY_WORKSPACE_FILTERABLE_ITEMS.plans;
  const acceptanceTaskItems = activeTab === 'acceptance'
    ? snapshot?.tasks ?? EMPTY_WORKSPACE_FILTERABLE_ITEMS.tasks
    : EMPTY_WORKSPACE_FILTERABLE_ITEMS.tasks;
  const acceptanceProjectPlans = useMemo(
    () => (activeTab === 'acceptance'
      ? acceptancePlanItems.filter((plan) => Number(plan.project_id) === projectId)
      : EMPTY_WORKSPACE_FILTERABLE_ITEMS.plans),
    [acceptancePlanItems, activeTab, projectId],
  );
  const acceptanceGroups = useMemo(
    () => (activeTab === 'acceptance'
      ? buildAcceptanceGroups(acceptanceProjectPlans, acceptanceTaskItems)
      : []),
    [acceptanceProjectPlans, acceptanceTaskItems, activeTab],
  );
  const recentAccepted = useMemo(
    () => (activeTab === 'acceptance'
      ? buildRecentAccepted(acceptanceProjectPlans, acceptanceTaskItems)
      : []),
    [acceptanceProjectPlans, acceptanceTaskItems, activeTab],
  );
  const acceptedGroups = useMemo(
    () => (activeTab === 'acceptance'
      ? buildAcceptedGroups(acceptanceProjectPlans, acceptanceTaskItems)
      : []),
    [acceptanceProjectPlans, acceptanceTaskItems, activeTab],
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

  const openScopeFile = useCallback((
    filePath: string,
    mode: 'system' | 'folder' | 'vscode' | 'command' = scopeFileOpenSettings.mode,
  ) => {
    void (async () => {
      try {
        const result = await desktopBridge.openWorkspaceFile({
          projectId,
          filePath,
          mode,
          command: scopeFileOpenSettings.command,
        });
        if (!result.ok) throw new Error(result.error || '打开 scope 文件失败');
      } catch (e) {
        showError(e);
      }
    })();
  }, [desktopBridge, projectId, scopeFileOpenSettings.mode, scopeFileOpenSettings.command, showError]);

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
  }, [
    projectId,
    loopFormDirty,
    state?.project_id,
    state?.workspace_path,
    state?.interval_seconds,
    state?.validation_command,
    state?.project_prompt,
    state?.agent_cli_provider,
    state?.agent_cli_command,
    state?.codex_reasoning_effort,
    state?.plan_generation_strategy,
    state?.plan_generation_provider,
    state?.plan_generation_command,
    state?.plan_generation_model,
    state?.plan_generation_codex_reasoning_effort,
    state?.plan_execution_strategy,
    state?.plan_execution_provider,
    state?.plan_execution_command,
    state?.plan_execution_model,
    state?.plan_execution_codex_reasoning_effort,
    state?.env_vars,
    state,
  ]);

  useEffect(() => {
    setLoopFormDirty(false);
  }, [projectId]);

  useEffect(() => {
    if (!state || Number(state.project_id) !== Number(projectId)) return;
    setComposerPlanGeneration({
      requirement: composerPlanGenerationSelectionFromProjectState(state),
      feedback: composerPlanGenerationSelectionFromProjectState(state),
    });
  }, [
    projectId,
    state?.agent_cli_provider,
    state?.codex_reasoning_effort,
    state?.plan_generation_strategy,
    state?.plan_generation_provider,
    state?.plan_generation_command,
    state?.plan_generation_model,
    state?.plan_generation_codex_reasoning_effort,
    state,
  ]);

  const composerCliSelection = useMemo(
    () => ({
      options: agentCliOptions,
      reasoningOptions: codexReasoningOptions,
      selectedByType: composerPlanGeneration,
      onProviderChange: (type: IntakeType, provider: PlanBackendProvider) => {
        setComposerPlanGeneration((current) => {
          const currentSelection = current[type];
          const selectedStrategy = normalizePlanGenerationStrategy(currentSelection.strategy);
          const strategy = isExternalPlanGenerationStrategy(selectedStrategy)
            ? selectedStrategy
            : PLAN_GENERATION_STRATEGIES.EXTERNAL_CLI_MARKDOWN;
          const currentProvider = normalizePlanBackendProvider(currentSelection.provider, strategy);
          const nextProvider = normalizePlanBackendProvider(provider, strategy);
          return {
            ...current,
            [type]: {
              ...currentSelection,
              strategy,
              provider: nextProvider,
              command: currentProvider === nextProvider ? currentSelection.command : '',
            },
          };
        });
      },
      onReasoningChange: (type: IntakeType, effort: CodexReasoningEffort) => {
        setComposerPlanGeneration((current) => ({
          ...current,
          [type]: {
            ...current[type],
            codexReasoningEffort: normalizeCodexReasoningEffort(effort),
          },
        }));
      },
      onStrategyChange: (type: IntakeType, strategy: string) => {
        setComposerPlanGeneration((current) => {
          const normalizedStrategy = normalizePlanGenerationStrategy(strategy);
          const provider = normalizePlanBackendProvider(current[type].provider, normalizedStrategy);
          return {
            ...current,
            [type]: {
              ...current[type],
              strategy: normalizedStrategy,
              provider,
            },
          };
        });
      },
    }),
    [composerPlanGeneration],
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
    async (type: IntakeType, body: string | ({ body: string; createAsDraft?: boolean } & PlanGenerationInputFields)) => {
      if (!projectId) return false;
      try {
        const payload = body && typeof body === 'object' && !Array.isArray(body)
          ? body
          : { body: String(body || '') };
        const selectedPlanGeneration = planGenerationInputFromComposerSelection(composerPlanGeneration[type]);
        const explicitPlanGeneration: PlanGenerationInputFields = {
          ...(payload.planGenerationStrategy !== undefined ? { planGenerationStrategy: payload.planGenerationStrategy } : {}),
          ...(payload.planGenerationProvider !== undefined ? { planGenerationProvider: payload.planGenerationProvider } : {}),
          ...(payload.planGenerationCommand !== undefined ? { planGenerationCommand: payload.planGenerationCommand } : {}),
          ...(payload.planGenerationModel !== undefined ? { planGenerationModel: payload.planGenerationModel } : {}),
          ...(payload.planGenerationCodexReasoningEffort !== undefined
            ? { planGenerationCodexReasoningEffort: payload.planGenerationCodexReasoningEffort }
            : {}),
        };
        const planGenerationPayload = Object.keys(explicitPlanGeneration).length ? explicitPlanGeneration : selectedPlanGeneration;
        const next = await client[type === 'requirement' ? 'createRequirement' : 'createFeedback']({
          projectId,
          body: payload.body,
          attachments: pendingAttachments[type],
          ...(payload.createAsDraft ? { createAsDraft: true } : {}),
          ...planGenerationPayload,
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
    [client, composerPlanGeneration, pendingAttachments, projectId, setSnapshot, setError, showError],
  );

  const createRequirement = useCallback((body: string | ({ body: string; createAsDraft?: boolean } & PlanGenerationInputFields)) => createIntake('requirement', body), [createIntake]);
  const createFeedback = useCallback((body: string | ({ body: string; createAsDraft?: boolean } & PlanGenerationInputFields)) => createIntake('feedback', body), [createIntake]);

  const updateRequirement = useCallback(
    async (id: number, input: { title?: string; body?: string; status?: string }) => {
      if (!projectId) return false;
      try {
        const next = await client.updateRequirement({ projectId, id, ...input });
        setSnapshot(next);
        setError(null);
        return true;
      } catch (e) {
        showError(e);
        return false;
      }
    },
    [client, projectId, setSnapshot, setError, showError],
  );

  const deleteRequirement = useCallback(
    async (id: number) => {
      if (!projectId) return false;
      try {
        const next = await client.deleteRequirement({ projectId, id });
        setSnapshot(next);
        clearDeletedPlanReader(next);
        setError(null);
        return true;
      } catch (e) {
        showError(e);
        return false;
      }
    },
    [clearDeletedPlanReader, client, projectId, setSnapshot, setError, showError],
  );

  const updateFeedback = useCallback(
    async (id: number, input: { title?: string; body?: string; status?: string }) => {
      if (!projectId) return false;
      try {
        const next = await client.updateFeedback({ projectId, id, ...input });
        setSnapshot(next);
        setError(null);
        return true;
      } catch (e) {
        showError(e);
        return false;
      }
    },
    [client, projectId, setSnapshot, setError, showError],
  );

  const deleteFeedback = useCallback(
    async (id: number) => {
      if (!projectId) return false;
      try {
        const next = await client.deleteFeedback({ projectId, id });
        setSnapshot(next);
        clearDeletedPlanReader(next);
        setError(null);
        return true;
      } catch (e) {
        showError(e);
        return false;
      }
    },
    [clearDeletedPlanReader, client, projectId, setSnapshot, setError, showError],
  );

  const submitLoopConfig = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    try {
      const next = await client.configureLoop(loopConfigurePayloadFromForm(projectId, loopForm));
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

  const runLoopAction = useCallback(async (action: () => Promise<AppSnapshot>) => {
    try {
      const next = await action();
      setSnapshot(next);
      setError(null);
    } catch (e) {
      showError(e);
    }
  }, [setSnapshot, setError, showError]);

  const stopPlan = useCallback(
    async (plan: Plan) => {
      const targetProjectId = Number(plan?.project_id || projectId);
      const planId = Number(plan?.id || 0);
      if (!targetProjectId || !planId) return;
      await runLoopAction(() => client.stopPlan({ projectId: targetProjectId, planId }));
    },
    [client, projectId, runLoopAction],
  );

  const deletePlan = useCallback(
    async (plan: Plan) => {
      const targetProjectId = Number(plan?.project_id || projectId);
      const planId = Number(plan?.id || 0);
      if (!targetProjectId || !planId) return;
      try {
        const next = await client.deletePlan({ projectId: targetProjectId, planId });
        setSnapshot(next);
        clearDeletedPlanReader(next);
        setError(null);
      } catch (e) {
        showError(e);
      }
    },
    [clearDeletedPlanReader, client, projectId, setSnapshot, setError, showError],
  );

  const resumePlan = useCallback(
    async (plan: Plan) => {
      const targetProjectId = Number(plan?.project_id || projectId);
      const planId = Number(plan?.id || 0);
      if (!targetProjectId || !planId) return;
      await runLoopAction(() => client.resumePlan({ projectId: targetProjectId, planId }));
    },
    [client, projectId, runLoopAction],
  );

  const updatePlanExecutionConfig = useCallback(
    async (plan: Plan, provider: string, command?: string) => {
      const targetProjectId = Number(plan?.project_id || projectId);
      const planId = Number(plan?.id || 0);
      if (!targetProjectId || !planId) return;
      await runLoopAction(() =>
        client.updatePlanExecutionConfig({ projectId: targetProjectId, planId, provider, command }),
      );
    },
    [client, projectId, runLoopAction],
  );

  const reExecutePlan = useCallback(
    async (plan: Plan) => {
      const targetProjectId = Number(plan?.project_id || projectId);
      const planId = Number(plan?.id || 0);
      if (!targetProjectId || !planId) return;
      await runLoopAction(() => client.reExecutePlan({ projectId: targetProjectId, planId }));
    },
    [client, projectId, runLoopAction],
  );

  const recreatePlanFromIntake = useCallback(
    async (plan: Plan) => {
      const targetProjectId = Number(plan?.project_id || projectId);
      const planId = Number(plan?.id || 0);
      if (!targetProjectId || !planId) return;
      await runLoopAction(() =>
        client.recreatePlanFromIntake({ projectId: targetProjectId, planId }),
      );
    },
    [client, projectId, runLoopAction],
  );

  const appendPlanTask = useCallback(
    async (plan: Plan, title: string) => {
      const targetProjectId = Number(plan?.project_id || projectId);
      const planId = Number(plan?.id || 0);
      if (!targetProjectId || !planId) return;
      await runLoopAction(() =>
        client.appendPlanTask({ projectId: targetProjectId, planId, title }),
      );
    },
    [client, projectId, runLoopAction],
  );

  const startMcp = () => runLoopAction(() => client.startMcp({ projectId }));
  const stopMcp = () => runLoopAction(() => client.stopMcp({ projectId }));
  const saveMcpConfig = async () => {
    if (!projectId) return;
    try {
      const next = await client.saveMcpConfig(mcpConfigFormToPayload(projectId, mcpForm, mcpAuthTokenTouched));
      resetMcpForm(next.mcp);
      setSnapshot(next);
      setError(null);
    } catch (e) { showError(e); }
  };

  const acceptItem = (targetType: 'plan' | 'task', id: number) =>
    runLoopAction(() => client.acceptItem({ projectId, targetType, id }));
  const unacceptItem = (targetType: 'plan' | 'task', id: number) =>
    runLoopAction(() => client.unacceptItem({ projectId, targetType, id }));
  const redoAcceptanceItem = (targetType: 'plan' | 'task', id: number, supplement?: string) =>
    runLoopAction(() => client.redoAcceptanceItem({ projectId, targetType, id, supplement }));

  const acceptItems = (targets: { targetType: 'plan' | 'task'; id: number }[]) => {
    if (!targets || targets.length === 0) return; // 空列表短路，不发 IPC（后端亦拒绝）
    return runLoopAction(() => client.acceptItems({
      projectId,
      targets: targets.map((t) => ({ projectId, targetType: t.targetType, id: t.id })),
    }));
  };
  const unacceptItems = (targets: { targetType: 'plan' | 'task'; id: number }[]) => {
    if (!targets || targets.length === 0) return; // 空列表短路，不发 IPC（后端亦拒绝）
    return runLoopAction(() => client.unacceptItems({
      projectId,
      targets: targets.map((t) => ({ projectId, targetType: t.targetType, id: t.id })),
    }));
  };

  const acceptIntake = useCallback<IntakeAcceptanceHandler>(
    async (type, id) => {
      if (!projectId || !id) return;
      await runLoopAction(() => client.acceptIntake({ projectId, type, id }));
    },
    [client, projectId, runLoopAction],
  );

  const unacceptIntake = useCallback<IntakeAcceptanceHandler>(
    async (type, id) => {
      if (!projectId || !id) return;
      await runLoopAction(() => client.unacceptIntake({ projectId, type, id }));
    },
    [client, projectId, runLoopAction],
  );
  const interruptIntake = useCallback(
    async (type: IntakeType, id: number) => {
      try {
        const next = await client.interruptIntake({ projectId, type, id });
        setSnapshot(next);
        setError(null);
      } catch (e) {
        showError(e);
      }
    },
    [client, projectId, setSnapshot, setError, showError],
  );

  const resumeIntake = useCallback(
    async (type: IntakeType, id: number) => {
      try {
        const next = await client.resumeIntake({ projectId, type, id });
        setSnapshot(next);
        setError(null);
      } catch (e) {
        showError(e);
      }
    },
    [client, projectId, setSnapshot, setError, showError],
  );

  const appendIntakeTask = useCallback(
    async (type: IntakeType, id: number, title: string) => {
      try {
        const next = await client.appendIntakeTask({ projectId, type, id, title });
        setSnapshot(next);
        setError(null);
      } catch (e) {
        showError(e);
      }
    },
    [client, projectId, setSnapshot, setError, showError],
  );

  const retryIntakePlanGeneration = useCallback(
    async (type: IntakeType, id: number, options: RetryIntakePlanGenerationOptions = {}) => {
      try {
        const next = await client.retryIntakePlanGeneration({ projectId, type, id, ...options });
        setSnapshot(next);
        setError(null);
      } catch (e) {
        showError(e);
      }
    },
    [client, projectId, setSnapshot, setError, showError],
  );

  const readPlanForReader = useCallback(async (plan: Plan) => {
    const requestId = planReadRequestRef.current + 1;
    planReadRequestRef.current = requestId;
    setPlanReadState({ plan, result: null, loading: true, error: null });

    try {
      const result = await client.readPlan({ projectId: plan.project_id, planId: plan.id });
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
  }, [client]);

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
    (
      item: LinkedPlanIntakeItem,
      message: string,
      planId: number | null = normalizeLinkedPlanId(item.linked_plan_id),
      linkedPlan: LinkedPlanSummary | null = null,
    ) => {
      planReadRequestRef.current += 1;
      setPlanReadState({
        plan: linkedPlan
          ? createUnavailableLinkedPlanFromSummary(projectId, linkedPlan)
          : createUnavailableLinkedPlan(projectId, item, planId),
        result: null,
        loading: false,
        error: message,
      });
    },
    [projectId],
  );

  const openIntakePlanReader = useCallback(
    (item: LinkedPlanIntakeItem, linkedPlan?: LinkedPlanSummary | null, fallbackPlan?: Plan | null) => {
      const targetLinkedPlan = linkedPlan || currentLinkedPlanSummary(normalizeLinkedPlans(item));
      const planId = linkedPlanIdFromSummary(targetLinkedPlan) || normalizeLinkedPlanId(item.linked_plan_id);
      if (planId === null) {
        if (fallbackPlan) {
          openPlanReader(fallbackPlan);
          return;
        }
        showUnavailableLinkedPlanReader(item, '绑定 Plan ID 无效，暂无法预览。', null);
        return;
      }

      const plan = findPreviewableLinkedPlan(item, snapshot?.plans || [], projectId, targetLinkedPlan)
        || matchFallbackPlan(fallbackPlan, planId);
      if (!plan) {
        showUnavailableLinkedPlanReader(
          item,
          `绑定 Plan #${planId} 当前不可用，可能尚未同步、已删除或不属于当前项目。`,
          planId,
          targetLinkedPlan,
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
      const visibleTab = resolveWorkspaceTab(tab);
      setActiveTab(visibleTab);
      setSearchParams(visibleTab === DEFAULT_WORKSPACE_TAB ? {} : { tab: visibleTab }, { replace: true });
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
    acceptIntake,
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
    deletePlan,
    deleteRequirement,
    displayTasks,
    error,
    filteredEmptyText,
    filteredItems,
    interruptIntake,
    intakeMentionCandidates,
    isSearching,
    latestReadingPlan,
    loopForm,
    mcpForm,
    navigate,
    openIntakePlanReader,
    openPlanReader,
    openScopeFile,
    openTaskPlanReader,
    pendingAttachments,
    planReadState,
    project,
    projectId,
    projects,
    redoAcceptanceItem,
    recentAccepted,
    refreshPlanReader,
    removePendingAttachment,
    resumeIntake,
    retryIntakePlanGeneration,
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
    appendPlanTask,
    recreatePlanFromIntake,
    reExecutePlan,
    resumePlan,
    stopPlan,
    submitLoopConfig,
    updatePlanExecutionConfig,
    switchProject,
    unacceptIntake,
    unacceptItem,
    unacceptItems,
    updateComposerDraft,
    updateFeedback,
    updateLoopForm,
    updateRequirement,
    workspaceSearch,
  };
}

function linkedPlanIdFromSummary(linkedPlan: LinkedPlanSummary | null | undefined) {
  return normalizeLinkedPlanId(linkedPlan?.plan_id ?? linkedPlan?.planId ?? linkedPlan?.id);
}
