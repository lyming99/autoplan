import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  TerminalCreateInput,
  TerminalReplayResult,
  TerminalSession,
  TerminalSessionResult,
} from '../types';

export type TerminalBusyAction = 'create' | 'refresh' | 'write' | 'resize' | 'kill' | 'close' | 'rename' | 'clear' | 'replay';
export type TerminalDataHandler = (data: string, session: TerminalSession) => void;

export interface UseTerminalSessionsOptions {
  projectId: number;
  initialSessions?: TerminalSession[];
  autoRefresh?: boolean;
}

export interface UseTerminalSessionsResult {
  sessions: TerminalSession[];
  activeSession: TerminalSession | null;
  activeSessionId: string | null;
  activeCount: number;
  loading: boolean;
  error: string;
  busyAction: TerminalBusyAction | null;
  setActiveSessionId: (sessionId: string | null) => void;
  clearError: () => void;
  refresh: () => Promise<void>;
  createSession: (input?: Partial<TerminalCreateInput>) => Promise<TerminalSession | null>;
  write: (sessionId: string, data: string) => Promise<boolean>;
  resize: (sessionId: string, cols: number, rows: number) => Promise<boolean>;
  kill: (sessionId: string) => Promise<TerminalSession | null>;
  close: (sessionId: string) => Promise<boolean>;
  rename: (sessionId: string, title: string) => Promise<TerminalSession | null>;
  clear: (sessionId: string) => Promise<boolean>;
  replay: (sessionId: string) => Promise<TerminalReplayResult | null>;
  removeLocal: (sessionId: string) => void;
  subscribeData: (sessionId: string, handler: TerminalDataHandler) => () => void;
}

const EMPTY_TERMINAL_SESSIONS: TerminalSession[] = [];

