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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const findUniqueSpy = vi.spyOn(prisma.webhookConfig, "findUnique") as unknown as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const upsertSpy = vi.spyOn(prisma.webhookConfig, "upsert") as unknown as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const deleteManySpy = vi.spyOn(prisma.webhookConfig, "deleteMany") as unknown as any;
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

beforeEach(() => {
  findUniqueSpy.mockReset();
  upsertSpy.mockReset();
  deleteManySpy.mockReset();
  deliverSpy.mockReset();
});

describe("webhookConfig — auth gate", () => {
  it("getMyWebhook without userId returns 401", async () => {
    const res = mockRes();
    await getMyWebhook(mockReq({}), res);
    expect(res._status).toBe(401);
  });
});

describe("getMyWebhook", () => {
  it("returns null when no row exists", async () => {
    findUniqueSpy.mockResolvedValue(null);
    const res = mockRes();
    await getMyWebhook(mockReq({ userId: USER }), res);
    expect(res._body).toEqual({ webhook: null });
  });

  it("maps a discord row into discriminated union shape", async () => {
    findUniqueSpy.mockResolvedValue({
      userId: USER,
      type: "discord",
      url: "https://discord.com/api/webhooks/x/y",
      botToken: null,
      chatId: null,
      updatedAt: new Date(),
    });
    const res = mockRes();
    await getMyWebhook(mockReq({ userId: USER }), res);
    expect(res._body).toEqual({
      webhook: { type: "discord", url: "https://discord.com/api/webhooks/x/y" },
    });
  });

  it("maps a telegram row correctly", async () => {
    findUniqueSpy.mockResolvedValue({
      userId: USER,
      type: "telegram",
      url: null,
      botToken: "bot:tok",
      chatId: "123",
      updatedAt: new Date(),
    });
    const res = mockRes();
    await getMyWebhook(mockReq({ userId: USER }), res);
    expect(res._body).toEqual({
      webhook: { type: "telegram", botToken: "bot:tok", chatId: "123" },
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
    expect(upsertSpy).not.toHaveBeenCalled();
  });

  it("upserts a slack webhook with url", async () => {
    upsertSpy.mockResolvedValue({
      userId: USER,
      type: "slack",
      url: "https://hooks.slack.com/x",
      botToken: null,
      chatId: null,
      updatedAt: new Date(),
    });
    const res = mockRes();
    await upsertMyWebhook(
      mockReq({
        userId: USER,
        body: { webhook: { type: "slack", url: "https://hooks.slack.com/x" } },
      }),
      res
    );
    expect(upsertSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: USER },
        create: expect.objectContaining({
          userId: USER,
          type: "slack",
          url: "https://hooks.slack.com/x",
          botToken: null,
          chatId: null,
        }),
      })
    );
    expect(res._body).toMatchObject({ webhook: { type: "slack" } });
  });

  it("stores telegram token/chatId in the correct fields", async () => {
    upsertSpy.mockResolvedValue({
      userId: USER,
      type: "telegram",
      url: null,
      botToken: "t",
      chatId: "c",
      updatedAt: new Date(),
    });
    const res = mockRes();
    await upsertMyWebhook(
      mockReq({
        userId: USER,
        body: { webhook: { type: "telegram", botToken: "t", chatId: "c" } },
      }),
      res
    );
    expect(upsertSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          type: "telegram",
          url: null,
          botToken: "t",
          chatId: "c",
        }),
      })
    );
  });
});

describe("deleteMyWebhook", () => {
  it("deletes the caller's row and returns 204", async () => {
    deleteManySpy.mockResolvedValue({ count: 1 });
    const res = mockRes();
    await deleteMyWebhook(mockReq({ userId: USER }), res);
    expect(deleteManySpy).toHaveBeenCalledWith({ where: { userId: USER } });
    expect(res._status).toBe(204);
    expect(res._ended).toBe(true);
  });
});

describe("testMyWebhook", () => {
  it("returns 404 when no webhook is saved", async () => {
    findUniqueSpy.mockResolvedValue(null);
    const res = mockRes();
    await testMyWebhook(mockReq({ userId: USER }), res);
    expect(res._status).toBe(404);
    expect(deliverSpy).not.toHaveBeenCalled();
  });

  it("delivers against the saved webhook and returns ok", async () => {
    findUniqueSpy.mockResolvedValue({
      userId: USER,
      type: "discord",
      url: "https://discord.com/api/webhooks/x/y",
      botToken: null,
      chatId: null,
      updatedAt: new Date(),
    });
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
    findUniqueSpy.mockResolvedValue({
      userId: USER,
      type: "slack",
      url: "https://hooks.slack.com/x",
      botToken: null,
      chatId: null,
      updatedAt: new Date(),
    });
    deliverSpy.mockRejectedValue(new Error("boom"));
    const res = mockRes();
    await testMyWebhook(mockReq({ userId: USER }), res);
    expect(res._status).toBe(502);
    expect(res._body).toMatchObject({ code: "WEBHOOK_DELIVERY_FAILED" });
  });
});
