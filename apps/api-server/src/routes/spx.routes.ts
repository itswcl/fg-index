import { Router } from "express";
import { getSpx } from "../controllers/spx.controller.js";
import { spxRateLimiter } from "../middlewares/rateLimit.js";
import { apiKeyMiddleware } from "../middlewares/apiKey.js";

const router = Router();

router.get("/", spxRateLimiter, apiKeyMiddleware, getSpx);

export default router;
