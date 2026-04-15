import { Router } from "express";
import { authMiddleware } from "../middlewares/auth.js";
import {
  listAlerts,
  createAlert,
  updateAlert,
  deleteAlert,
  bulkReplaceAlerts,
} from "../controllers/alerts.controller.js";

const router = Router();

// All alert routes require an authenticated user.
router.use(authMiddleware);

router.get("/", listAlerts);
router.post("/", createAlert);
router.post("/bulk", bulkReplaceAlerts);
router.put("/:id", updateAlert);
router.delete("/:id", deleteAlert);

export default router;
