import { describe, it, expect } from "vitest";
import { evaluateAlerts } from "../services/alertEvaluator.js";
import type { Alert } from "@shared/types";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeAlert(overrides: Partial<Alert> = {}): Alert {
  return {
    id: "alert-1",
    name: "Test Alert",
    conditions: [],
    logic: "AND",
    enabled: true,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("evaluateAlerts()", () => {
  it("returns empty array when alerts list is empty", () => {
    const result = evaluateAlerts([], 8, 25);
    expect(result).toEqual([]);
  });

  it("fearGreed < 10 with score 8 → triggers", () => {
    const alert = makeAlert({
      conditions: [{ metric: "fearGreed", operator: "<", value: 10 }],
    });
    const result = evaluateAlerts([alert], 8, null);
    expect(result).toHaveLength(1);
    expect(result[0].alertId).toBe("alert-1");
    expect(result[0].type).toBe("alert_triggered");
    expect(result[0].message).toContain("Fear & Greed is 8 (< 10)");
  });

  it("fearGreed < 10 with score 15 → does not trigger", () => {
    const alert = makeAlert({
      conditions: [{ metric: "fearGreed", operator: "<", value: 10 }],
    });
    const result = evaluateAlerts([alert], 15, null);
    expect(result).toHaveLength(0);
  });

  it("AND logic: both conditions must match — triggers when both pass", () => {
    const alert = makeAlert({
      logic: "AND",
      conditions: [
        { metric: "fearGreed", operator: "<", value: 10 },
        { metric: "vix", operator: ">", value: 30 },
      ],
    });
    const result = evaluateAlerts([alert], 8, 32.1);
    expect(result).toHaveLength(1);
    expect(result[0].message).toContain("AND");
  });

  it("AND logic: does not trigger when only one condition passes", () => {
    const alert = makeAlert({
      logic: "AND",
      conditions: [
        { metric: "fearGreed", operator: "<", value: 10 },
        { metric: "vix", operator: ">", value: 30 },
      ],
    });
    // fearGreed passes (8 < 10) but vix fails (20 is NOT > 30)
    const result = evaluateAlerts([alert], 8, 20);
    expect(result).toHaveLength(0);
  });

  it("OR logic: triggers when at least one condition passes", () => {
    const alert = makeAlert({
      logic: "OR",
      conditions: [
        { metric: "fearGreed", operator: "<", value: 10 },
        { metric: "vix", operator: ">", value: 30 },
      ],
    });
    // Only fearGreed passes (8 < 10); vix fails (20 is NOT > 30)
    const result = evaluateAlerts([alert], 8, 20);
    expect(result).toHaveLength(1);
  });

  it("OR logic: does not trigger when no conditions pass", () => {
    const alert = makeAlert({
      logic: "OR",
      conditions: [
        { metric: "fearGreed", operator: "<", value: 10 },
        { metric: "vix", operator: ">", value: 30 },
      ],
    });
    const result = evaluateAlerts([alert], 50, 20);
    expect(result).toHaveLength(0);
  });

  it("null vix → skips vix condition; AND is true when other conditions pass", () => {
    const alert = makeAlert({
      logic: "AND",
      conditions: [
        { metric: "fearGreed", operator: "<", value: 10 },
        { metric: "vix", operator: ">", value: 30 },
      ],
    });
    // vix is null so vix condition is skipped; fearGreed passes → alert fires
    const result = evaluateAlerts([alert], 8, null);
    expect(result).toHaveLength(1);
    expect(result[0].message).not.toContain("VIX");
  });

  it("null vix with all conditions null → does not trigger", () => {
    const alert = makeAlert({
      conditions: [{ metric: "vix", operator: ">", value: 30 }],
    });
    const result = evaluateAlerts([alert], null, null);
    expect(result).toHaveLength(0);
  });

  // ─── BTC ────────────────────────────────────────────────────────────────────

  it("btc > 100000 with price 105000 → triggers", () => {
    const alert = makeAlert({
      conditions: [{ metric: "btc", operator: ">", value: 100000 }],
    });
    const result = evaluateAlerts([alert], null, null, 105000, null);
    expect(result).toHaveLength(1);
    expect(result[0].message).toContain("BTC is 105000 (> 100000)");
  });

  it("btc > 100000 with price 95000 → does not trigger", () => {
    const alert = makeAlert({
      conditions: [{ metric: "btc", operator: ">", value: 100000 }],
    });
    const result = evaluateAlerts([alert], null, null, 95000, null);
    expect(result).toHaveLength(0);
  });

  it("null btc → skips btc condition in AND; other passing conditions still fire", () => {
    const alert = makeAlert({
      logic: "AND",
      conditions: [
        { metric: "fearGreed", operator: "<", value: 10 },
        { metric: "btc", operator: ">", value: 100000 },
      ],
    });
    const result = evaluateAlerts([alert], 8, null, null, null);
    expect(result).toHaveLength(1);
    expect(result[0].message).not.toContain("BTC");
  });

  it("null btc with only btc condition → does not trigger", () => {
    const alert = makeAlert({
      conditions: [{ metric: "btc", operator: ">", value: 100000 }],
    });
    const result = evaluateAlerts([alert], null, null, null, null);
    expect(result).toHaveLength(0);
  });

  // ─── SPX ────────────────────────────────────────────────────────────────────

  it("spx < 5000 with price 4800 → triggers", () => {
    const alert = makeAlert({
      conditions: [{ metric: "spx", operator: "<", value: 5000 }],
    });
    const result = evaluateAlerts([alert], null, null, null, 4800);
    expect(result).toHaveLength(1);
    expect(result[0].message).toContain("SPX is 4800 (< 5000)");
  });

  it("spx < 5000 with price 5200 → does not trigger", () => {
    const alert = makeAlert({
      conditions: [{ metric: "spx", operator: "<", value: 5000 }],
    });
    const result = evaluateAlerts([alert], null, null, null, 5200);
    expect(result).toHaveLength(0);
  });

  it("null spx → skips spx condition in AND; other passing conditions still fire", () => {
    const alert = makeAlert({
      logic: "AND",
      conditions: [
        { metric: "vix", operator: ">", value: 30 },
        { metric: "spx", operator: "<", value: 5000 },
      ],
    });
    const result = evaluateAlerts([alert], null, 35, null, null);
    expect(result).toHaveLength(1);
    expect(result[0].message).not.toContain("SPX");
  });

  it("null spx with only spx condition → does not trigger", () => {
    const alert = makeAlert({
      conditions: [{ metric: "spx", operator: "<", value: 5000 }],
    });
    const result = evaluateAlerts([alert], null, null, null, null);
    expect(result).toHaveLength(0);
  });

  // ─── Cross-metric ─────────────────────────────────────────────────────────

  it("OR: btc > threshold OR fearGreed < threshold — fires when only btc passes", () => {
    const alert = makeAlert({
      logic: "OR",
      conditions: [
        { metric: "btc", operator: ">", value: 100000 },
        { metric: "fearGreed", operator: "<", value: 10 },
      ],
    });
    const result = evaluateAlerts([alert], 50, null, 105000, null);
    expect(result).toHaveLength(1);
    expect(result[0].message).toContain("BTC");
  });

  it("AND: all four metrics — triggers when all pass", () => {
    const alert = makeAlert({
      logic: "AND",
      conditions: [
        { metric: "fearGreed", operator: "<", value: 30 },
        { metric: "vix", operator: ">", value: 25 },
        { metric: "btc", operator: "<", value: 80000 },
        { metric: "spx", operator: "<", value: 5000 },
      ],
    });
    const result = evaluateAlerts([alert], 20, 28, 75000, 4900);
    expect(result).toHaveLength(1);
    expect(result[0].message).toContain("AND");
  });

  it("disabled alert → never triggers", () => {
    const alert = makeAlert({
      enabled: false,
      conditions: [{ metric: "fearGreed", operator: "<", value: 100 }],
    });
    const result = evaluateAlerts([alert], 8, 25);
    expect(result).toHaveLength(0);
  });

  it("triggered message includes alertId and alertName", () => {
    const alert = makeAlert({
      id: "my-alert-id",
      name: "My Custom Alert",
      conditions: [{ metric: "fearGreed", operator: "==", value: 8 }],
    });
    const result = evaluateAlerts([alert], 8, null);
    expect(result).toHaveLength(1);
    expect(result[0].alertId).toBe("my-alert-id");
    expect(result[0].alertName).toBe("My Custom Alert");
    expect(result[0].triggeredAt).toBeTruthy();
  });

  it("evaluates all operators correctly", () => {
    const baseAlert = (operator: Condition["operator"], value: number, score: number) =>
      makeAlert({
        conditions: [{ metric: "fearGreed", operator, value }],
      });

    // <=
    expect(evaluateAlerts([baseAlert("<=", 10, 10)], 10, null)).toHaveLength(1);
    expect(evaluateAlerts([baseAlert("<=", 10, 11)], 11, null)).toHaveLength(0);
    // >=
    expect(evaluateAlerts([baseAlert(">=", 10, 10)], 10, null)).toHaveLength(1);
    expect(evaluateAlerts([baseAlert(">=", 10, 9)], 9, null)).toHaveLength(0);
    // ==
    expect(evaluateAlerts([baseAlert("==", 42, 42)], 42, null)).toHaveLength(1);
    expect(evaluateAlerts([baseAlert("==", 42, 43)], 43, null)).toHaveLength(0);
  });
});

// Keep TypeScript happy with Condition type used inside
import type { Condition } from "@shared/types";
