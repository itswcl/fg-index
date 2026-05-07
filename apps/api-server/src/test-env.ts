const defaults: Record<string, string> = {
  CNN_FEAR_GREED_URL: "https://example.com/fear-greed",
  GOOGLE_FINANCE_VIX_URL: "https://example.com/vix",
  YAHOO_FINANCE_VIX_URL: "https://example.com/vix-yahoo",
  GOOGLE_FINANCE_BTC_URL: "https://example.com/btc",
  YAHOO_FINANCE_BTC_URL: "https://example.com/btc-yahoo",
  GOOGLE_FINANCE_SPX_URL: "https://example.com/spx",
  YAHOO_FINANCE_SPX_URL: "https://example.com/spx-yahoo",
  SCRAPER_USER_AGENT: "test-agent",
  PORT: "8080",
  FEAR_GREED_INTERVAL_MS: "1800000",
  VIX_REALTIME_INTERVAL_MS: "10000",
  VIX_FALLBACK_INTERVAL_MS: "300000",
  BTC_INTERVAL_MS: "60000",
  SPX_INTERVAL_MS: "10000",
  QUOTE_REFRESH_INTERVAL_MS: "10000",
  QUOTE_REFRESH_CONCURRENCY: "4",
  QUOTE_REFRESH_FAILURE_COOLDOWN_MS: "60000",
  BACKGROUND_DB_FAILURE_COOLDOWN_MS: "60000",
  CORS_ORIGIN: "*",
  INTERNAL_API_KEY: "test-key",
  DATABASE_URL: "https://example.com/db",
  DIRECT_URL: "https://example.com/direct",
  SUPABASE_URL: "https://example.com/supabase",
  SUPABASE_JWKS_URL: "https://example.com/jwks",
};

for (const [key, value] of Object.entries(defaults)) {
  process.env[key] ??= value;
}
