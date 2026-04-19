import type { Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../services/db.js";
import { HttpError, handleError } from "../errors/httpError.js";

// Card IDs are short slugs ("fearGreed", "vix", "ticker:AAPL", etc.)
// Bound the array so a malicious client can't blow up the row.
const MAX_CARDS = 36;

const PreferencesSchema = z.object({
  cardOrder: z
    .array(z.string().min(1).max(16))
    .max(MAX_CARDS),
});

function requireUserId(req: Request): string {
  if (!req.userId) {
    throw new HttpError(401, "Unauthenticated", "UNAUTHORIZED");
  }
  return req.userId;
}

// ─── GET /api/user/preferences ────────────────────────────────────
export async function getPreferences(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const userId = requireUserId(req);
    // authMiddleware upserts the User row, so it exists here.
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { cardOrder: true },
    });
    res.json({ cardOrder: user?.cardOrder ?? [] });
  } catch (err) {
    handleError(res, err);
  }
}

// ─── PUT /api/user/preferences ────────────────────────────────────
export async function updatePreferences(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const userId = requireUserId(req);
    const parsed = PreferencesSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, parsed.error.message, "INVALID_BODY");
    }
    const { cardOrder } = parsed.data;

    // Dedupe while preserving first-seen order.
    const seen = new Set<string>();
    const unique = cardOrder.filter((id) => {
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });

    const user = await prisma.user.update({
      where: { id: userId },
      data: { cardOrder: unique },
      select: { cardOrder: true },
    });
    res.json({ cardOrder: user.cardOrder });
  } catch (err) {
    handleError(res, err);
  }
}
