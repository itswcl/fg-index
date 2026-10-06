import { WebSocketServer, WebSocket } from "ws";
import http from "http";
import type { Duplex } from "node:stream";
import { URL } from "url";
import { subscribeToFearGreed, getCachedFearGreed } from "./schedulers/fear-greed.scheduler.js";
import { subscribeToVix, getCachedVix } from "./schedulers/vix.scheduler.js";
import { subscribeToBtc, getCachedBtc } from "./schedulers/btc.scheduler.js";
import { subscribeToSpx, getCachedSpx } from "./schedulers/spx.scheduler.js";
import { MAX_WS_CONNECTIONS } from "./middlewares/rateLimit.js";
import { verifySupabaseJwt } from "./middlewares/auth.js";
import {
  createWsAdmission,
  DEFAULT_WS_CONNECTIONS_PER_IP,
  DEFAULT_WS_UPGRADES_PER_IP,
  DEFAULT_WS_UPGRADE_WINDOW_MS,
  resolveWsClientIp,
  type WsAdmissionOptions,
} from "./services/wsAdmission.js";
import {
  registerUserSocket,
  unregisterUserSocket,
} from "./services/wsRegistry.js";
import { evaluateForMetric } from "./services/alertWorker.js";

const WS_MAX_PAYLOAD_BYTES = 4 * 1024;

// Attach userId to the socket once the ?token= is verified.
interface AuthedSocket extends WebSocket {
  userId?: string;
}

export type WsServerOptions = Partial<Omit<WsAdmissionOptions, "maxConnections">> & {
  maxConnections?: number;
  maxPayloadBytes?: number;
};

function rejectUpgrade(socket: Duplex, status: 400 | 503): void {
  const message = status === 400 ? "Bad Request" : "Service Unavailable";
  socket.end(
    `HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
}

function writeWsErrorEvent(): void {
  // Keep transport errors out of logs; peer-controlled payloads must not be
  // reflected, and authentication tokens/user claims are never logged.
  process.stderr.write('{"event":"ws_error"}\n');
}

export function startWsServer(server: http.Server, options: WsServerOptions = {}) {
  const admission = createWsAdmission({
    maxConnections: options.maxConnections ?? MAX_WS_CONNECTIONS,
    maxConnectionsPerIp: options.maxConnectionsPerIp ?? DEFAULT_WS_CONNECTIONS_PER_IP,
    maxUpgradesPerIp: options.maxUpgradesPerIp ?? DEFAULT_WS_UPGRADES_PER_IP,
    upgradeWindowMs: options.upgradeWindowMs ?? DEFAULT_WS_UPGRADE_WINDOW_MS,
    maxTrackedIps: options.maxTrackedIps,
    now: options.now,
  });
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: options.maxPayloadBytes ?? WS_MAX_PAYLOAD_BYTES,
    perMessageDeflate: false,
  });

  // HTTP middleware (including express-rate-limit) does not handle upgrades.
  // The loopback peer is Caddy; only then is its appended rightmost XFF entry
  // trusted as the public client address.
  const onUpgrade = (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
    const clientIp = resolveWsClientIp(
      req.socket.remoteAddress,
      req.headers["x-forwarded-for"],
    );
    if (!clientIp) {
      rejectUpgrade(socket, 400);
      return;
    }

    const result = admission.admit(clientIp);
    if (!result.allowed) {
      rejectUpgrade(socket, 503);
      return;
    }

    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      result.release();
    };
    socket.once("close", release);

    try {
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.once("close", release);
        wss.emit("connection", ws, req);
      });
    } catch {
      release();
      socket.destroy();
    }
  };
  server.on("upgrade", onUpgrade);

  wss.on("close", () => server.off("upgrade", onUpgrade));
  wss.on("error", writeWsErrorEvent);
  wss.on("wsClientError", (_error, socket) => socket.destroy());

  wss.on("connection", (ws: AuthedSocket, req) => {
    let closed = false;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      if (ws.userId) unregisterUserSocket(ws.userId, ws);
    };

    // Install all lifecycle handlers before authentication can yield. In
    // particular, ws emits `error` for protocol errors such as invalid RSV bits.
    ws.once("close", cleanup);
    ws.on("error", writeWsErrorEvent);
    ws.on("message", () => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.close(1003, "Unsupported data");
      }
    });

    void initializeConnection(ws, req).catch(() => {
      if (ws.readyState === WebSocket.OPEN) ws.close(1011, "Connection error");
      cleanup();
    });
  });

  async function initializeConnection(ws: AuthedSocket, req: http.IncomingMessage): Promise<void> {
    // Optional JWT via ?token=<jwt>. Anonymous connections are allowed —
    // they receive market data but no alert pushback.
    const url = new URL(req.url ?? "/", "http://localhost");
    const token = url.searchParams.get("token");
    if (token) {
      try {
        const payload = await verifySupabaseJwt(token);
        // Close/error may have happened while remote JWKS verification waited.
        if (ws.readyState !== WebSocket.OPEN) return;

        const sub = typeof payload.sub === "string" ? payload.sub : null;
        if (sub) {
          ws.userId = sub;
          registerUserSocket(sub, ws);
          // Keep the success event fixed; do not log token or user claims.
          process.stdout.write('{"event":"ws_auth_accepted"}\n');
        }
      } catch {
        if (ws.readyState !== WebSocket.OPEN) return;
        // A bad token becomes anonymous; never log its value or verifier detail.
        process.stderr.write('{"event":"ws_token_verify_failed"}\n');
      }
    }

    if (ws.readyState !== WebSocket.OPEN) return;
    sendSnapshot(ws, "FEAR_GREED_UPDATE", getCachedFearGreed());
    sendSnapshot(ws, "VIX_UPDATE", getCachedVix());
    sendSnapshot(ws, "BTC_UPDATE", getCachedBtc());
    sendSnapshot(ws, "SPX_UPDATE", getCachedSpx());
  }

  function sendSnapshot(ws: AuthedSocket, type: string, payload: unknown): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (type === "FEAR_GREED_UPDATE" && payload === null) return;
    try {
      ws.send(JSON.stringify({ type, payload }), (error) => {
        if (error) writeWsErrorEvent();
      });
    } catch {
      writeWsErrorEvent();
    }
  }

  // ─── Broadcast helper ───────────────────────────────────────────
  const broadcast = (type: string, payload: unknown) => {
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        try {
          client.send(JSON.stringify({ type, payload }), (error) => {
            if (error) writeWsErrorEvent();
          });
        } catch {
          writeWsErrorEvent();
        }
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
  return wss;
}
