import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Request, Response } from "express";
import { prisma } from "../services/db.js";
import {
  addTickerToGroup,
  createTickerGroup,
  deleteTickerGroup,
  listTickerGroups,
  migrateTickerGroups,
  removeTickerFromGroup,
  renameTickerGroup,
  replaceGroupTickers,
} from "../services/ticker-groups.service.js";
import { migrateGroups } from "../controllers/ticker-groups.controller.js";

vi.mock("../services/quote-refresh-queue.service.js", () => ({
  enqueueQuoteRefresh: vi.fn(),
}));

import { enqueueQuoteRefresh } from "../services/quote-refresh-queue.service.js";

interface GroupRow {
  id: string;
  userId: string;
  name: string;
  position: number;
  isDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
}

interface GroupItemRow {
  id: string;
  groupId: string;
  userId: string;
  symbol: string;
  position: number;
  createdAt: Date;
}

interface UserTickerRow {
  id: string;
  userId: string;
  symbol: string;
  position: number;
  createdAt: Date;
}

interface MockedRes {
  _status: number;
  _body: unknown;
  _ended: boolean;
  status(code: number): MockedRes;
  json(body: unknown): MockedRes;
  end(): MockedRes;
}

const USER = "user-1";
const OTHER_USER = "user-2";
let idSeq = 0;
let groups: GroupRow[] = [];
let items: GroupItemRow[] = [];
let userTickers: UserTickerRow[] = [];
let nowSeq = 0;

function nextId(prefix: string): string {
  idSeq += 1;
  return `${prefix}-${idSeq}`;
}

function nextDate(): Date {
  nowSeq += 1;
  return new Date(`2026-05-05T12:${String(nowSeq).padStart(2, "0")}:00.000Z`);
}

function makeGroup(data: Partial<GroupRow> & Pick<GroupRow, "userId" | "name">): GroupRow {
  const now = nextDate();
  return {
    id: data.id ?? nextId("group"),
    userId: data.userId,
    name: data.name,
    position: data.position ?? 0,
    isDefault: data.isDefault ?? false,
    createdAt: data.createdAt ?? now,
    updatedAt: data.updatedAt ?? now,
  };
}

function makeTicker(
  data: Partial<UserTickerRow> & Pick<UserTickerRow, "userId" | "symbol" | "position">
): UserTickerRow {
  return {
    id: data.id ?? nextId("ticker"),
    userId: data.userId,
    symbol: data.symbol,
    position: data.position,
    createdAt: data.createdAt ?? nextDate(),
  };
}

function makeItem(
  data: Partial<GroupItemRow> & Pick<GroupItemRow, "groupId" | "userId" | "symbol" | "position">
): GroupItemRow {
  return {
    id: data.id ?? nextId("item"),
    groupId: data.groupId,
    userId: data.userId,
    symbol: data.symbol,
    position: data.position,
    createdAt: data.createdAt ?? nextDate(),
  };
}

function includeItems(group: GroupRow): GroupRow & { items: GroupItemRow[] } {
  return {
    ...group,
    items: items.filter((item) => item.groupId === group.id),
  };
}

function matchesGroup(group: GroupRow, where: Record<string, unknown> = {}): boolean {
  return Object.entries(where).every(([key, value]) => group[key as keyof GroupRow] === value);
}

function matchesItem(item: GroupItemRow, where: Record<string, unknown> = {}): boolean {
  return Object.entries(where).every(([key, value]) => item[key as keyof GroupItemRow] === value);
}

function matchesUserTicker(ticker: UserTickerRow, where: Record<string, unknown> = {}): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (key === "symbol" && typeof value === "object" && value && "in" in value) {
      return (value as { in: string[] }).in.includes(ticker.symbol);
    }
    return ticker[key as keyof UserTickerRow] === value;
  });
}

function orderGroups(rows: GroupRow[]): GroupRow[] {
  return [...rows].sort((a, b) => {
    if (Number(a.isDefault) !== Number(b.isDefault)) return Number(b.isDefault) - Number(a.isDefault);
    if (a.position !== b.position) return a.position - b.position;
    return a.createdAt.getTime() - b.createdAt.getTime();
  });
}

function orderTickers(rows: UserTickerRow[]): UserTickerRow[] {
  return [...rows].sort((a, b) => {
    if (a.position !== b.position) return a.position - b.position;
    return a.createdAt.getTime() - b.createdAt.getTime();
  });
}

