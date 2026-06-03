import { env } from "../config/env.js";
import { normalizeQuoteSymbol } from "./quote-symbols.service.js";
import {
  getCachedQuoteSnapshot,
  getFreshQuoteMemorySnapshot,
  recordQuoteRefreshFailure,
  upsertCachedQuote,
} from "./ticker-cache.service.js";
import { fetchFreshTickerQuote } from "./ticker.service.js";

const queue: string[] = [];
const queued = new Set<string>();
const inFlight = new Set<string>();
const failedUntil = new Map<string, number>();

let activeWorkers = 0;
let nextWorkerStartAtMs = 0;
let drainTimer: ReturnType<typeof setTimeout> | null = null;
let lastActiveSyncAt: Date | null = null;
let lastActiveSyncError: string | null = null;
let trackedSymbolsCount = 0;
let lastRefreshFailure: { symbol: string; error: string; at: Date } | null = null;

function normalizeSymbol(symbol: string): string {
  return normalizeQuoteSymbol(symbol);
}

function isCoolingDown(symbol: string): boolean {
  const until = failedUntil.get(symbol);
  if (!until) return false;
  if (Date.now() >= until) {
    failedUntil.delete(symbol);
    return false;
  }
  return true;
}

function recordWorkerFailure(symbol: string, error: string): void {
  failedUntil.set(symbol, Date.now() + env.QUOTE_REFRESH_FAILURE_COOLDOWN_MS);
  lastRefreshFailure = { symbol, error, at: new Date() };
}

function scheduleDrain(delayMs: number): void {
  if (drainTimer) return;
  drainTimer = setTimeout(() => {
    drainTimer = null;
    drainQueue();
  }, delayMs);
}

function drainQueue(): void {
  while (activeWorkers < env.QUOTE_REFRESH_CONCURRENCY && queue.length > 0) {
    const waitMs = nextWorkerStartAtMs - Date.now();
    if (waitMs > 0) {
      scheduleDrain(waitMs);
      return;
    }

    const symbol = queue.shift();
    if (!symbol) continue;

    queued.delete(symbol);
    if (isCoolingDown(symbol)) {
      continue;
    }
    inFlight.add(symbol);
    activeWorkers += 1;
    nextWorkerStartAtMs = Date.now() + Math.max(0, env.QUOTE_REFRESH_SPACING_MS);

    void processSymbol(symbol).finally(() => {
      inFlight.delete(symbol);
      activeWorkers -= 1;
      drainQueue();
    });
  }
}

async function processSymbol(symbol: string): Promise<void> {
  try {
    const snapshot =
      getFreshQuoteMemorySnapshot(symbol) ?? (await getCachedQuoteSnapshot(symbol));
    if (snapshot.isFresh) {
      failedUntil.delete(symbol);
      return;
    }

    const quote = await fetchFreshTickerQuote(symbol);
    if (!quote) {
      const message = "Upstream quote fetch returned null";
      recordWorkerFailure(symbol, message);
      await recordQuoteRefreshFailure(symbol, message);
      return;
    }
    failedUntil.delete(symbol);
    await upsertCachedQuote(symbol, quote, {
      previousPrice: snapshot.quote?.price,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    recordWorkerFailure(symbol, message);
    await recordQuoteRefreshFailure(symbol, message);
  }
}

export function enqueueQuoteRefresh(symbols: string[] | string): void {
  const items = Array.isArray(symbols) ? symbols : [symbols];
  for (const raw of items) {
    const symbol = normalizeSymbol(raw);
    if (!symbol || queued.has(symbol) || inFlight.has(symbol) || isCoolingDown(symbol)) {
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
  const coolingDownSymbols = Array.from(failedUntil.keys()).filter(isCoolingDown);

  return {
    queuedSymbols: queue.length,
    inFlightSymbols: inFlight.size,
    activeWorkers,
    coolingDownSymbols: coolingDownSymbols.length,
    trackedSymbolsCount,
    lastActiveSyncAt,
    lastActiveSyncError,
    lastRefreshFailure,
    nextWorkerStartAt: nextWorkerStartAtMs > Date.now()
      ? new Date(nextWorkerStartAtMs)
      : null,
  };
}

export async function __waitForQuoteRefreshQueueToIdle(): Promise<void> {
  while (queue.length > 0 || inFlight.size > 0 || activeWorkers > 0) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

export function __resetQuoteRefreshQueueForTests(): void {
  if (drainTimer) {
    clearTimeout(drainTimer);
    drainTimer = null;
  }
  queue.length = 0;
  queued.clear();
  inFlight.clear();
  failedUntil.clear();
  activeWorkers = 0;
  nextWorkerStartAtMs = 0;
  trackedSymbolsCount = 0;
  lastActiveSyncAt = null;
  lastActiveSyncError = null;
  lastRefreshFailure = null;
}
