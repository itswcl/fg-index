import type { Alert, Condition, AlertTriggeredMessage } from "@shared/types";

interface MarketSnapshot {
  fearGreedScore: number | null;
  vixPrice: number | null;
  btcPrice: number | null;
  spxPrice: number | null;
}

interface ConditionResult {
  condition: Condition;
  result: boolean | null;
}

function getMetricValue(condition: Condition, snapshot: MarketSnapshot): number | null {
  switch (condition.metric) {
    case "fearGreed": return snapshot.fearGreedScore;
    case "vix":       return snapshot.vixPrice;
    case "btc":       return snapshot.btcPrice;
    case "spx":       return snapshot.spxPrice;
    default: {
      const _exhaustive: never = condition.metric;
      return _exhaustive;
    }
  }
}

function getMetricLabel(metric: Condition["metric"]): string {
  switch (metric) {
    case "fearGreed": return "Fear & Greed";
    case "vix":       return "VIX";
    case "btc":       return "BTC";
    case "spx":       return "SPX";
    default: {
      const _exhaustive: never = metric;
      return _exhaustive;
    }
  }
}

function evaluateCondition(condition: Condition, snapshot: MarketSnapshot): boolean | null {
  const metricValue = getMetricValue(condition, snapshot);

  // Skip condition when metric data is unavailable
  if (metricValue === null) return null;

  switch (condition.operator) {
    case "<":  return metricValue < condition.value;
    case ">":  return metricValue > condition.value;
    case "<=": return metricValue <= condition.value;
    case ">=": return metricValue >= condition.value;
    case "==": return metricValue === condition.value;
    default: {
      const _exhaustive: never = condition.operator;
      return _exhaustive;
    }
  }
}

function formatConditionFragment(condition: Condition, snapshot: MarketSnapshot): string {
  const metricLabel = getMetricLabel(condition.metric);
  const metricValue = getMetricValue(condition, snapshot);

  if (metricValue === null) {
    return `${metricLabel} is unavailable`;
  }

  return `${metricLabel} is ${metricValue} (${condition.operator} ${condition.value})`;
}

function buildTriggeredMessage(
  alert: Alert,
  snapshot: MarketSnapshot,
  matchedConditions: Condition[]
): string {
  const fragments = matchedConditions.map((c: Condition) =>
    formatConditionFragment(c, snapshot)
  );
  return fragments.join(` ${alert.logic} `);
}

export function evaluateAlerts(
  alerts: Alert[],
  fearGreedScore: number | null,
  vixPrice: number | null,
  btcPrice: number | null = null,
  spxPrice: number | null = null
): AlertTriggeredMessage[] {
  const snapshot: MarketSnapshot = { fearGreedScore, vixPrice, btcPrice, spxPrice };
  const triggered: AlertTriggeredMessage[] = [];

  for (const alert of alerts) {
    if (!alert.enabled) continue;

    const results: ConditionResult[] = alert.conditions.map(
      (c: Condition): ConditionResult => ({
        condition: c,
        result: evaluateCondition(c, snapshot),
      })
    );

    // Conditions with null result (missing data) are skipped.
    // For AND: all non-null conditions must pass; at least one non-null must exist.
    // For OR: at least one non-null condition must pass.
    const nonNull = results.filter((r) => r.result !== null);

    if (nonNull.length === 0) continue;

    let fires: boolean;
    let matchedConditions: Condition[];

    if (alert.logic === "AND") {
      fires = nonNull.every((r) => r.result === true);
      matchedConditions = nonNull.map((r) => r.condition);
    } else {
      const passing = nonNull.filter((r) => r.result === true);
      fires = passing.length > 0;
      matchedConditions = passing.map((r) => r.condition);
    }

    if (fires) {
      triggered.push({
        type: "alert_triggered",
        alertId: alert.id,
        alertName: alert.name,
        message: buildTriggeredMessage(alert, snapshot, matchedConditions),
        triggeredAt: new Date().toISOString(),
      });
    }
  }

  return triggered;
}
