import express from "express";
import cors from "cors";
import helmet from "helmet";
import http from "http";
import { env } from "./config/env.js";
import fearGreedRouter from "./routes/fear-greed.routes.js";
import vixRouter from "./routes/vix.routes.js";
import btcRouter from "./routes/btc.routes.js";
import spxRouter from "./routes/spx.routes.js";
import tickerRouter from "./routes/ticker.routes.js";
import webhookRoutes from "./routes/webhook.routes.js";
import alertsRouter from "./routes/alerts.routes.js";
import userRouter from "./routes/user.routes.js";
import tickerListRouter from "./routes/ticker-list.routes.js";
import tickerGroupsRouter from "./routes/ticker-groups.routes.js";
import { startFearGreedScheduler } from "./schedulers/fear-greed.scheduler.js";
import { startVixScheduler } from "./schedulers/vix.scheduler.js";
import { startBtcScheduler } from "./schedulers/btc.scheduler.js";
import { startSpxScheduler } from "./schedulers/spx.scheduler.js";
import { startTickerQuoteScheduler } from "./schedulers/ticker-quote.scheduler.js";
import { startMarketStatusScheduler } from "./schedulers/market-status.scheduler.js";
import { startWsServer } from "./ws.js";
import { getHealth } from "./controllers/health.controller.js";
import { globalRateLimiter } from "./middlewares/rateLimit.js";
import { prisma } from "./services/db.js";

const SHUTDOWN_CONNECTION_GRACE_MS = 20_000;
const SHUTDOWN_DATABASE_GRACE_MS = 5_000;

const app = express();

// Configure CORS
const ALLOWED_ORIGINS = env.CORS_ORIGIN === "*"
  ? true
  : env.CORS_ORIGIN.split(",").map((s) => s.trim());

app.use(helmet()); // Set secure HTTP headers
app.use(cors({
  origin: ALLOWED_ORIGINS,
  methods: ["GET", "POST", "PUT", "DELETE"],
  allowedHeaders: ["X-API-KEY", "Content-Type", "Authorization"],
}));
app.use(express.json({ limit: "10kb" })); // Request size limit
app.set("trust proxy", 1); // Trust first proxy
app.use(globalRateLimiter); // Apply rate limiting to all requests

// Routes
app.use("/api/fear-greed", fearGreedRouter);
app.use("/api/vix", vixRouter);
app.use("/api/btc", btcRouter);
app.use("/api/spx", spxRouter);
app.use("/api/quote", tickerRouter);
app.use("/api/webhooks", webhookRoutes);
app.use("/api/alerts", alertsRouter);
app.use("/api/user/tickers", tickerListRouter);
app.use("/api/user/ticker-groups", tickerGroupsRouter);
app.use("/api/user", userRouter);

// Health check
app.get("/api/health", getHealth);
app.get("/health", getHealth); // Backward compatibility

if (env.SCHEDULERS_ENABLED) {
  startFearGreedScheduler();
  startVixScheduler();
  startBtcScheduler();
  startSpxScheduler();
  startTickerQuoteScheduler();
  startMarketStatusScheduler();
}

// Create HTTP server
const server = http.createServer(app);

// Start WS Server (on same port)
const wsServer = startWsServer(server);

// Start HTTP Server
server.listen(env.PORT, env.HOST, () => {
  process.stdout.write(`HTTP server started on ${env.HOST}:${env.PORT}\n`);
});

let shutdownStarted = false;

const shutdown = (signal: NodeJS.Signals) => {
  if (shutdownStarted) return;
  shutdownStarted = true;

  process.stdout.write(`Received ${signal}; draining HTTP and WebSocket connections\n`);

  const websocketClosed = new Promise<void>((resolve) => {
    wsServer.close(() => resolve());
  });
  const httpClosed = new Promise<void>((resolve) => {
    server.close((error) => {
      if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") {
        process.stderr.write(`HTTP server close failed: ${error.message}\n`);
      }
      resolve();
    });
  });

  for (const client of wsServer.clients) {
    client.close(1001, "Server shutting down");
  }

  const forceCloseTimer = setTimeout(() => {
    process.stderr.write("Shutdown connection grace expired; terminating remaining connections\n");
    server.closeAllConnections();
    for (const client of wsServer.clients) {
      client.terminate();
    }
  }, SHUTDOWN_CONNECTION_GRACE_MS);

  void Promise.all([httpClosed, websocketClosed]).then(async () => {
    clearTimeout(forceCloseTimer);

    // Scheduler-triggered alert evaluations are fire-and-forget and are not
    // included in this connection drain, so shutdown does not guarantee delivery.
    let databaseCloseTimer: NodeJS.Timeout | undefined;
    const databaseClosed = prisma.$disconnect().catch((error: unknown) => {
      process.stderr.write(
        `Prisma disconnect failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    });
    await Promise.race([
      databaseClosed,
      new Promise<void>((resolve) => {
        databaseCloseTimer = setTimeout(() => {
          process.stderr.write("Prisma disconnect grace expired; exiting\n");
          resolve();
        }, SHUTDOWN_DATABASE_GRACE_MS);
      }),
    ]);
    if (databaseCloseTimer) clearTimeout(databaseCloseTimer);

    process.stdout.write("Shutdown complete\n");
    process.exit(0);
  });
};

process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
