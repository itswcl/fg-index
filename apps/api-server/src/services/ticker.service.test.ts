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
  process.env.CORS_ORIGIN = "*";
  process.env.INTERNAL_API_KEY = "test-key";
  process.env.DATABASE_URL = "https://example.com/db";
  process.env.DIRECT_URL = "https://example.com/direct";
  process.env.SUPABASE_URL = "https://example.com/supabase";
  process.env.SUPABASE_JWKS_URL = "https://example.com/jwks";
}

describe("ticker service — BTC-USD / crypto path", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    applyEnv();
  });

  it("prefers Yahoo chart JSON for BTC-USD over Google HTML", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);

      if (url.includes("query1.finance.yahoo.com")) {
        return new Response(
          JSON.stringify({
            chart: {
              result: [
                {
                  meta: {
                    symbol: "BTC-USD",
                    longName: "Bitcoin USD",
                    regularMarketPrice: 79033.46,
                    chartPreviousClose: 78000,
                  },
                },
              ],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      throw new Error(`unexpected fetch: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    const mod = await import("./ticker.service.js");
    mod._resetTickerServiceState();
    const quote = await mod.fetchTickerQuote("BTC-USD");

    expect(quote).toMatchObject({
      ticker: "BTC-USD",
      name: "Bitcoin USD",
      price: 79033.46,
      previousClose: 78000,
    });
    expect(quote?.sourceUrl).toContain("query1.finance.yahoo.com/v8/finance/chart/BTC-USD");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toContain("query1.finance.yahoo.com");
  });

  it("falls back to CoinGecko (not Google) when the Yahoo chart request fails", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);

      if (url.includes("query1.finance.yahoo.com")) {
        return new Response("upstream unavailable", { status: 503 });
      }

      if (url.includes("api.coingecko.com")) {
        return new Response(
          JSON.stringify({
            bitcoin: { usd: 77951, usd_24h_change: -0.65 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      throw new Error(`unexpected fetch: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    const mod = await import("./ticker.service.js");
    mod._resetTickerServiceState();
    const quote = await mod.fetchTickerQuote("BTC-USD");

    expect(quote).toMatchObject({
      ticker: "BTC-USD",
      name: "Bitcoin USD",
      price: 77951,
    });
    expect(quote?.changePercent).toBeCloseTo(-0.65, 2);
    expect(quote?.sourceUrl).toContain("api.coingecko.com");
    // Yahoo (503) + CoinGecko — Google must NOT be called for crypto.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("google.com/finance"))).toBe(false);
  });

  it("trips a Yahoo cooldown on 429 and routes the next crypto request straight to CoinGecko", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);

      if (url.includes("query1.finance.yahoo.com")) {
        return new Response("too many requests", { status: 429 });
      }

      if (url.includes("api.coingecko.com")) {
        const id = url.includes("bitcoin") ? "bitcoin" : "ethereum";
        const body =
          id === "bitcoin"
            ? { bitcoin: { usd: 77900, usd_24h_change: 1.2 } }
            : { ethereum: { usd: 3450, usd_24h_change: 2.1 } };
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      throw new Error(`unexpected fetch: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    const mod = await import("./ticker.service.js");
    mod._resetTickerServiceState();

    // First crypto request: Yahoo 429s (trips cooldown), CoinGecko serves BTC.
    const btc = await mod.fetchTickerQuote("BTC-USD");
    expect(btc?.ticker).toBe("BTC-USD");
    expect(btc?.price).toBe(77900);

    // Second crypto request (different symbol → no cache hit): should NOT
    // call Yahoo again because cooldown is active. CoinGecko only.
    const eth = await mod.fetchTickerQuote("ETH-USD");
    expect(eth?.ticker).toBe("ETH-USD");
    expect(eth?.price).toBe(3450);

    const yahooCalls = fetchMock.mock.calls.filter(([u]) =>
      String(u).includes("query1.finance.yahoo.com")
    ).length;
    const coinGeckoCalls = fetchMock.mock.calls.filter(([u]) =>
      String(u).includes("api.coingecko.com")
    ).length;

    expect(yahooCalls).toBe(1); // only BTC's first attempt — ETH skipped Yahoo
    expect(coinGeckoCalls).toBe(2);
    // Google must never be called in the crypto path.
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("google.com/finance"))).toBe(false);
  });

  it("returns null instead of falling through to Google when both Yahoo and CoinGecko fail", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("query1.finance.yahoo.com")) {
        return new Response("bad gateway", { status: 502 });
      }
      if (url.includes("api.coingecko.com")) {
        return new Response("service unavailable", { status: 503 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    const mod = await import("./ticker.service.js");
    mod._resetTickerServiceState();
    const quote = await mod.fetchTickerQuote("BTC-USD");

    expect(quote).toBeNull();
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("google.com/finance"))).toBe(false);
  });
});
