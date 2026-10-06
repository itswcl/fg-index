import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { startWsServer, type WsServerOptions } from "../ws.js";

let httpServer: Server;
let wsServer: ReturnType<typeof startWsServer>;
let wsUrl: string;
const clients: WebSocket[] = [];

function startServer(options: WsServerOptions): Promise<void> {
  httpServer = createServer();
  wsServer = startWsServer(httpServer, options);
  return new Promise((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(0, "127.0.0.1", () => {
      const address = httpServer.address();
      if (!address || typeof address === "string") {
        reject(new Error("Expected a TCP test server"));
        return;
      }
      wsUrl = `ws://127.0.0.1:${address.port}`;
      resolve();
    });
  });
}

function openClient(): Promise<WebSocket> {
  const client = new WebSocket(wsUrl);
  clients.push(client);
  return new Promise((resolve, reject) => {
    client.once("open", () => resolve(client));
    client.once("error", reject);
  });
}

function expectRejectedClient(): Promise<string> {
  const client = new WebSocket(wsUrl);
  clients.push(client);
  return new Promise((resolve, reject) => {
    client.once("open", () => reject(new Error("Expected upgrade rejection")));
    client.once("error", (error) => {
      client.once("close", () => resolve(error.message));
    });
  });
}

async function closeClient(client: WebSocket): Promise<void> {
  if (client.readyState === WebSocket.CLOSED) return;
  await new Promise<void>((resolve) => {
    client.once("close", () => resolve());
    if (client.readyState === WebSocket.OPEN) client.close();
    else client.once("open", () => client.close());
  });
}

beforeEach(() => {
  clients.length = 0;
});

afterEach(async () => {
  await Promise.all(clients.map(closeClient));
  await new Promise<void>((resolve) => wsServer.close(() => resolve()));
  await new Promise<void>((resolve, reject) => {
    httpServer.close((error) => (error ? reject(error) : resolve()));
  });
});

describe("WebSocket upgrade admission", () => {
  it("rejects a second connection for one IP and allows a reconnect after cleanup", async () => {
    await startServer({ maxConnections: 10, maxConnectionsPerIp: 1 });
    const first = await openClient();

    expect(await expectRejectedClient()).toContain("503");
    await closeClient(first);

    const reconnected = await openClient();
    expect(reconnected.readyState).toBe(WebSocket.OPEN);
  });

  it("enforces the exact global cap before completing another upgrade", async () => {
    await startServer({ maxConnections: 1, maxConnectionsPerIp: 10 });
    const first = await openClient();

    expect(await expectRejectedClient()).toContain("503");
    await closeClient(first);

    const reconnected = await openClient();
    expect(reconnected.readyState).toBe(WebSocket.OPEN);
  });

  it("accepts the configured payload boundary but rejects a larger message", async () => {
    await startServer({ maxConnections: 5, maxConnectionsPerIp: 5, maxPayloadBytes: 32 });
    const atBoundary = await openClient();
    const boundaryClose = new Promise<number>((resolve) => {
      atBoundary.once("close", (code) => resolve(code));
    });
    atBoundary.send(Buffer.alloc(32));
    expect(await boundaryClose).toBe(1003);

    const oversized = await openClient();
    const oversizedClose = new Promise<number>((resolve) => {
      oversized.once("close", (code) => resolve(code));
    });
    oversized.send(Buffer.alloc(33));
    expect(await oversizedClose).toBe(1009);
  });
});
