type WsStatus = 'connecting' | 'connected' | 'disconnected';

const STATUS_COLOR: Record<WsStatus, string> = {
  connected:    '#27AE60',
  connecting:   '#F39C12',
  disconnected: '#E74C3C',
};

const STATUS_TOOLTIP: Record<WsStatus, string> = {
  connected:    'Live',
  connecting:   'Connecting…',
  disconnected: 'Disconnected · Click to retry',
};

interface IconBarProps {
  isDark: boolean;
  wsStatus: WsStatus;
  onStatusClick: () => void;
  /** Number of enabled alerts — drives bell badge */
  activeAlertCount: number;
  /** Called when bell is clicked */
  onAlertsClick: () => void;
}

export function IconBar({
  isDark,
  wsStatus,
  onStatusClick,
  activeAlertCount,
  onAlertsClick,
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
        style={{ position: 'relative' }}
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
      </a>

      {/* Status dot */}
      <button
        className={`icon-btn ${isDark ? 'icon-btn-dark' : 'icon-btn-light'}`}
        onClick={onStatusClick}
        title={STATUS_TOOLTIP[wsStatus]}
        aria-label={STATUS_TOOLTIP[wsStatus]}
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
      </button>
    </div>
  );
}
