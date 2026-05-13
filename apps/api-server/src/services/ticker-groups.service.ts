import { Prisma } from "@prisma/client";
import { MAX_CUSTOM_TICKER_GROUPS } from "@shared/types";
import { HttpError } from "../errors/httpError.js";
import { prisma } from "./db.js";
import { enqueueQuoteRefresh } from "./quote-refresh-queue.service.js";

const DEFAULT_GROUP_NAME = "Default";
const MAX_CUSTOM_GROUPS = MAX_CUSTOM_TICKER_GROUPS;
const MAX_TICKERS_PER_GROUP = 32;

type Tx = Prisma.TransactionClient;

type GroupWithItems = Prisma.UserTickerGroupGetPayload<{
  include: { items: true };
}>;

export interface TickerGroupResponse {
  id: string;
  userId: string;
  name: string;
  position: number;
  isDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
  tickers: Array<{
    id: string;
    groupId: string;
    userId: string;
    symbol: string;
    position: number;
    createdAt: Date;
  }>;
}

function formatGroup(group: GroupWithItems): TickerGroupResponse {
  return {
    id: group.id,
    userId: group.userId,
    name: group.name,
    position: group.position,
    isDefault: group.isDefault,
    createdAt: group.createdAt,
    updatedAt: group.updatedAt,
    tickers: [...group.items].sort((a, b) => {
      if (a.position !== b.position) return a.position - b.position;
      return a.createdAt.getTime() - b.createdAt.getTime();
    }),
  };
}

function assertCustomGroupNameAvailable(name: string): void {
  if (name.toLowerCase() === DEFAULT_GROUP_NAME.toLowerCase()) {
    throw new HttpError(400, "Default group name is reserved", "INVALID_BODY");
  }
}

function uniqueSymbols(symbols: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const symbol of symbols) {
    if (seen.has(symbol)) continue;
    seen.add(symbol);
    unique.push(symbol);
  }
  return unique;
}

async function findDefaultGroup(tx: Tx, userId: string): Promise<GroupWithItems | null> {
  return tx.userTickerGroup.findFirst({
    where: { userId, isDefault: true },
    include: { items: true },
  });
}

async function listGroupsFromDb(tx: Tx, userId: string): Promise<TickerGroupResponse[]> {
  const groups = await tx.userTickerGroup.findMany({
    where: { userId },
    include: { items: true },
    orderBy: [{ isDefault: "desc" }, { position: "asc" }, { createdAt: "asc" }],
  });
  return groups.map(formatGroup);
}

async function ensureDefaultGroup(tx: Tx, userId: string): Promise<void> {
  const existingDefault = await findDefaultGroup(tx, userId);
  if (existingDefault) return;

  const existingNamedDefault = await tx.userTickerGroup.findFirst({
    where: { userId, name: DEFAULT_GROUP_NAME },
    include: { items: true },
  });

  if (existingNamedDefault) {
    await tx.userTickerGroup.update({
      where: { id: existingNamedDefault.id },
      data: { isDefault: true, position: 0 },
    });
    return;
  }

  const defaultGroup = await tx.userTickerGroup.create({
    data: { userId, name: DEFAULT_GROUP_NAME, isDefault: true, position: 0 },
  });
  const existingTickers = await tx.userTicker.findMany({
    where: { userId },
    orderBy: [{ position: "asc" }, { createdAt: "asc" }],
  });

  if (existingTickers.length === 0) return;

  await tx.userTickerGroupItem.createMany({
    data: existingTickers.map((ticker, index) => ({
      groupId: defaultGroup.id,
      userId,
      symbol: ticker.symbol,
      position: ticker.position ?? index,
      createdAt: ticker.createdAt,
    })),
    skipDuplicates: true,
  });
}

async function getOwnedGroup(tx: Tx, userId: string, groupId: string): Promise<GroupWithItems> {
  const group = await tx.userTickerGroup.findUnique({
    where: { id: groupId },
    include: { items: true },
  });
  if (!group || group.userId !== userId) {
    throw new HttpError(404, "Ticker group not found", "NOT_FOUND");
  }
  return group;
}

async function ensureGlobalUserTickers(tx: Tx, userId: string, symbols: string[]): Promise<void> {
  if (symbols.length === 0) return;

  const existing = await tx.userTicker.findMany({
    where: { userId, symbol: { in: symbols } },
    select: { symbol: true },
  });
  const existingSymbols = new Set(existing.map((ticker) => ticker.symbol));
  const missing = symbols.filter((symbol) => !existingSymbols.has(symbol));
  if (missing.length === 0) return;

  const count = await tx.userTicker.count({ where: { userId } });
  for (let i = 0; i < missing.length; i++) {
    await tx.userTicker.create({
      data: { userId, symbol: missing[i], position: count + i },
    });
  }
}

