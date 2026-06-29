import { Fragment } from 'react';
import type { Project, ProjectState, WorkspaceTab } from '../../types';
import { Icon, type IconName } from '../icons';
import {
  agentCliProviderLabel,
  codexReasoningEffortLabel,
  readAgentCliProvider,
  readCodexReasoningEffort,
} from '../shared';

type NavItem = { id: WorkspaceTab; label: string; icon: IconName };

// 导航分组：与设计稿一致，分为「工作区」「执行」两组；脚本入口位于「执行」分组。
const WORKSPACE_NAV: NavItem[] = [
  { id: 'overview', label: '概览', icon: 'overview' },
  { id: 'requirement', label: '需求', icon: 'requirement' },
  { id: 'feedback', label: '反馈', icon: 'feedback' },
  // 「验收」排在「反馈」之下：人工对已完成计划/任务逐项验收（与循环自动验收阶段正交）。
  { id: 'acceptance', label: '验收', icon: 'acceptance' },
];

const EXEC_NAV: NavItem[] = [
  { id: 'tasks', label: '任务与计划', icon: 'tasks' },
  { id: 'scripts', label: '脚本', icon: 'script' },
  { id: 'events', label: '事件流', icon: 'events' },
  { id: 'settings', label: '设置', icon: 'settings' },
];

const NAV_GROUPS: Array<{ label: string; items: NavItem[] }> = [
  { label: '工作区', items: WORKSPACE_NAV },
  { label: '执行', items: EXEC_NAV },
];

// 工作区路径渲染为链接样式（主题色文字 + 指针光标 + 悬停下划线）；点击仍走 openProjectFolder。
// 链接外观由 .project-path-link 提供，复用 .project-path 的等宽字体与省略号。

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
  scriptCount = 0,
  onSwitchProject,
}: {
  activeTab: WorkspaceTab;
  onTab: (tab: WorkspaceTab) => void;
  onBack: () => void;
  projectId: number;
  projects: Project[];
  currentProject: Project | null;
  state: ProjectState | null;
  scriptCount?: number;
  onSwitchProject: (id: number) => void;
}) {
  const openFolder = async () => {
    try {
      const result = await window.autoplan.openProjectFolder({ projectId });
      if (!result.ok) {
        window.alert(result.error || '无法打开工作区文件夹');
      }
    } catch (e) {
      window.alert(e instanceof Error ? e.message : String(e));
    }
  };

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
        {currentProject ? (
          <button
            type="button"
            className="project-path project-path-link mono"
            disabled={!currentProject.workspace_path}
            onClick={() => {
              if (currentProject.workspace_path) void openFolder();
            }}
            title={currentProject.workspace_path ? '在系统文件夹中打开' : undefined}
          >
            {currentProject.workspace_path || '未设置工作区'}
          </button>
        ) : null}
      </div>

      {NAV_GROUPS.map((group) => (
        <Fragment key={group.label}>
          <div className="nav-group-label">{group.label}</div>
          {group.items.map((tab) => {
            const badge = tab.id === 'scripts' && scriptCount > 0 ? scriptCount : undefined;
            return (
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
                {badge !== undefined ? <span className="nav-badge">{badge}</span> : null}
              </button>
            );
          })}
        </Fragment>
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
