import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal as XTerm } from '@xterm/xterm';
import type { IDisposable } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import type { Executor, Script, TerminalProfileInput, TerminalSession } from '../../types';
import {
  isTerminalActive,
  useTerminalSessions,
  type UseTerminalSessionsResult,
} from '../../hooks/useTerminalSessions';
import {
  buildTerminalCommandShortcuts,
  loadTerminalSettings,
  normalizeTerminalSettingsForm,
  saveTerminalSettings,
  terminalCreateInputFromSettings,
  terminalShortcutCommandText,
  type TerminalCommandShortcut,
  type TerminalPackageScriptsInput,
  type TerminalSettingsFormState,
} from '../../utils/workspaceForms';
import { Icon } from '../icons';

type TerminalProfileChoice = {
  id: string;
  label: string;
  profile?: TerminalProfileInput;
};

const PROFILE_CHOICES: TerminalProfileChoice[] = [
  { id: 'default', label: '默认' },
  {
    id: 'powershell',
    label: 'PowerShell',
    profile: { id: 'powershell', name: 'PowerShell', kind: 'custom', shellPath: 'powershell.exe', args: ['-NoLogo'] },
  },
  {
    id: 'cmd',
    label: 'cmd',
    profile: { id: 'cmd', name: 'Command Prompt', kind: 'custom', shellPath: 'cmd.exe', args: [] },
  },
  {
    id: 'bash',
    label: 'bash',
    profile: { id: 'bash', name: 'bash', kind: 'custom', shellPath: 'bash', args: [] },
  },
];

const EMPTY_TERMINALS: TerminalSession[] = [];
const EMPTY_SCRIPTS: Script[] = [];
const EMPTY_EXECUTORS: Executor[] = [];
const EMPTY_PACKAGE_SCRIPTS: Record<string, string> = {};

export interface WorkspaceTerminalViewProps {
  projectId: number;
  terminals?: TerminalSession[];
  scripts?: Script[];
  executors?: Executor[];
  packageScripts?: TerminalPackageScriptsInput;
  workspacePath?: string;
  className?: string;
  autoRefresh?: boolean;
}

