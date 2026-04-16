import { Router } from "express";
import { authMiddleware } from "../middlewares/auth.js";
import {
  getPreferences,
  updatePreferences,
} from "../controllers/user.controller.js";

const router = Router();

router.use(authMiddleware);

router.get("/preferences", getPreferences);
router.put("/preferences", updatePreferences);

export default router;
