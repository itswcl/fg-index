import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Request, Response } from "express";
import {
  getMyWebhook,
  upsertMyWebhook,
  deleteMyWebhook,
  testMyWebhook,
} from "../controllers/webhookConfig.controller.js";
import { prisma } from "../services/db.js";
import * as delivery from "../services/webhookDelivery.js";

// The legacy `/me*` controller now operates on the user's *first* (oldest)
// row in the new N-per-user `Webhook` table. Tests stub `prisma.webhook.*`
// directly so we exercise the alias mapping without touching the DB.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const findFirstSpy = vi.spyOn(prisma.webhook, "findFirst") as unknown as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const createSpy = vi.spyOn(prisma.webhook, "create") as unknown as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const updateSpy = vi.spyOn(prisma.webhook, "update") as unknown as any;
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

function mockReq(opts: { userId?: string; body?: unknown }): Request {
  return {
    userId: opts.userId,
    body: opts.body,
  } as unknown as Request;
}

const USER = "00000000-0000-0000-0000-000000000042";

function row(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "wh-1",
    userId: USER,
    name: "Default",
    type: "discord",
    url: null,
    botToken: null,
    chatId: null,
    enabled: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

beforeEach(() => {
  findFirstSpy.mockReset();
  createSpy.mockReset();
  updateSpy.mockReset();
  deleteManySpy.mockReset();
  deliverSpy.mockReset();
});

describe("webhookConfig (legacy alias) — auth gate", () => {
  it("getMyWebhook without userId returns 401", async () => {
    const res = mockRes();
    await getMyWebhook(mockReq({}), res);
    expect(res._status).toBe(401);
  });
});

describe("getMyWebhook", () => {
  it("returns null when the user has no webhook rows", async () => {
    findFirstSpy.mockResolvedValue(null);
    const res = mockRes();
    await getMyWebhook(mockReq({ userId: USER }), res);
    expect(res._body).toEqual({ webhook: null });
  });

  it("maps the first discord row into discriminated union shape", async () => {
    findFirstSpy.mockResolvedValue(
      row({ type: "discord", url: "https://discord.com/api/webhooks/x/y" })
    );
    const res = mockRes();
    await getMyWebhook(mockReq({ userId: USER }), res);
    expect(res._body).toEqual({
      webhook: { type: "discord", url: "https://discord.com/api/webhooks/x/y" },
    });
  });

  it("maps a telegram row correctly", async () => {
    findFirstSpy.mockResolvedValue(
      row({ type: "telegram", url: null, botToken: "bot:tok", chatId: "123" })
    );
    const res = mockRes();
    await getMyWebhook(mockReq({ userId: USER }), res);
    expect(res._body).toEqual({
      webhook: { type: "telegram", botToken: "bot:tok", chatId: "123" },
    });
  });

  it("orders by createdAt ascending so 'first' is the oldest row", async () => {
    findFirstSpy.mockResolvedValue(null);
    const res = mockRes();
    await getMyWebhook(mockReq({ userId: USER }), res);
    expect(findFirstSpy).toHaveBeenCalledWith({
      where: { userId: USER },
      orderBy: { createdAt: "asc" },
    });
  });
});

describe("upsertMyWebhook", () => {
  it("rejects invalid body with 400", async () => {
    const res = mockRes();
    await upsertMyWebhook(
      mockReq({ userId: USER, body: { webhook: { type: "discord" } } }),
      res
    );
    expect(res._status).toBe(400);
    expect(createSpy).not.toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("creates a new row named 'Default' when none exists", async () => {
    findFirstSpy.mockResolvedValue(null);
    createSpy.mockResolvedValue(
      row({ type: "slack", url: "https://hooks.slack.com/x" })
    );
    const res = mockRes();
    await upsertMyWebhook(
      mockReq({
        userId: USER,
        body: { webhook: { type: "slack", url: "https://hooks.slack.com/x" } },
      }),
      res
    );
    expect(createSpy).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: USER,
        name: "Default",
        enabled: true,
        type: "slack",
        url: "https://hooks.slack.com/x",
        botToken: null,
        chatId: null,
      }),
    });
    expect(res._body).toMatchObject({ webhook: { type: "slack" } });
  });

  it("updates the existing first row in place rather than creating a second", async () => {
    findFirstSpy.mockResolvedValue(row({ id: "wh-existing", type: "discord" }));
    updateSpy.mockResolvedValue(
      row({
        id: "wh-existing",
        type: "telegram",
        url: null,
        botToken: "t",
        chatId: "c",
      })
    );
    const res = mockRes();
    await upsertMyWebhook(
      mockReq({
        userId: USER,
        body: { webhook: { type: "telegram", botToken: "t", chatId: "c" } },
      }),
      res
    );
    expect(createSpy).not.toHaveBeenCalled();
    expect(updateSpy).toHaveBeenCalledWith({
      where: { id: "wh-existing" },
      data: expect.objectContaining({
        type: "telegram",
        url: null,
        botToken: "t",
        chatId: "c",
      }),
    });
  });
});

describe("deleteMyWebhook", () => {
  it("deletes ALL rows for the caller (legacy 'off' semantics) and returns 204", async () => {
    deleteManySpy.mockResolvedValue({ count: 3 });
    const res = mockRes();
    await deleteMyWebhook(mockReq({ userId: USER }), res);
    expect(deleteManySpy).toHaveBeenCalledWith({ where: { userId: USER } });
    expect(res._status).toBe(204);
    expect(res._ended).toBe(true);
  });
});

describe("testMyWebhook", () => {
  it("returns 404 when no webhook is saved", async () => {
    findFirstSpy.mockResolvedValue(null);
    const res = mockRes();
    await testMyWebhook(mockReq({ userId: USER }), res);
    expect(res._status).toBe(404);
    expect(deliverSpy).not.toHaveBeenCalled();
  });

  it("delivers against the first saved webhook and returns ok", async () => {
    findFirstSpy.mockResolvedValue(
      row({ type: "discord", url: "https://discord.com/api/webhooks/x/y" })
    );
    deliverSpy.mockResolvedValue(undefined);
    const res = mockRes();
    await testMyWebhook(mockReq({ userId: USER }), res);
    expect(deliverSpy).toHaveBeenCalledWith(
      { type: "discord", url: "https://discord.com/api/webhooks/x/y" },
      "fg-index Test",
      expect.any(String)
    );
    expect(res._body).toEqual({ ok: true });
  });

  it("returns 502 when delivery fails", async () => {
    findFirstSpy.mockResolvedValue(
      row({ type: "slack", url: "https://hooks.slack.com/x" })
    );
    deliverSpy.mockRejectedValue(new Error("boom"));
    const res = mockRes();
    await testMyWebhook(mockReq({ userId: USER }), res);
    expect(res._status).toBe(502);
    expect(res._body).toMatchObject({ code: "WEBHOOK_DELIVERY_FAILED" });
  });
});
