import { useQuery } from '@tanstack/react-query';
import type { Btc } from '../types';
import { API_BASE_URL, API_KEY, BTC_REFETCH_INTERVAL_MS } from '../constants';

async function fetchBtc(): Promise<Btc | null> {
  const headers: HeadersInit = {};
  if (API_KEY) headers['X-API-KEY'] = API_KEY;
  const res = await fetch(`${API_BASE_URL}/api/btc`, { headers });
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
