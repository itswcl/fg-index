import { afterEach, describe, expect, it, vi } from "vitest";
import { canEvaluateMarketAlert, canRefreshSymbol, isMarketWindowOpen } from "@shared/types";
import { startMarketWindowTask } from "../schedulers/market-window.js";

afterEach(() => vi.useRealTimers());

describe("Pacific weekday data window", () => {
  it.each([
    ["2026-10-19T12:59:59Z", false], // Monday 05:59 PDT
    ["2026-10-19T13:00:00Z", true],
    ["2026-10-19T21:59:59Z", true],
    ["2026-10-19T22:00:00Z", false], // Monday 15:00 PDT
    ["2026-10-17T19:00:00Z", false], // Saturday
    ["2026-10-18T19:00:00Z", false], // Sunday
    ["2026-12-07T13:59:59Z", false], // Monday 05:59 PST
    ["2026-12-07T14:00:00Z", true],
    ["2026-12-07T23:00:00Z", false],
    ["2026-03-09T13:00:00Z", true], // Monday after DST begins
    ["2026-11-02T14:00:00Z", true], // Monday after DST ends
  ])("%s -> %s", (timestamp, expected) => {
    expect(isMarketWindowOpen(new Date(timestamp))).toBe(expected);
  });

  it.each([
    "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25",
    "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25",
    "2027-06-18", "2027-07-05", "2027-12-24", "2028-01-17", "2028-04-14",
  ])("pauses stocks on full-day exchange holiday %s while BTC continues", (day) => {
    const now = new Date(`${day}T18:00:00Z`);
    expect(isMarketWindowOpen(now)).toBe(false);
    expect(canRefreshSymbol("AAPL", now)).toBe(false);
    expect(canRefreshSymbol("BTC-USD", now)).toBe(true);
  });

  it("retains early-close days and the NYSE Saturday New Year exception", () => {
    expect(isMarketWindowOpen(new Date("2026-11-27T21:00:00Z"))).toBe(true);
    expect(isMarketWindowOpen(new Date("2027-12-31T18:00:00Z"))).toBe(true);
  });

  it("allows only BTC symbols and BTC-only alerts outside the window", () => {
    const weekend = new Date("2026-10-18T19:00:00Z");
    expect(canRefreshSymbol("BTC-USD", weekend)).toBe(true);
    expect(canRefreshSymbol("btc", weekend)).toBe(true);
    expect(canRefreshSymbol("AAPL", weekend)).toBe(false);
    expect(canRefreshSymbol("ETH-USD", weekend)).toBe(false);
    expect(canEvaluateMarketAlert([{ metric: "btc" }], weekend)).toBe(true);
    expect(canEvaluateMarketAlert([{ metric: "btc" }, { metric: "vix" }], weekend)).toBe(false);
    expect(canEvaluateMarketAlert([], weekend)).toBe(false);
  });

  it("resumes promptly at Monday opening and pauses after close", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-19T12:59:45Z"));
    const task = vi.fn(async () => {});
    startMarketWindowTask(task, () => 15 * 60_000);
    expect(task).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(task).toHaveBeenCalledTimes(1);
    vi.setSystemTime(new Date("2026-10-19T22:00:00Z"));
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(task).toHaveBeenCalledTimes(1);
  });
});
