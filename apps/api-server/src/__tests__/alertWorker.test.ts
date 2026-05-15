import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  evaluateForMetric,
  getAlertWorkerStats,
  invalidateAlertCandidateCache,
  __resetAlertWorkerStateForTests,
  __setFetchOverrideForTests,
  __setPushOverrideForTests,
} from "../services/alertWorker.js";
import { prisma } from "../services/db.js";
import * as delivery from "../services/webhookDelivery.js";
import * as registry from "../services/wsRegistry.js";
import {
  __resetBackgroundDbCircuitForTests,
} from "../services/background-db-circuit.service.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const updateManySpy = vi.spyOn(prisma.alert, "updateMany") as unknown as any;
updateManySpy.mockResolvedValue({ count: 1 });
const findManySpy = vi.spyOn(prisma.alert, "findMany") as unknown as any;
findManySpy.mockResolvedValue([]);

const deliverSpy = vi.spyOn(delivery, "deliverWebhook");
const getSocketsSpy = vi.spyOn(registry, "getSocketsForUser");
const pushSpy = vi.fn();

const USER = "u-1";

interface WebhookStub {
  id: string;
  type: string;
  url: string | null;
  botToken: string | null;
  chatId: string | null;
  enabled: boolean;
}

// Build an AlertRow stub matching the worker's include-shape.
function alertRow(overrides: Partial<{
  id: string;
  userId: string;
  name: string;
  logic: "AND" | "OR";
  cooldownMinutes: number;
  lastTriggeredAt: Date | null;
  conditions: { metric: string; operator: string; value: number }[];
  webhooks: WebhookStub[];
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
      webhooks: overrides.webhooks ?? [],
    },
  };
}

beforeEach(() => {
  __resetBackgroundDbCircuitForTests();
  __resetAlertWorkerStateForTests();
  findManySpy.mockClear();
  findManySpy.mockResolvedValue([]);
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
  __resetAlertWorkerStateForTests();
  __resetBackgroundDbCircuitForTests();
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

  it("skips overlapping DB fetches for the same metric", async () => {
    let releaseFetch!: () => void;
    findManySpy.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseFetch = () => resolve([]);
        })
    );

    const first = evaluateForMetric("spx", {
      fearGreedScore: null,
      vixPrice: null,
      btcPrice: null,
      spxPrice: 5000,
    });
    const second = await evaluateForMetric("spx", {
      fearGreedScore: null,
      vixPrice: null,
      btcPrice: null,
      spxPrice: 5001,
    });

    releaseFetch();
    await first;

    expect(second).toEqual([]);
    expect(findManySpy).toHaveBeenCalledTimes(1);
  });

  it("backs off background DB fetches after a Prisma connectivity failure", async () => {
    findManySpy.mockRejectedValueOnce(
      new Error("Can't reach database server at `aws-1-us-east-2.pooler.supabase.com:6543`")
    );

    const first = await evaluateForMetric("vix", {
      fearGreedScore: null,
      vixPrice: 30,
      btcPrice: null,
      spxPrice: null,
    });
    const second = await evaluateForMetric("spx", {
      fearGreedScore: null,
      vixPrice: null,
      btcPrice: null,
      spxPrice: 5000,
    });

    expect(first).toEqual([]);
    expect(second).toEqual([]);
    expect(findManySpy).toHaveBeenCalledTimes(1);
  });

  it("caches DB alert candidates per metric until invalidated", async () => {
    findManySpy.mockResolvedValue([alertRow()]);

    await evaluateForMetric("vix", {
      fearGreedScore: null,
      vixPrice: 20,
      btcPrice: null,
      spxPrice: null,
    });
    await evaluateForMetric("vix", {
      fearGreedScore: null,
      vixPrice: 20,
      btcPrice: null,
      spxPrice: null,
    });
    invalidateAlertCandidateCache();
    await evaluateForMetric("vix", {
      fearGreedScore: null,
      vixPrice: 20,
      btcPrice: null,
      spxPrice: null,
    });

    expect(findManySpy).toHaveBeenCalledTimes(2);
    expect(getAlertWorkerStats()).toMatchObject({
      candidateCacheHits: 1,
      candidateDbReads: 2,
      candidateCacheInvalidations: 1,
    });
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

  it("delivers to the user's webhook when one is configured", async () => {
    __setFetchOverrideForTests(async () => [
      alertRow({
        webhooks: [
          {
            id: "wh-1",
            type: "discord",
            url: "https://discord.com/api/webhooks/x/y",
            botToken: null,
            chatId: null,
            enabled: true,
          },
        ],
      }),
    ]);
    await evaluateForMetric("vix", {
      fearGreedScore: null, vixPrice: 35, btcPrice: null, spxPrice: null,
    });
    // deliverWebhook is fire-and-forget — await microtasks for the
    // Promise.allSettled chain to settle.
    await new Promise((r) => setImmediate(r));
    expect(deliverSpy).toHaveBeenCalledWith(
      { type: "discord", url: "https://discord.com/api/webhooks/x/y" },
      "My Alert",
      expect.any(String)
    );
  });

  it("fans out to every enabled webhook (3 destinations → 3 deliveries)", async () => {
    __setFetchOverrideForTests(async () => [
      alertRow({
        webhooks: [
          {
            id: "wh-d",
            type: "discord",
            url: "https://discord.com/api/webhooks/x/y",
            botToken: null,
            chatId: null,
            enabled: true,
          },
          {
            id: "wh-s",
            type: "slack",
            url: "https://hooks.slack.com/abc",
            botToken: null,
            chatId: null,
            enabled: true,
          },
          {
            id: "wh-t",
            type: "telegram",
            url: null,
            botToken: "tok",
            chatId: "chat",
            enabled: true,
          },
        ],
      }),
    ]);
    await evaluateForMetric("vix", {
      fearGreedScore: null, vixPrice: 35, btcPrice: null, spxPrice: null,
    });
    await new Promise((r) => setImmediate(r));
    expect(deliverSpy).toHaveBeenCalledTimes(3);
    const targets = deliverSpy.mock.calls.map((c) => c[0]?.type);
    expect(targets).toEqual(
      expect.arrayContaining(["discord", "slack", "telegram"])
    );
  });

  it("one failing destination doesn't suppress the others (Promise.allSettled)", async () => {
    __setFetchOverrideForTests(async () => [
      alertRow({
        webhooks: [
          {
            id: "wh-bad",
            type: "discord",
            url: "https://discord.com/api/webhooks/bad",
            botToken: null,
            chatId: null,
            enabled: true,
          },
          {
            id: "wh-good",
            type: "slack",
            url: "https://hooks.slack.com/good",
            botToken: null,
            chatId: null,
            enabled: true,
          },
        ],
      }),
    ]);
    deliverSpy.mockImplementation(async (cfg) => {
      if (cfg.type === "discord") throw new Error("discord 500");
    });
    await evaluateForMetric("vix", {
      fearGreedScore: null, vixPrice: 35, btcPrice: null, spxPrice: null,
    });
    await new Promise((r) => setImmediate(r));
    expect(deliverSpy).toHaveBeenCalledTimes(2);
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
