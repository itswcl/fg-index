import { env } from "../config/env.js";
import type { MarketSession, TickerQuote } from "@shared/types";
import {
  applyQuoteSymbolMapping,
  getQuoteSymbolMapping,
  isMappedMarketSymbol,
  normalizeQuoteSymbol,
} from "./quote-symbols.service.js";
import { buildGoogleFinanceQuoteUrl } from "./google-finance-url.service.js";
import { applyGlobalMarketSessionToQuote } from "./market-status.service.js";
import { parseGoogleFinanceQuoteHtml } from "./google-finance-parser.service.js";
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

const CACHE_TTL_MS = env.QUOTE_STOCK_CACHE_TTL_MS; // stocks/indices
// Crypto keeps a longer TTL because upstreams rate-limit hard and the
// fear-and-greed UI doesn't need sub-minute crypto precision.
const CRYPTO_CACHE_TTL_MS = 60_000; // 60s for BTC-USD
// Product scope: the only supported crypto is Bitcoin. Every other input is a
// stock or index. Keeping the set this narrow prevents a stock request from
// ever being interpreted as crypto — e.g. before we locked this down, a
// transient Google-Finance SSR miss on AMD:NASDAQ cascaded through the suffix
// loop to AMD-USD, which Google resolves to a crypto token page, poisoning
// the resolved-format cache with a crypto URL for a semiconductor stock.
const CRYPTO_TICKERS = new Set(["BTC", "BTC-USD"]);

function buildYahooChartUrl(ticker: string): string {
  return (
    `https://query1.finance.yahoo.com/v8/finance/chart/` +
    `${encodeURIComponent(ticker)}?interval=1d&range=1d`
  );
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit = {}
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), env.QUOTE_FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

// Exposed for tests so each `it` starts with a clean cooldown state.
export function _resetTickerServiceState(): void {
  resolvedFormatCache.clear();
  quoteCache.clear();
  lastKnownCache.clear();
  lastKnownStoredAt.clear();
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
  return CRYPTO_TICKERS.has(normalizeQuoteSymbol(ticker));
}

export function getTickerCacheTtlMs(ticker: string): number {
  return isCryptoTicker(ticker) ? CRYPTO_CACHE_TTL_MS : CACHE_TTL_MS;
}

// Map any supported crypto input to its canonical `-USD` form so we hit the
// same cache/CoinGecko key regardless of whether the caller sent "BTC" or
// "BTC-USD".
function canonicalCryptoTicker(ticker: string): string {
  return ticker.endsWith("-USD") ? ticker : `${ticker}-USD`;
}

// ─── Google Finance: extended-hours extraction ────────────────────
// Google's quote page renders a small block right under the main price for
// stocks that are currently in (or have just exited) an extended session.
// Live AMD example:
//
//   <div class="ivZBbf ygUjEc" jsname="QRHKC">
//     After Hours:<span><div class="YMlKec ...">$348.84</div></span>
//     <span>...0.30%...</span>
//     <span>...+1.04...</span>
//   </div>
//
// We pull `marketSession` plus the explicit post/preMarket fields from this
// block. Doing it here means stocks always come back with after-hours data
// in a single round-trip — no second fetch to a heavier upstream (the prior
// Yahoo HTML scrape was failing intermittently on Render's egress).
//
// Caveats:
//   - Indices (^VIX, ^GSPC) don't have this block — they're computed, not
//     traded — so this returns {} and the quote ships without session info.
//   - We deliberately do NOT try to distinguish "active post-market" from
//     "overnight, last AH print still showing". A previous version classified
//     by checking for a "Closed: <date>" marker on the page, but that marker
//     just shows the regular-session close *timestamp* — Google renders it
//     during ACTIVE post-market too. The result was `marketSession='closed'`
//     shipping during real post-market hours, breaking the FE moon indicator
//     in exactly the case it was designed for. The simpler rule — "if there
//     is a postMarketPrice in the response, the session is 'post'" — is
//     internally consistent and matches what the data means.
interface SessionFields {
  marketSession?: MarketSession;
  postMarketPrice?: number;
  postMarketChange?: number;
  postMarketChangePercent?: number;
  preMarketPrice?: number;
  preMarketChange?: number;
  preMarketChangePercent?: number;
}

const finite = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);
const finitePos = (v: unknown): v is number => finite(v) && v > 0;

