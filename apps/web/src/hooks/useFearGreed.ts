import { useQuery } from '@tanstack/react-query';
import type { FearGreed } from '../types';
import { API_BASE_URL, FEAR_GREED_REFETCH_INTERVAL_MS } from '../constants';
import { authFetch } from '../lib/authFetch';

async function fetchFearGreed(): Promise<FearGreed> {
  const res = await authFetch(`${API_BASE_URL}/api/fear-greed`);
  if (!res.ok) throw new Error('Failed to fetch Fear & Greed');
  return res.json() as Promise<FearGreed>;
}

export function useFearGreed() {
  return useQuery<FearGreed, Error>({
    queryKey: ['fearGreed'],
    queryFn: fetchFearGreed,
    staleTime: FEAR_GREED_REFETCH_INTERVAL_MS,
    refetchInterval: FEAR_GREED_REFETCH_INTERVAL_MS,
    retry: 2,
  });
}
