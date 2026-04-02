import type { Request, Response } from "express";
import { WebhookConfigSchema } from "@shared/types";
import { deliverWebhook } from "../services/webhookDelivery.js";

export async function testWebhook(req: Request, res: Response): Promise<void> {
  const result = WebhookConfigSchema.safeParse(req.body?.webhook);
  if (!result.success) {
    res.status(400).json({ ok: false, error: "Invalid webhook configuration" });
    return;
  }

  try {
    await deliverWebhook(result.data, "fg-index Test", "Your webhook is connected! Alerts will be delivered here.");
    res.json({ ok: true });
  } catch (err: unknown) {
    res.status(502).json({ ok: false, error: String(err) });
  }
}
