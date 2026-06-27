import type { Project, ProjectState, WorkspaceTab } from '../../types';
import { Icon, type IconName } from '../icons';
import {
  agentCliProviderLabel,
  codexReasoningEffortLabel,
  readAgentCliProvider,
  readCodexReasoningEffort,
} from '../shared';

const tabs: Array<{ id: WorkspaceTab; label: string; icon: IconName }> = [
  { id: 'overview', label: '概览', icon: 'overview' },
  { id: 'requirement', label: '需求', icon: 'requirement' },
  { id: 'feedback', label: '反馈', icon: 'feedback' },
  { id: 'tasks', label: '任务与计划', icon: 'tasks' },
  { id: 'events', label: '事件流', icon: 'events' },
  { id: 'settings', label: '设置', icon: 'settings' },
];

export function agentCliConfigSummary(state?: ProjectState | null) {
  const provider = readAgentCliProvider(state);
  const providerLabel = agentCliProviderLabel(provider);
  if (provider === 'claude') return providerLabel;
  return `${providerLabel} · 思考${codexReasoningEffortLabel(readCodexReasoningEffort(state))}`;
}

export function WorkspaceSidebar({
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
