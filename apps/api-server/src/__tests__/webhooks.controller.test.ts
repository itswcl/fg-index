import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Request, Response } from "express";
import {
  listWebhooks,
  createWebhook,
  updateWebhook,
  deleteWebhook,
  testWebhookById,
  MAX_WEBHOOKS_PER_USER,
} from "../controllers/webhooks.controller.js";
import { prisma } from "../services/db.js";
import * as delivery from "../services/webhookDelivery.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const findManySpy = vi.spyOn(prisma.webhook, "findMany") as unknown as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const findFirstSpy = vi.spyOn(prisma.webhook, "findFirst") as unknown as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const findUniqueSpy = vi.spyOn(prisma.webhook, "findUnique") as unknown as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const countSpy = vi.spyOn(prisma.webhook, "count") as unknown as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const createSpy = vi.spyOn(prisma.webhook, "create") as unknown as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const updateManySpy = vi.spyOn(prisma.webhook, "updateMany") as unknown as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const deleteManySpy = vi.spyOn(prisma.webhook, "deleteMany") as unknown as any;
const deliverSpy = vi.spyOn(delivery, "deliverWebhook");

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
    status(code) { this._status = code; return this; },
    json(body) { this._body = body; return this; },
    end() { this._ended = true; return this; },
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

function row(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "wh-1",
    userId: USER,
    name: "My Webhook",
    type: "discord",
    url: "https://discord.com/api/webhooks/x/y",
    botToken: null,
    chatId: null,
    enabled: true,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

beforeEach(() => {
  findManySpy.mockReset();
  findFirstSpy.mockReset();
  findUniqueSpy.mockReset();
  countSpy.mockReset();
  createSpy.mockReset();
  updateManySpy.mockReset();
  deleteManySpy.mockReset();
  deliverSpy.mockReset();
});

describe("webhooks CRUD — auth gate", () => {
  it("listWebhooks without userId returns 401", async () => {
    const res = mockRes();
    await listWebhooks(mockReq({}), res);
    expect(res._status).toBe(401);
  });

  it("createWebhook without userId returns 401", async () => {
    const res = mockRes();
    await createWebhook(mockReq({ body: {} }), res);
    expect(res._status).toBe(401);
  });
});

describe("listWebhooks", () => {
  it("returns the caller's rows mapped to API shape, oldest first", async () => {
    findManySpy.mockResolvedValue([
      row({ id: "a", name: "A" }),
      row({ id: "b", name: "B" }),
    ]);
    const res = mockRes();
    await listWebhooks(mockReq({ userId: USER }), res);
    expect(findManySpy).toHaveBeenCalledWith({
      where: { userId: USER },
      orderBy: { createdAt: "asc" },
    });
    expect(res._body).toMatchObject({
      webhooks: [
        expect.objectContaining({ id: "a", name: "A", type: "discord" }),
        expect.objectContaining({ id: "b", name: "B" }),
      ],
    });
  });
});

describe("createWebhook", () => {
  it("rejects invalid input with 400", async () => {
    const res = mockRes();
    await createWebhook(
      mockReq({ userId: USER, body: { type: "discord", name: "x" } }),
      res
    );
    expect(res._status).toBe(400);
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("returns 409 when the per-user cap is reached", async () => {
    countSpy.mockResolvedValue(MAX_WEBHOOKS_PER_USER);
    const res = mockRes();
    await createWebhook(
      mockReq({
        userId: USER,
        body: { name: "n", type: "discord", url: "https://example.com/h" },
      }),
      res
    );
    expect(res._status).toBe(409);
    expect(res._body).toMatchObject({ code: "WEBHOOK_LIMIT_REACHED" });
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("creates a discord webhook and returns 201", async () => {
    countSpy.mockResolvedValue(0);
    createSpy.mockResolvedValue(
      row({ name: "My Discord", type: "discord", url: "https://example.com/h" })
    );
    const res = mockRes();
    await createWebhook(
      mockReq({
        userId: USER,
        body: {
          name: "My Discord",
          type: "discord",
          url: "https://example.com/h",
        },
      }),
      res
    );
    expect(createSpy).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: USER,
        name: "My Discord",
        type: "discord",
        url: "https://example.com/h",
        botToken: null,
        chatId: null,
        enabled: true,
      }),
    });
    expect(res._status).toBe(201);
    expect(res._body).toMatchObject({ webhook: { type: "discord" } });
  });

  it("creates a telegram webhook with botToken/chatId in the right columns", async () => {
    countSpy.mockResolvedValue(0);
    createSpy.mockResolvedValue(
      row({
        name: "TG",
        type: "telegram",
        url: null,
        botToken: "t",
        chatId: "c",
      })
    );
    const res = mockRes();
    await createWebhook(
      mockReq({
        userId: USER,
        body: { name: "TG", type: "telegram", botToken: "t", chatId: "c" },
      }),
      res
    );
    expect(createSpy).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: "telegram",
        url: null,
        botToken: "t",
        chatId: "c",
      }),
    });
  });
});

