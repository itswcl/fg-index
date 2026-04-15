import { useQuery } from '@tanstack/react-query';
import type { Vix } from '../types';
import { API_BASE_URL, VIX_REFETCH_INTERVAL_MS } from '../constants';
import { authFetch } from '../lib/authFetch';

async function fetchVix(): Promise<Vix | null> {
  const res = await authFetch(`${API_BASE_URL}/api/vix`);
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
