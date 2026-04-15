import { useQuery } from '@tanstack/react-query';
import type { Btc } from '../types';
import { API_BASE_URL, BTC_REFETCH_INTERVAL_MS } from '../constants';
import { authFetch } from '../lib/authFetch';

async function fetchBtc(): Promise<Btc | null> {
  const res = await authFetch(`${API_BASE_URL}/api/btc`);
  if (!res.ok) throw new Error('Failed to fetch BTC');
  return res.json() as Promise<Btc | null>;
}

export function useBtc() {
  return useQuery<Btc | null, Error>({
    queryKey: ['btc'],
    queryFn: fetchBtc,
    refetchInterval: BTC_REFETCH_INTERVAL_MS,
    staleTime: BTC_REFETCH_INTERVAL_MS,
    retry: 2,
  });
}
