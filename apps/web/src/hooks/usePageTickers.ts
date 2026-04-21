import { useEffect, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { TickerQuote } from '../types';
import { API_BASE_URL, TICKER_REFETCH_INTERVAL_MS } from '../constants';
import { authFetch } from '../lib/authFetch';

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
  return res.json() as Promise<BatchResponse>;
}

export interface UsePageTickersOptions {
  /**
   * Symbols on the next page (if any). Fired as a silent prefetch so
   * page-turning feels instant — no loading flash after the swipe.
   * Pass undefined or [] to skip prefetch.
   */
  prefetchNeighbor?: string[];
}

export function usePageTickers(symbols: string[], opts: UsePageTickersOptions = {}) {
  const queryClient = useQueryClient();
  const { prefetchNeighbor } = opts;

  // Sort to keep queryKey stable across in-page reorders — dragging cards
  // shouldn't reissue the batch under a different key and refetch.
  const sortedSymbols = useMemo(() => [...symbols].sort(), [symbols.join(',')]);
  const sortedNeighbor = useMemo(
    () => (prefetchNeighbor && prefetchNeighbor.length > 0 ? [...prefetchNeighbor].sort() : null),
    [prefetchNeighbor?.join(',')],
  );

  const query = useQuery<BatchResponse, Error>({
    queryKey: ['tickers', 'batch', sortedSymbols],
    queryFn: () => fetchBatch(sortedSymbols),
    enabled: sortedSymbols.length > 0,
    refetchInterval: TICKER_REFETCH_INTERVAL_MS,
    staleTime: TICKER_REFETCH_INTERVAL_MS,
    retry: 2,
  });

  // Fan out into per-symbol cache so useTicker readers re-render. null is a
  // legitimate cached value ("batch returned no data for this symbol") —
  // distinct from undefined ("cache not seeded yet").
  useEffect(() => {
    const quotes = query.data?.quotes;
    if (!quotes) return;
    for (const [sym, quote] of Object.entries(quotes)) {
      queryClient.setQueryData<TickerQuote | null>(['ticker', sym], quote ?? null);
    }
  }, [query.data, queryClient]);

  // Neighbor prefetch — silent, shares staleTime so the real useQuery on
  // the next page hydrates from this prefetched cache without re-firing.
  useEffect(() => {
    if (!sortedNeighbor) return;
    void queryClient.prefetchQuery({
      queryKey: ['tickers', 'batch', sortedNeighbor],
      queryFn: () => fetchBatch(sortedNeighbor),
      staleTime: TICKER_REFETCH_INTERVAL_MS,
    });
  }, [sortedNeighbor, queryClient]);

  return query;
}