function extractGoogleSessionFields(html: string): SessionFields {
  // Find the label first. Google uses "After Hours" and "Pre-market"
  // (sometimes "Pre Market"). Either presence tells us we have an extended
  // block to parse; absence means the page is in regular session (or the
  // ticker doesn't trade extended hours).
  const labelMatch = html.match(/(After Hours|Pre[\s-]?market):/);
  if (!labelMatch) return {};

  const isPre = /^pre/i.test(labelMatch[1]);
  // Extract a window of HTML right after the label and pull price / pct /
  // change from it. The pattern mirrors Google's rendered structure: a
  // YMlKec-classed `<div>` with the price, then a percent (in %), then a
  // signed plain change. Bounded `[\s\S]{0,N}` keeps the regex from
  // backtracking across unrelated parts of the 1+ MB page.
  const blockRe = new RegExp(
    `${labelMatch[1]}:[\\s\\S]{0,2000}?` +
      `<div class="YMlKec[^"]*">\\$?([0-9,.]+)<` +
      `[\\s\\S]{0,1000}?>\\s*(-?[0-9.]+)\\s*%<` +
      `[\\s\\S]{0,500}?>\\s*([+\\-]?[0-9.]+)\\s*<`
  );
  const m = html.match(blockRe);

  // Session = whichever extended block is present. Pre-market block → 'pre',
  // After Hours block → 'post'. We do not try to derive 'closed' here — see
  // the long comment on the Caveats above for why the previous "Closed:"
  // detection was wrong.
  const baseSession: MarketSession = isPre ? "pre" : "post";

  // Even without numeric extraction, knowing the session is useful — emit
  // the session flag so the FE indicator works.
  if (!m) return { marketSession: baseSession };

  const price = parseFloat(m[1].replace(/,/g, ""));
  const pct = parseFloat(m[2]);
  const change = parseFloat(m[3]);
  if (!finitePos(price)) return { marketSession: baseSession };

  if (isPre) {
    return {
      marketSession: baseSession,
      preMarketPrice: price,
      ...(finite(change) ? { preMarketChange: +change.toFixed(4) } : {}),
      ...(finite(pct) ? { preMarketChangePercent: +pct.toFixed(4) } : {}),
    };
  }
  return {
    marketSession: baseSession,
    postMarketPrice: price,
    ...(finite(change) ? { postMarketChange: +change.toFixed(4) } : {}),
    ...(finite(pct) ? { postMarketChangePercent: +pct.toFixed(4) } : {}),
  };
}

// ─── Google Finance scraper ────────────────────────────────────────
async function scrapeGoogleFinance(
  tickerFormat: string
): Promise<TickerQuote | null> {
  try {
    const url = buildGoogleFinanceQuoteUrl(tickerFormat);
    const response = await fetchWithTimeout(url, {
      headers: { "User-Agent": env.SCRAPER_USER_AGENT },
    });

    if (!response.ok) return null;

    const html = await response.text();
    const parsed = parseGoogleFinanceQuoteHtml(html, {
      tickerFormat,
      recoverInvalidPreviousClose: true,
    });
    if (!parsed) return null;

    // Session fields: prefer structured AF extended-hours data, fall back to
    // the rendered HTML label ("After Hours:" / "Pre-market:") extraction.
    let sessionFields: SessionFields = {};
    if (finitePos(parsed.extendedPrice)) {
      const change = parsed.extendedChange ?? +(parsed.extendedPrice - parsed.price).toFixed(4);
      const pct = parsed.extendedChangePercent ?? (parsed.price > 0 ? +((change / parsed.price) * 100).toFixed(4) : 0);
      sessionFields = {
        marketSession: "post",
        postMarketPrice: parsed.extendedPrice,
        ...(finite(change) ? { postMarketChange: change } : {}),
        ...(finite(pct) ? { postMarketChangePercent: pct } : {}),
      };
    } else {
      sessionFields = extractGoogleSessionFields(html);
    }

    return validateTickerQuote({
      ticker: parsed.ticker,
      name: parsed.name,
      price: parsed.price,
      previousClose: parsed.previousClose,
      change: parsed.change,
      changePercent: parsed.changePercent,
      fetchedAt: new Date().toISOString(),
      sourceUrl: url,
      ...sessionFields,
    });
  } catch {
    return null;
  }
}

async function enrichWithGoogleSessionFields(
  quote: TickerQuote,
  tickerFormat: string
): Promise<TickerQuote> {
  const google = await scrapeGoogleFinance(tickerFormat);
  if (!google) return quote;

  const fields: SessionFields = {};
  if (google.marketSession) fields.marketSession = google.marketSession;
  if (finitePos(google.postMarketPrice)) fields.postMarketPrice = google.postMarketPrice;
  if (finite(google.postMarketChange)) fields.postMarketChange = google.postMarketChange;
  if (finite(google.postMarketChangePercent)) fields.postMarketChangePercent = google.postMarketChangePercent;
  if (finitePos(google.preMarketPrice)) fields.preMarketPrice = google.preMarketPrice;
  if (finite(google.preMarketChange)) fields.preMarketChange = google.preMarketChange;
  if (finite(google.preMarketChangePercent)) fields.preMarketChangePercent = google.preMarketChangePercent;

  return Object.keys(fields).length > 0 ? { ...quote, ...fields } : quote;
}

