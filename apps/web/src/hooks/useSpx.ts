import { useQuery } from '@tanstack/react-query';
import type { TickerQuote } from '../types';
import { API_BASE_URL, SPX_REFETCH_INTERVAL_MS } from '../constants';
import { authFetch } from '../lib/authFetch';
import { sanitizeTickerQuote } from '../lib/marketData';

async function fetchSpx(): Promise<TickerQuote | null> {
  const res = await authFetch(`${API_BASE_URL}/api/spx`);
  if (!res.ok) throw new Error('Failed to fetch SPX');
  return sanitizeTickerQuote(await res.json());
}

export function useSpx() {
  return useQuery<TickerQuote | null, Error>({
    queryKey: ['spx'],
    queryFn: fetchSpx,
    refetchInterval: SPX_REFETCH_INTERVAL_MS,
    staleTime: SPX_REFETCH_INTERVAL_MS,
    retry: 2,
  });
}
