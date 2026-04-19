import { useQuery } from '@tanstack/react-query';
import type { TickerQuote } from '../types';
import { API_BASE_URL, BTC_REFETCH_INTERVAL_MS } from '../constants';
import { authFetch } from '../lib/authFetch';

async function fetchBtc(): Promise<TickerQuote | null> {
  const res = await authFetch(`${API_BASE_URL}/api/btc`);
  if (!res.ok) throw new Error('Failed to fetch BTC');
  return res.json() as Promise<TickerQuote | null>;
}

export function useBtc() {
  return useQuery<TickerQuote | null, Error>({
    queryKey: ['btc'],
    queryFn: fetchBtc,
    refetchInterval: BTC_REFETCH_INTERVAL_MS,
    staleTime: BTC_REFETCH_INTERVAL_MS,
    retry: 2,
  });
}
