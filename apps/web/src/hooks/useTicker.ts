import { useQuery } from '@tanstack/react-query';
import type { TickerQuote } from '../types';
import { API_BASE_URL, API_KEY, TICKER_REFETCH_INTERVAL_MS } from '../constants';

async function fetchTicker(ticker: string): Promise<TickerQuote | null> {
  const headers: HeadersInit = {};
  if (API_KEY) headers['X-API-KEY'] = API_KEY;
  const res = await fetch(`${API_BASE_URL}/api/quote/${encodeURIComponent(ticker)}`, { headers });
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
