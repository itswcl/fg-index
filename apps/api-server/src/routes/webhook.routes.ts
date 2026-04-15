import { Router } from "express";
import rateLimit from "express-rate-limit";
import { testWebhook } from "../controllers/webhook.controller.js";
import {
  getMyWebhook,
  upsertMyWebhook,
  deleteMyWebhook,
  testMyWebhook,
} from "../controllers/webhookConfig.controller.js";
import { apiKeyMiddleware } from "../middlewares/apiKey.js";
import { authMiddleware } from "../middlewares/auth.js";

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

// Legacy ad-hoc test endpoint (apiKey-gated) — kept for internal/dev usage.
router.post("/test", webhookTestRateLimiter, apiKeyMiddleware, testWebhook);

// Per-user persistent webhook config (JWT-gated, Feature 6).
router.get("/me", authMiddleware, getMyWebhook);
router.put("/me", authMiddleware, upsertMyWebhook);
router.delete("/me", authMiddleware, deleteMyWebhook);
router.post("/me/test", webhookTestRateLimiter, authMiddleware, testMyWebhook);

export default router;
