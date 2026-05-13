import { useCallback, useEffect, useState } from 'react';
import { useDashboardUiStore } from '../stores/useDashboardUiStore';
import type { ThemePreference } from '../stores/useDashboardUiStore';

function getSystemScheme(): 'light' | 'dark' {
  if (typeof window === 'undefined') return 'dark';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export type { ThemePreference };

export function useTheme() {
  const preference = useDashboardUiStore((state) => state.themePreference);
  const setPreferenceState = useDashboardUiStore((state) => state.setThemePreference);
  const [systemScheme, setSystemScheme] = useState<'light' | 'dark'>(getSystemScheme);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (e: MediaQueryListEvent) =>
      setSystemScheme(e.matches ? 'dark' : 'light');
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  const setTheme = useCallback((pref: ThemePreference) => {
    setPreferenceState(pref);
  }, [setPreferenceState]);

  const isDark =
    preference === 'system' ? systemScheme === 'dark' : preference === 'dark';

  return { theme: preference, setTheme, isDark };
}
