import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Request, Response } from "express";
import { Prisma } from "@prisma/client";
import {
  listTickers,
  addTicker,
  deleteTicker,
  bulkReplaceTickers,
} from "../controllers/ticker-list.controller.js";
import { prisma } from "../services/db.js";

vi.mock("../services/quote-refresh-queue.service.js", () => ({
  enqueueQuoteRefresh: vi.fn(),
}));

import { enqueueQuoteRefresh } from "../services/quote-refresh-queue.service.js";

// ─── Prisma stubs ────────────────────────────────────────────────
/* eslint-disable @typescript-eslint/no-explicit-any */
const findManySpy = vi.spyOn(prisma.userTicker, "findMany") as unknown as any;
const countSpy = vi.spyOn(prisma.userTicker, "count") as unknown as any;
const createSpy = vi.spyOn(prisma.userTicker, "create") as unknown as any;
const deleteManySpy = vi.spyOn(prisma.userTicker, "deleteMany") as unknown as any;
const txSpy = vi.spyOn(prisma, "$transaction") as unknown as any;
const enqueueQuoteRefreshMock =
  enqueueQuoteRefresh as unknown as ReturnType<typeof vi.fn>;
/* eslint-enable @typescript-eslint/no-explicit-any */

txSpy.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
  const tx = {
    userTicker: {
      deleteMany: deleteManySpy,
      create: createSpy,
      findMany: findManySpy,
    },
  };
  return fn(tx);
});

// ─── Mock req/res ────────────────────────────────────────────────
interface MockedRes {
  _status: number;
  _body: unknown;
  _ended: boolean;
  status(code: number): MockedRes;
  json(body: unknown): MockedRes;
  end(): MockedRes;
}

function mockRes(): MockedRes & Response {
  const res: MockedRes = {
    _status: 0,
    _body: null,
    _ended: false,
    status(code) {
      this._status = code;
      return this;
    },
    json(body) {
      this._body = body;
      return this;
    },
    end() {
      this._ended = true;
      return this;
    },
  };
  return res as unknown as MockedRes & Response;
}

function mockReq(opts: {
  userId?: string;
  body?: unknown;
  params?: Record<string, string>;
}): Request {
  return {
    userId: opts.userId,
    body: opts.body,
    params: opts.params ?? {},
  } as unknown as Request;
}

const USER = "00000000-0000-0000-0000-000000000042";

beforeEach(() => {
  findManySpy.mockReset();
  countSpy.mockReset();
  createSpy.mockReset();
  deleteManySpy.mockReset();
  enqueueQuoteRefreshMock.mockReset();
});

describe("ticker-list controller — auth gate", () => {
  it("listTickers without userId returns 401", async () => {
    const res = mockRes();
    await listTickers(mockReq({}), res);
    expect(res._status).toBe(401);
  });

  it("addTicker without userId returns 401", async () => {
    const res = mockRes();
    await addTicker(mockReq({ body: { symbol: "AAPL" } }), res);
    expect(res._status).toBe(401);
  });

  it("deleteTicker without userId returns 401", async () => {
    const res = mockRes();
    await deleteTicker(mockReq({ params: { symbol: "AAPL" } }), res);
    expect(res._status).toBe(401);
  });

  it("bulkReplaceTickers without userId returns 401", async () => {
    const res = mockRes();
    await bulkReplaceTickers(mockReq({ body: { symbols: [] } }), res);
    expect(res._status).toBe(401);
  });
});

describe("listTickers", () => {
  it("returns tickers scoped to the caller", async () => {
    findManySpy.mockResolvedValue([
      { id: "t1", userId: USER, symbol: "AAPL", position: 0 },
    ]);
    const res = mockRes();
    await listTickers(mockReq({ userId: USER }), res);
    expect(res._status).toBe(0); // res.json default
    expect(findManySpy).toHaveBeenCalledWith({
      where: { userId: USER },
      orderBy: [{ position: "asc" }, { createdAt: "asc" }],
    });
    expect((res._body as { tickers: unknown[] }).tickers).toHaveLength(1);
  });
});

