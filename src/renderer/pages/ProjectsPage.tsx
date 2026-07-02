import { FormEvent, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Icon } from '../components/icons';
import type { CreateProjectInput, Project } from '../types';
import { useSnapshot } from '../hooks/useSnapshot';
import { agentCliProviderLabel } from '../components/shared';
import { formatChinaDateTime } from '../utils/time';
import { UpdateNotice } from '../components/UpdateNotice';

type Draft = CreateProjectInput & { id?: number };

const emptyDraft: Draft = { name: '', workspacePath: '', description: '', agentCliProvider: 'codex' };

export function ProjectsPage() {
  const navigate = useNavigate();
  const { snapshot, setSnapshot, error, setError } = useSnapshot(null);
  const projects = snapshot?.projects || [];
  const [query, setQuery] = useState('');
  const [modalOpen, setModalOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [deleting, setDeleting] = useState<Project | null>(null);

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return projects;
    return projects.filter((project) =>
      [project.name, project.workspace_path, project.description].some((value) =>
        String(value || '').toLowerCase().includes(keyword),
      ),
    );
  }, [projects, query]);

  const showError = (e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e);
    setError(msg);
    window.alert(msg);
  };

  const openCreate = () => {
    setDraft(emptyDraft);
    setModalOpen(true);
  };

  const openEdit = (project: Project) => {
    setDraft({
      id: project.id,
      name: project.name,
      workspacePath: project.workspace_path,
      description: project.description,
      agentCliProvider: project.agent_cli_provider || 'codex',
      agentCliCommand: project.agent_cli_command || '',
    });
    setModalOpen(true);
  };

  const pickFolder = async () => {
    try {
      const directory = await window.autoplan.pickDirectory();
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
      const result = await window.autoplan.openProjectFolder({ projectId: project.id });
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
      const agentCliProvider = draft.agentCliProvider || 'codex';
      const agentCliCommand = (draft.agentCliCommand || '').trim();
      const next = draft.id
        ? await window.autoplan.updateProject({
            id: draft.id,
            name: draft.name.trim(),
            workspacePath: draft.workspacePath.trim(),
            description,
            agentCliProvider,
            agentCliCommand,
          })
        : await window.autoplan.createProject({
            name: draft.name.trim(),
            workspacePath: draft.workspacePath.trim(),
            description,
            agentCliProvider,
            agentCliCommand,
          });
      setSnapshot(next);
      setModalOpen(false);
      setError(null);
    } catch (e) {
      showError(e);
    }
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    try {
      const next = await window.autoplan.deleteProject({ projectId: deleting.id });
      setSnapshot(next);
      setDeleting(null);
      setError(null);
    } catch (e) {
      showError(e);
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
                  <span className="project-cli-badge">{agentCliProviderLabel(project.agent_cli_provider)}</span>
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
          <div className="modal" onClick={(e) => e.stopPropagation()}>
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
              <label className="field">
                CLI 后端
                <select
                  value={draft.agentCliProvider}
                  onChange={(event) => setDraft((current) => ({ ...current, agentCliProvider: event.target.value }))}
                >
                  <option value="codex">Codex CLI</option>
                  <option value="claude">Claude CLI</option>
                </select>
                {draft.agentCliProvider === 'claude' ? (
                  <small className="field-hint">需本机已安装 claude CLI 并完成认证</small>
                ) : null}
              </label>
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
        <div className="modal-mask" onClick={() => setDeleting(null)}>
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
              <button type="button" className="btn" onClick={() => setDeleting(null)}>
                取消
              </button>
              <button type="button" className="btn btn-danger" onClick={confirmDelete}>
                确认删除
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
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
      waiting: '等待',
      error: '异常',
    }[phase] || phase
  );
}
