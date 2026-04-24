import type { TickerQuote } from "@shared/types";

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * Enforces the "complete quote or null" contract at the producer boundary.
 *
 * The frontend sanitizer (apps/web/src/lib/marketData.ts::sanitizeTickerQuote)
 * rejects any quote where price / previousClose / change / changePercent isn't
 * a finite number. Express `res.json()` silently coerces NaN to null over the
 * wire, so a producer returning `{ price: 100, previousClose: 100, change: NaN,
 * changePercent: 0 }` ships `{"change": null, ...}` and the sanitizer throws
 * the whole quote away — users see "Not Found" / "–".
 *
 * Rather than trust every scraper path to guard each field individually
 * (brittle — missed in multiple places already), we run every quote through
 * this validator on its way out. Any non-finite numeric field → null, which
 * means the caller either returns a complete quote or omits the symbol.
 */
export function validateTickerQuote(
  quote: TickerQuote | null | undefined
): TickerQuote | null {
  if (!quote) return null;
  if (
    !isFiniteNumber(quote.price) ||
    !isFiniteNumber(quote.previousClose) ||
    !isFiniteNumber(quote.change) ||
    !isFiniteNumber(quote.changePercent) ||
    quote.price <= 0
  ) {
    return null;
  }
  return quote;
}
