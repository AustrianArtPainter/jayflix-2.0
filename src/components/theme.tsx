'use client';

import { createContext, useCallback, useContext, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { loadTheme, THEME_STORAGE_KEY, type ThemeChoice } from '@/lib/ui-palette';
import { PaletteProvider } from './palette';

/**
 * 主题上下文：light / dark / system，持久化到 localStorage，默认 dark。
 * html 上的 .dark 类由 layout 中的内联脚本先行设置（避免首屏闪烁），此处负责后续切换。
 */

export type { ThemeChoice } from '@/lib/ui-palette';

interface ThemeContextValue {
  theme: ThemeChoice;
  resolved: 'light' | 'dark';
  setTheme: (t: ThemeChoice) => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: 'dark',
  resolved: 'dark',
  setTheme: () => {},
});

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}

function systemPrefersDark(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function resolve(choice: ThemeChoice): 'light' | 'dark' {
  return choice === 'system' ? (systemPrefersDark() ? 'dark' : 'light') : choice;
}

function storedTheme(): ThemeChoice {
  try { return loadTheme(window.localStorage); } catch { return 'dark'; }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemeChoice>('dark');
  const [resolved, setResolved] = useState<'light' | 'dark'>('dark');
  const currentTheme = useRef<ThemeChoice>('dark');

  useLayoutEffect(() => {
    const stored = storedTheme();
    currentTheme.current = stored;
    setThemeState(stored);
    setResolved(resolve(stored));

    const media = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : undefined;
    const onChange = () => {
      if (currentTheme.current === 'system') setResolved(resolve('system'));
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key !== THEME_STORAGE_KEY && event.key !== null) return;
      try { if (event.storageArea && event.storageArea !== window.localStorage) return; } catch { return; }
      const current = storedTheme();
      currentTheme.current = current;
      setThemeState(current);
      setResolved(resolve(current));
    };
    media?.addEventListener('change', onChange);
    window.addEventListener('storage', onStorage);
    return () => {
      media?.removeEventListener('change', onChange);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  const setTheme = useCallback((t: ThemeChoice) => {
    try { window.localStorage.setItem(THEME_STORAGE_KEY, t); } catch { /* Keep in-memory theme usable. */ }
    currentTheme.current = t;
    setThemeState(t);
    setResolved(resolve(t));
  }, []);

  return (
    <ThemeContext.Provider value={{ theme, resolved, setTheme }}>
      <PaletteProvider resolved={resolved}>{children}</PaletteProvider>
    </ThemeContext.Provider>
  );
}

/** 色调标题旁的亮暗切换按钮：在 light → dark → system 三态间循环。 */
export function ThemeToggle() {
  const { theme, resolved, setTheme } = useTheme();
  const next: ThemeChoice = theme === 'light' ? 'dark' : theme === 'dark' ? 'system' : 'light';
  const label = theme === 'system' ? `跟随系统（当前${resolved === 'dark' ? '深色' : '浅色'}）` : theme === 'dark' ? '深色' : '浅色';
  const nextLabel = next === 'light' ? '浅色' : next === 'dark' ? '深色' : '跟随系统';

  return (
    <button
      type="button"
      className="ui-palette-theme"
      title={`主题：${label}，点击切换为${nextLabel}`}
      aria-label={`切换主题，当前 ${label}`}
      onClick={() => setTheme(next)}
    >
      {theme === 'system' ? (
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
        </svg>
      ) : resolved === 'dark' ? (
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
        </svg>
      ) : (
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
        </svg>
      )}
      <span>主题</span>
    </button>
  );
}
