import { env } from "../config/env.js";
import type { TickerQuote } from "@shared/types";
import { validateTickerQuote } from "./validateQuote.js";
import { fetchYahooSession } from "./ticker.service.js";

// Identity fields applied to every VIX response regardless of which
// scraper produced the price.
const VIX_TICKER = "VIX";
const VIX_NAME = "CBOE Volatility Index";
// Yahoo's symbol for the CBOE Volatility Index. Used only to enrich the
// scraped quote with `marketSession` — the price itself still comes from
// the Google/Yahoo HTML scrape paths above.
const VIX_YAHOO_SYMBOL = "^VIX";

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
  const quote = (await scrapeGoogleFinance()) ?? (await scrapeYahooFinance());
  if (!quote) return null;

  // Enrich with marketSession. ^VIX is index-computed (no after-hours print),
  // so typically only `marketSession` is added; pre/post price fields stay
  // undefined. Best-effort — Yahoo cooldown or upstream miss leaves the quote
  // intact rather than dropping it.
  const session = await fetchYahooSession(VIX_YAHOO_SYMBOL);
  return Object.keys(session).length === 0 ? quote : { ...quote, ...session };
}
