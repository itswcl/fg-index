import { beforeEach, describe, expect, it, vi } from "vitest";

const { updateManyMock } = vi.hoisted(() => ({
  updateManyMock: vi.fn(),
}));

vi.mock("./db.js", () => ({
  prisma: {
    tickerQuoteCache: {
      updateMany: updateManyMock,
    },
  },
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
  process.env.MASSIVE_API_KEY = "massive-key";
  process.env.MASSIVE_MARKET_STATUS_URL = "https://api.massive.com/v1/marketstatus/now";
  process.env.CORS_ORIGIN = "*";
  process.env.INTERNAL_API_KEY = "test-key";
  process.env.DATABASE_URL = "https://example.com/db";
  process.env.DIRECT_URL = "https://example.com/direct";
  process.env.SUPABASE_URL = "https://example.com/supabase";
  process.env.SUPABASE_JWKS_URL = "https://example.com/jwks";
}

describe("market status service", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    updateManyMock.mockReset();
    updateManyMock.mockResolvedValue({ count: 3 });
    applyEnv();
  });

  it("maps Massive market status flags to app market sessions", async () => {
    const mod = await import("./market-status.service.js");

    expect(mod.__normalizeMassiveSessionForTests({ earlyHours: true })).toBe("pre");
    expect(mod.__normalizeMassiveSessionForTests({ afterHours: true })).toBe("post");
    expect(mod.__normalizeMassiveSessionForTests({ market: "open" })).toBe("regular");
    expect(mod.__normalizeMassiveSessionForTests({ exchanges: { nasdaq: "open" } })).toBe("regular");
    expect(mod.__normalizeMassiveSessionForTests({ market: "closed" })).toBe("closed");
  });

  it("fetches Massive status, caches the session, and updates all non-crypto cached quotes", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          market: "open",
          earlyHours: false,
          afterHours: false,
          serverTime: "2026-05-01T16:30:00Z",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    const mod = await import("./market-status.service.js");
    const session = await mod.refreshMarketStatus();

    expect(session).toBe("regular");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.toString()).toBe(
      "https://api.massive.com/v1/marketstatus/now?apiKey=massive-key"
    );
    expect(updateManyMock).toHaveBeenCalledWith({
      where: { symbol: { notIn: ["BTC", "BTC-USD"] } },
      data: expect.objectContaining({
        marketSession: "regular",
        postMarketPrice: null,
        preMarketPrice: null,
      }),
    });
    expect(mod.getMarketStatusStats()).toMatchObject({
      session: "regular",
      serverTime: "2026-05-01T16:30:00Z",
      lastError: null,
      configured: true,
    });
  });

  it("clears stale extended fields from quotes while regular session is active", async () => {
    const mod = await import("./market-status.service.js");
    mod.__setMarketSessionForTests("regular");

    const quote = mod.applyGlobalMarketSessionToQuote({
      ticker: "AMD",
      price: 356.8,
      previousClose: 354.49,
      change: 2.31,
      changePercent: 0.6516,
      fetchedAt: "2026-05-01T16:30:00.000Z",
      marketSession: "post",
      postMarketPrice: 353.35,
      postMarketChange: -3.61,
      postMarketChangePercent: -0.9891,
    });

    expect(quote).toMatchObject({ ticker: "AMD", marketSession: "regular" });
    expect(quote.postMarketPrice).toBeUndefined();
    expect(quote.postMarketChange).toBeUndefined();
    expect(quote.postMarketChangePercent).toBeUndefined();
  });

  it("preserves post-market quote data while global market status is closed", async () => {
    const mod = await import("./market-status.service.js");
    mod.__setMarketSessionForTests("closed");

    const quote = mod.applyGlobalMarketSessionToQuote({
      ticker: "AMD",
      price: 356.8,
      previousClose: 354.49,
      change: 2.31,
      changePercent: 0.6516,
      fetchedAt: "2026-05-01T20:30:00.000Z",
      marketSession: "closed",
      postMarketPrice: 353.35,
      postMarketChange: -3.61,
      postMarketChangePercent: -0.9891,
    });

    expect(quote).toMatchObject({
      ticker: "AMD",
      marketSession: "post",
      postMarketPrice: 353.35,
      postMarketChange: -3.61,
      postMarketChangePercent: -0.9891,
    });
  });

  it("marks quotes closed when global market status is closed and no post-market data exists", async () => {
    const mod = await import("./market-status.service.js");
    mod.__setMarketSessionForTests("closed");

    const quote = mod.applyGlobalMarketSessionToQuote({
      ticker: "AMD",
      price: 356.8,
      previousClose: 354.49,
      change: 2.31,
      changePercent: 0.6516,
      fetchedAt: "2026-05-01T20:30:00.000Z",
      marketSession: "regular",
    });

    expect(quote).toMatchObject({ ticker: "AMD", marketSession: "closed" });
  });

  it("does not wipe post-market cache fields when persisting closed status", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          market: "closed",
          earlyHours: false,
          afterHours: false,
          serverTime: "2026-05-01T22:00:00Z",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    const mod = await import("./market-status.service.js");
    const session = await mod.refreshMarketStatus();

    expect(session).toBe("closed");
    expect(updateManyMock).toHaveBeenCalledWith({
      where: { symbol: { notIn: ["BTC", "BTC-USD"] } },
      data: {
        marketSession: "closed",
        preMarketPrice: null,
        preMarketChange: null,
        preMarketChangePercent: null,
      },
    });
  });

  it("does not override BTC session because crypto trades continuously", async () => {
    const mod = await import("./market-status.service.js");
    mod.__setMarketSessionForTests("closed");

    const quote = mod.applyGlobalMarketSessionToQuote({
      ticker: "BTC-USD",
      price: 90000,
      previousClose: 89000,
      change: 1000,
      changePercent: 1.1236,
      fetchedAt: "2026-05-01T16:30:00.000Z",
      marketSession: "regular",
    });

    expect(quote.marketSession).toBe("regular");
  });
});
