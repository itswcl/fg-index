export function withGoogleFinanceLocale(url: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set("hl", "en");
  return parsed.toString();
}

export function buildGoogleFinanceQuoteUrl(tickerFormat: string): string {
  return withGoogleFinanceLocale(
    `https://www.google.com/finance/quote/${encodeURIComponent(tickerFormat)}`
  );
}
