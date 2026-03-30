import { describe, it, expect, beforeAll } from "vitest";
import { FearGreedSchema, VixSchema } from "@shared/types";

const BASE_URL = "http://localhost:8080";

describe("Integration: GET /health", () => {
  it("returns status ok", async () => {
    const res = await fetch(`${BASE_URL}/health`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ status: "ok" });
  });
});

describe("Integration: GET /api/fear-greed", () => {
  it("returns 200 with valid FearGreed shape", async () => {
    const res = await fetch(`${BASE_URL}/api/fear-greed`);
    expect(res.status).toBe(200);

    // Verify Cache-Control header
    expect(res.headers.get("cache-control")).toContain("max-age=1800");

    const json = await res.json();
    const result = FearGreedSchema.safeParse(json);
    if (!result.success) {
      console.error("Zod validation errors:", result.error.format());
    }
    expect(result.success).toBe(true);
  });

  it("score is in range 0–100", async () => {
    const res = await fetch(`${BASE_URL}/api/fear-greed`);
    const json = await res.json();
    expect(json.score).toBeGreaterThanOrEqual(0);
    expect(json.score).toBeLessThanOrEqual(100);
  });

  it("classification is one of the five valid values", async () => {
    const res = await fetch(`${BASE_URL}/api/fear-greed`);
    const json = await res.json();
    expect([
      "Extreme Fear",
      "Fear",
      "Neutral",
      "Greed",
      "Extreme Greed",
    ]).toContain(json.classification);
  });

  it("updatedAt is a valid ISO 8601 datetime", async () => {
    const res = await fetch(`${BASE_URL}/api/fear-greed`);
    const json = await res.json();
    expect(new Date(json.updatedAt).toString()).not.toBe("Invalid Date");
  });
});

describe("Integration: GET /api/vix", () => {
  it("returns 200", async () => {
    const res = await fetch(`${BASE_URL}/api/vix`);
    expect(res.status).toBe(200);
  });

  it("has correct Cache-Control header", async () => {
    const res = await fetch(`${BASE_URL}/api/vix`);
    expect(res.headers.get("cache-control")).toContain("max-age=300");
  });

  it("returns valid VIX shape or null (PRD null-safe)", async () => {
    const res = await fetch(`${BASE_URL}/api/vix`);
    const json = await res.json();

    if (json === null) {
      // Both scrapers failed — this is an accepted PRD state
      expect(json).toBeNull();
    } else {
      const result = VixSchema.safeParse(json);
      if (!result.success) {
        console.error("Zod validation errors:", result.error.format());
      }
      expect(result.success).toBe(true);
    }
  });

  it("price is positive when vix data is available", async () => {
    const res = await fetch(`${BASE_URL}/api/vix`);
    const json = await res.json();
    if (json !== null) {
      expect(json.price).toBeGreaterThan(0);
    }
  });

  it("fetchedAt is a valid ISO 8601 timestamp", async () => {
    const res = await fetch(`${BASE_URL}/api/vix`);
    const json = await res.json();
    if (json !== null) {
      expect(new Date(json.fetchedAt).toString()).not.toBe("Invalid Date");
    }
  });
});
