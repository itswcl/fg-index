import { readFile } from "node:fs/promises";
import { DEFAULT_STOCK_ALERT_CUTOFF, isValidStockAlertCutoff } from "@shared/types";

const SETTINGS_PATH = "/etc/fg-index/stock-alert-cutoff";
const RELOAD_INTERVAL_MS = 15_000;

let cutoff = DEFAULT_STOCK_ALERT_CUTOFF;
let reloadAfter = 0;
let pendingReload: Promise<string> | undefined;
let lastReadError: string | undefined;

async function reloadCutoff(): Promise<string> {
  try {
    const value = (await readFile(SETTINGS_PATH, "utf8")).trim();
    if (!isValidStockAlertCutoff(value)) throw new Error("invalid cutoff");
    cutoff = value;
    lastReadError = undefined;
  } catch (error) {
    const reason = (error as NodeJS.ErrnoException).code ?? "invalid cutoff";
    if (reason !== lastReadError && (reason !== "ENOENT" || lastReadError !== undefined || cutoff !== DEFAULT_STOCK_ALERT_CUTOFF)) {
      process.stderr.write(`Stock alert cutoff setting unavailable (${reason}); keeping ${cutoff} Pacific.\n`);
    }
    lastReadError = reason;
  } finally {
    reloadAfter = Date.now() + RELOAD_INTERVAL_MS;
    pendingReload = undefined;
  }
  return cutoff;
}

export function getStockAlertCutoff(): Promise<string> {
  if (pendingReload) return pendingReload;
  if (Date.now() < reloadAfter) return Promise.resolve(cutoff);
  pendingReload = reloadCutoff();
  return pendingReload;
}