async function replaceGroupItems(
  tx: Tx,
  userId: string,
  groupId: string,
  symbols: string[]
): Promise<void> {
  await tx.userTickerGroupItem.deleteMany({ where: { groupId, userId } });
  if (symbols.length === 0) return;

  await tx.userTickerGroupItem.createMany({
    data: symbols.map((symbol, position) => ({
      groupId,
      userId,
      symbol,
      position,
    })),
    skipDuplicates: true,
  });
}

export async function listTickerGroups(userId: string): Promise<TickerGroupResponse[]> {
  return prisma.$transaction(async (tx) => {
    await ensureDefaultGroup(tx, userId);
    return listGroupsFromDb(tx, userId);
  });
}

export async function createTickerGroup(
  userId: string,
  name: string
): Promise<TickerGroupResponse[]> {
  assertCustomGroupNameAvailable(name);

  return prisma.$transaction(async (tx) => {
    await ensureDefaultGroup(tx, userId);

    const customGroupCount = await tx.userTickerGroup.count({
      where: { userId, isDefault: false },
    });
    if (customGroupCount >= MAX_CUSTOM_GROUPS) {
      throw new HttpError(
        400,
        `Maximum ${MAX_CUSTOM_GROUPS} custom ticker groups`,
        "GROUP_LIMIT"
      );
    }

    try {
      await tx.userTickerGroup.create({
        data: {
          userId,
          name,
          isDefault: false,
          position: customGroupCount + 1,
        },
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2002"
      ) {
        throw new HttpError(409, "Ticker group already exists", "DUPLICATE_GROUP");
      }
      throw err;
    }

    return listGroupsFromDb(tx, userId);
  });
}

export async function renameTickerGroup(
  userId: string,
  groupId: string,
  name: string
): Promise<TickerGroupResponse[]> {
  assertCustomGroupNameAvailable(name);

  return prisma.$transaction(async (tx) => {
    const group = await getOwnedGroup(tx, userId, groupId);
    if (group.isDefault) {
      throw new HttpError(400, "Default group cannot be renamed", "DEFAULT_GROUP_LOCKED");
    }

    try {
      await tx.userTickerGroup.update({
        where: { id: groupId },
        data: { name },
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2002"
      ) {
        throw new HttpError(409, "Ticker group already exists", "DUPLICATE_GROUP");
      }
      throw err;
    }

    return listGroupsFromDb(tx, userId);
  });
}

export async function deleteTickerGroup(
  userId: string,
  groupId: string
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const group = await getOwnedGroup(tx, userId, groupId);
    if (group.isDefault) {
      throw new HttpError(400, "Default group cannot be deleted", "DEFAULT_GROUP_LOCKED");
    }
    await tx.userTickerGroup.delete({ where: { id: groupId } });
  });
}

export async function reorderTickerGroups(
  userId: string,
  groupIds: string[]
): Promise<TickerGroupResponse[]> {
  return prisma.$transaction(async (tx) => {
    await ensureDefaultGroup(tx, userId);
    const customGroups = await tx.userTickerGroup.findMany({
      where: { userId, isDefault: false },
      orderBy: [{ position: "asc" }, { createdAt: "asc" }],
    });
    const existingIds = new Set(customGroups.map((group) => group.id));
    const requestedIds = new Set(groupIds);

    if (
      groupIds.length !== customGroups.length ||
      requestedIds.size !== groupIds.length ||
      groupIds.some((id) => !existingIds.has(id))
    ) {
      throw new HttpError(400, "Reorder must include each custom group exactly once", "INVALID_BODY");
    }

    for (let i = 0; i < groupIds.length; i++) {
      await tx.userTickerGroup.update({
        where: { id: groupIds[i] },
        data: { position: i + 1 },
      });
    }

    return listGroupsFromDb(tx, userId);
  });
}

export async function addTickerToGroup(
  userId: string,
  groupId: string,
  symbol: string
): Promise<TickerGroupResponse[]> {
  return prisma.$transaction(async (tx) => {
    await getOwnedGroup(tx, userId, groupId);

    const existingItem = await tx.userTickerGroupItem.findFirst({
      where: { groupId, userId, symbol },
    });
    if (existingItem) {
      throw new HttpError(409, "Ticker already exists in group", "DUPLICATE_TICKER");
    }

    const itemCount = await tx.userTickerGroupItem.count({
      where: { groupId, userId },
    });
    if (itemCount >= MAX_TICKERS_PER_GROUP) {
      throw new HttpError(
        400,
        `Maximum ${MAX_TICKERS_PER_GROUP} tickers per group`,
        "TICKER_GROUP_LIMIT"
      );
    }

    await ensureGlobalUserTickers(tx, userId, [symbol]);
    await tx.userTickerGroupItem.create({
      data: { groupId, userId, symbol, position: itemCount },
    });

    return listGroupsFromDb(tx, userId);
  }).then((groups) => {
    enqueueQuoteRefresh(symbol);
    return groups;
  });
}

