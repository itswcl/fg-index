import { FearGreedSchema } from "@shared/types";
import { loadIndicatorSnapshot, saveIndicatorSnapshot } from "../services/indicator-snapshot.service.js";
import { fetchCnnData } from "../services/cnn.service.js";
import { FearGreed } from "@shared/types";
import { startMarketWindowTask } from "./market-window.js";
import { isMarketWindowOpen } from "@shared/types";
import { env } from "../config/env.js";
import { recordFearGreedFetch } from "../controllers/health.controller.js";

let fearGreedCache: FearGreed | null = loadIndicatorSnapshot("fear-greed", FearGreedSchema);
let listeners: ((data: FearGreed) => void)[] = [];

export function subscribeToFearGreed(callback: (data: FearGreed) => void) {
  listeners.push(callback);
}

export function getCachedFearGreed(): FearGreed | null {
  return fearGreedCache;
}

async function refreshFearGreed() {
  if (!isMarketWindowOpen()) return;
  try {
    const data = await fetchCnnData();
    fearGreedCache = data;
    void saveIndicatorSnapshot("fear-greed", data);
    recordFearGreedFetch();
    listeners.forEach((cb) => cb(data));
  } catch (error) {
    process.stderr.write(`FearGreed Scheduler Error: ${error}\n`);
  }
}

export function startFearGreedScheduler() {
  startMarketWindowTask(refreshFearGreed, () => env.FEAR_GREED_INTERVAL_MS);
}
