import { describe, it, expect } from "vitest";
import { fetchCnnData } from "./cnn.service.js";

describe("cnn service", () => {
  it("should fetch and parse cnn data", async () => {
    const data = await fetchCnnData();
    expect(data).toBeDefined();
    expect(data.score).toBeGreaterThanOrEqual(0);
    expect(data.score).toBeLessThanOrEqual(100);
    expect(data.classification).toBeDefined();
    expect(data.updatedAt).toBeDefined();
  });
});
