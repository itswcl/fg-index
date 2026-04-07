import { env } from "../config/env.js";
import { Spx } from "@shared/types";

export async function fetchSpxData(): Promise<Spx | null> {
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

    return {
      price,
      previousClose,
      change,
      changePercent,
      fetchedAt: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}