describe("addTicker", () => {
  it("rejects invalid symbol", async () => {
    const res = mockRes();
    await addTicker(mockReq({ userId: USER, body: { symbol: "BAD SYMBOL!" } }), res);
    expect(res._status).toBe(400);
  });

  it("uppercases the symbol and assigns next position", async () => {
    countSpy.mockResolvedValue(2);
    createSpy.mockImplementation(async (args: { data: unknown }) => ({
      id: "t3",
      ...(args.data as object),
    }));
    const res = mockRes();
    await addTicker(mockReq({ userId: USER, body: { symbol: "aapl" } }), res);
    expect(res._status).toBe(201);
    expect(createSpy).toHaveBeenCalledWith({
      data: { userId: USER, symbol: "AAPL", position: 2 },
    });
    expect(enqueueQuoteRefreshMock).toHaveBeenCalledWith("AAPL");
  });

  it("accepts futures symbols with equals", async () => {
    countSpy.mockResolvedValue(0);
    createSpy.mockImplementation(async (args: { data: unknown }) => ({
      id: "t1",
      ...(args.data as object),
    }));

    const res = mockRes();
    await addTicker(mockReq({ userId: USER, body: { symbol: "es=f" } }), res);

    expect(res._status).toBe(201);
    expect(createSpy).toHaveBeenCalledWith({
      data: { userId: USER, symbol: "ES=F", position: 0 },
    });
    expect(enqueueQuoteRefreshMock).toHaveBeenCalledWith("ES=F");
  });

  it("canonicalizes default market index aliases before storing", async () => {
    countSpy.mockResolvedValue(0);
    createSpy.mockImplementation(async (args: { data: unknown }) => ({
      id: "t1",
      ...(args.data as object),
    }));

    const res = mockRes();
    await addTicker(mockReq({ userId: USER, body: { symbol: "^gspc" } }), res);

    expect(res._status).toBe(201);
    expect(createSpy).toHaveBeenCalledWith({
      data: { userId: USER, symbol: "SPX", position: 0 },
    });
    expect(enqueueQuoteRefreshMock).toHaveBeenCalledWith("SPX");
  });

  it("rejects when user already has the max", async () => {
    countSpy.mockResolvedValue(32);
    const res = mockRes();
    await addTicker(mockReq({ userId: USER, body: { symbol: "AAPL" } }), res);
    expect(res._status).toBe(400);
    expect((res._body as { code: string }).code).toBe("TICKER_LIMIT");
  });

  it("returns 409 on duplicate", async () => {
    countSpy.mockResolvedValue(1);
    createSpy.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("dup", {
        code: "P2002",
        clientVersion: "x",
      })
    );
    const res = mockRes();
    await addTicker(mockReq({ userId: USER, body: { symbol: "AAPL" } }), res);
    expect(res._status).toBe(409);
    expect((res._body as { code: string }).code).toBe("DUPLICATE_TICKER");
  });
});

describe("deleteTicker", () => {
  it("returns 204 on success", async () => {
    deleteManySpy.mockResolvedValue({ count: 1 });
    const res = mockRes();
    await deleteTicker(
      mockReq({ userId: USER, params: { symbol: "AAPL" } }),
      res
    );
    expect(res._status).toBe(204);
    expect(deleteManySpy).toHaveBeenCalledWith({
      where: { userId: USER, symbol: "AAPL" },
    });
  });

  it("returns 404 when nothing matched", async () => {
    deleteManySpy.mockResolvedValue({ count: 0 });
    const res = mockRes();
    await deleteTicker(
      mockReq({ userId: USER, params: { symbol: "ZZZZ" } }),
      res
    );
    expect(res._status).toBe(404);
  });
});

describe("bulkReplaceTickers", () => {
  it("dedupes and writes positions in order", async () => {
    deleteManySpy.mockResolvedValue({ count: 0 });
    createSpy.mockImplementation(async (args: { data: unknown }) => args.data);
    findManySpy.mockResolvedValue([
      { symbol: "AAPL", position: 0 },
      { symbol: "MSFT", position: 1 },
    ]);
    const res = mockRes();
    await bulkReplaceTickers(
      mockReq({ userId: USER, body: { symbols: ["aapl", "MSFT", "aapl"] } }),
      res
    );
    // Two creates: AAPL@0, MSFT@1 (dup dropped).
    expect(createSpy).toHaveBeenCalledTimes(2);
    expect(createSpy).toHaveBeenNthCalledWith(1, {
      data: { userId: USER, symbol: "AAPL", position: 0 },
    });
    expect(createSpy).toHaveBeenNthCalledWith(2, {
      data: { userId: USER, symbol: "MSFT", position: 1 },
    });
    expect(enqueueQuoteRefreshMock).toHaveBeenCalledWith(["AAPL", "MSFT"]);
    expect((res._body as { tickers: unknown[] }).tickers).toHaveLength(2);
  });

  it("rejects payload exceeding the cap", async () => {
    const symbols = Array.from({ length: 33 }, (_, i) => `T${i}`);
    const res = mockRes();
    await bulkReplaceTickers(mockReq({ userId: USER, body: { symbols } }), res);
    expect(res._status).toBe(400);
  });
});
