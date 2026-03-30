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
