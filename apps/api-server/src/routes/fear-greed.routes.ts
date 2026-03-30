import { Router } from "express";
import { getFearGreed } from "../controllers/fear-greed.controller.js";

const router = Router();

router.get("/", getFearGreed);

export default router;
