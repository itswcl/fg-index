import { Request, Response } from "express";
import { getCachedFearGreed } from "../schedulers/fear-greed.scheduler.js";
import { handleError, HttpError } from "../errors/httpError.js";

export const getFearGreed = (req: Request, res: Response) => {
  try {
    const data = getCachedFearGreed();
    if (!data) {
      throw new HttpError(404, "Fear & Greed data not ready", "DATA_NOT_READY");
    }
    res.setHeader("Cache-Control", "public, max-age=1800");
    res.json(data);
  } catch (error) {
    handleError(res, error);
  }
};
