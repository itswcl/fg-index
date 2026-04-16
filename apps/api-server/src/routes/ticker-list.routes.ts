import { Router } from "express";
import { authMiddleware } from "../middlewares/auth.js";
import {
  listTickers,
  addTicker,
  deleteTicker,
  bulkReplaceTickers,
} from "../controllers/ticker-list.controller.js";

const router = Router();

// All user-ticker routes require an authenticated user.
router.use(authMiddleware);

router.get("/", listTickers);
router.post("/", addTicker);
router.put("/", bulkReplaceTickers);
router.delete("/:symbol", deleteTicker);

export default router;
