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
import tickerListRouter from "./routes/ticker-list.routes.js";
import { startFearGreedScheduler } from "./schedulers/fear-greed.scheduler.js";
import { startVixScheduler } from "./schedulers/vix.scheduler.js";
import { startBtcScheduler } from "./schedulers/btc.scheduler.js";
import { startSpxScheduler } from "./schedulers/spx.scheduler.js";
import { startWsServer } from "./ws.js";
import { getHealth } from "./controllers/health.controller.js";
import { globalRateLimiter } from "./middlewares/rateLimit.js";

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

// Health check
app.get("/api/health", getHealth);
app.get("/health", getHealth); // Backward compatibility

// Start Schedulers
startFearGreedScheduler();
startVixScheduler();
startBtcScheduler();
startSpxScheduler();

// Create HTTP server
const server = http.createServer(app);

// Start WS Server (on same port)
startWsServer(server);

// Start HTTP Server
server.listen(env.PORT, () => {
  process.stdout.write(`HTTP server started on port ${env.PORT}\n`);
});
