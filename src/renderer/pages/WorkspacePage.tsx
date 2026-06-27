import { useEffect, useRef, useState } from 'react';
import { isTaskAssociatedWithPlan, readPlanTaskAssociationFilePath } from '../types';
import type {
  AppSnapshot,
  Plan,
  Project,
  WorkspacePlanSelectionState,
  WorkspaceSearchResult,
  WorkspaceTab,
} from '../types';
import { useWorkspaceController } from '../hooks/useWorkspaceController';
import { ComposerCliSelectionProvider, type ComposerSubmitPayload } from '../components/Composer';
import { IntakePanel } from '../components/IntakePanel';
import { EventList, PlanList, TaskList } from '../components/PlanLists';
import { SearchResults } from '../components/SearchResults';
import { Icon } from '../components/icons';
import { WorkspaceOverviewView } from '../components/workspace/WorkspaceOverviewView';
import { WorkspaceSearchBox } from '../components/workspace/WorkspaceSearchBox';
import { WorkspaceSettingsView } from '../components/workspace/WorkspaceSettingsView';
import { WorkspaceSidebar, agentCliConfigSummary } from '../components/workspace/WorkspaceSidebar';

export function WorkspacePage() {
  const {
    activeTab,
    addPendingFiles,
    appendIntakeTask,
    closePlanReader,
    composerCliSelection,
    createFeedback,
    createRequirement,
    deleteFeedback,
    deleteRequirement,
    displayTasks,
    error,
    filteredEmptyText,
    filteredItems,
    interruptIntake,
    latestReadingPlan,
    loopForm,
    mcpAuthToken,
    navigate,
    openPlanReader,
    openTaskPlanReader,
    pendingAttachments,
    planReadState,
    project,
    projectId,
    projects,
    refreshPlanReader,
    removePendingAttachment,
    resumeIntake,
    runLoopAction,
    scopeFileOpenSettings,
    searchHitCount,
    searchQuery,
    selectSearchResult,
    selectTab,
    setMcpAuthToken,
    setScopeFileOpenSettings,
    setSearchQuery,
    snapshot,
    state,
    submitLoopConfig,
    switchProject,
    updateFeedback,
    updateLoopForm,
    updateRequirement,
    workspaceSearch,
  } = useWorkspaceController();
  const [searchPopupOpen, setSearchPopupOpen] = useState(false);
  const [pendingSearchTarget, setPendingSearchTarget] = useState<WorkspaceSearchResult | null>(null);
  const [searchLocateNotice, setSearchLocateNotice] = useState('');
  const [selectedPlanId, setSelectedPlanId] = useState<number | null>(null);
  const searchPopupRef = useRef<HTMLDivElement>(null);
  const hasSearchQuery = !workspaceSearch.query.isEmpty;
  const selectedPlan = snapshot?.plans.find((plan) => plan.id === selectedPlanId && plan.project_id === projectId) || null;

  const planSelectionState: WorkspacePlanSelectionState = {
    selectedPlanId,
    selectedPlan,
    selectPlan: (plan) => setSelectedPlanId((current) => (current === plan.id ? null : plan.id)),
    clearSelection: () => setSelectedPlanId(null),
  };
  const selectedPlanAllTasks = selectedPlan
    ? (snapshot?.tasks || []).filter((task) => isTaskAssociatedWithPlan(task, selectedPlan))
    : [];
  const taskListTasks = selectedPlan
    ? displayTasks.filter((task) => isTaskAssociatedWithPlan(task, selectedPlan))
    : displayTasks;
  const selectedPlanTaskFilter = selectedPlan
    ? {
        totalTaskCount: selectedPlanAllTasks.length,
      }
    : null;

  useEffect(() => {
    setSearchPopupOpen(hasSearchQuery);
  }, [hasSearchQuery, workspaceSearch.query.normalized]);

  useEffect(() => {
    setSelectedPlanId((current) => {
      if (current === null) return current;
      if (!snapshot) return null;
      return snapshot.plans.some((plan) => plan.id === current && plan.project_id === projectId) ? current : null;
    });
  }, [projectId, snapshot]);

  useEffect(() => {
    if (!searchPopupOpen) return undefined;

    function handlePointerDown(event: MouseEvent) {
      if (!searchPopupRef.current || !(event.target instanceof Node)) return;
      if (!searchPopupRef.current.contains(event.target)) {
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

  function handleSearchQueryChange(nextQuery: string) {
    setSearchQuery(nextQuery);
    if (nextQuery.trim()) return;

    setPendingSearchTarget(null);
    setSearchLocateNotice('');
    setSearchPopupOpen(false);
  }

  function handleSelectSearchResult(result: WorkspaceSearchResult) {
    const resultPlan = findPlanForSearchResult(result, snapshot?.plans || []);
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
          <div className="workspace-search-popover-anchor" ref={searchPopupRef}>
            <WorkspaceSearchBox
              hitCount={searchHitCount}
              onQueryChange={handleSearchQueryChange}
              query={searchQuery}
            />
            <SearchResults
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
              <WorkspaceOverviewView snapshot={snapshot} state={state} onGoTasks={() => selectTab('tasks')} />
            </>
          ) : null}
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
                onSubmit={createRequirementFromComposer}
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
                onSubmit={createFeedbackFromComposer}
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
                  <PlanList
                    emptyText={filteredEmptyText}
                    latestReadingPlan={latestReadingPlan}
                    onCloseReader={closePlanReader}
                    onOpenReader={openPlanReader}
                    onRunParallel={({ plan, batches }) =>
                      runLoopAction(() =>
                        (window.autoplan as typeof window.autoplan & {
                          runTaskBatches: (input: {
                            projectId: number;
                            planId: number;
                            batches: Array<{ taskIds: number[] }>;
                            manual: true;
                          }) => Promise<AppSnapshot>;
                        }).runTaskBatches({ projectId, planId: plan.id, batches, manual: true }),
                      )
                    }
                    onRefreshReader={refreshPlanReader}
                    onSelectPlan={planSelectionState.selectPlan}
                    plans={filteredItems.plans}
                    readerState={planReadState}
                    selectedPlanId={planSelectionState.selectedPlanId}
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
                    locateTarget={pendingSearchTarget}
                    planFilter={selectedPlanTaskFilter}
                    tasks={taskListTasks}
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
            <WorkspaceSettingsView
              loopForm={loopForm}
              mcpAuthToken={mcpAuthToken}
              scopeFileOpenSettings={scopeFileOpenSettings}
              setLoopForm={updateLoopForm}
              setMcpAuthToken={setMcpAuthToken}
              setScopeFileOpenSettings={setScopeFileOpenSettings}
              mcp={snapshot.mcp}
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

function normalizeSearchResultPlanId(value: number | null | undefined) {
  if (value === null || typeof value === 'undefined') return null;
  const planId = Number(value);
  return Number.isFinite(planId) ? planId : null;
}

function formatSearchLocateFallback(result: WorkspaceSearchResult) {
  return `已打开${tabTitle(result.targetTab)}，但暂未找到可定位的“${result.title}”节点。`;
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
    settings: '工作区路径、循环间隔、验收命令、CLI 后端与 MCP 接入',
  }[tab];
  return project ? `${base} · ${project.name}` : base;
}
