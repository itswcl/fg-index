import { useQuery } from '@tanstack/react-query';
import type { Spx } from '../types';
import { API_BASE_URL, SPX_REFETCH_INTERVAL_MS } from '../constants';
import { authFetch } from '../lib/authFetch';

async function fetchSpx(): Promise<Spx | null> {
  const res = await authFetch(`${API_BASE_URL}/api/spx`);
  if (!res.ok) throw new Error('Failed to fetch SPX');
  return res.json() as Promise<Spx | null>;
}

export function useSpx() {
  return useQuery<Spx | null, Error>({
    queryKey: ['spx'],
    queryFn: fetchSpx,
    refetchInterval: SPX_REFETCH_INTERVAL_MS,
    staleTime: SPX_REFETCH_INTERVAL_MS,
    retry: 2,
  });
}
