import { Router } from "express";
import { getTicker, getBatchQuotes } from "../controllers/ticker.controller.js";
import { tickerRateLimiter } from "../middlewares/rateLimit.js";
import { apiKeyMiddleware } from "../middlewares/apiKey.js";

const router = Router();

// Order matters: /batch must be registered before /:ticker so the
// param route doesn't consume the literal "batch" path segment.
router.get("/batch", tickerRateLimiter, apiKeyMiddleware, getBatchQuotes);
router.get("/:ticker", tickerRateLimiter, apiKeyMiddleware, getTicker);

export default router;
