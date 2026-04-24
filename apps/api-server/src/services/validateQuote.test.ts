import { describe, expect, it } from "vitest";
import { validateTickerQuote } from "./validateQuote.js";

describe("validateTickerQuote", () => {
  const base = {
    ticker: "AAPL",
    name: "Apple Inc.",
    price: 180.5,
    previousClose: 179,
    change: 1.5,
    changePercent: 0.838,
    fetchedAt: "2026-04-23T00:00:00.000Z",
    sourceUrl: "https://example.com",
  };

  it("returns the quote unchanged when all numeric fields are finite", () => {
    expect(validateTickerQuote(base)).toEqual(base);
  });

  it("returns null for null / undefined", () => {
    expect(validateTickerQuote(null)).toBeNull();
    expect(validateTickerQuote(undefined)).toBeNull();
  });

  it.each([
    ["price", NaN],
    ["previousClose", NaN],
    ["change", NaN],
    ["changePercent", NaN],
    ["price", Infinity],
    ["previousClose", -Infinity],
  ])("returns null when %s is %s (non-finite)", (field, value) => {
    const bad = { ...base, [field]: value };
    expect(validateTickerQuote(bad)).toBeNull();
  });

  it("returns null when price is zero or negative", () => {
    expect(validateTickerQuote({ ...base, price: 0 })).toBeNull();
    expect(validateTickerQuote({ ...base, price: -5 })).toBeNull();
  });

  it("allows change / changePercent to be zero (flat-day quote)", () => {
    const flat = { ...base, change: 0, changePercent: 0, previousClose: base.price };
    expect(validateTickerQuote(flat)).toEqual(flat);
  });
});
