import type { Request, Response } from "express";
import { WebhookConfigSchema, type WebhookConfig } from "@shared/types";
import { prisma } from "../services/db.js";
import { HttpError, handleError } from "../errors/httpError.js";
import { deliverWebhook } from "../services/webhookDelivery.js";
import { rowToWebhookConfig } from "./webhooks.controller.js";

// ─── Legacy alias controller ─────────────────────────────────────
// The old single-webhook UI (and any external callers) hit
// /api/webhooks/me*. We now store N rows per user, so "the user's
// webhook" is no longer a well-defined thing. We keep these endpoints
// alive by mapping them to the user's *first* (oldest) webhook row,
// which is what the data-preserving migration produced as "Default".
//
// Once the FE has fully cut over to the CRUD endpoints we can delete
// this file and the routes that mount it.

interface WebhookRow {
  id: string;
  userId: string;
  name: string;
  type: string;
  url: string | null;
  botToken: string | null;
  chatId: string | null;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

function configToRowWrite(cfg: WebhookConfig): {
  type: string;
  url: string | null;
  botToken: string | null;
  chatId: string | null;
} {
  if (cfg.type === "telegram") {
    return {
      type: "telegram",
      url: null,
      botToken: cfg.botToken,
      chatId: cfg.chatId,
    };
  }
  return { type: cfg.type, url: cfg.url, botToken: null, chatId: null };
}

function requireUserId(req: Request): string {
  if (!req.userId) {
    throw new HttpError(401, "Unauthenticated", "UNAUTHORIZED");
  }
  return req.userId;
}

async function firstWebhook(userId: string): Promise<WebhookRow | null> {
  const row = await prisma.webhook.findFirst({
    where: { userId },
    orderBy: { createdAt: "asc" },
  });
  return (row as WebhookRow | null) ?? null;
}

// ─── GET /api/webhooks/me ────────────────────────────────────────
export async function getMyWebhook(req: Request, res: Response): Promise<void> {
  try {
    const userId = requireUserId(req);
    const row = await firstWebhook(userId);
    res.json({ webhook: row ? rowToWebhookConfig(row) : null });
  } catch (err) {
    handleError(res, err);
  }
}

// ─── PUT /api/webhooks/me ────────────────────────────────────────
// Upsert semantics on the *first* webhook row. If none exists, create
// one named "Default"; otherwise overwrite the oldest row in place.
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
    const data = configToRowWrite(parsed.data);
    const existing = await firstWebhook(userId);
    let saved: WebhookRow;
    if (existing) {
      saved = (await prisma.webhook.update({
        where: { id: existing.id },
        data,
      })) as WebhookRow;
    } else {
      saved = (await prisma.webhook.create({
        data: { userId, name: "Default", enabled: true, ...data },
      })) as WebhookRow;
    }
    res.json({ webhook: rowToWebhookConfig(saved) });
  } catch (err) {
    handleError(res, err);
  }
}

// ─── DELETE /api/webhooks/me ─────────────────────────────────────
// Legacy semantics: "remove my webhook." With N-per-user that's
// ambiguous; we delete *all* of the caller's webhooks so the legacy
// UI's "off" toggle still leaves the account in a clean state.
export async function deleteMyWebhook(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const userId = requireUserId(req);
    await prisma.webhook.deleteMany({ where: { userId } });
    res.status(204).end();
  } catch (err) {
    handleError(res, err);
  }
}

// ─── POST /api/webhooks/me/test ──────────────────────────────────
// Fires a test notification against the *first* saved webhook for the
// caller. If no webhook is saved, returns 404.
export async function testMyWebhook(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const userId = requireUserId(req);
    const row = await firstWebhook(userId);
    const cfg = row ? rowToWebhookConfig(row) : null;
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
      throw new HttpError(
        502,
        `Delivery failed: ${msg}`,
        "WEBHOOK_DELIVERY_FAILED"
      );
    }
    res.json({ ok: true });
  } catch (err) {
    handleError(res, err);
  }
}
