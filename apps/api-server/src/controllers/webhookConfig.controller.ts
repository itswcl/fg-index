import type { Request, Response } from "express";
import { WebhookConfigSchema, type WebhookConfig } from "@shared/types";
import { prisma } from "../services/db.js";
import { HttpError, handleError } from "../errors/httpError.js";
import { deliverWebhook } from "../services/webhookDelivery.js";

// ─── Row ⇄ WebhookConfig mapping ─────────────────────────────────
// DB row is flat (type/url/botToken/chatId), the API/shared-types shape is a
// discriminated union. Map in both directions.

interface WebhookRow {
  userId: string;
  type: string;
  url: string | null;
  botToken: string | null;
  chatId: string | null;
  updatedAt: Date;
}

function rowToConfig(row: WebhookRow): WebhookConfig | null {
  if (row.type === "discord" && row.url) return { type: "discord", url: row.url };
  if (row.type === "slack" && row.url) return { type: "slack", url: row.url };
  if (row.type === "telegram" && row.botToken && row.chatId) {
    return { type: "telegram", botToken: row.botToken, chatId: row.chatId };
  }
  return null;
}

function configToRow(cfg: WebhookConfig): {
  type: string;
  url: string | null;
  botToken: string | null;
  chatId: string | null;
} {
  if (cfg.type === "telegram") {
    return { type: "telegram", url: null, botToken: cfg.botToken, chatId: cfg.chatId };
  }
  return { type: cfg.type, url: cfg.url, botToken: null, chatId: null };
}

function requireUserId(req: Request): string {
  if (!req.userId) {
    throw new HttpError(401, "Unauthenticated", "UNAUTHORIZED");
  }
  return req.userId;
}

// ─── GET /api/webhooks/me ────────────────────────────────────────
export async function getMyWebhook(req: Request, res: Response): Promise<void> {
  try {
    const userId = requireUserId(req);
    const row = await prisma.webhookConfig.findUnique({ where: { userId } });
    res.json({ webhook: row ? rowToConfig(row as WebhookRow) : null });
  } catch (err) {
    handleError(res, err);
  }
}

// ─── PUT /api/webhooks/me ────────────────────────────────────────
export async function upsertMyWebhook(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const userId = requireUserId(req);
    const parsed = WebhookConfigSchema.safeParse(req.body?.webhook);
    if (!parsed.success) {
      throw new HttpError(400, "Invalid webhook configuration", "INVALID_BODY");
    }
    const row = configToRow(parsed.data);
    const saved = await prisma.webhookConfig.upsert({
      where: { userId },
      update: row,
      create: { userId, ...row },
    });
    res.json({ webhook: rowToConfig(saved as WebhookRow) });
  } catch (err) {
    handleError(res, err);
  }
}

// ─── DELETE /api/webhooks/me ─────────────────────────────────────
export async function deleteMyWebhook(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const userId = requireUserId(req);
    await prisma.webhookConfig.deleteMany({ where: { userId } });
    res.status(204).end();
  } catch (err) {
    handleError(res, err);
  }
}

// ─── POST /api/webhooks/me/test ──────────────────────────────────
// Fires a test notification against the *saved* webhook for the caller.
// If no webhook is saved, returns 404.
export async function testMyWebhook(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const userId = requireUserId(req);
    const row = await prisma.webhookConfig.findUnique({ where: { userId } });
    const cfg = row ? rowToConfig(row as WebhookRow) : null;
    if (!cfg) {
      throw new HttpError(404, "No webhook configured", "NOT_FOUND");
    }
    try {
      await deliverWebhook(
        cfg,
        "fg-index Test",
        "Your webhook is connected! Alerts will be delivered here."
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new HttpError(502, `Delivery failed: ${msg}`, "WEBHOOK_DELIVERY_FAILED");
    }
    res.json({ ok: true });
  } catch (err) {
    handleError(res, err);
  }
}
