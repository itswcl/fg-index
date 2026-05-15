import { WebSocket } from "ws";
import { env } from "../config/env.js";
import { prisma } from "./db.js";
import { evaluateAlerts } from "./alertEvaluator.js";
import { deliverWebhook } from "./webhookDelivery.js";
import { getSocketsForUser } from "./wsRegistry.js";
import {
  getBackgroundDbCooldownRemainingMs,
  recordBackgroundDbFailure,
  recordBackgroundDbSuccess,
} from "./background-db-circuit.service.js";
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
const inFlightMetrics = new Set<MetricKey>();
const candidateCache = new Map<MetricKey, { rows: AlertRow[]; expiresAtMs: number }>();

const stats = {
  candidateCacheHits: 0,
  candidateCacheMisses: 0,
  candidateDbReads: 0,
  candidateCacheInvalidations: 0,
};

export function __setFetchOverrideForTests(fn: FetchFn | null): void {
  fetchOverride = fn;
}

export function __resetAlertWorkerStateForTests(): void {
  inFlightMetrics.clear();
  candidateCache.clear();
  stats.candidateCacheHits = 0;
  stats.candidateCacheMisses = 0;
  stats.candidateDbReads = 0;
  stats.candidateCacheInvalidations = 0;
}

export function invalidateAlertCandidateCache(): void {
  candidateCache.clear();
  stats.candidateCacheInvalidations += 1;
}

export function getAlertWorkerStats() {
  return {
    ...stats,
    candidateCacheEntries: candidateCache.size,
  };
}

async function fetchCandidateAlerts(metric: MetricKey): Promise<AlertRow[]> {
  if (fetchOverride) return fetchOverride(metric);
  const cached = candidateCache.get(metric);
  if (cached && cached.expiresAtMs > Date.now()) {
    stats.candidateCacheHits += 1;
    return cached.rows;
  }

  stats.candidateCacheMisses += 1;
  stats.candidateDbReads += 1;
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
  const alertRows = rows as unknown as AlertRow[];
  candidateCache.set(metric, {
    rows: alertRows,
    expiresAtMs: Date.now() + env.ALERT_CANDIDATE_CACHE_TTL_MS,
  });
  return alertRows;
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
  if (!fetchOverride && getBackgroundDbCooldownRemainingMs() > 0) {
    return [];
  }

  if (!fetchOverride && inFlightMetrics.has(metric)) {
    process.stderr.write(
      JSON.stringify({
        event: "alert_worker_skipped",
        metric,
        reason: "evaluation_in_flight",
      }) + "\n"
    );
    return [];
  }

  if (!fetchOverride) {
    inFlightMetrics.add(metric);
  }

  let candidates: AlertRow[];
  try {
    candidates = await fetchCandidateAlerts(metric);
    if (!fetchOverride) {
      recordBackgroundDbSuccess();
    }
  } catch (err) {
    if (!fetchOverride) {
      recordBackgroundDbFailure("alert_worker", err);
    }
    process.stderr.write(
      JSON.stringify({
        event: "alert_worker_fetch_error",
        metric,
        error: err instanceof Error ? err.message : String(err),
      }) + "\n"
    );
    return [];
  } finally {
    if (!fetchOverride) {
      inFlightMetrics.delete(metric);
    }
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
        row.lastTriggeredAt = now;
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
