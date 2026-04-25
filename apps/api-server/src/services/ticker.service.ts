import { env } from "../config/env.js";
import type { MarketSession, TickerQuote } from "@shared/types";
import { validateTickerQuote } from "./validateQuote.js";

// ─── Cache ─────────────────────────────────────────────────────────
interface CacheEntry {
  data: TickerQuote;
  expiresAt: number;
}

// Maps raw input ticker → resolved Google Finance format (e.g. "AAPL" → "AAPL:NASDAQ")
const resolvedFormatCache = new Map<string, string>();

// Maps resolved ticker → cached quote
const quoteCache = new Map<string, CacheEntry>();

// Separate, much longer-lived cache of the last validated quote we ever saw
// for a symbol. Consulted only when the fresh fetch path returns null (e.g.
// Google served an HTML page with no data-last-price element — a transient
// SSR variance we've observed for TSLA). Serving last-known beats serving
// null, which the frontend renders as "Not Found". Keys are both raw tickers
// and their resolved formats so either lookup path can hit.
const lastKnownCache = new Map<string, TickerQuote>();
const LAST_KNOWN_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h hard ceiling
const lastKnownStoredAt = new Map<string, number>();

const CACHE_TTL_MS = 15_000; // 15s for stocks/indices
// Crypto gets a longer TTL because upstreams (Yahoo, CoinGecko) rate-limit
// hard and the fear-and-greed UI doesn't need sub-minute crypto precision.
const CRYPTO_CACHE_TTL_MS = 60_000; // 60s for BTC-USD
// Product scope: the only supported crypto is Bitcoin. Every other input is a
// stock or index. Keeping the set this narrow prevents a stock request from
// ever being interpreted as crypto — e.g. before we locked this down, a
// transient Google-Finance SSR miss on AMD:NASDAQ cascaded through the suffix
// loop to AMD-USD, which Google resolves to a crypto token page, poisoning
// the resolved-format cache with a crypto URL for a semiconductor stock.
const CRYPTO_TICKERS = new Set(["BTC", "BTC-USD"]);

// Yahoo's `query1.finance.yahoo.com` chart endpoint aggressively throttles
// anonymous IPs (observed 429s at ~60–120 req/hr). When we see a 429 we pause
// all Yahoo calls for this long before trying again, to avoid hammering the
// endpoint deeper into a block while we fall through to CoinGecko.
const YAHOO_COOLDOWN_MS = 5 * 60_000; // 5 min
let yahooCooldownUntil = 0;

function isYahooInCooldown(): boolean {
  return Date.now() < yahooCooldownUntil;
}

function tripYahooCooldown(): void {
  yahooCooldownUntil = Date.now() + YAHOO_COOLDOWN_MS;
}

// Exposed for tests so each `it` starts with a clean cooldown state.
export function _resetTickerServiceState(): void {
  resolvedFormatCache.clear();
  quoteCache.clear();
  lastKnownCache.clear();
  lastKnownStoredAt.clear();
  yahooCooldownUntil = 0;
}

// Write-through: called alongside every `setCache` success so we always have
// a fallback if the next fetch misses. Indexed by both the raw ticker and
// its resolved format so a later call that only knows one key still hits.
function rememberLastKnown(ticker: string, data: TickerQuote): void {
  lastKnownCache.set(ticker, data);
  lastKnownStoredAt.set(ticker, Date.now());
}

function getLastKnown(ticker: string): TickerQuote | null {
  const entry = lastKnownCache.get(ticker);
  if (!entry) return null;
  const storedAt = lastKnownStoredAt.get(ticker) ?? 0;
  if (Date.now() - storedAt > LAST_KNOWN_MAX_AGE_MS) {
    // Don't serve day-old prices — let the null propagate so clients see
    // that we've genuinely lost coverage rather than a stale number.
    lastKnownCache.delete(ticker);
    lastKnownStoredAt.delete(ticker);
    return null;
  }
  return entry;
}

