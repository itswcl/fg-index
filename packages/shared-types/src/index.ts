import { z } from "zod";

// ─── Fear & Greed ─────────────────────────────────────────────────
export const FearGreedClassificationSchema = z.enum([
  "Extreme Fear",
  "Fear",
  "Neutral",
  "Greed",
  "Extreme Greed",
]);

export const FearGreedSchema = z.object({
  score: z.number().min(0).max(100),
  classification: FearGreedClassificationSchema,
  previousClose: z.number().min(0).max(100),
  oneWeekAgo: z.number().min(0).max(100),
  oneMonthAgo: z.number().min(0).max(100),
  oneYearAgo: z.number().min(0).max(100),
  updatedAt: z.string().datetime({ offset: true }), // ISO 8601 from CNN
  // Public user-facing page for the Fear & Greed index (not the
  // internal JSON endpoint we scrape from). Lets the UI link through.
  sourceUrl: z.string().url().optional(),
});

// ─── VIX ──────────────────────────────────────────────────────────
export const VixSchema = z.object({
  price: z.number().positive(),
  previousClose: z.number().positive(),
  change: z.number(),
  changePercent: z.number(),
  fetchedAt: z.string().datetime({ offset: true }), // ISO 8601, set by our server
  // Public URL of the source page the price was scraped from
  // (Google Finance VIX:INDEXCBOE primary, Yahoo ^VIX fallback).
  sourceUrl: z.string().url().optional(),
});

// ─── Combined response ─────────────────────────────────────────────
export const MarketIndicatorsSchema = z.object({
  fearGreed: FearGreedSchema,
  vix: VixSchema.nullable(),
});

// ─── Inferred TypeScript types ─────────────────────────────────────
export type FearGreedClassification = z.infer<
  typeof FearGreedClassificationSchema
>;
export type FearGreed = z.infer<typeof FearGreedSchema>;
export type Vix = z.infer<typeof VixSchema>;
export type MarketIndicators = z.infer<typeof MarketIndicatorsSchema>;

// ─── BTC ──────────────────────────────────────────────────────────
export const BtcSchema = z.object({
  price: z.number().positive(),
  change: z.number(),
  changePercent: z.number(),
  fetchedAt: z.string().datetime({ offset: true }), // ISO 8601, set by our server
  // Public URL of the source page the price was scraped from
  // (Google Finance BTC-USD primary, Yahoo BTC-USD fallback).
  sourceUrl: z.string().url().optional(),
});

export type Btc = z.infer<typeof BtcSchema>;

// ─── SPX ──────────────────────────────────────────────────────────
export const SpxSchema = z.object({
  price: z.number().positive(),
  previousClose: z.number().positive(),
  change: z.number(),
  changePercent: z.number(),
  fetchedAt: z.string().datetime({ offset: true }), // ISO 8601, set by our server
  // Public URL of the source page the price was scraped from
  // (Google Finance .INX:INDEXSP primary, Yahoo ^GSPC fallback).
  sourceUrl: z.string().url().optional(),
});

export type Spx = z.infer<typeof SpxSchema>;

// ─── Ticker Quote ─────────────────────────────────────────────────
export const TickerQuoteSchema = z.object({
  ticker: z.string(),
  name: z.string().optional(),
  price: z.number().positive(),
  previousClose: z.number().positive(),
  change: z.number(),
  changePercent: z.number(),
  fetchedAt: z.string().datetime({ offset: true }),
  // Public URL of the source page the price was scraped from
  // (Google Finance or Yahoo Finance). Lets the UI link through so
  // users can verify the quote. Optional — older cache entries or
  // future data sources may not populate it.
  sourceUrl: z.string().url().optional(),
});

export type TickerQuote = z.infer<typeof TickerQuoteSchema>;

// ─── Alerts ────────────────────────────────────────────────────────
export const ConditionSchema = z.object({
  metric: z.enum(["fearGreed", "vix", "btc", "spx"]),
  operator: z.enum(["<", ">", "<=", ">=", "=="]),
  value: z.number(),
});
export type Condition = z.infer<typeof ConditionSchema>;

export const AlertSchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(80),
  conditions: z.array(ConditionSchema).min(1).max(10),
  logic: z.enum(["AND", "OR"]),
  enabled: z.boolean(),
  createdAt: z.string(),
  lastTriggeredAt: z.string().optional(),
});
export type Alert = z.infer<typeof AlertSchema>;

export const SetAlertsMessageSchema = z.object({
  type: z.literal("set_alerts"),
  alerts: z.array(AlertSchema),
});
export type SetAlertsMessage = z.infer<typeof SetAlertsMessageSchema>;

export const AlertTriggeredMessageSchema = z.object({
  type: z.literal("alert_triggered"),
  alertId: z.string(),
  alertName: z.string(),
  message: z.string(),
  triggeredAt: z.string(),
});
export type AlertTriggeredMessage = z.infer<typeof AlertTriggeredMessageSchema>;

// ─── Webhook delivery payload (discriminated by type) ──────────────
// Used by the delivery service. Represents the minimum fields needed
// to fire a message at a given destination.
export const WebhookConfigSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("discord"),
    url: z.string().url(),
  }),
  z.object({
    type: z.literal("slack"),
    url: z.string().url(),
  }),
  z.object({
    type: z.literal("telegram"),
    botToken: z.string().min(1),
    chatId: z.string().min(1),
  }),
  z.object({
    type: z.literal("generic"),
    url: z.string().url(),
  }),
]);
export type WebhookConfig = z.infer<typeof WebhookConfigSchema>;

// ─── Persistent Webhook (N-per-user) ───────────────────────────────
// What the UI sees and what the DB stores (minus server-managed fields).
// Ids/timestamps are produced by the server; the input schema on create/
// update strips them out.
export const WebhookTypeSchema = z.enum([
  "discord",
  "slack",
  "telegram",
  "generic",
]);
export type WebhookType = z.infer<typeof WebhookTypeSchema>;

export const WebhookSchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(60),
  type: WebhookTypeSchema,
  url: z.string().url().nullable(),
  botToken: z.string().min(1).nullable(),
  chatId: z.string().min(1).nullable(),
  enabled: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Webhook = z.infer<typeof WebhookSchema>;

// Input shape for create / update. Refinements validate shape-per-type:
// discord/slack/generic need a URL, telegram needs botToken + chatId.
export const WebhookInputSchema = z
  .object({
    name: z.string().min(1).max(60),
    type: WebhookTypeSchema,
    url: z.string().url().optional().nullable(),
    botToken: z.string().min(1).optional().nullable(),
    chatId: z.string().min(1).optional().nullable(),
    enabled: z.boolean().optional(),
  })
  .superRefine((val, ctx) => {
    if (val.type === "telegram") {
      if (!val.botToken) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["botToken"],
          message: "botToken is required for telegram",
        });
      }
      if (!val.chatId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["chatId"],
          message: "chatId is required for telegram",
        });
      }
    } else {
      if (!val.url) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["url"],
          message: `url is required for ${val.type}`,
        });
      }
    }
  });
export type WebhookInput = z.infer<typeof WebhookInputSchema>;

export const SetWebhookMessageSchema = z.object({
  type: z.literal("set_webhook"),
  webhook: WebhookConfigSchema.nullable(), // null = remove webhook
});
export type SetWebhookMessage = z.infer<typeof SetWebhookMessageSchema>;
