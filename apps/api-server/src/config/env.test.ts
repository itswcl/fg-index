import { describe, expect, it } from "vitest";
import { parseEnv } from "./env.js";

const requiredEnv: NodeJS.ProcessEnv = {
  CNN_FEAR_GREED_URL: "https://example.com/fear-greed",
  GOOGLE_FINANCE_VIX_URL: "https://example.com/vix",
  YAHOO_FINANCE_VIX_URL: "https://example.com/vix-yahoo",
  GOOGLE_FINANCE_BTC_URL: "https://example.com/btc",
  YAHOO_FINANCE_BTC_URL: "https://example.com/btc-yahoo",
  GOOGLE_FINANCE_SPX_URL: "https://example.com/spx",
  YAHOO_FINANCE_SPX_URL: "https://example.com/spx-yahoo",
  SCRAPER_USER_AGENT: "test-agent",
  DATABASE_URL: "postgresql://test:test@localhost:5432/test",
  DIRECT_URL: "postgresql://test:test@localhost:5432/test",
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_JWKS_URL: "https://example.supabase.co/auth/v1/.well-known/jwks.json",
};

function productionEnv(internalApiKey?: string): NodeJS.ProcessEnv {
  return {
    ...requiredEnv,
    NODE_ENV: "production",
    ...(internalApiKey === undefined ? {} : { INTERNAL_API_KEY: internalApiKey }),
  };
}

describe("API environment production safeguards", () => {
  it("rejects a missing INTERNAL_API_KEY in production instead of applying the dev bypass", () => {
    expect(() => parseEnv(productionEnv())).toThrow(/INTERNAL_API_KEY.*production/i);
  });

  it("rejects the development bypass key when explicitly set in production", () => {
    expect(() => parseEnv(productionEnv("dev-key-123"))).toThrow(
      /INTERNAL_API_KEY.*production/i,
    );
  });

  it("accepts an explicit non-default key in production", () => {
    expect(parseEnv(productionEnv("production-test-key")).INTERNAL_API_KEY).toBe(
      "production-test-key",
    );
  });

  it("preserves the development default outside production", () => {
    expect(parseEnv({ ...requiredEnv, NODE_ENV: "development" }).INTERNAL_API_KEY).toBe(
      "dev-key-123",
    );
  });
});
