import { createServer, type Server } from "node:http";
import { connect, type Socket } from "node:net";
import { randomBytes } from "node:crypto";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { __setVerifyOverrideForTests } from "../middlewares/auth.js";
import { startWsServer } from "../ws.js";
import * as wsRegistry from "../services/wsRegistry.js";
import {
  __clearRegistryForTests,
  getSocketsForUser,
} from "../services/wsRegistry.js";

const TEST_USER_ID = "ws-lifecycle-test-user";

let httpServer: Server;
let wsServer: ReturnType<typeof startWsServer>;
let wsUrl: string;
const clients: WebSocket[] = [];
const rawSockets: Socket[] = [];

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
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

function openClient(url: string): Promise<WebSocket> {
  const client = new WebSocket(url);
  clients.push(client);
  return new Promise((resolve, reject) => {
    client.once("open", () => resolve(client));
    client.once("error", reject);
  });
}

function connectRawWebSocket(url: string): Promise<Socket> {
  const address = new URL(url);
  const socket = connect(Number(address.port), "127.0.0.1");
  rawSockets.push(socket);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for WebSocket upgrade")), 3000);
    let response = Buffer.alloc(0);
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.on("connect", () => {
      const key = randomBytes(16).toString("base64");
      socket.write(
        `GET ${address.pathname}${address.search} HTTP/1.1\r\n` +
          `Host: 127.0.0.1:${address.port}\r\n` +
          "Upgrade: websocket\r\n" +
          "Connection: Upgrade\r\n" +
          `Sec-WebSocket-Key: ${key}\r\n` +
          "Sec-WebSocket-Version: 13\r\n\r\n",
      );
    });
    socket.on("data", (chunk) => {
      response = Buffer.concat([response, chunk]);
      const boundary = response.indexOf("\r\n\r\n");
      if (boundary === -1) return;
      clearTimeout(timer);
      const status = response.subarray(0, boundary).toString("ascii").split("\r\n", 1)[0];
      if (!status?.includes(" 101 ")) {
        reject(new Error(`Expected an upgraded connection, received ${status}`));
        return;
      }
      resolve(socket);
    });
  });
}

