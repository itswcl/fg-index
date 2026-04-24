import { env } from "../config/env.js";
import type { TickerQuote } from "@shared/types";
import { validateTickerQuote } from "./validateQuote.js";

// Identity fields applied to every VIX response regardless of which
// scraper produced the price.
const VIX_TICKER = "VIX";
const VIX_NAME = "CBOE Volatility Index";

async function scrapeGoogleFinance(): Promise<TickerQuote | null> {
  try {
    const response = await fetch(env.GOOGLE_FINANCE_VIX_URL, {
      headers: { "User-Agent": env.SCRAPER_USER_AGENT },
    });

    if (!response.ok) return null;

    const html = await response.text();

    const priceMatch = html.match(/data-last-price="([^"]+)"/);
    const prevCloseMatch = html.match(/class="P6K39c"[^>]*>([0-9.]+)</);

    if (!priceMatch) return null;

    const price = parseFloat(priceMatch[1]);
    const previousClose = prevCloseMatch ? parseFloat(prevCloseMatch[1]) : price;
    const change = +(price - previousClose).toFixed(2);
    const changePercent = previousClose > 0 ? +((change / previousClose) * 100).toFixed(2) : 0;

    return validateTickerQuote({
      ticker: VIX_TICKER,
      name: VIX_NAME,
      price,
      previousClose,
      change,
      changePercent,
      fetchedAt: new Date().toISOString(),
      sourceUrl: env.GOOGLE_FINANCE_VIX_URL,
    });
  } catch {
    return null;
  }
}

async function scrapeYahooFinance(): Promise<TickerQuote | null> {
  try {
    const response = await fetch(env.YAHOO_FINANCE_VIX_URL, {
      headers: { "User-Agent": env.SCRAPER_USER_AGENT },
    });

    if (!response.ok) return null;

    const html = await response.text();

    // Today's snapshot only
    const priceMatch = html.match(/data-value="([^"]+)"/);
    if (!priceMatch) {
      const spanMatch = html.match(/<span[^>]*class="[^"]*Fz\(36px\)[^"]*"[^>]*>([0-9.]+)</);
      if (!spanMatch) return null;
      const price = parseFloat(spanMatch[1]);
      return validateTickerQuote({
        ticker: VIX_TICKER,
        name: VIX_NAME,
        price,
        previousClose: price,
        change: 0,
        changePercent: 0,
        fetchedAt: new Date().toISOString(),
        sourceUrl: env.YAHOO_FINANCE_VIX_URL,
      });
    }

    const price = parseFloat(priceMatch[1]);
    return validateTickerQuote({
      ticker: VIX_TICKER,
      name: VIX_NAME,
      price,
      previousClose: price,
      change: 0,
      changePercent: 0,
      fetchedAt: new Date().toISOString(),
      sourceUrl: env.YAHOO_FINANCE_VIX_URL,
    });
  } catch {
    return null;
  }
}

export async function fetchVixData(): Promise<TickerQuote | null> {
  const googleData = await scrapeGoogleFinance();
  if (googleData) return googleData;

  const yahooData = await scrapeYahooFinance();
  return yahooData;
}
