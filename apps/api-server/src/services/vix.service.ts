import { env } from "../config/env.js";
import type { TickerQuote } from "@shared/types";
import { withGoogleFinanceLocale } from "./google-finance-url.service.js";
import { parseGoogleFinanceQuoteHtml } from "./google-finance-parser.service.js";
import { validateTickerQuote } from "./validateQuote.js";

// Identity fields applied to every VIX response regardless of which
// scraper produced the price.
const VIX_TICKER = "VIX";
const VIX_NAME = "CBOE Volatility Index";

async function scrapeGoogleFinance(): Promise<TickerQuote | null> {
  try {
    const url = withGoogleFinanceLocale(env.GOOGLE_FINANCE_VIX_URL);
    const response = await fetch(url, {
      headers: { "User-Agent": env.SCRAPER_USER_AGENT },
    });

    if (!response.ok) return null;

    const html = await response.text();
    const parsed = parseGoogleFinanceQuoteHtml(html, {
      tickerFormat: `${VIX_TICKER}:INDEXCBOE`,
    });
    if (!parsed) return null;

    return validateTickerQuote({
      ticker: VIX_TICKER,
      name: VIX_NAME,
      price: parsed.price,
      previousClose: parsed.previousClose,
      change: parsed.change,
      changePercent: parsed.changePercent,
      fetchedAt: new Date().toISOString(),
      sourceUrl: url,
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
  // VIX is an index computed from option premiums — there's no extended-hours
  // trade print, so we don't enrich with session data. The FE shows no moon
  // indicator for VIX, which matches the spec.
  return (await scrapeGoogleFinance()) ?? (await scrapeYahooFinance());
}
