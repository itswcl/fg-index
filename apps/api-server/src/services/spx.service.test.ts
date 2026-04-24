import { beforeEach, describe, expect, it, vi } from "vitest";

function applyEnv() {
  process.env.CNN_FEAR_GREED_URL = "https://example.com/fear-greed";
  process.env.GOOGLE_FINANCE_VIX_URL = "https://example.com/vix";
  process.env.YAHOO_FINANCE_VIX_URL = "https://example.com/vix-yahoo";
  process.env.GOOGLE_FINANCE_BTC_URL = "https://example.com/btc";
  process.env.YAHOO_FINANCE_BTC_URL = "https://example.com/btc-yahoo";
  process.env.GOOGLE_FINANCE_SPX_URL = "https://example.com/spx-google";
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

describe("spx.service — partial/NaN rejection", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    applyEnv();
  });

  it("returns a complete quote when Google HTML is well-formed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("spx-google")) {
          return new Response(
            '<html><div data-last-price="5250.33"></div><div class="P6K39c">5220.11</div></html>',
            { status: 200, headers: { "Content-Type": "text/html" } }
          );
        }
        throw new Error(`unexpected fetch: ${url}`);
      })
    );

    const { fetchSpxData } = await import("./spx.service.js");
    const q = await fetchSpxData();
    expect(q).toMatchObject({ ticker: "SPX", price: 5250.33, previousClose: 5220.11 });
    expect(Number.isFinite(q?.change)).toBe(true);
    expect(Number.isFinite(q?.changePercent)).toBe(true);
  });

  it("returns null instead of a NaN-change payload when prev-close is garbage", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("spx-google")) {
          // "." matches `[0-9.,]+` but parseFloat(".") is NaN, which
          // previously shipped { price: 5250, previousClose: NaN, change: NaN, … }.
          return new Response(
            '<html><div data-last-price="5250.33"></div><div class="P6K39c">.</div></html>',
            { status: 200, headers: { "Content-Type": "text/html" } }
          );
        }
        if (url.includes("spx-yahoo")) {
          return new Response("<html>offline</html>", {
            status: 200,
            headers: { "Content-Type": "text/html" },
          });
        }
        throw new Error(`unexpected fetch: ${url}`);
      })
    );

    const { fetchSpxData } = await import("./spx.service.js");
    const q = await fetchSpxData();
    expect(q).toBeNull();
  });

  it("returns null when Yahoo data-value parses to NaN", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("spx-google")) {
          return new Response("<html>no match</html>", {
            status: 200,
            headers: { "Content-Type": "text/html" },
          });
        }
        if (url.includes("spx-yahoo")) {
          // Same trick — "." matches `data-value`, parseFloat gives NaN.
          return new Response('<html><input data-value="."/></html>', {
            status: 200,
            headers: { "Content-Type": "text/html" },
          });
        }
        throw new Error(`unexpected fetch: ${url}`);
      })
    );

    const { fetchSpxData } = await import("./spx.service.js");
    const q = await fetchSpxData();
    expect(q).toBeNull();
  });
});
