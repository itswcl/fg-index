/**
 * Multi-webhook contract.
 *
 * Mirrors the shape returned by the upcoming `feat/multi-webhooks-api` BE PR:
 *   GET    /api/webhooks           → Webhook[]
 *   POST   /api/webhooks           → Webhook
 *   PUT    /api/webhooks/:id       → Webhook
 *   DELETE /api/webhooks/:id       → 204
 *   POST   /api/webhooks/:id/test  → { ok: boolean; error?: string }
 *
 * TODO(backend-contract): once the BE PR lands, align this with whatever the
 * server actually returns (especially timestamp formats) and move the canonical
 * type to `@shared/types` instead of duplicating it here.
 */

export type WebhookType = 'discord' | 'slack' | 'telegram' | 'generic';

/** Server-cap on number of webhooks per user; matches the BE config. */
export const MAX_WEBHOOKS = 10;

export interface Webhook {
  id: string;
  name: string;
  type: WebhookType;
  /** Present for discord / slack / generic. */
  url?: string;
  /** Present for telegram only. */
  botToken?: string;
  /** Present for telegram only. */
  chatId?: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Payload shape for POST /api/webhooks. */
export type CreateWebhookInput = Omit<Webhook, 'id' | 'createdAt' | 'updatedAt'>;

/** Payload shape for PUT /api/webhooks/:id. All fields optional. */
export type UpdateWebhookInput = Partial<CreateWebhookInput>;