export function useTerminalSessions({
  projectId,
  initialSessions = EMPTY_TERMINAL_SESSIONS,
  autoRefresh = true,
}: UseTerminalSessionsOptions): UseTerminalSessionsResult {
  const [sessions, setSessions] = useState<TerminalSession[]>(() => normalizeSessions(initialSessions, projectId));
  const [activeSessionId, setActiveSessionIdState] = useState<string | null>(() => sessions[0]?.id ?? null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [busyAction, setBusyAction] = useState<TerminalBusyAction | null>(null);
  const projectIdRef = useRef(projectId);
  const dataHandlersRef = useRef(new Map<string, Set<TerminalDataHandler>>());
  projectIdRef.current = projectId;

  const setActiveSessionId = useCallback((sessionId: string | null) => {
    setActiveSessionIdState(sessionId || null);
  }, []);

  const clearError = useCallback(() => setError(''), []);

  const selectExistingSession = useCallback((nextSessions: TerminalSession[]) => {
    setActiveSessionIdState((current) => {
      if (current && nextSessions.some((session) => session.id === current)) return current;
      const running = nextSessions.find(isTerminalActive);
      return running?.id ?? nextSessions[0]?.id ?? null;
    });
  }, []);

  const upsertSession = useCallback((session: TerminalSession | null | undefined) => {
    if (!session || !belongsToProject(session, projectIdRef.current)) return;
    setSessions((current) => {
      const next = sortSessions([
        ...current.filter((item) => item.id !== session.id),
        session,
      ]);
      selectExistingSession(next);
      return next;
    });
  }, [selectExistingSession]);

  const refresh = useCallback(async () => {
    const requestProjectId = projectId;
    if (!isValidProjectId(requestProjectId)) {
      setSessions([]);
      setActiveSessionIdState(null);
      return;
    }

    setLoading(true);
    setBusyAction('refresh');
    try {
      const result = await window.autoplan.listTerminals({ projectId: requestProjectId });
      if (projectIdRef.current !== requestProjectId) return;
      if (!result.ok) {
        setError(result.message || '读取终端会话失败');
        setSessions([]);
        setActiveSessionIdState(null);
        return;
      }
      const nextSessions = normalizeSessions(result.sessions, requestProjectId);
      setSessions(nextSessions);
      selectExistingSession(nextSessions);
    } catch (err) {
      if (projectIdRef.current === requestProjectId) setError(errorMessage(err, '读取终端会话失败'));
    } finally {
      if (projectIdRef.current === requestProjectId) {
        setLoading(false);
        setBusyAction((current) => (current === 'refresh' ? null : current));
      }
    }
  }, [projectId, selectExistingSession]);

  useEffect(() => {
    const normalized = normalizeSessions(initialSessions, projectId);
    setSessions((current) => {
      const next = mergeSessions(current, normalized, projectId);
      if (sameSessionList(current, next)) {
        selectExistingSession(current);
        return current;
      }
      selectExistingSession(next);
      return next;
    });
  }, [initialSessions, projectId, selectExistingSession]);

  useEffect(() => {
    setSessions(normalizeSessions(initialSessions, projectId));
    selectExistingSession(normalizeSessions(initialSessions, projectId));
    setError('');
    if (autoRefresh) void refresh();
  }, [autoRefresh, projectId, refresh, selectExistingSession]);

  useEffect(() => {
    const unsubscribeData = window.autoplan.onTerminalData((event) => {
      if (!event.session || !belongsToProject(event.session, projectIdRef.current)) return;
      upsertSession(event.session);
      const data = String(event.data ?? '');
      if (!data) return;
      const handlers = dataHandlersRef.current.get(event.session.id);
      if (!handlers || handlers.size === 0) return;
      handlers.forEach((handler) => handler(data, event.session));
    });
    const unsubscribeExit = window.autoplan.onTerminalExit((event) => upsertSession(event.session));
    const unsubscribeStatus = window.autoplan.onTerminalStatus((event) => upsertSession(event.session));
    return () => {
      unsubscribeData();
      unsubscribeExit();
      unsubscribeStatus();
    };
  }, [upsertSession]);

  const createSession = useCallback(async (input: Partial<TerminalCreateInput> = {}) => {
    if (!isValidProjectId(projectId)) {
      setError('项目不存在');
      return null;
    }
    setBusyAction('create');
    try {
      const payload: TerminalCreateInput = {
        projectId,
        ...input,
      };
      const result = await window.autoplan.createTerminal(payload);
      if (projectIdRef.current !== projectId) return null;
      const session = sessionFromResult(result, '创建终端失败', setError);
      if (!session) return null;
      upsertSession(session);
      setActiveSessionIdState(session.id);
      return session;
    } catch (err) {
      if (projectIdRef.current === projectId) setError(errorMessage(err, '创建终端失败'));
      return null;
    } finally {
      if (projectIdRef.current === projectId) setBusyAction((current) => (current === 'create' ? null : current));
    }
  }, [projectId, upsertSession]);

  const write = useCallback(async (sessionId: string, data: string) => {
    if (!sessionId || !data) return true;
    try {
      const result = await window.autoplan.writeTerminal({ sessionId, data });
      return Boolean(sessionFromResult(result, '终端写入失败', setError, { silentOk: true }));
    } catch (err) {
      setError(errorMessage(err, '终端写入失败'));
      return false;
    }
  }, []);

  const resize = useCallback(async (sessionId: string, cols: number, rows: number) => {
    if (!sessionId || !Number.isInteger(cols) || !Number.isInteger(rows)) return false;
    try {
      const result = await window.autoplan.resizeTerminal({ sessionId, cols, rows });
      const session = sessionFromResult(result, '调整终端尺寸失败', setError, { silentOk: true });
      if (session) upsertSession(session);
      return Boolean(session);
    } catch (err) {
      setError(errorMessage(err, '调整终端尺寸失败'));
      return false;
    }
  }, [upsertSession]);

  const kill = useCallback(async (sessionId: string) => runSessionAction(
    'kill',
    () => window.autoplan.killTerminal({ sessionId }),
    '停止终端失败',
    setBusyAction,
    setError,
    upsertSession,
  ), [upsertSession]);

  const close = useCallback(async (sessionId: string) => {
    if (!sessionId) return false;
    setBusyAction('close');
    try {
      const result = await window.autoplan.closeTerminal({ sessionId });
      if (!result.ok) {
        setError(result.message || '关闭终端失败');
        return false;
      }
      removeSessionFromState(sessionId, setSessions, setActiveSessionIdState, dataHandlersRef);
      return true;
    } catch (err) {
      setError(errorMessage(err, '关闭终端失败'));
      return false;
    } finally {
      setBusyAction((current) => (current === 'close' ? null : current));
    }
  }, []);

  const rename = useCallback(async (sessionId: string, title: string) => runSessionAction(
    'rename',
    () => window.autoplan.renameTerminal({ sessionId, title }),
    '重命名终端失败',
    setBusyAction,
    setError,
    upsertSession,
  ), [upsertSession]);

  const clear = useCallback(async (sessionId: string) => {
    if (!sessionId) return false;
    setBusyAction('clear');
    try {
      const result = await window.autoplan.clearTerminal({ sessionId });
      const session = sessionFromResult(result, '清屏失败', setError, { silentOk: true });
      if (session) upsertSession(session);
      return Boolean(session);
    } catch (err) {
      setError(errorMessage(err, '清屏失败'));
      return false;
    } finally {
      setBusyAction((current) => (current === 'clear' ? null : current));
    }
  }, [upsertSession]);

  const replay = useCallback(async (sessionId: string) => {
    if (!sessionId) return null;
    setBusyAction('replay');
    try {
      const result = await window.autoplan.replayTerminal({ sessionId });
      if (!result.ok) {
        setError(result.message || '读取终端输出失败');
        return null;
      }
      upsertSession(result.session);
      return result;
    } catch (err) {
      setError(errorMessage(err, '读取终端输出失败'));
      return null;
    } finally {
      setBusyAction((current) => (current === 'replay' ? null : current));
    }
  }, [upsertSession]);

  const removeLocal = useCallback((sessionId: string) => {
    removeSessionFromState(sessionId, setSessions, setActiveSessionIdState, dataHandlersRef);
  }, []);

  const subscribeData = useCallback((sessionId: string, handler: TerminalDataHandler) => {
    if (!sessionId) return () => {};
    let handlers = dataHandlersRef.current.get(sessionId);
    if (!handlers) {
      handlers = new Set();
      dataHandlersRef.current.set(sessionId, handlers);
    }
    handlers.add(handler);
    return () => {
      const current = dataHandlersRef.current.get(sessionId);
      if (!current) return;
      current.delete(handler);
      if (current.size === 0) dataHandlersRef.current.delete(sessionId);
    };
  }, []);

  const activeSession = useMemo(
    () => sessions.find((session) => session.id === activeSessionId) ?? sessions[0] ?? null,
    [activeSessionId, sessions],
  );
  const activeCount = useMemo(() => sessions.filter(isTerminalActive).length, [sessions]);

  return {
    sessions,
    activeSession,
    activeSessionId: activeSession?.id ?? null,
    activeCount,
    loading,
    error,
    busyAction,
    setActiveSessionId,
    clearError,
    refresh,
    createSession,
    write,
    resize,
    kill,
    close,
    rename,
    clear,
    replay,
    removeLocal,
    subscribeData,
  };
}

export function isTerminalActive(session: TerminalSession) {
  const status = String(session.status || '').toLowerCase();
  return !session.endedAt && !['exited', 'killed', 'error'].includes(status);
}

function isValidProjectId(projectId: number) {
  return Number.isInteger(projectId) && projectId > 0;
}

function belongsToProject(session: TerminalSession, projectId: number) {
  return Number(session.projectId) === Number(projectId);
}

function normalizeSessions(sessions: TerminalSession[] = [], projectId: number) {
  return sortSessions(sessions.filter((session) => belongsToProject(session, projectId)));
}

function mergeSessions(current: TerminalSession[], incoming: TerminalSession[], projectId: number) {
  const byId = new Map<string, TerminalSession>();
  normalizeSessions(current, projectId).forEach((session) => byId.set(session.id, session));
  normalizeSessions(incoming, projectId).forEach((session) => byId.set(session.id, session));
  return sortSessions(Array.from(byId.values()));
}

function sortSessions(sessions: TerminalSession[]) {
  return [...sessions].sort((left, right) => String(left.createdAt || '').localeCompare(String(right.createdAt || '')));
}

function sameSessionList(left: TerminalSession[], right: TerminalSession[]) {
  if (left.length !== right.length) return false;
  return left.every((session, index) => sessionSignature(session) === sessionSignature(right[index]));
}

function sessionSignature(session: TerminalSession) {
  return [
    session.id,
    session.projectId,
    session.title,
    session.cwd,
    session.shell,
    session.status,
    session.createdAt,
    session.endedAt ?? '',
    session.exitCode ?? '',
    session.cols ?? '',
    session.rows ?? '',
    session.profile?.id ?? '',
    session.profile?.name ?? '',
    session.profile?.shellPath ?? '',
  ].join('\0');
}

function removeSessionFromState(
  sessionId: string,
  setSessions: (action: (current: TerminalSession[]) => TerminalSession[]) => void,
  setActiveSessionIdState: (action: (active: string | null) => string | null) => void,
  dataHandlersRef: { current: Map<string, Set<TerminalDataHandler>> },
) {
  if (!sessionId) return;
  setSessions((current) => {
    const next = current.filter((session) => session.id !== sessionId);
    setActiveSessionIdState((active) => (active === sessionId ? next[0]?.id ?? null : active));
    dataHandlersRef.current.delete(sessionId);
    return next;
  });
}

function sessionFromResult(
  result: TerminalSessionResult,
  fallback: string,
  setError: (message: string) => void,
  options: { silentOk?: boolean } = {},
) {
  if (!result.ok) {
    setError(result.message || fallback);
    return null;
  }
  if (!options.silentOk) setError('');
  return result.session;
}

async function runSessionAction(
  action: TerminalBusyAction,
  call: () => Promise<TerminalSessionResult>,
  fallback: string,
  setBusyAction: (action: TerminalBusyAction | null | ((current: TerminalBusyAction | null) => TerminalBusyAction | null)) => void,
  setError: (message: string) => void,
  upsertSession: (session: TerminalSession | null | undefined) => void,
) {
  setBusyAction(action);
  try {
    const result = await call();
    const session = sessionFromResult(result, fallback, setError);
    if (!session) return null;
    upsertSession(session);
    return session;
  } catch (err) {
    setError(errorMessage(err, fallback));
    return null;
  } finally {
    setBusyAction((current) => (current === action ? null : current));
  }
}

function errorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message) return error.message;
  const text = String(error || '').trim();
  return text || fallback;
}
