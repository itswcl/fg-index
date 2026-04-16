import rateLimit from "express-rate-limit";

// Fear & Greed: data updates every 30 min; generous limit
export const fearGreedRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    status: 429,
    message: "Too many requests, please try again later.",
    code: "TOO_MANY_REQUESTS",
  },
});

// VIX: real-time polling backup; moderate limit
export const vixRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    status: 429,
    message: "Too many requests, please try again later.",
    code: "TOO_MANY_REQUESTS",
  },
});

// BTC: crypto trades 24/7; 30s poll — moderate limit
export const btcRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    status: 429,
    message: "Too many requests, please try again later.",
    code: "TOO_MANY_REQUESTS",
  },
});

// SPX: real-time poll like VIX — moderate limit
export const spxRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    status: 429,
    message: "Too many requests, please try again later.",
    code: "TOO_MANY_REQUESTS",
  },
});

// Custom ticker: on-demand fetch with 15s cache — tighter limit
export const tickerRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    status: 429,
    message: "Too many requests, please try again later.",
    code: "TOO_MANY_REQUESTS",
  },
});

// General API limiter (health check etc).
// Budget: ~40 req/min per IP. Signed-in sessions hit /api/alerts and
// /api/webhooks/me on mount + every save/edit, so 100/15min was far too
// tight and produced spurious 429s during normal use. Per-endpoint
// limiters (ticker, webhook/test) still enforce stricter caps where the
// abuse surface is real.
export const globalRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    status: 429,
    message: "Too many requests, please try again later.",
    code: "TOO_MANY_REQUESTS",
  },
});

export const MAX_WS_CONNECTIONS = 50;
