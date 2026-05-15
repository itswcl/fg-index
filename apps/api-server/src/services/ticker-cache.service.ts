import type { TickerQuote } from "@shared/types";
import { env } from "../config/env.js";
import { prisma } from "./db.js";
import { applyGlobalMarketSessionToQuote } from "./market-status.service.js";
import { normalizeQuoteSymbol } from "./quote-symbols.service.js";
import { getTickerCacheTtlMs } from "./ticker.service.js";
import { validateTickerQuote } from "./validateQuote.js";

const MAX_SERVED_QUOTE_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_REFRESH_ERROR_LENGTH = 500;

type TickerQuoteCacheRow = {
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
  staleAt: Date;
};

type QuoteMemoryEntry = {
  quote: TickerQuote | null;
  staleAtMs: number;
  expiresAtMs: number;
};

const quoteRowSelect = {
  symbol: true,
  name: true,
  price: true,
  previousClose: true,
  change: true,
  changePercent: true,
  fetchedAt: true,
  sourceUrl: true,
  marketSession: true,
  postMarketPrice: true,
  postMarketChange: true,
  postMarketChangePercent: true,
  preMarketPrice: true,
  preMarketChange: true,
  preMarketChangePercent: true,
  staleAt: true,
} as const;

const quoteMemoryCache = new Map<string, QuoteMemoryEntry>();
let activeSymbolsCache: { symbols: string[]; expiresAtMs: number } | null = null;

const stats = {
  quoteMemoryHits: 0,
  quoteMemoryMisses: 0,
  quoteDbReads: 0,
  activeSymbolCacheHits: 0,
  activeSymbolCacheMisses: 0,
  activeSymbolDbSyncs: 0,
  activeSymbolInvalidations: 0,
};

export class SuspiciousQuotePriceMoveError extends Error {
  constructor(symbol: string, previousPrice: number, nextPrice: number, movePercent: number) {
    super(
      `Suspicious quote price move for ${symbol}: ${previousPrice} -> ${nextPrice} (${movePercent.toFixed(2)}%)`
    );
    this.name = "SuspiciousQuotePriceMoveError";
  }
}

function normalizeSymbol(symbol: string): string {
  return normalizeQuoteSymbol(symbol);
}

function isServable(row: { fetchedAt: Date }): boolean {
  return Date.now() - row.fetchedAt.getTime() <= MAX_SERVED_QUOTE_AGE_MS;
}

function quoteMemoryTtlMs(quote: TickerQuote | null): number {
  return quote ? env.QUOTE_MEMORY_CACHE_TTL_MS : env.QUOTE_NULL_CACHE_TTL_MS;
}

function readQuoteMemory(symbol: string): { quote: TickerQuote | null; isFresh: boolean } | null {
  const entry = quoteMemoryCache.get(symbol);
  if (!entry) {
    stats.quoteMemoryMisses += 1;
    return null;
  }

  if (entry.expiresAtMs <= Date.now()) {
    quoteMemoryCache.delete(symbol);
    stats.quoteMemoryMisses += 1;
    return null;
  }

  stats.quoteMemoryHits += 1;
  return {
    quote: entry.quote,
    isFresh: entry.quote !== null && entry.staleAtMs > Date.now(),
  };
}

function writeQuoteMemory(
  symbol: string,
  quote: TickerQuote | null,
  staleAtMs = 0
): void {
  quoteMemoryCache.set(symbol, {
    quote,
    staleAtMs,
    expiresAtMs: Date.now() + quoteMemoryTtlMs(quote),
  });
}

export function getFreshQuoteMemorySnapshot(symbol: string): {
  quote: TickerQuote | null;
  isFresh: boolean;
} | null {
  const normalized = normalizeSymbol(symbol);
  const snapshot = readQuoteMemory(normalized);
  if (!snapshot?.isFresh) return null;
  return snapshot;
}

function getAbsoluteMovePercent(previousPrice: number, nextPrice: number): number {
  if (!Number.isFinite(previousPrice) || previousPrice <= 0) return 0;
  return Math.abs((nextPrice - previousPrice) / previousPrice) * 100;
}

async function assertQuotePriceMoveIsSane(
  symbol: string,
  quote: TickerQuote,
  previousPrice?: number
): Promise<void> {
  const threshold = env.QUOTE_PRICE_SANITY_MAX_MOVE_PERCENT;
  if (!Number.isFinite(threshold) || threshold <= 0) return;

  const baselinePrice =
    previousPrice ??
    (
      await prisma.tickerQuoteCache.findUnique({
        where: { symbol },
        select: { price: true },
      })
    )?.price;
  if (baselinePrice === undefined) return;

  const movePercent = getAbsoluteMovePercent(baselinePrice, quote.price);
  if (movePercent >= threshold) {
    throw new SuspiciousQuotePriceMoveError(
      symbol,
      baselinePrice,
      quote.price,
      movePercent
    );
  }
}

