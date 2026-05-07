import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../services/ticker-cache.service.js", () => ({
  listActiveTrackedSymbols: vi.fn(),
}));

vi.mock("../services/quote-refresh-queue.service.js", () => ({
  enqueueQuoteRefresh: vi.fn(),
  recordActiveTickerSyncFailure: vi.fn(),
  recordActiveTickerSyncSuccess: vi.fn(),
}));

import { listActiveTrackedSymbols } from "../services/ticker-cache.service.js";
import {
  enqueueQuoteRefresh,
  recordActiveTickerSyncFailure,
  recordActiveTickerSyncSuccess,
} from "../services/quote-refresh-queue.service.js";
import {
  __resetBackgroundDbCircuitForTests,
  recordBackgroundDbFailure,
} from "../services/background-db-circuit.service.js";

const listActiveTrackedSymbolsMock =
  listActiveTrackedSymbols as unknown as ReturnType<typeof vi.fn>;
const enqueueQuoteRefreshMock =
  enqueueQuoteRefresh as unknown as ReturnType<typeof vi.fn>;
const recordActiveTickerSyncFailureMock =
  recordActiveTickerSyncFailure as unknown as ReturnType<typeof vi.fn>;
const recordActiveTickerSyncSuccessMock =
  recordActiveTickerSyncSuccess as unknown as ReturnType<typeof vi.fn>;

describe("ticker quote scheduler", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    __resetBackgroundDbCircuitForTests();
    listActiveTrackedSymbolsMock.mockReset();
    enqueueQuoteRefreshMock.mockReset();
    recordActiveTickerSyncFailureMock.mockReset();
    recordActiveTickerSyncSuccessMock.mockReset();
  });

  it("skips active ticker DB reads while the background DB circuit is cooling down", async () => {
    recordBackgroundDbFailure(
      "test",
      new Error("Can't reach database server at `aws-1-us-east-2.pooler.supabase.com:6543`")
    );

    const mod = await import("./ticker-quote.scheduler.js");
    mod.__privateTickerQuoteSchedulerForTests.resetInFlightState();
    await mod.__privateTickerQuoteSchedulerForTests.refreshActiveTickerQuotes();

    expect(listActiveTrackedSymbolsMock).not.toHaveBeenCalled();
    expect(enqueueQuoteRefreshMock).not.toHaveBeenCalled();
    expect(recordActiveTickerSyncFailureMock).toHaveBeenCalledWith(
      expect.stringContaining("Background DB cooldown active")
    );
  });

  it("does not overlap active ticker DB reads when a prior sync is still running", async () => {
    let releaseSync!: (symbols: string[]) => void;
    listActiveTrackedSymbolsMock.mockImplementationOnce(
      () =>
        new Promise<string[]>((resolve) => {
          releaseSync = resolve;
        })
    );

    const mod = await import("./ticker-quote.scheduler.js");
    mod.__privateTickerQuoteSchedulerForTests.resetInFlightState();

    const first = mod.__privateTickerQuoteSchedulerForTests.refreshActiveTickerQuotes();
    await mod.__privateTickerQuoteSchedulerForTests.refreshActiveTickerQuotes();

    releaseSync(["AAPL", "MSFT"]);
    await first;

    expect(listActiveTrackedSymbolsMock).toHaveBeenCalledTimes(1);
    expect(recordActiveTickerSyncSuccessMock).toHaveBeenCalledWith(2);
    expect(enqueueQuoteRefreshMock).toHaveBeenCalledWith(["AAPL", "MSFT"]);
  });
});