// Yahoo's chart endpoint is a fallback source for stocks and mapped indices.
// Stocks prefer Google first (price + after-market in one request), then Yahoo
// chart as fallback.
interface YahooChartMeta {
  regularMarketPrice?: number;
  chartPreviousClose?: number;
  previousClose?: number;
  longName?: string;
  shortName?: string;
  symbol?: string;
}

async function fetchYahooChartMeta(ticker: string): Promise<YahooChartMeta | null> {
  try {
    const url = buildYahooChartUrl(ticker);
    const response = await fetchWithTimeout(url, {
      headers: {
        "User-Agent": env.SCRAPER_USER_AGENT,
        Accept: "application/json",
      },
    });

    if (response.status === 429) return null;
    if (!response.ok) return null;

    const json = (await response.json()) as {
      chart?: { result?: Array<{ meta?: YahooChartMeta }> };
    };

    return json.chart?.result?.[0]?.meta ?? null;
  } catch {
    return null;
  }
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

  const url = buildYahooChartUrl(ticker);

  return {
    ticker: meta.symbol ?? ticker,
    name: meta.longName ?? meta.shortName,
    price,
    previousClose,
    change,
    changePercent,
    fetchedAt: new Date().toISOString(),
    sourceUrl: url,
  };
}

// ─── CoinGecko for crypto ──────────────────────────────────────────
// BTC uses CoinGecko directly so the Yahoo chart quota is reserved for stocks,
// ETFs, indices, and futures-style symbols that need Yahoo as fallback.
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
    const response = await fetchWithTimeout(url, {
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

// Crypto-only fetch path: CoinGecko only. Google is deliberately excluded
// because it served stale crypto snapshots, and Yahoo is reserved for tickers.
async function fetchCryptoQuote(ticker: string): Promise<TickerQuote | null> {
  return fetchCoinGeckoQuote(ticker);
}

// ─── Yahoo Finance fallback ────────────────────────────────────────
async function scrapeYahooFinance(ticker: string): Promise<TickerQuote | null> {
  try {
    // Yahoo uses plain tickers (^GSPC for indices, AAPL for stocks).
    const yahooTicker = ticker.includes(":") ? ticker.split(":")[0] : ticker;
    const url = `https://finance.yahoo.com/quote/${encodeURIComponent(yahooTicker)}`;
    const response = await fetchWithTimeout(url, {
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

async function resolveAndFetch(rawTicker: string): Promise<TickerQuote | null> {
  const mapping = getQuoteSymbolMapping(rawTicker);

  // ─── Crypto: CoinGecko only. Never Google/Yahoo. ─────────────────
  if (isCryptoTicker(mapping.canonicalSymbol)) {
    const canonical = canonicalCryptoTicker(mapping.canonicalSymbol);
    const cached = getCached(canonical);
    if (cached) return cached;

    const crypto = await fetchCryptoQuote(canonical);
    if (crypto) {
      // Crypto markets run 24/7 — there's no pre / post / closed session.
      // Pin to `regular` so the FE's session-based UI stays off for BTC.
      const withSession: TickerQuote = { ...crypto, marketSession: "regular" };
      resolvedFormatCache.set(mapping.canonicalSymbol, canonical);
      setCache(canonical, withSession, CRYPTO_CACHE_TTL_MS);
      return withSession;
    }
    // If both crypto sources fail, return null rather than serving stale
    // Google data. The caller surfaces this as a missing/null quote.
    return null;
  }

  if (isMappedMarketSymbol(rawTicker)) {
    const cached = getCached(mapping.canonicalSymbol);
    if (cached) return cached;

    const yahooChart = await fetchYahooChartQuote(mapping.providerSymbol);
    if (yahooChart) {
      const normalized = applyQuoteSymbolMapping(yahooChart, mapping);
      resolvedFormatCache.set(rawTicker, mapping.canonicalSymbol);
      setCache(mapping.canonicalSymbol, normalized);
      rememberLastKnown(mapping.providerSymbol, normalized);
      return normalized;
    }

    const google = await scrapeGoogleFinance(mapping.providerSymbol);
    if (google) {
      const normalized = applyQuoteSymbolMapping(google, mapping);
      resolvedFormatCache.set(rawTicker, mapping.canonicalSymbol);
      setCache(mapping.canonicalSymbol, normalized);
      rememberLastKnown(mapping.providerSymbol, normalized);
      return normalized;
    }

    const yahooHtml = await scrapeYahooFinance(mapping.providerSymbol);
    if (yahooHtml) {
      const normalized = applyQuoteSymbolMapping(yahooHtml, mapping);
      resolvedFormatCache.set(rawTicker, mapping.canonicalSymbol);
      setCache(mapping.canonicalSymbol, normalized);
      rememberLastKnown(mapping.providerSymbol, normalized);
      return normalized;
    }

    return null;
  }

  // ─── Stocks / indices ────────────────────────────────────────────
  // 1. Check resolved format cache
  const knownFormat = resolvedFormatCache.get(rawTicker);
  if (knownFormat) {
    const cached = getCached(knownFormat);
    if (cached) return cached;
    const result = await scrapeGoogleFinance(knownFormat);
    if (result) {
      setCache(knownFormat, result);
      return result;
    }
    const yahooChart = await fetchYahooChartQuote(knownFormat);
    if (yahooChart) {
      const enriched = await enrichWithGoogleSessionFields(yahooChart, knownFormat);
      setCache(knownFormat, enriched);
      return enriched;
    }
  }

  // 2. Prefer Google Finance for stocks — it provides price + after-market
  // session fields in one request, avoiding the extra Yahoo round-trip that
  // was triggering 429 rate limiting.
  const direct = await scrapeGoogleFinance(rawTicker);
  if (direct) {
    resolvedFormatCache.set(rawTicker, rawTicker);
    setCache(rawTicker, direct);
    return direct;
  }

  // 3. Yahoo chart JSON as fallback
  const yahooChart = await fetchYahooChartQuote(rawTicker);
  if (yahooChart) {
    const enriched = await enrichWithGoogleSessionFields(yahooChart, rawTicker);
    resolvedFormatCache.set(rawTicker, rawTicker);
    setCache(rawTicker, enriched);
    return enriched;
  }

  // 4. Try common exchange suffixes
  for (const suffix of EXCHANGE_SUFFIXES) {
    const fmt = `${rawTicker}${suffix}`;
    const result = await scrapeGoogleFinance(fmt);
    if (result) {
      resolvedFormatCache.set(rawTicker, fmt);
      setCache(fmt, result);
      return result;
    }
    const yahooWithSuffix = await fetchYahooChartQuote(fmt);
    if (yahooWithSuffix) {
      const enriched = await enrichWithGoogleSessionFields(yahooWithSuffix, fmt);
      resolvedFormatCache.set(rawTicker, fmt);
      setCache(fmt, enriched);
      return enriched;
    }
  }

  // 5. Yahoo Finance fallback — try as-is
  const yahoo = await scrapeYahooFinance(rawTicker);
  if (yahoo) {
    return yahoo;
  }

  // 6. Yahoo Finance with =F suffix (futures: "ES" → "ES=F", "NQ" → "NQ=F")
  if (!rawTicker.includes("=") && !rawTicker.includes(":")) {
    const yahooChartFutures = await fetchYahooChartQuote(`${rawTicker}=F`);
    if (yahooChartFutures) {
      resolvedFormatCache.set(rawTicker, `${rawTicker}=F`);
      setCache(`${rawTicker}=F`, yahooChartFutures);
      return yahooChartFutures;
    }
    const yahooFutures = await scrapeYahooFinance(`${rawTicker}=F`);
    if (yahooFutures) {
      resolvedFormatCache.set(rawTicker, `${rawTicker}=F`);
      return yahooFutures;
    }
  }

  return null;
}

export async function fetchFreshTickerQuote(
  rawTicker: string
): Promise<TickerQuote | null> {
  const upperTicker = normalizeQuoteSymbol(rawTicker);

  // Check quote cache with known resolved format first
  const knownFormat = resolvedFormatCache.get(upperTicker);
  if (knownFormat) {
    const cached = getCached(knownFormat);
    if (cached) return validateTickerQuote(cached);
  }

  // Defense-in-depth: every exit through the public API runs through the
  // validator so any future scraper regression that lets a non-finite field
  // slip through gets coerced to null here instead of reaching the wire.
  const quote = validateTickerQuote(await resolveAndFetch(upperTicker));
  return quote ? applyGlobalMarketSessionToQuote(quote) : null;
}

// ─── Public API ────────────────────────────────────────────────────
export async function fetchTickerQuote(
  rawTicker: string
): Promise<TickerQuote | null> {
  const upperTicker = normalizeQuoteSymbol(rawTicker);
  const knownFormat = resolvedFormatCache.get(upperTicker);

  const fresh = await fetchFreshTickerQuote(upperTicker);
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
