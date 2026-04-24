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

  it("never returns a NaN `change` for a non-crypto Google-scraped ticker (garbage prev-close)", async () => {
    // Regression guard: previously, scrapeGoogleFinance on e.g. AAPL would
    // recover `previousClose` to `price` when its regex captured garbage,
    // but `change` had already been computed from NaN — so the response
    // shipped { price: ok, previousClose: ok, change: NaN, changePercent: 0 }
    // and the frontend sanitizer dropped the whole quote. After the fix:
    // either all four numeric fields are finite, or the quote is null.
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("google.com/finance/quote/AAPL")) {
        // "." matches the `[0-9.,]+` capture but parseFloat(".") is NaN.
        // Before the fix this returned a NaN `change` alongside a valid price.
        return new Response(
          '<html><div class="zzDege">Apple</div>' +
            '<div data-last-price="180.50"></div>' +
            '<div class="P6K39c">$.</div></html>',
          { status: 200, headers: { "Content-Type": "text/html" } }
        );
      }
      // Any other upstream (suffix retries, yahoo fallback) returns nothing.
      return new Response("", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const mod = await import("./ticker.service.js");
    mod._resetTickerServiceState();
    const quote = await mod.fetchTickerQuote("AAPL");

    // Quote either resolves with all-finite numeric fields OR is null — but
    // must NEVER carry a NaN change / changePercent to the wire.
    if (quote !== null) {
      expect(Number.isFinite(quote.price)).toBe(true);
      expect(Number.isFinite(quote.previousClose)).toBe(true);
      expect(Number.isFinite(quote.change)).toBe(true);
      expect(Number.isFinite(quote.changePercent)).toBe(true);
    }
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

describe("ticker service — stale-on-error fallback", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    vi.useRealTimers();
    applyEnv();
  });

  it("serves the last-known quote when a later fetch returns null (TSLA-style flake)", async () => {
    // Scenario: Google serves TSLA fine on call 1, then ~16 s later serves an
    // HTML page without `data-last-price` (observed in the wild). Before
    // this change the batch endpoint shipped { TSLA: null } and the card
    // rendered "Not Found". After this change we serve the last validated
    // quote so the user never sees that flash.
    let call = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("google.com/finance/quote/TSLA")) {
        call += 1;
        if (call === 1) {
          return new Response(
            '<html><div class="zzDege">Tesla, Inc.</div>' +
              '<div data-last-price="376.30"></div>' +
              '<div class="P6K39c">$370.00</div></html>',
            { status: 200, headers: { "Content-Type": "text/html" } }
          );
        }
        // Second call: Google returned HTML but no price element.
        return new Response(
          '<html><div class="zzDege">Tesla, Inc.</div></html>',
          { status: 200, headers: { "Content-Type": "text/html" } }
        );
      }
      // Block suffix retries and Yahoo fallbacks so the second fetch path
      // really does resolve to null.
      return new Response("", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const mod = await import("./ticker.service.js");
    mod._resetTickerServiceState();

    // Fake timers so we can age the 15 s short cache without flaking the
    // 24 h last-known ceiling.
    vi.useFakeTimers({ now: new Date("2026-04-24T12:00:00Z") });

    // 1st call: Google serves the quote, seeds both caches.
    const fresh = await mod.fetchTickerQuote("TSLA");
    expect(fresh?.price).toBe(376.3);

    // Age past short cache TTL (15 s) but nowhere near 24 h.
    vi.setSystemTime(new Date("2026-04-24T12:00:20Z"));

    // 2nd call: Google returns HTML without data-last-price → resolveAndFetch
    // returns null → we fall back to last-known instead of null.
    const stale = await mod.fetchTickerQuote("TSLA");
    expect(stale).not.toBeNull();
    expect(stale?.ticker).toBe("TSLA");
    expect(stale?.price).toBe(376.3);
    expect(stale?.fetchedAt).toBe(fresh?.fetchedAt); // same timestamp — it IS the prior quote

    vi.useRealTimers();
  });

  it("returns null when we've never seen the symbol (ESW00-style bad input)", async () => {
    // No cached fallback exists for a never-seen symbol. Every upstream
    // returns nothing → null propagates, since fabricating data would be
    // worse than admitting coverage loss.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 404 }))
    );

    const mod = await import("./ticker.service.js");
    mod._resetTickerServiceState();

    const quote = await mod.fetchTickerQuote("ESW00");
    expect(quote).toBeNull();
  });

  it("does not serve last-known that has aged past the 24h ceiling", async () => {
    let call = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("google.com/finance/quote/AAPL")) {
        call += 1;
        if (call === 1) {
          return new Response(
            '<html><div class="zzDege">Apple Inc.</div>' +
              '<div data-last-price="180.50"></div>' +
              '<div class="P6K39c">$179.00</div></html>',
            { status: 200, headers: { "Content-Type": "text/html" } }
          );
        }
        return new Response("<html></html>", { status: 200 });
      }
      return new Response("", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const mod = await import("./ticker.service.js");
    mod._resetTickerServiceState();

    vi.useFakeTimers({ now: new Date("2026-04-24T12:00:00Z") });

    const fresh = await mod.fetchTickerQuote("AAPL");
    expect(fresh?.price).toBe(180.5);

    // Jump 25 hours forward — past LAST_KNOWN_MAX_AGE_MS.
    vi.setSystemTime(new Date("2026-04-25T13:00:00Z"));

    const quote = await mod.fetchTickerQuote("AAPL");
    expect(quote).toBeNull();

    vi.useRealTimers();
  });
});
