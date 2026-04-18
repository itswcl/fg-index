import type { Request, Response } from "express";
import {
  WebhookInputSchema,
  type Webhook,
  type WebhookConfig,
  type WebhookInput,
} from "@shared/types";
import { prisma } from "../services/db.js";
import { HttpError, handleError } from "../errors/httpError.js";
import { deliverWebhook } from "../services/webhookDelivery.js";

// Per-user cap. Keep in sync with any UI-level hint.
export const MAX_WEBHOOKS_PER_USER = 10;

// ─── Row ⇄ API shape ─────────────────────────────────────────────
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

export function rowToWebhook(row: WebhookRow): Webhook {
  return {
    id: row.id,
    name: row.name,
    type: row.type as Webhook["type"],
    url: row.url,
    botToken: row.botToken,
    chatId: row.chatId,
    enabled: row.enabled,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// Map a stored row into the delivery-payload union consumed by
// `deliverWebhook`. Returns null when the row is malformed (missing
// the fields required for its type) — defensive, shouldn't occur for
// rows created through the validated API.
export function rowToWebhookConfig(
  row: Pick<WebhookRow, "type" | "url" | "botToken" | "chatId">
): WebhookConfig | null {
  if (row.type === "discord" && row.url) return { type: "discord", url: row.url };
  if (row.type === "slack" && row.url) return { type: "slack", url: row.url };
  if (row.type === "generic" && row.url) return { type: "generic", url: row.url };
  if (row.type === "telegram" && row.botToken && row.chatId) {
    return { type: "telegram", botToken: row.botToken, chatId: row.chatId };
  }
  return null;
}

function inputToRowWrite(input: WebhookInput): {
  name: string;
  type: string;
  url: string | null;
  botToken: string | null;
  chatId: string | null;
  enabled: boolean;
} {
  if (input.type === "telegram") {
    return {
      name: input.name,
      type: "telegram",
      url: null,
      botToken: input.botToken ?? null,
      chatId: input.chatId ?? null,
      enabled: input.enabled ?? true,
    };
  }
  return {
    name: input.name,
    type: input.type,
    url: input.url ?? null,
    botToken: null,
    chatId: null,
    enabled: input.enabled ?? true,
  };
}

function requireUserId(req: Request): string {
  if (!req.userId) {
    throw new HttpError(401, "Unauthenticated", "UNAUTHORIZED");
  }
  return req.userId;
}

function parseInput(body: unknown): WebhookInput {
  const parsed = WebhookInputSchema.safeParse(body);
  if (!parsed.success) {
    throw new HttpError(400, "Invalid webhook configuration", "INVALID_BODY");
  }
  return parsed.data;
}

// ─── GET /api/webhooks ───────────────────────────────────────────
export async function listWebhooks(req: Request, res: Response): Promise<void> {
  try {
    const userId = requireUserId(req);
    const rows = await prisma.webhook.findMany({
      where: { userId },
      orderBy: { createdAt: "asc" },
    });
    res.json({ webhooks: (rows as WebhookRow[]).map(rowToWebhook) });
  } catch (err) {
    handleError(res, err);
  }
}

// ─── POST /api/webhooks ──────────────────────────────────────────
export async function createWebhook(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const userId = requireUserId(req);
    const input = parseInput(req.body);

    // Enforce per-user cap. Use a count rather than findMany+length so we
    // don't drag the full rows back.
    const count = await prisma.webhook.count({ where: { userId } });
    if (count >= MAX_WEBHOOKS_PER_USER) {
      throw new HttpError(
        409,
        `Webhook limit reached (max ${MAX_WEBHOOKS_PER_USER})`,
        "WEBHOOK_LIMIT_REACHED"
      );
    }

    const row = await prisma.webhook.create({
      data: { userId, ...inputToRowWrite(input) },
    });
    res.status(201).json({ webhook: rowToWebhook(row as WebhookRow) });
  } catch (err) {
    handleError(res, err);
  }
}

// ─── PUT /api/webhooks/:id ───────────────────────────────────────
export async function updateWebhook(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const userId = requireUserId(req);
    const { id } = req.params;
    const input = parseInput(req.body);

    // updateMany with composite where(id, userId) so a user can only update
    // their own rows — never leaks ownership via the :id param.
    const result = await prisma.webhook.updateMany({
      where: { id, userId },
      data: inputToRowWrite(input),
    });
    if (result.count === 0) {
      throw new HttpError(404, "Webhook not found", "NOT_FOUND");
    }
    const row = await prisma.webhook.findUnique({ where: { id } });
    if (!row) {
      throw new HttpError(404, "Webhook not found", "NOT_FOUND");
    }
    res.json({ webhook: rowToWebhook(row as WebhookRow) });
  } catch (err) {
    handleError(res, err);
  }
}

// ─── DELETE /api/webhooks/:id ────────────────────────────────────
export async function deleteWebhook(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const userId = requireUserId(req);
    const { id } = req.params;

    const result = await prisma.webhook.deleteMany({
      where: { id, userId },
    });
    if (result.count === 0) {
      throw new HttpError(404, "Webhook not found", "NOT_FOUND");
    }
    res.status(204).end();
  } catch (err) {
    handleError(res, err);
  }
}

// ─── POST /api/webhooks/:id/test ─────────────────────────────────
export async function testWebhookById(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const userId = requireUserId(req);
    const { id } = req.params;

    const row = (await prisma.webhook.findFirst({
      where: { id, userId },
    })) as WebhookRow | null;
    if (!row) {
      throw new HttpError(404, "Webhook not found", "NOT_FOUND");
    }
    const cfg = rowToWebhookConfig(row);
    if (!cfg) {
      throw new HttpError(
        400,
        "Webhook is missing required fields for its type",
        "INVALID_WEBHOOK"
      );
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
