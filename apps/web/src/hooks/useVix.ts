import { useQuery } from '@tanstack/react-query';
import type { TickerQuote } from '../types';
import { API_BASE_URL, VIX_REFETCH_INTERVAL_MS } from '../constants';
import { authFetch } from '../lib/authFetch';
import { sanitizeTickerQuote } from '../lib/marketData';

async function fetchVix(): Promise<TickerQuote | null> {
  const res = await authFetch(`${API_BASE_URL}/api/vix`);
  if (!res.ok) throw new Error('Failed to fetch VIX');
  return sanitizeTickerQuote(await res.json());
}

export function useVix() {
  return useQuery<TickerQuote | null, Error>({
    queryKey: ['vix'],
    queryFn: fetchVix,
    refetchInterval: VIX_REFETCH_INTERVAL_MS,
    staleTime: VIX_REFETCH_INTERVAL_MS,
    retry: 2,
  });
}
