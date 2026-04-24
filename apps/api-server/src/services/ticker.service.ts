import { env } from "../config/env.js";
import type { TickerQuote } from "@shared/types";
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
const CRYPTO_CACHE_TTL_MS = 60_000; // 60s for BTC-USD / ETH-USD / …
const CRYPTO_USD_TICKER_REGEX = /^[A-Z0-9]+-USD$/;

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

function isCryptoUsdTicker(ticker: string): boolean {
  return CRYPTO_USD_TICKER_REGEX.test(ticker);
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

async function fetchYahooChartQuote(ticker: string): Promise<TickerQuote | null> {
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

    const json = await response.json() as {
      chart?: {
        result?: Array<{
          meta?: {
            regularMarketPrice?: number;
            chartPreviousClose?: number;
            previousClose?: number;
            longName?: string;
            shortName?: string;
            symbol?: string;
          };
        }>;
      };
    };

    const meta = json.chart?.result?.[0]?.meta;
    const price = meta?.regularMarketPrice;
    if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) {
      return null;
    }

    const previousCloseCandidate = meta?.chartPreviousClose ?? meta?.previousClose;
    const previousClose =
      typeof previousCloseCandidate === "number" &&
      Number.isFinite(previousCloseCandidate) &&
      previousCloseCandidate > 0
        ? previousCloseCandidate
        : price;
    const change = +(price - previousClose).toFixed(4);
    const changePercent =
      previousClose > 0 ? +((change / previousClose) * 100).toFixed(4) : 0;

    return {
      ticker: meta?.symbol ?? ticker,
      name: meta?.longName ?? meta?.shortName,
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
const EXCHANGE_SUFFIXES = [":NASDAQ", ":NYSE", ":NYSEARCA", ":MUTF", ":CME_EMINIS", ":CME", "-USD"];

async function resolveAndFetch(rawTicker: string): Promise<TickerQuote | null> {
  // ─── Crypto: Yahoo → CoinGecko. Never Google. ────────────────────
  if (isCryptoUsdTicker(rawTicker)) {
    const cached = getCached(rawTicker);
    if (cached) return cached;

    const crypto = await fetchCryptoQuote(rawTicker);
    if (crypto) {
      resolvedFormatCache.set(rawTicker, rawTicker);
      setCache(rawTicker, crypto, CRYPTO_CACHE_TTL_MS);
      return crypto;
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
      setCache(knownFormat, result);
      return result;
    }
  }

  // 2. Try raw ticker on Google Finance
  const direct = await scrapeGoogleFinance(rawTicker);
  if (direct) {
    resolvedFormatCache.set(rawTicker, rawTicker);
    setCache(rawTicker, direct);
    return direct;
  }

  // 3. Try common exchange suffixes
  for (const suffix of EXCHANGE_SUFFIXES) {
    const fmt = `${rawTicker}${suffix}`;
    const result = await scrapeGoogleFinance(fmt);
    if (result) {
      resolvedFormatCache.set(rawTicker, fmt);
      setCache(fmt, result);
      return result;
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
