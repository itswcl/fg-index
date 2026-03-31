import { WebSocketServer, WebSocket } from "ws";
import http from "http";
import { subscribeToFearGreed, getCachedFearGreed } from "./schedulers/fear-greed.scheduler.js";
import { subscribeToVix, getCachedVix } from "./schedulers/vix.scheduler.js";
import { MAX_WS_CONNECTIONS } from "./middlewares/rateLimit.js";

export function startWsServer(server: http.Server) {
  const wss = new WebSocketServer({ server });

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

    // Reject any client messages (broadcast-only server)
    ws.on("message", (data) => {
      ws.close(1003, "Unsupported data");
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
  });

  subscribeToVix((data) => {
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({ type: "VIX_UPDATE", payload: data }));
      }
    });
  });

  process.stdout.write("WebSocket server started on same port as HTTP\n");
}
