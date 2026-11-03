import { canRefreshSymbol } from "@shared/types";
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
const visibleQueued = new Set<string>();
const inFlight = new Set<string>();
const failedUntil = new Map<string, number>();
const consecutiveFailures = new Map<string, number>();
const MAX_VISIBLE_BURST = 3;
let visibleBurst = 0;

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
  const failures = Math.min((consecutiveFailures.get(symbol) ?? 0) + 1, 3);
  consecutiveFailures.set(symbol, failures);
  const multiplier = [1, 2, 5][failures - 1];
  failedUntil.set(symbol, Date.now() + env.QUOTE_REFRESH_FAILURE_COOLDOWN_MS * multiplier);
  lastRefreshFailure = { symbol, error, at: new Date() };
}

function recordWorkerSuccess(symbol: string): void {
  failedUntil.delete(symbol);
  consecutiveFailures.delete(symbol);
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

    // Up to three visible jobs, then one background job when both are waiting.
    // FIFO within each class keeps polling from starving the tracked watchlist
    // (including symbols used by alerts).
    const visibleIndex = queue.findIndex((symbol) => visibleQueued.has(symbol));
    const backgroundIndex = queue.findIndex((symbol) => !visibleQueued.has(symbol));
    const index = visibleIndex >= 0 && (visibleBurst < MAX_VISIBLE_BURST || backgroundIndex < 0)
      ? visibleIndex : backgroundIndex;
    const [symbol] = queue.splice(index, 1);
    if (!symbol) continue;

    const visible = visibleQueued.delete(symbol);
    queued.delete(symbol);
    if (!canRefreshSymbol(symbol) || isCoolingDown(symbol)) {
      continue;
    }
    visibleBurst = visible ? Math.min(visibleBurst + 1, MAX_VISIBLE_BURST) : 0;
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
  if (!canRefreshSymbol(symbol)) return;
  try {
    const snapshot =
      getFreshQuoteMemorySnapshot(symbol) ?? (await getCachedQuoteSnapshot(symbol));
    if (snapshot.isFresh) {
      recordWorkerSuccess(symbol);
      return;
    }

    if (!canRefreshSymbol(symbol)) return;
    const quote = await fetchFreshTickerQuote(symbol);
    if (!quote) {
      throw new Error("Upstream quote fetch returned null");
    }
    await upsertCachedQuote(symbol, quote, {
      previousPrice: snapshot.quote?.price,
    });
    recordWorkerSuccess(symbol);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    recordWorkerFailure(symbol, message);
    try {
      await recordQuoteRefreshFailure(symbol, message);
    } catch {
      // A DB outage must not reject the worker promise or count one failed
      // refresh twice. Keep the in-memory cooldown until a later retry.
      process.stderr.write(`Unable to persist quote refresh failure for ${symbol}\n`);
    }
  }
}

export function enqueueQuoteRefresh(
  symbols: string[] | string,
  options: { priority?: "visible" | "background" } = {}
): void {
  const items = Array.isArray(symbols) ? symbols : [symbols];
  for (const raw of items) {
    const symbol = normalizeSymbol(raw);
    if (!symbol || !canRefreshSymbol(symbol) || inFlight.has(symbol) || isCoolingDown(symbol)) {
      continue;
    }
    if (queued.has(symbol)) {
      if (options.priority === "visible") visibleQueued.add(symbol);
      continue;
    }
    // Browser polling and scheduler syncs repeatedly submit the same symbols.
    // Fresh memory hits need no upstream work and must not consume paced slots
    // ahead of stale quotes. The worker checks freshness again when it starts.
    if (getFreshQuoteMemorySnapshot(symbol)?.isFresh) {
      recordWorkerSuccess(symbol);
      continue;
    }
    queue.push(symbol);
    queued.add(symbol);
    if (options.priority === "visible") visibleQueued.add(symbol);
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
    visibleQueuedSymbols: visibleQueued.size,
    backgroundQueuedSymbols: queue.length - visibleQueued.size,
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
  visibleQueued.clear();
  inFlight.clear();
  failedUntil.clear();
  consecutiveFailures.clear();
  visibleBurst = 0;
  activeWorkers = 0;
  nextWorkerStartAtMs = 0;
  trackedSymbolsCount = 0;
  lastActiveSyncAt = null;
  lastActiveSyncError = null;
  lastRefreshFailure = null;
}