function getCached(ticker: string): TickerQuote | null {
  const entry = quoteCache.get(ticker);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    quoteCache.delete(ticker);
    return null;
  }
  return entry.data;
}

function setCache(ticker: string, data: TickerQuote, ttlMs = CACHE_TTL_MS): void {
  quoteCache.set(ticker, { data, expiresAt: Date.now() + ttlMs });
  // Shadow every validated success into last-known so a later null fetch
  // can serve stale-but-complete instead of returning null.
  rememberLastKnown(ticker, data);
}

function isCryptoTicker(ticker: string): boolean {
  return CRYPTO_TICKERS.has(ticker);
}

// Map any supported crypto input to its canonical `-USD` form so we hit the
// same cache/CoinGecko key regardless of whether the caller sent "BTC" or
// "BTC-USD".
function canonicalCryptoTicker(ticker: string): string {
  return ticker.endsWith("-USD") ? ticker : `${ticker}-USD`;
}

// ─── Google Finance scraper ────────────────────────────────────────
async function scrapeGoogleFinance(
  tickerFormat: string
): Promise<TickerQuote | null> {
  try {
    const url = `https://www.google.com/finance/quote/${encodeURIComponent(tickerFormat)}`;
    const response = await fetch(url, {
      headers: { "User-Agent": env.SCRAPER_USER_AGENT },
    });

    if (!response.ok) return null;

    const html = await response.text();

    const priceMatch = html.match(/data-last-price="([^"]+)"/);
    if (!priceMatch) return null;

    const prevCloseMatch = html.match(/class="P6K39c"[^>]*>\$?([0-9.,]+)</);
    const nameMatch = html.match(/<div class="zzDege">([^<]+)<\/div>/);

    const rawPrice = priceMatch[1].replace(/,/g, "");
    const price = parseFloat(rawPrice);
    if (isNaN(price) || price <= 0) return null;

    const rawPrev = prevCloseMatch ? prevCloseMatch[1].replace(/,/g, "") : rawPrice;
    const previousClose = parseFloat(rawPrev);

    const change = +(price - previousClose).toFixed(4);
    const changePercent =
      previousClose > 0 ? +((change / previousClose) * 100).toFixed(4) : 0;

    // Extract the clean ticker symbol (e.g. "AAPL" from "AAPL:NASDAQ")
    const tickerSymbol = tickerFormat.includes(":")
      ? tickerFormat.split(":")[0]
      : tickerFormat;

    // Guard `change` alongside `previousClose`: when prevClose parsed to NaN,
    // we recover it with `price` but `change` was already computed from NaN
    // above. Recompute here so the returned quote never ships NaN fields.
    const safePreviousClose = isNaN(previousClose) ? price : previousClose;
    const safeChange = +(price - safePreviousClose).toFixed(4);
    const safeChangePercent =
      safePreviousClose > 0
        ? +((safeChange / safePreviousClose) * 100).toFixed(4)
        : 0;

    return validateTickerQuote({
      ticker: tickerSymbol,
      name: nameMatch ? nameMatch[1].trim() : undefined,
      price,
      previousClose: safePreviousClose,
      change: safeChange,
      changePercent: safeChangePercent,
      fetchedAt: new Date().toISOString(),
      sourceUrl: url,
    });
  } catch {
    return null;
  }
}

// Yahoo's chart `meta` block is the one upstream that tells us the current
// market session and the extended-hours prints in a single JSON call. We use
// it two ways:
//   1. As a primary quote source for crypto (`fetchYahooChartQuote`).
//   2. As best-effort enrichment for Google-scraped stocks, so every /quote
//      response carries `marketSession` and (when applicable) the post/pre
//      market tick. See `fetchYahooSession` below.
interface YahooChartMeta {
  regularMarketPrice?: number;
  chartPreviousClose?: number;
  previousClose?: number;
  longName?: string;
  shortName?: string;
  symbol?: string;
  marketState?: string;
  postMarketPrice?: number;
  postMarketChange?: number;
  postMarketChangePercent?: number;
  preMarketPrice?: number;
  preMarketChange?: number;
  preMarketChangePercent?: number;
}

