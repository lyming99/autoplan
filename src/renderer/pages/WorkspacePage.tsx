import { useCallback, useEffect, useRef, useState, useDeferredValue, type CSSProperties } from 'react';
import type { ComponentProps, ComponentType } from 'react';
import { isTaskAssociatedWithPlan, readPlanTaskAssociationFilePath } from '../types';
import type {
  AgentCliOption,
  AppSnapshot,
  ChatIntakeOpenRef,
  IntakeAcceptanceHandler,
  IntakeType,
  Plan,
  Project,
  RetryIntakePlanGenerationOptions,
  Script,
  TerminalEvent,
  TerminalSession,
  WorkspaceChatState,
  WorkspacePlanSelectionState,
  WorkspaceSearchResult,
  WorkspaceTab,
} from '../types';
import { useChat } from '../hooks/useChat';
import { useSidebarResize } from '../hooks/useSidebarResize';
import { useWorkspaceController } from '../hooks/useWorkspaceController';
import { useAutoplanClient } from '../lib/api/provider';
import { ComposerCliSelectionProvider, type ComposerSubmitPayload } from '../components/Composer';
import { IntakePanel } from '../components/IntakePanel';
import { EventList, PlanList, TaskList } from '../components/PlanLists';
import { SearchResults, type SearchResultsAnchorRect } from '../components/SearchResults';
import { Icon } from '../components/icons';
import { PlanReaderModal } from '../components/plans/PlanReaderModal';
import { UpdateNotice } from '../components/UpdateNotice';
import { AcceptanceView } from '../components/workspace/AcceptanceView';
import { WorkspaceOverviewView } from '../components/workspace/WorkspaceOverviewView';
import { ChatView } from '../components/workspace/ChatView';
import { WorkspaceExecutorsView } from '../components/workspace/WorkspaceExecutorsView';
import { WorkspaceScriptsView } from '../components/workspace/WorkspaceScriptsView';
import { WorkspaceSearchBox } from '../components/workspace/WorkspaceSearchBox';
import { WorkspaceSettingsView } from '../components/workspace/WorkspaceSettingsView';
import { WorkspaceSidebar, agentCliConfigSummary } from '../components/workspace/WorkspaceSidebar';
import { WorkspaceTerminalView } from '../components/workspace/WorkspaceTerminalView';
import { buildIntakeAnchorId } from '../utils/chatIntents';
import { locateWorkspaceAnchor } from '../utils/workspaceLocate';

type WorkspaceSidebarWithChatProps = ComponentProps<typeof WorkspaceSidebar> & {
  chatState: WorkspaceChatState;
};

const WorkspaceSidebarWithChat = WorkspaceSidebar as ComponentType<WorkspaceSidebarWithChatProps>;

type WorkspaceIntakePanelProps = ComponentProps<typeof IntakePanel> & {
  onAcceptIntake: IntakeAcceptanceHandler;
  onUnacceptIntake: IntakeAcceptanceHandler;
  onRetryGeneratePlan: (
    type: IntakeType,
    id: number,
    options?: RetryIntakePlanGenerationOptions,
  ) => Promise<void> | void;
  retryAgentCliOptions: AgentCliOption[];
  retryCodexReasoningOptions: AgentCliOption[];
};

const WorkspaceIntakePanel = IntakePanel as ComponentType<WorkspaceIntakePanelProps>;

type WorkspacePlanListProps = ComponentProps<typeof PlanList> & {
  onStopPlan: (plan: Plan) => Promise<void> | void;
  onDeletePlan: (plan: Plan) => Promise<void> | void;
};

const WorkspacePlanList = PlanList as ComponentType<WorkspacePlanListProps>;

type WorkspaceTaskListProps = ComponentProps<typeof TaskList> & {
  onOpenScopeFile?: (filePath: string) => void;
};

const WorkspaceTaskList = TaskList as ComponentType<WorkspaceTaskListProps>;

type PendingIntakeTarget = { tab: WorkspaceTab; id: number; anchorId: string };

