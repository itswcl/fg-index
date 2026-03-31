

type Status = 'connecting' | 'connected' | 'disconnected';

const STATUS_LABEL: Record<Status, string> = {
  connecting: 'Connecting…',
  connected: 'Live',
  disconnected: 'Disconnected',
};

const STATUS_COLOR: Record<Status, string> = {
  connecting: '#F39C12',
  connected: '#27AE60',
  disconnected: '#E74C3C',
};

const STATUS_BG_COLOR: Record<Status, string> = {
  connecting: 'rgba(243, 156, 18, 0.12)',
  connected: 'rgba(39, 174, 96, 0.12)',
  disconnected: 'rgba(231, 76, 60, 0.12)',
};

interface StatusRefreshButtonProps {
  status: Status;
  onPress: () => void;
  isRefreshing?: boolean;
  isDark: boolean;
}

export function StatusRefreshButton({ status, onPress, isRefreshing, isDark }: StatusRefreshButtonProps) {
  const color = STATUS_COLOR[status];
  const backgroundColor = STATUS_BG_COLOR[status];

  return (
    <button
      onClick={onPress}
      className={`status-btn ${isDark ? 'status-btn-dark' : 'status-btn-light'}`}
      style={{ backgroundColor, borderColor: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.06)' }}
      aria-label={isRefreshing ? 'Refreshing data' : `Status: ${STATUS_LABEL[status]}. Click to refresh.`}
    >
      <span className="status-dot" style={{ backgroundColor: color }} />
      <span className="status-text" style={{ color }}>
        {isRefreshing ? 'Refreshing…' : STATUS_LABEL[status]}
      </span>
    </button>
  );
}
