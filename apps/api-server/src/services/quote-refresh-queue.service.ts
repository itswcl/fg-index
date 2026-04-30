import { env } from "../config/env.js";
import { getCachedQuoteSnapshot, recordQuoteRefreshFailure, upsertCachedQuote } from "./ticker-cache.service.js";
import { fetchFreshTickerQuote } from "./ticker.service.js";

const queue: string[] = [];
const queued = new Set<string>();
const inFlight = new Set<string>();

let activeWorkers = 0;
let lastActiveSyncAt: Date | null = null;
let lastActiveSyncError: string | null = null;
let trackedSymbolsCount = 0;

function normalizeSymbol(symbol: string): string {
  return symbol.trim().toUpperCase();
}

function drainQueue(): void {
  while (activeWorkers < env.QUOTE_REFRESH_CONCURRENCY && queue.length > 0) {
    const symbol = queue.shift();
    if (!symbol) continue;

    queued.delete(symbol);
    inFlight.add(symbol);
    activeWorkers += 1;

    void processSymbol(symbol).finally(() => {
      inFlight.delete(symbol);
      activeWorkers -= 1;
      drainQueue();
    });
  }
}

async function processSymbol(symbol: string): Promise<void> {
  const snapshot = await getCachedQuoteSnapshot(symbol);
  if (snapshot.isFresh) return;

  try {
    const quote = await fetchFreshTickerQuote(symbol);
    if (!quote) {
      await recordQuoteRefreshFailure(symbol, "Upstream quote fetch returned null");
      return;
    }
    await upsertCachedQuote(symbol, quote);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await recordQuoteRefreshFailure(symbol, message);
  }
}

export function enqueueQuoteRefresh(symbols: string[] | string): void {
  const items = Array.isArray(symbols) ? symbols : [symbols];
  for (const raw of items) {
    const symbol = normalizeSymbol(raw);
    if (!symbol || queued.has(symbol) || inFlight.has(symbol)) {
      continue;
    }
    queue.push(symbol);
    queued.add(symbol);
  }
  drainQueue();
}

export function recordActiveTickerSyncSuccess(symbolCount: number): void {
  trackedSymbolsCount = symbolCount;
  lastActiveSyncAt = new Date();
  lastActiveSyncError = null;
}

export function recordActiveTickerSyncFailure(error: string): void {
  lastActiveSyncAt = new Date();
  lastActiveSyncError = error;
}

export function getQuoteRefreshQueueStats() {
  return {
    queuedSymbols: queue.length,
    inFlightSymbols: inFlight.size,
    activeWorkers,
    trackedSymbolsCount,
    lastActiveSyncAt,
    lastActiveSyncError,
  };
}

export async function __waitForQuoteRefreshQueueToIdle(): Promise<void> {
  while (queue.length > 0 || inFlight.size > 0 || activeWorkers > 0) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

export function __resetQuoteRefreshQueueForTests(): void {
  queue.length = 0;
  queued.clear();
  inFlight.clear();
  activeWorkers = 0;
  trackedSymbolsCount = 0;
  lastActiveSyncAt = null;
  lastActiveSyncError = null;
}
