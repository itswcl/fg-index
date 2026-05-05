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
  recordQuoteRefreshFailure: vi.fn(),
  upsertCachedQuote: vi.fn(),
}));

vi.mock("./ticker.service.js", () => ({
  fetchFreshTickerQuote: vi.fn(),
}));

import {
  getCachedQuoteSnapshot,
  recordQuoteRefreshFailure,
  upsertCachedQuote,
} from "./ticker-cache.service.js";
import { fetchFreshTickerQuote } from "./ticker.service.js";

const getCachedQuoteSnapshotMock =
  getCachedQuoteSnapshot as unknown as ReturnType<typeof vi.fn>;
const recordQuoteRefreshFailureMock =
  recordQuoteRefreshFailure as unknown as ReturnType<typeof vi.fn>;
const upsertCachedQuoteMock =
  upsertCachedQuote as unknown as ReturnType<typeof vi.fn>;
const fetchFreshTickerQuoteMock =
  fetchFreshTickerQuote as unknown as ReturnType<typeof vi.fn>;

describe("quote refresh queue service", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    applyEnv();
    getCachedQuoteSnapshotMock.mockReset();
    recordQuoteRefreshFailureMock.mockReset();
    upsertCachedQuoteMock.mockReset();
    fetchFreshTickerQuoteMock.mockReset();
  });

  it("skips upstream work when the cache is already fresh", async () => {
    getCachedQuoteSnapshotMock.mockResolvedValue({
      quote: { ticker: "AAPL", price: 100 },
      isFresh: true,
    });

    const mod = await import("./quote-refresh-queue.service.js");
    mod.__resetQuoteRefreshQueueForTests();

    mod.enqueueQuoteRefresh("AAPL");
    await mod.__waitForQuoteRefreshQueueToIdle();

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
});
