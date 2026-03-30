import { WebSocketServer, WebSocket } from "ws";
import { env } from "./config/env.js";
import { subscribeToFearGreed, getCachedFearGreed } from "./schedulers/fear-greed.scheduler.js";
import { subscribeToVix, getCachedVix } from "./schedulers/vix.scheduler.js";

export function startWsServer() {
  const wss = new WebSocketServer({ port: env.WS_PORT });

  wss.on("connection", (ws) => {
    // Send initial data
    const fg = getCachedFearGreed();
    if (fg) {
      ws.send(JSON.stringify({ type: "FEAR_GREED_UPDATE", payload: fg }));
    }

    const vix = getCachedVix();
    ws.send(JSON.stringify({ type: "VIX_UPDATE", payload: vix }));

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

  process.stdout.write(`WebSocket server started on port ${env.WS_PORT}\n`);
}
