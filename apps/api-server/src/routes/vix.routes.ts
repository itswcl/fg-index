import { Router } from "express";
import { getVix } from "../controllers/vix.controller.js";
import { vixRateLimiter } from "../middlewares/rateLimit.js";
import { apiKeyMiddleware } from "../middlewares/apiKey.js";

const router = Router();

router.get("/", vixRateLimiter, apiKeyMiddleware, getVix);

export default router;
