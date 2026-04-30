import { Request, Response } from "express";
import { getCachedFearGreed } from "../schedulers/fear-greed.scheduler.js";
import { getCachedVix } from "../schedulers/vix.scheduler.js";
import { getCachedBtc } from "../schedulers/btc.scheduler.js";
import { getCachedSpx } from "../schedulers/spx.scheduler.js";
import { getQuoteRefreshQueueStats } from "../services/quote-refresh-queue.service.js";

let lastFearGreedFetchTime: Date | null = null;
let lastVixFetchTime: Date | null = null;
let lastBtcFetchTime: Date | null = null;
let lastSpxFetchTime: Date | null = null;

export function recordFearGreedFetch() {
  lastFearGreedFetchTime = new Date();
}

export function recordVixFetch() {
  lastVixFetchTime = new Date();
}

export function recordBtcFetch() {
  lastBtcFetchTime = new Date();
}

export function recordSpxFetch() {
  lastSpxFetchTime = new Date();
}

export const getHealth = (req: Request, res: Response) => {
  const now = Date.now();
  const fgAge = lastFearGreedFetchTime ? now - lastFearGreedFetchTime.getTime() : Infinity;
  const vixAge = lastVixFetchTime ? now - lastVixFetchTime.getTime() : Infinity;
  const btcAge = lastBtcFetchTime ? now - lastBtcFetchTime.getTime() : Infinity;
  const spxAge = lastSpxFetchTime ? now - lastSpxFetchTime.getTime() : Infinity;

  const fgHealthy = fgAge < 60 * 60 * 1000; // 1 hour
  const vixHealthy = vixAge < 15 * 60 * 1000; // 15 minutes
  const btcHealthy = btcAge < 5 * 60 * 1000; // 5 minutes
  const spxHealthy = spxAge < 15 * 60 * 1000; // 15 minutes

  const hasFgData = getCachedFearGreed() !== null;
  const hasVixData = getCachedVix() !== null;
  const hasBtcData = getCachedBtc() !== null;
  const hasSpxData = getCachedSpx() !== null;
  const quoteRefresh = getQuoteRefreshQueueStats();

  const healthy = fgHealthy && vixHealthy && btcHealthy && hasFgData;
  const status = healthy ? 200 : 503;

  res.status(status).json({
    status: healthy ? "ok" : "degraded",
    fearGreed: {
      hasData: hasFgData,
      lastFetchAgeMs: lastFearGreedFetchTime ? fgAge : null,
      healthy: fgHealthy,
    },
    vix: {
      hasData: hasVixData,
      lastFetchAgeMs: lastVixFetchTime ? vixAge : null,
      healthy: vixHealthy,
    },
    btc: {
      hasData: hasBtcData,
      lastFetchAgeMs: lastBtcFetchTime ? btcAge : null,
      healthy: btcHealthy,
    },
    spx: {
      hasData: hasSpxData,
      lastFetchAgeMs: lastSpxFetchTime ? spxAge : null,
      healthy: spxHealthy,
    },
    tickerQuotes: {
      queuedSymbols: quoteRefresh.queuedSymbols,
      inFlightSymbols: quoteRefresh.inFlightSymbols,
      activeWorkers: quoteRefresh.activeWorkers,
      coolingDownSymbols: quoteRefresh.coolingDownSymbols,
      trackedSymbolsCount: quoteRefresh.trackedSymbolsCount,
      lastActiveSyncAt: quoteRefresh.lastActiveSyncAt,
      lastActiveSyncError: quoteRefresh.lastActiveSyncError,
      lastRefreshFailure: quoteRefresh.lastRefreshFailure,
    },
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
};
