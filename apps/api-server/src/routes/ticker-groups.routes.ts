import { Router } from "express";
import { authMiddleware } from "../middlewares/auth.js";
import {
  addGroupTicker,
  createGroup,
  deleteGroup,
  deleteGroupTicker,
  listGroups,
  migrateGroups,
  renameGroup,
  reorderGroups,
  replaceGroupTickerList,
} from "../controllers/ticker-groups.controller.js";

const router = Router();

router.use(authMiddleware);

router.get("/", listGroups);
router.post("/", createGroup);
router.put("/reorder", reorderGroups);
router.put("/migration", migrateGroups);
router.put("/:groupId", renameGroup);
router.delete("/:groupId", deleteGroup);
router.post("/:groupId/tickers", addGroupTicker);
router.put("/:groupId/tickers", replaceGroupTickerList);
router.delete("/:groupId/tickers/:symbol", deleteGroupTicker);

export default router;
