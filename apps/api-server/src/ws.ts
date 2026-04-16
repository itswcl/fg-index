import { WebSocketServer, WebSocket } from "ws";
import http from "http";
import { URL } from "url";
import { subscribeToFearGreed, getCachedFearGreed } from "./schedulers/fear-greed.scheduler.js";
import { subscribeToVix, getCachedVix } from "./schedulers/vix.scheduler.js";
import { subscribeToBtc, getCachedBtc } from "./schedulers/btc.scheduler.js";
import { subscribeToSpx, getCachedSpx } from "./schedulers/spx.scheduler.js";
import { MAX_WS_CONNECTIONS } from "./middlewares/rateLimit.js";
import { verifySupabaseJwt } from "./middlewares/auth.js";
import {
  registerUserSocket,
  unregisterUserSocket,
} from "./services/wsRegistry.js";
import { evaluateForMetric } from "./services/alertWorker.js";

// Attach userId to the socket once the ?token= is verified.
interface AuthedSocket extends WebSocket {
  userId?: string;
}

export function startWsServer(server: http.Server) {
  const wss = new WebSocketServer({ server });

  wss.on("connection", async (ws: AuthedSocket, req) => {
    // Connection cap
    if (wss.clients.size > MAX_WS_CONNECTIONS) {
      ws.close(1013, "Server at capacity");
      return;
    }

    // Optional JWT via ?token=<jwt>. Anonymous connections are allowed —
    // they receive market data but no alert pushback.
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const token = url.searchParams.get("token");
      if (token) {
        const payload = await verifySupabaseJwt(token);
        const sub = typeof payload.sub === "string" ? payload.sub : null;
        if (sub) {
          ws.userId = sub;
          registerUserSocket(sub, ws);
        }
      }
    } catch (err) {
      // Bad token → treat as anonymous. Do not drop the connection; market
      // data still has value for unauthenticated readers.
      process.stderr.write(
        JSON.stringify({
          event: "ws_token_verify_failed",
          error: err instanceof Error ? err.message : String(err),
        }) + "\n"
      );
    }

    // Send initial market data snapshot
    const fg = getCachedFearGreed();
    if (fg) ws.send(JSON.stringify({ type: "FEAR_GREED_UPDATE", payload: fg }));

    const vix = getCachedVix();
    ws.send(JSON.stringify({ type: "VIX_UPDATE", payload: vix }));

    const btc = getCachedBtc();
    ws.send(JSON.stringify({ type: "BTC_UPDATE", payload: btc }));

    const spx = getCachedSpx();
    ws.send(JSON.stringify({ type: "SPX_UPDATE", payload: spx }));

    // Feature 6: alerts + webhooks live in the DB now. We no longer accept
    // set_alerts / set_webhook client→server messages. Any client message
    // is a protocol violation — close the connection.
    ws.on("message", () => {
      ws.close(1003, "Unsupported data");
    });

    ws.on("close", () => {
      if (ws.userId) unregisterUserSocket(ws.userId, ws);
    });

    ws.on("error", (err) => {
      process.stderr.write(
        JSON.stringify({ event: "ws_error", message: err.message }) + "\n"
      );
    });
  });

  // ─── Broadcast helper ───────────────────────────────────────────
  const broadcast = (type: string, payload: unknown) => {
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({ type, payload }));
      }
    });
  };

  // ─── Scheduler subscriptions: broadcast + run alert worker ──────
  subscribeToFearGreed((data) => {
    broadcast("FEAR_GREED_UPDATE", data);
    void evaluateForMetric("fearGreed", {
      fearGreedScore: data.score ?? null,
      vixPrice: getCachedVix()?.price ?? null,
      btcPrice: getCachedBtc()?.price ?? null,
      spxPrice: getCachedSpx()?.price ?? null,
    });
  });

  subscribeToVix((data) => {
    broadcast("VIX_UPDATE", data);
    void evaluateForMetric("vix", {
      fearGreedScore: getCachedFearGreed()?.score ?? null,
      vixPrice: data?.price ?? null,
      btcPrice: getCachedBtc()?.price ?? null,
      spxPrice: getCachedSpx()?.price ?? null,
    });
  });

  subscribeToBtc((data) => {
    broadcast("BTC_UPDATE", data);
    void evaluateForMetric("btc", {
      fearGreedScore: getCachedFearGreed()?.score ?? null,
      vixPrice: getCachedVix()?.price ?? null,
      btcPrice: data?.price ?? null,
      spxPrice: getCachedSpx()?.price ?? null,
    });
  });

  subscribeToSpx((data) => {
    broadcast("SPX_UPDATE", data);
    void evaluateForMetric("spx", {
      fearGreedScore: getCachedFearGreed()?.score ?? null,
      vixPrice: getCachedVix()?.price ?? null,
      btcPrice: getCachedBtc()?.price ?? null,
      spxPrice: data?.price ?? null,
    });
  });

  process.stdout.write("WebSocket server started on same port as HTTP\n");
}
