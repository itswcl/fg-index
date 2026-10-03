import type { Server } from "node:http";
import type { WebSocket, WebSocketServer } from "ws";

export const SHUTDOWN_CONNECTION_GRACE_MS = 20_000;
const SHUTDOWN_DATABASE_GRACE_MS = 5_000;

interface Output {
  write(chunk: string): unknown;
}

interface ShutdownDependencies {
  httpServer: Pick<Server, "close" | "closeAllConnections">;
  websocketServer: Pick<WebSocketServer, "close" | "clients">;
  drainAlertWorker: () => Promise<void>;
  getInFlightAlertEvaluationCount: () => number;
  disconnect: () => Promise<unknown>;
  exit: (code: number) => unknown;
  stdout?: Output;
  stderr?: Output;
}

export function createShutdownHandler({
  httpServer,
  websocketServer,
  drainAlertWorker,
  getInFlightAlertEvaluationCount,
  disconnect,
  exit,
  stdout = process.stdout,
  stderr = process.stderr,
}: ShutdownDependencies): (signal: NodeJS.Signals) => void {
  let shutdownStarted = false;

  return (signal) => {
    if (shutdownStarted) return;
    shutdownStarted = true;

    stdout.write(`Received ${signal}; draining HTTP and WebSocket connections\n`);

    // Close scheduler admission immediately. Existing evaluations, including
    // their webhook fan-out, share the same 20s grace window as connections.
    const alertWorkerDrained = drainAlertWorker();

    const websocketClosed = new Promise<void>((resolve) => {
      websocketServer.close(() => resolve());
    });
    const httpClosed = new Promise<void>((resolve) => {
      httpServer.close((error) => {
        if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") {
          stderr.write(`HTTP server close failed: ${error.message}\n`);
        }
        resolve();
      });
    });

    for (const client of websocketServer.clients) {
      client.close(1001, "Server shutting down");
    }

    void (async () => {
      let graceTimer: NodeJS.Timeout | undefined;
      const graceExpired = new Promise<void>((resolve) => {
        graceTimer = setTimeout(() => {
          const inFlightCount = getInFlightAlertEvaluationCount();
          if (inFlightCount > 0) {
            stderr.write(
              `Shutdown grace expired; ${inFlightCount} alert evaluations remain in flight\n` +
              "Webhook delivery is best-effort; a persisted lastTriggeredAt may suppress an interrupted delivery until cooldown expires\n"
            );
          } else {
            stderr.write("Shutdown grace expired; terminating remaining connections\n");
          }
          httpServer.closeAllConnections();
          for (const client of websocketServer.clients) {
            client.terminate();
          }
          resolve();
        }, SHUTDOWN_CONNECTION_GRACE_MS);
      });

      await Promise.race([
        Promise.all([httpClosed, websocketClosed, alertWorkerDrained]),
        graceExpired,
      ]);
      if (graceTimer) clearTimeout(graceTimer);

      // The 20s shared grace plus the 5s Prisma cap stays within the drafted
      // systemd TimeoutStopSec=30s budget.
      let databaseCloseTimer: NodeJS.Timeout | undefined;
      const databaseClosed = disconnect().catch((error: unknown) => {
        stderr.write(
          `Prisma disconnect failed: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      });
      await Promise.race([
        databaseClosed,
        new Promise<void>((resolve) => {
          databaseCloseTimer = setTimeout(() => {
            stderr.write("Prisma disconnect grace expired; exiting\n");
            resolve();
          }, SHUTDOWN_DATABASE_GRACE_MS);
        }),
      ]);
      if (databaseCloseTimer) clearTimeout(databaseCloseTimer);

      stdout.write("Shutdown complete\n");
      exit(0);
    })();
  };
}
