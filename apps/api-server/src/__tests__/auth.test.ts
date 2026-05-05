import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Request, Response, NextFunction } from "express";
import {
  authMiddleware,
  __clearUserUpsertCacheForTests,
  __setVerifyOverrideForTests,
} from "../middlewares/auth.js";
import { prisma } from "../services/db.js";

// Stub the Prisma client's user.upsert so tests don't touch the DB.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const upsertSpy = vi.spyOn(prisma.user, "upsert") as unknown as any;
upsertSpy.mockResolvedValue({
  id: "stub",
  email: "stub@example.com",
  createdAt: new Date(),
});

interface MockedRes {
  _status: number;
  _body: unknown;
  status(code: number): MockedRes;
  json(body: unknown): MockedRes;
}

function mockReq(headers: Record<string, string> = {}): Request {
  return {
    header(name: string) {
      return headers[name] ?? headers[name.toLowerCase()];
    },
  } as unknown as Request;
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
  };
  return res as unknown as MockedRes & Response;
}

describe("authMiddleware", () => {
  beforeEach(() => {
    upsertSpy.mockClear();
    __clearUserUpsertCacheForTests();
  });

  afterEach(() => {
    __setVerifyOverrideForTests(null);
  });

  it("rejects requests with no Authorization header", async () => {
    const req = mockReq();
    const res = mockRes();
    const next = vi.fn() as unknown as NextFunction;

    await authMiddleware(req, res, next);

    expect(res._status).toBe(401);
    expect(res._body).toMatchObject({ code: "UNAUTHORIZED" });
    expect(next).not.toHaveBeenCalled();
  });

  it("rejects Authorization header without Bearer prefix", async () => {
    const req = mockReq({ Authorization: "token abc" });
    const res = mockRes();
    const next = vi.fn() as unknown as NextFunction;

    await authMiddleware(req, res, next);

    expect(res._status).toBe(401);
    expect(res._body).toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("rejects empty bearer token", async () => {
    const req = mockReq({ Authorization: "Bearer " });
    const res = mockRes();
    const next = vi.fn() as unknown as NextFunction;

    await authMiddleware(req, res, next);

    expect(res._status).toBe(401);
    expect(res._body).toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("rejects tokens that fail verification", async () => {
    __setVerifyOverrideForTests(async () => {
      throw new Error("signature verification failed");
    });

    const req = mockReq({ Authorization: "Bearer bogus" });
    const res = mockRes();
    const next = vi.fn() as unknown as NextFunction;

    await authMiddleware(req, res, next);

    expect(res._status).toBe(401);
    expect(res._body).toMatchObject({ code: "INVALID_TOKEN" });
    expect(upsertSpy).not.toHaveBeenCalled();
  });

  it("rejects tokens missing sub claim", async () => {
    __setVerifyOverrideForTests(async () => ({
      email: "user@example.com",
    }));

    const req = mockReq({ Authorization: "Bearer good" });
    const res = mockRes();
    const next = vi.fn() as unknown as NextFunction;

    await authMiddleware(req, res, next);

    expect(res._status).toBe(401);
    expect(res._body).toMatchObject({ code: "INVALID_TOKEN" });
    expect(upsertSpy).not.toHaveBeenCalled();
  });

  it("rejects tokens missing email claim", async () => {
    __setVerifyOverrideForTests(async () => ({
      sub: "00000000-0000-0000-0000-000000000001",
    }));

    const req = mockReq({ Authorization: "Bearer good" });
    const res = mockRes();
    const next = vi.fn() as unknown as NextFunction;

    await authMiddleware(req, res, next);

    expect(res._status).toBe(401);
    expect(res._body).toMatchObject({ code: "INVALID_TOKEN" });
    expect(upsertSpy).not.toHaveBeenCalled();
  });

  it("accepts a valid token, upserts the user, and attaches userId/email", async () => {
    const sub = "00000000-0000-0000-0000-000000000042";
    const email = "alice@example.com";

    __setVerifyOverrideForTests(async () => ({ sub, email }));

    const req = mockReq({ Authorization: "Bearer good" });
    const res = mockRes();
    const next = vi.fn() as unknown as NextFunction;

    await authMiddleware(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res._status).toBe(0); // no error response written
    expect(req.userId).toBe(sub);
    expect(req.userEmail).toBe(email);
    expect(upsertSpy).toHaveBeenCalledWith({
      where: { id: sub },
      update: { email },
      create: { id: sub, email },
    });
  });

  it("skips repeated user upsert while the same user/email is cached", async () => {
    const sub = "00000000-0000-0000-0000-000000000042";
    const email = "alice@example.com";
    __setVerifyOverrideForTests(async () => ({ sub, email }));

    const firstReq = mockReq({ Authorization: "Bearer good" });
    const secondReq = mockReq({ Authorization: "Bearer good" });
    const res = mockRes();

    await authMiddleware(firstReq, res, vi.fn() as unknown as NextFunction);
    await authMiddleware(secondReq, res, vi.fn() as unknown as NextFunction);

    expect(upsertSpy).toHaveBeenCalledTimes(1);
    expect(secondReq.userId).toBe(sub);
    expect(secondReq.userEmail).toBe(email);
  });
});
