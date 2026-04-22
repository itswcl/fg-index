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
  process.env.BTC_INTERVAL_MS = "30000";
  process.env.SPX_INTERVAL_MS = "10000";
  process.env.CORS_ORIGIN = "*";
  process.env.INTERNAL_API_KEY = "test-key";
  process.env.DATABASE_URL = "https://example.com/db";
  process.env.DIRECT_URL = "https://example.com/direct";
  process.env.SUPABASE_URL = "https://example.com/supabase";
  process.env.SUPABASE_JWKS_URL = "https://example.com/jwks";
}

describe("ticker service", () => {
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

    const { fetchTickerQuote } = await import("./ticker.service.js");
    const quote = await fetchTickerQuote("BTC-USD");

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

  it("falls back to Google Finance when the Yahoo chart request fails", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);

      if (url.includes("query1.finance.yahoo.com")) {
        return new Response("upstream unavailable", { status: 503 });
      }

      if (url.includes("google.com/finance/quote/BTC-USD")) {
        return new Response(
          '<html><div class="zzDege">Bitcoin USD</div><div data-last-price="74039.75"></div><div class="P6K39c">$74182.03</div></html>',
          { status: 200, headers: { "Content-Type": "text/html" } }
        );
      }

      throw new Error(`unexpected fetch: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    const { fetchTickerQuote } = await import("./ticker.service.js");
    const quote = await fetchTickerQuote("BTC-USD");

    expect(quote).toMatchObject({
      ticker: "BTC-USD",
      name: "Bitcoin USD",
      price: 74039.75,
      previousClose: 74182.03,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toContain("query1.finance.yahoo.com");
    expect(fetchMock.mock.calls[1]?.[0]).toContain("google.com/finance/quote/BTC-USD");
  });
});
