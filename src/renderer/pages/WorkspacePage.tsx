import { Dispatch, FormEvent, SetStateAction, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { PENDING_ATTACHMENT_SOURCES, WORKSPACE_SEARCH_SOURCE_TYPES } from '../types';
import type {
  AgentCliOption,
  AgentCliProvider,
  AppSnapshot,
  CodexReasoningEffort,
  IntakeType,
  PendingAttachment,
  Plan,
  PlanTask,
  Project,
  ProjectState,
  WorkspacePlanReadState,
  WorkspaceSearchGroup,
  WorkspaceSearchSourceType,
  WorkspaceSearchState,
  WorkspaceTab,
} from '../types';
import { useSnapshot } from '../hooks/useSnapshot';
import { ComposerCliSelectionProvider } from '../components/Composer';
import { IntakePanel } from '../components/IntakePanel';
import { EventList, PlanList, TaskList } from '../components/PlanLists';
import { SearchResults } from '../components/SearchResults';
import { CodexLog } from '../components/CodexLog';
import { Icon, type IconName } from '../components/icons';
import { getFilePath, agentCliProviderLabel, codexReasoningEffortLabel } from '../components/shared';
import { searchWorkspaceSnapshot } from '../utils/search';
import { formatChinaTime } from '../utils/time';

const emptyPendingAttachments: Record<IntakeType, PendingAttachment[]> = {
  requirement: [],
  feedback: [],
};

const agentCliOptions: AgentCliOption[] = [
  { value: 'codex', label: 'Codex CLI' },
  { value: 'claude', label: 'Claude CLI' },
];

const codexReasoningOptions: AgentCliOption[] = [
  { value: 'low', label: '低 · 快速' },
  { value: 'medium', label: '中 · 默认' },
  { value: 'high', label: '高 · 深入' },
];

const defaultCodexReasoningEffort: CodexReasoningEffort = 'medium';

const defaultComposerCliProviders: Record<IntakeType, AgentCliProvider> = {
  requirement: 'codex',
  feedback: 'codex',
};

const defaultComposerCodexReasoning: Record<IntakeType, CodexReasoningEffort> = {
  requirement: defaultCodexReasoningEffort,
  feedback: defaultCodexReasoningEffort,
};

const tabs: Array<{ id: WorkspaceTab; label: string; icon: IconName }> = [
  { id: 'overview', label: '概览', icon: 'overview' },
  { id: 'requirement', label: '需求', icon: 'requirement' },
  { id: 'feedback', label: '反馈', icon: 'feedback' },
  { id: 'tasks', label: '任务与计划', icon: 'tasks' },
  { id: 'events', label: '事件流', icon: 'events' },
  { id: 'settings', label: '设置', icon: 'settings' },
];

const searchNoMatchText = '没有匹配结果。';

type LoopFormState = {
  workspacePath: string;
  intervalSeconds: string;
  validationCommand: string;
  agentCliProvider: string;
  agentCliCommand: string;
  codexReasoningEffort: CodexReasoningEffort;
};

type WorkspaceFilterableItems = Pick<AppSnapshot, 'requirements' | 'feedback' | 'plans' | 'tasks' | 'events'>;

function createEmptyPlanReadState(): WorkspacePlanReadState {
  return { plan: null, result: null, loading: false, error: null };
}

function getErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error.trim()) return error.trim();
  return fallback;
}

function createPendingPathAttachment(file: File): PendingAttachment | null {
  const path = getFilePath(file);
  if (!path) return null;
  const name = file.name || path.split(/[\\/]/).pop() || '附件';
  const type = file.type || 'application/octet-stream';
  return {
    id: `${PENDING_ATTACHMENT_SOURCES.PATH}:${path}:${file.size}`,
    source: PENDING_ATTACHMENT_SOURCES.PATH,
    path,
    name,
    size: file.size,
    type,
    previewUrl: window.autoplan.toFileUrl(path),
  };
}

function getImageExtension(type: string) {
  if (type === 'image/jpeg') return 'jpg';
  const subtype = type.startsWith('image/') ? type.slice('image/'.length) : 'png';
  return subtype.replace(/[^a-z0-9]+/gi, '').toLowerCase() || 'png';
}

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('读取剪贴板图片失败'));
    reader.readAsDataURL(file);
  });
}

