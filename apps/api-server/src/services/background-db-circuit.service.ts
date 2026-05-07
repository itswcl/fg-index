import { env } from "../config/env.js";

let cooldownUntil = 0;
let lastFailure: { source: string; error: string; at: Date } | null = null;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function getBackgroundDbCooldownRemainingMs(now = Date.now()): number {
  if (cooldownUntil <= now) {
    cooldownUntil = 0;
    return 0;
  }
  return cooldownUntil - now;
}

export function isBackgroundDbInCooldown(now = Date.now()): boolean {
  return getBackgroundDbCooldownRemainingMs(now) > 0;
}

export function recordBackgroundDbFailure(source: string, error: unknown): void {
  const cooldownMs = env.BACKGROUND_DB_FAILURE_COOLDOWN_MS;
  if (!Number.isFinite(cooldownMs) || cooldownMs <= 0) return;

  cooldownUntil = Date.now() + cooldownMs;
  lastFailure = {
    source,
    error: errorMessage(error),
    at: new Date(),
  };
}

export function recordBackgroundDbSuccess(): void {
  cooldownUntil = 0;
}

export function getBackgroundDbCircuitStats() {
  return {
    coolingDown: isBackgroundDbInCooldown(),
    cooldownRemainingMs: getBackgroundDbCooldownRemainingMs(),
    lastFailure,
  };
}

export function __resetBackgroundDbCircuitForTests(): void {
  cooldownUntil = 0;
  lastFailure = null;
}