function rowToQuote(row: TickerQuoteCacheRow): TickerQuote | null {
  const quote = validateTickerQuote({
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
  return quote ? applyGlobalMarketSessionToQuote(quote) : null;
}

export async function getCachedQuoteSnapshot(symbol: string): Promise<{
  quote: TickerQuote | null;
  isFresh: boolean;
}> {
  const normalized = normalizeSymbol(symbol);
  const memorySnapshot = readQuoteMemory(normalized);
  if (memorySnapshot) return memorySnapshot;

  stats.quoteDbReads += 1;
  const row = await prisma.tickerQuoteCache.findUnique({
    where: { symbol: normalized },
    select: quoteRowSelect,
  });
  if (!row || !isServable(row)) {
    writeQuoteMemory(normalized, null);
    return { quote: null, isFresh: false };
  }
  const quote = rowToQuote(row);
  writeQuoteMemory(normalized, quote, row.staleAt.getTime());
  return {
    quote,
    isFresh: row.staleAt.getTime() > Date.now(),
  };
}

export async function getCachedQuotesBatch(
  symbols: string[]
): Promise<Record<string, TickerQuote | null>> {
  const normalized = symbols.map(normalizeSymbol);
  const bySymbol = new Map<string, TickerQuote | null>();
  const missing: string[] = [];

  for (const symbol of normalized) {
    const memorySnapshot = readQuoteMemory(symbol);
    if (memorySnapshot) {
      bySymbol.set(symbol, memorySnapshot.quote);
    } else {
      missing.push(symbol);
    }
  }

  if (missing.length > 0) {
    stats.quoteDbReads += 1;
    const rows = await prisma.tickerQuoteCache.findMany({
      where: { symbol: { in: missing } },
      select: quoteRowSelect,
    });
    const rowsBySymbol = new Map(rows.map((row) => [row.symbol, row]));
    for (const symbol of missing) {
      const row = rowsBySymbol.get(symbol);
      if (!row || !isServable(row)) {
        writeQuoteMemory(symbol, null);
        bySymbol.set(symbol, null);
        continue;
      }
      const quote = rowToQuote(row);
      writeQuoteMemory(symbol, quote, row.staleAt.getTime());
      bySymbol.set(symbol, quote);
    }
  }

  const quotes: Record<string, TickerQuote | null> = {};
  for (const symbol of normalized) {
    quotes[symbol] = bySymbol.get(symbol) ?? null;
  }
  return quotes;
}

export async function upsertCachedQuote(
  symbol: string,
  quote: TickerQuote,
  options: { previousPrice?: number } = {}
): Promise<void> {
  const normalized = normalizeSymbol(symbol);
  const now = new Date();
  const staleAt = new Date(now.getTime() + getTickerCacheTtlMs(normalized));
  const fetchedAt = new Date(quote.fetchedAt);
  await assertQuotePriceMoveIsSane(normalized, quote, options.previousPrice);

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
  writeQuoteMemory(normalized, applyGlobalMarketSessionToQuote(quote), staleAt.getTime());
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

export function invalidateActiveTrackedSymbolsCache(): void {
  activeSymbolsCache = null;
  stats.activeSymbolInvalidations += 1;
}

export async function listActiveTrackedSymbols(): Promise<string[]> {
  if (activeSymbolsCache && activeSymbolsCache.expiresAtMs > Date.now()) {
    stats.activeSymbolCacheHits += 1;
    return activeSymbolsCache.symbols;
  }

  stats.activeSymbolCacheMisses += 1;
  stats.activeSymbolDbSyncs += 1;
  const rows = await prisma.userTicker.findMany({
    select: { symbol: true },
    distinct: ["symbol"],
  });
  const symbols = [...new Set(rows.map((row) => normalizeSymbol(row.symbol)))];
  activeSymbolsCache = {
    symbols,
    expiresAtMs: Date.now() + env.ACTIVE_SYMBOL_CACHE_TTL_MS,
  };
  return symbols;
}

export function getTickerCacheStats() {
  return {
    ...stats,
    quoteMemoryEntries: quoteMemoryCache.size,
    activeSymbolCacheEntries: activeSymbolsCache?.symbols.length ?? 0,
    activeSymbolCacheExpiresAt: activeSymbolsCache
      ? new Date(activeSymbolsCache.expiresAtMs).toISOString()
      : null,
  };
}

export function __resetTickerCacheMemoryForTests(): void {
  quoteMemoryCache.clear();
  activeSymbolsCache = null;
  stats.quoteMemoryHits = 0;
  stats.quoteMemoryMisses = 0;
  stats.quoteDbReads = 0;
  stats.activeSymbolCacheHits = 0;
  stats.activeSymbolCacheMisses = 0;
  stats.activeSymbolDbSyncs = 0;
  stats.activeSymbolInvalidations = 0;
}
