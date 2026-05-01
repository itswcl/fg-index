import { describe, expect, it } from "vitest";
import {
  buildGoogleFinanceQuoteUrl,
  withGoogleFinanceLocale,
} from "./google-finance-url.service.js";

describe("google finance url helpers", () => {
  it("adds hl=en to generated quote URLs", () => {
    expect(buildGoogleFinanceQuoteUrl("AAPL:NASDAQ")).toBe(
      "https://www.google.com/finance/quote/AAPL%3ANASDAQ?hl=en"
    );
  });

  it("preserves existing params and sets hl=en", () => {
    expect(withGoogleFinanceLocale("https://example.com/quote?window=1d")).toBe(
      "https://example.com/quote?window=1d&hl=en"
    );
  });
});
