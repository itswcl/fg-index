import { useQuery } from '@tanstack/react-query';
import type { TickerQuote } from '../types';
import { API_BASE_URL, TICKER_REFETCH_INTERVAL_MS } from '../constants';
import { authFetch } from '../lib/authFetch';

async function fetchTicker(ticker: string): Promise<TickerQuote | null> {
  const res = await authFetch(`${API_BASE_URL}/api/quote/${encodeURIComponent(ticker)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Failed to fetch ticker ${ticker}`);
  return res.json() as Promise<TickerQuote>;
}

export function useTicker(ticker: string) {
  return useQuery<TickerQuote | null, Error>({
    queryKey: ['ticker', ticker],
    queryFn: () => fetchTicker(ticker),
    enabled: !!ticker,
    refetchInterval: TICKER_REFETCH_INTERVAL_MS,
    staleTime: TICKER_REFETCH_INTERVAL_MS,
    retry: 2,
  });
}