function mockRes(): MockedRes & Response {
  const res: MockedRes = {
    _status: 0,
    _body: null,
    _ended: false,
    status(code) {
      this._status = code;
      return this;
    },
    json(body) {
      this._body = body;
      return this;
    },
    end() {
      this._ended = true;
      return this;
    },
  };
  return res as unknown as MockedRes & Response;
}

function mockReq(opts: { userId?: string; body?: unknown }): Request {
  return {
    userId: opts.userId,
    body: opts.body,
    params: {},
  } as unknown as Request;
}

const enqueueQuoteRefreshMock =
  enqueueQuoteRefresh as unknown as ReturnType<typeof vi.fn>;

/* eslint-disable @typescript-eslint/no-explicit-any */
const txSpy = vi.spyOn(prisma, "$transaction") as unknown as any;
const groupFindFirstSpy = vi.spyOn(prisma.userTickerGroup, "findFirst") as unknown as any;
const groupFindUniqueSpy = vi.spyOn(prisma.userTickerGroup, "findUnique") as unknown as any;
const groupFindManySpy = vi.spyOn(prisma.userTickerGroup, "findMany") as unknown as any;
const groupCountSpy = vi.spyOn(prisma.userTickerGroup, "count") as unknown as any;
const groupCreateSpy = vi.spyOn(prisma.userTickerGroup, "create") as unknown as any;
const groupUpdateSpy = vi.spyOn(prisma.userTickerGroup, "update") as unknown as any;
const groupDeleteSpy = vi.spyOn(prisma.userTickerGroup, "delete") as unknown as any;
const itemFindFirstSpy = vi.spyOn(prisma.userTickerGroupItem, "findFirst") as unknown as any;
const itemCountSpy = vi.spyOn(prisma.userTickerGroupItem, "count") as unknown as any;
const itemCreateSpy = vi.spyOn(prisma.userTickerGroupItem, "create") as unknown as any;
const itemCreateManySpy = vi.spyOn(prisma.userTickerGroupItem, "createMany") as unknown as any;
const itemDeleteManySpy = vi.spyOn(prisma.userTickerGroupItem, "deleteMany") as unknown as any;
const tickerFindManySpy = vi.spyOn(prisma.userTicker, "findMany") as unknown as any;
const tickerCountSpy = vi.spyOn(prisma.userTicker, "count") as unknown as any;
const tickerCreateSpy = vi.spyOn(prisma.userTicker, "create") as unknown as any;

txSpy.mockImplementation(async (fn: any) => fn(prisma));
groupFindFirstSpy.mockImplementation(async (args: any) => {
  const row = groups.find((group) => matchesGroup(group, args?.where));
  return row ? includeItems(row) : null;
});
groupFindUniqueSpy.mockImplementation(async (args: any) => {
  const row = groups.find((group) => group.id === args?.where?.id);
  return row ? includeItems(row) : null;
});
groupFindManySpy.mockImplementation(async (args: any) => {
  const rows = groups.filter((group) => matchesGroup(group, args?.where));
  const ordered = args?.orderBy ? orderGroups(rows) : rows;
  return args?.include?.items ? ordered.map(includeItems) : ordered;
});
groupCountSpy.mockImplementation(async (args: any) =>
  groups.filter((group) => matchesGroup(group, args?.where)).length
);
groupCreateSpy.mockImplementation(async (args: any) => {
  if (groups.some((group) => group.userId === args.data.userId && group.name === args.data.name)) {
    throw new Error("unique constraint");
  }
  const row = makeGroup(args.data);
  groups.push(row);
  return row;
});
groupUpdateSpy.mockImplementation(async (args: any) => {
  const index = groups.findIndex((group) => group.id === args.where.id);
  groups[index] = { ...groups[index], ...args.data, updatedAt: nextDate() };
  return groups[index];
});
groupDeleteSpy.mockImplementation(async (args: any) => {
  const index = groups.findIndex((group) => group.id === args.where.id);
  const [deleted] = groups.splice(index, 1);
  items = items.filter((item) => item.groupId !== args.where.id);
  return deleted;
});
itemFindFirstSpy.mockImplementation(async (args: any) => {
  return items.find((item) => matchesItem(item, args?.where)) ?? null;
});
itemCountSpy.mockImplementation(async (args: any) =>
  items.filter((item) => matchesItem(item, args?.where)).length
);
itemCreateSpy.mockImplementation(async (args: any) => {
  if (items.some((item) => item.groupId === args.data.groupId && item.symbol === args.data.symbol)) {
    throw new Error("unique constraint");
  }
  const row = makeItem(args.data);
  items.push(row);
  return row;
});
itemCreateManySpy.mockImplementation(async (args: any) => {
  let count = 0;
  for (const item of args.data) {
    const duplicate = items.some(
      (existing) => existing.groupId === item.groupId && existing.symbol === item.symbol
    );
    if (duplicate && args.skipDuplicates) continue;
    items.push(makeItem(item));
    count += 1;
  }
  return { count };
});
itemDeleteManySpy.mockImplementation(async (args: any) => {
  const before = items.length;
  items = items.filter((item) => !matchesItem(item, args?.where));
  return { count: before - items.length };
});
tickerFindManySpy.mockImplementation(async (args: any) => {
  const rows = orderTickers(userTickers.filter((ticker) => matchesUserTicker(ticker, args?.where)));
  if (args?.select?.symbol) {
    return rows.map((ticker) => ({ symbol: ticker.symbol }));
  }
  return rows;
});
tickerCountSpy.mockImplementation(async (args: any) =>
  userTickers.filter((ticker) => matchesUserTicker(ticker, args?.where)).length
);
tickerCreateSpy.mockImplementation(async (args: any) => {
  const row = makeTicker(args.data);
  userTickers.push(row);
  return row;
});
/* eslint-enable @typescript-eslint/no-explicit-any */