async function createPendingClipboardImageAttachment(file: File, index: number): Promise<PendingAttachment | null> {
  if (!file.type.startsWith('image/')) return null;
  const type = file.type || 'image/png';
  const extension = getImageExtension(type);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const fallbackName = `pasted-image-${timestamp}-${index + 1}.${extension}`;
  const name = file.name || fallbackName;
  const dataUrl = await readFileAsDataUrl(file);
  if (!dataUrl) return null;
  const idSuffix = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${index}-${Math.random().toString(36).slice(2)}`;
  return {
    id: `${PENDING_ATTACHMENT_SOURCES.CLIPBOARD_IMAGE}:${idSuffix}`,
    source: PENDING_ATTACHMENT_SOURCES.CLIPBOARD_IMAGE,
    dataUrl,
    name,
    size: file.size,
    type,
    previewUrl: dataUrl,
  };
}

function appendPendingAttachments(
  setPendingAttachments: Dispatch<SetStateAction<Record<IntakeType, PendingAttachment[]>>>,
  type: IntakeType,
  attachments: PendingAttachment[],
) {
  if (!attachments.length) return;
  setPendingAttachments((current) => {
    const nextItems = [...current[type]];
    for (const attachment of attachments) {
      if (!nextItems.some((item) => isSamePendingAttachment(item, attachment))) nextItems.push(attachment);
    }
    return nextItems.length === current[type].length ? current : { ...current, [type]: nextItems };
  });
}

function isSamePendingAttachment(current: PendingAttachment, next: PendingAttachment) {
  if (current.source !== next.source) return false;
  if (current.source === PENDING_ATTACHMENT_SOURCES.PATH && next.source === PENDING_ATTACHMENT_SOURCES.PATH) {
    return current.path === next.path && current.size === next.size;
  }
  if (
    current.source === PENDING_ATTACHMENT_SOURCES.CLIPBOARD_IMAGE &&
    next.source === PENDING_ATTACHMENT_SOURCES.CLIPBOARD_IMAGE
  ) {
    return current.dataUrl === next.dataUrl && current.size === next.size;
  }
  return current.id === next.id;
}

function resolveWorkspaceTab(tab: string | null): WorkspaceTab {
  return tabs.some((item) => item.id === tab) ? (tab as WorkspaceTab) : 'overview';
}

function normalizeCodexReasoningEffort(value?: string | null): CodexReasoningEffort {
  const effort = String(value || '').trim().toLowerCase();
  if (effort === 'low' || effort === 'high') return effort;
  return defaultCodexReasoningEffort;
}

export function WorkspacePage() {
  const params = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const projectId = Number(params.projectId);
  const { snapshot, setSnapshot, error, setError } = useSnapshot(Number.isFinite(projectId) ? projectId : null);
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
  });
  const [searchQuery, setSearchQuery] = useState('');
  const [planReadState, setPlanReadState] = useState<WorkspacePlanReadState>(() => createEmptyPlanReadState());
  const planReadRequestRef = useRef(0);

  const project = snapshot?.activeProject || null;
  const state = snapshot?.state || null;
  const projects = snapshot?.projects || [];
  const workspaceSearch = useMemo(() => searchWorkspaceSnapshot(snapshot, searchQuery), [snapshot, searchQuery]);
  const searchableItemCount = useMemo(() => (snapshot ? countSearchableItems(snapshot) : 0), [snapshot]);
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

  useEffect(() => {
    if (!state) return;
    const defaultProvider = state.agent_cli_provider || 'codex';
    const defaultReasoning = normalizeCodexReasoningEffort(state.codex_reasoning_effort);
    setLoopForm({
      workspacePath: state.workspace_path || '',
      intervalSeconds: String(state.interval_seconds || 5),
      validationCommand: state.validation_command || '',
      agentCliProvider: defaultProvider,
      agentCliCommand: state.agent_cli_command || '',
      codexReasoningEffort: defaultReasoning,
    });
  }, [state?.workspace_path, state?.interval_seconds, state?.validation_command, state?.agent_cli_provider, state?.agent_cli_command, state?.codex_reasoning_effort, state]);

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
    const nextTab = resolveWorkspaceTab(tabParam);
    setActiveTab((current) => (current === nextTab ? current : nextTab));
  }, [tabParam]);

  useEffect(() => {
    planReadRequestRef.current += 1;
    setPlanReadState(createEmptyPlanReadState());
    return () => {
      planReadRequestRef.current += 1;
    };
  }, [projectId]);

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

  const createRequirement = useCallback(
    async (body: string) => {
      if (!projectId) return false;
      try {
        const next = await window.autoplan.createRequirement({
          projectId,
          body,
          attachments: pendingAttachments.requirement,
          agentCliProvider: composerCliProviders.requirement,
          ...(composerCliProviders.requirement === 'claude'
            ? {}
            : { codexReasoningEffort: composerCodexReasoning.requirement }),
        });
        setSnapshot(next);
        setPendingAttachments((current) => ({ ...current, requirement: [] }));
        setError(null);
        return true;
      } catch (e) {
        showError(e);
        return false;
      }
    },
    [composerCliProviders.requirement, composerCodexReasoning.requirement, pendingAttachments.requirement, projectId, setSnapshot, setError, showError],
  );

  const createFeedback = useCallback(
    async (body: string) => {
      if (!projectId) return false;
      try {
        const next = await window.autoplan.createFeedback({
          projectId,
          body,
          attachments: pendingAttachments.feedback,
          agentCliProvider: composerCliProviders.feedback,
          ...(composerCliProviders.feedback === 'claude'
            ? {}
            : { codexReasoningEffort: composerCodexReasoning.feedback }),
        });
        setSnapshot(next);
        setPendingAttachments((current) => ({ ...current, feedback: [] }));
        setError(null);
        return true;
      } catch (e) {
        showError(e);
        return false;
      }
    },
    [composerCliProviders.feedback, composerCodexReasoning.feedback, pendingAttachments.feedback, projectId, setSnapshot, setError, showError],
  );

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
        setError(null);
        return true;
      } catch (e) {
        showError(e);
        return false;
      }
    },
    [projectId, setSnapshot, setError, showError],
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
        setError(null);
        return true;
      } catch (e) {
        showError(e);
        return false;
      }
    },
    [projectId, setSnapshot, setError, showError],
  );

  const submitLoopConfig = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    try {
      const next = await window.autoplan.configureLoop({
        projectId,
        workspacePath: loopForm.workspacePath,
        intervalSeconds: Number(loopForm.intervalSeconds || 5),
        validationCommand: loopForm.validationCommand,
        agentCliProvider: loopForm.agentCliProvider || 'codex',
        agentCliCommand: loopForm.agentCliCommand.trim(),
        ...(loopForm.agentCliProvider === 'claude'
          ? {}
          : { codexReasoningEffort: loopForm.codexReasoningEffort }),
      });
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

  const closePlanReader = useCallback(() => {
    planReadRequestRef.current += 1;
    setPlanReadState(createEmptyPlanReadState());
  }, []);

  const refreshPlanReader = useCallback(() => {
    if (planReadState.loading) return;
    const plan = latestReadingPlan || planReadState.plan;
    if (!plan) return;
    void readPlanForReader(plan);
  }, [latestReadingPlan, planReadState.loading, planReadState.plan, readPlanForReader]);

  const openTaskPlanReader = useCallback(
    (task: PlanTask) => {
      const plan = snapshot?.plans.find(
        (item) => item.id === task.plan_id || (!!task.file_path && item.file_path === task.file_path),
      );
      if (plan) openPlanReader(plan);
    },
    [openPlanReader, snapshot?.plans],
  );

  const switchProject = (nextId: number) => {
    if (nextId && nextId !== projectId) navigate(`/projects/${nextId}${activeTab === 'overview' ? '' : `?tab=${activeTab}`}`);
  };

  const selectTab = useCallback(
    (tab: WorkspaceTab) => {
      setActiveTab(tab);
      setSearchParams(tab === 'overview' ? {} : { tab }, { replace: true });
    },
    [setSearchParams],
  );

  if (!snapshot) {
    return (
      <div className="workspace-shell">
        <WorkspaceSidebar
          activeTab={activeTab}
          onTab={selectTab}
          onBack={() => navigate('/projects')}
          projectId={projectId}
          projects={projects}
          currentProject={project}
          state={null}
          onSwitchProject={switchProject}
        />
        <div className="workspace-main">
          <div className="empty">加载中...</div>
        </div>
      </div>
    );
  }

  return (
    <div className="workspace-shell">
      <WorkspaceSidebar
        activeTab={activeTab}
        onTab={selectTab}
        onBack={() => navigate('/projects')}
        projectId={projectId}
        projects={projects}
        currentProject={project}
        state={state}
        onSwitchProject={switchProject}
      />
      <div className="workspace-main">
        <header className="topbar">
          <div className="topbar-title">
            <h1>{tabTitle(activeTab)}</h1>
            <p>{tabSubtitle(activeTab, project)}</p>
          </div>
          <WorkspaceSearchBox
            hitCount={searchHitCount}
            onQueryChange={setSearchQuery}
            query={searchQuery}
            totalCount={searchableItemCount}
          />
          <div className="topbar-actions">
            <span className="pill">
              <span className={`led ${state?.running ? 'running' : 'stopped'}`} />
              {state ? `${state.running ? 'running' : 'stopped'} · ${state.phase || 'idle'}` : 'idle'}
            </span>
            <button
              type="button"
              className={`btn btn-sm ${state?.running ? 'btn-danger' : 'btn-primary'}`}
              onClick={() =>
                runLoopAction(() =>
                  state?.running
                    ? window.autoplan.stopLoop({ projectId, manual: true })
                    : window.autoplan.startLoop({ projectId, manual: true }),
                )
              }
            >
              <Icon name={state?.running ? 'stop' : 'run'} size={14} aria-hidden />
              {state?.running ? '停止' : '启动'}
            </button>
          </div>
        </header>

        <SearchResults
          onClear={() => setSearchQuery('')}
          onSelectGroup={selectTab}
          onSelectResult={(result) => selectTab(result.targetTab)}
          searchState={workspaceSearch}
        />

        <section className={`view ${activeTab === 'overview' ? 'active' : ''}`}>
          {error ? <div className="error-banner">{error}</div> : null}
          <OverviewView snapshot={snapshot} state={state} onGoTasks={() => selectTab('tasks')} />
        </section>

        <section className={`view ${activeTab === 'requirement' ? 'active' : ''}`}>
          {activeTab === 'requirement' ? (
            <ComposerCliSelectionProvider value={composerCliSelection}>
              <IntakePanel
                emptyText={filteredEmptyText || '暂无需求。也可以把需求文件放到工作区 docs/issues。'}
                heading="需求记录"
                items={filteredItems.requirements}
                pendingAttachments={pendingAttachments.requirement}
                placeholder="输入需求，Enter 发送，Shift+Enter 换行"
                submitLabel="发送需求"
                subtitle="循环开启后自动扫描并生成计划"
                type="requirement"
                attachments={snapshot.attachments}
                onAddFiles={addPendingFiles}
                onDelete={deleteRequirement}
                onRemoveAttachment={removePendingAttachment}
                onSubmit={createRequirement}
                onUpdate={updateRequirement}
                onInterrupt={interruptIntake}
                onResume={resumeIntake}
                onAppendTask={appendIntakeTask}
              />
            </ComposerCliSelectionProvider>
          ) : null}
        </section>

        <section className={`view ${activeTab === 'feedback' ? 'active' : ''}`}>
          {activeTab === 'feedback' ? (
            <ComposerCliSelectionProvider value={composerCliSelection}>
              <IntakePanel
                emptyText={filteredEmptyText || '暂无反馈。'}
                heading="反馈记录"
                items={filteredItems.feedback}
                pendingAttachments={pendingAttachments.feedback}
                placeholder="输入反馈，Enter 发送，Shift+Enter 换行"
                submitLabel="发送反馈"
                subtitle="循环开启后自动扫描并生成计划"
                type="feedback"
                attachments={snapshot.attachments}
                onAddFiles={addPendingFiles}
                onDelete={deleteFeedback}
                onRemoveAttachment={removePendingAttachment}
                onSubmit={createFeedback}
                onUpdate={updateFeedback}
                onInterrupt={interruptIntake}
                onResume={resumeIntake}
                onAppendTask={appendIntakeTask}
              />
            </ComposerCliSelectionProvider>
          ) : null}
        </section>

        <section className={`view ${activeTab === 'tasks' ? 'active' : ''}`}>
          {activeTab === 'tasks' ? (
            <div className="task-main">
              <div className="task-status-grid">
                <section className="card">
                  <div className="card-head">
                    <h2>Plan</h2>
                  </div>
                  <PlanList
                    emptyText={filteredEmptyText}
                    latestReadingPlan={latestReadingPlan}
                    onCloseReader={closePlanReader}
                    onOpenReader={openPlanReader}
                    onRefreshReader={refreshPlanReader}
                    plans={filteredItems.plans}
                    readerState={planReadState}
                    tasks={snapshot.tasks}
                    totalPlanCount={snapshot.plans.length}
                  />
                </section>
                <section className="card">
                  <div className="card-head">
                    <h2>任务</h2>
                  </div>
                  <TaskList
                    emptyText={filteredEmptyText}
                    tasks={displayTasks}
                    onOpenPlan={openTaskPlanReader}
                    onRun={(task) => runLoopAction(() => window.autoplan.runTask({ projectId, taskId: task.id }))}
                    onStop={(task) => runLoopAction(() => window.autoplan.stopTask({ projectId, taskId: task.id }))}
                  />
                </section>
              </div>
            </div>
          ) : null}
        </section>

        <section className={`view ${activeTab === 'settings' ? 'active' : ''}`}>
          {activeTab === 'settings' ? (
            <SettingsView
              loopForm={loopForm}
              setLoopForm={setLoopForm}
              onSubmit={submitLoopConfig}
              onToggleRun={() =>
                runLoopAction(() =>
                  state?.running
                    ? window.autoplan.stopLoop({ projectId, manual: true })
                    : window.autoplan.startLoop({ projectId, manual: true }),
                )
              }
              running={Boolean(state?.running)}
            />
          ) : null}
        </section>

        <section className={`view ${activeTab === 'events' ? 'active' : ''}`}>
          {activeTab === 'events' ? (
            <section className="card">
              <div className="card-head">
                <h2>事件流</h2>
                <span className="hint">最近 80 条 · 实时更新 · 当前 {agentCliConfigSummary(state)}</span>
              </div>
              <EventList emptyText={filteredEmptyText} events={filteredItems.events} />
            </section>
          ) : null}
        </section>
      </div>
    </div>
  );
}

function WorkspaceSidebar({
  activeTab,
  onTab,
  onBack,
  projectId,
  projects,
  currentProject,
  state,
  onSwitchProject,
}: {
  activeTab: WorkspaceTab;
  onTab: (tab: WorkspaceTab) => void;
  onBack: () => void;
  projectId: number;
  projects: Project[];
  currentProject: Project | null;
  state: ProjectState | null;
  onSwitchProject: (id: number) => void;
}) {
  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark">A</div>
        <div>
          <div className="brand-name">AutoPlan</div>
          <div className="brand-sub">需求 · 计划 · 执行 · 验收</div>
        </div>
      </div>

      <button type="button" className="back-link" onClick={onBack}>
        <Icon name="back" size={16} aria-hidden />
        返回项目列表
      </button>

      <div className="project-switcher">
        <div className="project-label">当前项目</div>
        <select
          className="project-select"
          value={projectId}
          onChange={(event) => onSwitchProject(Number(event.target.value))}
        >
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
        {currentProject ? <div className="project-path mono">{currentProject.workspace_path || '未设置工作区'}</div> : null}
      </div>

      <div className="nav-group-label">工作区</div>
      {tabs.map((tab) => (
        <button
          className={`nav-item ${activeTab === tab.id ? 'active' : ''}`}
          key={tab.id}
          type="button"
          onClick={() => onTab(tab.id)}
        >
          <span className="nav-ico">
            <Icon name={tab.icon} size={18} aria-hidden="true" />
          </span>
          <span>{tab.label}</span>
        </button>
      ))}

      <div className="sidebar-footer">
        <div className="loop-mini">
          <span className={`led ${state?.running ? 'running' : 'stopped'}`} />
          <span>
            循环 <b>{state?.running ? '运行中' : '已停止'}</b>
          </span>
        </div>
        <div className="loop-config mono">
          {agentCliConfigSummary(state)}
          {' · '}间隔 {state?.interval_seconds || 5}s
          {state?.validation_command ? ` · ${state.validation_command}` : ' · 无验收命令'}
        </div>
      </div>
    </aside>
  );
}

function WorkspaceSearchBox({
  hitCount,
  onQueryChange,
  query,
  totalCount,
}: {
  hitCount: number;
  onQueryChange: (query: string) => void;
  query: string;
  totalCount: number;
}) {
  const hasQuery = Boolean(normalizeSearchQuery(query));
  const resultLabel = hasQuery ? `命中 ${hitCount} 条` : `可搜索 ${totalCount} 条`;

  return (
    <div className="workspace-search" role="search" aria-label="工作区搜索">
      <div className="workspace-search-field">
        <Icon name="search" size={16} className="workspace-search-icon" aria-hidden="true" />
        <input
          aria-label="搜索当前工作区"
          className="workspace-search-input search-input"
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && query) {
              event.preventDefault();
              onQueryChange('');
            }
          }}
          placeholder="搜索需求、反馈、任务、Plan 或事件"
          value={query}
        />
        {query ? (
          <button
            type="button"
            className="workspace-search-clear"
            onClick={() => onQueryChange('')}
            aria-label="清空工作区搜索关键字"
          >
            <Icon name="close" size={15} aria-hidden="true" />
          </button>
        ) : null}
      </div>
      <span className={`workspace-search-count${hasQuery && hitCount === 0 ? ' is-empty' : ''}`} aria-live="polite">
        {resultLabel}
      </span>
    </div>
  );
}

function normalizeSearchQuery(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function countSearchableItems(snapshot: AppSnapshot) {
  return (
    snapshot.requirements.length +
    snapshot.feedback.length +
    snapshot.plans.length +
    snapshot.tasks.length +
    snapshot.events.length
  );
}

function createFilteredWorkspaceItems(
  snapshot: AppSnapshot | null | undefined,
  searchState: WorkspaceSearchState,
): WorkspaceFilterableItems {
  if (!snapshot) {
    return { requirements: [], feedback: [], plans: [], tasks: [], events: [] };
  }
  if (searchState.query.isEmpty) {
    return {
      requirements: snapshot.requirements,
      feedback: snapshot.feedback,
      plans: snapshot.plans,
      tasks: snapshot.tasks,
      events: snapshot.events,
    };
  }

  return {
    requirements: filterItemsBySearchGroup(
      snapshot.requirements,
      searchState.groups,
      WORKSPACE_SEARCH_SOURCE_TYPES.REQUIREMENT,
    ),
    feedback: filterItemsBySearchGroup(snapshot.feedback, searchState.groups, WORKSPACE_SEARCH_SOURCE_TYPES.FEEDBACK),
    plans: filterItemsBySearchGroup(snapshot.plans, searchState.groups, WORKSPACE_SEARCH_SOURCE_TYPES.PLAN),
    tasks: filterItemsBySearchGroup(snapshot.tasks, searchState.groups, WORKSPACE_SEARCH_SOURCE_TYPES.TASK),
    events: filterItemsBySearchGroup(snapshot.events, searchState.groups, WORKSPACE_SEARCH_SOURCE_TYPES.EVENT),
  };
}

function filterItemsBySearchGroup<T extends { id: number }>(
  items: T[],
  groups: WorkspaceSearchGroup[],
  source: WorkspaceSearchSourceType,
) {
  const group = groups.find((item) => item.source === source);
  if (!group?.results.length) return [];

  const recordIds = new Set(group.results.map((result) => result.recordId));
  return items.filter((item) => recordIds.has(item.id));
}

function withTaskCliProviderTitle(task: PlanTask, fallbackProvider?: string | null): PlanTask {
  const providerLabel = agentCliProviderLabel(task.agentCliProvider || fallbackProvider);
  if (!providerLabel || task.title.startsWith(`[${providerLabel}] `)) return task;
  return { ...task, title: `[${providerLabel}] ${task.title}` };
}

function agentCliConfigSummary(state?: ProjectState | null) {
  const provider = state?.agent_cli_provider || 'codex';
  const providerLabel = agentCliProviderLabel(provider);
  if (provider === 'claude') return providerLabel;
  return `${providerLabel} · 思考${codexReasoningEffortLabel(state?.codex_reasoning_effort)}`;
}

function SettingsView({
  loopForm,
  setLoopForm,
  onSubmit,
  onToggleRun,
  running,
}: {
  loopForm: LoopFormState;
  setLoopForm: Dispatch<SetStateAction<LoopFormState>>;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onToggleRun: () => void;
  running: boolean;
}) {
  const isCodexProvider = loopForm.agentCliProvider !== 'claude';

  return (
    <div className="settings-layout">
      <form className="editor card settings-card" onSubmit={onSubmit}>
        <div className="card-head">
          <h2>循环控制</h2>
          <span className="hint">工作区路径、循环间隔、验收命令与 CLI 后端</span>
        </div>
        <label className="field">
          工作区路径
          <input
            value={loopForm.workspacePath}
            onChange={(event) => setLoopForm((current) => ({ ...current, workspacePath: event.target.value }))}
            placeholder="D:\project\GitHub\my-app"
          />
        </label>
        <label className="field">
          间隔秒数
          <input
            min="1"
            type="number"
            value={loopForm.intervalSeconds}
            onChange={(event) => setLoopForm((current) => ({ ...current, intervalSeconds: event.target.value }))}
          />
        </label>
        <label className="field">
          验收命令（留空则不校验）
          <input
            value={loopForm.validationCommand}
            onChange={(event) => setLoopForm((current) => ({ ...current, validationCommand: event.target.value }))}
            placeholder="留空则跳过外部验收命令"
          />
        </label>
        <label className="field">
          CLI 后端
          <select
            value={loopForm.agentCliProvider}
            onChange={(event) => setLoopForm((current) => ({ ...current, agentCliProvider: event.target.value }))}
          >
            <option value="codex">Codex CLI</option>
            <option value="claude">Claude CLI</option>
          </select>
          {loopForm.agentCliProvider === 'claude' ? (
            <small className="field-hint">需本机已安装 claude CLI 并完成认证</small>
          ) : null}
        </label>
        {isCodexProvider ? (
          <label className="field">
            Codex 思考深度
            <select
              value={loopForm.codexReasoningEffort}
              onChange={(event) =>
                setLoopForm((current) => ({
                  ...current,
                  codexReasoningEffort: normalizeCodexReasoningEffort(event.target.value),
                }))
              }
            >
              {codexReasoningOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <small className="field-hint">仅 Codex CLI 生效，保存后执行参数会使用该深度</small>
          </label>
        ) : (
          <div className="field readonly-field">
            Codex 思考深度
            <span>Claude CLI 不使用该配置</span>
          </div>
        )}
        <label className="field">
          CLI 命令路径（留空用默认）
          <input
            className="mono"
            value={loopForm.agentCliCommand}
            onChange={(event) => setLoopForm((current) => ({ ...current, agentCliCommand: event.target.value }))}
            placeholder={loopForm.agentCliProvider === 'claude' ? 'claude' : 'codex'}
          />
        </label>
        <div className="button-row">
          <button type="submit">保存配置</button>
          <button type="button" onClick={onToggleRun}>
            {running ? '停止' : '启动'}
          </button>
        </div>
      </form>
    </div>
  );
}

function OverviewView({
  snapshot,
  state,
  onGoTasks,
}: {
  snapshot: AppSnapshot;
  state: ProjectState | null;
  onGoTasks: () => void;
}) {
  const reqCount = snapshot.requirements.length;
  const planCount = snapshot.plans.length;
  const runningPlan = snapshot.plans.find((plan) => !['completed'].includes(plan.status));
  const doneTasks = snapshot.tasks.filter((task) => task.status === 'completed').length;
  const totalTasks = snapshot.tasks.length;

  const phases = ['scan', 'generate-plan', 'execute-task', 'validate', 'completed'];
  const currentPhase = state?.phase || 'idle';
  const activeIndex = phases.indexOf(currentPhase);
  const operation = snapshot.activeOperation || snapshot.lastOperation;
  const operationActive = Boolean(snapshot.activeOperation);
  const operationProvider = operation?.agentCliProvider || state?.agent_cli_provider;
  const operationProviderLabel = agentCliProviderLabel(operationProvider);
  const operationReasoningLabel = operationProvider !== 'claude'
    ? `思考${codexReasoningEffortLabel(operation?.codexReasoningEffort || state?.codex_reasoning_effort)}`
    : '';
  const operationSessionLabel = operationProviderLabel === 'Codex' ? operation?.codexSessionLabel : '';
  const operationTime = operation?.startedAt ? `开始于 ${formatChinaTime(operation.startedAt)}` : '';
  const operationExit =
    operation && !operationActive && typeof operation.exitCode === 'number'
      ? `退出码 ${operation.exitCode}${operation.exitCode === 0 ? '（成功）' : '（失败）'}`
      : '';
  const operationHint = operation
    ? [operationProviderLabel, operationReasoningLabel, operationTime, operationSessionLabel, operationExit].filter(Boolean).join(' · ')
    : '等待下一次执行';
  const operationTitle = operation
    ? `${operationActive ? '执行日志' : '最近执行'} · ${operationProviderLabel} · ${operation.label}`
    : `执行日志 · ${operationProviderLabel}`;

  return (
    <>
      <div className="stat-grid">
        <StatCard icon="requirement" value={String(reqCount)} label="需求" accent="brand" />
        <StatCard
          icon="plan"
          value={String(planCount)}
          label="计划"
          sub={runningPlan ? `${runningPlan.completed_tasks}/${runningPlan.total_tasks} 任务` : '无进行中'}
          accent="info"
        />
        <StatCard icon="tasks" value={`${doneTasks}/${totalTasks}`} label="任务进度" accent="success" />
        <StatCard
          icon="settings"
          value={agentCliProviderLabel(state?.agent_cli_provider)}
          label="CLI 后端"
          sub={state?.agent_cli_provider === 'claude' ? `间隔 ${state?.interval_seconds || 5}s` : `思考${codexReasoningEffortLabel(state?.codex_reasoning_effort)} · 间隔 ${state?.interval_seconds || 5}s`}
          accent="warning"
        />
      </div>

      <div className="overview-grid">
        <div className="overview-main-column">
          <section className="card live-log-card">
            <div className="card-head log-card-head">
              <div className="log-title-line">
                <h2>
                  <span className={`live-dot${operationActive ? '' : ' idle'}`} /> {operationTitle}
                </h2>
                <span className="hint">{operationHint}</span>
                <span className={`log-phase-chip ${state?.running ? 'running' : 'stopped'}`}>
                  {state?.running ? '循环运行中' : '循环已停止'} · {operationProviderLabel} · {currentPhase}
                </span>
              </div>
              <div className="log-summary">
                <span>
                  需求 <b>{snapshot.requirements.length}</b>
                </span>
                <span>
                  反馈 <b>{snapshot.feedback.length}</b>
                </span>
                <span>
                  Plan <b>{snapshot.plans.length}</b>
                </span>
              </div>
            </div>
            <CodexLog
              log={operation?.logTail || ''}
              activity={operation?.activity || []}
              context={operation || null}
              provider={operationProvider}
            />
          </section>
        </div>

        <div className="overview-side-column">
          <section className="card">
            <div className="card-head">
              <h2>循环阶段流水线</h2>
            </div>
            <div className="card-body">
              <div className="pipeline">
                {phases.map((phase, index) => {
                  const done = activeIndex > index;
                  const active = activeIndex === index;
                  return (
                    <div className={`pipe-step ${done ? 'done' : ''} ${active ? 'active' : ''}`} key={phase}>
                      <div className="pipe-node">
                        {done ? (
                          <Icon name="complete" size={18} className="pipe-status-icon" aria-hidden="true" />
                        ) : active ? (
                          <Icon name="run" size={18} className="pipe-status-icon" aria-hidden="true" />
                        ) : (
                          index + 1
                        )}
                      </div>
                      <div className="pipe-label">{phaseLabel(phase)}</div>
                    </div>
                  );
                })}
              </div>
            </div>
          </section>

          <section className="card">
            <div className="card-head">
              <h2>近期事件</h2>
              <span className="spacer">
                <button type="button" className="btn-link" onClick={onGoTasks}>
                  查看任务
                  <Icon name="enter" size={14} aria-hidden />
                </button>
              </span>
            </div>
            <div className="card-body">
              <EventList events={snapshot.events.slice(0, 8)} />
            </div>
          </section>
        </div>
      </div>
    </>
  );
}

function StatCard({
  icon,
  value,
  label,
  sub,
  accent,
}: {
  icon: IconName;
  value: string;
  label: string;
  sub?: string;
  accent: 'brand' | 'info' | 'success' | 'warning';
}) {
  return (
    <div className={`stat stat-${accent}`}>
      <div className="stat-ico">
        <Icon name={icon} size={20} aria-hidden="true" />
      </div>
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
      {sub ? <div className="stat-delta">{sub}</div> : null}
    </div>
  );
}

function tabTitle(tab: WorkspaceTab) {
  return { overview: '概览', requirement: '需求模块', feedback: '反馈模块', tasks: '任务与计划', events: '事件流', settings: '设置' }[tab];
}

function tabSubtitle(tab: WorkspaceTab, project: Project | null) {
  const base = {
    overview: '循环状态、阶段流水线与各模块一览',
    requirement: '收集需求，发送后由循环自动生成开发计划',
    feedback: '收集反馈，关联需求并由循环生成开发计划',
    tasks: 'Plan 与任务进度',
    events: '循环运行日志与任务执行记录',
    settings: '工作区路径、循环间隔、验收命令与 CLI 后端',
  }[tab];
  return project ? `${base} · ${project.name}` : base;
}

function phaseLabel(phase: string) {
  return (
    {
      idle: '空闲',
      scan: '扫描',
      'generate-plan': '生成计划',
      'execute-task': '执行任务',
      validate: '验收',
      completed: '完成',
      waiting: '等待',
      error: '异常',
    }[phase] || phase
  );
}