async function fetchYahooChartMeta(ticker: string): Promise<YahooChartMeta | null> {
  try {
    const url =
      `https://query1.finance.yahoo.com/v8/finance/chart/` +
      `${encodeURIComponent(ticker)}?interval=1d&range=5d`;
    const response = await fetch(url, {
      headers: {
        "User-Agent": env.SCRAPER_USER_AGENT,
        Accept: "application/json",
      },
    });

    // Rate-limited → trip cooldown so we stop hammering Yahoo and route crypto
    // through CoinGecko for the next few minutes.
    if (response.status === 429) {
      tripYahooCooldown();
      return null;
    }
    if (!response.ok) return null;

    const json = (await response.json()) as {
      chart?: { result?: Array<{ meta?: YahooChartMeta }> };
    };

    return json.chart?.result?.[0]?.meta ?? null;
  } catch {
    return null;
  }
}

// Map Yahoo's raw `marketState` enum onto our public session union. Yahoo
// uses a broader vocabulary than we expose — PREPRE / POSTPOST are the
// "futures have opened but the equity session hasn't started/resumed" states,
// which we fold into `pre` / `post` because the FE only needs to know
// "regular vs extended". Anything we don't recognize returns undefined so
// the FE falls back to its own timestamp heuristic instead of guessing.
function mapMarketState(state: string | undefined): MarketSession | undefined {
  switch (state) {
    case "REGULAR":
      return "regular";
    case "PRE":
    case "PREPRE":
      return "pre";
    case "POST":
    case "POSTPOST":
      return "post";
    case "CLOSED":
      return "closed";
    default:
      return undefined;
  }
}

interface SessionFields {
  marketSession?: MarketSession;
  postMarketPrice?: number;
  postMarketChange?: number;
  postMarketChangePercent?: number;
  preMarketPrice?: number;
  preMarketChange?: number;
  preMarketChangePercent?: number;
}

// Pull the session + extended-hours fields out of a Yahoo meta block. Numeric
// fields are only forwarded when they're finite and (for prices) positive —
// same discipline as validateTickerQuote applies here so NaN can't ship over
// the wire as JSON `null`.
function sessionFieldsFromMeta(meta: YahooChartMeta): SessionFields {
  const out: SessionFields = {};
  const session = mapMarketState(meta.marketState);
  if (session) out.marketSession = session;

  const finitePos = (v: unknown): v is number =>
    typeof v === "number" && Number.isFinite(v) && v > 0;
  const finite = (v: unknown): v is number =>
    typeof v === "number" && Number.isFinite(v);

  if (finitePos(meta.postMarketPrice)) {
    out.postMarketPrice = meta.postMarketPrice;
    if (finite(meta.postMarketChange)) out.postMarketChange = meta.postMarketChange;
    if (finite(meta.postMarketChangePercent))
      out.postMarketChangePercent = meta.postMarketChangePercent;
  }
  if (finitePos(meta.preMarketPrice)) {
    out.preMarketPrice = meta.preMarketPrice;
    if (finite(meta.preMarketChange)) out.preMarketChange = meta.preMarketChange;
    if (finite(meta.preMarketChangePercent))
      out.preMarketChangePercent = meta.preMarketChangePercent;
  }
  return out;
}

// Public helper for other services (VIX, SPX) to enrich their own scraped
// quotes with session info. Respects the Yahoo cooldown so a rate-limit event
// on the chart endpoint pauses enrichment without poisoning the main scrape.
// Yahoo symbol is caller's responsibility (^VIX, ^GSPC, etc.).
export async function fetchYahooSession(
  yahooSymbol: string
): Promise<SessionFields> {
  if (isYahooInCooldown()) return {};
  const meta = await fetchYahooChartMeta(yahooSymbol);
  if (!meta) return {};
  return sessionFieldsFromMeta(meta);
}

