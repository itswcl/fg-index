import { isMarketWindowOpen } from "@shared/types";
import { getMarketStatusStats, refreshMarketStatus } from "../services/market-status.service.js";

const MARKET_STATUS_CHECK_INTERVAL_MS = 60_000;
const REFRESH_TIMES_PT = new Set([
  "06:00",
  "06:25",
  "06:30",
  "06:35",
  "12:55",
  "13:00",
  "13:05",
]);

const completedRefreshKeys = new Set<string>();
const MAX_ATTEMPTS = 5;
let pendingRefresh: { key: string; attempts: number } | null = null;
let refreshInFlight = false;

function getPacificRefreshKey(date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const byType = new Map(parts.map((part) => [part.type, part.value]));
  return [
    `${byType.get("year")}-${byType.get("month")}-${byType.get("day")}`,
    `${byType.get("hour")}:${byType.get("minute")}`,
  ].join("T");
}

async function refreshIfScheduled(now = new Date(), startup = false): Promise<void> {
  if (!isMarketWindowOpen(now) || refreshInFlight) return;
  const key = getPacificRefreshKey(now);
  const day = key.slice(0, 10);
  for (const completed of completedRefreshKeys) {
    if (!completed.startsWith(day)) completedRefreshKeys.delete(completed);
  }
  if (pendingRefresh && !pendingRefresh.key.startsWith(day)) pendingRefresh = null;
  if ((startup || REFRESH_TIMES_PT.has(key.slice(-5))) && !completedRefreshKeys.has(key) && pendingRefresh?.key !== key) {
    pendingRefresh = { key, attempts: 0 };
  }
  if (!pendingRefresh || pendingRefresh.attempts >= MAX_ATTEMPTS) return;
  const attempt = pendingRefresh;
  attempt.attempts += 1;
  refreshInFlight = true;
  try {
    const session = await refreshMarketStatus();
    const stats = getMarketStatusStats();
    if (stats.lastError || !stats.configured || session === null) return;
    completedRefreshKeys.add(attempt.key);
    pendingRefresh = null;
    process.stdout.write(`Market status refreshed: ${session}\n`);
  } finally {
    refreshInFlight = false;
  }
}

export function startMarketStatusScheduler(): void {
  void refreshIfScheduled(new Date(), true);
  setInterval(() => {
    void refreshIfScheduled();
  }, MARKET_STATUS_CHECK_INTERVAL_MS);
}

export const __privateMarketStatusSchedulerForTests = {
  getPacificRefreshKey,
  refreshIfScheduled,
  completedRefreshKeys,
};
