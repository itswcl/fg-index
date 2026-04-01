import { WebSocketServer, WebSocket } from "ws";
import http from "http";
import { subscribeToFearGreed, getCachedFearGreed } from "./schedulers/fear-greed.scheduler.js";
import { subscribeToVix, getCachedVix } from "./schedulers/vix.scheduler.js";
import { MAX_WS_CONNECTIONS } from "./middlewares/rateLimit.js";
import { SetAlertsMessageSchema, SetWebhookMessageSchema, type Alert, type WebhookConfig } from "@shared/types";
import { evaluateAlerts } from "./services/alertEvaluator.js";
import { deliverWebhook } from "./services/webhookDelivery.js";

// Per-connection alert storage
const connectionAlerts = new Map<WebSocket, Alert[]>();

// Per-connection webhook config storage
const connectionWebhooks = new Map<WebSocket, WebhookConfig | null>();

// Cached reference to the WSS for external broadcast
let wssInstance: WebSocketServer | null = null;

export function broadcastWithAlertEvaluation(
  fearGreedScore: number | null,
  vixPrice: number | null
): void {
  if (!wssInstance) return;

  wssInstance.clients.forEach((client) => {
    if (client.readyState !== WebSocket.OPEN) return;

    const alerts = connectionAlerts.get(client) ?? [];
    if (alerts.length > 0) {
      const triggered = evaluateAlerts(alerts, fearGreedScore, vixPrice);
      for (const msg of triggered) {
        client.send(JSON.stringify(msg));
      }

      // Deliver webhook for each triggered alert if this connection has one configured
      const webhookConfig = connectionWebhooks.get(client);
      if (webhookConfig) {
        for (const msg of triggered) {
          void deliverWebhook(webhookConfig, msg.alertName, msg.message);
        }
      }
    }
  });
}

export function startWsServer(server: http.Server) {
  const wss = new WebSocketServer({ server });
  wssInstance = wss;

  wss.on("connection", (ws) => {
    // Check connection limit
    if (wss.clients.size > MAX_WS_CONNECTIONS) {
      ws.close(1013, "Server at capacity");
      return;
    }

    // Send initial data
    const fg = getCachedFearGreed();
    if (fg) {
      ws.send(JSON.stringify({ type: "FEAR_GREED_UPDATE", payload: fg }));
    }

    const vix = getCachedVix();
    ws.send(JSON.stringify({ type: "VIX_UPDATE", payload: vix }));

    // Accept set_alerts messages; reject anything else
    ws.on("message", (data) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(data.toString());
      } catch {
        // Ignore malformed JSON — don't crash or close
        return;
      }

      // Dispatch on message type
      const msgType =
        parsed !== null &&
        typeof parsed === "object" &&
        "type" in (parsed as Record<string, unknown>)
          ? (parsed as Record<string, unknown>).type
          : undefined;

      if (msgType === "set_webhook") {
        const webhookResult = SetWebhookMessageSchema.safeParse(parsed);
        if (webhookResult.success) {
          connectionWebhooks.set(ws, webhookResult.data.webhook);
          return;
        }
        ws.close(1003, "Unsupported data");
        return;
      }

      const result = SetAlertsMessageSchema.safeParse(parsed);
      if (result.success) {
        connectionAlerts.set(ws, result.data.alerts);
        return;
      }

      // Unknown message type — close as before for unsupported data
      ws.close(1003, "Unsupported data");
    });

    ws.on("close", () => {
      connectionAlerts.delete(ws);
      connectionWebhooks.delete(ws);
    });

    ws.on("error", (err) => {
      process.stderr.write(JSON.stringify({ event: "ws_error", message: err.message }) + "\n");
    });
  });

  subscribeToFearGreed((data) => {
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({ type: "FEAR_GREED_UPDATE", payload: data }));
      }
    });

    // Evaluate alerts with freshly updated fear & greed, use latest cached VIX
    const vix = getCachedVix();
    broadcastWithAlertEvaluation(data.score, vix?.price ?? null);
  });

  subscribeToVix((data) => {
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({ type: "VIX_UPDATE", payload: data }));
      }
    });

    // Evaluate alerts with freshly updated VIX, use latest cached fear & greed
    const fg = getCachedFearGreed();
    broadcastWithAlertEvaluation(fg?.score ?? null, data?.price ?? null);
  });

  process.stdout.write("WebSocket server started on same port as HTTP\n");
}
