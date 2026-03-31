import { fetchVixData } from "../services/vix.service.js";
import { Vix } from "@shared/types";
import { env } from "../config/env.js";
import { recordVixFetch } from "../controllers/health.controller.js";

let vixCache: Vix | null = null;
let listeners: ((data: Vix | null) => void)[] = [];
let currentInterval = env.VIX_REALTIME_INTERVAL_MS;
let timeoutId: NodeJS.Timeout | null = null;

export function subscribeToVix(callback: (data: Vix | null) => void) {
  listeners.push(callback);
}

export function getCachedVix(): Vix | null {
  return vixCache;
}

async function refreshVix() {
  const start = Date.now();
  try {
    const data = await fetchVixData();
    if (data) {
      vixCache = data;
      recordVixFetch();
      listeners.forEach((cb) => cb(data));
    }

    const duration = Date.now() - start;

    // Throttling logic
    if (duration > 8000) {
      currentInterval = 30000; // Widening to 30s
    } else {
      currentInterval = env.VIX_REALTIME_INTERVAL_MS;
    }
  } catch (error) {
    process.stderr.write(`Vix Scheduler Error: ${error}\n`);
  } finally {
    timeoutId = setTimeout(refreshVix, currentInterval);
  }
}

async function fallbackRefreshVix() {
    try {
        const data = await fetchVixData();
        if (data) {
          vixCache = data;
          recordVixFetch();
        }
    } catch (error) {
        // Silent fail for fallback
    }
}

export function startVixScheduler() {
  refreshVix(); // Start real-time loop
  setInterval(fallbackRefreshVix, env.VIX_FALLBACK_INTERVAL_MS);
}