export function WorkspacePage() {
  const client = useAutoplanClient();
  const {
    acceptIntake,
    acceptItem,
    acceptItems,
    acceptanceGroups,
    acceptedGroups,
    activeTab,
    addPendingFiles,
    appendIntakeTask,
    appendPlanTask,
    closePlanReader,
    recreatePlanFromIntake,
    reExecutePlan,
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
    projectId,
    projects,
    recentAccepted,
    refreshPlanReader,
    removePendingAttachment,
    resumeIntake,
    resumePlan,
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
    stopPlan,
    submitLoopConfig,
    switchProject,
    updatePlanExecutionConfig,
    unacceptIntake,
    unacceptItem,
    unacceptItems,
    updateComposerDraft,
    updateFeedback,
    updateLoopForm,
    updateRequirement,
    workspaceSearch,
  } = useWorkspaceController();
  const chatState = useChat(projectId);
  const sidebarResize = useSidebarResize();
  const [searchPopupOpen, setSearchPopupOpen] = useState(false);
  const [pendingSearchTarget, setPendingSearchTarget] = useState<WorkspaceSearchResult | null>(null);
  const [searchLocateNotice, setSearchLocateNotice] = useState('');
  // 「打开需求/反馈」待定位锚点（沿用搜索定位的 120ms 延时模式）
  const [pendingIntakeTarget, setPendingIntakeTarget] = useState<PendingIntakeTarget | null>(null);
  const [selectedPlanId, setSelectedPlanId] = useState<number | null>(null);
  const searchPopupRef = useRef<HTMLDivElement>(null);
  const terminalProjectIdRef = useRef(projectId);
  const terminalRequestRef = useRef(0);
  const closedTerminalSessionKeysRef = useRef(new Set<string>());
  terminalProjectIdRef.current = projectId;
  // 锚点视口坐标，供 SearchResults 的 Portal(fixed) 弹层定位使用。
  const [searchPopupRect, setSearchPopupRect] = useState<SearchResultsAnchorRect | null>(null);
  const [terminalSessions, setTerminalSessions] = useState<TerminalSession[]>([]);
  const [terminalListLoaded, setTerminalListLoaded] = useState(false);
  // 延迟快照：让 React 在计算新 UI 时继续响应用户滚动/输入
  const deferredSnapshot = useDeferredValue(snapshot);
  const hasSearchQuery = !workspaceSearch.query.isEmpty;
  const activeSnapshot = isWorkspaceSnapshotForProject(deferredSnapshot, projectId) ? deferredSnapshot : null;
  const routeProject = projects.find((item) => Number(item.id) === Number(projectId)) || null;
  const sidebarProject = activeSnapshot?.activeProject || routeProject;
  const selectedPlan = activeSnapshot?.plans.find((plan) => plan.id === selectedPlanId && plan.project_id === projectId) || null;

  const refreshTerminalSessions = useCallback(async () => {
    const requestId = terminalRequestRef.current + 1;
    terminalRequestRef.current = requestId;
    const requestProjectId = projectId;
    if (!Number.isInteger(projectId) || projectId <= 0) {
      if (terminalProjectIdRef.current === requestProjectId) {
        setTerminalSessions([]);
        setTerminalListLoaded(true);
      }
      return;
    }
    try {
      const result = await client.listTerminals({ projectId });
      if (terminalRequestRef.current === requestId && terminalProjectIdRef.current === requestProjectId) {
        if (result.ok) {
          rememberClosedTerminalSessions(result.sessions, requestProjectId, closedTerminalSessionKeysRef.current);
          setTerminalSessions(normalizeTerminalSessions(
            result.sessions,
            requestProjectId,
            closedTerminalSessionKeysRef.current,
          ));
        } else {
          setTerminalSessions([]);
        }
      }
    } catch {
      if (terminalRequestRef.current === requestId && terminalProjectIdRef.current === requestProjectId) setTerminalSessions([]);
    } finally {
      if (terminalRequestRef.current === requestId && terminalProjectIdRef.current === requestProjectId) setTerminalListLoaded(true);
    }
  }, [client, projectId]);

  const planSelectionState: WorkspacePlanSelectionState = {
    selectedPlanId,
    selectedPlan,
    selectPlan: (plan) => setSelectedPlanId((current) => (current === plan.id ? null : plan.id)),
    clearSelection: () => setSelectedPlanId(null),
  };
  const selectedPlanAllTasks = selectedPlan
    ? activeSnapshot?.tasks.filter((task) => isTaskAssociatedWithPlan(task, selectedPlan)) || []
    : [];
  const taskListTasks = selectedPlan
    ? displayTasks.filter((task) => isTaskAssociatedWithPlan(task, selectedPlan))
    : displayTasks;
  const selectedPlanTaskFilter = selectedPlan
    ? {
        totalTaskCount: selectedPlanAllTasks.length,
      }
    : null;
  const workspaceShellStyle = {
    '--workspace-sidebar-width': `${sidebarResize.width}px`,
  } as CSSProperties;

  useEffect(() => {
    setSearchPopupOpen(hasSearchQuery);
  }, [hasSearchQuery, workspaceSearch.query.normalized]);

  useEffect(() => {
    setSelectedPlanId((current) => {
      if (current === null) return current;
      if (!activeSnapshot) return null;
      return activeSnapshot.plans.some((plan) => plan.id === current && plan.project_id === projectId) ? current : null;
    });
  }, [activeSnapshot, projectId]);

  useEffect(() => {
    setTerminalSessions([]);
    setTerminalListLoaded(false);
    void refreshTerminalSessions();
    return () => {
      terminalRequestRef.current += 1;
    };
  }, [refreshTerminalSessions]);

  useEffect(() => {
    let active = true;
    const applyTerminalEvent = (event: TerminalEvent) => {
      if (!active) return;
      if (!terminalEventBelongsToProject(event, projectId)) return;
      const sessionId = terminalEventSessionId(event);
      if (terminalEventClosed(event, projectId, closedTerminalSessionKeysRef.current)) {
        rememberClosedTerminalSession(
          sessionId,
          terminalEventProjectId(event) ?? projectId,
          closedTerminalSessionKeysRef.current,
        );
        setTerminalListLoaded(true);
        setTerminalSessions((current) => removeTerminalSession(
          current,
          sessionId,
          projectId,
          closedTerminalSessionKeysRef.current,
        ));
        return;
      }
      if (!event.session) return;
      setTerminalListLoaded(true);
      setTerminalSessions((current) => upsertTerminalSession(
        current,
        event.session,
        projectId,
        closedTerminalSessionKeysRef.current,
      ));
    };
    const unsubscribeStatus = client.onTerminalStatus(applyTerminalEvent);
    const unsubscribeExit = client.onTerminalExit(applyTerminalEvent);
    const unsubscribeClosed = client.onTerminalClosed(applyTerminalEvent);
    return () => {
      active = false;
      unsubscribeStatus();
      unsubscribeExit();
      unsubscribeClosed();
    };
  }, [client, projectId]);

  // Portal 弹层定位：弹层打开时读取锚点（.workspace-search-popover-anchor）视口坐标，
  // 并在滚动 / 缩放时刷新，保证 fixed 弹层始终紧贴搜索框定位。
  useEffect(() => {
    if (!searchPopupOpen) return undefined;
    let rafId = 0;
    let pending = false;
    function updatePopupRect() {
      pending = false;
      const node = searchPopupRef.current;
      if (!node) return;
      const rect = node.getBoundingClientRect();
      setSearchPopupRect({
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        left: rect.left,
        width: rect.width,
        height: rect.height,
      });
    }
    function scheduleUpdate() {
      if (pending) return;
      pending = true;
      rafId = window.requestAnimationFrame(updatePopupRect);
    }
    updatePopupRect();
    // 用 rAF 节流 + passive 避免滚动时强制同步布局
    window.addEventListener('scroll', scheduleUpdate, { passive: true, capture: true });
    window.addEventListener('resize', scheduleUpdate, { passive: true });
    return () => {
      window.removeEventListener('scroll', scheduleUpdate, { passive: true, capture: true } as AddEventListenerOptions);
      window.removeEventListener('resize', scheduleUpdate, { passive: true } as AddEventListenerOptions);
      if (rafId) window.cancelAnimationFrame(rafId);
    };
  }, [searchPopupOpen]);

  useEffect(() => {
    if (!searchPopupOpen) return undefined;

    function handlePointerDown(event: MouseEvent) {
      if (!(event.target instanceof Node)) return;
      const anchor = searchPopupRef.current;
      const insideAnchor = anchor ? anchor.contains(event.target) : false;
      // Portal 化后弹层已脱离锚点子树，点击弹层内部需额外排除，避免被误判为外部点击而提前关闭。
      const insidePopup =
        event.target instanceof Element && event.target.closest('.search-results-popup') !== null;
      if (!insideAnchor && !insidePopup) {
        setSearchPopupOpen(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setSearchPopupOpen(false);
      }
    }

    document.addEventListener('mousedown', handlePointerDown, true);
    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown, true);
      document.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [searchPopupOpen]);

  useEffect(() => {
    if (!pendingSearchTarget || activeTab !== pendingSearchTarget.targetTab) return undefined;

    const timer = window.setTimeout(() => {
      const located = locateWorkspaceSearchResult(pendingSearchTarget);
      setPendingSearchTarget(null);
      setSearchLocateNotice(located ? '' : formatSearchLocateFallback(pendingSearchTarget));
    }, 120);

    return () => window.clearTimeout(timer);
  }, [activeTab, pendingSearchTarget]);

  // 「打开需求/反馈」：切 tab 后延时定位锚点 + 高亮（沿用搜索定位模式）
  useEffect(() => {
    if (!pendingIntakeTarget || activeTab !== pendingIntakeTarget.tab) return undefined;

    const timer = window.setTimeout(() => {
      const located = locateWorkspaceAnchor(pendingIntakeTarget.anchorId);
      setPendingIntakeTarget(null);
      setSearchLocateNotice(located ? '' : '已在对应模块打开，但未找到该条目（可能已被删除或不在当前项目）。');
    }, 120);

    return () => window.clearTimeout(timer);
  }, [activeTab, pendingIntakeTarget]);

  function handleOpenIntake(ref: ChatIntakeOpenRef) {
    const { type, projectId: targetProjectId, id } = ref;
    setPendingIntakeTarget({ tab: type, id, anchorId: buildIntakeAnchorId(type, id) });
    // activeTab 不随 URL tab 自动同步，需显式 selectTab；跨项目再 navigate 切换路由
    selectTab(type);
    if (Number(targetProjectId) !== Number(projectId)) {
      navigate(`/projects/${targetProjectId}?tab=${type}`);
    }
  }

  function handleSearchQueryChange(nextQuery: string) {
    setSearchQuery(nextQuery);
    if (nextQuery.trim()) return;

    setPendingSearchTarget(null);
    setSearchLocateNotice('');
    setSearchPopupOpen(false);
  }

  function handleSelectSearchResult(result: WorkspaceSearchResult) {
    const resultPlan = findPlanForSearchResult(result, activeSnapshot?.plans || []);
    if (result.targetTab === 'tasks') {
      setSelectedPlanId((current) => (resultPlan ? resultPlan.id : result.targetType === 'task' ? null : current));
    }
    setSearchLocateNotice('');
    setPendingSearchTarget(result);
    selectSearchResult(result);
  }

  const createRequirementFromComposer = (payload: string | ComposerSubmitPayload) =>
    createRequirement(payload as unknown as string);
  const createFeedbackFromComposer = (payload: string | ComposerSubmitPayload) =>
    createFeedback(payload as unknown as string);
  if (!activeSnapshot) {
    return (
      <div
        className={`workspace-shell${sidebarResize.resizing ? ' is-sidebar-resizing' : ''}`}
        style={workspaceShellStyle}
      >
        <WorkspaceSidebarWithChat
          activeTab={activeTab}
          onTab={selectTab}
          onBack={() => navigate('/projects')}
          projectId={projectId}
          projects={projects}
          currentProject={sidebarProject}
          state={null}
          terminalCount={0}
          executorCount={0}
          scriptCount={0}
          onSwitchProject={switchProject}
          chatState={chatState}
          resizing={sidebarResize.resizing}
          onResizePointerDown={sidebarResize.onPointerDown}
          onResizeReset={sidebarResize.onReset}
        />
        <div className="workspace-main">
          <div className="empty">加载中...</div>
        </div>
      </div>
    );
  }

  const intakePlanPreviewProps: Pick<ComponentProps<typeof IntakePanel>, 'plans' | 'onPreviewPlan'> = {
    plans: activeSnapshot.plans,
    onPreviewPlan: openIntakePlanReader,
  };
  const planListReaderState = planReadState.plan ? { ...planReadState, plan: null } : planReadState;

  // 脚本模块：列表启用开关即时落库；详情弹窗（P005）由视图自管打开/新建态。
  // 运行/保存/删除后经 onSync 回灌最新 snapshot，使列表卡片状态与导航徽标数量同步刷新。
  const toggleScript = (script: Script) => {
    runLoopAction(() => client.toggleScript({ projectId, scriptId: script.id }));
  };
  // 卡片「启动执行」按钮：按 last_status 决定运行/停止，成功后经 runLoopAction 回灌快照刷新卡片。
  // 运行与启停正交——禁用脚本仍可手动运行（沿用弹窗「运行」语义）。
  const runScript = (script: Script) => {
    const running = (script.last_status ?? script.lastStatus) === 'running';
    runLoopAction(async () => {
      if (running) {
        return client.stopScript({ projectId, scriptId: script.id });
      }
      const result = await client.runScript({ projectId, scriptId: script.id });
      return result.snapshot;
    });
  };
  const syncScripts = (next: AppSnapshot) => {
    runLoopAction(async () => next);
  };
  const syncExecutors = (next: AppSnapshot) => {
    runLoopAction(async () => next);
  };
  const currentTerminalSessions = normalizeTerminalSessions(
    terminalListLoaded ? terminalSessions : (activeSnapshot.terminals || terminalSessions),
    projectId,
    closedTerminalSessionKeysRef.current,
  );
  const activeTerminalCount = currentTerminalSessions.filter(isTerminalActive).length;
  const workspacePath = activeSnapshot.activeProject?.workspace_path || routeProject?.workspace_path || '';

  return (
    <div
      className={`workspace-shell${sidebarResize.resizing ? ' is-sidebar-resizing' : ''}`}
      style={workspaceShellStyle}
    >
      <WorkspaceSidebarWithChat
        activeTab={activeTab}
        onTab={selectTab}
        onBack={() => navigate('/projects')}
        projectId={projectId}
        projects={projects}
        currentProject={sidebarProject}
        state={state}
        terminalCount={activeTerminalCount}
        executorCount={(activeSnapshot.executors || []).length}
        scriptCount={activeSnapshot.scripts.length}
        onSwitchProject={switchProject}
        chatState={chatState}
        resizing={sidebarResize.resizing}
        onResizePointerDown={sidebarResize.onPointerDown}
        onResizeReset={sidebarResize.onReset}
      />
      <div className="workspace-main">
        <header className="topbar">
          <div className="topbar-title">
            <h1>{tabTitle(activeTab)}</h1>
            <p>{tabSubtitle(activeTab, sidebarProject)}</p>
          </div>
          <div className="workspace-search-popover-anchor" ref={searchPopupRef}>
            <WorkspaceSearchBox
              hitCount={searchHitCount}
              onQueryChange={handleSearchQueryChange}
              query={searchQuery}
            />
            <SearchResults
              anchorRect={searchPopupRect}
              onClear={() => handleSearchQueryChange('')}
              onClose={() => setSearchPopupOpen(false)}
              onSelectGroup={selectTab}
              onSelectResult={handleSelectSearchResult}
              open={searchPopupOpen}
              searchState={workspaceSearch}
            />
          </div>
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
                    ? client.stopLoop({ projectId, manual: true })
                    : client.startLoop({ projectId, manual: true }),
                )
              }
            >
              <Icon name={state?.running ? 'stop' : 'run'} size={14} aria-hidden />
              {state?.running ? '停止' : '启动'}
            </button>
          </div>
        </header>

        <UpdateNotice />

        {searchLocateNotice ? (
          <div className="search-locate-notice" role="status">
            <span>{searchLocateNotice}</span>
            <button type="button" className="btn-link" onClick={() => setSearchLocateNotice('')}>关闭</button>
          </div>
        ) : null}

        <section className={`view ${activeTab === 'overview' ? 'active' : ''}`}>
          {activeTab === 'overview' ? (
            <>
              {error ? <div className="error-banner">{error}</div> : null}
              <WorkspaceOverviewView snapshot={activeSnapshot} state={state} onGoTasks={() => selectTab('tasks')} />
            </>
          ) : null}
        </section>

        <section className={`view ${activeTab === 'requirement' ? 'active' : ''}`}>
          {activeTab === 'requirement' ? (
            <ComposerCliSelectionProvider value={composerCliSelection}>
              <WorkspaceIntakePanel
                emptyText={filteredEmptyText || '暂无需求。也可以把需求文件放到工作区 docs/issues。'}
                heading="需求记录"
                items={filteredItems.requirements}
                locateItemId={intakeLocateItemId('requirement', pendingSearchTarget, pendingIntakeTarget)}
                mentionCandidates={intakeMentionCandidates}
                pendingAttachments={pendingAttachments.requirement}
                placeholder="输入需求，Enter 发送，Shift+Enter 换行"
                submitLabel="发送需求"
                subtitle="循环开启后自动扫描并生成计划"
                type="requirement"
                {...intakePlanPreviewProps}
                attachments={activeSnapshot.attachments}
                onAddFiles={addPendingFiles}
                onDelete={deleteRequirement}
                onRemoveAttachment={removePendingAttachment}
                onSubmit={createRequirementFromComposer}
                onUpdate={updateRequirement}
                onInterrupt={interruptIntake}
                onResume={resumeIntake}
                onAppendTask={appendIntakeTask}
                onRetryGeneratePlan={retryIntakePlanGeneration}
                onAcceptIntake={acceptIntake}
                onUnacceptIntake={unacceptIntake}
                retryAgentCliOptions={composerCliSelection.options}
                retryCodexReasoningOptions={composerCliSelection.reasoningOptions}
                composerIdentityKey={`project:${projectId}:requirement`}
                draftValue={composerDrafts.requirement}
                onDraftChange={(next) => updateComposerDraft('requirement', next)}
              />
            </ComposerCliSelectionProvider>
          ) : null}
        </section>

        <section className={`view ${activeTab === 'feedback' ? 'active' : ''}`}>
          {activeTab === 'feedback' ? (
            <ComposerCliSelectionProvider value={composerCliSelection}>
              <WorkspaceIntakePanel
                emptyText={filteredEmptyText || '暂无反馈。'}
                heading="反馈记录"
                items={filteredItems.feedback}
                locateItemId={intakeLocateItemId('feedback', pendingSearchTarget, pendingIntakeTarget)}
                mentionCandidates={intakeMentionCandidates}
                pendingAttachments={pendingAttachments.feedback}
                placeholder="输入反馈，Enter 发送，Shift+Enter 换行"
                submitLabel="发送反馈"
                subtitle="循环开启后自动扫描并生成计划"
                type="feedback"
                {...intakePlanPreviewProps}
                attachments={activeSnapshot.attachments}
                onAddFiles={addPendingFiles}
                onDelete={deleteFeedback}
                onRemoveAttachment={removePendingAttachment}
                onSubmit={createFeedbackFromComposer}
                onUpdate={updateFeedback}
                onInterrupt={interruptIntake}
                onResume={resumeIntake}
                onAppendTask={appendIntakeTask}
                onRetryGeneratePlan={retryIntakePlanGeneration}
                onAcceptIntake={acceptIntake}
                onUnacceptIntake={unacceptIntake}
                retryAgentCliOptions={composerCliSelection.options}
                retryCodexReasoningOptions={composerCliSelection.reasoningOptions}
                composerIdentityKey={`project:${projectId}:feedback`}
                draftValue={composerDrafts.feedback}
                onDraftChange={(next) => updateComposerDraft('feedback', next)}
              />
            </ComposerCliSelectionProvider>
          ) : null}
        </section>

        <section className={`view ${activeTab === 'acceptance' ? 'active' : ''}`}>
          {activeTab === 'acceptance' ? (
            <AcceptanceView
              projectId={projectId}
              groups={acceptanceGroups}
              acceptedGroups={acceptedGroups}
              recentAccepted={recentAccepted}
              onAccept={acceptItem}
              onUnaccept={unacceptItem}
              onAcceptItems={acceptItems}
              onUnacceptItems={unacceptItems}
            />
          ) : null}
        </section>

        <section className={`view ${activeTab === 'tasks' ? 'active' : ''}`}>
          {activeTab === 'tasks' ? (
            <div
              className="task-main"
              data-testid="workspace-task-main"
              data-selected-plan-id={planSelectionState.selectedPlanId ?? undefined}
              data-selected-plan-file={planSelectionState.selectedPlan?.file_path || undefined}
            >
              <div className="task-status-grid">
                <section className="card">
                  <div className="card-head">
                    <h2>Plan</h2>
                  </div>
                  <WorkspacePlanList
                    emptyText={filteredEmptyText}
                    latestReadingPlan={latestReadingPlan}
                    onCloseReader={closePlanReader}
                    onDeletePlan={deletePlan}
                    onOpenReader={openPlanReader}
                    onOpenPlanFile={(plan) => openScopeFile(plan.file_path, 'folder')}
                    onResumePlan={resumePlan}
                    onRunParallel={({ plan, batches }) =>
                      runLoopAction(() =>
                        client.runTaskBatches({ projectId, planId: plan.id, batches, manual: true }),
                      )
                    }
                    onRunDraft={(plan, task) =>
                      runLoopAction(() => client.runTask({ projectId: plan.project_id || projectId, planId: plan.id, taskId: task.id }))
                    }
                    onRefreshReader={refreshPlanReader}
                    onSelectPlan={planSelectionState.selectPlan}
                    onReExecutePlan={reExecutePlan}
                    onRecreatePlanFromIntake={recreatePlanFromIntake}
                    onAppendPlanTask={appendPlanTask}
                    onStopPlan={stopPlan}
                    onUpdatePlanExecutionConfig={
                      updatePlanExecutionConfig
                        ? (plan, provider) => updatePlanExecutionConfig(plan, provider)
                        : undefined
                    }
                    plans={filteredItems.plans}
                    readerState={planListReaderState}
                    selectedPlanId={planSelectionState.selectedPlanId}
                    tasks={activeSnapshot.tasks}
                    totalPlanCount={activeSnapshot.plans.length}
                  />
                </section>
                <section className="card">
                  <div className="card-head">
                    <h2>任务</h2>
                  </div>
                  <WorkspaceTaskList
                    emptyText={filteredEmptyText}
                    locateTarget={pendingSearchTarget}
                    planFilter={selectedPlanTaskFilter}
                    tasks={taskListTasks}
                    onOpenScopeFile={openScopeFile}
                    onOpenPlan={openTaskPlanReader}
                    onRun={(task) => runLoopAction(() => client.runTask({ projectId, planId: task.plan_id, taskId: task.id }))}
                    onStop={(task) => runLoopAction(() => client.stopTask({ projectId, planId: task.plan_id, taskId: task.id }))}
                  />
                </section>
              </div>
            </div>
          ) : null}
        </section>

        <section className={`view ${activeTab === 'terminal' ? 'active' : ''}`}>
          {activeTab === 'terminal' ? (
            <WorkspaceTerminalView
              executors={activeSnapshot.executors || []}
              projectId={projectId}
              scripts={activeSnapshot.scripts}
              terminals={currentTerminalSessions}
              workspacePath={workspacePath}
            />
          ) : null}
        </section>

        <section className={`view ${activeTab === 'settings' ? 'active' : ''}`}>
          {activeTab === 'settings' ? (
            <WorkspaceSettingsView
              projectId={projectId}
              loopForm={loopForm}
              mcpForm={mcpForm}
              scopeFileOpenSettings={scopeFileOpenSettings}
              setLoopForm={updateLoopForm}
              setMcpForm={setMcpForm}
              setScopeFileOpenSettings={setScopeFileOpenSettings}
              mcp={activeSnapshot.mcp}
              startMcp={startMcp}
              stopMcp={stopMcp}
              saveMcpConfig={saveMcpConfig}
              onSubmit={submitLoopConfig}
              onToggleRun={() =>
                runLoopAction(() =>
                  state?.running
                    ? client.stopLoop({ projectId, manual: true })
                    : client.startLoop({ projectId, manual: true }),
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

        <section className={`view ${activeTab === 'scripts' ? 'active' : ''}`}>
          {activeTab === 'scripts' ? (
            <WorkspaceScriptsView
              scripts={activeSnapshot.scripts}
              projectId={projectId}
              onToggle={toggleScript}
              onRun={runScript}
              onSync={syncScripts}
            />
          ) : null}
        </section>

        <section className={`view ${activeTab === 'executors' ? 'active' : ''}`}>
          {activeTab === 'executors' ? (
            <WorkspaceExecutorsView
              executors={activeSnapshot.executors || []}
              projectId={projectId}
              onSync={syncExecutors}
            />
          ) : null}
        </section>

        <section className={`view ${activeTab === 'chat' ? 'active' : ''}`}>
          {activeTab === 'chat' ? (
            <ChatView chatState={chatState} onOpenIntake={handleOpenIntake} />
          ) : null}
        </section>

        <PlanReaderModal
          latestPlan={latestReadingPlan}
          onClose={closePlanReader}
          onRefresh={refreshPlanReader}
          readerState={planReadState}
        />
      </div>
    </div>
  );
}

function isWorkspaceSnapshotForProject(
  snapshot: AppSnapshot | null,
  projectId: number,
): snapshot is AppSnapshot {
  return (
    Boolean(snapshot)
    && snapshot?.activeProjectId !== null
    && Number(snapshot?.activeProjectId) === Number(projectId)
  );
}

function normalizeTerminalSessions(
  sessions: TerminalSession[] = [],
  projectId: number,
  closedSessionKeys: ReadonlySet<string> = new Set(),
) {
  return sessions
    .filter((session) => (
      terminalBelongsToProject(session, projectId)
      && !shouldRemoveTerminalSession(session, projectId, closedSessionKeys)
    ))
    .slice()
    .sort((left, right) => String(left.createdAt || '').localeCompare(String(right.createdAt || '')));
}

function upsertTerminalSession(
  current: TerminalSession[],
  next: TerminalSession,
  projectId: number,
  closedSessionKeys: ReadonlySet<string>,
) {
  if (!terminalBelongsToProject(next, projectId)) {
    return normalizeTerminalSessions(current, projectId, closedSessionKeys);
  }
  if (shouldRemoveTerminalSession(next, projectId, closedSessionKeys)) {
    return removeTerminalSession(current, next.id, projectId, closedSessionKeys);
  }
  return normalizeTerminalSessions([
    ...current.filter((session) => session.id !== next.id),
    next,
  ], projectId, closedSessionKeys);
}

function removeTerminalSession(
  current: TerminalSession[],
  sessionId: string,
  projectId: number,
  closedSessionKeys: ReadonlySet<string>,
) {
  const id = String(sessionId || '').trim();
  if (!id) return normalizeTerminalSessions(current, projectId, closedSessionKeys);
  return normalizeTerminalSessions(current.filter((session) => session.id !== id), projectId, closedSessionKeys);
}

function terminalBelongsToProject(session: TerminalSession | null | undefined, projectId: number) {
  if (!session) return false;
  return Number(session.projectId) === Number(projectId);
}

function shouldRemoveTerminalSession(
  session: TerminalSession,
  projectId: number,
  closedSessionKeys: ReadonlySet<string>,
) {
  return Boolean(session.closed) || closedSessionKeys.has(closedTerminalSessionKey(projectId, session.id));
}

function rememberClosedTerminalSessions(
  sessions: TerminalSession[] = [],
  projectId: number,
  closedSessionKeys: Set<string>,
) {
  sessions.forEach((session) => {
    if (terminalBelongsToProject(session, projectId) && session.closed) {
      rememberClosedTerminalSession(session.id, session.projectId, closedSessionKeys);
    }
  });
}

function rememberClosedTerminalSession(
  sessionId: string | null | undefined,
  projectId: number | string,
  closedSessionKeys: Set<string>,
) {
  const id = String(sessionId || '').trim();
  if (!id) return;
  closedSessionKeys.add(closedTerminalSessionKey(projectId, id));
}

function closedTerminalSessionKey(projectId: number | string, sessionId: string) {
  return `${projectKey(projectId)}:${sessionId}`;
}

function projectKey(projectId: number | string) {
  const number = Number(projectId);
  return Number.isFinite(number) ? String(number) : String(projectId || '');
}

function terminalEventSessionId(event: TerminalEvent) {
  return String(event.sessionId || event.session?.id || '').trim();
}

function terminalEventProjectId(event: TerminalEvent) {
  return event.projectId ?? event.session?.projectId;
}

function terminalEventBelongsToProject(event: TerminalEvent, projectId: number) {
  if (event.session) return terminalBelongsToProject(event.session, projectId);
  return Number(event.projectId) === Number(projectId);
}

function terminalEventClosed(
  event: TerminalEvent,
  projectId: number,
  closedSessionKeys: ReadonlySet<string>,
) {
  if (event.closed || event.session?.closed) return true;
  const sessionId = terminalEventSessionId(event);
  if (!sessionId) return false;
  return closedSessionKeys.has(closedTerminalSessionKey(projectId, sessionId))
    || closedSessionKeys.has(closedTerminalSessionKey(terminalEventProjectId(event) ?? projectId, sessionId));
}

function isTerminalActive(session: TerminalSession) {
  const status = String(session.status || '').toLowerCase();
  return !session.endedAt && !['exited', 'killed', 'error'].includes(status);
}

function locateWorkspaceSearchResult(result: WorkspaceSearchResult) {
  const target = getWorkspaceSearchAnchorCandidates(result)
    .map((anchorId) => document.getElementById(anchorId))
    .find((element): element is HTMLElement => element instanceof HTMLElement);

  if (!target) return false;

  const previousTabIndex = target.getAttribute('tabindex');
  const highlightMs = Math.max(600, Number(result.location.highlightMs) || 2400);
  target.scrollIntoView({ behavior: result.location.scrollBehavior, block: 'center', inline: 'nearest' });
  target.classList.remove('search-locate-highlight');
  void target.offsetWidth;
  target.classList.add('search-locate-highlight');
  target.setAttribute('tabindex', previousTabIndex ?? '-1');
  target.focus({ preventScroll: true });

  window.setTimeout(() => {
    target.classList.remove('search-locate-highlight');
    if (previousTabIndex === null) target.removeAttribute('tabindex');
  }, highlightMs);

  return true;
}

function getWorkspaceSearchAnchorCandidates(result: WorkspaceSearchResult) {
  const candidates = [
    result.anchorId,
    result.location.anchorId,
    `workspace-${result.targetType}-${result.targetId}`,
    result.taskId ? `workspace-task-${result.taskId}` : '',
    result.planId ? `workspace-plan-${result.planId}` : '',
    result.filePath ? `workspace-plan-file-${sanitizeWorkspaceSearchAnchor(result.filePath)}` : '',
  ];

  return Array.from(new Set(candidates.filter(Boolean)));
}

function sanitizeWorkspaceSearchAnchor(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]/g, '-');
}

function findPlanForSearchResult(result: WorkspaceSearchResult, plans: Plan[]) {
  const planId = normalizeSearchResultPlanId(result.planId ?? (result.targetType === 'plan' ? result.targetId : null));
  if (planId !== null) {
    const plan = plans.find((item) => item.id === planId);
    if (plan) return plan;
  }

  const filePath = readPlanTaskAssociationFilePath({ file_path: result.filePath });
  if (!filePath) return null;
  return plans.find((plan) => readPlanTaskAssociationFilePath(plan) === filePath) || null;
}

function intakeLocateItemId(
  type: IntakeType,
  pendingSearchTarget: WorkspaceSearchResult | null,
  pendingIntakeTarget: PendingIntakeTarget | null,
) {
  if (pendingIntakeTarget?.tab === type) return pendingIntakeTarget.id;
  if (pendingSearchTarget?.targetTab !== type || pendingSearchTarget.targetType !== type) return null;
  return normalizeSearchResultPlanId(pendingSearchTarget.targetId);
}

function normalizeSearchResultPlanId(value: number | null | undefined) {
  if (value === null || typeof value === 'undefined') return null;
  const planId = Number(value);
  return Number.isFinite(planId) ? planId : null;
}

function formatSearchLocateFallback(result: WorkspaceSearchResult) {
  return `已打开${tabTitle(result.targetTab)}，但暂未找到可定位的“${result.title}”节点。`;
}


function tabTitle(tab: WorkspaceTab) {
  return { overview: '概览', requirement: '需求模块', feedback: '反馈模块', acceptance: '验收模块', tasks: '计划与任务', terminal: '终端', executors: '执行器', scripts: '脚本模块', events: '事件流', settings: '设置', chat: 'AI 对话' }[tab];
}

function tabSubtitle(tab: WorkspaceTab, project: Project | null) {
  const base = {
    overview: '循环状态、阶段流水线与各模块一览',
    requirement: '收集需求，发送后由循环自动生成开发计划',
    feedback: '收集反馈，关联需求并由循环生成开发计划',
    acceptance: '对已完成的计划与任务逐项验收',
    tasks: 'Plan 与任务进度',
    terminal: '当前项目的交互终端会话',
    executors: '管理工作区命令执行器，导入 tasks.json 并手动运行',
    scripts: '自定义脚本，手动运行或挂到循环各阶段自动触发',
    events: '循环运行日志与任务执行记录',
    settings: '工作区路径、循环间隔、验收命令、CLI 后端与 MCP 接入',
    chat: '与 AI 对话，自配 LLM 接口，AI 可读取文件、创建需求与脚本',
  }[tab];
  return project ? `${base} · ${project.name}` : base;
}
