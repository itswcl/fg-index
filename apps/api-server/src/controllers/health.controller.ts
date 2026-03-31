import { Request, Response } from "express";
import { getCachedFearGreed } from "../schedulers/fear-greed.scheduler.js";
import { getCachedVix } from "../schedulers/vix.scheduler.js";

let lastFearGreedFetchTime: Date | null = null;
let lastVixFetchTime: Date | null = null;

export function recordFearGreedFetch() {
  lastFearGreedFetchTime = new Date();
}

export function recordVixFetch() {
  lastVixFetchTime = new Date();
}

export const getHealth = (req: Request, res: Response) => {
  const now = Date.now();
  const fgAge = lastFearGreedFetchTime ? now - lastFearGreedFetchTime.getTime() : Infinity;
  const vixAge = lastVixFetchTime ? now - lastVixFetchTime.getTime() : Infinity;

  const fgHealthy = fgAge < 60 * 60 * 1000; // 1 hour
  const vixHealthy = vixAge < 15 * 60 * 1000; // 15 minutes

  const hasFgData = getCachedFearGreed() !== null;
  const hasVixData = getCachedVix() !== null;

  const healthy = fgHealthy && vixHealthy && hasFgData;
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
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
};