async function fetchYahooChartQuote(ticker: string): Promise<TickerQuote | null> {
  const meta = await fetchYahooChartMeta(ticker);
  if (!meta) return null;

  const price = meta.regularMarketPrice;
  if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) {
    return null;
  }

  const previousCloseCandidate = meta.chartPreviousClose ?? meta.previousClose;
  const previousClose =
    typeof previousCloseCandidate === "number" &&
    Number.isFinite(previousCloseCandidate) &&
    previousCloseCandidate > 0
      ? previousCloseCandidate
      : price;
  const change = +(price - previousClose).toFixed(4);
  const changePercent =
    previousClose > 0 ? +((change / previousClose) * 100).toFixed(4) : 0;

  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/` +
    `${encodeURIComponent(ticker)}?interval=1d&range=5d`;

  return {
    ticker: meta.symbol ?? ticker,
    name: meta.longName ?? meta.shortName,
    price,
    previousClose,
    change,
    changePercent,
    fetchedAt: new Date().toISOString(),
    sourceUrl: url,
    ...sessionFieldsFromMeta(meta),
  };
}

// ─── CoinGecko fallback for crypto ─────────────────────────────────
// When Yahoo is rate-limited we need a crypto-native source that won't serve
// stale data the way Google Finance has been. CoinGecko's /simple/price is
// free, keyless, returns fresh spot + 24h change, and tolerates ~30 req/min.
const COINGECKO_SYMBOL_TO_ID: Record<string, { id: string; name: string }> = {
  "BTC-USD": { id: "bitcoin", name: "Bitcoin USD" },
  "ETH-USD": { id: "ethereum", name: "Ethereum USD" },
  "SOL-USD": { id: "solana", name: "Solana USD" },
  "BNB-USD": { id: "binancecoin", name: "BNB USD" },
  "XRP-USD": { id: "ripple", name: "XRP USD" },
  "ADA-USD": { id: "cardano", name: "Cardano USD" },
  "DOGE-USD": { id: "dogecoin", name: "Dogecoin USD" },
  "AVAX-USD": { id: "avalanche-2", name: "Avalanche USD" },
  "MATIC-USD": { id: "matic-network", name: "Polygon USD" },
  "DOT-USD": { id: "polkadot", name: "Polkadot USD" },
  "LINK-USD": { id: "chainlink", name: "Chainlink USD" },
  "LTC-USD": { id: "litecoin", name: "Litecoin USD" },
  "BCH-USD": { id: "bitcoin-cash", name: "Bitcoin Cash USD" },
  "TRX-USD": { id: "tron", name: "TRON USD" },
  "ATOM-USD": { id: "cosmos", name: "Cosmos USD" },
};

async function fetchCoinGeckoQuote(ticker: string): Promise<TickerQuote | null> {
  const mapped = COINGECKO_SYMBOL_TO_ID[ticker];
  if (!mapped) return null;

  try {
    const url =
      `https://api.coingecko.com/api/v3/simple/price` +
      `?ids=${encodeURIComponent(mapped.id)}&vs_currencies=usd&include_24hr_change=true`;
    const response = await fetch(url, {
      headers: {
        "User-Agent": env.SCRAPER_USER_AGENT,
        Accept: "application/json",
      },
    });
    if (!response.ok) return null;

    const json = (await response.json()) as Record<
      string,
      { usd?: number; usd_24h_change?: number } | undefined
    >;
    const row = json[mapped.id];
    const price = row?.usd;
    if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) {
      return null;
    }

    // CoinGecko gives us a 24h % change, not a prev close. Derive prev close
    // from (price / (1 + pct/100)) so change/changePercent stay consistent
    // with the shape of other providers.
    const changePercent =
      typeof row?.usd_24h_change === "number" &&
      Number.isFinite(row.usd_24h_change)
        ? +row.usd_24h_change.toFixed(4)
        : 0;
    const previousClose =
      changePercent !== 0 ? +(price / (1 + changePercent / 100)).toFixed(4) : price;
    const change = +(price - previousClose).toFixed(4);

    return {
      ticker,
      name: mapped.name,
      price,
      previousClose,
      change,
      changePercent,
      fetchedAt: new Date().toISOString(),
      sourceUrl: url,
    };
  } catch {
    return null;
  }
}