export function WorkspaceTerminalView({
  projectId,
  terminals = EMPTY_TERMINALS,
  scripts = EMPTY_SCRIPTS,
  executors = EMPTY_EXECUTORS,
  packageScripts = EMPTY_PACKAGE_SCRIPTS,
  workspacePath = '',
  className = '',
  autoRefresh = true,
}: WorkspaceTerminalViewProps) {
  const terminal = useTerminalSessions({ projectId, initialSessions: terminals, autoRefresh });
  const initialSettingsRef = useRef<TerminalSettingsFormState | null>(null);
  const initialSettings = initialSettingsRef.current ?? readInitialTerminalSettings(projectId);
  initialSettingsRef.current = initialSettings;
  const [terminalSettings, setTerminalSettings] = useState<TerminalSettingsFormState>(initialSettings);
  const [cwdDraft, setCwdDraft] = useState(initialSettings.initialCwd);
  const [profileId, setProfileId] = useState(initialSettings.defaultProfile);
  const [selectedShortcutId, setSelectedShortcutId] = useState('');
  const [commandDraft, setCommandDraft] = useState('');
  const [renameSessionId, setRenameSessionId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [clearRevision, setClearRevision] = useState(0);
  const [replayRevision, setReplayRevision] = useState(0);
  const activeSession = terminal.activeSession;
  const activeRunning = activeSession ? isTerminalActive(activeSession) : false;
  const commandShortcuts = useMemo(() => buildTerminalCommandShortcuts({
    packageScripts,
    scripts,
    executors,
    workspacePath,
  }), [executors, packageScripts, scripts, workspacePath]);
  const selectedShortcut = commandShortcuts.find((shortcut) => shortcut.id === selectedShortcutId) ?? null;

  useEffect(() => {
    const next = readInitialTerminalSettings(projectId);
    setTerminalSettings(next);
    setCwdDraft(next.initialCwd);
    setProfileId(next.defaultProfile);
    setSelectedShortcutId('');
    setCommandDraft('');
  }, [projectId]);

  useEffect(() => {
    if (selectedShortcutId && !commandShortcuts.some((shortcut) => shortcut.id === selectedShortcutId)) {
      setSelectedShortcutId('');
    }
  }, [commandShortcuts, selectedShortcutId]);

  const updateTerminalSettings = useCallback((patch: Partial<TerminalSettingsFormState>) => {
    setTerminalSettings((current) => {
      const next = normalizeTerminalSettingsForProfiles({ ...current, ...patch });
      return saveTerminalSettings(projectId, next);
    });
  }, [projectId]);

  const updateProfile = useCallback((value: string) => {
    const nextProfile = resolveProfileChoiceId(value);
    setProfileId(nextProfile);
    updateTerminalSettings({ defaultProfile: nextProfile });
  }, [updateTerminalSettings]);

  const updateCwdDraft = useCallback((value: string) => {
    setCwdDraft(value);
    updateTerminalSettings({ initialCwd: value });
  }, [updateTerminalSettings]);

  const createTerminalWithOptions = useCallback(async (input: {
    cwd?: string;
    profileId?: string;
    profile?: TerminalProfileInput;
    title?: string;
  } = {}) => {
    const nextProfileId = resolveProfileChoiceId(input.profileId || profileId);
    const profile = PROFILE_CHOICES.find((item) => item.id === nextProfileId) ?? PROFILE_CHOICES[0];
    const payload = terminalCreateInputFromSettings(projectId, terminalSettings, {
      cwd: (input.cwd ?? cwdDraft.trim()) || undefined,
      profileId: profile.id === 'default' ? undefined : profile.id,
      profile: input.profile ?? profile.profile,
      title: input.title ?? (profile.id === 'default' ? undefined : profile.label),
    });
    if (profile.id === 'default') delete payload.profileId;

    const next = await terminal.createSession(payload);
    if (next) setRenameSessionId(null);
    return next;
  }, [cwdDraft, profileId, projectId, terminal, terminalSettings]);

  const createTerminal = useCallback(async () => {
    await createTerminalWithOptions();
  }, [createTerminalWithOptions]);

  const reconnectTerminal = useCallback(async () => {
    if (!activeSession) return;
    await terminal.createSession(terminalCreateInputFromSettings(projectId, terminalSettings, {
      cwd: activeSession.cwd,
      profile: activeSession.profile,
      title: activeSession.title,
    }));
  }, [activeSession, projectId, terminal, terminalSettings]);

  const selectCommandShortcut = useCallback((shortcutId: string) => {
    setSelectedShortcutId(shortcutId);
    const shortcut = commandShortcuts.find((item) => item.id === shortcutId);
    if (shortcut) setCommandDraft(terminalShortcutCommandText(shortcut));
  }, [commandShortcuts]);

  const insertCommandIntoTerminal = useCallback(async () => {
    const command = commandDraft.trim();
    if (!command) return;
    const target = activeSession && isTerminalActive(activeSession)
      ? activeSession
      : await createTerminalWithOptions({ cwd: selectedShortcut?.cwd || cwdDraft.trim() || undefined });
    if (!target) return;
    await terminal.write(target.id, command);
  }, [activeSession, commandDraft, createTerminalWithOptions, cwdDraft, selectedShortcut, terminal]);

  const startRename = useCallback((session: TerminalSession) => {
    setRenameSessionId(session.id);
    setRenameDraft(session.title || terminalShellName(session) || 'Terminal');
  }, []);

  const commitRename = useCallback(async () => {
    if (!renameSessionId) return;
    const title = renameDraft.trim();
    if (!title) {
      setRenameSessionId(null);
      setRenameDraft('');
      return;
    }
    const renamed = await terminal.rename(renameSessionId, title);
    if (renamed) {
      setRenameSessionId(null);
      setRenameDraft('');
    }
  }, [renameDraft, renameSessionId, terminal]);

  const clearActiveTerminal = useCallback(async () => {
    if (!activeSession) return;
    const cleared = await terminal.clear(activeSession.id);
    if (cleared) setClearRevision((revision) => revision + 1);
  }, [activeSession, terminal]);

  const replayActiveTerminal = useCallback(() => {
    if (activeSession) setReplayRevision((revision) => revision + 1);
  }, [activeSession]);

  const killActiveTerminal = useCallback(async () => {
    if (!activeSession) return;
    if (terminalSettings.confirmBeforeKill && !window.confirm('停止当前终端会话？')) return;
    await terminal.kill(activeSession.id);
  }, [activeSession, terminal, terminalSettings.confirmBeforeKill]);

  const terminalClassName = ['terminal-view', className].filter(Boolean).join(' ');

  return (
    <div className={terminalClassName}>
      <div className="terminal-topbar">
        <div className="terminal-tabs" role="tablist" aria-label="终端会话">
          {terminal.sessions.map((session) => (
            <TerminalTab
              active={session.id === terminal.activeSessionId}
              key={session.id}
              onClose={() => { void terminal.close(session.id); }}
              onRename={() => startRename(session)}
              onSelect={() => terminal.setActiveSessionId(session.id)}
              session={session}
            />
          ))}
          <button
            type="button"
            className="terminal-tab terminal-tab--new"
            onClick={createTerminal}
            disabled={terminal.busyAction === 'create'}
            title="新建终端"
            aria-label="新建终端"
          >
            <Icon name="plus" size={15} aria-hidden />
          </button>
        </div>
        <div className="terminal-top-actions">
          <button type="button" className="terminal-icon-btn" onClick={() => { void terminal.refresh(); }} title="刷新会话" aria-label="刷新会话">
            <Icon name="refresh" size={15} aria-hidden />
          </button>
          <button
            type="button"
            className="terminal-icon-btn"
            onClick={() => {
              if (!activeSession) return;
              startRename(activeSession);
            }}
            disabled={!activeSession}
            title="重命名"
            aria-label="重命名"
          >
            <Icon name="edit" size={15} aria-hidden />
          </button>
          <button
            type="button"
            className="terminal-icon-btn"
            onClick={replayActiveTerminal}
            disabled={!activeSession}
            title="回放输出"
            aria-label="回放输出"
          >
            <Icon name="history" size={15} aria-hidden />
          </button>
        </div>
      </div>

      <div className="terminal-meta-bar">
        <div className="terminal-current">
          <span className={`terminal-status-dot ${activeRunning ? 'running' : 'stopped'}`} />
          <span className="terminal-current-title">{activeSession ? terminalTitle(activeSession) : '未选择终端'}</span>
          <span className="terminal-current-meta">{activeSession ? terminalSessionMeta(activeSession) : workspacePath || '未设置工作区'}</span>
        </div>
        {renameSessionId ? (
          <form
            className="terminal-rename-form"
            onSubmit={(event) => {
              event.preventDefault();
              void commitRename();
            }}
          >
            <input
              value={renameDraft}
              onChange={(event) => setRenameDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault();
                  setRenameSessionId(null);
                  setRenameDraft('');
                }
              }}
              autoFocus
              aria-label="终端名称"
            />
            <button type="submit" className="terminal-mini-btn">保存</button>
          </form>
        ) : null}
      </div>

      {terminal.error ? (
        <div className="terminal-error" role="status">
          <span>{terminal.error}</span>
          <button type="button" className="btn-link" onClick={terminal.clearError}>关闭</button>
        </div>
      ) : null}

      <TerminalPane
        activeSession={activeSession}
        clearRevision={clearRevision}
        replayRevision={replayRevision}
        settings={terminalSettings}
        terminal={terminal}
        onCreate={createTerminal}
      />

      <div className="terminal-controlbar terminal-commandbar">
        <label className="terminal-field terminal-field--shortcut">
          <span>快捷命令</span>
          <select value={selectedShortcutId} onChange={(event) => selectCommandShortcut(event.target.value)}>
            <option value="">选择快捷入口</option>
            {commandShortcuts.map((shortcut) => (
              <option key={shortcut.id} value={shortcut.id}>
                {shortcut.label}
              </option>
            ))}
          </select>
        </label>
        <label className="terminal-field terminal-field--command">
          <span>命令</span>
          <input
            value={commandDraft}
            onChange={(event) => setCommandDraft(event.target.value)}
            placeholder="npm run dev"
          />
        </label>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => { void insertCommandIntoTerminal(); }}
          disabled={!commandDraft.trim() || terminal.busyAction === 'write' || terminal.busyAction === 'create'}
          title={selectedShortcut ? terminalShortcutTitle(selectedShortcut) : '插入到当前终端'}
        >
          <Icon name="terminal" size={14} aria-hidden />
          插入
        </button>
      </div>

      <div className="terminal-controlbar">
        <label className="terminal-field terminal-field--cwd">
          <span>cwd</span>
          <input
            value={cwdDraft}
            onChange={(event) => updateCwdDraft(event.target.value)}
            placeholder={workspacePath || '${workspace}'}
          />
        </label>
        <label className="terminal-field terminal-field--profile">
          <span>profile</span>
          <select value={profileId} onChange={(event) => updateProfile(event.target.value)}>
            {PROFILE_CHOICES.map((profile) => (
              <option key={profile.id} value={profile.id}>{profile.label}</option>
            ))}
          </select>
        </label>
        <label className="terminal-field terminal-field--compact">
          <span>font</span>
          <input
            type="number"
            min={10}
            max={24}
            value={terminalSettings.fontSize}
            onChange={(event) => updateTerminalSettings({ fontSize: event.target.value })}
          />
        </label>
        <label className="terminal-field terminal-field--compact">
          <span>scroll</span>
          <input
            type="number"
            min={100}
            max={50000}
            step={500}
            value={terminalSettings.scrollbackLimit}
            onChange={(event) => updateTerminalSettings({ scrollbackLimit: event.target.value })}
          />
        </label>
        <label className="terminal-field terminal-field--check">
          <span>保留</span>
          <input
            type="checkbox"
            checked={terminalSettings.retainOnExit}
            onChange={(event) => updateTerminalSettings({ retainOnExit: event.target.checked })}
          />
        </label>
        <label className="terminal-field terminal-field--check">
          <span>确认</span>
          <input
            type="checkbox"
            checked={terminalSettings.confirmBeforeKill}
            onChange={(event) => updateTerminalSettings({ confirmBeforeKill: event.target.checked })}
          />
        </label>
        <button type="button" className="btn btn-primary btn-sm" onClick={createTerminal} disabled={terminal.busyAction === 'create'}>
          <Icon name="plus" size={14} aria-hidden />
          新建
        </button>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => { void clearActiveTerminal(); }}
          disabled={!activeSession}
        >
          <Icon name="clear" size={14} aria-hidden />
          清屏
        </button>
        <button
          type="button"
          className="btn btn-sm"
          onClick={reconnectTerminal}
          disabled={!activeSession}
        >
          <Icon name="terminal" size={14} aria-hidden />
          重连
        </button>
        <button
          type="button"
          className="btn btn-danger btn-sm"
          onClick={() => { void killActiveTerminal(); }}
          disabled={!activeSession || !activeRunning}
        >
          <Icon name="stop" size={14} aria-hidden />
          停止
        </button>
      </div>
    </div>
  );
}

