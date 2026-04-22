import { env } from "../config/env.js";
import type { TickerQuote } from "@shared/types";

// ─── Cache ─────────────────────────────────────────────────────────
interface CacheEntry {
  data: TickerQuote;
  expiresAt: number;
}

// Maps raw input ticker → resolved Google Finance format (e.g. "AAPL" → "AAPL:NASDAQ")
const resolvedFormatCache = new Map<string, string>();

// Maps resolved ticker → cached quote
const quoteCache = new Map<string, CacheEntry>();

const CACHE_TTL_MS = 15_000; // 15s
const CRYPTO_USD_TICKER_REGEX = /^[A-Z0-9]+-USD$/;

function getCached(ticker: string): TickerQuote | null {
  const entry = quoteCache.get(ticker);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    quoteCache.delete(ticker);
    return null;
  }
  return entry.data;
}

function setCache(ticker: string, data: TickerQuote): void {
  quoteCache.set(ticker, { data, expiresAt: Date.now() + CACHE_TTL_MS });
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

    return {
      ticker: tickerSymbol,
      name: nameMatch ? nameMatch[1].trim() : undefined,
      price,
      previousClose: isNaN(previousClose) ? price : previousClose,
      change,
      changePercent,
      fetchedAt: new Date().toISOString(),
      sourceUrl: url,
    };
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
  // 1. Check resolved format cache
  const knownFormat = resolvedFormatCache.get(rawTicker);
  if (knownFormat) {
    const cached = getCached(knownFormat);
    if (cached) return cached;
    if (isCryptoUsdTicker(knownFormat)) {
      const yahooChart = await fetchYahooChartQuote(knownFormat);
      if (yahooChart) {
        setCache(knownFormat, yahooChart);
        return yahooChart;
      }
    }
    const result = await scrapeGoogleFinance(knownFormat);
    if (result) {
      setCache(knownFormat, result);
      return result;
    }
  }

  // 2. Prefer Yahoo chart JSON for crypto pairs such as BTC-USD because
  // Google Finance has recently served stale HTML snapshots for them.
  if (isCryptoUsdTicker(rawTicker)) {
    const yahooChart = await fetchYahooChartQuote(rawTicker);
    if (yahooChart) {
      resolvedFormatCache.set(rawTicker, rawTicker);
      setCache(rawTicker, yahooChart);
      return yahooChart;
    }
  }

  // 3. Try raw ticker on Google Finance
  const direct = await scrapeGoogleFinance(rawTicker);
  if (direct) {
    resolvedFormatCache.set(rawTicker, rawTicker);
    setCache(rawTicker, direct);
    return direct;
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
  }

  // 5. Yahoo Finance fallback — try as-is
  const yahoo = await scrapeYahooFinance(rawTicker);
  if (yahoo) {
    return yahoo;
  }

  // 6. Yahoo Finance with =F suffix (futures: "ES" → "ES=F", "NQ" → "NQ=F")
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
    if (cached) return cached;
  }

  return resolveAndFetch(upperTicker);
}
