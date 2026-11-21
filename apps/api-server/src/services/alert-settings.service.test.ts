import { afterEach, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { canEvaluateMarketAlert, canRefreshSymbol } from "@shared/types";
import { getStockAlertCutoff } from "./alert-settings.service.js";

vi.mock("node:fs/promises", () => ({ readFile: vi.fn() }));

afterEach(() => vi.useRealTimers());

it("reloads an edited cutoff in the same process and retains the last valid setting on bad edits", async () => {
  vi.useFakeTimers();
  const read = vi.mocked(readFile);
  read.mockResolvedValue("13:30\n");
  const tick = new Date("2026-11-20T21:45:00Z");
  const conditions = [{ metric: "vix" }];
  expect(canEvaluateMarketAlert(conditions, tick, await getStockAlertCutoff())).toBe(false);

  read.mockResolvedValue("14:00\n");
  expect(await getStockAlertCutoff()).toBe("13:30");
  vi.advanceTimersByTime(15_000);
  const cutoffs = await Promise.all([getStockAlertCutoff(), getStockAlertCutoff()]);
  expect(cutoffs).toEqual(["14:00", "14:00"]);
  expect(read).toHaveBeenCalledTimes(2);
  expect(canEvaluateMarketAlert(conditions, tick, cutoffs[0])).toBe(true);

  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  try {
    read.mockResolvedValue("15:01\n");
    vi.advanceTimersByTime(15_000);
    expect(await getStockAlertCutoff()).toBe("14:00");
    read.mockRejectedValue(Object.assign(new Error("missing"), { code: "ENOENT" }));
    vi.advanceTimersByTime(15_000);
    expect(await getStockAlertCutoff()).toBe("14:00");
    expect(canRefreshSymbol("AAPL", tick)).toBe(true);
    expect(canEvaluateMarketAlert([{ metric: "btc" }], tick, "13:30")).toBe(true);
  } finally {
    stderr.mockRestore();
  }
});
