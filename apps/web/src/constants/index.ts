/** Brand colors for F&G classifications */
export const FEAR_GREED_COLORS = {
  'Extreme Fear': '#C0392B',
  Fear: '#E74C3C',
  Neutral: '#F39C12',
  Greed: '#27AE60',
  'Extreme Greed': '#1E8449',
} as const;

// Production: Render URL. Development: localhost.
export const API_BASE_URL: string = import.meta.env.VITE_API_URL ?? 'http://localhost:8080';

// WebSocket URL — derived from API URL (https → wss, http → ws)
// No separate secret needed: VITE_API_URL https://fg-index.onrender.com → wss://fg-index.onrender.com
export const WS_URL: string = (() => {
  const explicit: string | undefined = import.meta.env.VITE_WS_URL;
  if (explicit) return explicit;
  const api: string = import.meta.env.VITE_API_URL ?? 'http://localhost:8080';
  return api.replace(/^https:\/\//, 'wss://').replace(/^http:\/\//, 'ws://');
})();

/** Optional API key sent as X-API-KEY header */
export const API_KEY: string = import.meta.env.VITE_API_KEY ?? '';

/** Re-try HTTP fallback every 5 min */
export const VIX_REFETCH_INTERVAL_MS = 5 * 60 * 1000;

/** BTC poll every 30s — matches backend WS broadcast cadence */
export const BTC_REFETCH_INTERVAL_MS = 30 * 1000;

/** SPX poll every 5 min */
export const SPX_REFETCH_INTERVAL_MS = 5 * 60 * 1000;

/** Consider data stale after 10 min */
export const STALENESS_THRESHOLD_MS = 10 * 60 * 1000;

/** Custom ticker poll every 10s */
export const TICKER_REFETCH_INTERVAL_MS = 10 * 1000;

/** Max number of custom ticker cards (matches BE MAX_TICKERS_PER_USER = 32). */
export const MAX_CUSTOM_TICKERS = 32;

/** Cards shown per page in the paginated grid (3 pages × 12 = 36 max). */
export const CARDS_PER_PAGE = 12;

/** Hard cap on pagination. 36 total cards / 12 per page → 3 pages. */
export const MAX_PAGES = 3;

/** localStorage key for custom ticker list */
export const TICKER_STORAGE_KEY = 'fg-index-tickers';
