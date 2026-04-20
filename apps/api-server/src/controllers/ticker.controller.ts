import { Request, Response } from "express";
import type { TickerQuote } from "@shared/types";
import { fetchTickerQuote } from "../services/ticker.service.js";

const TICKER_REGEX = /^[A-Za-z0-9:.\-^=_]{1,20}$/;
const MAX_BATCH_SYMBOLS = 12;

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

// ─── GET /api/quote/batch?symbols=A,B,C ───────────────────────────
// Fans out to fetchTickerQuote for each symbol (deduped, upper-cased,
// capped at MAX_BATCH_SYMBOLS) via Promise.allSettled so one bad
// scrape doesn't poison the rest. Returns { quotes: { SYM: quote|null } }.
export async function getBatchQuotes(
  req: Request,
  res: Response
): Promise<void> {
  const raw = req.query.symbols;
  if (typeof raw !== "string" || raw.trim() === "") {
    res.status(400).json({
      status: 400,
      message: "Missing or invalid 'symbols' query parameter.",
      code: "INVALID_QUERY",
    });
    return;
  }

  // Split, trim, upper-case, drop empties, dedupe while preserving order.
  const seen = new Set<string>();
  const symbols: string[] = [];
  for (const part of raw.split(",")) {
    const s = part.trim().toUpperCase();
    if (!s) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    symbols.push(s);
  }

  if (symbols.length === 0) {
    res.status(400).json({
      status: 400,
      message: "No valid symbols provided.",
      code: "INVALID_QUERY",
    });
    return;
  }

  if (symbols.length > MAX_BATCH_SYMBOLS) {
    res.status(400).json({
      status: 400,
      message: `Too many symbols — max ${MAX_BATCH_SYMBOLS} per batch.`,
      code: "BATCH_LIMIT",
    });
    return;
  }

  for (const s of symbols) {
    if (!TICKER_REGEX.test(s)) {
      res.status(400).json({
        status: 400,
        message: `Invalid ticker format: "${s}".`,
        code: "INVALID_TICKER",
      });
      return;
    }
  }

  const results = await Promise.allSettled(
    symbols.map((sym) => fetchTickerQuote(sym))
  );

  const quotes: Record<string, TickerQuote | null> = {};
  for (let i = 0; i < symbols.length; i++) {
    const r = results[i];
    quotes[symbols[i]] = r.status === "fulfilled" ? r.value : null;
  }

  res.set("Cache-Control", "public, max-age=15");
  res.json({ quotes });
}
