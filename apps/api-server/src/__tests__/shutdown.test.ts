import type { Server } from "node:http";
import type { WebSocket, WebSocketServer } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createShutdownHandler } from "../services/shutdown.js";

describe("API shutdown grace period", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("terminates stuck connections at 20 seconds, then disconnects and exits", async () => {
    vi.useFakeTimers();

    let httpCloseCallback: (() => void) | undefined;
    let websocketCloseCallback: (() => void) | undefined;
    const websocketClients = new Set<WebSocket>();
    const httpServer = {
      close: vi.fn((callback: (() => void) | undefined) => {
        httpCloseCallback = callback;
      }),
      closeAllConnections: vi.fn(() => httpCloseCallback?.()),
    } as unknown as Server;
    const websocketServer = {
      clients: websocketClients,
      close: vi.fn((callback: (() => void) | undefined) => {
        websocketCloseCallback = callback;
      }),
    } as unknown as WebSocketServer;
    const client = {
      close: vi.fn(),
      terminate: vi.fn(() => {
        websocketClients.delete(client as unknown as WebSocket);
        websocketCloseCallback?.();
      }),
    } as unknown as WebSocket;
    websocketClients.add(client);

    const stdout: string[] = [];
    const stderr: string[] = [];
    const drainAlertWorker = vi.fn(async () => undefined);
    const disconnect = vi.fn(async () => undefined);
    const exit = vi.fn();
    const shutdown = createShutdownHandler({
      httpServer,
      websocketServer,
      drainAlertWorker,
      getInFlightAlertEvaluationCount: () => 0,
      disconnect,
      exit,
      stdout: { write: (chunk: string) => stdout.push(chunk) },
      stderr: { write: (chunk: string) => stderr.push(chunk) },
    });

    shutdown("SIGTERM");
    expect(drainAlertWorker).toHaveBeenCalledOnce();
    expect(client.close).toHaveBeenCalledWith(1001, "Server shutting down");

    await vi.advanceTimersByTimeAsync(19_999);
    expect(httpServer.closeAllConnections).not.toHaveBeenCalled();
    expect(client.terminate).not.toHaveBeenCalled();
    expect(disconnect).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);

    expect(stderr.join("")).toContain(
      "Shutdown grace expired; terminating remaining connections\n"
    );
    expect(httpServer.closeAllConnections).toHaveBeenCalledOnce();
    expect(client.terminate).toHaveBeenCalledOnce();
    expect(websocketClients.size).toBe(0);
    expect(disconnect).toHaveBeenCalledOnce();
    expect(stdout.join("")).toContain("Shutdown complete\n");
    expect(exit).toHaveBeenCalledWith(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(stderr.join("")).not.toContain("alert evaluations remain in flight");
  });

  it("clears the timeout when HTTP, WebSocket, and alert work drain normally", async () => {
    vi.useFakeTimers();

    const httpServer = {
      close: vi.fn((callback: (() => void) | undefined) => callback?.()),
      closeAllConnections: vi.fn(),
    } as unknown as Server;
    const websocketServer = {
      clients: new Set<WebSocket>(),
      close: vi.fn((callback: (() => void) | undefined) => callback?.()),
    } as unknown as WebSocketServer;
    const exit = vi.fn();
    const shutdown = createShutdownHandler({
      httpServer,
      websocketServer,
      drainAlertWorker: async () => undefined,
      getInFlightAlertEvaluationCount: () => 0,
      disconnect: async () => undefined,
      exit,
      stdout: { write: vi.fn() },
      stderr: { write: vi.fn() },
    });

    shutdown("SIGTERM");
    await vi.advanceTimersByTimeAsync(0);

    expect(httpServer.closeAllConnections).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
