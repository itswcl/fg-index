import type { MarketSession, TickerQuote } from '../types';

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

const MARKET_SESSIONS: readonly MarketSession[] = ['regular', 'pre', 'post', 'closed'];

function isMarketSession(value: unknown): value is MarketSession {
  return typeof value === 'string' && (MARKET_SESSIONS as readonly string[]).includes(value);
}

export function hasFiniteNumber(value: unknown): value is number {
  return isFiniteNumber(value);
}

export function sanitizeTickerQuote(value: unknown): TickerQuote | null {
  if (!value || typeof value !== 'object') return null;

  const quote = value as Partial<Record<keyof TickerQuote, unknown>>;
  if (
    typeof quote.ticker !== 'string' ||
    !isFiniteNumber(quote.price) ||
    !isFiniteNumber(quote.previousClose) ||
    !isFiniteNumber(quote.change) ||
    !isFiniteNumber(quote.changePercent) ||
    typeof quote.fetchedAt !== 'string'
  ) {
    return null;
  }

  return {
    ticker: quote.ticker,
    price: quote.price,
    previousClose: quote.previousClose,
    change: quote.change,
    changePercent: quote.changePercent,
    fetchedAt: quote.fetchedAt,
    ...(typeof quote.name === 'string' ? { name: quote.name } : {}),
    ...(typeof quote.sourceUrl === 'string' ? { sourceUrl: quote.sourceUrl } : {}),
    ...(isMarketSession(quote.marketSession) ? { marketSession: quote.marketSession } : {}),
    // Extended-hours prints — pass through whichever optional numeric
    // fields the backend included. Each is independently validated so a
    // partial payload (e.g. only `postMarketPrice`) still survives the
    // sanitizer cleanly.
    ...(isFiniteNumber(quote.postMarketPrice) ? { postMarketPrice: quote.postMarketPrice } : {}),
    ...(isFiniteNumber(quote.postMarketChange) ? { postMarketChange: quote.postMarketChange } : {}),
    ...(isFiniteNumber(quote.postMarketChangePercent)
      ? { postMarketChangePercent: quote.postMarketChangePercent }
      : {}),
    ...(isFiniteNumber(quote.preMarketPrice) ? { preMarketPrice: quote.preMarketPrice } : {}),
    ...(isFiniteNumber(quote.preMarketChange) ? { preMarketChange: quote.preMarketChange } : {}),
    ...(isFiniteNumber(quote.preMarketChangePercent)
      ? { preMarketChangePercent: quote.preMarketChangePercent }
      : {}),
  };
}
