/** US equity full-day holidays; rules follow https://www.nyse.com/trade/hours-calendars.
 * Early-close days retain the application's fixed window for extended-hours quotes.
 * Unscheduled exchange closures are not predicted by this calendar.
 */
const pacificClock = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit",
  weekday: "short", hour: "2-digit", hourCycle: "h23",
});

function nthWeekday(year: number, month: number, weekday: number, nth: number): number {
  return 1 + (weekday - new Date(Date.UTC(year, month - 1, 1)).getUTCDay() + 7) % 7 + (nth - 1) * 7;
}

function observedDay(year: number, month: number, day: number): number {
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return day + (weekday === 6 ? -1 : weekday === 0 ? 1 : 0);
}

function goodFriday(year: number): Date {
  // Gregorian Easter (Meeus/Jones/Butcher), minus two days.
  const a = year % 19, b = Math.floor(year / 100), c = year % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = (h + l - 7 * m + 114) % 31 + 1;
  return new Date(Date.UTC(year, month - 1, day - 2));
}

function isHoliday(year: number, month: number, day: number): boolean {
  const friday = goodFriday(year);
  // A Saturday New Year's Day does not close the preceding year's final Friday.
  const newYear = new Date(Date.UTC(year, 0, 1)).getUTCDay();
  return (month === 1 && (day === 1 || (newYear === 0 && day === 2) || day === nthWeekday(year, 1, 1, 3)))
    || (month === 2 && day === nthWeekday(year, 2, 1, 3))
    || (month === friday.getUTCMonth() + 1 && day === friday.getUTCDate())
    || (month === 5 && day === nthWeekday(year, 5, 1, 5) - (nthWeekday(year, 5, 1, 5) > 31 ? 7 : 0))
    || (year >= 2022 && month === 6 && day === observedDay(year, 6, 19))
    || (month === 7 && day === observedDay(year, 7, 4))
    || (month === 9 && day === nthWeekday(year, 9, 1, 1))
    || (month === 11 && day === nthWeekday(year, 11, 4, 4))
    || (month === 12 && day === observedDay(year, 12, 25));
}

/** Scheduled 06:00–15:00 Pacific window, excluding weekends and full-day holidays. */
export function isMarketWindowOpen(now = new Date()): boolean {
  const parts = Object.fromEntries(pacificClock.formatToParts(now).map(({ type, value }) => [type, value]));
  return parts.weekday !== "Sat" && parts.weekday !== "Sun"
    && Number(parts.hour) >= 6 && Number(parts.hour) < 15
    && !isHoliday(Number(parts.year), Number(parts.month), Number(parts.day));
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
