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
