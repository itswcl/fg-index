import type { ThemePreference } from '../hooks/useTheme';
import { ThemeSwitcher } from './ThemeSwitcher';
import { SignInButton } from './SignInButton';

type WsStatus = 'connecting' | 'connected' | 'disconnected';

const STATUS_COLOR: Record<WsStatus, string> = {
  connected:    '#27AE60',
  connecting:   '#F39C12',
  disconnected: '#E74C3C',
};


interface IconBarProps {
  isDark: boolean;
  wsStatus: WsStatus;
  onStatusClick: () => void;
  activeAlertCount: number;
  onAlertsClick: () => void;
  theme: ThemePreference;
  onThemeSelect: (t: ThemePreference) => void;
}

export function IconBar({
  isDark,
  wsStatus,
  onStatusClick,
  activeAlertCount,
  onAlertsClick,
  theme,
  onThemeSelect,
}: IconBarProps) {
  const iconColor = isDark ? 'rgba(255,255,255,0.45)' : 'rgba(0,0,0,0.40)';
  const badgeBorder = isDark ? '#000000' : '#F2F2F7';

  return (
    <div className="icon-bar">
      {/* Bell — Alerts */}
      <button
        className={`icon-btn ${isDark ? 'icon-btn-dark' : 'icon-btn-light'}`}
        onClick={onAlertsClick}
        aria-label="Alerts"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
          stroke={iconColor} strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"
          aria-hidden="true">
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
        {activeAlertCount > 0 && (
          <span
            style={{
              position: 'absolute',
              top: 5,
              right: 5,
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: '#5F7FFF',
              border: `1.5px solid ${badgeBorder}`,
            }}
          />
        )}
        <span className={`tooltip ${isDark ? 'tooltip-dark' : 'tooltip-light'}`}>Alerts</span>
      </button>

      {/* Coffee — Buy Me a Coffee */}
      <a
        href="https://www.buymeacoffee.com/weiclee"
        target="_blank"
        rel="noopener noreferrer"
        className={`icon-btn ${isDark ? 'icon-btn-dark' : 'icon-btn-light'}`}
        aria-label="Buy me a coffee"
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none"
          stroke={iconColor} strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"
          aria-hidden="true">
          <path d="M6 2v2M10 2v2M14 2v2" />
          <path d="M4 7h14v9a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4V7z" strokeLinejoin="round" />
          <path d="M18 9h1a3 3 0 0 1 0 6h-1" />
        </svg>
        <span className={`tooltip tooltip-right ${isDark ? 'tooltip-dark' : 'tooltip-light'}`}>Coffee</span>
      </a>

      {/* Status dot */}
      <button
        className={`icon-btn ${isDark ? 'icon-btn-dark' : 'icon-btn-light'}`}
        onClick={onStatusClick}
        aria-label="Refresh data"
      >
        <span
          className={wsStatus === 'connecting' ? 'status-dot-pulse' : undefined}
          style={{
            display: 'block',
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: STATUS_COLOR[wsStatus],
          }}
        />
        <span className={`tooltip tooltip-right ${isDark ? 'tooltip-dark' : 'tooltip-light'}`}>Refresh</span>
      </button>

      {/* Sign in / account — placed next to alerts per Feature 6 spec */}
      <SignInButton isDark={isDark} />

      {/* Theme switcher — last in row */}
      <ThemeSwitcher theme={theme} onSelect={onThemeSelect} isDark={isDark} />
    </div>
  );
}
