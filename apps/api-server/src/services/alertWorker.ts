import { WebSocket } from "ws";
import { prisma } from "./db.js";
import { evaluateAlerts } from "./alertEvaluator.js";
import { deliverWebhook } from "./webhookDelivery.js";
import { getSocketsForUser } from "./wsRegistry.js";
import type {
  Alert as SharedAlert,
  WebhookConfig,
  AlertTriggeredMessage,
} from "@shared/types";

// ─── Types ───────────────────────────────────────────────────────
export type MetricKey = "fearGreed" | "vix" | "btc" | "spx";

export interface MarketSnapshot {
  fearGreedScore: number | null;
  vixPrice: number | null;
  btcPrice: number | null;
  spxPrice: number | null;
}

// ─── Prisma row shapes (duck-typed so tests can stub minimally) ──
interface ConditionRow {
  metric: string;
  operator: string;
  value: number;
}

interface WebhookRow {
  id: string;
  type: string;
  url: string | null;
  botToken: string | null;
  chatId: string | null;
  enabled: boolean;
}

interface UserRow {
  id: string;
  webhooks: WebhookRow[];
}

interface AlertRow {
  id: string;
  userId: string;
  name: string;
  logic: string;
  enabled: boolean;
  cooldownMinutes: number;
  lastTriggeredAt: Date | null;
  conditions: ConditionRow[];
  user: UserRow;
}

// ─── Mapping helpers ─────────────────────────────────────────────
function rowToSharedAlert(row: AlertRow): SharedAlert {
  return {
    id: row.id,
    name: row.name,
    logic: row.logic as SharedAlert["logic"],
    enabled: row.enabled,
    conditions: row.conditions.map((c) => ({
      metric: c.metric as SharedAlert["conditions"][number]["metric"],
      operator: c.operator as SharedAlert["conditions"][number]["operator"],
      value: c.value,
    })),
    createdAt: "",
  };
}

function rowToWebhookConfig(row: WebhookRow): WebhookConfig | null {
  if (row.type === "discord" && row.url) return { type: "discord", url: row.url };
  if (row.type === "slack" && row.url) return { type: "slack", url: row.url };
  if (row.type === "generic" && row.url) return { type: "generic", url: row.url };
  if (row.type === "telegram" && row.botToken && row.chatId) {
    return { type: "telegram", botToken: row.botToken, chatId: row.chatId };
  }
  return null;
}

function isInCooldown(row: AlertRow, now: Date): boolean {
  if (!row.lastTriggeredAt) return false;
  const elapsedMs = now.getTime() - row.lastTriggeredAt.getTime();
  return elapsedMs < row.cooldownMinutes * 60_000;
}

// ─── Seam for tests ──────────────────────────────────────────────
// prisma.alert.findMany with the exact include-shape the worker needs.
type FetchFn = (metric: MetricKey) => Promise<AlertRow[]>;

let fetchOverride: FetchFn | null = null;

export function __setFetchOverrideForTests(fn: FetchFn | null): void {
  fetchOverride = fn;
}

async function fetchCandidateAlerts(metric: MetricKey): Promise<AlertRow[]> {
  if (fetchOverride) return fetchOverride(metric);
  const rows = await prisma.alert.findMany({
    where: {
      enabled: true,
      conditions: { some: { metric } },
    },
    include: {
      conditions: true,
      user: {
        include: {
          webhooks: { where: { enabled: true } },
        },
      },
    },
  });
  return rows as unknown as AlertRow[];
}

// Test seam for delivery side-effects
type PushFn = (ws: WebSocket, msg: AlertTriggeredMessage) => void;
let pushOverride: PushFn | null = null;
export function __setPushOverrideForTests(fn: PushFn | null): void {
  pushOverride = fn;
}

function pushToSocket(ws: WebSocket, msg: AlertTriggeredMessage): void {
  if (pushOverride) return pushOverride(ws, msg);
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

// ─── Public API ──────────────────────────────────────────────────
/**
 * Evaluate all enabled alerts that reference `metric`, using the provided
 * snapshot. Fires webhook delivery + WS pushback for any alert whose
 * conditions are satisfied and whose cooldown has elapsed.
 *
 * Called from scheduler subscribers after each market-data update.
 */
export async function evaluateForMetric(
  metric: MetricKey,
  snapshot: MarketSnapshot,
  now: Date = new Date()
): Promise<AlertTriggeredMessage[]> {
  let candidates: AlertRow[];
  try {
    candidates = await fetchCandidateAlerts(metric);
  } catch (err) {
    process.stderr.write(
      JSON.stringify({
        event: "alert_worker_fetch_error",
        metric,
        error: err instanceof Error ? err.message : String(err),
      }) + "\n"
    );
    return [];
  }

  const fresh = candidates.filter((row) => !isInCooldown(row, now));
  if (fresh.length === 0) return [];

  // Reuse existing evaluator — but it expects the shared Alert shape.
  const sharedAlerts = fresh.map(rowToSharedAlert);
  const triggered = evaluateAlerts(
    sharedAlerts,
    snapshot.fearGreedScore,
    snapshot.vixPrice,
    snapshot.btcPrice,
    snapshot.spxPrice
  );
  if (triggered.length === 0) return [];

  // Index back to rows for side-effects.
  const rowsById = new Map(fresh.map((r) => [r.id, r]));

  await Promise.all(
    triggered.map(async (msg) => {
      const row = rowsById.get(msg.alertId);
      if (!row) return;

      // 1) Persist cooldown timestamp. Use updateMany so a concurrently-
      // deleted alert can't throw.
      try {
        await prisma.alert.updateMany({
          where: { id: row.id },
          data: { lastTriggeredAt: now },
        });
      } catch (err) {
        process.stderr.write(
          JSON.stringify({
            event: "alert_worker_update_error",
            alertId: row.id,
            error: err instanceof Error ? err.message : String(err),
          }) + "\n"
        );
      }

      // 2) Fan-out delivery: fire every enabled webhook the user owns.
      // Use Promise.allSettled so one bad endpoint doesn't suppress the
      // others. Per-webhook success/failure is logged individually so an
      // operator can tell *which* destination dropped a notification.
      const webhooks = row.user.webhooks ?? [];
      const deliveries = webhooks
        .map((w) => ({ webhookId: w.id, cfg: rowToWebhookConfig(w) }))
        .filter(
          (
            d
          ): d is { webhookId: string; cfg: NonNullable<typeof d.cfg> } =>
            d.cfg !== null
        );
      void Promise.allSettled(
        deliveries.map(({ webhookId, cfg }) =>
          deliverWebhook(cfg, msg.alertName, msg.message)
            .then(() => {
              process.stdout.write(
                JSON.stringify({
                  event: "alert_worker_webhook_delivered",
                  alertId: row.id,
                  webhookId,
                }) + "\n"
              );
            })
            .catch((err: unknown) => {
              process.stderr.write(
                JSON.stringify({
                  event: "alert_worker_webhook_error",
                  alertId: row.id,
                  webhookId,
                  error: err instanceof Error ? err.message : String(err),
                }) + "\n"
              );
            })
        )
      );

      // 3) Push to any live WS connections for this user.
      const sockets = getSocketsForUser(row.userId);
      for (const ws of sockets) pushToSocket(ws, msg);
    })
  );

  return triggered;
}
