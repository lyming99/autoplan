import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { Conversation, Project, ProjectState, WorkspaceChatState, WorkspaceTab } from '../../types';
import { useTheme } from '../../hooks/useTheme';
import { Icon, type IconName } from '../icons';
import {
  agentCliProviderLabel,
  codexReasoningEffortLabel,
  readAgentCliProvider,
  readCodexReasoningEffort,
} from '../shared';

type NavItem = { id: WorkspaceTab; label: string; icon: IconName };
type SidebarChatState = WorkspaceChatState & {
  createConversation: (options?: { activate?: boolean }) => Promise<void>;
};

// 导航分组：与设计稿一致，分为「工作区」「执行」两组；脚本入口位于「执行」分组。
const WORKSPACE_NAV: NavItem[] = [
  { id: 'overview', label: '概览', icon: 'overview' },
  { id: 'requirement', label: '需求', icon: 'requirement' },
  { id: 'feedback', label: '反馈', icon: 'feedback' },
  // 「验收」排在「反馈」之下：人工对已完成计划/任务逐项验收（与循环自动验收阶段正交）。
  { id: 'acceptance', label: '验收', icon: 'acceptance' },
  { id: 'chat', label: '对话', icon: 'chat' },
];

const EXEC_NAV: NavItem[] = [
  { id: 'tasks', label: '计划与任务', icon: 'tasks' },
  { id: 'scripts', label: '脚本', icon: 'script' },
  { id: 'events', label: '事件流', icon: 'events' },
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

export const WorkspaceSidebar = memo(function WorkspaceSidebar({
  activeTab,
  onTab,
  onBack,
  projectId,
  projects,
  currentProject,
  state,
  terminalCount = 0,
  executorCount = 0,
  scriptCount = 0,
  onSwitchProject,
  chatState,
  resizing = false,
  onResizePointerDown,
  onResizeReset,
}: {
  activeTab: WorkspaceTab;
  onTab: (tab: WorkspaceTab) => void;
  onBack: () => void;
  projectId: number;
  projects: Project[];
  currentProject: Project | null;
  state: ProjectState | null;
  terminalCount?: number;
  executorCount?: number;
  scriptCount?: number;
  onSwitchProject: (id: number) => void;
  chatState?: WorkspaceChatState;
  resizing?: boolean;
  onResizePointerDown?: (event: ReactPointerEvent<HTMLElement>) => void;
  onResizeReset?: () => void;
}) {
  const { resolved: theme, setTheme } = useTheme();
  const [chatExpanded, setChatExpanded] = useState(true);
  const [visibleConversationCount, setVisibleConversationCount] = useState(5);
  const [sidebarConversations, setSidebarConversations] = useState<Conversation[]>(() => chatState?.conversations ?? []);
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [openMenuId, setOpenMenuId] = useState<number | null>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;

  const themeIcon = theme === 'dark' ? 'moon' : 'sun';
  const nextTheme = theme === 'dark' ? 'light' : 'dark';
  const themeLabel = theme === 'dark' ? '深色模式' : '浅色模式';
  const nextThemeLabel = nextTheme === 'dark' ? '深色模式' : '浅色模式';

  const cycleTheme = useCallback(() => {
    setTheme(nextTheme);
  }, [nextTheme, setTheme]);

  useEffect(() => {
    setSidebarConversations((current) =>
      mergeSidebarConversations(current, chatState?.conversations ?? []),
    );
  }, [chatState?.conversations]);

  useEffect(() => {
    setSidebarConversations([]);
    setVisibleConversationCount(5);
    setOpenMenuId(null);
    setRenamingId(null);
    setRenameValue('');
  }, [projectId]);

  useEffect(() => {
    if (activeTab === 'chat') setChatExpanded(true);
  }, [activeTab]);

  useEffect(() => {
    if (renamingId !== null) {
      window.setTimeout(() => {
        renameInputRef.current?.focus();
        renameInputRef.current?.select();
      }, 0);
    }
  }, [renamingId]);

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

  const openTerminal = async () => {
    try {
      const result = await window.autoplan.openProjectTerminal({ projectId });
      if (!result.ok) window.alert(result.error || '无法启动系统终端');
    } catch (error) {
      window.alert(error instanceof Error ? error.message : String(error));
    }
  };

  const openLogs = async () => {
    try {
      const result = await window.autoplan.openLogFolder();
      if (!result.ok) window.alert('无法打开日志文件夹');
    } catch (error) {
      window.alert(error instanceof Error ? error.message : String(error));
    }
  };

  const beginRenameConversation = useCallback((conversation: Conversation) => {
    setOpenMenuId(null);
    setRenamingId(conversation.id);
    setRenameValue(conversation.title || '新对话');
  }, []);

  const cancelRenameConversation = useCallback(() => {
    setRenamingId(null);
    setRenameValue('');
  }, []);

  const commitRenameConversation = useCallback(
    async (conversation: Conversation) => {
      const title = renameValue.trim();
      cancelRenameConversation();
      if (!title || title === conversation.title) return;

      setSidebarConversations((items) =>
        items.map((item) => (item.id === conversation.id ? { ...item, title } : item)),
      );
      await chatState?.renameConversation(conversation.id, title);
    },
    [cancelRenameConversation, chatState, renameValue],
  );

  const selectConversation = useCallback(
    (conversationId: number) => {
      setOpenMenuId(null);
      onTab('chat');
      void chatState?.switchConversation(conversationId);
    },
    [chatState, onTab],
  );

  const createConversation = useCallback(() => {
    setOpenMenuId(null);
    void (chatState as SidebarChatState | undefined)?.createConversation({ activate: false });
  }, [chatState]);

  const deleteConversation = useCallback(
    (conversation: Conversation) => {
      setOpenMenuId(null);
      if (!window.confirm('确认删除该对话？关联的消息将被清空。')) return;
      setSidebarConversations((items) => items.filter((item) => item.id !== conversation.id));
      void chatState?.deleteConversation(conversation.id);
    },
    [chatState],
  );

  const togglePinnedConversation = useCallback(async (conversation: Conversation) => {
    setOpenMenuId(null);
    const nextPinned = !isConversationPinned(conversation);
    const optimisticPinnedAt = nextPinned ? new Date().toISOString() : null;
    setSidebarConversations((items) =>
      sortConversations(
        items.map((item) =>
          item.id === conversation.id
            ? { ...item, pinned: nextPinned, pinnedAt: optimisticPinnedAt, pinned_at: optimisticPinnedAt }
            : item,
        ),
      ),
    );

    try {
      const updated = await window.autoplan.conversationUpdate({
        projectId,
        conversationId: conversation.id,
        pinned: nextPinned,
      });
      if (projectIdRef.current !== projectId) return;
      setSidebarConversations((items) =>
        sortConversations(items.map((item) => (item.id === conversation.id ? { ...item, ...updated } : item))),
      );
    } catch {
      if (projectIdRef.current !== projectId) return;
      setSidebarConversations(sortConversations(chatState?.conversations ?? []));
    }
  }, [chatState?.conversations, projectId]);

  const chatConversations = useMemo(
    () => sortConversations(
      sidebarConversations.filter((conversation) => readConversationProjectId(conversation) === projectId),
    ),
    [projectId, sidebarConversations],
  );
  const visibleChatConversations = chatConversations.slice(0, visibleConversationCount);
  const hasMoreConversations = chatConversations.length > visibleConversationCount;

  return (
    <aside className={`sidebar${resizing ? ' is-resizing' : ''}`}>
      <div className="brand">
        <div className="brand-mark">A</div>
        <div className="brand-copy">
          <div className="brand-name">AutoPlan</div>
          <div className="brand-sub">需求 · 计划 · 执行 · 验收</div>
        </div>
        <button
          type="button"
          className="sidebar-theme-btn"
          title={`当前${themeLabel}，点击切换为${nextThemeLabel}`}
          aria-label={`当前${themeLabel}，点击切换为${nextThemeLabel}`}
          onClick={cycleTheme}
        >
          <Icon name={themeIcon} size={17} aria-hidden="true" />
        </button>
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
          onChange={(event) => {
            event.currentTarget.blur();
            onSwitchProject(Number(event.target.value));
          }}
        >
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
        {currentProject ? (
          <div className="project-path-row">
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
            <button
              type="button"
              className="project-terminal-btn"
              disabled={!currentProject.workspace_path}
              onClick={() => {
                if (currentProject.workspace_path) void openTerminal();
              }}
              title="在此项目文件夹打开系统终端"
              aria-label="在此项目文件夹打开系统终端"
            >
              <Icon name="terminal" size={15} aria-hidden />
            </button>
          </div>
        ) : null}
      </div>

      <nav className="sidebar-nav" aria-label="工作区导航">
      {NAV_GROUPS.map((group) => (
        <Fragment key={group.label}>
          <div className="nav-group-label">{group.label}</div>
          {group.items.map((tab) => {
            const badge = tab.id === 'terminal' && terminalCount > 0
              ? terminalCount
              : tab.id === 'executors' && executorCount > 0
                ? executorCount
                : tab.id === 'scripts' && scriptCount > 0
                  ? scriptCount
                  : undefined;
            if (tab.id === 'chat') {
              return (
                <div className="nav-chat-block" key={tab.id}>
                  <div className="nav-chat-row">
                    <button
                      className={`nav-item nav-item--chat nav-item--collapsible ${chatExpanded ? 'expanded' : ''}`}
                      type="button"
                      onClick={() => setChatExpanded((value) => !value)}
                      aria-expanded={chatExpanded}
                    >
                      <span className="nav-ico">
                        <Icon name={tab.icon} size={18} aria-hidden="true" />
                      </span>
                      <span>{tab.label}</span>
                    </button>
                    <button
                      type="button"
                      className="nav-add-btn"
                      onClick={(event) => {
                        event.stopPropagation();
                        createConversation();
                      }}
                      aria-label="新建对话"
                      title="新建对话"
                    >
                      <Icon name="plus" size={16} aria-hidden />
                    </button>
                  </div>
                  {chatExpanded ? (
                    <div className="nav-subgroup" aria-label="对话列表">
                      {visibleChatConversations.length === 0 ? (
                        <div className="nav-sub-empty">暂无对话</div>
                      ) : (
                        visibleChatConversations.map((conversation) => {
                          const isActive = activeTab === 'chat' && conversation.id === chatState?.activeConversationId;
                          const pinned = isConversationPinned(conversation);
                          const updatedAt = readConversationUpdatedAt(conversation);
                          const relativeTime = updatedAt ? chatState?.formatRelativeTime(updatedAt) || updatedAt : '';
                          const metaText = relativeTime;
                          return (
                            <div
                              className={`nav-sub-item ${isActive ? 'active' : ''}`}
                              key={conversation.id}
                            >
                              {renamingId === conversation.id ? (
                                <input
                                  ref={renameInputRef}
                                  className="nav-sub-rename-input"
                                  value={renameValue}
                                  onChange={(event) => setRenameValue(event.target.value)}
                                  onBlur={() => { void commitRenameConversation(conversation); }}
                                  onKeyDown={(event) => {
                                    if (event.key === 'Enter') {
                                      event.preventDefault();
                                      void commitRenameConversation(conversation);
                                    }
                                    if (event.key === 'Escape') {
                                      event.preventDefault();
                                      cancelRenameConversation();
                                    }
                                  }}
                                  aria-label="重命名对话"
                                />
                              ) : (
                                <>
                                  <button
                                    type="button"
                                    className={`nav-sub-item__pin${pinned ? ' pinned' : ''}`}
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      void togglePinnedConversation(conversation);
                                    }}
                                    aria-label={pinned ? '取消置顶对话' : '置顶对话'}
                                    title={pinned ? '取消置顶' : '置顶'}
                                  >
                                    <Icon name="pin" size={14} aria-hidden />
                                  </button>
                                  <button
                                    type="button"
                                    className="nav-sub-item__main"
                                    onClick={() => selectConversation(conversation.id)}
                                    aria-current={isActive ? 'page' : undefined}
                                    title={metaText}
                                  >
                                    <span className="nav-sub-item__title">{conversation.title || '新对话'}</span>
                                    <span className="nav-sub-item__meta">{metaText}</span>
                                  </button>
                                  <div
                                    className="nav-sub-item__actions"
                                    onClick={(event) => event.stopPropagation()}
                                    onBlur={(event) => {
                                      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                                        setOpenMenuId(null);
                                      }
                                    }}
                                  >
                                    <div className="nav-sub-item__menu-wrap">
                                      <button
                                        type="button"
                                        className="nav-sub-item__menu-trigger"
                                        onClick={() => setOpenMenuId((current) => (current === conversation.id ? null : conversation.id))}
                                        aria-expanded={openMenuId === conversation.id}
                                        aria-label="打开对话操作菜单"
                                        title="更多操作"
                                      >
                                        <Icon name="more-horizontal" size={15} aria-hidden />
                                      </button>
                                      {openMenuId === conversation.id ? (
                                        <div className="nav-sub-item__menu open" role="menu">
                                          <button
                                            type="button"
                                            role="menuitem"
                                            className="nav-sub-item__menu-item"
                                            onClick={() => { void togglePinnedConversation(conversation); }}
                                          >
                                            <Icon name="pin" size={14} aria-hidden />
                                            {pinned ? '取消置顶' : '置顶'}
                                          </button>
                                          <button
                                            type="button"
                                            role="menuitem"
                                            className="nav-sub-item__menu-item"
                                            onClick={() => beginRenameConversation(conversation)}
                                          >
                                            <Icon name="edit" size={14} aria-hidden />
                                            重命名
                                          </button>
                                          <button
                                            type="button"
                                            role="menuitem"
                                            className="nav-sub-item__menu-item nav-sub-item__menu-item--danger"
                                            onClick={() => deleteConversation(conversation)}
                                          >
                                            <Icon name="trash" size={14} aria-hidden />
                                            删除对话
                                          </button>
                                        </div>
                                      ) : null}
                                    </div>
                                  </div>
                                </>
                              )}
                            </div>
                          );
                        })
                      )}
                      {hasMoreConversations ? (
                        <button
                          type="button"
                          className="nav-sub-more"
                          onClick={() => setVisibleConversationCount((count) => count + 5)}
                        >
                          加载更多对话
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              );
            }
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
      </nav>

      <div className="sidebar-footer">
        <div className="sidebar-footer-main">
          <div className="sidebar-footer-status">
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
          <div className="sidebar-footer-actions">
            <button
              type="button"
              className="sidebar-settings-btn"
              title="打开系统日志文件夹"
              aria-label="打开系统日志文件夹"
              onClick={() => { void openLogs(); }}
            >
              <Icon name="folder" size={16} aria-hidden="true" />
            </button>
            <button
              type="button"
              className={`sidebar-settings-btn${activeTab === 'settings' ? ' active' : ''}`}
              title="打开设置"
              aria-label="打开设置"
              aria-current={activeTab === 'settings' ? 'page' : undefined}
              onClick={() => onTab('settings')}
            >
              <Icon name="settings" size={16} aria-hidden="true" />
            </button>
          </div>
        </div>
      </div>
      <button
        type="button"
        className="sidebar-resizer"
        aria-label="拖拽调整导航栏宽度"
        title="拖拽调整导航栏宽度，双击恢复默认"
        onPointerDown={onResizePointerDown}
        onDoubleClick={onResizeReset}
      />
    </aside>
  );
});

function isConversationPinned(conversation: Conversation) {
  return Boolean(conversation.pinnedAt ?? conversation.pinned_at ?? conversation.pinned);
}

function readConversationUpdatedAt(conversation: Conversation) {
  return conversation.updated_at || conversation.updatedAt || '';
}

function readConversationProjectId(conversation: Conversation) {
  return Number(conversation.projectId ?? conversation.project_id ?? 0);
}

function mergeSidebarConversations(current: Conversation[], incoming: Conversation[]) {
  const currentById = new Map(current.map((conversation) => [conversation.id, conversation]));
  return sortConversations(
    incoming.map((conversation) => {
      const existing = currentById.get(conversation.id);
      if (!existing) return conversation;

      const pinnedAt = existing.pinnedAt ?? existing.pinned_at ?? null;
      const pinned = Boolean(pinnedAt ?? existing.pinned);
      return {
        ...conversation,
        pinned,
        pinnedAt,
        pinned_at: pinnedAt,
      };
    }),
  );
}

function sortConversations(conversations: Conversation[]) {
  return [...conversations].sort((a, b) => {
    const pinnedDelta = Number(!isConversationPinned(a)) - Number(!isConversationPinned(b));
    if (pinnedDelta !== 0) return pinnedDelta;

    const updatedA = readConversationUpdatedAt(a);
    const updatedB = readConversationUpdatedAt(b);
    if (updatedA < updatedB) return 1;
    if (updatedA > updatedB) return -1;
    return b.id - a.id;
  });
}
