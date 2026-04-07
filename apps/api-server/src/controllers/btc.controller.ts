import { Request, Response } from "express";
import { getCachedBtc } from "../schedulers/btc.scheduler.js";
import { handleError } from "../errors/httpError.js";

export const getBtc = (req: Request, res: Response) => {
  try {
    const data = getCachedBtc();
    res.setHeader("Cache-Control", "public, max-age=30");
    res.json(data);
  } catch (error) {
    handleError(res, error);
  }
};
