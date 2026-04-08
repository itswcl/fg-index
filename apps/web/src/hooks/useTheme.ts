import { useState, useEffect } from 'react';

export type ThemePreference = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'fg-theme';

function getSystemScheme(): 'light' | 'dark' {
  if (typeof window === 'undefined') return 'dark';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function loadPreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'light' || stored === 'dark' || stored === 'system') return stored;
  } catch {
    // ignore
  }
  return 'system';
}

export function useTheme() {
  const [preference, setPreferenceState] = useState<ThemePreference>(loadPreference);
  const [systemScheme, setSystemScheme] = useState<'light' | 'dark'>(getSystemScheme);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (e: MediaQueryListEvent) =>
      setSystemScheme(e.matches ? 'dark' : 'light');
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  const setTheme = (pref: ThemePreference) => {
    setPreferenceState(pref);
    try {
      localStorage.setItem(STORAGE_KEY, pref);
    } catch {
      // ignore
    }
  };

  const isDark =
    preference === 'system' ? systemScheme === 'dark' : preference === 'dark';

  return { theme: preference, setTheme, isDark };
}
