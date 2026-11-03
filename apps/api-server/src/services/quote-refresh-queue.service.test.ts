import { beforeEach, describe, expect, it, vi } from "vitest";

function applyEnv() {
  process.env.CNN_FEAR_GREED_URL = "https://example.com/fear-greed";
  process.env.GOOGLE_FINANCE_VIX_URL = "https://example.com/vix";
  process.env.YAHOO_FINANCE_VIX_URL = "https://example.com/vix-yahoo";
  process.env.GOOGLE_FINANCE_BTC_URL = "https://example.com/btc";
  process.env.YAHOO_FINANCE_BTC_URL = "https://example.com/btc-yahoo";
  process.env.GOOGLE_FINANCE_SPX_URL = "https://example.com/spx";
  process.env.YAHOO_FINANCE_SPX_URL = "https://example.com/spx-yahoo";
  process.env.SCRAPER_USER_AGENT = "test-agent";
  process.env.PORT = "8080";
  process.env.FEAR_GREED_INTERVAL_MS = "1800000";
  process.env.VIX_REALTIME_INTERVAL_MS = "10000";
  process.env.VIX_FALLBACK_INTERVAL_MS = "300000";
  process.env.BTC_INTERVAL_MS = "60000";
  process.env.SPX_INTERVAL_MS = "10000";
  process.env.QUOTE_REFRESH_INTERVAL_MS = "15000";
  process.env.QUOTE_REFRESH_CONCURRENCY = "2";
  process.env.QUOTE_REFRESH_SPACING_MS = "0";
  process.env.QUOTE_REFRESH_FAILURE_COOLDOWN_MS = "60000";
  process.env.CORS_ORIGIN = "*";
  process.env.INTERNAL_API_KEY = "test-key";
  process.env.DATABASE_URL = "https://example.com/db";
  process.env.DIRECT_URL = "https://example.com/direct";
  process.env.SUPABASE_URL = "https://example.com/supabase";
  process.env.SUPABASE_JWKS_URL = "https://example.com/jwks";
}

vi.mock("./ticker-cache.service.js", () => ({
  getCachedQuoteSnapshot: vi.fn(),
  getFreshQuoteMemorySnapshot: vi.fn(),
  recordQuoteRefreshFailure: vi.fn(),
  upsertCachedQuote: vi.fn(),
}));

vi.mock("./ticker.service.js", () => ({
  fetchFreshTickerQuote: vi.fn(),
}));

import {
  getCachedQuoteSnapshot,
  getFreshQuoteMemorySnapshot,
  recordQuoteRefreshFailure,
  upsertCachedQuote,
} from "./ticker-cache.service.js";
import { fetchFreshTickerQuote } from "./ticker.service.js";

const getCachedQuoteSnapshotMock =
  getCachedQuoteSnapshot as unknown as ReturnType<typeof vi.fn>;
const getFreshQuoteMemorySnapshotMock =
  getFreshQuoteMemorySnapshot as unknown as ReturnType<typeof vi.fn>;
const recordQuoteRefreshFailureMock =
  recordQuoteRefreshFailure as unknown as ReturnType<typeof vi.fn>;
const upsertCachedQuoteMock =
  upsertCachedQuote as unknown as ReturnType<typeof vi.fn>;
const fetchFreshTickerQuoteMock =
  fetchFreshTickerQuote as unknown as ReturnType<typeof vi.fn>;

