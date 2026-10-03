import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { __setVerifyOverrideForTests } from "../middlewares/auth.js";
import { startWsServer } from "../ws.js";
import {
  __clearRegistryForTests,
  getSocketsForUser,
} from "../services/wsRegistry.js";

const AUTHENTICATED_USER_ID = "ws-auth-test-user";

let httpServer: Server;
let wsServer: ReturnType<typeof startWsServer>;
let wsUrl: string;
const clients: WebSocket[] = [];

function connectAndReadFirstMessage(url: string): Promise<WebSocket> {
  const client = new WebSocket(url);
  clients.push(client);

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      client.close();
      reject(new Error("Timed out waiting for the initial WebSocket message"));
    }, 3000);

    client.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    client.once("message", () => {
      clearTimeout(timer);
      resolve(client);
    });
  });
}

async function closeClient(client: WebSocket): Promise<void> {
  if (client.readyState === WebSocket.CLOSED) return;
  await new Promise<void>((resolve) => {
    client.once("close", () => resolve());
    if (client.readyState === WebSocket.OPEN) {
      client.close();
    } else {
      client.once("open", () => client.close());
    }
  });
}

beforeEach(async () => {
  __clearRegistryForTests();
  __setVerifyOverrideForTests(null);
  clients.length = 0;

  httpServer = createServer();
  wsServer = startWsServer(httpServer);
  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(0, "127.0.0.1", () => resolve());
  });

  const address = httpServer.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected a TCP address for the WebSocket test server");
  }
  wsUrl = `ws://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await Promise.all(clients.map(closeClient));
  await new Promise<void>((resolve) => wsServer.close(() => resolve()));
  await new Promise<void>((resolve, reject) => {
    httpServer.close((error) => (error ? reject(error) : resolve()));
  });
  __setVerifyOverrideForTests(null);
  __clearRegistryForTests();
  vi.restoreAllMocks();
});

describe("WebSocket authentication acceptance log", () => {
  it("logs acceptance only after verification and socket registration", async () => {
    __setVerifyOverrideForTests(async () => ({ sub: AUTHENTICATED_USER_ID }));
    let socketsRegisteredWhenLogged = 0;
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      if (String(chunk).includes('"event":"ws_auth_accepted"')) {
        socketsRegisteredWhenLogged = getSocketsForUser(AUTHENTICATED_USER_ID).length;
      }
      return true;
    });

    await connectAndReadFirstMessage(`${wsUrl}?token=known-test-token`);

    const acceptedEvents = stdoutSpy.mock.calls
      .map(([chunk]) => String(chunk))
      .filter((line) => line.includes('"event":"ws_auth_accepted"'));
    expect(acceptedEvents).toEqual(['{"event":"ws_auth_accepted"}\n']);
    expect(socketsRegisteredWhenLogged).toBe(1);
    expect(acceptedEvents[0]).not.toContain(AUTHENTICATED_USER_ID);
  });

  it("does not log acceptance for an anonymous connection", async () => {
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await connectAndReadFirstMessage(wsUrl);

    expect(stdoutSpy.mock.calls.map(([chunk]) => String(chunk))).not.toContain(
      '{"event":"ws_auth_accepted"}\n'
    );
    expect(getSocketsForUser(AUTHENTICATED_USER_ID)).toEqual([]);
  });

  it("does not log acceptance when token verification fails", async () => {
    __setVerifyOverrideForTests(async () => {
      throw new Error("invalid test token");
    });
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await connectAndReadFirstMessage(`${wsUrl}?token=invalid-test-token`);

    expect(stdoutSpy.mock.calls.map(([chunk]) => String(chunk))).not.toContain(
      '{"event":"ws_auth_accepted"}\n'
    );
    expect(getSocketsForUser(AUTHENTICATED_USER_ID)).toEqual([]);
  });
});