describe("updateWebhook", () => {
  it("returns 404 when no row matches (id, userId) — prevents ownership leak", async () => {
    updateManySpy.mockResolvedValue({ count: 0 });
    const res = mockRes();
    await updateWebhook(
      mockReq({
        userId: USER,
        params: { id: "someone-elses" },
        body: { name: "x", type: "discord", url: "https://example.com/h" },
      }),
      res
    );
    expect(updateManySpy).toHaveBeenCalledWith({
      where: { id: "someone-elses", userId: USER },
      data: expect.any(Object),
    });
    expect(res._status).toBe(404);
  });

  it("updates and returns the row when (id, userId) matches", async () => {
    updateManySpy.mockResolvedValue({ count: 1 });
    findUniqueSpy.mockResolvedValue(
      row({ id: "wh-1", name: "Renamed" })
    );
    const res = mockRes();
    await updateWebhook(
      mockReq({
        userId: USER,
        params: { id: "wh-1" },
        body: {
          name: "Renamed",
          type: "discord",
          url: "https://example.com/h",
        },
      }),
      res
    );
    expect(res._body).toMatchObject({
      webhook: expect.objectContaining({ id: "wh-1", name: "Renamed" }),
    });
  });
});

describe("deleteWebhook", () => {
  it("returns 204 on successful delete scoped to the caller", async () => {
    deleteManySpy.mockResolvedValue({ count: 1 });
    const res = mockRes();
    await deleteWebhook(
      mockReq({ userId: USER, params: { id: "wh-1" } }),
      res
    );
    expect(deleteManySpy).toHaveBeenCalledWith({
      where: { id: "wh-1", userId: USER },
    });
    expect(res._status).toBe(204);
    expect(res._ended).toBe(true);
  });

  it("returns 404 when row doesn't belong to caller", async () => {
    deleteManySpy.mockResolvedValue({ count: 0 });
    const res = mockRes();
    await deleteWebhook(
      mockReq({ userId: USER, params: { id: "someone-elses" } }),
      res
    );
    expect(res._status).toBe(404);
  });
});

describe("testWebhookById", () => {
  it("returns 404 when row doesn't belong to the caller", async () => {
    findFirstSpy.mockResolvedValue(null);
    const res = mockRes();
    await testWebhookById(
      mockReq({ userId: USER, params: { id: "someone-elses" } }),
      res
    );
    expect(res._status).toBe(404);
    expect(deliverSpy).not.toHaveBeenCalled();
  });

  it("delivers against the matched row and returns ok", async () => {
    findFirstSpy.mockResolvedValue(
      row({ id: "wh-1", type: "discord", url: "https://example.com/h" })
    );
    deliverSpy.mockResolvedValue(undefined);
    const res = mockRes();
    await testWebhookById(
      mockReq({ userId: USER, params: { id: "wh-1" } }),
      res
    );
    expect(findFirstSpy).toHaveBeenCalledWith({
      where: { id: "wh-1", userId: USER },
    });
    expect(deliverSpy).toHaveBeenCalledWith(
      { type: "discord", url: "https://example.com/h" },
      "fg-index Test",
      expect.any(String)
    );
    expect(res._body).toEqual({ ok: true });
  });

  it("returns 502 when delivery fails", async () => {
    findFirstSpy.mockResolvedValue(
      row({ id: "wh-1", type: "slack", url: "https://example.com/h" })
    );
    deliverSpy.mockRejectedValue(new Error("boom"));
    const res = mockRes();
    await testWebhookById(
      mockReq({ userId: USER, params: { id: "wh-1" } }),
      res
    );
    expect(res._status).toBe(502);
    expect(res._body).toMatchObject({ code: "WEBHOOK_DELIVERY_FAILED" });
  });
});
