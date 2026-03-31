import type { Alert, Condition, AlertTriggeredMessage } from "@shared/types";

interface ConditionResult {
  condition: Condition;
  result: boolean | null;
}

function evaluateCondition(
  condition: Condition,
  fearGreedScore: number | null,
  vixPrice: number | null
): boolean | null {
  const metricValue: number | null =
    condition.metric === "fearGreed" ? fearGreedScore : vixPrice;

  // Skip condition when metric data is unavailable
  if (metricValue === null) {
    return null;
  }

  switch (condition.operator) {
    case "<":
      return metricValue < condition.value;
    case ">":
      return metricValue > condition.value;
    case "<=":
      return metricValue <= condition.value;
    case ">=":
      return metricValue >= condition.value;
    case "==":
      return metricValue === condition.value;
    default: {
      const _exhaustive: never = condition.operator;
      return _exhaustive;
    }
  }
}

function formatConditionFragment(
  condition: Condition,
  fearGreedScore: number | null,
  vixPrice: number | null
): string {
  const metricLabel =
    condition.metric === "fearGreed" ? "Fear & Greed" : "VIX";
  const metricValue: number | null =
    condition.metric === "fearGreed" ? fearGreedScore : vixPrice;

  if (metricValue === null) {
    return `${metricLabel} is unavailable`;
  }

  return `${metricLabel} is ${metricValue} (${condition.operator} ${condition.value})`;
}

function buildTriggeredMessage(
  alert: Alert,
  fearGreedScore: number | null,
  vixPrice: number | null,
  matchedConditions: Condition[]
): string {
  const fragments = matchedConditions.map((c: Condition) =>
    formatConditionFragment(c, fearGreedScore, vixPrice)
  );
  return fragments.join(` ${alert.logic} `);
}

export function evaluateAlerts(
  alerts: Alert[],
  fearGreedScore: number | null,
  vixPrice: number | null
): AlertTriggeredMessage[] {
  const triggered: AlertTriggeredMessage[] = [];

  for (const alert of alerts) {
    if (!alert.enabled) {
      continue;
    }

    const results: ConditionResult[] = alert.conditions.map(
      (c: Condition): ConditionResult => ({
        condition: c,
        result: evaluateCondition(c, fearGreedScore, vixPrice),
      })
    );

    // Conditions with null result (missing data) are skipped.
    // For AND: all non-null conditions must pass; at least one non-null must exist.
    // For OR: at least one non-null condition must pass.
    const nonNull: ConditionResult[] = results.filter(
      (r: ConditionResult) => r.result !== null
    );

    if (nonNull.length === 0) {
      // All conditions had no data — cannot evaluate
      continue;
    }

    let fires: boolean;
    let matchedConditions: Condition[];

    if (alert.logic === "AND") {
      fires = nonNull.every((r: ConditionResult) => r.result === true);
      matchedConditions = nonNull.map((r: ConditionResult) => r.condition);
    } else {
      // OR
      const passing: ConditionResult[] = nonNull.filter(
        (r: ConditionResult) => r.result === true
      );
      fires = passing.length > 0;
      matchedConditions = passing.map((r: ConditionResult) => r.condition);
    }

    if (fires) {
      triggered.push({
        type: "alert_triggered",
        alertId: alert.id,
        alertName: alert.name,
        message: buildTriggeredMessage(
          alert,
          fearGreedScore,
          vixPrice,
          matchedConditions
        ),
        triggeredAt: new Date().toISOString(),
      });
    }
  }

  return triggered;
}
