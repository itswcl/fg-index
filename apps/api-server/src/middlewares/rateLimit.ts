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

// General API limiter (health check etc)
export const globalRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    status: 429,
    message: "Too many requests, please try again later.",
    code: "TOO_MANY_REQUESTS",
  },
});

export const MAX_WS_CONNECTIONS = 50;
