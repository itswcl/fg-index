import type { Request, Response } from "express";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../services/db.js";
import { HttpError, handleError } from "../errors/httpError.js";
import { enqueueQuoteRefresh } from "../services/quote-refresh-queue.service.js";
import { invalidateActiveTrackedSymbolsCache } from "../services/ticker-cache.service.js";
import { normalizeQuoteSymbol } from "../services/quote-symbols.service.js";

const MAX_TICKERS_PER_USER = 32;

// Symbol format matches quote endpoints and supports futures/index symbols.
const SymbolSchema = z
  .string()
  .min(1)
  .max(20)
  .regex(/^[A-Za-z0-9:.\-^=_]+$/, "Invalid ticker symbol")
  .transform(normalizeQuoteSymbol);

const AddSchema = z.object({ symbol: SymbolSchema });
const BulkSchema = z.object({
  symbols: z.array(SymbolSchema).max(MAX_TICKERS_PER_USER),
});

function requireUserId(req: Request): string {
  if (!req.userId) {
    throw new HttpError(401, "Unauthenticated", "UNAUTHORIZED");
  }
  return req.userId;
}

// ─── GET /api/user/tickers ────────────────────────────────────────
export async function listTickers(req: Request, res: Response): Promise<void> {
  try {
    const userId = requireUserId(req);
    const tickers = await prisma.userTicker.findMany({
      where: { userId },
      orderBy: [{ position: "asc" }, { createdAt: "asc" }],
    });
    res.json({ tickers });
  } catch (err) {
    handleError(res, err);
  }
}

// ─── POST /api/user/tickers ───────────────────────────────────────
export async function addTicker(req: Request, res: Response): Promise<void> {
  try {
    const userId = requireUserId(req);
    const parsed = AddSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, parsed.error.message, "INVALID_BODY");
    }
    const { symbol } = parsed.data;

    const count = await prisma.userTicker.count({ where: { userId } });
    if (count >= MAX_TICKERS_PER_USER) {
      throw new HttpError(
        400,
        `Maximum ${MAX_TICKERS_PER_USER} tickers per user`,
        "TICKER_LIMIT"
      );
    }

    try {
      const ticker = await prisma.userTicker.create({
        data: { userId, symbol, position: count },
      });
      invalidateActiveTrackedSymbolsCache();
      enqueueQuoteRefresh(symbol);
      res.status(201).json({ ticker });
    } catch (err) {
      // Unique violation = duplicate symbol for this user
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2002"
      ) {
        throw new HttpError(409, "Ticker already added", "DUPLICATE_TICKER");
      }
      throw err;
    }
  } catch (err) {
    handleError(res, err);
  }
}

// ─── DELETE /api/user/tickers/:symbol ─────────────────────────────
export async function deleteTicker(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const userId = requireUserId(req);
    const parsed = SymbolSchema.safeParse(req.params.symbol);
    if (!parsed.success) {
      throw new HttpError(400, "Invalid symbol", "INVALID_BODY");
    }
    const symbol = parsed.data;

    const result = await prisma.userTicker.deleteMany({
      where: { userId, symbol },
    });
    if (result.count === 0) {
      throw new HttpError(404, "Ticker not found", "NOT_FOUND");
    }
    invalidateActiveTrackedSymbolsCache();
    res.status(204).end();
  } catch (err) {
    handleError(res, err);
  }
}

// ─── PUT /api/user/tickers ────────────────────────────────────────
// Bulk replace — used for reordering and one-time localStorage migration.
export async function bulkReplaceTickers(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const userId = requireUserId(req);
    const parsed = BulkSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, parsed.error.message, "INVALID_BODY");
    }
    const { symbols } = parsed.data;

    // Dedupe while preserving first-seen order so position stays stable.
    const seen = new Set<string>();
    const unique = symbols.filter((s) => {
      if (seen.has(s)) return false;
      seen.add(s);
      return true;
    });

    const tickers = await prisma.$transaction(async (tx) => {
      await tx.userTicker.deleteMany({ where: { userId } });
      for (let i = 0; i < unique.length; i++) {
        await tx.userTicker.create({
          data: { userId, symbol: unique[i], position: i },
        });
      }
      return tx.userTicker.findMany({
        where: { userId },
        orderBy: [{ position: "asc" }, { createdAt: "asc" }],
      });
    });

    enqueueQuoteRefresh(unique);
    invalidateActiveTrackedSymbolsCache();
    res.json({ tickers });
  } catch (err) {
    handleError(res, err);
  }
}
