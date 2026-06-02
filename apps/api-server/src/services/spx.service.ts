import { env } from "../config/env.js";
import type { TickerQuote } from "@shared/types";
import { withGoogleFinanceLocale } from "./google-finance-url.service.js";
import { parseGoogleFinanceQuoteHtml } from "./google-finance-parser.service.js";
import { validateTickerQuote } from "./validateQuote.js";

const SPX_TICKER = "SPX";
const SPX_NAME = "S&P 500";
const YAHOO_SPX_CHART_URL =
  "https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC?interval=1d&range=1d";

interface YahooChartMeta {
  regularMarketPrice?: number;
  chartPreviousClose?: number;
  previousClose?: number;
  regularMarketPreviousClose?: number;
}

function finitePositive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

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
  const chartQuote = await fetchYahooChartQuote();
  if (chartQuote) return chartQuote;

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

async function fetchYahooChartQuote(): Promise<TickerQuote | null> {
  try {
    const response = await fetch(YAHOO_SPX_CHART_URL, {
      headers: {
        "User-Agent": env.SCRAPER_USER_AGENT,
        Accept: "application/json",
      },
    });

    if (!response.ok) return null;

    const json = (await response.json()) as {
      chart?: { result?: Array<{ meta?: YahooChartMeta }> };
    };
    const meta = json.chart?.result?.[0]?.meta;
    if (!meta) return null;

    const price = meta.regularMarketPrice;
    const previousClose =
      meta.chartPreviousClose ?? meta.regularMarketPreviousClose ?? meta.previousClose;
    if (!finitePositive(price) || !finitePositive(previousClose)) return null;

    const change = +(price - previousClose).toFixed(4);
    const changePercent = +((change / previousClose) * 100).toFixed(4);

    return validateTickerQuote({
      ticker: SPX_TICKER,
      name: SPX_NAME,
      price,
      previousClose,
      change,
      changePercent,
      fetchedAt: new Date().toISOString(),
      sourceUrl: YAHOO_SPX_CHART_URL,
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
