/** Scheduled stock-data window; Pacific daylight saving changes follow Los Angeles. */
const pacificClock = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Los_Angeles", weekday: "short", hour: "2-digit", hourCycle: "h23",
});

export function isMarketWindowOpen(now = new Date()): boolean {
  const parts = pacificClock.formatToParts(now);
  const weekday = parts.find((part) => part.type === "weekday")?.value;
  const hour = Number(parts.find((part) => part.type === "hour")?.value);
  return weekday !== "Sat" && weekday !== "Sun" && hour >= 6 && hour < 18;
}

export function isBtcSymbol(symbol: string): boolean {
  return ["BTC", "BTC-USD"].includes(symbol.trim().toUpperCase());
}

export function canRefreshSymbol(symbol: string, now = new Date()): boolean {
  return isBtcSymbol(symbol) || isMarketWindowOpen(now);
}

/** Mixed stock/BTC alerts wait for the stock window, regardless of AND/OR logic. */
export function canEvaluateMarketAlert(conditions: readonly { metric: string }[], now = new Date()): boolean {
  return isMarketWindowOpen(now) || (conditions.length > 0 && conditions.every((c) => c.metric === "btc"));
}
