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
    expect(quote?.sourceUrl).toContain("range=1d");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toContain("query1.finance.yahoo.com");
    expect(fetchMock.mock.calls[0]?.[0]).toContain("range=1d");
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

  it("trips a Yahoo cooldown on 429 and routes subsequent BTC requests straight to CoinGecko", async () => {
    vi.useFakeTimers({ now: new Date("2026-04-24T12:00:00Z") });

    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);

      if (url.includes("query1.finance.yahoo.com")) {
        return new Response("too many requests", { status: 429 });
      }

      if (url.includes("api.coingecko.com")) {
        return new Response(
          JSON.stringify({ bitcoin: { usd: 77900, usd_24h_change: 1.2 } }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      throw new Error(`unexpected fetch: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    const mod = await import("./ticker.service.js");
    mod._resetTickerServiceState();

    // First crypto request: Yahoo 429s (trips cooldown), CoinGecko serves BTC.
    const first = await mod.fetchTickerQuote("BTC-USD");
    expect(first?.ticker).toBe("BTC-USD");
    expect(first?.price).toBe(77900);

    // Advance past the 60s crypto cache so the second call re-fetches.
    // With the cooldown active, it should go straight to CoinGecko — Yahoo
    // is still within the 5-minute cooldown window and must be skipped.
    await vi.advanceTimersByTimeAsync(61_000);

    const second = await mod.fetchTickerQuote("BTC-USD");
    expect(second?.ticker).toBe("BTC-USD");
    expect(second?.price).toBe(77900);

    const yahooCalls = fetchMock.mock.calls.filter(([u]) =>
      String(u).includes("query1.finance.yahoo.com")
    ).length;
    const coinGeckoCalls = fetchMock.mock.calls.filter(([u]) =>
      String(u).includes("api.coingecko.com")
    ).length;

    expect(yahooCalls).toBe(1); // only the first attempt — cooldown skipped the second
    expect(coinGeckoCalls).toBe(2);
    // Google must never be called in the crypto path.
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("google.com/finance"))).toBe(false);

    vi.useRealTimers();
  });

  it("never resolves a stock like AMD to the -USD crypto URL, even if :NASDAQ flakes", async () => {
    // Regression: before the fix, EXCHANGE_SUFFIXES included "-USD" as the
    // last fallback. Google Finance happens to serve a crypto-token page at
    // `/finance/quote/AMD-USD`, so a transient miss on AMD:NASDAQ would
    // cascade down to AMD-USD, cache that as AMD's resolved format, and
    // every future AMD lookup would hit the crypto URL for a stock.
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (!url.includes("google.com/finance/quote/")) {
        throw new Error(`unexpected fetch: ${url}`);
      }
      if (url.includes("AMD%3ANASDAQ") || url.endsWith("/AMD")) {
        // Simulate the transient SSR flake: page served without data-last-price.
        return new Response("<html><body>offline</body></html>", {
          status: 200,
          headers: { "Content-Type": "text/html" },
        });
      }
      // If the code were to hit /AMD-USD (old bug), this branch would fire.
      // We want this test to fail loudly if the regression is ever reintroduced.
      if (url.includes("AMD-USD")) {
        return new Response(
          '<html><div data-last-price="0.0012"></div></html>',
          { status: 200, headers: { "Content-Type": "text/html" } }
        );
      }
      return new Response("<html><body>miss</body></html>", {
        status: 404,
        headers: { "Content-Type": "text/html" },
      });
    });

    vi.stubGlobal("fetch", fetchMock);

    const mod = await import("./ticker.service.js");
    mod._resetTickerServiceState();

    const quote = await mod.fetchTickerQuote("AMD");
    expect(quote).toBeNull();

    // Hard assertion: the crypto URL must never have been requested.
    const urls = fetchMock.mock.calls.map(([u]) => String(u));
    expect(urls.some((u) => u.includes("AMD-USD"))).toBe(false);
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

function fakeGoogleAfQuotePage(args: {
  ticker: string;
  exchange: string;
  name: string;
  price: number;
  change: number;
  changePercent: number;
  previousClose?: number;
  ext?: string;
  afExt?: {
    price: number;
    change: number;
    changePercent: number;
    session?: { year: number; month: number; day: number };
  };
}): string {
  const previousClose =
    args.previousClose === undefined ? "" : `,null,${args.previousClose}`;
  const session = args.afExt?.session ?? { year: 2026, month: 4, day: 30 };
  const afExtBlock = args.afExt
    ? `,"#666666","US","/m/0k8z",[1777585274],"America/New_York",-14400,"/m/test",` +
      `null,[${args.afExt.price},${args.afExt.change},${args.afExt.changePercent},2,2,2],` +
      `[1777579201],[1777585273],[[1,[${session.year},${session.month},${session.day},9,30,null,null,[-14400]],[${session.year},${session.month},${session.day},16,null,null,null,[-14400]]]],` +
      `null,"${args.ticker}:${args.exchange}",0,null,null,null,0`
    : "";
  return (
    `<html><body>` +
    `AF_initDataCallback({key: 'ds:2', data:[[[[` +
    `"/m/test",["${args.ticker}","${args.exchange}"],"${args.name}",0,"USD",` +
    `[${args.price},${args.change},${args.changePercent},2,2,2]${previousClose}` +
    `${afExtBlock}]]]], sideChannel: {}});` +
    (args.ext ?? "") +
    `</body></html>`
  );
}

describe("ticker service — Google Finance AF_initDataCallback parser", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    applyEnv();
  });

  it("parses AF quote data when Google no longer serves data-last-price", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("query1.finance.yahoo.com")) {
        return new Response("too many requests", { status: 429 });
      }
      if (url.includes("google.com/finance/quote/AAPL")) {
        return new Response(
          fakeGoogleAfQuotePage({
            ticker: "AAPL",
            exchange: "NASDAQ",
            name: "Apple Inc",
            price: 274.39,
            change: 4.220001,
            changePercent: 1.5619799,
            previousClose: 270.17,
          }),
          { status: 200, headers: { "Content-Type": "text/html" } }
        );
      }
      return new Response("", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const mod = await import("./ticker.service.js");
    mod._resetTickerServiceState();
    const quote = await mod.fetchTickerQuote("AAPL");

    expect(quote).toMatchObject({
      ticker: "AAPL",
      name: "Apple Inc",
      price: 274.39,
      previousClose: 270.17,
      change: 4.22,
    });
    expect(Number.isFinite(quote?.changePercent)).toBe(true);
    expect(quote?.sourceUrl).toContain("google.com/finance/quote/AAPL");
    expect(quote?.sourceUrl).toContain("hl=en");
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("?hl=en"))).toBe(true);
  });

  it("extracts postMarketPrice from AF extended-hours data", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("query1.finance.yahoo.com")) {
        return new Response("too many requests", { status: 429 });
      }
      if (url.includes("google.com/finance/quote/AAPL")) {
        return new Response(
          fakeGoogleAfQuotePage({
            ticker: "AAPL",
            exchange: "NASDAQ",
            name: "Apple Inc",
            price: 271.35,
            change: 1.18,
            changePercent: 0.4368,
            previousClose: 270.17,
            afExt: { price: 283, change: 11.65, changePercent: 4.2933 },
          }),
          { status: 200, headers: { "Content-Type": "text/html" } }
        );
      }
      return new Response("", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const mod = await import("./ticker.service.js");
    mod._resetTickerServiceState();
    const quote = await mod.fetchTickerQuote("AAPL");

    expect(quote?.price).toBe(271.35);
    expect(quote?.marketSession).toBe("post");
    expect(quote?.postMarketPrice).toBe(283);
    expect(quote?.postMarketChange).toBe(11.65);
    expect(quote?.postMarketChangePercent).toBe(4.2933);
  });

  it("does not classify stale AF extended data as post-market during regular session", async () => {
    vi.useFakeTimers({ now: new Date("2026-05-01T16:30:00Z") });

    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("query1.finance.yahoo.com")) {
        return new Response("too many requests", { status: 429 });
      }
      if (url.includes("google.com/finance/quote/AMD")) {
        return new Response(
          fakeGoogleAfQuotePage({
            ticker: "AMD",
            exchange: "NASDAQ",
            name: "Advanced Micro Devices Inc",
            price: 356.8,
            change: 2.31,
            changePercent: 0.6516,
            previousClose: 354.49,
            afExt: {
              price: 353.35,
              change: -3.61,
              changePercent: -0.9891,
              session: { year: 2026, month: 5, day: 1 },
            },
          }),
          { status: 200, headers: { "Content-Type": "text/html" } }
        );
      }
      return new Response("", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const mod = await import("./ticker.service.js");
    mod._resetTickerServiceState();
    const quote = await mod.fetchTickerQuote("AMD");

    expect(quote?.price).toBe(356.8);
    expect(quote?.marketSession).toBeUndefined();
    expect(quote?.postMarketPrice).toBeUndefined();
    expect(quote?.postMarketChange).toBeUndefined();
    expect(quote?.postMarketChangePercent).toBeUndefined();

    vi.useRealTimers();
  });

  it("falls back to HTML label extraction when AF has no extended array", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("query1.finance.yahoo.com")) {
        return new Response("too many requests", { status: 429 });
      }
      if (url.includes("google.com/finance/quote/AAPL")) {
        return new Response(
          fakeGoogleAfQuotePage({
            ticker: "AAPL",
            exchange: "NASDAQ",
            name: "Apple Inc",
            price: 274.39,
            change: 4.220001,
            changePercent: 1.5619799,
            previousClose: 270.17,
            ext:
              `<div class="ivZBbf ygUjEc" jsname="QRHKC">After Hours:` +
              `<span><div class="YMlKec fxKbKc">$275.10</div></span>` +
              `<span><span>0.26%</span></span>` +
              `<span><span>+0.71</span></span>` +
              `</div>`,
          }),
          { status: 200, headers: { "Content-Type": "text/html" } }
        );
      }
      return new Response("", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const mod = await import("./ticker.service.js");
    mod._resetTickerServiceState();
    const quote = await mod.fetchTickerQuote("AAPL");

    expect(quote?.price).toBe(274.39);
    expect(quote?.marketSession).toBe("post");
    expect(quote?.postMarketPrice).toBe(275.1);
    expect(quote?.postMarketChange).toBe(0.71);
    expect(quote?.postMarketChangePercent).toBe(0.26);
  });

  it("returns null for malformed AF quote data", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("query1.finance.yahoo.com")) {
        return new Response("too many requests", { status: 429 });
      }
      if (url.includes("google.com/finance/quote/AAPL")) {
        return new Response(
          `AF_initDataCallback({key: 'ds:2', data:[[[["/m/test",["AAPL","NASDAQ"],"Apple Inc",0,"USD",[null,4.22,1.56],null,270.17]]]], sideChannel: {}});`,
          { status: 200, headers: { "Content-Type": "text/html" } }
        );
      }
      return new Response("", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const mod = await import("./ticker.service.js");
    mod._resetTickerServiceState();
    const quote = await mod.fetchTickerQuote("AAPL");

    expect(quote).toBeNull();
  });
});

describe("ticker service — default market index aliases", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    applyEnv();
  });

  it("maps VIX to Yahoo ^VIX but returns the default VIX response identity", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("query1.finance.yahoo.com/v8/finance/chart/%5EVIX")) {
        return new Response(
          JSON.stringify({
            chart: {
              result: [
                {
                  meta: {
                    symbol: "^VIX",
                    longName: "CBOE Volatility Index",
                    regularMarketPrice: 16.42,
                    chartPreviousClose: 17,
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
    const quote = await mod.fetchTickerQuote("VIX");

    expect(quote).toMatchObject({
      ticker: "VIX",
      name: "CBOE Volatility Index",
      price: 16.42,
      previousClose: 17,
    });
    expect(quote?.sourceUrl).toContain("%5EVIX");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("maps SPX to Yahoo ^GSPC but returns the default S&P 500 response identity", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("query1.finance.yahoo.com/v8/finance/chart/%5EGSPC")) {
        return new Response(
          JSON.stringify({
            chart: {
              result: [
                {
                  meta: {
                    symbol: "^GSPC",
                    longName: "S&P 500",
                    regularMarketPrice: 5250.33,
                    chartPreviousClose: 5220.11,
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
    const quote = await mod.fetchTickerQuote("SPX");

    expect(quote).toMatchObject({
      ticker: "SPX",
      name: "S&P 500",
      price: 5250.33,
      previousClose: 5220.11,
    });
    expect(quote?.sourceUrl).toContain("%5EGSPC");
    expect(fetchMock).toHaveBeenCalledTimes(1);
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

// ─── Helpers for the after-hours extraction tests ────────────────────
// Build a minimal Google Finance quote page that includes the extended-hours
// block matching production's structure. The real page is ~1.2 MB; this
// stripped-down version only contains the fields the parser cares about so
// tests stay legible. `extLabel` is "After Hours" or "Pre-market".
function fakeGoogleFinancePage(args: {
  name: string;
  price: string; // shown in `data-last-price` and main YMlKec
  prevClose: string;
  ext?: {
    label: "After Hours" | "Pre-market";
    price: string; // formatted like "$348.84"
    pct: string; // signed % like "0.30" or "-1.26"
    change: string; // signed plain like "+1.04" or "-2.28"
    closed?: boolean; // include the "Closed:" marker further down the page
  };
}): string {
  const ext = args.ext
    ? `<div class="ivZBbf ygUjEc" jsname="QRHKC">${args.ext.label}:` +
      `<span class="tO2BSb"><div class="YMlKec fxKbKc">${args.ext.price}</div></span>` +
      `<span class="tO2BSb"><span class="JwB6zf">${args.ext.pct}%</span></span>` +
      `<span class="tO2BSb"><span class="P2Luy">${args.ext.change}</span></span>` +
      `</div>` +
      (args.ext.closed
        ? `<div class="ygUjEc">Closed: Apr 24, 7:59:54 PM GMT-4</div>`
        : "")
    : "";
  return (
    `<html><body>` +
    `<div class="zzDege">${args.name}</div>` +
    `<div data-last-price="${args.price}"></div>` +
    `<div class="YMlKec fxKbKc">$${args.price}</div>` +
    `<div class="P6K39c">$${args.prevClose}</div>` +
    ext +
    `</body></html>`
  );
}

describe("ticker service — marketSession + after-hours enrichment", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    vi.useRealTimers();
    applyEnv();
  });

  it("extracts marketSession='post' and postMarketPrice from Google's After Hours block (active post-market)", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("google.com/finance/quote/AAPL")) {
        // Active post-market session: After Hours block present, no "Closed:"
        // marker yet (Google removes "Closed:" while AH is in progress).
        return new Response(
          fakeGoogleFinancePage({
            name: "Apple Inc.",
            price: "180.50",
            prevClose: "179.00",
            ext: {
              label: "After Hours",
              price: "$181.42",
              pct: "0.51",
              change: "+0.92",
            },
          }),
          { status: 200, headers: { "Content-Type": "text/html" } }
        );
      }
      return new Response("", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const mod = await import("./ticker.service.js");
    mod._resetTickerServiceState();
    const quote = await mod.fetchTickerQuote("AAPL");

    expect(quote?.price).toBe(180.5);
    expect(quote?.previousClose).toBe(179.0);
    expect(quote?.marketSession).toBe("post");
    expect(quote?.postMarketPrice).toBe(181.42);
    expect(quote?.postMarketChange).toBe(0.92);
    expect(quote?.postMarketChangePercent).toBe(0.51);
    expect(fetchMock.mock.calls.some(([u]) =>
      String(u).includes("google.com/finance/quote/AAPL")
    )).toBe(true);
  });

  it("enriches Yahoo-sourced stock quotes with Google after-market fields", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("google.com/finance/quote/AVGO")) {
        return new Response(
          fakeGoogleAfQuotePage({
            ticker: "AVGO",
            exchange: "NASDAQ",
            name: "Broadcom Inc",
            price: 200.9,
            change: 1,
            changePercent: 0.4998,
            previousClose: 199.9,
            ext:
              `<div class="ivZBbf ygUjEc" jsname="QRHKC">After Hours:` +
              `<span><div class="YMlKec fxKbKc">$201.20</div></span>` +
              `<span><span>0.15%</span></span>` +
              `<span><span>+0.30</span></span>` +
              `</div>`,
          }),
          { status: 200, headers: { "Content-Type": "text/html" } }
        );
      }
      if (url.includes("query1.finance.yahoo.com/v8/finance/chart/AVGO")) {
        return new Response(
          JSON.stringify({
            chart: {
              result: [
                {
                  meta: {
                    symbol: "AVGO",
                    longName: "Broadcom Inc",
                    regularMarketPrice: 200.9,
                    chartPreviousClose: 199.9,
                  },
                },
              ],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response("", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const mod = await import("./ticker.service.js");
    mod._resetTickerServiceState();
    const quote = await mod.fetchTickerQuote("AVGO");

    expect(quote).toMatchObject({
      ticker: "AVGO",
      name: "Broadcom Inc",
      price: 200.9,
      previousClose: 199.9,
      marketSession: "post",
      postMarketPrice: 201.2,
      postMarketChange: 0.3,
      postMarketChangePercent: 0.15,
    });
  });

  it("ships a plain quote (no session fields) when Google's page has no extended-hours block", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        fakeGoogleFinancePage({
          name: "Apple Inc.",
          price: "180.50",
          prevClose: "179.00",
          // No `ext` → regular session, no After Hours / Pre-market label.
        }),
        { status: 200, headers: { "Content-Type": "text/html" } }
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    const mod = await import("./ticker.service.js");
    mod._resetTickerServiceState();
    const quote = await mod.fetchTickerQuote("AAPL");

    expect(quote?.price).toBe(180.5);
    expect(quote?.marketSession).toBeUndefined();
    expect(quote?.postMarketPrice).toBeUndefined();
    expect(quote?.preMarketPrice).toBeUndefined();
  });

  it("pins BTC to marketSession='regular' (crypto trades 24/7)", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("query1.finance.yahoo.com/v8/finance/chart/BTC-USD")) {
        // BTC still goes through the chart endpoint as its primary source —
        // the chart endpoint still returns regularMarketPrice for crypto.
        return new Response(
          JSON.stringify({
            chart: {
              result: [
                {
                  meta: {
                    symbol: "BTC-USD",
                    longName: "Bitcoin USD",
                    regularMarketPrice: 79000,
                    chartPreviousClose: 78500,
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

    expect(quote?.ticker).toBe("BTC-USD");
    expect(quote?.marketSession).toBe("regular");
  });

  it("extracts marketSession='pre' and preMarketPrice from Google's Pre-market block", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        fakeGoogleFinancePage({
          name: "Apple Inc.",
          price: "180.50",
          prevClose: "179.00",
          ext: {
            label: "Pre-market",
            price: "$178.22",
            pct: "-1.26",
            change: "-2.28",
          },
        }),
        { status: 200, headers: { "Content-Type": "text/html" } }
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    const mod = await import("./ticker.service.js");
    mod._resetTickerServiceState();
    const quote = await mod.fetchTickerQuote("AAPL");

    expect(quote?.marketSession).toBe("pre");
    expect(quote?.preMarketPrice).toBe(178.22);
    expect(quote?.preMarketChange).toBe(-2.28);
    expect(quote?.preMarketChangePercent).toBe(-1.26);
    expect(quote?.postMarketPrice).toBeUndefined();
  });

  it("emits marketSession='post' even when Google's page also has the 'Closed:' regular-session timestamp", async () => {
    // Regression for the bug FE flagged: Google renders the "Closed: <date>"
    // line whenever the regular session has ended (i.e. throughout BOTH
    // active post-market AND overnight). A previous version of this code
    // treated that line as an "overnight" signal and emitted
    // marketSession='closed', which silenced the FE moon indicator during
    // the exact post-market hours it was designed for. The contract is now
    // simple: if the After Hours block (and therefore postMarketPrice)
    // is present, the session is 'post' — full stop. If FE later wants to
    // distinguish "live AH" from "stale overnight AH", it can do so from
    // the quote's `fetchedAt` timestamp.
    const fetchMock = vi.fn(async () =>
      new Response(
        fakeGoogleFinancePage({
          name: "Advanced Micro Devices",
          price: "347.80",
          prevClose: "305.33",
          ext: {
            label: "After Hours",
            price: "$348.84",
            pct: "0.30",
            change: "+1.04",
            closed: true, // "Closed:" timestamp present — must NOT downgrade session
          },
        }),
        { status: 200, headers: { "Content-Type": "text/html" } }
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    const mod = await import("./ticker.service.js");
    mod._resetTickerServiceState();
    const quote = await mod.fetchTickerQuote("AMD");

    // Internally consistent: postMarketPrice present → session is 'post'.
    expect(quote?.marketSession).toBe("post");
    expect(quote?.postMarketPrice).toBe(348.84);
    expect(quote?.postMarketChange).toBe(1.04);
    expect(quote?.postMarketChangePercent).toBe(0.3);
  });

  it("emits the session flag even when the After Hours numbers can't be parsed (defensive partial-parse)", async () => {
    // If Google's HTML structure shifts and our numeric regex stops matching
    // but the label is still there, we can still tell the FE we're in an
    // extended session (so the moon indicator works) — even without the
    // explicit price. Better than going dark on the indicator entirely.
    const fetchMock = vi.fn(async () =>
      new Response(
        // Has "After Hours:" label but no following YMlKec block — partial
        // page or future markup change.
        `<html><body>` +
          `<div class="zzDege">Apple Inc.</div>` +
          `<div data-last-price="180.50"></div>` +
          `<div class="P6K39c">$179.00</div>` +
          `<div>After Hours: <em>data unavailable</em></div>` +
          `</body></html>`,
        { status: 200, headers: { "Content-Type": "text/html" } }
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    const mod = await import("./ticker.service.js");
    mod._resetTickerServiceState();
    const quote = await mod.fetchTickerQuote("AAPL");

    expect(quote?.marketSession).toBe("post"); // label seen, no Closed marker
    expect(quote?.postMarketPrice).toBeUndefined(); // numbers couldn't be parsed
  });

  it("aborts slow upstream requests so refresh workers can continue", async () => {
    process.env.QUOTE_FETCH_TIMEOUT_MS = "10";
    const fetchMock = vi.fn((_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) {
          reject(new Error("missing abort signal"));
          return;
        }
        signal.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        });
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const mod = await import("./ticker.service.js");
    mod._resetTickerServiceState();
    const quote = await mod.fetchFreshTickerQuote("BTC-USD");

    expect(quote).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2); // Yahoo chart, then CoinGecko fallback
  });
});