function TerminalPane({
  activeSession,
  clearRevision,
  replayRevision,
  settings,
  terminal,
  onCreate,
}: {
  activeSession: TerminalSession | null;
  clearRevision: number;
  replayRevision: number;
  settings: TerminalSettingsFormState;
  terminal: UseTerminalSessionsResult;
  onCreate: () => Promise<void>;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const resizeFrameRef = useRef<number | null>(null);
  const lastSizeRef = useRef('');
  const terminalRef = useRef(terminal);
  terminalRef.current = terminal;

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !activeSession) return undefined;

    host.textContent = '';
    lastSizeRef.current = '';
    const xterm = new XTerm({
      allowTransparency: false,
      convertEol: true,
      cursorBlink: true,
      cursorStyle: 'bar',
      disableStdin: !isTerminalActive(activeSession),
      drawBoldTextInBrightColors: true,
      fontFamily: "var(--font-mono, ui-monospace, 'Cascadia Code', 'Fira Code', monospace)",
      fontSize: Number(settings.fontSize || 13),
      lineHeight: 1.18,
      scrollback: Number(settings.scrollbackLimit || 10000),
      tabStopWidth: 4,
      theme: readTerminalTheme(host),
    });
    const fitAddon = new FitAddon();
    xterm.loadAddon(fitAddon);
    xterm.open(host);
    xterm.focus();
    xtermRef.current = xterm;
    fitAddonRef.current = fitAddon;

    let disposed = false;
    const resize = () => {
      if (disposed || !host.isConnected) return;
      if (resizeFrameRef.current !== null) window.cancelAnimationFrame(resizeFrameRef.current);
      resizeFrameRef.current = window.requestAnimationFrame(() => {
        resizeFrameRef.current = null;
        if (disposed) return;
        try {
          fitAddon.fit();
          const sizeKey = `${activeSession.id}:${xterm.cols}:${xterm.rows}`;
          if (sizeKey !== lastSizeRef.current && xterm.cols > 0 && xterm.rows > 0) {
            lastSizeRef.current = sizeKey;
            void terminalRef.current.resize(activeSession.id, xterm.cols, xterm.rows);
          }
        } catch {
          /* xterm fit can fail while the pane is hidden or has zero size. */
        }
      });
    };

    const dataDisposable: IDisposable = xterm.onData((data) => {
      void terminalRef.current.write(activeSession.id, data);
    });
    const unsubscribeData = terminalRef.current.subscribeData(activeSession.id, (data) => {
      if (!disposed) xterm.write(data);
    });
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(host);

    resize();
    void terminalRef.current.replay(activeSession.id).then((result) => {
      if (disposed || !result?.ok) return;
      const data = result.data || result.chunks.join('');
      if (data) xterm.write(data);
      resize();
    });

    return () => {
      disposed = true;
      if (resizeFrameRef.current !== null) {
        window.cancelAnimationFrame(resizeFrameRef.current);
        resizeFrameRef.current = null;
      }
      resizeObserver.disconnect();
      unsubscribeData();
      dataDisposable.dispose();
      xterm.dispose();
      xtermRef.current = null;
      fitAddonRef.current = null;
    };
  }, [activeSession?.id, settings.fontSize, settings.scrollbackLimit]);

  useEffect(() => {
    if (!activeSession || !xtermRef.current) return;
    xtermRef.current.options.disableStdin = !isTerminalActive(activeSession);
  }, [activeSession]);

  useEffect(() => {
    if (clearRevision > 0) xtermRef.current?.clear();
  }, [clearRevision]);

  useEffect(() => {
    const xterm = xtermRef.current;
    if (replayRevision <= 0 || !activeSession || !xterm) return;
    let disposed = false;
    xterm.clear();
    void terminalRef.current.replay(activeSession.id).then((result) => {
      if (disposed) return;
      if (!result?.ok) return;
      const data = result.data || result.chunks.join('');
      if (data) xterm.write(data);
    });
    return () => {
      disposed = true;
    };
  }, [activeSession?.id, replayRevision]);

  const empty = !activeSession;
  return (
    <div className={`terminal-pane${empty ? ' is-empty' : ''}`}>
      {empty ? (
        <div className="terminal-empty">
          <span className="terminal-empty-icon">
            <Icon name="terminal" size={30} aria-hidden />
          </span>
          <h3>暂无终端会话</h3>
          <button type="button" className="btn btn-primary btn-sm" onClick={() => { void onCreate(); }}>
            <Icon name="plus" size={14} aria-hidden />
            新建终端
          </button>
        </div>
      ) : null}
      <div className="terminal-screen" ref={hostRef} aria-label="终端输出" />
    </div>
  );
}

