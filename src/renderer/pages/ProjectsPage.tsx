import { FormEvent, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { useNavigate } from 'react-router-dom';
import { Icon } from '../components/icons';
import type { CreateProjectInput, Project } from '../types';
import { useSnapshot } from '../hooks/useSnapshot';
import { useAutoplanClient, useDesktopBridge } from '../lib/api/provider';
import { planExecutionSummaryLabel, planGenerationSummaryLabel } from '../components/shared';
import {
  codexReasoningOptionDetails,
  defaultCodexReasoningEffort,
  isBuiltinPlanExecutionStrategy,
  isBuiltinPlanGenerationStrategy,
  isCodexPlanBackendProvider,
  loadNewProjectDefaultCliPreferences,
  normalizeCodexReasoningEffort,
  normalizePlanBackendProvider,
  normalizePlanExecutionStrategy,
  normalizePlanGenerationStrategy,
  planBackendDefaultCommand,
  planBackendDefaultModel,
  planBackendProviderOptionsForStrategy,
  planExecutionStrategyOptions,
  planGenerationStrategyOptions,
  saveNewProjectDefaultCliPreferences,
} from '../utils/workspaceForms';
import { formatChinaDateTime } from '../utils/time';
import { UpdateNotice } from '../components/UpdateNotice';

type Draft = CreateProjectInput & { id?: number };

type ProjectSortKey =
  | 'updated_at_desc'
  | 'updated_at_asc'
  | 'created_at_desc'
  | 'created_at_asc'
  | 'name_asc'
  | 'name_desc'
  | 'running_desc'
  | 'running_asc';

const PROJECTS_SORT_STORAGE_KEY = 'autoplan:projects-sort';

const SORT_OPTIONS: { label: string; value: ProjectSortKey }[] = [
  { label: '最后运行时间（最近优先）', value: 'updated_at_desc' },
  { label: '最后运行时间（最早优先）', value: 'updated_at_asc' },
  { label: '创建时间（最新优先）', value: 'created_at_desc' },
  { label: '创建时间（最早优先）', value: 'created_at_asc' },
  { label: '名称（A-Z）', value: 'name_asc' },
  { label: '名称（Z-A）', value: 'name_desc' },
  { label: '运行状态（运行中优先）', value: 'running_desc' },
  { label: '运行状态（已停止优先）', value: 'running_asc' },
];

function readStoredSort(): ProjectSortKey {
  try {
    const stored = localStorage.getItem(PROJECTS_SORT_STORAGE_KEY);
    if (stored && SORT_OPTIONS.some((option) => option.value === stored)) {
      return stored as ProjectSortKey;
    }
  } catch {
    // ignore storage errors
  }
  return 'running_desc';
}

const emptyDraft: Draft = {
  name: '',
  workspacePath: '',
  description: '',
  agentCliProvider: 'codex',
  agentCliCommand: '',
  codexReasoningEffort: defaultCodexReasoningEffort,
  planGenerationStrategy: 'external-cli-markdown',
  planGenerationProvider: 'codex',
  planGenerationCommand: '',
  planGenerationModel: '',
  planGenerationCodexReasoningEffort: defaultCodexReasoningEffort,
  planExecutionStrategy: 'external-cli',
  planExecutionProvider: 'codex',
  planExecutionCommand: '',
  planExecutionModel: '',
  planExecutionCodexReasoningEffort: defaultCodexReasoningEffort,
};

export function ProjectsPage() {
  const client = useAutoplanClient();
  const desktopBridge = useDesktopBridge();
  const navigate = useNavigate();
  const { snapshot, setSnapshot, error, setError } = useSnapshot(null);
  const projects = snapshot?.projects || [];
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<ProjectSortKey>(readStoredSort());
  const sortDetailsRef = useRef<HTMLDetailsElement>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [defaultSaved, setDefaultSaved] = useState(false);
  const [deleting, setDeleting] = useState<Project | null>(null);
  const [deletePending, setDeletePending] = useState(false);

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    const matched = keyword
      ? projects.filter((project) =>
          [project.name, project.workspace_path, project.description].some((value) =>
            String(value || '').toLowerCase().includes(keyword),
          ),
        )
      : projects.slice();
    matched.sort((left, right) => sortProjects(left, right, sort));
    return matched;
  }, [projects, query, sort]);

  const showError = (e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e);
    setError(msg);
    window.alert(msg);
  };

  const openCreate = () => {
    setDraft(createDraftFromNewProjectDefaults());
    setDefaultSaved(false);
    setModalOpen(true);
  };

  const openEdit = (project: Project) => {
    setDraft(projectDraftFromProject(project));
    setDefaultSaved(false);
    setModalOpen(true);
  };

  const pickFolder = async () => {
    try {
      const directory = await desktopBridge.pickDirectory();
      // 用户取消或无可用窗口时返回 null，保持当前值不变
      if (directory) {
        setDraft((current) => ({ ...current, workspacePath: directory }));
      }
    } catch (e) {
      showError(e);
    }
  };

  const openFolder = async (project: Project) => {
    try {
      const result = await desktopBridge.openProjectFolder({ projectId: project.id });
      if (!result.ok) {
        window.alert(result.error || '无法打开工作区文件夹');
      }
    } catch (e) {
      showError(e);
    }
  };

  const submitProject = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!draft.name.trim()) return;
    try {
      const description = (draft.description || '').trim();
      const projectPayload = projectInputFromDraft(draft, description);
      const next = draft.id
        ? await client.updateProject({
            id: draft.id,
            ...projectPayload,
          })
        : await client.createProject(projectPayload);
      setSnapshot(next);
      setModalOpen(false);
      setError(null);
    } catch (e) {
      showError(e);
    }
  };

  const handleSortChange = (value: ProjectSortKey) => {
    setSort(value);
    sortDetailsRef.current?.removeAttribute('open');
    try {
      localStorage.setItem(PROJECTS_SORT_STORAGE_KEY, value);
    } catch {
      // ignore storage errors
    }
  };

  const saveCurrentCliAsDefault = () => {
    try {
      const saved = saveNewProjectDefaultCliPreferences(newProjectDefaultCliPreferencesFromDraft(draft));
      setDraft((current) => current.id ? current : { ...current, ...draftCliFieldsFromNewProjectDefaults(saved) });
      setDefaultSaved(true);
      setError(null);
    } catch (e) {
      showError(e);
    }
  };

  const confirmDelete = async () => {
    if (!deleting || deletePending) return;
    const target = deleting;
    setDeletePending(true);
    try {
      const next = await client.deleteProject({ projectId: target.id });
      setSnapshot(next);
      setDeleting(null);
      setError(null);
    } catch (e) {
      showError(e);
    } finally {
      setDeletePending(false);
    }
  };

  const stats = {
    total: projects.length,
    running: projects.filter((project) => project.running).length,
  };

  return (
    <>
      <header className="app-header">
        <div className="brand">
          <div className="brand-mark">A</div>
          <div>
            <h1>AutoPlan</h1>
            <p>项目管理</p>
          </div>
        </div>
        <div className="header-actions">
          <button type="button" className="btn btn-primary" onClick={openCreate}>
            <Icon name="plus" size={16} aria-hidden="true" />
            创建项目
          </button>
        </div>
      </header>

      <main className="projects-main">
        <UpdateNotice />
        {error ? <div className="error-banner">{error}</div> : null}

        <div className="projects-hero">
          <div>
            <h2>项目</h2>
            <p>管理工作区项目 · 点击卡片进入对应项目的工作区</p>
          </div>
          <div className="hero-stats">
            <div className="hero-stat">
              <b>{stats.total}</b>
              <span>项目总数</span>
            </div>
            <div className="hero-stat">
              <b>{stats.running}</b>
              <span>运行中</span>
            </div>
          </div>
        </div>

        <div className="projects-toolbar">
          <input
            className="search-input"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索项目名称、路径或备注…"
          />
          <details className="sort-details" ref={sortDetailsRef}>
            <summary className="sort-summary" aria-label="项目排序">
              <Icon name="sliders" size={18} aria-hidden="true" />
            </summary>
            <div className="ctx-menu sort-menu">
              {SORT_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className={sort === option.value ? 'active' : undefined}
                  onClick={() => handleSortChange(option.value)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </details>
        </div>

        <div className="project-grid">
          {filtered.length ? (
            filtered.map((project) => (
              <article className="project-card" key={project.id} onClick={() => navigate(`/projects/${project.id}`)}>
                <div className="project-card-top">
                  <span className="project-avatar">{project.name.slice(0, 1).toUpperCase()}</span>
                  <div className="project-info">
                    <div className="project-name">{project.name}</div>
                    <button
                      type="button"
                      className="project-path project-path-link mono"
                      disabled={!project.workspace_path}
                      onClick={(event) => {
                        // 阻止冒泡到卡片，避免触发“进入工作区”导航
                        event.stopPropagation();
                        if (project.workspace_path) void openFolder(project);
                      }}
                      title={project.workspace_path ? '在系统文件夹中打开' : undefined}
                    >
                      {project.workspace_path || '未设置工作区'}
                    </button>
                  </div>
                  <div className="project-card-menu" onClick={(e) => e.stopPropagation()}>
                    <details className="ctx-details">
                      <summary className="ctx-summary" aria-label="更多操作">
                        <svg
                          className="app-icon ctx-more-icon"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth={1.8}
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          focusable="false"
                          aria-hidden="true"
                        >
                          <circle cx="5" cy="12" r="1.5" fill="currentColor" stroke="none" />
                          <circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" />
                          <circle cx="19" cy="12" r="1.5" fill="currentColor" stroke="none" />
                        </svg>
                      </summary>
                      <div className="ctx-menu">
                        <button type="button" onClick={() => navigate(`/projects/${project.id}`)}>
                          <Icon name="enter" size={16} aria-hidden="true" />
                          <span>进入工作区</span>
                        </button>
                        <button type="button" onClick={() => navigate(`/projects/${project.id}?tab=settings`)}>
                          <Icon name="settings" size={16} aria-hidden="true" />
                          <span>项目设置</span>
                        </button>
                        <button type="button" onClick={() => openEdit(project)}>
                          <Icon name="edit" size={16} aria-hidden="true" />
                          <span>编辑</span>
                        </button>
                        <button type="button" className="ctx-danger" onClick={() => setDeleting(project)}>
                          <Icon name="delete" size={16} aria-hidden="true" />
                          <span>删除</span>
                        </button>
                      </div>
                    </details>
                  </div>
                </div>
                <div className="project-desc">{project.description || '暂无描述'}</div>
                <div className="project-loop-status">
                  <span className={`led ${project.running ? 'running' : 'stopped'}`} />
                  <span>{projectStatusText(project)}</span>
                  <span className="project-cli-badge" title={planGenerationSummaryLabel(project)}>
                    生成 · {planGenerationSummaryLabel(project)}
                  </span>
                  <span className="project-cli-badge" title={planExecutionSummaryLabel(project)}>
                    执行 · {planExecutionSummaryLabel(project)}
                  </span>
                  <span className="project-loop-interval">{project.interval_seconds || 5}s</span>
                </div>
                <div className="project-meta">#{project.id} · 更新于 {formatChinaDateTime(project.updated_at)}</div>
              </article>
            ))
          ) : (
            <div className="empty">没有匹配的项目。</div>
          )}
        </div>
      </main>

      {modalOpen ? (
        <div className="modal-mask" onClick={() => setModalOpen(false)}>
          <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h3>{draft.id ? '编辑项目' : '创建项目'}</h3>
              <button type="button" className="modal-close" onClick={() => setModalOpen(false)} aria-label="关闭">
                <Icon name="close" size={16} aria-hidden="true" />
              </button>
            </div>
            <form className="modal-form" onSubmit={submitProject}>
              <label className="field">
                项目名称 <span className="req">*</span>
                <input
                  value={draft.name}
                  onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
                  placeholder="例如 wenz_richtext"
                  autoFocus
                />
              </label>
              <label className="field">
                工作区路径 <span className="req">*</span>
                <div className="input-affix">
                  <input
                    className="field-input mono"
                    value={draft.workspacePath}
                    onChange={(event) => setDraft((current) => ({ ...current, workspacePath: event.target.value }))}
                    placeholder="D:\project\GitHub\my-app"
                  />
                  <button type="button" className="affix" onClick={pickFolder}>
                    选择文件夹
                  </button>
                </div>
                <span className="field-hint">可直接输入路径，或点击“选择文件夹”定位目录。</span>
              </label>
              <label className="field">
                备注
                <textarea
                  value={draft.description}
                  onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))}
                  placeholder="一句话描述这个项目"
                />
              </label>
              <div className="project-backend-form-grid">
                <ProjectBackendDraftFields kind="generation" draft={draft} setDraft={setDraft} />
                <ProjectBackendDraftFields kind="execution" draft={draft} setDraft={setDraft} />
              </div>
              {!draft.id ? (
                <div className="button-row">
                  <span className="field-hint">新项目默认 CLI</span>
                  {defaultSaved ? <span className="chip chip-completed">已保存</span> : null}
                  <button type="button" className="btn btn-sm" onClick={saveCurrentCliAsDefault}>
                    <Icon name="save" size={15} aria-hidden="true" />
                    设为默认
                  </button>
                </div>
              ) : null}
              <div className="modal-foot">
                <button type="button" className="btn" onClick={() => setModalOpen(false)}>
                  取消
                </button>
                <button type="submit" className="btn btn-primary">
                  保存
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {deleting ? (
        <div className="modal-mask" onClick={() => { if (!deletePending) setDeleting(null); }}>
          <div className="modal modal-confirm" onClick={(e) => e.stopPropagation()}>
            <div className="modal-danger-icon">
              <Icon name="warning" size={24} aria-hidden="true" />
            </div>
            <h3>删除项目</h3>
            <p>
              确定要删除项目 <b>{deleting.name}</b> 吗？
              <br />
              该操作会移除项目记录，<b className="danger-text">不会删除磁盘上的工作区文件</b>。
            </p>
            <div className="modal-foot">
              <button type="button" className="btn" disabled={deletePending} onClick={() => setDeleting(null)}>
                取消
              </button>
              <button type="button" className="btn btn-danger" disabled={deletePending} onClick={confirmDelete}>
                {deletePending ? '正在删除…' : '确认删除'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

function createDraftFromNewProjectDefaults(): Draft {
  return {
    ...emptyDraft,
    ...draftCliFieldsFromNewProjectDefaults(loadNewProjectDefaultCliPreferences()),
  };
}

function draftCliFieldsFromNewProjectDefaults(
  defaults: ReturnType<typeof loadNewProjectDefaultCliPreferences>,
): Partial<Draft> {
  return {
    agentCliProvider: defaults.agentCliProvider,
    agentCliCommand: defaults.agentCliCommand,
    codexReasoningEffort: defaults.codexReasoningEffort || defaultCodexReasoningEffort,
    planGenerationStrategy: defaults.planGenerationStrategy,
    planGenerationProvider: defaults.planGenerationProvider,
    planGenerationCommand: defaults.planGenerationCommand,
    planGenerationModel: defaults.planGenerationModel,
    planGenerationCodexReasoningEffort: defaults.planGenerationCodexReasoningEffort || defaultCodexReasoningEffort,
    planExecutionStrategy: defaults.planExecutionStrategy,
    planExecutionProvider: defaults.planExecutionProvider,
    planExecutionCommand: defaults.planExecutionCommand,
    planExecutionModel: defaults.planExecutionModel,
    planExecutionCodexReasoningEffort: defaults.planExecutionCodexReasoningEffort || defaultCodexReasoningEffort,
  };
}

function newProjectDefaultCliPreferencesFromDraft(draft: Draft): ReturnType<typeof loadNewProjectDefaultCliPreferences> {
  const payload = projectInputFromDraft(draft, draft.description || '');
  const planGenerationStrategy = normalizePlanGenerationStrategy(payload.planGenerationStrategy);
  const planGenerationProvider = normalizePlanBackendProvider(payload.planGenerationProvider, planGenerationStrategy);
  const planExecutionStrategy = normalizePlanExecutionStrategy(payload.planExecutionStrategy);
  const planExecutionProvider = normalizePlanBackendProvider(payload.planExecutionProvider, planExecutionStrategy);
  return {
    agentCliProvider: payload.agentCliProvider || 'codex',
    agentCliCommand: String(payload.agentCliCommand || ''),
    codexReasoningEffort: payload.codexReasoningEffort ?? null,
    planGenerationStrategy,
    planGenerationProvider,
    planGenerationCommand: String(payload.planGenerationCommand || ''),
    planGenerationModel: String(payload.planGenerationModel || ''),
    planGenerationCodexReasoningEffort: payload.planGenerationCodexReasoningEffort ?? null,
    planExecutionStrategy,
    planExecutionProvider,
    planExecutionCommand: String(payload.planExecutionCommand || ''),
    planExecutionModel: String(payload.planExecutionModel || ''),
    planExecutionCodexReasoningEffort: payload.planExecutionCodexReasoningEffort ?? null,
  };
}

function projectDraftFromProject(project: Project): Draft {
  const legacyProvider = String(project.agent_cli_provider || 'codex');
  const legacyCommand = project.agent_cli_command || '';
  const legacyReasoning = normalizeCodexReasoningEffort(project.codex_reasoning_effort);
  const planGenerationStrategy = normalizePlanGenerationStrategy(project.plan_generation_strategy);
  const planGenerationProvider = normalizePlanBackendProvider(
    project.plan_generation_provider || legacyProvider,
    planGenerationStrategy,
  );
  const planExecutionStrategy = normalizePlanExecutionStrategy(project.plan_execution_strategy);
  const planExecutionProvider = normalizePlanBackendProvider(
    project.plan_execution_provider || legacyProvider,
    planExecutionStrategy,
  );
  return {
    ...emptyDraft,
    id: project.id,
    name: project.name,
    workspacePath: project.workspace_path,
    description: project.description,
    agentCliProvider: legacyProvider,
    agentCliCommand: legacyCommand,
    codexReasoningEffort: legacyReasoning,
    planGenerationStrategy,
    planGenerationProvider,
    planGenerationCommand: project.plan_generation_command || legacyCommand,
    planGenerationModel: project.plan_generation_model || (isBuiltinPlanGenerationStrategy(planGenerationStrategy) ? planBackendDefaultModel(planGenerationProvider) : ''),
    planGenerationCodexReasoningEffort: normalizeCodexReasoningEffort(
      project.plan_generation_codex_reasoning_effort || legacyReasoning,
    ),
    planExecutionStrategy,
    planExecutionProvider,
    planExecutionCommand: project.plan_execution_command || legacyCommand,
    planExecutionModel: project.plan_execution_model || (isBuiltinPlanExecutionStrategy(planExecutionStrategy) ? planBackendDefaultModel(planExecutionProvider) : ''),
    planExecutionCodexReasoningEffort: normalizeCodexReasoningEffort(
      project.plan_execution_codex_reasoning_effort || legacyReasoning,
    ),
  };
}

function projectInputFromDraft(draft: Draft, description: string): CreateProjectInput {
  const planGenerationStrategy = normalizePlanGenerationStrategy(draft.planGenerationStrategy);
  const planGenerationProvider = normalizePlanBackendProvider(draft.planGenerationProvider, planGenerationStrategy);
  const planExecutionStrategy = normalizePlanExecutionStrategy(draft.planExecutionStrategy);
  const planExecutionProvider = normalizePlanBackendProvider(draft.planExecutionProvider, planExecutionStrategy);
  const legacyProvider = planExecutionStrategy === 'external-cli' ? planExecutionProvider : 'codex';
  const legacyCommand = planExecutionStrategy === 'external-cli' ? String(draft.planExecutionCommand || '').trim() : '';
  const legacyReasoning = legacyProvider === 'codex'
    ? normalizeCodexReasoningEffort(draft.planExecutionCodexReasoningEffort)
    : undefined;
  return {
    name: draft.name.trim(),
    workspacePath: draft.workspacePath.trim(),
    description,
    agentCliProvider: legacyProvider,
    agentCliCommand: legacyCommand,
    ...(legacyReasoning ? { codexReasoningEffort: legacyReasoning } : {}),
    planGenerationStrategy,
    planGenerationProvider,
    planGenerationCommand: isBuiltinPlanGenerationStrategy(planGenerationStrategy)
      ? ''
      : String(draft.planGenerationCommand || '').trim(),
    planGenerationModel: isBuiltinPlanGenerationStrategy(planGenerationStrategy)
      ? (String(draft.planGenerationModel || '').trim() || planBackendDefaultModel(planGenerationProvider))
      : '',
    planGenerationCodexReasoningEffort: isCodexPlanBackendProvider(planGenerationProvider)
      ? normalizeCodexReasoningEffort(draft.planGenerationCodexReasoningEffort)
      : null,
    planExecutionStrategy,
    planExecutionProvider,
    planExecutionCommand: isBuiltinPlanExecutionStrategy(planExecutionStrategy)
      ? ''
      : String(draft.planExecutionCommand || '').trim(),
    planExecutionModel: isBuiltinPlanExecutionStrategy(planExecutionStrategy)
      ? (String(draft.planExecutionModel || '').trim() || planBackendDefaultModel(planExecutionProvider))
      : '',
    planExecutionCodexReasoningEffort: isCodexPlanBackendProvider(planExecutionProvider)
      ? normalizeCodexReasoningEffort(draft.planExecutionCodexReasoningEffort)
      : null,
  };
}

function ProjectBackendDraftFields({
  kind,
  draft,
  setDraft,
}: {
  kind: 'generation' | 'execution';
  draft: Draft;
  setDraft: Dispatch<SetStateAction<Draft>>;
}) {
  const isGeneration = kind === 'generation';
  const strategy = isGeneration
    ? normalizePlanGenerationStrategy(draft.planGenerationStrategy)
    : normalizePlanExecutionStrategy(draft.planExecutionStrategy);
  const provider = normalizePlanBackendProvider(
    isGeneration ? draft.planGenerationProvider : draft.planExecutionProvider,
    strategy,
  );
  const isBuiltin = isGeneration ? isBuiltinPlanGenerationStrategy(strategy) : isBuiltinPlanExecutionStrategy(strategy);
  const providerOptions = planBackendProviderOptionsForStrategy(strategy);
  const title = isGeneration ? '计划生成默认' : '计划执行默认';
  const command = isGeneration ? draft.planGenerationCommand || '' : draft.planExecutionCommand || '';
  const model = isGeneration ? draft.planGenerationModel || '' : draft.planExecutionModel || '';
  const reasoning = normalizeCodexReasoningEffort(
    isGeneration ? draft.planGenerationCodexReasoningEffort : draft.planExecutionCodexReasoningEffort,
  );

  const setStrategy = (value: string) => {
    setDraft((current) => {
      if (isGeneration) {
        const nextStrategy = normalizePlanGenerationStrategy(value);
        const nextProvider = normalizePlanBackendProvider(current.planGenerationProvider, nextStrategy);
        return {
          ...current,
          planGenerationStrategy: nextStrategy,
          planGenerationProvider: nextProvider,
          planGenerationModel: isBuiltinPlanGenerationStrategy(nextStrategy)
            ? current.planGenerationModel || planBackendDefaultModel(nextProvider)
            : current.planGenerationModel,
        };
      }
      const nextStrategy = normalizePlanExecutionStrategy(value);
      const nextProvider = normalizePlanBackendProvider(current.planExecutionProvider, nextStrategy);
      return {
        ...current,
        planExecutionStrategy: nextStrategy,
        planExecutionProvider: nextProvider,
        planExecutionModel: isBuiltinPlanExecutionStrategy(nextStrategy)
          ? current.planExecutionModel || planBackendDefaultModel(nextProvider)
          : current.planExecutionModel,
      };
    });
  };

  const setProvider = (value: string) => {
    setDraft((current) => {
      if (isGeneration) {
        const nextProvider = normalizePlanBackendProvider(value, current.planGenerationStrategy);
        return {
          ...current,
          planGenerationProvider: nextProvider,
          planGenerationModel: isBuiltinPlanGenerationStrategy(current.planGenerationStrategy)
            ? nextModelForProvider(current.planGenerationModel || '', String(current.planGenerationProvider || ''), nextProvider)
            : current.planGenerationModel,
        };
      }
      const nextProvider = normalizePlanBackendProvider(value, current.planExecutionStrategy);
      return {
        ...current,
        planExecutionProvider: nextProvider,
        planExecutionModel: isBuiltinPlanExecutionStrategy(current.planExecutionStrategy)
          ? nextModelForProvider(current.planExecutionModel || '', String(current.planExecutionProvider || ''), nextProvider)
          : current.planExecutionModel,
      };
    });
  };

  return (
    <div className="project-backend-form">
      <div className="project-backend-form-title">{title}</div>
      <label className="field">
        策略
        <select value={strategy} onChange={(event) => setStrategy(event.target.value)}>
          {(isGeneration ? planGenerationStrategyOptions : planExecutionStrategyOptions).map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      </label>
      <label className="field">
        Provider
        <select value={provider} onChange={(event) => setProvider(event.target.value)}>
          {providerOptions.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      </label>
      <label className="field">
        {isBuiltin ? '模型名称' : 'CLI 命令路径'}
        <input
          className="field-input mono"
          value={isBuiltin ? model : command}
          onChange={(event) =>
            setDraft((current) => {
              if (isGeneration) {
                return isBuiltin
                  ? { ...current, planGenerationModel: event.target.value }
                  : { ...current, planGenerationCommand: event.target.value };
              }
              return isBuiltin
                ? { ...current, planExecutionModel: event.target.value }
                : { ...current, planExecutionCommand: event.target.value };
            })
          }
          placeholder={isBuiltin ? planBackendDefaultModel(provider) : planBackendDefaultCommand(provider)}
        />
        {!isGeneration && isBuiltin ? (
          <span className="field-hint">阶段一仅保存配置；执行任务时后端会明确提示暂不支持。</span>
        ) : null}
      </label>
      {isCodexPlanBackendProvider(provider) ? (
        <label className="field">
          Codex 思考深度
          <select
            value={reasoning}
            onChange={(event) =>
              setDraft((current) => (
                isGeneration
                  ? { ...current, planGenerationCodexReasoningEffort: normalizeCodexReasoningEffort(event.target.value) }
                  : { ...current, planExecutionCodexReasoningEffort: normalizeCodexReasoningEffort(event.target.value) }
              ))
            }
          >
            {codexReasoningOptionDetails.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
      ) : null}
    </div>
  );
}

function nextModelForProvider(currentModel: string, currentProvider: string, nextProvider: string) {
  const current = String(currentModel || '').trim();
  if (!current || current === planBackendDefaultModel(currentProvider)) return planBackendDefaultModel(nextProvider);
  return currentModel;
}

function sortProjects(left: Project, right: Project, sort: ProjectSortKey): number {
  switch (sort) {
    case 'name_asc':
      return compareStrings(left.name, right.name) || compareNumbers(left.id, right.id);
    case 'name_desc':
      return compareStrings(right.name, left.name) || compareNumbers(left.id, right.id);
    case 'created_at_desc':
      return compareTimestamps(right.created_at, left.created_at) || compareNumbers(right.id, left.id);
    case 'created_at_asc':
      return compareTimestamps(left.created_at, right.created_at) || compareNumbers(left.id, right.id);
    case 'updated_at_desc':
      return compareTimestamps(right.updated_at, left.updated_at) || compareNumbers(right.id, left.id);
    case 'updated_at_asc':
      return compareTimestamps(left.updated_at, right.updated_at) || compareNumbers(left.id, right.id);
    case 'running_desc': {
      const leftRunning = left.running ? 1 : 0;
      const rightRunning = right.running ? 1 : 0;
      return rightRunning - leftRunning || compareTimestamps(right.updated_at, left.updated_at);
    }
    case 'running_asc': {
      const leftRunning = left.running ? 1 : 0;
      const rightRunning = right.running ? 1 : 0;
      return leftRunning - rightRunning || compareTimestamps(right.updated_at, left.updated_at);
    }
    default:
      return 0;
  }
}

function compareStrings(left: string, right: string): number {
  return String(left || '').localeCompare(String(right || ''), 'zh-CN', { sensitivity: 'base' });
}

function compareNumbers(left: number, right: number): number {
  return (left || 0) - (right || 0);
}

function compareTimestamps(left: string, right: string): number {
  const leftTime = Date.parse(String(left || ''));
  const rightTime = Date.parse(String(right || ''));
  const leftValue = Number.isFinite(leftTime) ? leftTime : 0;
  const rightValue = Number.isFinite(rightTime) ? rightTime : 0;
  return leftValue - rightValue;
}

function projectStatusText(project: Project) {
  const phase = project.phase || (project.running ? 'running' : 'idle');
  return project.running ? `运行中 · ${projectPhaseLabel(phase)}` : `已停止 · ${projectPhaseLabel(phase)}`;
}

function projectPhaseLabel(phase: string) {
  return (
    {
      idle: '空闲',
      stopped: '已停止',
      running: '运行中',
      scan: '扫描',
      'generate-plan': '生成计划',
      'execute-task': '执行任务',
      validate: '验收',
      waiting: '等待下一轮',
      error: '异常',
    }[phase] || phase
  );
}
