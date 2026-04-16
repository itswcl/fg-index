import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  evaluateForMetric,
  __setFetchOverrideForTests,
  __setPushOverrideForTests,
} from "../services/alertWorker.js";
import { prisma } from "../services/db.js";
import * as delivery from "../services/webhookDelivery.js";
import * as registry from "../services/wsRegistry.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const updateManySpy = vi.spyOn(prisma.alert, "updateMany") as unknown as any;
updateManySpy.mockResolvedValue({ count: 1 });

const deliverSpy = vi.spyOn(delivery, "deliverWebhook");
const getSocketsSpy = vi.spyOn(registry, "getSocketsForUser");
const pushSpy = vi.fn();

const USER = "u-1";

// Build an AlertRow stub matching the worker's include-shape.
function alertRow(overrides: Partial<{
  id: string;
  userId: string;
  name: string;
  logic: "AND" | "OR";
  cooldownMinutes: number;
  lastTriggeredAt: Date | null;
  conditions: { metric: string; operator: string; value: number }[];
  webhook: { type: string; url: string | null; botToken: string | null; chatId: string | null } | null;
}> = {}) {
  return {
    id: overrides.id ?? "a1",
    userId: overrides.userId ?? USER,
    name: overrides.name ?? "My Alert",
    logic: overrides.logic ?? "AND",
    enabled: true,
    cooldownMinutes: overrides.cooldownMinutes ?? 60,
    lastTriggeredAt: overrides.lastTriggeredAt ?? null,
    conditions: overrides.conditions ?? [
      { metric: "vix", operator: ">", value: 30 },
    ],
    user: {
      id: overrides.userId ?? USER,
      webhook: overrides.webhook ?? null,
    },
  };
}

beforeEach(() => {
  updateManySpy.mockClear();
  deliverSpy.mockReset();
  deliverSpy.mockResolvedValue(undefined);
  getSocketsSpy.mockReset();
  getSocketsSpy.mockReturnValue([]);
  pushSpy.mockReset();
  __setPushOverrideForTests(pushSpy);
});

afterEach(() => {
  __setFetchOverrideForTests(null);
  __setPushOverrideForTests(null);
});

