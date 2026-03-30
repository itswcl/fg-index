import { useQuery } from '@tanstack/react-query';
import { Vix } from '@shared/types';
import { API_BASE_URL, VIX_REFETCH_INTERVAL_MS } from '../constants';

async function fetchVix(): Promise<Vix | null> {
  const res = await fetch(`${API_BASE_URL}/api/vix`);
  if (!res.ok) throw new Error('Failed to fetch VIX');
  return res.json();
}

/**
 * HTTP fallback hook for VIX — polls every 5 min.
 * Only used when WS is disconnected.
 */
export function useVix() {
  return useQuery<Vix | null, Error>({
    queryKey: ['vix'],
    queryFn: fetchVix,
    refetchInterval: VIX_REFETCH_INTERVAL_MS,
    staleTime: VIX_REFETCH_INTERVAL_MS,
    retry: 2,
  });
}
