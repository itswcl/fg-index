import { useState } from 'react';
import { PopupBackdrop } from './PopupBackdrop';
import type { ThemePreference } from '../hooks/useTheme';

interface Props {
  theme: ThemePreference;
  onSelect: (t: ThemePreference) => void;
  isDark: boolean;
}

const OPTIONS: { value: ThemePreference; label: string; icon: React.ReactNode }[] = [
  {
    value: 'light',
    label: 'Light',
    icon: (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="5" />
        <line x1="12" y1="1" x2="12" y2="3" />
        <line x1="12" y1="21" x2="12" y2="23" />
        <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
        <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
        <line x1="1" y1="12" x2="3" y2="12" />
        <line x1="21" y1="12" x2="23" y2="12" />
        <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
        <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
      </svg>
    ),
  },
  {
    value: 'dark',
    label: 'Dark',
    icon: (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
      </svg>
    ),
  },
  {
    value: 'system',
    label: 'System',
    icon: (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
        <line x1="8" y1="21" x2="16" y2="21" />
        <line x1="12" y1="17" x2="12" y2="21" />
      </svg>
    ),
  },
];

function getCurrentIcon(theme: ThemePreference) {
  return OPTIONS.find(o => o.value === theme)?.icon ?? OPTIONS[2].icon;
}

export function ThemeSwitcher({ theme, onSelect, isDark }: Props) {
  const [open, setOpen] = useState(false);

  return (
    <div className="theme-switcher">
      <button
        className={`theme-btn ${isDark ? 'theme-btn-dark' : 'theme-btn-light'}`}
        onClick={() => setOpen(v => !v)}
        aria-label="Switch theme"
        aria-expanded={open}
      >
        {getCurrentIcon(theme)}
        <svg
          className={`theme-chevron ${open ? 'theme-chevron-open' : ''}`}
          width="10" height="10" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {open && (
        <>
          <PopupBackdrop isDark={isDark} onDismiss={() => setOpen(false)} className="popup-backdrop-top-menu" />
          <div className={`theme-dropdown ${isDark ? 'theme-dropdown-dark' : 'theme-dropdown-light'}`}>
            {OPTIONS.map(opt => (
              <button
                key={opt.value}
                className={`theme-option ${isDark ? 'theme-option-dark' : 'theme-option-light'} ${theme === opt.value ? 'theme-option-active' : ''}`}
                onClick={() => { onSelect(opt.value); setOpen(false); }}
              >
                {opt.icon}
                <span>{opt.label}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
