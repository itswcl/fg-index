import type { QueryClient } from '@tanstack/react-query';
import type { FearGreed, TickerQuote } from '../types';
import { sanitizeTickerQuote } from './marketData';

/**
 * localStorage-backed cache for last-known quote + F&G payloads.
 *
 * Goal: first render after a reload paints the user's most recent values
 * instead of a blank "N/A / Market Closed" shimmer while fresh data is
 * still in flight. Live WS / REST updates overwrite cached entries as
 * they arrive.
 *
 * Design notes:
 *   - Values are re-run through `sanitizeTickerQuote` on load, so a stale
 *     cached shape (e.g. a new numeric field added since the entry was
 *     written) can't crash the formatter.
 *   - `saveQuote(sym, null)` is a deliberate no-op. A null payload means
 *     "market closed / scraper failed right now" — it shouldn't erase the
 *     last good value we have on disk.
 *   - All reads/writes are wrapped in try/catch. Private mode, quota
 *     pressure, and malformed JSON all degrade to "no cached value"
 *     rather than throwing out of a render path.
 *   - No TTL. The `Updated HH:MM:SS` footer on each card already tells the
 *     truth about how fresh the number is, and a hard TTL would re-
 *     introduce the exact N/A flash this cache exists to avoid (e.g. on
 *     Monday morning after a weekend).
 */

const QUOTE_KEY_PREFIX = 'fgi:quote:';
const FEAR_GREED_KEY = 'fgi:fearGreed';

interface StoredQuote {
  quote: TickerQuote;
  updatedAt: string;
}

interface StoredFearGreed {
  data: FearGreed;
  updatedAt: string;
}

function safeStorage(): Storage | null {
  try {
    if (typeof window === 'undefined') return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

function quoteKey(symbol: string): string {
  return QUOTE_KEY_PREFIX + symbol.toUpperCase();
}

export function saveQuote(
  symbol: string,
  quote: TickerQuote | null,
  updatedAt: Date = new Date(),
): void {
  // Intentionally skip null — see file header.
  if (!quote) return;
  const storage = safeStorage();
  if (!storage) return;
  try {
    const record: StoredQuote = { quote, updatedAt: updatedAt.toISOString() };
    storage.setItem(quoteKey(symbol), JSON.stringify(record));
  } catch {
    // Best-effort: quota full, serialization error, etc.
  }
}

export function loadQuote(
  symbol: string,
): { quote: TickerQuote; updatedAt: Date } | null {
  const storage = safeStorage();
  if (!storage) return null;
  try {
    const raw = storage.getItem(quoteKey(symbol));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredQuote>;
    const quote = sanitizeTickerQuote(parsed.quote);
    if (!quote) return null;
    const updatedAt = parseDate(parsed.updatedAt);
    if (!updatedAt) return null;
    return { quote, updatedAt };
  } catch {
    return null;
  }
}

export function saveFearGreed(data: FearGreed, updatedAt: Date = new Date()): void {
  const storage = safeStorage();
  if (!storage) return;
  try {
    const record: StoredFearGreed = { data, updatedAt: updatedAt.toISOString() };
    storage.setItem(FEAR_GREED_KEY, JSON.stringify(record));
  } catch {
    // Best-effort
  }
}

export function loadFearGreed(): { data: FearGreed; updatedAt: Date } | null {
  const storage = safeStorage();
  if (!storage) return null;
  try {
    const raw = storage.getItem(FEAR_GREED_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredFearGreed>;
    const data = parsed.data;
    if (!data || typeof data !== 'object') return null;
    if (typeof data.score !== 'number' || !Number.isFinite(data.score)) return null;
    const updatedAt = parseDate(parsed.updatedAt);
    if (!updatedAt) return null;
    return { data, updatedAt };
  } catch {
    return null;
  }
}

function parseDate(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Walk every `fgi:quote:*` key in localStorage and seed the corresponding
 * `['ticker', SYMBOL]` React Query cache entry. Call this once at app
 * bootstrap, immediately after the QueryClient is constructed, so that
 * `useTicker(sym)` readers have data on the very first render instead of
 * needing a render → effect → re-render cycle.
 */
export function hydrateQuoteCacheIntoQueryClient(queryClient: QueryClient): void {
  const storage = safeStorage();
  if (!storage) return;
  try {
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i);
      if (!key || !key.startsWith(QUOTE_KEY_PREFIX)) continue;
      const symbol = key.slice(QUOTE_KEY_PREFIX.length);
      if (!symbol) continue;
      const cached = loadQuote(symbol);
      if (cached) {
        queryClient.setQueryData<TickerQuote | null>(['ticker', symbol], cached.quote);
      }
    }
  } catch {
    // Best-effort — never block render on cache hydration
  }
}
