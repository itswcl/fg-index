import type { TickerQuote } from '../types';

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
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
  };
}