export async function removeTickerFromGroup(
  userId: string,
  groupId: string,
  symbol: string
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await getOwnedGroup(tx, userId, groupId);
    const result = await tx.userTickerGroupItem.deleteMany({
      where: { groupId, userId, symbol },
    });
    if (result.count === 0) {
      throw new HttpError(404, "Ticker group item not found", "NOT_FOUND");
    }
  });
}

export async function replaceGroupTickers(
  userId: string,
  groupId: string,
  symbols: string[]
): Promise<TickerGroupResponse[]> {
  const unique = uniqueSymbols(symbols);
  if (unique.length > MAX_TICKERS_PER_GROUP) {
    throw new HttpError(
      400,
      `Maximum ${MAX_TICKERS_PER_GROUP} tickers per group`,
      "TICKER_GROUP_LIMIT"
    );
  }

  return prisma.$transaction(async (tx) => {
    await getOwnedGroup(tx, userId, groupId);
    await ensureGlobalUserTickers(tx, userId, unique);
    await replaceGroupItems(tx, userId, groupId, unique);
    return listGroupsFromDb(tx, userId);
  }).then((groups) => {
    enqueueQuoteRefresh(unique);
    return groups;
  });
}

export async function migrateTickerGroups(
  userId: string,
  defaultSymbolsInput: string[],
  groupsInput: Array<{ name: string; symbols: string[] }> = []
): Promise<TickerGroupResponse[]> {
  const defaultSymbols = uniqueSymbols(defaultSymbolsInput);
  if (defaultSymbols.length > MAX_TICKERS_PER_GROUP) {
    throw new HttpError(
      400,
      `Maximum ${MAX_TICKERS_PER_GROUP} tickers per group`,
      "TICKER_GROUP_LIMIT"
    );
  }

  const seenNames = new Set<string>();
  for (const group of groupsInput) {
    assertCustomGroupNameAvailable(group.name);
    const key = group.name.toLowerCase();
    if (seenNames.has(key)) {
      throw new HttpError(400, "Duplicate group name", "DUPLICATE_GROUP");
    }
    seenNames.add(key);
    if (uniqueSymbols(group.symbols).length > MAX_TICKERS_PER_GROUP) {
      throw new HttpError(
        400,
        `Maximum ${MAX_TICKERS_PER_GROUP} tickers per group`,
        "TICKER_GROUP_LIMIT"
      );
    }
  }

  if (groupsInput.length > MAX_CUSTOM_GROUPS) {
    throw new HttpError(
      400,
      `Maximum ${MAX_CUSTOM_GROUPS} custom ticker groups`,
      "GROUP_LIMIT"
    );
  }

  const symbolsToRefresh = [
    ...defaultSymbols,
    ...groupsInput.flatMap((group) => uniqueSymbols(group.symbols)),
  ];
  const uniqueRefreshSymbols = uniqueSymbols(symbolsToRefresh);

  return prisma.$transaction(async (tx) => {
    await ensureDefaultGroup(tx, userId);
    const defaultGroup = await findDefaultGroup(tx, userId);
    if (!defaultGroup) {
      throw new HttpError(500, "Default group missing after ensure", "INTERNAL_ERROR");
    }

    const existingCustomGroups = await tx.userTickerGroup.findMany({
      where: { userId, isDefault: false },
    });
    const existingCustomNames = new Set(
      existingCustomGroups.map((group) => group.name.toLowerCase())
    );
    const newCustomCount = groupsInput.filter(
      (group) => !existingCustomNames.has(group.name.toLowerCase())
    ).length;
    if (existingCustomGroups.length + newCustomCount > MAX_CUSTOM_GROUPS) {
      throw new HttpError(
        400,
        `Maximum ${MAX_CUSTOM_GROUPS} custom ticker groups`,
        "GROUP_LIMIT"
      );
    }

    await ensureGlobalUserTickers(tx, userId, uniqueRefreshSymbols);
    await replaceGroupItems(tx, userId, defaultGroup.id, defaultSymbols);

    let nextPosition = existingCustomGroups.length + 1;
    for (const group of groupsInput) {
      const symbols = uniqueSymbols(group.symbols);
      const existing = existingCustomGroups.find(
        (existingGroup) => existingGroup.name.toLowerCase() === group.name.toLowerCase()
      );
      const groupId = existing
        ? existing.id
        : (
            await tx.userTickerGroup.create({
              data: {
                userId,
                name: group.name,
                isDefault: false,
                position: nextPosition++,
              },
            })
          ).id;

      await replaceGroupItems(tx, userId, groupId, symbols);
    }

    return listGroupsFromDb(tx, userId);
  }).then((groups) => {
    enqueueQuoteRefresh(uniqueRefreshSymbols);
    return groups;
  });
}

export const tickerGroupLimits = {
  maxCustomGroups: MAX_CUSTOM_GROUPS,
  maxTickersPerGroup: MAX_TICKERS_PER_GROUP,
};
