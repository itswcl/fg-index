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
});

// ─── VIX ──────────────────────────────────────────────────────────
export const VixSchema = z.object({
  price: z.number().positive(),
  previousClose: z.number().positive(),
  change: z.number(),
  changePercent: z.number(),
  fetchedAt: z.string().datetime({ offset: true }), // ISO 8601, set by our server
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

// ─── Alerts ────────────────────────────────────────────────────────
export const ConditionSchema = z.object({
  metric: z.enum(["fearGreed", "vix"]),
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
