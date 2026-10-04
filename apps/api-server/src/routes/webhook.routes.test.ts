import express, { type Request, type Response, type NextFunction } from "express";
import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import router from "./webhook.routes.js";

// Real router/HTTP dispatch, isolated auth/controller fakes: no DB or delivery.
const handlers = vi.hoisted(() => ({ test: vi.fn() }));
vi.mock("../middlewares/auth.js", () => ({
  authMiddleware: (req: Request, res: Response, next: NextFunction) => {
    if (req.header("Authorization") !== "Bearer fixture-jwt") {
      res.status(401).json({ error: "Unauthenticated" }); return;
    }
    next();
  },
}));
vi.mock("../controllers/webhookConfig.controller.js", () => ({
  getMyWebhook: vi.fn(), upsertMyWebhook: vi.fn(), deleteMyWebhook: vi.fn(),
  testMyWebhook: handlers.test,
}));
vi.mock("../controllers/webhooks.controller.js", () => ({
  listWebhooks: vi.fn(), createWebhook: vi.fn(), updateWebhook: vi.fn(), deleteWebhook: vi.fn(),
  testWebhookById: handlers.test,
}));
let server: Server;
let origin: string;
beforeEach(async () => {
  handlers.test.mockReset().mockImplementation((_req: Request, res: Response) => res.json({ ok: true }));
  const app = express(); app.use(express.json()); app.use("/api/webhooks", router);
  server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject); server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture listener unavailable");
  origin = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });

describe("webhook test route authentication", () => {
  it("removed legacy route cannot initiate an ad-hoc send even with the public API key", async () => {
    const response = await fetch(`${origin}/api/webhooks/test`, {
      method: "POST", headers: { "Content-Type": "application/json", "X-API-KEY": "public-key" },
      body: JSON.stringify({ webhook: { type: "generic", url: "http://169.254.169.254/" } }),
    });
    expect(response.status).toBe(404);
    expect(handlers.test).not.toHaveBeenCalled();
  });
  it.each(["me", "fixture-id"])("saved %s test still requires JWT", async (id) => {
    const response = await fetch(`${origin}/api/webhooks/${id}/test`, { method: "POST" });
    expect(response.status).toBe(401);
    expect(handlers.test).not.toHaveBeenCalled();
  });
  it("saved ID test supports the current frontend's authenticated empty-body request", async () => {
    const response = await fetch(`${origin}/api/webhooks/fixture-id/test`, {
      method: "POST", headers: { Authorization: "Bearer fixture-jwt" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(handlers.test).toHaveBeenCalledOnce();
  });
});
