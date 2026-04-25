import { env } from "../config/env.js";
import type { TickerQuote } from "@shared/types";
import { validateTickerQuote } from "./validateQuote.js";
import { fetchYahooSession } from "./ticker.service.js";

const SPX_TICKER = "SPX";
const SPX_NAME = "S&P 500";
// Yahoo's symbol for the S&P 500 index. Used only for session/marketState
// enrichment — the price itself still comes from the Google scrape above.
const SPX_YAHOO_SYMBOL = "^GSPC";

async function scrapeGoogleFinance(): Promise<TickerQuote | null> {
  try {
    const response = await fetch(env.GOOGLE_FINANCE_SPX_URL, {
      headers: { "User-Agent": env.SCRAPER_USER_AGENT },
    });

    if (!response.ok) return null;

    const html = await response.text();

    const priceMatch = html.match(/data-last-price="([^"]+)"/);
    const prevCloseMatch = html.match(/class="P6K39c"[^>]*>([0-9.,]+)</);

    if (!priceMatch) return null;

    const price = parseFloat(priceMatch[1].replace(/,/g, ""));
    const previousClose = prevCloseMatch
      ? parseFloat(prevCloseMatch[1].replace(/,/g, ""))
      : price;
    const change = +(price - previousClose).toFixed(2);
    const changePercent =
      previousClose > 0 ? +((change / previousClose) * 100).toFixed(2) : 0;

    return validateTickerQuote({
      ticker: SPX_TICKER,
      name: SPX_NAME,
      price,
      previousClose,
      change,
      changePercent,
      fetchedAt: new Date().toISOString(),
      sourceUrl: env.GOOGLE_FINANCE_SPX_URL,
    });
  } catch {
    return null;
  }
}

async function scrapeYahooFinance(): Promise<TickerQuote | null> {
  try {
    const response = await fetch(env.YAHOO_FINANCE_SPX_URL, {
      headers: { "User-Agent": env.SCRAPER_USER_AGENT },
    });

    if (!response.ok) return null;

    const html = await response.text();

    const priceMatch = html.match(/data-value="([^"]+)"/);
    if (!priceMatch) return null;

    const price = parseFloat(priceMatch[1].replace(/,/g, ""));
    return validateTickerQuote({
      ticker: SPX_TICKER,
      name: SPX_NAME,
      price,
      previousClose: price,
      change: 0,
      changePercent: 0,
      fetchedAt: new Date().toISOString(),
      sourceUrl: env.YAHOO_FINANCE_SPX_URL,
    });
  } catch {
    return null;
  }
}

export async function fetchSpxData(): Promise<TickerQuote | null> {
  const quote = (await scrapeGoogleFinance()) ?? (await scrapeYahooFinance());
  if (!quote) return null;

  // Enrich with marketSession (and any pre/post fields Yahoo exposes for
  // ^GSPC — typically just session, since indices aren't traded after-hours).
  // Best-effort: if Yahoo's chart endpoint is cooling down or down, we ship
  // the plain quote rather than failing the whole fetch.
  const session = await fetchYahooSession(SPX_YAHOO_SYMBOL);
  return Object.keys(session).length === 0 ? quote : { ...quote, ...session };
}
