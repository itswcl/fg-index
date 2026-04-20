import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Request, Response } from "express";
import type { TickerQuote } from "@shared/types";

// Mock the ticker service before importing the controller so the
// controller picks up the mocked fetchTickerQuote.
vi.mock("../services/ticker.service.js", () => ({
  fetchTickerQuote: vi.fn(),
}));

import { getBatchQuotes } from "../controllers/ticker.controller.js";
import { fetchTickerQuote } from "../services/ticker.service.js";

const fetchMock = fetchTickerQuote as unknown as ReturnType<typeof vi.fn>;

// ─── Mock req/res ────────────────────────────────────────────────
interface MockedRes {
  _status: number;
  _body: unknown;
  _headers: Record<string, string>;
  status(code: number): MockedRes;
  json(body: unknown): MockedRes;
  set(name: string, value: string): MockedRes;
}

function mockRes(): MockedRes & Response {
  const res: MockedRes = {
    _status: 200,
    _body: null,
    _headers: {},
    status(code) {
      this._status = code;
      return this;
    },
    json(body) {
      this._body = body;
      return this;
    },
    set(name, value) {
      this._headers[name] = value;
      return this;
    },
  };
  return res as unknown as MockedRes & Response;
}

function mockReq(query: Record<string, string>): Request {
  return { query } as unknown as Request;
}

function makeQuote(ticker: string, price: number): TickerQuote {
  return {
    ticker,
    name: ticker,
    price,
    previousClose: price,
    change: 0,
    changePercent: 0,
    fetchedAt: new Date().toISOString(),
  };
}

beforeEach(() => {
  fetchMock.mockReset();
});

describe("getBatchQuotes", () => {
  it("rejects missing symbols param", async () => {
    const res = mockRes();
    await getBatchQuotes(mockReq({}), res);
    expect(res._status).toBe(400);
    expect((res._body as { code: string }).code).toBe("INVALID_QUERY");
  });

  it("rejects empty symbols param", async () => {
    const res = mockRes();
    await getBatchQuotes(mockReq({ symbols: "" }), res);
    expect(res._status).toBe(400);
  });

  it("rejects invalid ticker format", async () => {
    const res = mockRes();
    await getBatchQuotes(mockReq({ symbols: "AAPL,BAD SYMBOL!" }), res);
    expect(res._status).toBe(400);
    expect((res._body as { code: string }).code).toBe("INVALID_TICKER");
  });

  it("rejects batches over the cap (13 symbols)", async () => {
    const symbols = Array.from({ length: 13 }, (_, i) => `T${i}`).join(",");
    const res = mockRes();
    await getBatchQuotes(mockReq({ symbols }), res);
    expect(res._status).toBe(400);
    expect((res._body as { code: string }).code).toBe("BATCH_LIMIT");
  });

  it("returns 12 entries for 12 symbols", async () => {
    fetchMock.mockImplementation(async (sym: string) => makeQuote(sym, 100));
    const symbols = Array.from({ length: 12 }, (_, i) => `T${i}`);
    const res = mockRes();
    await getBatchQuotes(mockReq({ symbols: symbols.join(",") }), res);
    expect(res._status).toBe(200);
    const body = res._body as { quotes: Record<string, unknown> };
    expect(Object.keys(body.quotes)).toHaveLength(12);
    for (const s of symbols) {
      expect(body.quotes[s]).toBeTruthy();
    }
  });

  it("dedupes + uppercases symbols", async () => {
    fetchMock.mockImplementation(async (sym: string) => makeQuote(sym, 50));
    const res = mockRes();
    await getBatchQuotes(
      mockReq({ symbols: "aapl,AAPL,msft,aapl" }),
      res
    );
    expect(res._status).toBe(200);
    const body = res._body as { quotes: Record<string, unknown> };
    expect(Object.keys(body.quotes).sort()).toEqual(["AAPL", "MSFT"]);
    // fetchTickerQuote should have been called with the upper-cased symbols only.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledWith("AAPL");
    expect(fetchMock).toHaveBeenCalledWith("MSFT");
  });

  it("returns null (not an error) when a single symbol fails", async () => {
    fetchMock.mockImplementation(async (sym: string) => {
      if (sym === "BADSYM") return null;
      return makeQuote(sym, 10);
    });
    const res = mockRes();
    await getBatchQuotes(mockReq({ symbols: "AAPL,BADSYM,MSFT" }), res);
    expect(res._status).toBe(200);
    const body = res._body as { quotes: Record<string, unknown> };
    expect(body.quotes.AAPL).toBeTruthy();
    expect(body.quotes.BADSYM).toBeNull();
    expect(body.quotes.MSFT).toBeTruthy();
  });

  it("swallows a rejected scrape as null rather than failing the batch", async () => {
    fetchMock.mockImplementation(async (sym: string) => {
      if (sym === "BOOM") throw new Error("scraper exploded");
      return makeQuote(sym, 20);
    });
    const res = mockRes();
    await getBatchQuotes(mockReq({ symbols: "AAPL,BOOM" }), res);
    expect(res._status).toBe(200);
    const body = res._body as { quotes: Record<string, unknown> };
    expect(body.quotes.AAPL).toBeTruthy();
    expect(body.quotes.BOOM).toBeNull();
  });
});