describe("alertWorker.evaluateForMetric", () => {
  it("returns empty and makes no side-effects when no candidates exist", async () => {
    __setFetchOverrideForTests(async () => []);
    const out = await evaluateForMetric("vix", {
      fearGreedScore: 50,
      vixPrice: 35,
      btcPrice: null,
      spxPrice: null,
    });
    expect(out).toEqual([]);
    expect(updateManySpy).not.toHaveBeenCalled();
    expect(deliverSpy).not.toHaveBeenCalled();
    expect(pushSpy).not.toHaveBeenCalled();
  });

  it("fires for a simple VIX > 30 alert when vixPrice is 35", async () => {
    __setFetchOverrideForTests(async () => [alertRow()]);
    const out = await evaluateForMetric("vix", {
      fearGreedScore: null,
      vixPrice: 35,
      btcPrice: null,
      spxPrice: null,
    });
    expect(out).toHaveLength(1);
    expect(out[0].alertName).toBe("My Alert");
    expect(updateManySpy).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "a1" } })
    );
  });

  it("does not fire when VIX condition is not met", async () => {
    __setFetchOverrideForTests(async () => [alertRow()]);
    const out = await evaluateForMetric("vix", {
      fearGreedScore: null,
      vixPrice: 20,
      btcPrice: null,
      spxPrice: null,
    });
    expect(out).toEqual([]);
    expect(updateManySpy).not.toHaveBeenCalled();
  });

  it("AND logic: fires only when both conditions pass", async () => {
    const row = alertRow({
      logic: "AND",
      conditions: [
        { metric: "fearGreed", operator: "<", value: 10 },
        { metric: "vix", operator: ">", value: 30 },
      ],
    });
    __setFetchOverrideForTests(async () => [row]);

    const bothTrue = await evaluateForMetric("vix", {
      fearGreedScore: 8, vixPrice: 35, btcPrice: null, spxPrice: null,
    });
    expect(bothTrue).toHaveLength(1);

    __setFetchOverrideForTests(async () => [alertRow({
      logic: "AND",
      conditions: [
        { metric: "fearGreed", operator: "<", value: 10 },
        { metric: "vix", operator: ">", value: 30 },
      ],
    })]);
    const onlyOne = await evaluateForMetric("vix", {
      fearGreedScore: 50, vixPrice: 35, btcPrice: null, spxPrice: null,
    });
    expect(onlyOne).toEqual([]);
  });

  it("OR logic: fires when any condition passes", async () => {
    __setFetchOverrideForTests(async () => [alertRow({
      logic: "OR",
      conditions: [
        { metric: "fearGreed", operator: "<", value: 10 },
        { metric: "vix", operator: ">", value: 30 },
      ],
    })]);
    const out = await evaluateForMetric("vix", {
      fearGreedScore: 80, vixPrice: 35, btcPrice: null, spxPrice: null,
    });
    expect(out).toHaveLength(1);
  });

  it("skips alerts inside cooldown window", async () => {
    const now = new Date("2026-04-15T12:00:00Z");
    const recent = new Date(now.getTime() - 10 * 60_000); // 10 min ago
    __setFetchOverrideForTests(async () => [
      alertRow({ cooldownMinutes: 60, lastTriggeredAt: recent }),
    ]);
    const out = await evaluateForMetric(
      "vix",
      { fearGreedScore: null, vixPrice: 35, btcPrice: null, spxPrice: null },
      now
    );
    expect(out).toEqual([]);
    expect(updateManySpy).not.toHaveBeenCalled();
  });

  it("re-fires after cooldown elapses", async () => {
    const now = new Date("2026-04-15T12:00:00Z");
    const old = new Date(now.getTime() - 120 * 60_000); // 2h ago
    __setFetchOverrideForTests(async () => [
      alertRow({ cooldownMinutes: 60, lastTriggeredAt: old }),
    ]);
    const out = await evaluateForMetric(
      "vix",
      { fearGreedScore: null, vixPrice: 35, btcPrice: null, spxPrice: null },
      now
    );
    expect(out).toHaveLength(1);
    expect(updateManySpy).toHaveBeenCalledWith({
      where: { id: "a1" },
      data: { lastTriggeredAt: now },
    });
  });

  it("delivers to the user's webhook when configured", async () => {
    __setFetchOverrideForTests(async () => [
      alertRow({
        webhook: {
          type: "discord",
          url: "https://discord.com/api/webhooks/x/y",
          botToken: null,
          chatId: null,
        },
      }),
    ]);
    await evaluateForMetric("vix", {
      fearGreedScore: null, vixPrice: 35, btcPrice: null, spxPrice: null,
    });
    // deliverWebhook is fire-and-forget — await a microtask.
    await Promise.resolve();
    expect(deliverSpy).toHaveBeenCalledWith(
      { type: "discord", url: "https://discord.com/api/webhooks/x/y" },
      "My Alert",
      expect.any(String)
    );
  });

  it("pushes to live WS sockets for the alert owner", async () => {
    const fakeWs = { readyState: 1, send: vi.fn() } as unknown;
    getSocketsSpy.mockReturnValue([fakeWs as never]);

    __setFetchOverrideForTests(async () => [alertRow()]);
    await evaluateForMetric("vix", {
      fearGreedScore: null, vixPrice: 35, btcPrice: null, spxPrice: null,
    });
    expect(getSocketsSpy).toHaveBeenCalledWith(USER);
    expect(pushSpy).toHaveBeenCalledTimes(1);
    const [, msg] = pushSpy.mock.calls[0];
    expect(msg).toMatchObject({ type: "alert_triggered", alertId: "a1" });
  });

  it("does not throw if fetch fails — logs and returns empty", async () => {
    __setFetchOverrideForTests(async () => {
      throw new Error("db down");
    });
    const out = await evaluateForMetric("vix", {
      fearGreedScore: null, vixPrice: 35, btcPrice: null, spxPrice: null,
    });
    expect(out).toEqual([]);
  });
});