beforeEach(() => {
  idSeq = 0;
  nowSeq = 0;
  groups = [];
  items = [];
  userTickers = [];
  enqueueQuoteRefreshMock.mockReset();
});

describe("ticker groups", () => {
  it("creates Default and backfills existing UserTicker rows in order", async () => {
    userTickers = [
      makeTicker({ userId: USER, symbol: "MSFT", position: 1 }),
      makeTicker({ userId: USER, symbol: "AAPL", position: 0 }),
    ];

    const result = await listTickerGroups(USER);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ name: "Default", isDefault: true });
    expect(result[0].tickers.map((ticker) => ticker.symbol)).toEqual(["AAPL", "MSFT"]);
  });

  it("lists Default first, then custom groups by position with ordered tickers", async () => {
    const defaultGroup = makeGroup({ userId: USER, name: "Default", isDefault: true });
    const watch = makeGroup({ userId: USER, name: "Watch", position: 2 });
    const ai = makeGroup({ userId: USER, name: "AI", position: 1 });
    groups = [watch, defaultGroup, ai];
    items = [
      makeItem({ groupId: ai.id, userId: USER, symbol: "NVDA", position: 1 }),
      makeItem({ groupId: ai.id, userId: USER, symbol: "AMD", position: 0 }),
    ];

    const result = await listTickerGroups(USER);

    expect(result.map((group) => group.name)).toEqual(["Default", "AI", "Watch"]);
    expect(result[1].tickers.map((ticker) => ticker.symbol)).toEqual(["AMD", "NVDA"]);
  });

  it("creates, renames, and deletes a custom group", async () => {
    const created = await createTickerGroup(USER, "AI");
    const group = created.find((entry) => entry.name === "AI");
    expect(group).toBeDefined();

    const renamed = await renameTickerGroup(USER, group!.id, "Semis");
    expect(renamed.map((entry) => entry.name)).toContain("Semis");

    await deleteTickerGroup(USER, group!.id);
    expect(groups.some((entry) => entry.id === group!.id)).toBe(false);
  });

  it("rejects rename and delete for Default", async () => {
    const defaultGroup = makeGroup({ userId: USER, name: "Default", isDefault: true });
    groups = [defaultGroup];

    await expect(renameTickerGroup(USER, defaultGroup.id, "Main")).rejects.toMatchObject({
      code: "DEFAULT_GROUP_LOCKED",
    });
    await expect(deleteTickerGroup(USER, defaultGroup.id)).rejects.toMatchObject({
      code: "DEFAULT_GROUP_LOCKED",
    });
  });

  it("enforces the max 8 custom groups limit", async () => {
    groups = [makeGroup({ userId: USER, name: "Default", isDefault: true })];
    for (let i = 0; i < 8; i++) {
      groups.push(makeGroup({ userId: USER, name: `G${i}`, position: i + 1 }));
    }

    await expect(createTickerGroup(USER, "Overflow")).rejects.toMatchObject({
      code: "GROUP_LIMIT",
    });
  });

  it("enforces the max 32 tickers per group", async () => {
    const group = makeGroup({ userId: USER, name: "AI", position: 1 });
    groups = [makeGroup({ userId: USER, name: "Default", isDefault: true }), group];
    items = Array.from({ length: 32 }, (_, index) =>
      makeItem({ groupId: group.id, userId: USER, symbol: `T${index}`, position: index })
    );

    await expect(addTickerToGroup(USER, group.id, "AAPL")).rejects.toMatchObject({
      code: "TICKER_GROUP_LIMIT",
    });
  });

  it("adds ticker membership, ensures global UserTicker, and allows same ticker in multiple groups", async () => {
    const ai = makeGroup({ userId: USER, name: "AI", position: 1 });
    const etf = makeGroup({ userId: USER, name: "ETF", position: 2 });
    groups = [makeGroup({ userId: USER, name: "Default", isDefault: true }), ai, etf];

    await addTickerToGroup(USER, ai.id, "NVDA");
    await addTickerToGroup(USER, etf.id, "NVDA");

    expect(userTickers.filter((ticker) => ticker.symbol === "NVDA")).toHaveLength(1);
    expect(items.filter((item) => item.symbol === "NVDA")).toHaveLength(2);
    expect(enqueueQuoteRefreshMock).toHaveBeenCalledWith("NVDA");
  });

  it("removing ticker from one group leaves other memberships and global UserTicker intact", async () => {
    const ai = makeGroup({ userId: USER, name: "AI", position: 1 });
    const etf = makeGroup({ userId: USER, name: "ETF", position: 2 });
    groups = [makeGroup({ userId: USER, name: "Default", isDefault: true }), ai, etf];
    userTickers = [makeTicker({ userId: USER, symbol: "NVDA", position: 0 })];
    items = [
      makeItem({ groupId: ai.id, userId: USER, symbol: "NVDA", position: 0 }),
      makeItem({ groupId: etf.id, userId: USER, symbol: "NVDA", position: 0 }),
    ];

    await removeTickerFromGroup(USER, ai.id, "NVDA");

    expect(items).toHaveLength(1);
    expect(items[0].groupId).toBe(etf.id);
    expect(userTickers).toHaveLength(1);
  });

  it("isolates ownership for group mutations", async () => {
    const otherGroup = makeGroup({ userId: OTHER_USER, name: "Other", position: 1 });
    groups = [otherGroup];

    await expect(addTickerToGroup(USER, otherGroup.id, "AAPL")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("bulk replaces and reorders group tickers with dedupe", async () => {
    const group = makeGroup({ userId: USER, name: "AI", position: 1 });
    groups = [makeGroup({ userId: USER, name: "Default", isDefault: true }), group];
    userTickers = [makeTicker({ userId: USER, symbol: "AAPL", position: 0 })];

    const result = await replaceGroupTickers(USER, group.id, ["MSFT", "AAPL", "MSFT"]);
    const updated = result.find((entry) => entry.id === group.id);

    expect(updated?.tickers.map((ticker) => ticker.symbol)).toEqual(["MSFT", "AAPL"]);
    expect(userTickers.map((ticker) => ticker.symbol)).toEqual(["AAPL", "MSFT"]);
    expect(enqueueQuoteRefreshMock).toHaveBeenCalledWith(["MSFT", "AAPL"]);
  });

  it("migrates Default and custom groups from endpoint payload", async () => {
    const res = mockRes();

    await migrateGroups(
      mockReq({
        userId: USER,
        body: {
          defaultSymbols: ["aapl", "MSFT", "aapl"],
          groups: [{ name: "AI", symbols: ["nvda", "AMD"] }],
        },
      }),
      res
    );

    expect(res._status).toBe(0);
    const body = res._body as { groups: Array<{ name: string; tickers: Array<{ symbol: string }> }> };
    expect(body.groups.map((group) => group.name)).toEqual(["Default", "AI"]);
    expect(body.groups[0].tickers.map((ticker) => ticker.symbol)).toEqual(["AAPL", "MSFT"]);
    expect(body.groups[1].tickers.map((ticker) => ticker.symbol)).toEqual(["NVDA", "AMD"]);
  });

  it("service migration enforces all limits", async () => {
    const tooMany = Array.from({ length: 33 }, (_, index) => `T${index}`);

    await expect(migrateTickerGroups(USER, tooMany)).rejects.toMatchObject({
      code: "TICKER_GROUP_LIMIT",
    });
  });
});
