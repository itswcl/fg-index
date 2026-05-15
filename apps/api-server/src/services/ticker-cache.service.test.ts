import { beforeEach, describe, expect, it, vi } from "vitest";

const { findUniqueMock, findManyMock, upsertMock } = vi.hoisted(() => ({
  findUniqueMock: vi.fn(),
  findManyMock: vi.fn(),
  upsertMock: vi.fn(),
}));

vi.mock("./db.js", () => ({
  prisma: {
    tickerQuoteCache: {
      findUnique: findUniqueMock,
      findMany: findManyMock,
      upsert: upsertMock,
    },
    userTicker: {
      findMany: findManyMock,
    },
  },
}));

vi.mock("./ticker.service.js", () => ({
  getTickerCacheTtlMs: vi.fn(() => 15_000),
}));

vi.mock("./market-status.service.js", () => ({
  applyGlobalMarketSessionToQuote: vi.fn((quote) => quote),
}));

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
  process.env.QUOTE_PRICE_SANITY_MAX_MOVE_PERCENT = "100";
  process.env.CORS_ORIGIN = "*";
  process.env.INTERNAL_API_KEY = "test-key";
  process.env.DATABASE_URL = "https://example.com/db";
  process.env.DIRECT_URL = "https://example.com/direct";
  process.env.SUPABASE_URL = "https://example.com/supabase";
  process.env.SUPABASE_JWKS_URL = "https://example.com/jwks";
}

function quote(price: number) {
  return {
    ticker: "AMD",
    name: "Advanced Micro Devices Inc",
    price,
    previousClose: price,
    change: 0,
    changePercent: 0,
    fetchedAt: "2026-05-01T16:30:00.000Z",
  };
}

describe("ticker cache price sanity guard", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    applyEnv();
    findUniqueMock.mockReset();
    findManyMock.mockReset();
    upsertMock.mockReset();
    upsertMock.mockResolvedValue({});
  });

  it("allows first cached quote for a symbol", async () => {
    findUniqueMock.mockResolvedValue(null);

    const { upsertCachedQuote } = await import("./ticker-cache.service.js");
    await upsertCachedQuote("AMD", quote(100));

    expect(upsertMock).toHaveBeenCalledTimes(1);
  });

  it("allows normal price movement versus the previous cached price", async () => {
    findUniqueMock.mockResolvedValue({ price: 100 });

    const { upsertCachedQuote } = await import("./ticker-cache.service.js");
    await upsertCachedQuote("AMD", quote(150));

    expect(upsertMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a 100 percent price jump and preserves the previous cached quote", async () => {
    findUniqueMock.mockResolvedValue({ price: 100 });

    const { upsertCachedQuote, SuspiciousQuotePriceMoveError } = await import(
      "./ticker-cache.service.js"
    );

    await expect(upsertCachedQuote("AMD", quote(200))).rejects.toBeInstanceOf(
      SuspiciousQuotePriceMoveError
    );
    expect(upsertMock).not.toHaveBeenCalled();
  });

  it("uses caller-provided previous price instead of issuing another cache read", async () => {
    const { upsertCachedQuote } = await import("./ticker-cache.service.js");
    await upsertCachedQuote("AMD", quote(120), { previousPrice: 100 });

    expect(findUniqueMock).not.toHaveBeenCalled();
    expect(upsertMock).toHaveBeenCalledTimes(1);
  });
});

describe("ticker cache memory layer", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    applyEnv();
    findUniqueMock.mockReset();
    findManyMock.mockReset();
    upsertMock.mockReset();
    upsertMock.mockResolvedValue({});
  });

  function dbRow(symbol = "AMD", price = 100) {
    return {
      symbol,
      name: "Advanced Micro Devices Inc",
      price,
      previousClose: price,
      change: 0,
      changePercent: 0,
      fetchedAt: new Date(),
      sourceUrl: "https://example.com/quote",
      marketSession: "regular",
      postMarketPrice: null,
      postMarketChange: null,
      postMarketChangePercent: null,
      preMarketPrice: null,
      preMarketChange: null,
      preMarketChangePercent: null,
      staleAt: new Date(Date.now() + 15_000),
    };
  }

  it("serves repeated single quote reads from memory after the first DB read", async () => {
    findUniqueMock.mockResolvedValue(dbRow());

    const {
      getCachedQuoteSnapshot,
      __resetTickerCacheMemoryForTests,
      getTickerCacheStats,
    } = await import("./ticker-cache.service.js");
    __resetTickerCacheMemoryForTests();

    await getCachedQuoteSnapshot("AMD");
    const second = await getCachedQuoteSnapshot("AMD");

    expect(second.quote).toMatchObject({ ticker: "AMD", price: 100 });
    expect(findUniqueMock).toHaveBeenCalledTimes(1);
    expect(getTickerCacheStats()).toMatchObject({
      quoteMemoryHits: 1,
      quoteDbReads: 1,
    });
  });

  it("caches batch misses so repeated null reads avoid DB", async () => {
    findManyMock.mockResolvedValue([]);

    const {
      getCachedQuotesBatch,
      __resetTickerCacheMemoryForTests,
    } = await import("./ticker-cache.service.js");
    __resetTickerCacheMemoryForTests();

    await getCachedQuotesBatch(["TQQQ"]);
    const second = await getCachedQuotesBatch(["TQQQ"]);

    expect(second).toEqual({ TQQQ: null });
    expect(findManyMock).toHaveBeenCalledTimes(1);
  });

  it("caches active symbols for repeated scheduler syncs and supports invalidation", async () => {
    findManyMock
      .mockResolvedValueOnce([{ symbol: "aapl" }, { symbol: "AAPL" }])
      .mockResolvedValueOnce([{ symbol: "MSFT" }]);

    const {
      listActiveTrackedSymbols,
      invalidateActiveTrackedSymbolsCache,
      __resetTickerCacheMemoryForTests,
      getTickerCacheStats,
    } = await import("./ticker-cache.service.js");
    __resetTickerCacheMemoryForTests();

    await expect(listActiveTrackedSymbols()).resolves.toEqual(["AAPL"]);
    await expect(listActiveTrackedSymbols()).resolves.toEqual(["AAPL"]);
    invalidateActiveTrackedSymbolsCache();
    await expect(listActiveTrackedSymbols()).resolves.toEqual(["MSFT"]);

    expect(findManyMock).toHaveBeenCalledTimes(2);
    expect(getTickerCacheStats()).toMatchObject({
      activeSymbolCacheHits: 1,
      activeSymbolDbSyncs: 2,
      activeSymbolInvalidations: 1,
    });
  });
});
