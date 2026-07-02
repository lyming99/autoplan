import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export type ThemeMode = 'light' | 'dark';

const STORAGE_KEY = 'autoplan-theme';
const MEDIA_QUERY = '(prefers-color-scheme: dark)';

function readSystemTheme(): ThemeMode {
  return window.matchMedia(MEDIA_QUERY).matches ? 'dark' : 'light';
}

function applyTheme(resolved: 'light' | 'dark') {
  document.documentElement.setAttribute('data-theme', resolved);
}

function loadSavedTheme(): ThemeMode {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === 'light' || stored === 'dark') return stored;
  } catch { /* localStorage unavailable */ }
  return readSystemTheme();
}

function persistTheme(mode: ThemeMode) {
  try {
    window.localStorage.setItem(STORAGE_KEY, mode);
  } catch { /* localStorage unavailable */ }
}

interface ThemeContextValue {
  theme: ThemeMode;
  resolved: 'light' | 'dark';
  setTheme: (mode: ThemeMode) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemeMode>(loadSavedTheme);
  const [resolved, setResolved] = useState<'light' | 'dark'>(theme);

  const setTheme = useCallback((mode: ThemeMode) => {
    setThemeState(mode);
    setResolved(mode);
    applyTheme(mode);
    persistTheme(mode);
  }, []);

  // Sync resolved when theme changes externally (e.g. initial load, unlikely)
  useEffect(() => {
    setResolved(theme);
    applyTheme(theme);
  }, [theme]);

  const value = useMemo<ThemeContextValue>(
    () => ({ theme, resolved, setTheme }),
    [theme, resolved, setTheme],
  );

  return (
    <ThemeContext.Provider value={value}>
      {children}
    </ThemeContext.Provider>
  );
}

/**
 * 主题 hook：返回当前主题模式、解析后的实际主题、以及切换函数。
 * 必须在 <ThemeProvider> 内部使用。
 */
export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme() must be used within <ThemeProvider>');
  return ctx;
}