function TerminalTab({
  active,
  onClose,
  onRename,
  onSelect,
  session,
}: {
  active: boolean;
  onClose: () => void;
  onRename: () => void;
  onSelect: () => void;
  session: TerminalSession;
}) {
  const running = isTerminalActive(session);
  return (
    <div className={`terminal-tab-wrap${active ? ' active' : ''}`}>
      <button
        type="button"
        className="terminal-tab"
        role="tab"
        aria-selected={active}
        title={session.cwd}
        onDoubleClick={onRename}
        onClick={onSelect}
      >
        <span className={`terminal-tab-dot ${running ? 'running' : 'stopped'}`} />
        <span className="terminal-tab-title">{terminalTitle(session)}</span>
      </button>
      <button type="button" className="terminal-tab-close" onClick={onClose} title="关闭终端" aria-label="关闭终端">
        <Icon name="close" size={12} aria-hidden />
      </button>
    </div>
  );
}

function readInitialTerminalSettings(projectId: number) {
  return normalizeTerminalSettingsForProfiles(loadTerminalSettings(projectId));
}

function normalizeTerminalSettingsForProfiles(settings: Partial<TerminalSettingsFormState>) {
  const normalized = normalizeTerminalSettingsForm(settings);
  return {
    ...normalized,
    defaultProfile: resolveProfileChoiceId(normalized.defaultProfile),
  };
}

