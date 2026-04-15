import type { Request, Response } from "express";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../services/db.js";
import { HttpError, handleError } from "../errors/httpError.js";

// ─── Validation ───────────────────────────────────────────────────
const ConditionSchema = z.object({
  metric: z.string().min(1).max(64),
  operator: z.enum(["<", ">", "<=", ">=", "=="]),
  value: z.number().finite(),
});

const AlertBaseSchema = z.object({
  name: z.string().min(1).max(80),
  logic: z.enum(["AND", "OR"]),
  enabled: z.boolean().optional(),
  cooldownMinutes: z.number().int().min(0).max(10_080).optional(),
  conditions: z.array(ConditionSchema).min(1).max(5),
});

const AlertCreateSchema = AlertBaseSchema;
const AlertUpdateSchema = AlertBaseSchema.partial().extend({
  conditions: z.array(ConditionSchema).min(1).max(5).optional(),
});
const BulkSchema = z.object({
  alerts: z.array(AlertBaseSchema).max(100),
});

function requireUserId(req: Request): string {
  if (!req.userId) {
    throw new HttpError(401, "Unauthenticated", "UNAUTHORIZED");
  }
  return req.userId;
}

// ─── GET /api/alerts ──────────────────────────────────────────────
export async function listAlerts(req: Request, res: Response): Promise<void> {
  try {
    const userId = requireUserId(req);
    const alerts = await prisma.alert.findMany({
      where: { userId },
      include: { conditions: true },
      orderBy: { createdAt: "asc" },
    });
    res.json({ alerts });
  } catch (err) {
    handleError(res, err);
  }
}

// ─── POST /api/alerts ─────────────────────────────────────────────
export async function createAlert(req: Request, res: Response): Promise<void> {
  try {
    const userId = requireUserId(req);
    const parsed = AlertCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, parsed.error.message, "INVALID_BODY");
    }
    const { name, logic, enabled, cooldownMinutes, conditions } = parsed.data;

    const alert = await prisma.alert.create({
      data: {
        userId,
        name,
        logic,
        enabled: enabled ?? true,
        cooldownMinutes: cooldownMinutes ?? 60,
        conditions: { create: conditions },
      },
      include: { conditions: true },
    });
    res.status(201).json({ alert });
  } catch (err) {
    handleError(res, err);
  }
}

// ─── PUT /api/alerts/:id ──────────────────────────────────────────
export async function updateAlert(req: Request, res: Response): Promise<void> {
  try {
    const userId = requireUserId(req);
    const { id } = req.params;
    const parsed = AlertUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, parsed.error.message, "INVALID_BODY");
    }

    // Ownership check
    const existing = await prisma.alert.findUnique({ where: { id } });
    if (!existing || existing.userId !== userId) {
      throw new HttpError(404, "Alert not found", "NOT_FOUND");
    }

    const { name, logic, enabled, cooldownMinutes, conditions } = parsed.data;

    // Transactional update — if conditions provided, replace them.
    const alert = await prisma.$transaction(async (tx) => {
      if (conditions) {
        await tx.condition.deleteMany({ where: { alertId: id } });
      }
      return tx.alert.update({
        where: { id },
        data: {
          ...(name !== undefined ? { name } : {}),
          ...(logic !== undefined ? { logic } : {}),
          ...(enabled !== undefined ? { enabled } : {}),
          ...(cooldownMinutes !== undefined ? { cooldownMinutes } : {}),
          ...(conditions ? { conditions: { create: conditions } } : {}),
        },
        include: { conditions: true },
      });
    });

    res.json({ alert });
  } catch (err) {
    handleError(res, err);
  }
}

// ─── DELETE /api/alerts/:id ───────────────────────────────────────
export async function deleteAlert(req: Request, res: Response): Promise<void> {
  try {
    const userId = requireUserId(req);
    const { id } = req.params;

    const existing = await prisma.alert.findUnique({ where: { id } });
    if (!existing || existing.userId !== userId) {
      throw new HttpError(404, "Alert not found", "NOT_FOUND");
    }

    await prisma.alert.delete({ where: { id } });
    res.status(204).end();
  } catch (err) {
    handleError(res, err);
  }
}

// ─── POST /api/alerts/bulk ────────────────────────────────────────
// Replaces the authenticated user's alert set with the provided list.
// Intended for one-time localStorage → server migration after first sign-in.
export async function bulkReplaceAlerts(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const userId = requireUserId(req);
    const parsed = BulkSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, parsed.error.message, "INVALID_BODY");
    }
    const { alerts: incoming } = parsed.data;

    const alerts = await prisma.$transaction(async (tx) => {
      await tx.alert.deleteMany({ where: { userId } });
      for (const a of incoming) {
        await tx.alert.create({
          data: {
            userId,
            name: a.name,
            logic: a.logic,
            enabled: a.enabled ?? true,
            cooldownMinutes: a.cooldownMinutes ?? 60,
            conditions: { create: a.conditions },
          },
        });
      }
      return tx.alert.findMany({
        where: { userId },
        include: { conditions: true },
        orderBy: { createdAt: "asc" },
      });
    });

    res.json({ alerts });
  } catch (err) {
    // Prisma validation errors surface as generic 500 unless we narrow
    if (err instanceof Prisma.PrismaClientValidationError) {
      handleError(
        res,
        new HttpError(400, "Invalid alert payload", "INVALID_BODY")
      );
      return;
    }
    handleError(res, err);
  }
}
