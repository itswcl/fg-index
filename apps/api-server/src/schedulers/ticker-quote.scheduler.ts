import { env } from "../config/env.js";
import { listActiveTrackedSymbols } from "../services/ticker-cache.service.js";
import {
  enqueueQuoteRefresh,
  recordActiveTickerSyncFailure,
  recordActiveTickerSyncSuccess,
} from "../services/quote-refresh-queue.service.js";

async function refreshActiveTickerQuotes(): Promise<void> {
  try {
    const symbols = await listActiveTrackedSymbols();
    recordActiveTickerSyncSuccess(symbols.length);
    if (symbols.length === 0) return;
    enqueueQuoteRefresh(symbols);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    recordActiveTickerSyncFailure(message);
    process.stderr.write(`Ticker Quote Scheduler Error: ${message}\n`);
  }
}

export function startTickerQuoteScheduler(): void {
  void refreshActiveTickerQuotes();
  setInterval(() => {
    void refreshActiveTickerQuotes();
  }, env.QUOTE_REFRESH_INTERVAL_MS);
}
