import { useEffect, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { TickerQuote } from '../types';
import { API_BASE_URL, TICKER_REFETCH_INTERVAL_MS } from '../constants';
import { authFetch } from '../lib/authFetch';
import { sanitizeTickerQuote } from '../lib/marketData';
import { loadQuote, saveQuote } from '../lib/quoteCache';

/**
 * Batch quote fetch. One `GET /api/quote/batch?symbols=A,B,C` per page
 * instead of N parallel `GET /api/quote/:sym` requests. Critical on Render
 * free tier once users have 20+ tickers.
 *
 * Contract (BE-3):
 *   { quotes: Record<UPPERCASED_SYMBOL, TickerQuote | null> }
 *   - null = scrape failed for that symbol (still 200 overall)
 *   - 400 INVALID_QUERY if symbols missing / > 12 after dedupe / invalid format
 *
 * This hook owns fetching for on-page custom tickers. `useTicker(symbol)`
 * is a pure cache reader — it picks up data as soon as our onSuccess
 * effect seeds the ['ticker', symbol] cache keys.
 */

interface BatchResponse {
  quotes: Record<string, TickerQuote | null>;
}

async function fetchBatch(symbols: string[]): Promise<BatchResponse> {
  const qs = encodeURIComponent(symbols.join(','));
  const res = await authFetch(`${API_BASE_URL}/api/quote/batch?symbols=${qs}`);
  if (!res.ok) throw new Error(`Batch quote fetch failed (${res.status})`);
  const data = (await res.json()) as { quotes?: Record<string, unknown> };
  const quotes = Object.fromEntries(
    Object.entries(data.quotes ?? {}).map(([symbol, quote]) => [symbol, sanitizeTickerQuote(quote)]),
  );
  return { quotes };
}

export function usePageTickers(symbols: string[]) {
  const queryClient = useQueryClient();

  // Sort to keep queryKey stable across in-page reorders — dragging cards
  // shouldn't reissue the batch under a different key and refetch.
  const sortedSymbols = useMemo(() => [...symbols].sort(), [symbols.join(',')]);

  const query = useQuery<BatchResponse, Error>({
    queryKey: ['tickers', 'batch', sortedSymbols],
    queryFn: () => fetchBatch(sortedSymbols),
    enabled: sortedSymbols.length > 0,
    refetchInterval: TICKER_REFETCH_INTERVAL_MS,
    staleTime: TICKER_REFETCH_INTERVAL_MS,
    retry: 2,
  });

  // Seed the query cache from localStorage for any on-page symbol whose
  // entry hasn't been populated yet. This complements the app-bootstrap
  // hydration in App.tsx — it also covers symbols added to a page after
  // initial render (e.g. after navigating back from another page). Only
  // writes `undefined` slots, so it never overwrites a live batch result
  // with stale cached data.
  useEffect(() => {
    for (const sym of sortedSymbols) {
      const existing = queryClient.getQueryData<TickerQuote | null | undefined>([
        'ticker',
        sym,
      ]);
      if (existing !== undefined) continue;
      const cached = loadQuote(sym);
      if (cached) {
        queryClient.setQueryData<TickerQuote | null>(['ticker', sym], cached.quote);
      }
    }
  }, [sortedSymbols, queryClient]);

  // Fan out into per-symbol cache so useTicker readers re-render.
  //
  //   quote (non-null)  -> overwrite cache + persist to localStorage
  //   quote === null    -> only write null if the slot has NO existing
  //                        good value. Preserves a previously-good quote
  //                        through transient scraper failures, but still
  //                        surfaces "Not Found" on the first-fetch-null
  //                        case (user typo'd a symbol).
  //
  // So once a ticker has loaded at least once, a null response keeps the
  // last real price on screen (matching the indicator behavior above) —
  // the only way the card ever shows "Not Found" is if the very first
  // fetch for that symbol returned null.
  useEffect(() => {
    const quotes = query.data?.quotes;
    if (!quotes) return;
    for (const [sym, quote] of Object.entries(quotes)) {
      if (quote) {
        queryClient.setQueryData<TickerQuote | null>(['ticker', sym], quote);
        saveQuote(sym, quote);
      } else {
        const existing = queryClient.getQueryData<TickerQuote | null | undefined>([
          'ticker',
          sym,
        ]);
        // `existing` is a non-null quote -> keep it (transient failure).
        // `existing` is null -> already "Not Found", leave it.
        // `existing` is undefined -> first fetch came back null, write null so
        //   the card can show "Not Found" instead of spinning forever.
        if (existing === undefined) {
          queryClient.setQueryData<TickerQuote | null>(['ticker', sym], null);
        }
      }
    }
  }, [query.data, queryClient]);

  return query;
}
