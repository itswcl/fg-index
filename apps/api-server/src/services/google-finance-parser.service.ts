export interface ParsedGoogleFinanceQuote {
  ticker: string;
  exchange?: string;
  name?: string;
  price: number;
  previousClose: number;
  change: number;
  changePercent: number;
  extendedPrice?: number;
  extendedChange?: number;
  extendedChangePercent?: number;
}

interface ParseGoogleFinanceQuoteOptions {
  tickerFormat: string;
  recoverInvalidPreviousClose?: boolean;
}

const NUMBER_RE = String.raw`[-+]?\d+(?:\.\d+)?(?:[Ee][-+]?\d+)?`;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function parseNumber(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value.replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function parseMoney(value: string | undefined): number | null {
  if (!value) return null;
  return parseNumber(value.replace(/[$\s]/g, ""));
}

function normalizeTicker(ticker: string): string {
  return ticker.trim().toUpperCase();
}

function splitTickerFormat(tickerFormat: string): { ticker: string; exchange?: string } {
  const [ticker, exchange] = normalizeTicker(tickerFormat).split(":");
  return { ticker, exchange };
}

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function completeQuote(args: {
  ticker: string;
  exchange?: string;
  name?: string;
  price: number | null;
  previousClose?: number | null;
  change?: number | null;
  changePercent?: number | null;
}): ParsedGoogleFinanceQuote | null {
  const price = args.price;
  if (!isFiniteNumber(price) || price <= 0) return null;

  let previousClose = args.previousClose;
  let change = args.change;

  if ((!isFiniteNumber(previousClose) || previousClose <= 0) && isFiniteNumber(change)) {
    previousClose = +(price - change).toFixed(4);
  }
  if (!isFiniteNumber(previousClose) || previousClose <= 0) return null;

  if (!isFiniteNumber(change)) {
    change = +(price - previousClose).toFixed(4);
  }
  const changePercent =
    previousClose > 0 ? +((change / previousClose) * 100).toFixed(4) : args.changePercent;
  if (!isFiniteNumber(change) || !isFiniteNumber(changePercent)) return null;

  return {
    ticker: args.ticker,
    ...(args.exchange ? { exchange: args.exchange } : {}),
    ...(args.name ? { name: args.name } : {}),
    price,
    previousClose,
    change: +change.toFixed(4),
    changePercent,
  };
}

function parseLegacyQuote(
  html: string,
  options: ParseGoogleFinanceQuoteOptions
): ParsedGoogleFinanceQuote | null {
  const priceMatch = html.match(/data-last-price="([^"]+)"/);
  if (!priceMatch) return null;

  const { ticker, exchange } = splitTickerFormat(options.tickerFormat);
  const price = parseNumber(priceMatch[1]);
  if (!isFiniteNumber(price) || price <= 0) return null;

  const prevCloseMatch = html.match(/class="P6K39c"[^>]*>\$?([0-9.,]+)</);
  const parsedPreviousClose = parseMoney(prevCloseMatch?.[1]);
  if (prevCloseMatch && !isFiniteNumber(parsedPreviousClose) && !options.recoverInvalidPreviousClose) {
    return null;
  }

  const previousClose = parsedPreviousClose ?? price;
  const nameMatch = html.match(/<div class="zzDege">([^<]+)<\/div>/);

  return completeQuote({
    ticker,
    exchange,
    name: nameMatch ? decodeHtml(nameMatch[1].trim()) : undefined,
    price,
    previousClose,
  });
}

function parseAfQuote(
  html: string,
  options: ParseGoogleFinanceQuoteOptions
): ParsedGoogleFinanceQuote | null {
  const { ticker: expectedTicker, exchange: expectedExchange } = splitTickerFormat(
    options.tickerFormat
  );
  const number = NUMBER_RE;
  const recordRe = new RegExp(
    String.raw`\[\s*"[^"]+"\s*,\s*\[\s*"([^"]+)"\s*,\s*"([^"]+)"\s*\]\s*,\s*"([^"]*)"` +
      String.raw`[\s\S]{0,120}?\[\s*(${number})\s*,\s*(${number})\s*,\s*(${number})[^\]]*\]` +
      String.raw`(?:\s*,\s*null\s*,\s*(${number}))?` +
      String.raw`(?:[\s\S]{0,300}?null\s*,\s*\[\s*(${number})\s*,\s*(${number})\s*,\s*(${number})[^\]]*\])?`,
    "g"
  );

  for (const match of html.matchAll(recordRe)) {
    const ticker = normalizeTicker(match[1]);
    const exchange = normalizeTicker(match[2]);
    if (ticker !== expectedTicker) continue;
    if (expectedExchange && exchange !== expectedExchange) continue;

    const parsed = completeQuote({
      ticker,
      exchange,
      name: decodeHtml(match[3].trim()),
      price: parseNumber(match[4]),
      change: parseNumber(match[5]),
      changePercent: parseNumber(match[6]),
      previousClose: parseNumber(match[7]),
    });
    if (!parsed) continue;

    const extPrice = parseNumber(match[8]);
    if (isFiniteNumber(extPrice) && extPrice > 0) {
      parsed.extendedPrice = extPrice;
      const extChange = parseNumber(match[9]);
      if (isFiniteNumber(extChange)) parsed.extendedChange = +extChange.toFixed(4);
      const extPct = parseNumber(match[10]);
      if (isFiniteNumber(extPct)) parsed.extendedChangePercent = +extPct.toFixed(4);
    }

    return parsed;
  }

  return null;
}

export function parseGoogleFinanceQuoteHtml(
  html: string,
  options: ParseGoogleFinanceQuoteOptions
): ParsedGoogleFinanceQuote | null {
  return parseAfQuote(html, options) ?? parseLegacyQuote(html, options);
}
