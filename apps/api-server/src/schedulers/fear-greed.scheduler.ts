import { fetchCnnData } from "../services/cnn.service.js";
import { FearGreed } from "@shared/types";
import { env } from "../config/env.js";
import { recordFearGreedFetch } from "../controllers/health.controller.js";

let fearGreedCache: FearGreed | null = null;
let listeners: ((data: FearGreed) => void)[] = [];

export function subscribeToFearGreed(callback: (data: FearGreed) => void) {
  listeners.push(callback);
}

export function getCachedFearGreed(): FearGreed | null {
  return fearGreedCache;
}

async function refreshFearGreed() {
  try {
    const data = await fetchCnnData();
    fearGreedCache = data;
    recordFearGreedFetch();
    listeners.forEach((cb) => cb(data));
  } catch (error) {
    process.stderr.write(`FearGreed Scheduler Error: ${error}\n`);
  }
}

export function startFearGreedScheduler() {
  refreshFearGreed(); // Initial fetch
  setInterval(refreshFearGreed, env.FEAR_GREED_INTERVAL_MS);
}
