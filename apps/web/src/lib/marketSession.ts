import type { MarketSession, TickerQuote } from '../types';

/**
 * Bucket a timestamp into a US equity market session.
 *
 *   04:00–09:30 ET  → 'pre'
 *   09:30–16:00 ET  → 'regular'
 *   16:00–20:00 ET  → 'post'
 *   anything else   → 'closed'  (overnight, weekends)
 *
 * Used as a fallback when the backend doesn't ship `marketSession`. The
 * `fetchedAt` we receive is an ISO string in UTC; we extract the ET
 * wall-clock via Intl so DST flips are handled correctly without pulling
 * in a date library.
 *
 * Returns `'closed'` on parse failure so callers don't need to guard
 * separately.
 */
export function deriveMarketSession(fetchedAt: string | Date | undefined): MarketSession {
  if (!fetchedAt) return 'closed';
  const date = typeof fetchedAt === 'string' ? new Date(fetchedAt) : fetchedAt;
  if (Number.isNaN(date.getTime())) return 'closed';

  let weekday = '';
  let hour = NaN;
  let minute = NaN;
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    for (const part of fmt.formatToParts(date)) {
      if (part.type === 'weekday') weekday = part.value;
      else if (part.type === 'hour') hour = Number(part.value);
      else if (part.type === 'minute') minute = Number(part.value);
    }
  } catch {
    return 'closed';
  }

  if (weekday === 'Sat' || weekday === 'Sun') return 'closed';
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return 'closed';

  // `hour: '2-digit'` with `hour12: false` returns "00"–"23" in en-US,
  // except some engines have historically emitted "24" at midnight — guard:
  const h = hour === 24 ? 0 : hour;
  const minutes = h * 60 + minute;

  // Boundary policy: include the lower bound, exclude the upper.
  // 04:00 (240) → pre starts; 09:30 (570) → regular starts; 16:00 (960)
  // → post starts; 20:00 (1200) → closed.
  if (minutes >= 570 && minutes < 960) return 'regular';
  if (minutes >= 240 && minutes < 570) return 'pre';
  if (minutes >= 960 && minutes < 1200) return 'post';
  return 'closed';
}

/**
 * Resolve the session for a quote, preferring the backend-supplied value
 * and falling back to a `fetchedAt`-based derivation.
 *
 * `forceRegular` short-circuits the lookup — used by F&G and BTC cards
 * where the moon never makes sense (no session concept / 24-7 market).
 */
export function resolveMarketSession(
  quote: TickerQuote | null | undefined,
  options: { forceRegular?: boolean } = {},
): MarketSession {
  if (options.forceRegular) return 'regular';
  if (!quote) return 'closed';
  return quote.marketSession ?? deriveMarketSession(quote.fetchedAt);
}

/**
 * Should the moon glyph render for this session?
 * True only for extended-hours sessions where we have a tradeable print.
 */
export function isExtendedHoursSession(session: MarketSession): session is 'pre' | 'post' {
  return session === 'pre' || session === 'post';
}

/**
 * The numbers to actually paint on the card.
 *
 * The backend payload exposes BOTH the regular-session print (`price`,
 * `change`, `changePercent`) and — when applicable — the extended-hours
 * print (`postMarketPrice`, `postMarketChange`, …). The card has a single
 * price slot, so this helper picks the right cluster:
 *
 *   - session 'post' + postMarketPrice present → post-market triplet
 *   - session 'pre'  + preMarketPrice present  → pre-market triplet
 *   - otherwise (regular / closed / missing extended-hours fields) →
 *     regular-session triplet
 *
 * Falls back gracefully when the backend ships a session enum but omits
 * the numeric fields (Yahoo cool-down etc.) — we keep the regular price
 * rather than painting `undefined`.
 *
 * Each field is independently checked because a partial extended-hours
 * payload (price but no change%, say) is rare but possible; we don't
 * want a single missing field to demote the whole row back to regular.
 */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export interface DisplayQuote {
  price: number;
  change: number;
  changePercent: number;
}

export function getDisplayQuote(
  quote: TickerQuote | null | undefined,
  session: MarketSession,
): DisplayQuote | null {
  if (!quote) return null;

  if (session === 'post' && isFiniteNumber(quote.postMarketPrice)) {
    return {
      price: quote.postMarketPrice,
      // Fall back to the regular change values if the backend gave us a
      // post-market price but no post-market deltas — better to show the
      // day's move than a blank.
      change: isFiniteNumber(quote.postMarketChange) ? quote.postMarketChange : quote.change,
      changePercent: isFiniteNumber(quote.postMarketChangePercent)
        ? quote.postMarketChangePercent
        : quote.changePercent,
    };
  }

  if (session === 'pre' && isFiniteNumber(quote.preMarketPrice)) {
    return {
      price: quote.preMarketPrice,
      change: isFiniteNumber(quote.preMarketChange) ? quote.preMarketChange : quote.change,
      changePercent: isFiniteNumber(quote.preMarketChangePercent)
        ? quote.preMarketChangePercent
        : quote.changePercent,
    };
  }

  return {
    price: quote.price,
    change: quote.change,
    changePercent: quote.changePercent,
  };
}
