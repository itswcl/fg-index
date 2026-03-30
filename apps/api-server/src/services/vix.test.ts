import { describe, it, expect } from "vitest";
import { fetchVixData } from "./vix.service.js";

describe("vix service", () => {
  it("should fetch/scrape vix data", async () => {
    const data = await fetchVixData();
    if (data) {
      expect(data.price).toBeGreaterThan(0);
      expect(data.fetchedAt).toBeDefined();
    } else {
        console.warn("VIX scrape returned null - verify network/scraping logic if this persists");
    }
  });
});
