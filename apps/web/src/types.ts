export type FearGreedClassification = 'Extreme Fear' | 'Fear' | 'Neutral' | 'Greed' | 'Extreme Greed';

export interface FearGreed {
  score: number;
  classification: FearGreedClassification;
  previousClose: number;
  oneWeekAgo: number;
  oneMonthAgo: number;
  oneYearAgo: number;
  updatedAt: string;
  /** Public URL of the source page (CNN Fear & Greed). */
  sourceUrl?: string;
}

/**
 * Which session of the US equity day a quote represents.
 *
 *   regular  09:30–16:00 ET  (the official last-trade window)
 *   pre      04:00–09:30 ET
 *   post     16:00–20:00 ET
 *   closed   weekend / overnight / non-equity instrument
 *
 * Optional because:
 *   - Some backend producers (Yahoo cooling off, Google Finance fallback,
 *     non-US listings) can't determine session reliably.
 *   - Older cached quotes in localStorage predate this field.
 *
 * The FE falls back to `deriveMarketSession(fetchedAt)` when the backend
 * doesn't supply it.
 */
export type MarketSession = 'regular' | 'pre' | 'post' | 'closed';

export interface TickerQuote {
  ticker: string;
  name?: string;
  /** Always the regular-session last trade. Never silently swapped to a pre/post tick. */
  price: number;
  previousClose: number;
  change: number;
  changePercent: number;
  fetchedAt: string;
  /** Public URL of the source page the price was scraped from. */
  sourceUrl?: string;
  /**
   * Which session this quote was printed in. When omitted the FE derives
   * a session from `fetchedAt`. See {@link MarketSession}.
   *
   * Source of truth for the after-hours moon glyph: `'pre' | 'post'` shows
   * it, anything else hides it. BTC always reports `'regular'` so the
   * 24/7 market never gets a moon.
   */
  marketSession?: MarketSession;

  // ── Extended-hours prints (optional, populated by Yahoo when available) ──
  // FE displays `price` (regular-session) by default. A future enhancement
  // can switch the visible price to postMarketPrice/preMarketPrice when
  // session is 'post'/'pre'. Indices (VIX/SPX) typically don't have these
  // because indices are computed, not traded.
  postMarketPrice?: number;
  postMarketChange?: number;
  postMarketChangePercent?: number;
  preMarketPrice?: number;
  preMarketChange?: number;
  preMarketChangePercent?: number;
}
