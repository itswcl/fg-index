import { fetchSpxData } from "../services/spx.service.js";
import type { TickerQuote } from "@shared/types";

// Aliased so the scheduler's public API reads naturally.
type Spx = TickerQuote;
import { env } from "../config/env.js";
import { recordSpxFetch } from "../controllers/health.controller.js";

let spxCache: Spx | null = null;
let listeners: ((data: Spx | null) => void)[] = [];
let currentInterval = env.SPX_INTERVAL_MS;

export function subscribeToSpx(callback: (data: Spx | null) => void) {
  listeners.push(callback);
}

export function getCachedSpx(): Spx | null {
  return spxCache;
}

async function refreshSpx() {
  const start = Date.now();
  try {
    const data = await fetchSpxData();
    if (data) {
      spxCache = data;
      recordSpxFetch();
      listeners.forEach((cb) => cb(data));
    }

    const duration = Date.now() - start;

    // Throttle like VIX: widen to 30s if upstream is slow
    if (duration > 8000) {
      currentInterval = 30000;
    } else {
      currentInterval = env.SPX_INTERVAL_MS;
    }
  } catch (error) {
    process.stderr.write(`SPX Scheduler Error: ${error}\n`);
  } finally {
    setTimeout(refreshSpx, currentInterval);
  }
}

export function startSpxScheduler() {
  refreshSpx(); // Start real-time loop
}