// Crypto-only fetch path: Yahoo first (unless cooling down), then CoinGecko.
// Google is deliberately excluded — observed to serve stale crypto snapshots,
// which is the bug this fallback chain exists to avoid.
async function fetchCryptoQuote(ticker: string): Promise<TickerQuote | null> {
  if (!isYahooInCooldown()) {
    const yahoo = await fetchYahooChartQuote(ticker);
    if (yahoo) return yahoo;
  }
  return fetchCoinGeckoQuote(ticker);
}

// ─── Yahoo Finance fallback ────────────────────────────────────────
async function scrapeYahooFinance(ticker: string): Promise<TickerQuote | null> {
  try {
    // Yahoo uses plain tickers (BTC-USD for crypto, ^GSPC for indices, AAPL for stocks)
    const yahooTicker = ticker.includes(":") ? ticker.split(":")[0] : ticker;
    const url = `https://finance.yahoo.com/quote/${encodeURIComponent(yahooTicker)}`;
    const response = await fetch(url, {
      headers: { "User-Agent": env.SCRAPER_USER_AGENT },
    });

    if (!response.ok) return null;

    const html = await response.text();

    const priceMatch = html.match(/data-value="([^"]+)"/);
    if (!priceMatch) return null;

    const rawPrice = priceMatch[1].replace(/,/g, "");
    const price = parseFloat(rawPrice);
    if (isNaN(price) || price <= 0) return null;

    return {
      ticker: yahooTicker,
      price,
      previousClose: price,
      change: 0,
      changePercent: 0,
      fetchedAt: new Date().toISOString(),
      sourceUrl: url,
    };
  } catch {
    return null;
  }
}

// ─── Auto-resolution strategy ──────────────────────────────────────
// Stock/index exchange suffixes ONLY. `-USD` is deliberately excluded: it's a
// crypto format and Google Finance resolves stock-letter strings like "AMD" to
// crypto token pages under `-USD`, which poisoned our resolved-format cache
// (see the CRYPTO_TICKERS comment). Crypto routes through its own path above.
const EXCHANGE_SUFFIXES = [":NASDAQ", ":NYSE", ":NYSEARCA", ":MUTF", ":CME_EMINIS", ":CME"];

// Extract the Yahoo-compatible symbol from whatever format Google used.
// Google's "AAPL:NASDAQ" maps to Yahoo's "AAPL"; indices like ^VIX are already
// in Yahoo form. Anything else goes across as-is.
function yahooSymbolFor(rawOrResolvedTicker: string): string {
  return rawOrResolvedTicker.includes(":")
    ? rawOrResolvedTicker.split(":")[0]
    : rawOrResolvedTicker;
}

// Merge session/aftermarket fields onto a Google-scraped stock quote. We call
// Yahoo's chart-meta endpoint as a best-effort enrichment — when Yahoo is
// cooling down or rate-limits us, we fall back to the plain Google quote
// without session info rather than failing the whole fetch.
async function enrichStockWithSession(
  quote: TickerQuote,
  yahooSymbol: string
): Promise<TickerQuote> {
  const session = await fetchYahooSession(yahooSymbol);
  if (Object.keys(session).length === 0) return quote;
  return { ...quote, ...session };
}