beforeEach(async () => {
  __clearRegistryForTests();
  __setVerifyOverrideForTests(null);
  clients.length = 0;
  rawSockets.length = 0;
  httpServer = createServer();
  wsServer = startWsServer(httpServer);
  await listen(httpServer);
  const address = httpServer.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP test server");
  wsUrl = `ws://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await Promise.all(clients.map(closeClient));
  for (const socket of rawSockets) socket.destroy();
  await new Promise<void>((resolve) => wsServer.close(() => resolve()));
  await new Promise<void>((resolve, reject) => {
    httpServer.close((error) => (error ? reject(error) : resolve()));
  });
  __setVerifyOverrideForTests(null);
  __clearRegistryForTests();
  vi.restoreAllMocks();
});

describe("WebSocket lifecycle during authentication", () => {
  it("handles a protocol error while verification is pending and never registers after close", async () => {
    let resolveVerification!: (payload: { sub: string }) => void;
    let markVerificationStarted!: () => void;
    const verificationStarted = new Promise<void>((resolve) => {
      markVerificationStarted = resolve;
    });
    __setVerifyOverrideForTests(
      () =>
        new Promise((resolve) => {
          markVerificationStarted();
          resolveVerification = resolve;
        }),
    );
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const raw = await connectRawWebSocket(`${wsUrl}/?token=synthetic-pending-token`);
    await verificationStarted;

    const serverSocket = [...wsServer.clients][0];
    expect(serverSocket).toBeDefined();
    expect(serverSocket?.listenerCount("error")).toBeGreaterThan(0);
    const sent = vi.spyOn(serverSocket!, "send");
    const closed = new Promise<void>((resolve) => serverSocket!.once("close", () => resolve()));

    // A masked client text frame with RSV1 set is rejected by ws because
    // compression was not negotiated. This is the protocol-error/crash path.
    raw.write(Buffer.from([0xc1, 0x81, 0x01, 0x02, 0x03, 0x04, 0x79]));
    await closed;
    expect(stderrSpy.mock.calls.some(([line]) => String(line).includes('"event":"ws_error"'))).toBe(
      true,
    );

    resolveVerification({ sub: TEST_USER_ID });
    await nextTurn();
    expect(getSocketsForUser(TEST_USER_ID)).toEqual([]);
    expect(sent).not.toHaveBeenCalled();
  });

  it("does not register or send to a socket closed before verification resolves", async () => {
    let resolveVerification!: (payload: { sub: string }) => void;
    let markVerificationStarted!: () => void;
    const verificationStarted = new Promise<void>((resolve) => {
      markVerificationStarted = resolve;
    });
    __setVerifyOverrideForTests(
      () =>
        new Promise((resolve) => {
          markVerificationStarted();
          resolveVerification = resolve;
        }),
    );

    const client = await openClient(`${wsUrl}/?token=synthetic-pending-token`);
    await verificationStarted;
    const serverSocket = [...wsServer.clients][0]!;
    const sent = vi.spyOn(serverSocket, "send");
    expect(serverSocket.listenerCount("close")).toBeGreaterThan(0);
    expect(serverSocket.listenerCount("message")).toBeGreaterThan(0);
    expect(serverSocket.listenerCount("error")).toBeGreaterThan(0);

    const closed = new Promise<void>((resolve) => serverSocket.once("close", () => resolve()));
    client.close();
    await closed;
    resolveVerification({ sub: TEST_USER_ID });
    await nextTurn();

    expect(getSocketsForUser(TEST_USER_ID)).toEqual([]);
    expect(sent).not.toHaveBeenCalled();
  });

  it("keeps multiple authenticated tabs registered independently and cleans up each close", async () => {
    __setVerifyOverrideForTests(async () => ({ sub: TEST_USER_ID }));
    const unregister = vi.spyOn(wsRegistry, "unregisterUserSocket");
    const first = await openClient(`${wsUrl}/?token=synthetic-tab-one`);
    const firstServerSocket = [...wsServer.clients][0]!;
    expect(getSocketsForUser(TEST_USER_ID)).toContain(firstServerSocket);

    const second = await openClient(`${wsUrl}/?token=synthetic-tab-two`);
    const serverSockets = [...wsServer.clients];
    const secondServerSocket = serverSockets.find((socket) => socket !== firstServerSocket)!;
    expect(getSocketsForUser(TEST_USER_ID)).toHaveLength(2);

    const firstClosed = new Promise<void>((resolve) => firstServerSocket.once("close", () => resolve()));
    first.close();
    await firstClosed;
    expect(getSocketsForUser(TEST_USER_ID)).toEqual([secondServerSocket]);
    expect(unregister).toHaveBeenCalledTimes(1);

    const secondClosed = new Promise<void>((resolve) => secondServerSocket.once("close", () => resolve()));
    second.close();
    await secondClosed;
    expect(getSocketsForUser(TEST_USER_ID)).toEqual([]);
    expect(unregister).toHaveBeenCalledTimes(2);
  });

  it("keeps an invalid token anonymous while preserving public snapshots", async () => {
    __setVerifyOverrideForTests(async () => {
      throw new Error("synthetic verifier failure");
    });
    const client = new WebSocket(`${wsUrl}/?token=synthetic-invalid-token`);
    clients.push(client);
    const message = await new Promise<string>((resolve, reject) => {
      client.once("message", (data) => resolve(data.toString()));
      client.once("error", reject);
    });

    expect(JSON.parse(message)).toMatchObject({ type: "VIX_UPDATE" });
    expect(getSocketsForUser(TEST_USER_ID)).toEqual([]);
  });
});
