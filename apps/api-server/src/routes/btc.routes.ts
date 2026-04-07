import { Router } from "express";
import { getBtc } from "../controllers/btc.controller.js";
import { btcRateLimiter } from "../middlewares/rateLimit.js";
import { apiKeyMiddleware } from "../middlewares/apiKey.js";

const router = Router();

router.get("/", btcRateLimiter, apiKeyMiddleware, getBtc);

export default router;
