import { Request, Response } from "express";
import { fetchTickerQuote } from "../services/ticker.service.js";

const TICKER_REGEX = /^[A-Za-z0-9:.\-^=_]{1,20}$/;

export async function getTicker(req: Request, res: Response): Promise<void> {
  const { ticker } = req.params;

  if (!TICKER_REGEX.test(ticker)) {
    res.status(400).json({
      status: 400,
      message: "Invalid ticker format.",
      code: "INVALID_TICKER",
    });
    return;
  }

  const data = await fetchTickerQuote(ticker);

  if (!data) {
    res.status(404).json({
      status: 404,
      message: `Ticker "${ticker.toUpperCase()}" not found.`,
      code: "TICKER_NOT_FOUND",
    });
    return;
  }

  res.set("Cache-Control", "public, max-age=15");
  res.json(data);
}
