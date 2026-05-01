import { refreshMarketStatus } from "../services/market-status.service.js";

const MARKET_STATUS_CHECK_INTERVAL_MS = 60_000;
const REFRESH_TIMES_PT = new Set([
  "06:25",
  "06:30",
  "06:35",
  "12:55",
  "13:00",
  "13:05",
]);

const completedRefreshKeys = new Set<string>();

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

async function refreshIfScheduled(now = new Date()): Promise<void> {
  const key = getPacificRefreshKey(now);
  const minute = key.slice(-5);
  if (!REFRESH_TIMES_PT.has(minute) || completedRefreshKeys.has(key)) {
    return;
  }

  completedRefreshKeys.add(key);
  const session = await refreshMarketStatus();
  process.stdout.write(`Market status refreshed: ${session ?? "unknown"}\n`);
}

export function startMarketStatusScheduler(): void {
  void refreshMarketStatus();
  setInterval(() => {
    void refreshIfScheduled();
  }, MARKET_STATUS_CHECK_INTERVAL_MS);
}

export const __privateMarketStatusSchedulerForTests = {
  getPacificRefreshKey,
  refreshIfScheduled,
  completedRefreshKeys,
};
