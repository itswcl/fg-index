import { Router } from "express";
import { getFearGreed } from "../controllers/fear-greed.controller.js";
import { fearGreedRateLimiter } from "../middlewares/rateLimit.js";
import { apiKeyMiddleware } from "../middlewares/apiKey.js";

const router = Router();

router.get("/", fearGreedRateLimiter, apiKeyMiddleware, getFearGreed);

export default router;
