import { Request, Response } from "express";
import { getCachedSpx } from "../schedulers/spx.scheduler.js";
import { handleError } from "../errors/httpError.js";

export const getSpx = (req: Request, res: Response) => {
  try {
    const data = getCachedSpx();
    res.setHeader("Cache-Control", "public, max-age=10, stale-while-revalidate=20");
    res.json(data);
  } catch (error) {
    handleError(res, error);
  }
};
