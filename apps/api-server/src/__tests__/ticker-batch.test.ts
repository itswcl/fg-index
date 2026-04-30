import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import type { TickerQuote } from "@shared/types";

vi.mock("../services/ticker-cache.service.js", () => ({
  getCachedQuoteSnapshot: vi.fn(),
  getCachedQuotesBatch: vi.fn(),
}));

vi.mock("../services/quote-refresh-queue.service.js", () => ({
  enqueueQuoteRefresh: vi.fn(),
}));

import { getBatchQuotes, getTicker } from "../controllers/ticker.controller.js";
import { getCachedQuoteSnapshot, getCachedQuotesBatch } from "../services/ticker-cache.service.js";
import { enqueueQuoteRefresh } from "../services/quote-refresh-queue.service.js";

const getCachedQuoteSnapshotMock =
  getCachedQuoteSnapshot as unknown as ReturnType<typeof vi.fn>;
const getCachedQuotesBatchMock =
  getCachedQuotesBatch as unknown as ReturnType<typeof vi.fn>;
const enqueueQuoteRefreshMock =
  enqueueQuoteRefresh as unknown as ReturnType<typeof vi.fn>;

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

function mockReq(opts: {
  query?: Record<string, string>;
  params?: Record<string, string>;
}): Request {
  return {
    query: opts.query ?? {},
    params: opts.params ?? {},
  } as unknown as Request;
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
  getCachedQuoteSnapshotMock.mockReset();
  getCachedQuotesBatchMock.mockReset();
  enqueueQuoteRefreshMock.mockReset();
});

describe("getTicker", () => {
  it("returns a cached quote and enqueues a background refresh", async () => {
    const res = mockRes();
    const quote = makeQuote("AAPL", 100);
    getCachedQuoteSnapshotMock.mockResolvedValue({
      quote,
      isFresh: true,
    });

    await getTicker(mockReq({ params: { ticker: "aapl" } }), res);

    expect(res._status).toBe(200);
    expect(res._body).toEqual(quote);
    expect(getCachedQuoteSnapshotMock).toHaveBeenCalledWith("AAPL");
    expect(enqueueQuoteRefreshMock).toHaveBeenCalledWith("AAPL");
  });

  it("returns 404 for an uncached symbol but still enqueues refresh", async () => {
    const res = mockRes();
    getCachedQuoteSnapshotMock.mockResolvedValue({
      quote: null,
      isFresh: false,
    });

    await getTicker(mockReq({ params: { ticker: "tsla" } }), res);

    expect(res._status).toBe(404);
    expect((res._body as { code: string }).code).toBe("TICKER_NOT_FOUND");
    expect(getCachedQuoteSnapshotMock).toHaveBeenCalledWith("TSLA");
    expect(enqueueQuoteRefreshMock).toHaveBeenCalledWith("TSLA");
  });
});

describe("getBatchQuotes", () => {
  it("rejects missing symbols param", async () => {
    const res = mockRes();
    await getBatchQuotes(mockReq({}), res);
    expect(res._status).toBe(400);
    expect((res._body as { code: string }).code).toBe("INVALID_QUERY");
  });

  it("rejects invalid ticker format", async () => {
    const res = mockRes();
    await getBatchQuotes(mockReq({ query: { symbols: "AAPL,BAD SYMBOL!" } }), res);
    expect(res._status).toBe(400);
    expect((res._body as { code: string }).code).toBe("INVALID_TICKER");
  });

  it("rejects batches over the cap (13 symbols)", async () => {
    const symbols = Array.from({ length: 13 }, (_, i) => `T${i}`).join(",");
    const res = mockRes();
    await getBatchQuotes(mockReq({ query: { symbols } }), res);
    expect(res._status).toBe(400);
    expect((res._body as { code: string }).code).toBe("BATCH_LIMIT");
  });

  it("reads cached quotes in one batch call and enqueues a refresh", async () => {
    const symbols = ["AMD", "NVDA", "TSM"];
    const res = mockRes();
    getCachedQuotesBatchMock.mockResolvedValue({
      AMD: makeQuote("AMD", 100),
      NVDA: makeQuote("NVDA", 200),
      TSM: null,
    });

    await getBatchQuotes(
      mockReq({ query: { symbols: symbols.join(",") } }),
      res
    );

    expect(res._status).toBe(200);
    expect(getCachedQuotesBatchMock).toHaveBeenCalledWith(symbols);
    expect(enqueueQuoteRefreshMock).toHaveBeenCalledWith(symbols);
    expect(res._body).toEqual({
      quotes: {
        AMD: expect.objectContaining({ ticker: "AMD" }),
        NVDA: expect.objectContaining({ ticker: "NVDA" }),
        TSM: null,
      },
    });
  });

  it("dedupes + uppercases symbols before cache lookup", async () => {
    const res = mockRes();
    getCachedQuotesBatchMock.mockResolvedValue({
      AAPL: makeQuote("AAPL", 10),
      MSFT: makeQuote("MSFT", 20),
    });

    await getBatchQuotes(
      mockReq({ query: { symbols: "aapl,AAPL,msft,aapl" } }),
      res
    );

    expect(res._status).toBe(200);
    expect(getCachedQuotesBatchMock).toHaveBeenCalledWith(["AAPL", "MSFT"]);
    expect(enqueueQuoteRefreshMock).toHaveBeenCalledWith(["AAPL", "MSFT"]);
  });

  it("canonicalizes default market index aliases before cache lookup", async () => {
    const res = mockRes();
    getCachedQuotesBatchMock.mockResolvedValue({
      VIX: makeQuote("VIX", 16),
      SPX: makeQuote("SPX", 5250),
    });

    await getBatchQuotes(
      mockReq({ query: { symbols: "vix,^gspc,sp500" } }),
      res
    );

    expect(res._status).toBe(200);
    expect(getCachedQuotesBatchMock).toHaveBeenCalledWith(["VIX", "SPX"]);
    expect(enqueueQuoteRefreshMock).toHaveBeenCalledWith(["VIX", "SPX"]);
    expect(res._body).toEqual({
      quotes: {
        VIX: expect.objectContaining({ ticker: "VIX" }),
        SPX: expect.objectContaining({ ticker: "SPX" }),
      },
    });
  });
});
