/** PRD §4.1 — Color-Coding Map for F&G classifications */
export const FEAR_GREED_COLORS = {
  'Extreme Fear': '#C0392B',
  Fear: '#E74C3C',
  Neutral: '#F39C12',
  Greed: '#27AE60',
  'Extreme Greed': '#1E8449',
} as const;

export const API_BASE_URL = 'http://localhost:8080';
export const WS_URL = 'ws://localhost:8081';

/** Re-try HTTP fallback every 5 min */
export const VIX_REFETCH_INTERVAL_MS = 5 * 60 * 1000;
/** Consider data stale after 10 min */
export const STALENESS_THRESHOLD_MS = 10 * 60 * 1000;
