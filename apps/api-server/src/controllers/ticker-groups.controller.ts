import type { Request, Response } from "express";
import { z } from "zod";
import { HttpError, handleError } from "../errors/httpError.js";
import { normalizeQuoteSymbol } from "../services/quote-symbols.service.js";
import {
  addTickerToGroup,
  createTickerGroup,
  deleteTickerGroup,
  listTickerGroups,
  migrateTickerGroups,
  removeTickerFromGroup,
  renameTickerGroup,
  reorderTickerGroups,
  replaceGroupTickers,
} from "../services/ticker-groups.service.js";

const GroupIdSchema = z.string().min(1).max(120);
const GroupNameSchema = z
  .string()
  .transform((value) => value.trim())
  .refine((value) => value.length > 0, "Group name is required")
  .refine((value) => value.length <= 24, "Group name must be 24 characters or fewer");

const SymbolSchema = z
  .string()
  .min(1)
  .max(20)
  .regex(/^[A-Za-z0-9:.\-^=_]+$/, "Invalid ticker symbol")
  .transform(normalizeQuoteSymbol);

const CreateGroupSchema = z.object({ name: GroupNameSchema });
const ReorderGroupsSchema = z.object({
  groupIds: z.array(GroupIdSchema),
});
const AddTickerSchema = z.object({ symbol: SymbolSchema });
const ReplaceTickersSchema = z.object({
  symbols: z.array(SymbolSchema),
});
const MigrationGroupSchema = z.object({
  name: GroupNameSchema,
  symbols: z.array(SymbolSchema),
});
const MigrationSchema = z.object({
  defaultSymbols: z.array(SymbolSchema),
  groups: z.array(MigrationGroupSchema).optional(),
});

function requireUserId(req: Request): string {
  if (!req.userId) {
    throw new HttpError(401, "Unauthenticated", "UNAUTHORIZED");
  }
  return req.userId;
}

function parseGroupId(groupId: string | undefined): string {
  const parsed = GroupIdSchema.safeParse(groupId);
  if (!parsed.success) {
    throw new HttpError(400, "Invalid group id", "INVALID_BODY");
  }
  return parsed.data;
}

export async function listGroups(req: Request, res: Response): Promise<void> {
  try {
    const groups = await listTickerGroups(requireUserId(req));
    res.json({ groups });
  } catch (err) {
    handleError(res, err);
  }
}

export async function createGroup(req: Request, res: Response): Promise<void> {
  try {
    const userId = requireUserId(req);
    const parsed = CreateGroupSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, parsed.error.message, "INVALID_BODY");
    }
    const groups = await createTickerGroup(userId, parsed.data.name);
    res.status(201).json({ groups });
  } catch (err) {
    handleError(res, err);
  }
}

export async function renameGroup(req: Request, res: Response): Promise<void> {
  try {
    const userId = requireUserId(req);
    const groupId = parseGroupId(req.params.groupId);
    const parsed = CreateGroupSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, parsed.error.message, "INVALID_BODY");
    }
    const groups = await renameTickerGroup(userId, groupId, parsed.data.name);
    res.json({ groups });
  } catch (err) {
    handleError(res, err);
  }
}

export async function deleteGroup(req: Request, res: Response): Promise<void> {
  try {
    const userId = requireUserId(req);
    const groupId = parseGroupId(req.params.groupId);
    await deleteTickerGroup(userId, groupId);
    res.status(204).end();
  } catch (err) {
    handleError(res, err);
  }
}

export async function reorderGroups(req: Request, res: Response): Promise<void> {
  try {
    const userId = requireUserId(req);
    const parsed = ReorderGroupsSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, parsed.error.message, "INVALID_BODY");
    }
    const groups = await reorderTickerGroups(userId, parsed.data.groupIds);
    res.json({ groups });
  } catch (err) {
    handleError(res, err);
  }
}

export async function addGroupTicker(req: Request, res: Response): Promise<void> {
  try {
    const userId = requireUserId(req);
    const groupId = parseGroupId(req.params.groupId);
    const parsed = AddTickerSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, parsed.error.message, "INVALID_BODY");
    }
    const groups = await addTickerToGroup(userId, groupId, parsed.data.symbol);
    res.status(201).json({ groups });
  } catch (err) {
    handleError(res, err);
  }
}

export async function deleteGroupTicker(req: Request, res: Response): Promise<void> {
  try {
    const userId = requireUserId(req);
    const groupId = parseGroupId(req.params.groupId);
    const symbol = SymbolSchema.safeParse(req.params.symbol);
    if (!symbol.success) {
      throw new HttpError(400, "Invalid symbol", "INVALID_BODY");
    }
    await removeTickerFromGroup(userId, groupId, symbol.data);
    res.status(204).end();
  } catch (err) {
    handleError(res, err);
  }
}

export async function replaceGroupTickerList(req: Request, res: Response): Promise<void> {
  try {
    const userId = requireUserId(req);
    const groupId = parseGroupId(req.params.groupId);
    const parsed = ReplaceTickersSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, parsed.error.message, "INVALID_BODY");
    }
    const groups = await replaceGroupTickers(userId, groupId, parsed.data.symbols);
    res.json({ groups });
  } catch (err) {
    handleError(res, err);
  }
}

export async function migrateGroups(req: Request, res: Response): Promise<void> {
  try {
    const userId = requireUserId(req);
    const parsed = MigrationSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, parsed.error.message, "INVALID_BODY");
    }
    const groups = await migrateTickerGroups(
      userId,
      parsed.data.defaultSymbols,
      parsed.data.groups ?? []
    );
    res.json({ groups });
  } catch (err) {
    handleError(res, err);
  }
}
