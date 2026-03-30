import { Request, Response, NextFunction } from "express";
import { env } from "../config/env.js";
import { HttpError, handleError } from "../errors/httpError.js";

/**
 * Middleware to validate the X-API-KEY header.
 */
export function apiKeyMiddleware(req: Request, res: Response, next: NextFunction) {
  try {
    const apiKey = req.header("X-API-KEY");

    if (!apiKey || apiKey !== env.INTERNAL_API_KEY) {
      throw new HttpError(401, "Invalid or missing API Key", "UNAUTHORIZED");
    }

    next();
  } catch (error) {
    handleError(res, error);
  }
}
