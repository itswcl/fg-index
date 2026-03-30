import { Request, Response } from "express";
import { getCachedVix } from "../schedulers/vix.scheduler.js";
import { handleError } from "../errors/httpError.js";

export const getVix = (req: Request, res: Response) => {
  try {
    const data = getCachedVix();
    res.setHeader("Cache-Control", "public, max-age=300");
    res.json(data);
  } catch (error) {
    handleError(res, error);
  }
};