async function resolveAndFetch(rawTicker: string): Promise<TickerQuote | null> {
  // ─── Crypto: Yahoo → CoinGecko. Never Google. ────────────────────
  if (isCryptoTicker(rawTicker)) {
    const canonical = canonicalCryptoTicker(rawTicker);
    const cached = getCached(canonical);
    if (cached) return cached;

    const crypto = await fetchCryptoQuote(canonical);
    if (crypto) {
      // Crypto markets run 24/7 — there's no pre / post / closed session.
      // Pin to `regular` so the FE's session-based UI (moon indicator) stays
      // off for BTC regardless of which upstream (Yahoo vs CoinGecko) won.
      const withSession: TickerQuote = { ...crypto, marketSession: "regular" };
      resolvedFormatCache.set(rawTicker, canonical);
      setCache(canonical, withSession, CRYPTO_CACHE_TTL_MS);
      return withSession;
    }
    // If both crypto sources fail, return null rather than serving stale
    // Google data. The caller surfaces this as a missing/null quote.
    return null;
  }

  // ─── Stocks / indices (existing flow) ────────────────────────────
  // 1. Check resolved format cache
  const knownFormat = resolvedFormatCache.get(rawTicker);
  if (knownFormat) {
    const cached = getCached(knownFormat);
    if (cached) return cached;
    const result = await scrapeGoogleFinance(knownFormat);
    if (result) {
      const enriched = await enrichStockWithSession(result, yahooSymbolFor(knownFormat));
      setCache(knownFormat, enriched);
      return enriched;
    }
  }

  // 2. Try raw ticker on Google Finance
  const direct = await scrapeGoogleFinance(rawTicker);
  if (direct) {
    const enriched = await enrichStockWithSession(direct, yahooSymbolFor(rawTicker));
    resolvedFormatCache.set(rawTicker, rawTicker);
    setCache(rawTicker, enriched);
    return enriched;
  }

  // 3. Try common exchange suffixes
  for (const suffix of EXCHANGE_SUFFIXES) {
    const fmt = `${rawTicker}${suffix}`;
    const result = await scrapeGoogleFinance(fmt);
    if (result) {
      const enriched = await enrichStockWithSession(result, yahooSymbolFor(fmt));
      resolvedFormatCache.set(rawTicker, fmt);
      setCache(fmt, enriched);
      return enriched;
    }
  }

  // 4. Yahoo Finance fallback — try as-is
  const yahoo = await scrapeYahooFinance(rawTicker);
  if (yahoo) {
    return yahoo;
  }

  // 5. Yahoo Finance with =F suffix (futures: "ES" → "ES=F", "NQ" → "NQ=F")
  if (!rawTicker.includes("=") && !rawTicker.includes(":")) {
    const yahooFutures = await scrapeYahooFinance(`${rawTicker}=F`);
    if (yahooFutures) {
      resolvedFormatCache.set(rawTicker, `${rawTicker}=F`);
      return yahooFutures;
    }
  }

  return null;
}

// ─── Public API ────────────────────────────────────────────────────
export async function fetchTickerQuote(
  rawTicker: string
): Promise<TickerQuote | null> {
  const upperTicker = rawTicker.toUpperCase();

  // Check quote cache with known resolved format first
  const knownFormat = resolvedFormatCache.get(upperTicker);
  if (knownFormat) {
    const cached = getCached(knownFormat);
    if (cached) return validateTickerQuote(cached);
  }

  // Defense-in-depth: every exit through the public API runs through the
  // validator so any future scraper regression that lets a non-finite field
  // slip through gets coerced to null here instead of reaching the wire.
  const fresh = validateTickerQuote(await resolveAndFetch(upperTicker));
  if (fresh) return fresh;

  // Fresh fetch missed (transient scraper flake, upstream hiccup, etc.).
  // Serve the last validated quote we ever saw for this symbol rather than
  // null, so the frontend doesn't flash "Not Found" over a card that we
  // know the real price for. Try both the raw ticker and any resolved
  // format we've learned — either path may be the one that was written.
  const lastKnown =
    getLastKnown(upperTicker) ??
    (knownFormat ? getLastKnown(knownFormat) : null);
  return lastKnown; // null only when we've genuinely never seen this symbol
}
