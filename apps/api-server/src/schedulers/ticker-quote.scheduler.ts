import { env } from "../config/env.js";
import { listActiveTrackedSymbols } from "../services/ticker-cache.service.js";
import {
  enqueueQuoteRefresh,
  recordActiveTickerSyncFailure,
  recordActiveTickerSyncSuccess,
} from "../services/quote-refresh-queue.service.js";
import {
  getBackgroundDbCooldownRemainingMs,
  recordBackgroundDbFailure,
  recordBackgroundDbSuccess,
} from "../services/background-db-circuit.service.js";

let activeTickerRefreshInFlight = false;

async function refreshActiveTickerQuotes(): Promise<void> {
  if (activeTickerRefreshInFlight) return;

  const cooldownRemainingMs = getBackgroundDbCooldownRemainingMs();
  if (cooldownRemainingMs > 0) {
    recordActiveTickerSyncFailure(
      `Background DB cooldown active (${cooldownRemainingMs}ms remaining)`
    );
    return;
  }

  activeTickerRefreshInFlight = true;
  try {
    const symbols = await listActiveTrackedSymbols();
    recordBackgroundDbSuccess();
    recordActiveTickerSyncSuccess(symbols.length);
    if (symbols.length === 0) return;
    enqueueQuoteRefresh(symbols);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    recordBackgroundDbFailure("ticker_quote_scheduler", error);
    recordActiveTickerSyncFailure(message);
    process.stderr.write(`Ticker Quote Scheduler Error: ${message}\n`);
  } finally {
    activeTickerRefreshInFlight = false;
  }
}

export function startTickerQuoteScheduler(): void {
  void refreshActiveTickerQuotes();
  setInterval(() => {
    void refreshActiveTickerQuotes();
  }, env.QUOTE_REFRESH_INTERVAL_MS);
}

export const __privateTickerQuoteSchedulerForTests = {
  refreshActiveTickerQuotes,
  resetInFlightState() {
    activeTickerRefreshInFlight = false;
  },
};
