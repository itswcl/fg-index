import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Request, Response } from "express";
import {
  listAlerts,
  createAlert,
  updateAlert,
  deleteAlert,
  bulkReplaceAlerts,
} from "../controllers/alerts.controller.js";
import { prisma } from "../services/db.js";

// ─── Prisma stubs ────────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const findManySpy = vi.spyOn(prisma.alert, "findMany") as unknown as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const findUniqueSpy = vi.spyOn(prisma.alert, "findUnique") as unknown as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const createSpy = vi.spyOn(prisma.alert, "create") as unknown as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const updateSpy = vi.spyOn(prisma.alert, "update") as unknown as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const deleteSpy = vi.spyOn(prisma.alert, "delete") as unknown as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const deleteManySpy = vi.spyOn(prisma.alert, "deleteMany") as unknown as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const condDeleteMany = vi.spyOn(prisma.condition, "deleteMany") as unknown as any;

// $transaction: run the callback against a fake tx that reuses the spies above.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const txSpy = vi.spyOn(prisma, "$transaction") as unknown as any;
txSpy.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
  const tx = {
    alert: {
      deleteMany: deleteManySpy,
      create: createSpy,
      update: updateSpy,
      findMany: findManySpy,
    },
    condition: { deleteMany: condDeleteMany },
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
const OTHER = "00000000-0000-0000-0000-0000000000ff";

beforeEach(() => {
  findManySpy.mockReset();
  findUniqueSpy.mockReset();
  createSpy.mockReset();
  updateSpy.mockReset();
  deleteSpy.mockReset();
  deleteManySpy.mockReset();
  condDeleteMany.mockReset();
});

describe("alerts controller — auth gate", () => {
  it("listAlerts without userId returns 401", async () => {
    const req = mockReq({});
    const res = mockRes();
    await listAlerts(req, res);
    expect(res._status).toBe(401);
  });

  it("createAlert without userId returns 401", async () => {
    const req = mockReq({ body: {} });
    const res = mockRes();
    await createAlert(req, res);
    expect(res._status).toBe(401);
  });
});

describe("listAlerts", () => {
  it("returns alerts scoped to the caller", async () => {
    findManySpy.mockResolvedValue([{ id: "a1", userId: USER, conditions: [] }]);
    const req = mockReq({ userId: USER });
    const res = mockRes();
    await listAlerts(req, res);
    expect(findManySpy).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: USER } })
    );
    expect(res._body).toMatchObject({ alerts: [{ id: "a1" }] });
  });
});

describe("createAlert", () => {
  it("rejects invalid body with 400", async () => {
    const req = mockReq({ userId: USER, body: { name: "" } });
    const res = mockRes();
    await createAlert(req, res);
    expect(res._status).toBe(400);
    expect(res._body).toMatchObject({ code: "INVALID_BODY" });
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("creates an alert owned by the caller", async () => {
    createSpy.mockResolvedValue({ id: "new", userId: USER, conditions: [] });
    const req = mockReq({
      userId: USER,
      body: {
        name: "F&G Extreme",
        logic: "AND",
        conditions: [{ metric: "fearGreed", operator: "<", value: 10 }],
      },
    });
    const res = mockRes();
    await createAlert(req, res);
    expect(res._status).toBe(201);
    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ userId: USER, name: "F&G Extreme" }),
      })
    );
  });
});

describe("updateAlert", () => {
  it("returns 404 when alert belongs to another user", async () => {
    findUniqueSpy.mockResolvedValue({ id: "a1", userId: OTHER });
    const req = mockReq({
      userId: USER,
      params: { id: "a1" },
      body: { name: "Renamed", logic: "AND", conditions: [{ metric: "vix", operator: ">", value: 30 }] },
    });
    const res = mockRes();
    await updateAlert(req, res);
    expect(res._status).toBe(404);
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("updates and replaces conditions when provided", async () => {
    findUniqueSpy.mockResolvedValue({ id: "a1", userId: USER });
    updateSpy.mockResolvedValue({ id: "a1", userId: USER, conditions: [] });
    const req = mockReq({
      userId: USER,
      params: { id: "a1" },
      body: {
        name: "Renamed",
        conditions: [{ metric: "vix", operator: ">", value: 30 }],
      },
    });
    const res = mockRes();
    await updateAlert(req, res);
    expect(condDeleteMany).toHaveBeenCalledWith({ where: { alertId: "a1" } });
    expect(updateSpy).toHaveBeenCalled();
    expect(res._body).toMatchObject({ alert: { id: "a1" } });
  });
});

describe("deleteAlert", () => {
  it("returns 404 when alert not owned by caller", async () => {
    findUniqueSpy.mockResolvedValue({ id: "a1", userId: OTHER });
    const req = mockReq({ userId: USER, params: { id: "a1" } });
    const res = mockRes();
    await deleteAlert(req, res);
    expect(res._status).toBe(404);
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  it("deletes and returns 204 on success", async () => {
    findUniqueSpy.mockResolvedValue({ id: "a1", userId: USER });
    deleteSpy.mockResolvedValue({ id: "a1" });
    const req = mockReq({ userId: USER, params: { id: "a1" } });
    const res = mockRes();
    await deleteAlert(req, res);
    expect(res._status).toBe(204);
    expect(res._ended).toBe(true);
    expect(deleteSpy).toHaveBeenCalledWith({ where: { id: "a1" } });
  });
});

describe("bulkReplaceAlerts", () => {
  it("rejects invalid payload", async () => {
    const req = mockReq({ userId: USER, body: { alerts: [{ name: "" }] } });
    const res = mockRes();
    await bulkReplaceAlerts(req, res);
    expect(res._status).toBe(400);
  });

  it("deletes existing alerts then recreates from payload", async () => {
    deleteManySpy.mockResolvedValue({ count: 2 });
    createSpy.mockResolvedValue({ id: "x" });
    findManySpy.mockResolvedValue([{ id: "x", userId: USER, conditions: [] }]);

    const req = mockReq({
      userId: USER,
      body: {
        alerts: [
          {
            name: "A",
            logic: "AND",
            conditions: [{ metric: "vix", operator: ">", value: 30 }],
          },
          {
            name: "B",
            logic: "OR",
            conditions: [{ metric: "fearGreed", operator: "<", value: 10 }],
          },
        ],
      },
    });
    const res = mockRes();
    await bulkReplaceAlerts(req, res);

    expect(deleteManySpy).toHaveBeenCalledWith({ where: { userId: USER } });
    expect(createSpy).toHaveBeenCalledTimes(2);
    expect(res._body).toMatchObject({ alerts: [{ id: "x" }] });
  });
});
