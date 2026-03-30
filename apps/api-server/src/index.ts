import express from "express";
import cors from "cors";
import helmet from "helmet";
import { env } from "./config/env.js";
import fearGreedRouter from "./routes/fear-greed.routes.js";
import vixRouter from "./routes/vix.routes.js";
import { startFearGreedScheduler } from "./schedulers/fear-greed.scheduler.js";
import { startVixScheduler } from "./schedulers/vix.scheduler.js";
import { startWsServer } from "./ws.js";
import { globalRateLimiter } from "./middlewares/rateLimit.js";

const app = express();

app.use(helmet()); // Set secure HTTP headers
app.use(cors({ origin: env.CORS_ORIGIN }));
app.use(express.json());
app.use(globalRateLimiter); // Apply rate limiting to all requests

// Routes
app.use("/api/fear-greed", fearGreedRouter);
app.use("/api/vix", vixRouter);

// Health check
app.get("/health", (req, res) => res.json({ status: "ok" }));

// Start Schedulers
startFearGreedScheduler();
startVixScheduler();

// Start WS Server
startWsServer();

// Start HTTP Server
app.listen(env.PORT, () => {
  process.stdout.write(`HTTP server started on port ${env.PORT}\n`);
});
