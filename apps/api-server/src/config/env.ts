import { z } from "zod";
import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });

const DEVELOPMENT_INTERNAL_API_KEY = "dev-key-123";

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
  HOST: z.string().default("0.0.0.0"),
  SCHEDULERS_ENABLED: z.enum(["true", "false"]).default("true").transform((value) => value === "true"),
  FEAR_GREED_INTERVAL_MS: z.string().transform(Number).default("1800000"),
  VIX_REALTIME_INTERVAL_MS: z.string().transform(Number).default("10000"),
  VIX_FALLBACK_INTERVAL_MS: z.string().transform(Number).default("300000"),
  BTC_INTERVAL_MS: z.string().transform(Number).default("60000"),
  SPX_INTERVAL_MS: z.string().transform(Number).default("10000"),
  QUOTE_REFRESH_INTERVAL_MS: z.string().transform(Number).default("30000"),
  QUOTE_REFRESH_CONCURRENCY: z.string().transform(Number).default("2"),
  QUOTE_REFRESH_SPACING_MS: z.string().transform(Number).default("3000"),
  QUOTE_STOCK_CACHE_TTL_MS: z.string().transform(Number).default("60000"),
  QUOTE_MEMORY_CACHE_TTL_MS: z.string().transform(Number).default("120000"),
  QUOTE_NULL_CACHE_TTL_MS: z.string().transform(Number).default("120000"),
  ACTIVE_SYMBOL_CACHE_TTL_MS: z.string().transform(Number).default("300000"),
  QUOTE_REFRESH_FAILURE_COOLDOWN_MS: z.string().transform(Number).default("60000"),
  ALERT_CANDIDATE_CACHE_TTL_MS: z.string().transform(Number).default("300000"),
  BACKGROUND_DB_FAILURE_COOLDOWN_MS: z.string().transform(Number).default("60000"),
  QUOTE_FETCH_TIMEOUT_MS: z.string().transform(Number).default("5000"),
  QUOTE_PRICE_SANITY_MAX_MOVE_PERCENT: z.string().transform(Number).default("100"),
  AUTH_USER_UPSERT_TTL_MS: z.string().transform(Number).default("300000"),
  MASSIVE_API_KEY: z.string().default(""),
  MASSIVE_MARKET_STATUS_URL: z
    .string()
    .url()
    .default("https://api.massive.com/v1/marketstatus/now"),
  MARKET_STATUS_REFRESH_ENABLED: z
    .string()
    .transform((value) => value !== "false")
    .default("true"),
  CORS_ORIGIN: z.string().default("*"),
  INTERNAL_API_KEY: z.string().default(DEVELOPMENT_INTERNAL_API_KEY),
  // Supabase / Postgres — Feature 6 persistence
  DATABASE_URL: z.string().url(),
  DIRECT_URL: z.string().url(),
  SUPABASE_URL: z.string().url(),
  SUPABASE_JWKS_URL: z.string().url(),
});

export function parseEnv(source: NodeJS.ProcessEnv = process.env) {
  const parsed = envSchema.parse(source);
  if (source.NODE_ENV === "production" && parsed.INTERNAL_API_KEY === DEVELOPMENT_INTERNAL_API_KEY) {
    throw new Error("INTERNAL_API_KEY must be set to a non-default value in production");
  }
  return parsed;
}

export const env = parseEnv(process.env);
