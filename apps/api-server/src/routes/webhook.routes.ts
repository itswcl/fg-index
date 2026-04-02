import { Router } from "express";
import rateLimit from "express-rate-limit";
import { testWebhook } from "../controllers/webhook.controller.js";
import { apiKeyMiddleware } from "../middlewares/apiKey.js";

const webhookTestRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    status: 429,
    message: "Too many requests, please try again later.",
    code: "TOO_MANY_REQUESTS",
  },
});

const router = Router();

router.post("/test", webhookTestRateLimiter, apiKeyMiddleware, testWebhook);

export default router;
