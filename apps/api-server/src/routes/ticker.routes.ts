import { Router } from "express";
import { getTicker } from "../controllers/ticker.controller.js";
import { tickerRateLimiter } from "../middlewares/rateLimit.js";
import { apiKeyMiddleware } from "../middlewares/apiKey.js";

const router = Router();

router.get("/:ticker", tickerRateLimiter, apiKeyMiddleware, getTicker);

export default router;
