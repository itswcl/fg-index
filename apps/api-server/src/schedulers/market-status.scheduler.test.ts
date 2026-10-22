import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
const { refresh, stats } = vi.hoisted(() => ({ refresh: vi.fn(), stats: vi.fn() }));
vi.mock("../services/market-status.service.js", () => ({ refreshMarketStatus: refresh, getMarketStatusStats: stats }));

afterEach(() => vi.useRealTimers());
beforeEach(() => { vi.resetModules(); refresh.mockReset(); stats.mockReset(); });

describe("market status retry cadence", () => {
  it("retries a failed scheduled fetch next minute and stops after success", async () => {
    refresh.mockResolvedValue("regular");
    stats.mockReturnValueOnce({ configured: true, lastError: "network failure" })
      .mockReturnValue({ configured: true, lastError: null });
    const { __privateMarketStatusSchedulerForTests: { refreshIfScheduled, completedRefreshKeys } } = await import("./market-status.scheduler.js");
    await refreshIfScheduled(new Date("2026-10-19T13:30:00Z"));
    expect(completedRefreshKeys.size).toBe(0);
    await refreshIfScheduled(new Date("2026-10-19T13:31:00Z"));
    expect(completedRefreshKeys.size).toBe(1);
    await refreshIfScheduled(new Date("2026-10-19T13:32:00Z"));
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("bounds failures to five attempts and resumes at the next scheduled slot", async () => {
    refresh.mockResolvedValue(null);
    stats.mockReturnValue({ configured: true, lastError: "network failure" });
    const { __privateMarketStatusSchedulerForTests: { refreshIfScheduled } } = await import("./market-status.scheduler.js");
    for (let minute = 0; minute < 10; minute++) await refreshIfScheduled(new Date(`2026-10-19T13:0${minute}:00Z`));
    expect(refresh).toHaveBeenCalledTimes(5);
    await refreshIfScheduled(new Date("2026-10-19T13:25:00Z"));
    expect(refresh).toHaveBeenCalledTimes(6);
  });

  it("retries startup failure but never fetches on holidays or after 3 PM", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-19T16:00:00Z"));
    refresh.mockResolvedValue("regular");
    stats.mockReturnValueOnce({ configured: true, lastError: "network failure" }).mockReturnValue({ configured: true, lastError: null });
    const mod = await import("./market-status.scheduler.js");
    mod.startMarketStatusScheduler();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(refresh).toHaveBeenCalledTimes(2);
    await mod.__privateMarketStatusSchedulerForTests.refreshIfScheduled(new Date("2026-11-26T14:30:00Z"));
    await mod.__privateMarketStatusSchedulerForTests.refreshIfScheduled(new Date("2026-10-19T22:00:00Z"));
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});
