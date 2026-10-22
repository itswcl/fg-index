import { afterEach, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
vi.mock("../schedulers/fear-greed.scheduler.js", () => ({ getCachedFearGreed: () => null }));
vi.mock("../schedulers/vix.scheduler.js", () => ({ getCachedVix: () => null }));
vi.mock("../schedulers/btc.scheduler.js", () => ({ getCachedBtc: () => ({ price: 100 }) }));
vi.mock("../schedulers/spx.scheduler.js", () => ({ getCachedSpx: () => null }));
vi.mock("../services/quote-refresh-queue.service.js", () => ({ getQuoteRefreshQueueStats: () => ({}) }));
vi.mock("../services/ticker-cache.service.js", () => ({ getTickerCacheStats: () => ({}) }));
vi.mock("../services/market-status.service.js", () => ({ getMarketStatusStats: () => ({}) }));
vi.mock("../services/background-db-circuit.service.js", () => ({ getBackgroundDbCircuitStats: () => ({}) }));
vi.mock("../services/alertWorker.js", () => ({ getAlertWorkerStats: () => ({}) }));
import { getHealth, recordBtcFetch } from "../controllers/health.controller.js";

afterEach(() => vi.useRealTimers());

function health() {
  const response = { status: vi.fn().mockReturnThis(), json: vi.fn() };
  getHealth({} as Request, response as unknown as Response);
  return response;
}

it("does not fail health for intentionally paused stocks, but still requires fresh BTC", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-18T19:00:00Z"));
  recordBtcFetch();
  expect(health().status).toHaveBeenCalledWith(200);
  expect(health().json).toHaveBeenCalledWith(expect.objectContaining({ stockUpdatesPaused: true }));
  vi.advanceTimersByTime(5 * 60_000);
  expect(health().status).toHaveBeenCalledWith(503);
});

it("allows one minute at opening, then reports missing stock feeds", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-19T13:00:00Z"));
  recordBtcFetch();
  expect(health().status).toHaveBeenCalledWith(200);
  vi.advanceTimersByTime(60_000);
  expect(health().status).toHaveBeenCalledWith(503);
});
