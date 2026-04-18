import { env } from "../config/env.js";
import { Btc } from "@shared/types";

async function scrapeGoogleFinance(): Promise<Btc | null> {
  try {
    const response = await fetch(env.GOOGLE_FINANCE_BTC_URL, {
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

    return {
      price,
      change,
      changePercent,
      fetchedAt: new Date().toISOString(),
      sourceUrl: env.GOOGLE_FINANCE_BTC_URL,
    };
  } catch {
    return null;
  }
}

async function scrapeYahooFinance(): Promise<Btc | null> {
  try {
    const response = await fetch(env.YAHOO_FINANCE_BTC_URL, {
      headers: { "User-Agent": env.SCRAPER_USER_AGENT },
    });

    if (!response.ok) return null;

    const html = await response.text();

    const priceMatch = html.match(/data-value="([^"]+)"/);
    if (!priceMatch) return null;

    const price = parseFloat(priceMatch[1].replace(/,/g, ""));
    return {
      price,
      change: 0,
      changePercent: 0,
      fetchedAt: new Date().toISOString(),
      sourceUrl: env.YAHOO_FINANCE_BTC_URL,
    };
  } catch {
    return null;
  }
}

export async function fetchBtcData(): Promise<Btc | null> {
  const googleData = await scrapeGoogleFinance();
  if (googleData) return googleData;

  return scrapeYahooFinance();
}