describe("quote refresh queue service", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-21T17:00:00Z"));
    vi.restoreAllMocks();
    vi.resetModules();
    applyEnv();
    getFreshQuoteMemorySnapshotMock.mockReset();
    getFreshQuoteMemorySnapshotMock.mockReturnValue(null);
    getCachedQuoteSnapshotMock.mockReset();
    recordQuoteRefreshFailureMock.mockReset();
    upsertCachedQuoteMock.mockReset();
    fetchFreshTickerQuoteMock.mockReset();
  });

  it("blocks stock refreshes but permits BTC on weekends", async () => {
    vi.setSystemTime(new Date("2026-10-18T19:00:00Z"));
    getFreshQuoteMemorySnapshotMock.mockReturnValue({ quote: null, isFresh: true });
    const mod = await import("./quote-refresh-queue.service.js");
    mod.__resetQuoteRefreshQueueForTests();
    mod.enqueueQuoteRefresh(["AAPL", "BTC-USD"]);
    await mod.__waitForQuoteRefreshQueueToIdle();
    expect(getFreshQuoteMemorySnapshotMock).toHaveBeenCalledTimes(1);
    expect(getFreshQuoteMemorySnapshotMock).toHaveBeenCalledWith("BTC-USD");
  });

  it("skips upstream work when the cache is already fresh", async () => {
    getFreshQuoteMemorySnapshotMock.mockReturnValue({
      quote: { ticker: "AAPL", price: 100 },
      isFresh: true,
    });

    const mod = await import("./quote-refresh-queue.service.js");
    mod.__resetQuoteRefreshQueueForTests();

    mod.enqueueQuoteRefresh("AAPL");
    await mod.__waitForQuoteRefreshQueueToIdle();

    expect(getCachedQuoteSnapshotMock).not.toHaveBeenCalled();
    expect(fetchFreshTickerQuoteMock).not.toHaveBeenCalled();
    expect(upsertCachedQuoteMock).not.toHaveBeenCalled();
  });

  it("dedupes duplicate symbols and persists a successful refresh", async () => {
    getCachedQuoteSnapshotMock.mockResolvedValue({
      quote: null,
      isFresh: false,
    });
    fetchFreshTickerQuoteMock.mockResolvedValue({
      ticker: "AAPL",
      name: "Apple",
      price: 180,
      previousClose: 179,
      change: 1,
      changePercent: 0.56,
      fetchedAt: new Date().toISOString(),
    });

    const mod = await import("./quote-refresh-queue.service.js");
    mod.__resetQuoteRefreshQueueForTests();

    mod.enqueueQuoteRefresh(["AAPL", "AAPL", "aapl"]);
    await mod.__waitForQuoteRefreshQueueToIdle();

    expect(fetchFreshTickerQuoteMock).toHaveBeenCalledTimes(1);
    expect(fetchFreshTickerQuoteMock).toHaveBeenCalledWith("AAPL");
    expect(upsertCachedQuoteMock).toHaveBeenCalledTimes(1);
    expect(upsertCachedQuoteMock).toHaveBeenCalledWith(
      "AAPL",
      expect.objectContaining({ ticker: "AAPL", price: 180 }),
      { previousPrice: undefined }
    );
  });

  it("passes previous cached price into the sanity guard path", async () => {
    getCachedQuoteSnapshotMock.mockResolvedValue({
      quote: { ticker: "AAPL", price: 100 },
      isFresh: false,
    });
    fetchFreshTickerQuoteMock.mockResolvedValue({
      ticker: "AAPL",
      name: "Apple",
      price: 120,
      previousClose: 119,
      change: 1,
      changePercent: 0.84,
      fetchedAt: new Date().toISOString(),
    });

    const mod = await import("./quote-refresh-queue.service.js");
    mod.__resetQuoteRefreshQueueForTests();

    mod.enqueueQuoteRefresh("AAPL");
    await mod.__waitForQuoteRefreshQueueToIdle();

    expect(upsertCachedQuoteMock).toHaveBeenCalledWith(
      "AAPL",
      expect.objectContaining({ ticker: "AAPL", price: 120 }),
      { previousPrice: 100 }
    );
  });

  it("records a refresh failure when upstream returns null", async () => {
    getCachedQuoteSnapshotMock.mockResolvedValue({
      quote: null,
      isFresh: false,
    });
    fetchFreshTickerQuoteMock.mockResolvedValue(null);

    const mod = await import("./quote-refresh-queue.service.js");
    mod.__resetQuoteRefreshQueueForTests();

    mod.enqueueQuoteRefresh("TSLA");
    await mod.__waitForQuoteRefreshQueueToIdle();

    expect(recordQuoteRefreshFailureMock).toHaveBeenCalledWith(
      "TSLA",
      "Upstream quote fetch returned null"
    );
  });

  it("does not immediately requeue symbols that are cooling down after failure", async () => {
    getCachedQuoteSnapshotMock.mockResolvedValue({
      quote: null,
      isFresh: false,
    });
    fetchFreshTickerQuoteMock.mockResolvedValue(null);

    const mod = await import("./quote-refresh-queue.service.js");
    mod.__resetQuoteRefreshQueueForTests();

    mod.enqueueQuoteRefresh("ESW00");
    await mod.__waitForQuoteRefreshQueueToIdle();
    mod.enqueueQuoteRefresh("ESW00");
    await mod.__waitForQuoteRefreshQueueToIdle();

    expect(fetchFreshTickerQuoteMock).toHaveBeenCalledTimes(1);
    expect(recordQuoteRefreshFailureMock).toHaveBeenCalledTimes(1);
    expect(mod.getQuoteRefreshQueueStats()).toMatchObject({
      coolingDownSymbols: 1,
      lastRefreshFailure: {
        symbol: "ESW00",
        error: "Upstream quote fetch returned null",
      },
    });
  });

  it("paces upstream refresh starts to avoid provider bursts", async () => {
    vi.useFakeTimers();
    process.env.QUOTE_REFRESH_SPACING_MS = "1000";
    getCachedQuoteSnapshotMock.mockResolvedValue({
      quote: null,
      isFresh: false,
    });
    fetchFreshTickerQuoteMock.mockResolvedValue({
      ticker: "AAPL",
      name: "Apple",
      price: 180,
      previousClose: 179,
      change: 1,
      changePercent: 0.56,
      fetchedAt: new Date().toISOString(),
    });

    const mod = await import("./quote-refresh-queue.service.js");
    mod.__resetQuoteRefreshQueueForTests();

    mod.enqueueQuoteRefresh(["AAPL", "MSFT"]);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchFreshTickerQuoteMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(999);
    expect(fetchFreshTickerQuoteMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(fetchFreshTickerQuoteMock).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("does not delay a stale quote behind already-fresh symbols", async () => {
    vi.useFakeTimers();
    process.env.QUOTE_REFRESH_SPACING_MS = "3000";
    getFreshQuoteMemorySnapshotMock.mockImplementation((symbol: string) =>
      symbol === "AAPL" ? null : { quote: { ticker: symbol, price: 100 }, isFresh: true }
    );
    getCachedQuoteSnapshotMock.mockResolvedValue({ quote: null, isFresh: false });
    fetchFreshTickerQuoteMock.mockResolvedValue(null);

    const mod = await import("./quote-refresh-queue.service.js");
    mod.__resetQuoteRefreshQueueForTests();
    try {
      mod.enqueueQuoteRefresh(["MSFT", "GOOGL", "AAPL"]);
      await vi.advanceTimersByTimeAsync(0);

      expect(fetchFreshTickerQuoteMock).toHaveBeenCalledWith("AAPL");
      expect(mod.getQuoteRefreshQueueStats().queuedSymbols).toBe(0);
    } finally {
      mod.__resetQuoteRefreshQueueForTests();
      vi.useRealTimers();
    }
  });

  it("promotes visible symbols without duplicates and gives background work a turn after three visible jobs", async () => {
    vi.useFakeTimers();
    process.env.QUOTE_REFRESH_SPACING_MS = "1000";
    process.env.QUOTE_REFRESH_CONCURRENCY = "1";
    getCachedQuoteSnapshotMock.mockResolvedValue({ quote: null, isFresh: false });
    fetchFreshTickerQuoteMock.mockResolvedValue(null);
    const mod = await import("./quote-refresh-queue.service.js");
    mod.__resetQuoteRefreshQueueForTests();
    try {
      mod.enqueueQuoteRefresh(["SEED", "OLD1", "OLD2", "PROMOTE"]);
      mod.enqueueQuoteRefresh(["PROMOTE", "V1", "V2", "V3", "V4"], { priority: "visible" });
      mod.enqueueQuoteRefresh("PROMOTE"); // A scheduler sync must not demote it.
      await vi.advanceTimersByTimeAsync(0);
      expect(mod.getQuoteRefreshQueueStats()).toMatchObject({
        queuedSymbols: 7,
        visibleQueuedSymbols: 5,
        backgroundQueuedSymbols: 2,
      });
      await vi.advanceTimersByTimeAsync(4000);
      expect(fetchFreshTickerQuoteMock.mock.calls.map(([symbol]) => symbol)).toEqual([
        "SEED", "PROMOTE", "V1", "V2", "OLD1",
      ]);
      await vi.advanceTimersByTimeAsync(3000);
      expect(fetchFreshTickerQuoteMock.mock.calls.map(([symbol]) => symbol)).toEqual([
        "SEED", "PROMOTE", "V1", "V2", "OLD1", "V3", "V4", "OLD2",
      ]);
    } finally {
      mod.__resetQuoteRefreshQueueForTests();
      vi.useRealTimers();
    }
  });

  it("backs off repeated failures for one, two, then five minutes, even for visible requests", async () => {
    getCachedQuoteSnapshotMock.mockResolvedValue({ quote: null, isFresh: false });
    fetchFreshTickerQuoteMock.mockResolvedValue(null);
    const mod = await import("./quote-refresh-queue.service.js");
    mod.__resetQuoteRefreshQueueForTests();
    mod.enqueueQuoteRefresh("BAD");
    await mod.__waitForQuoteRefreshQueueToIdle();
    let attempts = 1;
    for (const cooldownMs of [60_000, 120_000, 300_000, 300_000]) {
      vi.setSystemTime(Date.now() + cooldownMs - 1);
      mod.enqueueQuoteRefresh("BAD", { priority: "visible" });
      await mod.__waitForQuoteRefreshQueueToIdle();
      expect(fetchFreshTickerQuoteMock).toHaveBeenCalledTimes(attempts);
      vi.setSystemTime(Date.now() + 1);
      mod.enqueueQuoteRefresh("BAD", { priority: "visible" });
      await mod.__waitForQuoteRefreshQueueToIdle();
      expect(fetchFreshTickerQuoteMock).toHaveBeenCalledTimes(++attempts);
    }
  });

  it("resets the progressive cooldown after successfully persisting a quote", async () => {
    getCachedQuoteSnapshotMock.mockResolvedValue({ quote: null, isFresh: false });
    fetchFreshTickerQuoteMock.mockResolvedValue(null);
    const mod = await import("./quote-refresh-queue.service.js");
    mod.__resetQuoteRefreshQueueForTests();
    for (const elapsed of [0, 60_000]) {
      vi.setSystemTime(Date.now() + elapsed);
      mod.enqueueQuoteRefresh("AAPL");
      await mod.__waitForQuoteRefreshQueueToIdle();
    }
    vi.setSystemTime(Date.now() + 120_000);
    fetchFreshTickerQuoteMock.mockResolvedValueOnce({ ticker: "AAPL", price: 100 });
    mod.enqueueQuoteRefresh("AAPL");
    await mod.__waitForQuoteRefreshQueueToIdle();
    expect(upsertCachedQuoteMock).toHaveBeenCalledTimes(1);
    mod.enqueueQuoteRefresh("AAPL");
    await mod.__waitForQuoteRefreshQueueToIdle(); // New failure starts at one minute.
    vi.setSystemTime(Date.now() + 59_999);
    mod.enqueueQuoteRefresh("AAPL");
    await mod.__waitForQuoteRefreshQueueToIdle();
    expect(fetchFreshTickerQuoteMock).toHaveBeenCalledTimes(4);
    vi.setSystemTime(Date.now() + 1);
    mod.enqueueQuoteRefresh("AAPL");
    await mod.__waitForQuoteRefreshQueueToIdle();
    expect(fetchFreshTickerQuoteMock).toHaveBeenCalledTimes(5);
  });

  it("continues draining when persisting a refresh failure also fails", async () => {
    process.env.QUOTE_REFRESH_CONCURRENCY = "1";
    getCachedQuoteSnapshotMock.mockResolvedValue({ quote: null, isFresh: false });
    fetchFreshTickerQuoteMock.mockResolvedValue(null);
    recordQuoteRefreshFailureMock.mockRejectedValue(new Error("DB unavailable"));
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const mod = await import("./quote-refresh-queue.service.js");
    mod.__resetQuoteRefreshQueueForTests();
    try {
      mod.enqueueQuoteRefresh(["AAPL", "MSFT"]);
      await mod.__waitForQuoteRefreshQueueToIdle();
      expect(fetchFreshTickerQuoteMock).toHaveBeenCalledTimes(2);
      expect(stderr).toHaveBeenCalledTimes(2);
      vi.setSystemTime(Date.now() + 60_000);
      mod.enqueueQuoteRefresh("AAPL");
      await mod.__waitForQuoteRefreshQueueToIdle();
      expect(fetchFreshTickerQuoteMock).toHaveBeenCalledTimes(3);
    } finally {
      stderr.mockRestore();
    }
  });
});
