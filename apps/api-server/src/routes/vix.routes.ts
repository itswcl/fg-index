import { Router } from "express";
import { getVix } from "../controllers/vix.controller.js";

const router = Router();

router.get("/", getVix);

export default router;
