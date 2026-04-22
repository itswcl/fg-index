import type { TickerQuote } from "@shared/types";
import { fetchTickerQuote } from "./ticker.service.js";

export async function fetchBtcData(): Promise<TickerQuote | null> {
  return fetchTickerQuote("BTC-USD");
}
