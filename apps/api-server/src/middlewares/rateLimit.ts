import rateLimit from "express-rate-limit";

const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;
const DASHBOARD_READ_MAX_PER_15_MIN = 240;

// Cached dashboard reads: allow 5s frontend polling plus reload/headroom.
export const fearGreedRateLimiter = rateLimit({
  windowMs: FIFTEEN_MINUTES_MS,
  max: DASHBOARD_READ_MAX_PER_15_MIN,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    status: 429,
    message: "Too many requests, please try again later.",
    code: "TOO_MANY_REQUESTS",
  },
});

// VIX: cached real-time polling backup.
export const vixRateLimiter = rateLimit({
  windowMs: FIFTEEN_MINUTES_MS,
  max: DASHBOARD_READ_MAX_PER_15_MIN,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    status: 429,
    message: "Too many requests, please try again later.",
    code: "TOO_MANY_REQUESTS",
  },
});

// BTC: crypto trades 24/7; cached read endpoint.
export const btcRateLimiter = rateLimit({
  windowMs: FIFTEEN_MINUTES_MS,
  max: DASHBOARD_READ_MAX_PER_15_MIN,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    status: 429,
    message: "Too many requests, please try again later.",
    code: "TOO_MANY_REQUESTS",
  },
});

// SPX: cached real-time read endpoint.
export const spxRateLimiter = rateLimit({
  windowMs: FIFTEEN_MINUTES_MS,
  max: DASHBOARD_READ_MAX_PER_15_MIN,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    status: 429,
    message: "Too many requests, please try again later.",
    code: "TOO_MANY_REQUESTS",
  },
});

// Custom ticker: cached read endpoint with background refresh.
export const tickerRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    status: 429,
    message: "Too many requests, please try again later.",
    code: "TOO_MANY_REQUESTS",
  },
});

// General API limiter (health check etc).
// Budget: ~160 req/min per IP. This leaves headroom for the web app to poll
// cached dashboard reads every 5s while signed-in sessions also hit user,
// alert, and webhook endpoints. Per-endpoint limiters still enforce stricter
// caps where the abuse surface is real.
export const globalRateLimiter = rateLimit({
  windowMs: FIFTEEN_MINUTES_MS,
  max: 2400,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    status: 429,
    message: "Too many requests, please try again later.",
    code: "TOO_MANY_REQUESTS",
  },
});

export const MAX_WS_CONNECTIONS = 50;
