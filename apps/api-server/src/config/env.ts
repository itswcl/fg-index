import { z } from "zod";
import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });

const envSchema = z.object({
  CNN_FEAR_GREED_URL: z.string().url(),
  GOOGLE_FINANCE_VIX_URL: z.string().url(),
  YAHOO_FINANCE_VIX_URL: z.string().url(),
  GOOGLE_FINANCE_BTC_URL: z.string().url(),
  YAHOO_FINANCE_BTC_URL: z.string().url(),
  GOOGLE_FINANCE_SPX_URL: z.string().url(),
  YAHOO_FINANCE_SPX_URL: z.string().url(),
  SCRAPER_USER_AGENT: z.string(),
  PORT: z.string().transform(Number).default("8080"),
  FEAR_GREED_INTERVAL_MS: z.string().transform(Number).default("1800000"),
  VIX_REALTIME_INTERVAL_MS: z.string().transform(Number).default("10000"),
  VIX_FALLBACK_INTERVAL_MS: z.string().transform(Number).default("300000"),
  BTC_INTERVAL_MS: z.string().transform(Number).default("60000"),
  SPX_INTERVAL_MS: z.string().transform(Number).default("10000"),
  CORS_ORIGIN: z.string().default("*"),
  INTERNAL_API_KEY: z.string().default("dev-key-123"),
  // Supabase / Postgres — Feature 6 persistence
  DATABASE_URL: z.string().url(),
  DIRECT_URL: z.string().url(),
  SUPABASE_URL: z.string().url(),
  SUPABASE_JWKS_URL: z.string().url(),
});

export const env = envSchema.parse(process.env);
