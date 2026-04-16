import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Request, Response } from "express";
import {
  getPreferences,
  updatePreferences,
} from "../controllers/user.controller.js";
import { prisma } from "../services/db.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
const findUniqueSpy = vi.spyOn(prisma.user, "findUnique") as unknown as any;
const updateSpy = vi.spyOn(prisma.user, "update") as unknown as any;
/* eslint-enable @typescript-eslint/no-explicit-any */

interface MockedRes {
  _status: number;
  _body: unknown;
  status(code: number): MockedRes;
  json(body: unknown): MockedRes;
  end(): MockedRes;
}

function mockRes(): MockedRes & Response {
  const res: MockedRes = {
    _status: 0,
    _body: null,
    status(code) {
      this._status = code;
      return this;
    },
    json(body) {
      this._body = body;
      return this;
    },
    end() {
      return this;
    },
  };
  return res as unknown as MockedRes & Response;
}

function mockReq(opts: { userId?: string; body?: unknown }): Request {
  return {
    userId: opts.userId,
    body: opts.body,
    params: {},
  } as unknown as Request;
}

const USER = "00000000-0000-0000-0000-000000000042";

beforeEach(() => {
  findUniqueSpy.mockReset();
  updateSpy.mockReset();
});

describe("user.controller — auth gate", () => {
  it("getPreferences without userId returns 401", async () => {
    const res = mockRes();
    await getPreferences(mockReq({}), res);
    expect(res._status).toBe(401);
  });

  it("updatePreferences without userId returns 401", async () => {
    const res = mockRes();
    await updatePreferences(mockReq({ body: { cardOrder: [] } }), res);
    expect(res._status).toBe(401);
  });
});

describe("getPreferences", () => {
  it("returns the user's stored cardOrder", async () => {
    findUniqueSpy.mockResolvedValue({ cardOrder: ["fearGreed", "vix"] });
    const res = mockRes();
    await getPreferences(mockReq({ userId: USER }), res);
    expect(findUniqueSpy).toHaveBeenCalledWith({
      where: { id: USER },
      select: { cardOrder: true },
    });
    expect(res._body).toEqual({ cardOrder: ["fearGreed", "vix"] });
  });

  it("returns [] when row is missing", async () => {
    findUniqueSpy.mockResolvedValue(null);
    const res = mockRes();
    await getPreferences(mockReq({ userId: USER }), res);
    expect(res._body).toEqual({ cardOrder: [] });
  });
});

describe("updatePreferences", () => {
  it("rejects non-array body", async () => {
    const res = mockRes();
    await updatePreferences(
      mockReq({ userId: USER, body: { cardOrder: "nope" } }),
      res
    );
    expect(res._status).toBe(400);
  });

  it("rejects payload exceeding the cap", async () => {
    const cardOrder = Array.from({ length: 33 }, (_, i) => `c${i}`);
    const res = mockRes();
    await updatePreferences(
      mockReq({ userId: USER, body: { cardOrder } }),
      res
    );
    expect(res._status).toBe(400);
  });

  it("dedupes and persists in first-seen order", async () => {
    updateSpy.mockImplementation(async (args: { data: { cardOrder: string[] } }) => ({
      cardOrder: args.data.cardOrder,
    }));
    const res = mockRes();
    await updatePreferences(
      mockReq({
        userId: USER,
        body: { cardOrder: ["a", "b", "a", "c", "b"] },
      }),
      res
    );
    expect(updateSpy).toHaveBeenCalledWith({
      where: { id: USER },
      data: { cardOrder: ["a", "b", "c"] },
      select: { cardOrder: true },
    });
    expect(res._body).toEqual({ cardOrder: ["a", "b", "c"] });
  });
});
