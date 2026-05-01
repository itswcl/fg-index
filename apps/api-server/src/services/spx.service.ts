import { env } from "../config/env.js";
import type { TickerQuote } from "@shared/types";
import { withGoogleFinanceLocale } from "./google-finance-url.service.js";
import { parseGoogleFinanceQuoteHtml } from "./google-finance-parser.service.js";
import { validateTickerQuote } from "./validateQuote.js";

const SPX_TICKER = "SPX";
const SPX_NAME = "S&P 500";

async function scrapeGoogleFinance(): Promise<TickerQuote | null> {
  try {
    const url = withGoogleFinanceLocale(env.GOOGLE_FINANCE_SPX_URL);
    const response = await fetch(url, {
      headers: { "User-Agent": env.SCRAPER_USER_AGENT },
    });

    if (!response.ok) return null;

    const html = await response.text();
    const parsed = parseGoogleFinanceQuoteHtml(html, {
      tickerFormat: ".INX:INDEXSP",
    });
    if (!parsed) return null;

    return validateTickerQuote({
      ticker: SPX_TICKER,
      name: SPX_NAME,
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
  // ^GSPC is an index — no extended-hours trade print to surface. The FE
  // shows no moon indicator for SPX, which matches the spec.
  return (await scrapeGoogleFinance()) ?? (await scrapeYahooFinance());
}
