import { beforeEach, describe, expect, it, vi } from "vitest";

function applyEnv() {
  process.env.CNN_FEAR_GREED_URL = "https://example.com/fear-greed";
  process.env.GOOGLE_FINANCE_VIX_URL = "https://example.com/vix-google";
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

describe("vix.service — partial/NaN rejection", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    applyEnv();
  });

  it("returns a complete quote when Google HTML is well-formed", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("vix-google")) {
        return new Response(
          '<html><div data-last-price="18.52"></div><div class="P6K39c">17.80</div></html>',
          { status: 200, headers: { "Content-Type": "text/html" } }
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { fetchVixData } = await import("./vix.service.js");
    const q = await fetchVixData();
    expect(q).toMatchObject({
      ticker: "VIX",
      price: 18.52,
      previousClose: 17.8,
    });
    expect(Number.isFinite(q?.change)).toBe(true);
    expect(Number.isFinite(q?.changePercent)).toBe(true);
    expect(q?.sourceUrl).toBe("https://example.com/vix-google?hl=en");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.com/vix-google?hl=en",
      expect.any(Object)
    );
  });

  it("parses Google AF_initDataCallback when data-last-price is absent", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("vix-google")) {
          return new Response(
            `AF_initDataCallback({key: 'ds:2', data:[[[[` +
              `"/m/test",["VIX","INDEXCBOE"],"VIX",0,"USD",` +
              `[17.11,-1.6999989,-9.03774,2,2,2],null,18.81,` +
              `"#666666","US"]]]], sideChannel: {}});`,
            { status: 200, headers: { "Content-Type": "text/html" } }
          );
        }
        throw new Error(`unexpected fetch: ${url}`);
      })
    );

    const { fetchVixData } = await import("./vix.service.js");
    const q = await fetchVixData();
    expect(q).toMatchObject({
      ticker: "VIX",
      name: "CBOE Volatility Index",
      price: 17.11,
      previousClose: 18.81,
    });
    expect(Number.isFinite(q?.change)).toBe(true);
    expect(Number.isFinite(q?.changePercent)).toBe(true);
  });

  it("falls through to Yahoo or null when Google AF data is malformed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("vix-google")) {
          return new Response(
            `AF_initDataCallback({key: 'ds:2', data:[[[[` +
              `"/m/test",["VIX","INDEXCBOE"],"VIX",0,"USD",` +
              `[null,-1.6999989,-9.03774],null,18.81]]]], sideChannel: {}});`,
            { status: 200, headers: { "Content-Type": "text/html" } }
          );
        }
        if (url.includes("vix-yahoo")) {
          return new Response("<html><body>offline</body></html>", {
            status: 200,
            headers: { "Content-Type": "text/html" },
          });
        }
        throw new Error(`unexpected fetch: ${url}`);
      })
    );

    const { fetchVixData } = await import("./vix.service.js");
    const q = await fetchVixData();
    expect(q).toBeNull();
  });

  it("rejects the Google payload (falls through to Yahoo or null) when prev-close is non-numeric", async () => {
    // Google matches data-last-price fine but prev-close is garbage → parseFloat = NaN.
    // Before the fix this returned { price: 18.52, previousClose: 18.52, change: NaN, ... }.
    // After the fix: validator returns null, and we fall through to Yahoo.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("vix-google")) {
          // "." passes the `[0-9.]+` regex capture but parseFloat(".") is NaN.
          // Before the fix the scraper returned { price: 18.52,
          // previousClose: NaN, change: NaN, changePercent: 0 } over the wire.
          return new Response(
            '<html><div data-last-price="18.52"></div><div class="P6K39c">.</div></html>',
            { status: 200, headers: { "Content-Type": "text/html" } }
          );
        }
        if (url.includes("vix-yahoo")) {
          // Yahoo HTML has neither `data-value` nor the Fz(36px) span → null.
          return new Response("<html><body>offline</body></html>", {
            status: 200,
            headers: { "Content-Type": "text/html" },
          });
        }
        throw new Error(`unexpected fetch: ${url}`);
      })
    );

    const { fetchVixData } = await import("./vix.service.js");
    const q = await fetchVixData();
    expect(q).toBeNull();
  });

  it("returns null when Yahoo span parses to NaN", async () => {
    // Google fails the match → falls to Yahoo. Yahoo data-value matches a
    // non-numeric string → parseFloat = NaN → validator kicks in.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("vix-google")) {
          return new Response("<html>no match</html>", {
            status: 200,
            headers: { "Content-Type": "text/html" },
          });
        }
        if (url.includes("vix-yahoo")) {
          // "." matches `data-value="([^"]+)"` but parseFloat(".") is NaN,
          // which previously shipped { price: NaN, previousClose: NaN, … }.
          return new Response(
            '<html><input data-value="."/></html>',
            { status: 200, headers: { "Content-Type": "text/html" } }
          );
        }
        throw new Error(`unexpected fetch: ${url}`);
      })
    );

    const { fetchVixData } = await import("./vix.service.js");
    const q = await fetchVixData();
    expect(q).toBeNull();
  });
});
