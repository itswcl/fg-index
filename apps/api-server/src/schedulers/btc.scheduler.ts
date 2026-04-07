import { fetchBtcData } from "../services/btc.service.js";
import { Btc } from "@shared/types";
import { env } from "../config/env.js";
import { recordBtcFetch } from "../controllers/health.controller.js";

let btcCache: Btc | null = null;
let listeners: ((data: Btc | null) => void)[] = [];

export function subscribeToBtc(callback: (data: Btc | null) => void) {
  listeners.push(callback);
}

export function getCachedBtc(): Btc | null {
  return btcCache;
}

async function refreshBtc() {
  try {
    const data = await fetchBtcData();
    if (data) {
      btcCache = data;
      recordBtcFetch();
      listeners.forEach((cb) => cb(data));
    }
  } catch (error) {
    process.stderr.write(`BTC Scheduler Error: ${error}\n`);
  }
}

export function startBtcScheduler() {
  refreshBtc(); // Initial fetch
  setInterval(refreshBtc, env.BTC_INTERVAL_MS);
}