function resolveProfileChoiceId(profileId: string) {
  const id = String(profileId || '').trim().toLowerCase();
  return PROFILE_CHOICES.some((profile) => profile.id === id) ? id : PROFILE_CHOICES[0].id;
}

function terminalShortcutTitle(shortcut: TerminalCommandShortcut) {
  return [shortcut.description, shortcut.cwd, shortcut.command].filter(Boolean).join(' · ');
}

function terminalTitle(session: TerminalSession) {
  return session.title || terminalShellName(session) || 'Terminal';
}

function terminalShellName(session: TerminalSession) {
  const profileName = String(session.profile?.name || '').trim();
  if (profileName) return profileName;
  const shell = String(session.shell || session.profile?.shellPath || '').trim();
  return shell.split(/[\\/]/).filter(Boolean).pop() || shell;
}

function terminalSessionMeta(session: TerminalSession) {
  const shell = terminalShellName(session);
  const cwd = session.cwd || '';
  const size = session.cols && session.rows ? `${session.cols}x${session.rows}` : '';
  const exit = session.endedAt ? `退出码 ${session.exitCode ?? '-'}` : '';
  return [shell, cwd, size, exit].filter(Boolean).join(' · ');
}

function readTerminalTheme(host: HTMLElement) {
  const style = window.getComputedStyle(host);
  const read = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  return {
    background: read('--terminal-bg', '#0e1118'),
    foreground: read('--terminal-fg', '#dce4f4'),
    cursor: read('--terminal-cursor', '#8fb3ff'),
    selectionBackground: read('--terminal-selection', '#2f4f85'),
    black: '#0e1118',
    red: '#ff7a85',
    green: '#8bdc9b',
    yellow: '#ffd166',
    blue: '#8fb3ff',
    magenta: '#d8a6ff',
    cyan: '#73d6d0',
    white: '#dce4f4',
    brightBlack: '#6d7485',
    brightRed: '#ff9aa3',
    brightGreen: '#a6f2b5',
    brightYellow: '#ffe08a',
    brightBlue: '#aac7ff',
    brightMagenta: '#e5c0ff',
    brightCyan: '#97ebe6',
    brightWhite: '#ffffff',
  };
}
