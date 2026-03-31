import { useQuery } from '@tanstack/react-query';
import type { Vix } from '../types';
import { API_BASE_URL, API_KEY, VIX_REFETCH_INTERVAL_MS } from '../constants';

async function fetchVix(): Promise<Vix | null> {
  const headers: HeadersInit = {};
  if (API_KEY) headers['X-API-KEY'] = API_KEY;
  const res = await fetch(`${API_BASE_URL}/api/vix`, { headers });
  if (!res.ok) throw new Error('Failed to fetch VIX');
  return res.json() as Promise<Vix | null>;
}

export function useVix() {
  return useQuery<Vix | null, Error>({
    queryKey: ['vix'],
    queryFn: fetchVix,
    refetchInterval: VIX_REFETCH_INTERVAL_MS,
    staleTime: VIX_REFETCH_INTERVAL_MS,
    retry: 2,
  });
}
