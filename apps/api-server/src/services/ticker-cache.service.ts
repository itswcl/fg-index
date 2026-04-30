import type { TickerQuote } from "@shared/types";
import { prisma } from "./db.js";
import { getTickerCacheTtlMs } from "./ticker.service.js";
import { validateTickerQuote } from "./validateQuote.js";

const MAX_SERVED_QUOTE_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_REFRESH_ERROR_LENGTH = 500;

function normalizeSymbol(symbol: string): string {
  return symbol.trim().toUpperCase();
}

function isServable(row: { fetchedAt: Date }): boolean {
  return Date.now() - row.fetchedAt.getTime() <= MAX_SERVED_QUOTE_AGE_MS;
}

function rowToQuote(row: {
  symbol: string;
  name: string | null;
  price: number;
  previousClose: number;
  change: number;
  changePercent: number;
  fetchedAt: Date;
  sourceUrl: string | null;
  marketSession: string | null;
  postMarketPrice: number | null;
  postMarketChange: number | null;
  postMarketChangePercent: number | null;
  preMarketPrice: number | null;
  preMarketChange: number | null;
  preMarketChangePercent: number | null;
}): TickerQuote | null {
  return validateTickerQuote({
    ticker: row.symbol,
    ...(row.name ? { name: row.name } : {}),
    price: row.price,
    previousClose: row.previousClose,
    change: row.change,
    changePercent: row.changePercent,
    fetchedAt: row.fetchedAt.toISOString(),
    ...(row.sourceUrl ? { sourceUrl: row.sourceUrl } : {}),
    ...(row.marketSession ? { marketSession: row.marketSession as TickerQuote["marketSession"] } : {}),
    ...(row.postMarketPrice !== null ? { postMarketPrice: row.postMarketPrice } : {}),
    ...(row.postMarketChange !== null ? { postMarketChange: row.postMarketChange } : {}),
    ...(row.postMarketChangePercent !== null
      ? { postMarketChangePercent: row.postMarketChangePercent }
      : {}),
    ...(row.preMarketPrice !== null ? { preMarketPrice: row.preMarketPrice } : {}),
    ...(row.preMarketChange !== null ? { preMarketChange: row.preMarketChange } : {}),
    ...(row.preMarketChangePercent !== null
      ? { preMarketChangePercent: row.preMarketChangePercent }
      : {}),
  });
}

export async function getCachedQuoteSnapshot(symbol: string): Promise<{
  quote: TickerQuote | null;
  isFresh: boolean;
}> {
  const normalized = normalizeSymbol(symbol);
  const row = await prisma.tickerQuoteCache.findUnique({
    where: { symbol: normalized },
  });
  if (!row || !isServable(row)) {
    return { quote: null, isFresh: false };
  }
  return {
    quote: rowToQuote(row),
    isFresh: row.staleAt.getTime() > Date.now(),
  };
}

export async function getCachedQuotesBatch(
  symbols: string[]
): Promise<Record<string, TickerQuote | null>> {
  const normalized = symbols.map(normalizeSymbol);
  const rows = await prisma.tickerQuoteCache.findMany({
    where: { symbol: { in: normalized } },
  });
  const bySymbol = new Map(
    rows
      .filter((row) => isServable(row))
      .map((row) => [row.symbol, rowToQuote(row)] as const)
  );

  const quotes: Record<string, TickerQuote | null> = {};
  for (const symbol of normalized) {
    quotes[symbol] = bySymbol.get(symbol) ?? null;
  }
  return quotes;
}

export async function upsertCachedQuote(
  symbol: string,
  quote: TickerQuote
): Promise<void> {
  const normalized = normalizeSymbol(symbol);
  const now = new Date();
  const staleAt = new Date(now.getTime() + getTickerCacheTtlMs(normalized));
  const fetchedAt = new Date(quote.fetchedAt);

  await prisma.tickerQuoteCache.upsert({
    where: { symbol: normalized },
    create: {
      symbol: normalized,
      name: quote.name ?? null,
      price: quote.price,
      previousClose: quote.previousClose,
      change: quote.change,
      changePercent: quote.changePercent,
      fetchedAt,
      sourceUrl: quote.sourceUrl ?? null,
      marketSession: quote.marketSession ?? null,
      postMarketPrice: quote.postMarketPrice ?? null,
      postMarketChange: quote.postMarketChange ?? null,
      postMarketChangePercent: quote.postMarketChangePercent ?? null,
      preMarketPrice: quote.preMarketPrice ?? null,
      preMarketChange: quote.preMarketChange ?? null,
      preMarketChangePercent: quote.preMarketChangePercent ?? null,
      staleAt,
      lastRefreshAttemptAt: now,
      lastRefreshSuccessAt: now,
      lastRefreshError: null,
    },
    update: {
      name: quote.name ?? null,
      price: quote.price,
      previousClose: quote.previousClose,
      change: quote.change,
      changePercent: quote.changePercent,
      fetchedAt,
      sourceUrl: quote.sourceUrl ?? null,
      marketSession: quote.marketSession ?? null,
      postMarketPrice: quote.postMarketPrice ?? null,
      postMarketChange: quote.postMarketChange ?? null,
      postMarketChangePercent: quote.postMarketChangePercent ?? null,
      preMarketPrice: quote.preMarketPrice ?? null,
      preMarketChange: quote.preMarketChange ?? null,
      preMarketChangePercent: quote.preMarketChangePercent ?? null,
      staleAt,
      lastRefreshAttemptAt: now,
      lastRefreshSuccessAt: now,
      lastRefreshError: null,
    },
  });
}

export async function recordQuoteRefreshFailure(
  symbol: string,
  error: string
): Promise<void> {
  const normalized = normalizeSymbol(symbol);
  await prisma.tickerQuoteCache.updateMany({
    where: { symbol: normalized },
    data: {
      lastRefreshAttemptAt: new Date(),
      lastRefreshError: error.slice(0, MAX_REFRESH_ERROR_LENGTH),
    },
  });
}

export async function listActiveTrackedSymbols(): Promise<string[]> {
  const rows = await prisma.userTicker.findMany({
    select: { symbol: true },
  });
  return [...new Set(rows.map((row) => normalizeSymbol(row.symbol)))];
}
